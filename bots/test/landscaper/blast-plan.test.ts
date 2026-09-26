import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blastCells, blockId, isLiquidId, isSolidId, blockName } from 'minicraft-bot';
import type { WorldView } from '../../src/port.js';
import type { Vec3 } from '../../src/types.js';
import { blastWorld, evaluateArea, filterBlast, KID_CELL_DIST, KID_POS_DIST, MIN_SPOT_REMOVE, terrainTop, type CellClass } from '../../src/landscaper/blast-plan.js';
import { BlastBudget, runLandscaper, saveLandscaperFile, TRIED_AREA_MS, type LandscaperFile } from '../../src/landscaper/landscaper.js';
import { FakeBody } from '../fake-port.js';

const ICE = blockId('ice')!, STONE = blockId('stone')!, DIRT = blockId('dirt')!, WATER = blockId('water')!, RED = blockId('red_wool')!;

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
		const w = new GridWorld((x, z) => 64 + (x > 8 ? 3 : 0) + (x < -30 ? 5 : 0) + (z % 3));
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

const natural = (w: GridWorld) => (x: number, y: number, z: number): CellClass => (w.isEdited(x, y, z) ? 'kid' : 'natural');
const hilly = (x: number, z: number) => 64 + Math.floor(4 * Math.sin(x / 5) + 3 * Math.cos(z / 3) + 4);

describe('evaluateArea: only genuinely uneven, safely blastable squares', () => {
	it('never picks an already-flat square (every column within ±1), nor a flat one with a small bump', () => {
		const w = new GridWorld((x, z) => 64 + ((x + z) % 2));
		expect(evaluateArea(w, 0, 0, 16, { classify: natural(w), kidCells: [], kids: [] })).toBe('already flat');
		// A 5 × 5 hill (10% of the square) on flat ground: still 90% flat.
		const b = new GridWorld((x, z) => 64 + (x >= 2 && x < 7 && z >= 2 && z < 7 ? 6 : 0));
		expect(evaluateArea(b, 0, 0, 16, { classify: natural(b), kidCells: [], kids: [] })).toBe('already flat');
	});

	it('never picks a square whose blasts are all near kid cells (the live ice patch)', () => {
		const w = new GridWorld(hilly);
		expect(typeof evaluateArea(w, 0, 0, 16, { classify: natural(w), kidCells: [], kids: [] })).toBe('object');
		const kidCells: Vec3[] = [];
		for (let x = -4; x < 20; x += 3) kidCells.push({ x, y: 66, z: 20 });
		for (const c of kidCells) w.set(c.x, c.y, c.z, RED, true);
		expect(evaluateArea(w, 0, 0, 16, { classify: natural(w), kidCells, kids: [] })).toMatch(/kid/);
	});

	it('refuses an icy surface (> 20% ice)', () => {
		const w = new GridWorld(hilly);
		for (let x = 0; x < 16; x++) for (let z = 0; z < 4; z++) w.set(x, terrainTop(w, x, z), z, ICE);
		expect(evaluateArea(w, 0, 0, 16, { classify: () => 'natural', kidCells: [], kids: [] })).toBe('ice');
	});

	it('plans no TNT where the filtered blast removes fewer than MIN_SPOT_REMOVE cells, and counts removableFiltered', () => {
		// One quadrant is a hill; the rest is flat at 64 (only one spot has anything to blast).
		const w = new GridWorld((x, z) => 64 + (x < 8 && z < 8 ? 5 : 0));
		const p = evaluateArea(w, 0, 0, 16, { classify: natural(w), kidCells: [], kids: [] });
		if (typeof p === 'string') throw new Error(p);
		expect(p.spots.length).toBeGreaterThanOrEqual(1);
		expect(p.spots.length).toBeLessThan(4);
		for (const s of p.spots) expect(s.removes).toBeGreaterThanOrEqual(MIN_SPOT_REMOVE);
		expect(p.removableFiltered).toBe(p.removes);
		expect(p.removableFiltered).toBeGreaterThanOrEqual(40);
	});
});

