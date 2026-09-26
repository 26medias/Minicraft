// The foreman on the shared board: with no viable plan it asks for flat ground (one flat-needed at a time), and it
// lays a new plan on the landscaper's 'flattened' answer, archiving the old plan.
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { list, post } from '../../src/board/board.js';
import { FLAT_NEEDED_SIZE, runForeman } from '../../src/foreman/foreman.js';
import { createPlan, readPlan, type NeighbourhoodPlan } from '../../src/foreman/plan-file.js';
import { FakeBody, FakeWorld } from '../fake-port.js';

const G = 120;
const R = { x0: 300, z0: 300, x1: 323, z1: 323 };
const SPAWN = { x: 260, y: 0, z: 260 };

function setup() {
	const world = new FakeWorld();
	for (let x = R.x0 - 2; x <= R.x1 + 2; x++) {
		for (let z = R.z0 - 2; z <= R.z1 + 2; z++) {
			for (let y = G - 2; y <= G; y++) world.setNatural(x, y, z, y === G ? 'grass_block' : 'dirt');
			for (let y = G + 1; y <= G + 40; y++) world.setNatural(x, y, z, 0);
		}
	}
	const root = mkdtempSync(join(tmpdir(), 'foreman-board-'));
	const planPath = join(root, 'plan.json');
	const old: NeighbourhoodPlan = {
		v: 1, id: 'old', foreman: 'Boss', t: 0, anchor: SPAWN, corner: { x: 100, z: 100 }, cols: 2, rows: 2, roads: [], lamps: [],
		lots: [1, 2, 3, 4].map((i) => ({ id: `lot-${i}`, origin: { x: 100 + i * 11, y: 70, z: 100 }, w: 7, d: 7, h: 16, status: 'dropped' as const, dropCount: 3, why: 'not-flat' })),
	};
	createPlan(planPath, old);
	return { world, root, planPath, boardPath: join(root, 'board.json') };
}

function start(s: ReturnType<typeof setup>, log: Array<Record<string, unknown>>, status: string[]) {
	const body = new FakeBody();
	body.world = s.world;
	body.current = { x: R.x0 + 0.5, y: G + 1, z: R.z0 - 3 + 0.5, yaw: 0, pitch: 0 };
	return runForeman({
		name: 'Boss', body, world: s.world, spawn: SPAWN, noEdits: true, statePath: join(s.root, 'Boss.json'), planPath: s.planPath,
		boardPath: s.boardPath, log: (e) => log.push(e), status: (l) => status.push(l), statusEveryMs: 20, rng: () => 0.3, paceMs: 0,
	});
}

const until = async (p: () => boolean, ms = 5000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms && !p()) await new Promise((r) => setTimeout(r, 10));
	expect(p()).toBe(true);
};

describe('foreman ↔ board', () => {
	it('every lot dropped: posts one flat-needed (≥ 24, near spawn, by Boss), and only one across a restart', async () => {
		const s = setup();
		for (let run = 0; run < 2; run++) {
			const log: Array<Record<string, unknown>> = [];
			const status: string[] = [];
			const h = start(s, log, status);
			await until(() => status.some((l) => l.includes('waiting for flat ground (board post ')));
			await h.stop();
			expect(log.filter((e) => e.k === 'flat-needed')).toHaveLength(run === 0 ? 1 : 0);
		}
		const posts = list(s.boardPath, { type: 'flat-needed' });
		expect(posts).toHaveLength(1);
		expect(posts[0]).toMatchObject({ requester: 'Boss', status: 'open', center: { x: SPAWN.x, z: SPAWN.z } });
		expect(posts[0].size).toBeGreaterThanOrEqual(24);
		expect(FLAT_NEEDED_SIZE).toBeGreaterThanOrEqual(24);
		expect(readPlan(s.planPath)!.id).toBe('old');
	});

	it('a flattened post for Boss: a new plan inside the region at the floor, the old plan archived, the post done', async () => {
		const s = setup();
		const fp = post(s.boardPath, { type: 'flattened', region: { ...R, y: G }, floor: G, size: 24, requester: 'Boss' }, 1).post;
		const log: Array<Record<string, unknown>> = [];
		const status: string[] = [];
		const h = start(s, log, status);
		await until(() => log.some((e) => e.k === 'plan'));
		await h.stop();
		expect(log.some((e) => e.k === 'flat-needed')).toBe(false);
		const p = readPlan(s.planPath)!;
		expect(p.id).not.toBe('old');
		expect(p.lots.length).toBeGreaterThanOrEqual(4);
		for (const l of p.lots) {
			expect(l.status).toBe('open');
			expect(l.origin.y).toBe(G + 1);
			expect(l.origin.x).toBeGreaterThanOrEqual(R.x0);
			expect(l.origin.z).toBeGreaterThanOrEqual(R.z0);
			expect(l.origin.x + l.w - 1).toBeLessThanOrEqual(R.x1);
			expect(l.origin.z + l.d - 1).toBeLessThanOrEqual(R.z1);
		}
		for (const c of [...p.roads, ...p.lamps]) {
			expect(c.cell.x).toBeGreaterThanOrEqual(R.x0);
			expect(c.cell.x).toBeLessThanOrEqual(R.x1);
			expect(c.cell.z).toBeGreaterThanOrEqual(R.z0);
			expect(c.cell.z).toBeLessThanOrEqual(R.z1);
		}
		const archives = readdirSync(s.root).filter((f) => /^plan-\d+\.json$/.test(f));
		expect(archives).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(s.root, archives[0]), 'utf8')).id).toBe('old');
		expect(list(s.boardPath).find((q) => q.id === fp.id)!.status).toBe('done');
		expect(log.find((e) => e.k === 'flattened-claimed')).toMatchObject({ post: fp.id });
	});
});
