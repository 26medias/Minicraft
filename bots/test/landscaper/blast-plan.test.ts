import { describe, expect, it } from 'vitest';
import { blastCells, blockId, isLiquidId, isSolidId, blockName } from 'minicraft-bot';
import type { WorldView } from '../../src/port.js';
import type { Vec3 } from '../../src/types.js';
import { blastWorld, evaluateArea, filterBlast, KID_CELL_DIST, KID_POS_DIST, terrainTop, type CellClass } from '../../src/landscaper/blast-plan.js';
import { BlastBudget } from '../../src/landscaper/landscaper.js';

const STONE = blockId('stone')!, DIRT = blockId('dirt')!, WATER = blockId('water')!, RED = blockId('red_wool')!;

/** A small synthetic world: a height function of stone, plus overrides. */
class GridWorld implements WorldView {
	mustMine = false;
	cells = new Map<string, number>();
	edited = new Set<string>();
	constructor(private readonly h: (x: number, z: number) => number) {}
	getBlock(x: number, y: number, z: number): number {
		const k = `${x},${y},${z}`;
		const v = this.cells.get(k);
		if (v !== undefined) return v;
		return y <= this.h(x, z) ? (y === this.h(x, z) ? DIRT : STONE) : 0;
	}
	set(x: number, y: number, z: number, id: number, edited = false): void {
		this.cells.set(`${x},${y},${z}`, id);
		if (edited) this.edited.add(`${x},${y},${z}`);
	}
	blockName = (id: number) => blockName(id);
	isSolid = (id: number) => isSolidId(id);
	isLiquid = (id: number) => isLiquidId(id);
	groundY = () => null;
	raycast = () => null;
	generatedBlock = () => 0;
	isEdited = (x: number, y: number, z: number) => this.edited.has(`${x},${y},${z}`);
	editedCellsInChunk = (cx: number, cz: number): Array<[number, number, number]> =>
		[...this.edited].map((k) => k.split(',').map(Number) as [number, number, number]).filter(([x, , z]) => Math.floor(x / 16) === cx && Math.floor(z / 16) === cz);
}

/** Deterministic PRNG. */
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe('filterBlast (property-ish): a kept blast never removes a kid-adjacent, non-natural or liquid-touching cell', () => {
	it('holds over 300 random worlds, and drops happen for each reason', () => {
		const reasons = new Set<string>();
		let kept = 0;
		for (let seed = 1; seed <= 300; seed++) {
			const r = rng(seed);
			const w = new GridWorld((x, z) => 60 + Math.floor(3 * Math.sin(x / 3 + seed) + 3 * Math.cos(z / 4)));
			const cls = new Map<string, CellClass>();
			const kidCells: Vec3[] = [];
			const kids: Vec3[] = [];
			// Sprinkle kid cells, bot cells, water, kid positions at random distances (often far, sometimes near).
			for (let i = 0; i < 3; i++) {
				const far = r() < 0.7 ? 30 : 0;
				const c = { x: Math.floor((r() - 0.5) * 2 * (far + 14)), y: 60 + Math.floor(r() * 10), z: Math.floor((r() - 0.5) * 2 * (far + 14)) };
				const kind = r();
				if (kind < 0.3) {
					cls.set(`${c.x},${c.y},${c.z}`, 'kid');
					kidCells.push(c);
				} else if (kind < 0.55) cls.set(`${c.x},${c.y},${c.z}`, 'bot');
				else if (kind < 0.75) w.set(c.x, c.y, c.z, WATER);
				else kids.push({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 });
			}
			const classify = (x: number, y: number, z: number) => cls.get(`${x},${y},${z}`) ?? 'natural';
			const tnt = { x: 0, y: 60, z: 0 };
			const { destroyed } = blastCells(blastWorld(w), 'flatten_tnt', tnt);
			const f = filterBlast(destroyed, { world: w, classify, kidCells, kids });
			if (f.dropped) {
				reasons.add(f.dropped.replace(/\d+/g, 'N'));
				expect(f.remove).toEqual([]);
				continue;
			}
			kept++;
			for (const c of f.remove) {
				expect(classify(c.x, c.y, c.z)).toBe('natural');
				for (const k of kidCells) expect(Math.hypot(c.x - k.x, c.y - k.y, c.z - k.z)).toBeGreaterThan(KID_CELL_DIST);
				for (const k of kids) expect(Math.hypot(c.x - k.x, c.y - k.y, c.z - k.z)).toBeGreaterThan(KID_POS_DIST);
				for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) expect(isLiquidId(w.getBlock(c.x + dx, c.y + dy, c.z + dz))).toBe(false);
			}
			// Bot cells in the blast are kept, never removed.
			for (const [k, v] of cls) if (v === 'bot') expect(f.remove.some((c) => `${c.x},${c.y},${c.z}` === k)).toBe(false);
		}
		expect(kept).toBeGreaterThan(20);
		expect([...reasons].sort()).toEqual(['touches liquid', 'within N of a kid', 'within N of a kid cell']);
	});
});