describe('landscaper loop: skipped spots and tried areas', () => {
	const base = (dir: string, w: GridWorld, body: FakeBody, logs: Array<Record<string, unknown>>, clock: () => number) => runLandscaper({
		name: 'Dan', body, world: w, spawn: { x: 100, y: 0, z: 100 }, primary: null, noEdits: true, statePath: join(dir, 's.json'),
		boardPath: join(dir, 'board.json'), log: (e) => logs.push(e), rng: () => 0.5, clock, breakMany: async () => [],
	});
	const until = async (p: () => boolean) => {
		for (let i = 0; i < 400 && !p(); i++) await new Promise((r) => setTimeout(r, 10));
		expect(p()).toBe(true);
	};

	it('a spot whose filtered blast is < 15 cells is skipped: no TNT placed, the spot remembered, the area dropped', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'land-skip-'));
		const w = new GridWorld(() => 64);
		const f: LandscaperFile = {
			v: 1, inv: { flatten_tnt: 1 }, blasts: [], crafts: [], owned: {}, triedAreas: [], triedSpots: [],
			areas: [{ id: 'a', status: 'active', t: 0, done: [], x0: 100, z0: 100, size: 8, L: 64, spots: [{ tnt: { x: 104, y: 65, z: 104 }, dig: [] }], removes: 123, removableFiltered: 123, range: 3, digs: 0 }],
		};
		saveLandscaperFile(join(dir, 's.json'), f);
		const body = new FakeBody();
		const logs: Array<Record<string, unknown>> = [];
		const h = base(dir, w, body, logs, () => 1000);
		await until(() => logs.some((l) => l.k === 'blast-skipped'));
		await h.stop();
		expect(body.calls.filter((c) => ['place', 'fx', 'mine', 'break'].includes(c.fn))).toEqual([]);
		expect(logs.some((l) => l.k === 'prime' || l.k === 'blast')).toBe(false);
		expect(String(logs.find((l) => l.k === 'blast-skipped')!.reason)).toMatch(/< 15/);
		const saved = JSON.parse(readFileSync(join(dir, 's.json'), 'utf8')) as LandscaperFile;
		expect(saved.triedSpots).toContain('104,65,104');
		expect(saved.areas[0].status).toBe('abandoned');
	});

	it('never picks the same (or an overlapping) area twice within the hour, even after it was abandoned', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'land-tried-'));
		const w = new GridWorld(hilly);
		const t = 5_000_000;
		const picked: Array<Record<string, unknown>> = [];
		for (let run = 0; run < 3; run++) {
			const logs: Array<Record<string, unknown>> = [];
			const h = base(dir, w, new FakeBody(), logs, () => t + run * 1000);
			await until(() => logs.some((l) => l.k === 'area'));
			await h.stop();
			picked.push(logs.find((l) => l.k === 'area')!);
			expect(typeof picked.at(-1)!.removableFiltered).toBe('number');
			// Whatever happened to it, the area is given up (as the live bot does after a failed blast).
			const f = JSON.parse(readFileSync(join(dir, 's.json'), 'utf8')) as LandscaperFile;
			for (const a of f.areas) a.status = 'abandoned';
			saveLandscaperFile(join(dir, 's.json'), f);
		}
		const n = (v: unknown) => v as number;
		for (let i = 0; i < picked.length; i++) for (let j = i + 1; j < picked.length; j++) {
			const a = picked[i], b = picked[j];
			const overlap = n(a.x0) < n(b.x0) + n(b.size) && n(b.x0) < n(a.x0) + n(a.size) && n(a.z0) < n(b.z0) + n(b.size) && n(b.z0) < n(a.z0) + n(a.size);
			expect(overlap).toBe(false);
		}
		// After the hour, the first square may be picked again (its spots still never re-blasted).
		const f = JSON.parse(readFileSync(join(dir, 's.json'), 'utf8')) as LandscaperFile;
		expect(f.triedAreas).toHaveLength(3);
		expect(TRIED_AREA_MS).toBe(60 * 60_000);
	});
});

