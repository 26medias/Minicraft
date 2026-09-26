// The landscaper honours a board flat-needed request's size, and it never rests (nor hovers) between the blasts of
// one area: the rest is between areas, on the ground.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blockName, isLiquidId, isSolidId } from 'minicraft-bot';
import type { WorldView } from '../../src/port.js';
import type { Vec3 } from '../../src/types.js';
import { list, post } from '../../src/board/board.js';
import { evaluateArea, terrainTop, type CellClass } from '../../src/landscaper/blast-plan.js';
import { runLandscaper, saveLandscaperFile, type LandscaperFile } from '../../src/landscaper/landscaper.js';
import { FakeBody, FakeWorld, id } from '../fake-port.js';

const STONE = id('stone'), DIRT = id('dirt');
const hilly = (x: number, z: number) => 64 + Math.floor(4 * Math.sin(x / 5) + 3 * Math.cos(z / 3) + 4);

/** A height function of stone and dirt, plus the cells the bot writes (its own: not a kid's). */
class HillWorld implements WorldView {
	mustMine = false;
	cells = new Map<string, number>();
	getBlock(x: number, y: number, z: number): number {
		const v = this.cells.get(`${x},${y},${z}`);
		if (v !== undefined) return v;
		const h = hilly(x, z);
		return y <= h ? (y === h ? DIRT : STONE) : 0;
	}
	set(x: number, y: number, z: number, v: number | string): void {
		this.cells.set(`${x},${y},${z}`, typeof v === 'string' ? id(v) : v);
	}
	blockName = (v: number) => blockName(v);
	isSolid = (v: number) => isSolidId(v);
	isLiquid = (v: number) => isLiquidId(v);
	groundY(x: number, z: number, nearY: number): number | null {
		for (let y = Math.floor(nearY) + 2; y >= Math.floor(nearY) - 64; y--) {
			if (isSolidId(this.getBlock(Math.floor(x), y - 1, Math.floor(z))) && !isSolidId(this.getBlock(Math.floor(x), y, Math.floor(z))) && !isSolidId(this.getBlock(Math.floor(x), y + 1, Math.floor(z)))) return y;
		}
		return null;
	}
	raycast = () => null;
	generatedBlock = () => 0;
	isEdited = () => false;
	editedCellsInChunk = (): Array<[number, number, number]> => [];
}
const natural = (): CellClass => 'natural';

const until = async (p: () => boolean, ms: number) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms && !p()) await new Promise((r) => setTimeout(r, 10));
	expect(p()).toBe(true);
};

function bodyOn(w: HillWorld, at: Vec3): FakeBody {
	const body = new FakeBody();
	body.world = w as unknown as FakeWorld;
	body.current = { ...at, yaw: 0, pitch: 0 };
	return body;
}

describe('landscaper: a flat-needed request', () => {
	it('flattens a square of the requested side (24), flat all over at one floor, not its own 16', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'land-req-'));
		const w = new HillWorld();
		const boardPath = join(dir, 'board.json');
		const req = post(boardPath, { type: 'flat-needed', center: { x: 200, y: 0, z: 200 }, size: 24, requester: 'Boss' }, 1).post;
		const logs: Array<Record<string, unknown>> = [];
		const h = runLandscaper({
			name: 'Dan', body: bodyOn(w, { x: 200.5, y: 90, z: 200.5 }), world: w, spawn: { x: -500, y: 0, z: -500 }, primary: null, noEdits: true,
			statePath: join(dir, 's.json'), boardPath, log: (e) => logs.push(e), rng: () => 0.5, breakMany: async () => [],
		});
		await until(() => logs.some((l) => l.k === 'area'), 20_000);
		await h.stop();
		const a = logs.find((l) => l.k === 'area')!;
		expect(a).toMatchObject({ size: 24, post: req.id });
		expect(list(boardPath).find((q) => q.id === req.id)).toMatchObject({ status: 'claimed', claimedBy: 'Dan' });
		// The planned square is flat at L over the whole 24 × 24 (evaluateArea with the full footprint agrees).
		const saved = JSON.parse(readFileSync(join(dir, 's.json'), 'utf8')) as LandscaperFile;
		const area = saved.areas[0];
		expect(area.size).toBe(24);
		expect(typeof evaluateArea(w, area.x0, area.z0, 24, { classify: natural, kidCells: [], kids: [] }, undefined, 24)).toBe('object');
	}, 30_000);
});

describe('landscaper: no rest between the blasts of one area, and it idles on the ground', () => {
	it('blasts every spot of the area back to back (rest 60 s would stall it), then lands to rest', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'land-rest-'));
		const w = new HillWorld();
		const plan = evaluateArea(w, 0, 0, 16, { classify: natural, kidCells: [], kids: [] });
		if (typeof plan === 'string') throw new Error(plan);
		expect(plan.spots.length).toBeGreaterThanOrEqual(2);
		const f: LandscaperFile = {
			v: 1, inv: { flatten_tnt: plan.spots.length }, blasts: [], crafts: [], owned: {}, triedAreas: [], triedSpots: [],
			areas: [{ ...plan, range: plan.range, id: 'a', status: 'active', t: 0, done: [] }],
		};
		saveLandscaperFile(join(dir, 's.json'), f);
		const body = bodyOn(w, { x: 8.5, y: terrainTop(w, 8, 8) + 1, z: 8.5 });
		const logs: Array<Record<string, unknown>> = [];
		const h = runLandscaper({
			name: 'Dan', body, world: w, spawn: { x: -500, y: 0, z: -500 }, primary: null, noEdits: false,
			statePath: join(dir, 's.json'), boardPath: join(dir, 'board.json'), log: (e) => logs.push(e), rng: () => 0.5,
			restMs: 60_000, fuseMs: 20, maxBlasts: plan.spots.length,
			mine: async (x, y, z) => {
				w.set(x, y, z, 0);
				return true;
			},
			breakMany: async (cells) => {
				const out = cells.filter((q) => q.expect === undefined || w.getBlock(q.x, q.y, q.z) === q.expect).map(({ x, y, z }) => ({ x, y, z }));
				for (const q of out) w.set(q.x, q.y, q.z, 0);
				return out;
			},
		});
		try {
			await until(() => logs.some((l) => l.k === 'flattened'), 25_000);
			const blasts = logs.filter((l) => l.k === 'blast' || l.k === 'blast-skipped' || l.k === 'blast-dropped');
			expect(logs.filter((l) => l.k === 'blast').length).toBeGreaterThanOrEqual(2);
			expect(blasts.length).toBe(plan.spots.length);
			// Resting: on the ground under it, not hovering where it watched the last fuse from.
			await until(() => {
				const p = body.pose();
				return Math.abs(p.y - (terrainTop(w, Math.floor(p.x), Math.floor(p.z)) + 1)) < 0.01;
			}, 2000);
			expect(h.stats.current).toMatch(/resting between areas|blast cap/);
		} finally {
			await h.stop();
		}
	}, 40_000);
});