describe('evaluateArea: the planned blasts level a hilly square', () => {
	it('after applying every planned blast (the game cells, filtered) the square is flat at L', () => {
		const w = new GridWorld((x, z) => 64 + Math.floor(4 * Math.sin(x / 5) + 3 * Math.cos(z / 3) + 4));
		const classify = (x: number, y: number, z: number): CellClass => (w.isEdited(x, y, z) ? 'kid' : 'natural');
		const p = evaluateArea(w, 0, 0, 16, { classify, kidCells: [], kids: [] });
		if (typeof p === 'string') throw new Error(p);
		expect(p.spots).toHaveLength(4);
		expect(p.range).toBeGreaterThanOrEqual(2);
		for (const s of p.spots) {
			for (const c of s.dig) w.set(c.x, c.y, c.z, 0);
			const f = filterBlast(blastCells(blastWorld(w), 'flatten_tnt', s.tnt).destroyed, { world: w, classify, kidCells: [], kids: [] });
			expect(f.dropped).toBeNull();
			for (const c of f.remove) w.set(c.x, c.y, c.z, 0);
		}
		const tops: number[] = [];
		for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) tops.push(terrainTop(w, x, z));
		expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
		expect(Math.min(...tops)).toBe(p.L);
	});

	it('refuses a square with a kid marker 5 blocks from it, or water in it', () => {
		const w = new GridWorld((x, z) => 64 + (x > 8 ? 3 : 0) + (z % 3));
		for (let y = 68; y <= 70; y++) w.set(20, y, 5, RED, true);
		const classify = (x: number, y: number, z: number): CellClass => (w.isEdited(x, y, z) ? 'kid' : 'natural');
		const kidCells = [68, 69, 70].map((y) => ({ x: 20, y, z: 5 }));
		expect(evaluateArea(w, 0, 0, 16, { classify, kidCells, kids: [] })).toMatch(/kid/);
		expect(typeof evaluateArea(w, -40, 0, 16, { classify, kidCells, kids: [] })).toBe('object');
		w.set(-35, terrainTop(w, -35, 3) + 1, 3, WATER);
		expect(evaluateArea(w, -40, 0, 16, { classify, kidCells, kids: [] })).toBe('water');
	});
});

describe('BlastBudget', () => {
	it('accepts exactly the planned cells once; anything else halts', () => {
		const b = new BlastBudget();
		b.plan([{ x: 1, y: 2, z: 3 }, { x: 1, y: 3, z: 3 }]);
		expect(b.spend([{ x: 1, y: 2, z: 3 }])).toBe(true);
		expect(b.halted).toBeNull();
		expect(b.spend([{ x: 1, y: 2, z: 3 }])).toBe(false);
		expect(b.halted).toMatch(/unplanned/);
	});
});
