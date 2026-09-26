import { describe, expect, it } from 'vitest';
import { blockId, blockName, isLiquidId, isSolidId } from 'minicraft-bot';
import type { WorldView } from '../../src/port.js';
import type { Vec3 } from '../../src/types.js';
import { ColumnTops, evaluateArea, terrainTop } from '../../src/landscaper/blast-plan.js';
import { searchAreas } from '../../src/landscaper/area-search.js';
import { Slicer } from '../../src/shared/slice.js';

const STONE = blockId('stone')!, DIRT = blockId('dirt')!;
const hilly = (x: number, z: number) => 64 + Math.floor(12 * Math.sin(x / 9) + 10 * Math.cos(z / 7) + 12);

/** A hilly world with kid cells (a big build far out, as on the live world); `slowMs` of busy work per new chunk read (worldgen). */
class HillWorld implements WorldView {
	mustMine = false;
	readonly kid = new Map<string, Array<[number, number, number]>>();
	private readonly seen = new Set<string>();
	constructor(private readonly h: (x: number, z: number) => number, private readonly slowMs = 0) {}
	getBlock(x: number, y: number, z: number): number {
		if (this.slowMs) {
			const k = `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
			if (!this.seen.has(k)) {
				this.seen.add(k);
				const until = performance.now() + this.slowMs;
				while (performance.now() < until) { /* worldgen */ }
			}
		}
		const t = this.h(x, z);
		return y <= t ? (y === t ? DIRT : STONE) : 0;
	}
	blockName = (id: number) => blockName(id);
	isSolid = (id: number) => isSolidId(id);
	isLiquid = (id: number) => isLiquidId(id);
	groundY = () => null;
	raycast = () => null;
	generatedBlock = () => 0;
	isEdited = (x: number, y: number, z: number) => this.kid.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`)?.some(([a, b, c]) => a === x && b === y && c === z) ?? false;
	editedCellsInChunk = (cx: number, cz: number) => this.kid.get(`${cx},${cz}`) ?? [];
	addKidCells(x0: number, z0: number, n: number): Vec3[] {
		const out: Vec3[] = [];
		for (let i = 0; i < n; i++) {
			const x = x0 + (i % 40), z = z0 + Math.floor(i / 40), y = 200;
			const k = `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
			if (!this.kid.has(k)) this.kid.set(k, []);
			this.kid.get(k)!.push([x, y, z]);
			out.push({ x, y, z });
		}
		return out;
	}
}

const ctxOf = (w: HillWorld, slicer: Slicer, alive = () => true) => ({
	world: w, classify: (x: number, y: number, z: number) => (w.isEdited(x, y, z) ? 'kid' as const : 'natural' as const), tops: new ColumnTops(w),
	spawn: { x: 1000, y: 0, z: 1000 }, kids: [], busy: [], alive, slicer,
});

describe('the landscaper area search is sliced (live: the 128-radius search starved the socket → 1006 → exit)', () => {
	it('every slice of a full search returns within ~20 ms, and a timer ticks throughout', async () => {
		// Flat near the anchor (every candidate "already flat") so the search widens ring by ring to 128, hilly beyond.
		const w = new HillWorld((x, z) => (Math.hypot(x, z) < 118 ? 64 : hilly(x, z)), 4);
		w.addKidCells(-300, -300, 4000); // a big kid build, far out of every blast's reach but inside the search box
		const slices: number[] = [];
		const slicer = new Slicer(12, undefined, (ms) => slices.push(ms));
		let ticks = 0, last = performance.now(), worstGap = 0;
		const timer = setInterval(() => {
			const t = performance.now();
			worstGap = Math.max(worstGap, t - last);
			last = t;
			ticks++;
		}, 5);
		const r = await searchAreas(ctxOf(w, slicer), { x: 0, z: 0 }, 16);
		clearInterval(timer);
		expect(r.radius).toBe(128);
		expect(r.found.length).toBeGreaterThan(0);
		expect(r.candidates).toBeGreaterThan(300);
		expect(slices.length).toBeGreaterThan(20);
		// One step past the 12 ms budget is at most a fresh chunk (4 ms of fake worldgen here) plus one column or one blast.
		expect(Math.max(...slices)).toBeLessThan(35);
		expect(slices.filter((s) => s > 20).length / slices.length).toBeLessThan(0.05);
		expect(ticks).toBeGreaterThan(slices.length / 2);
		expect(worstGap).toBeLessThan(100);
	}, 60_000);

	it('the sliced plan is the synchronous plan (same result, tops cached or not)', async () => {
		const w = new HillWorld(hilly);
		const f = { classify: () => 'natural' as const, kidCells: [], kids: [] };
		const tops = new ColumnTops(w);
		for (const [x0, z0] of [[0, 0], [40, -24], [-64, 16]]) {
			const sync = evaluateArea(w, x0, z0, 16, f);
			const cached = evaluateArea(w, x0, z0, 16, { ...f, tops: (x, z) => tops.get(x, z) });
			expect(cached).toEqual(sync);
		}
		expect(tops.get(3, 5)).toBe(terrainTop(w, 3, 5));
		tops.invalidate(3, 5);
		expect(tops.get(3, 5)).toBe(terrainTop(w, 3, 5));
	});

	it('far kid cells no longer cost every blast (a candidate is planned in well under 100 ms)', async () => {
		const w = new HillWorld(hilly);
		w.addKidCells(300, -150, 20_000);
		const slicer = new Slicer(15);
		const t = performance.now();
		const r = await searchAreas({ ...ctxOf(w, slicer), radii: [8] }, { x: 0, z: 0 }, 16);
		expect(r.candidates).toBeGreaterThan(0);
		expect((performance.now() - t) / r.candidates).toBeLessThan(100);
	});

	it('stops promptly when the bot stops', async () => {
		const w = new HillWorld(hilly);
		let alive = true;
		const p = searchAreas(ctxOf(w, new Slicer(1), () => alive), { x: 0, z: 0 }, 16);
		await new Promise((res) => setImmediate(res));
		alive = false;
		const r = await p;
		expect(r.found).toEqual([]);
	});
});