describe('terracing: a hill steeper than one blast is cut in layers', () => {
	/** Applies a plan's blasts in order (dig, then the filtered game cells); every blast must pass the filter. */
	const apply = (w: GridWorld, p: Exclude<ReturnType<typeof evaluateArea>, string>) => {
		const classify = natural(w);
		for (const s of p.spots) {
			for (const c of s.dig) w.set(c.x, c.y, c.z, 0);
			const f = filterBlast(blastCells(blastWorld(w), 'flatten_tnt', s.tnt).destroyed, { world: w, classify, kidCells: [], kids: [] });
			expect(f.dropped).toBeNull();
			expect(f.remove.length).toBeGreaterThanOrEqual(MIN_SPOT_REMOVE);
			for (const c of f.remove) w.set(c.x, c.y, c.z, 0);
		}
	};

	it('a range-25 hill yields 2–3 layers, top layer first, and leaves a 12 × 12 terrace at the floor', () => {
		const h = (x: number, z: number) => 64 + Math.floor((x * 25) / 15) + (z % 2);
		const w = new GridWorld(h);
		const p = evaluateArea(w, 0, 0, 16, { classify: natural(w), kidCells: [], kids: [] });
		if (typeof p === 'string') throw new Error(p);
		expect(p.range).toBeGreaterThanOrEqual(25);
		expect(p.layers).toBeGreaterThanOrEqual(2);
		expect(p.layers).toBeLessThanOrEqual(3);
		const ls = p.spots.map((s) => s.layer!);
		expect([...ls].sort((a, b) => b - a)).toEqual(ls);
		expect(new Set(p.spots.map((s) => `${s.tnt.x},${s.tnt.y},${s.tnt.z}`)).size).toBe(p.spots.length);
		apply(w, p);
		// Every column at or above the floor now ends at it; lower columns are untouched.
		let flatCols = 0;
		for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
			const t = terrainTop(w, x, z);
			if (h(x, z) >= p.L) expect(t).toBe(p.L);
			else expect(t).toBe(h(x, z));
			if (t === p.L) flatCols++;
		}
		expect(flatCols).toBeGreaterThanOrEqual(144);
	});

	it('a range-50 cliff is too steep', () => {
		const w = new GridWorld((x) => 64 + (x >= 6 ? 50 : 0));
		expect(evaluateArea(w, 0, 0, 16, { classify: natural(w), kidCells: [], kids: [] })).toBe('too steep');
	});
});

describe('landscaper search widens to 128', () => {
	it('finds an area beyond 96 when everything nearer spawn is water', async () => {
		class Lake extends GridWorld {
			override getBlock(x: number, y: number, z: number): number {
				if (Math.max(Math.abs(x), Math.abs(z)) < 100 && y === hilly(x, z) + 1) return WATER;
				return super.getBlock(x, y, z);
			}
		}
		const dir = mkdtempSync(join(tmpdir(), 'land-wide-'));
		const w = new Lake(hilly);
		const logs: Array<Record<string, unknown>> = [];
		const h = runLandscaper({
			name: 'Dan', body: new FakeBody(), world: w, spawn: { x: 0, y: 0, z: 0 }, primary: null, noEdits: true, statePath: join(dir, 's.json'),
			boardPath: join(dir, 'board.json'), log: (e) => logs.push(e), rng: () => 0.5, clock: () => 1000, breakMany: async () => [],
		});
		for (let i = 0; i < 3000 && !logs.some((l) => l.k === 'area'); i++) await new Promise((r) => setTimeout(r, 10));
		await h.stop();
		const search = logs.find((l) => l.k === 'area-search')!;
		expect(search.radius).toBe(128);
		const a = logs.find((l) => l.k === 'area')!;
		expect(a).toBeDefined();
		const n = (v: unknown) => v as number;
		expect(Math.hypot(n(a.x0) + n(a.size) / 2, n(a.z0) + n(a.size) / 2)).toBeGreaterThan(96);
		expect(typeof a.floor).toBe('number');
		expect(typeof a.layers).toBe('number');
	}, 60_000);
});
