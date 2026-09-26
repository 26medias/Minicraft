import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blockNames } from 'minicraft-bot';
import { Ownership } from '../../src/brain2/ownership.js';
import { runBuilder } from '../../src/builder/builder.js';
import { lotSite, MAX_DROPS, reopenDroppedLots } from '../../src/foreman/join.js';
import { createPlan, readPlan, updateLot, claimLot, type NeighbourhoodPlan, type PlanLot } from '../../src/foreman/plan-file.js';
import { SharedCells } from '../../src/shared/bot-cells.js';
import { FakeBody, FakeWorld, id } from '../fake-port.js';

const LX = 200, LZ = 200;

/**
 * A flat natural patch with one 7×7 lot, and the foreman's own cells around it exactly as layout.ts lays them out:
 * a 1-wide verge, then a 2-wide gravel road on top of the ground east of the lot, and a lamp (post + light) on the
 * verge corner, which is inside the lot's 1-block margin. The foreman's cells are in the shared bot-cell registry.
 */
function neighbourhood() {
	const world = new FakeWorld();
	const g = 120; // ground y; the lot's layer 0 is g + 1
	for (let x = LX - 20; x <= LX + 30; x++) {
		for (let z = LZ - 20; z <= LZ + 30; z++) {
			for (let y = g - 3; y <= g; y++) world.setNatural(x, y, z, y === g ? 'grass_block' : 'dirt');
			for (let y = g + 1; y <= g + 40; y++) world.setNatural(x, y, z, 0);
		}
	}
	const root = mkdtempSync(join(tmpdir(), 'join-'));
	const boss = new SharedCells(join(root, 'bot-cells.jsonl'), 'Boss', () => 0, 0);
	const put = (x: number, y: number, z: number, name: string) => {
		world.set(x, y, z, name);
		boss.append({ x, y, z }, id(name));
	};
	for (let z = LZ - 1; z <= LZ + 8; z++) {
		put(LX + 8, g + 1, z, 'gravel');
		put(LX + 9, g + 1, z, 'gravel');
	}
	put(LX + 7, g + 1, LZ + 7, 'oak_log');
	put(LX + 7, g + 2, LZ + 7, 'lamp');
	const lot: PlanLot = { id: 'lot-1', origin: { x: LX, y: g + 1, z: LZ }, w: 7, d: 7, h: 16, status: 'open' };
	const plan: NeighbourhoodPlan = {
		v: 1, id: 'p1', foreman: 'Boss', t: 0, anchor: { x: LX, y: g, z: LZ }, corner: { x: LX, z: LZ }, cols: 1, rows: 1,
		lots: [lot], roads: [], lamps: [],
	};
	const planPath = join(root, 'plan.json');
	createPlan(planPath, plan);
	return { world, g, root, lot, planPath, sharedPath: join(root, 'bot-cells.jsonl') };
}

async function runOnLot(n: ReturnType<typeof neighbourhood>) {
	const body = new FakeBody();
	body.world = n.world;
	body.current = { x: LX - 3, y: n.g + 1, z: LZ - 3, yaw: 0, pitch: 0 };
	const log: Array<Record<string, unknown>> = [];
	const h = runBuilder({
		name: 'Milo', body, world: n.world, spawn: { x: -5000, y: 0, z: -5000 }, primary: null, noEdits: false,
		statePath: join(n.root, 'Milo.json'), log: (e) => log.push(e), rng: () => 0.3, paceMs: 0, restMs: 0,
		known: new Set(blockNames()), shared: new SharedCells(n.sharedPath, 'Milo', () => Date.now(), 0),
		planPath: n.planPath, joinPlan: true, maxBuilds: 50,
	});
	const t0 = Date.now();
	while (Date.now() - t0 < 5000 && !log.some((e) => e.k === 'project' || e.k === 'lot-rejected')) await new Promise((r) => setTimeout(r, 10));
	await h.stop();
	return log;
}

describe('--join-plan: a builder on a foreman lot', () => {
	// Red on the old lotSite: it re-ran the full site rules on the lot's 1-block margin, where the foreman's own lamp
	// stands (not-flat / headroom), so every lot beside a lamp was dropped and nothing was ever built.
	it('builds on a 7×7 lot next to the foreman roads and a lamp on its verge', async () => {
		const n = neighbourhood();
		const log = await runOnLot(n);
		const rejected = log.filter((e) => e.k === 'lot-rejected');
		expect(rejected, JSON.stringify(rejected)).toEqual([]);
		const project = log.find((e) => e.k === 'project');
		expect(project).toMatchObject({ lot: 'lot-1', origin: { y: n.g + 1 } });
		expect(readPlan(n.planPath)!.lots[0]).toMatchObject({ status: 'claimed', claimedBy: 'Milo' });
	});

	it('the full 7×7 footprint fits the lot and layer 0 is the lot height', () => {
		const n = neighbourhood();
		const own = new Ownership(n.world, () => ({}), () => new SharedCells(n.sharedPath, 'x', () => 0, 0).cells());
		const s = lotSite(n.lot, { w: 7, d: 7, h: 9 }, { world: n.world, own, spawn: { x: -5000, y: 0, z: -5000 }, kids: [], avoid: [] });
		expect(s).toMatchObject({ origin: { x: LX, y: n.g + 1, z: LZ } });
	});

	it('a kid cell near the lot still rejects it, with the reason logged and the lot dropped', async () => {
		const n = neighbourhood();
		n.world.set(LX + 3, n.g + 1, LZ - 6, 'dirt'); // a kid's block, 9.5 from the lot centre, not in the registry
		const log = await runOnLot(n);
		expect(log.find((e) => e.k === 'lot-rejected')).toMatchObject({ lot: 'lot-1', why: 'kid-cells', status: 'dropped' });
		expect(log.some((e) => e.k === 'project')).toBe(false);
		expect(readPlan(n.planPath)!.lots[0]).toMatchObject({ status: 'dropped', why: 'kid-cells', dropCount: 1 });
	});
});

describe('foreman: dropped lots reopen when the reason is gone', () => {
	it('stays dropped while the kid cell is there, reopens once it is gone, never after MAX_DROPS drops', () => {
		const n = neighbourhood();
		const kid = { x: LX + 3, y: n.g + 1, z: LZ - 6 };
		n.world.set(kid.x, kid.y, kid.z, 'dirt');
		const own = () => new Ownership(n.world, () => ({}), () => new SharedCells(n.sharedPath, 'x', () => 0, 0).cells());
		const ctx = () => ({ world: n.world, own: own(), spawn: { x: -5000, y: 0, z: -5000 }, kids: [], avoid: [] });
		const log: Array<Record<string, unknown>> = [];
		claimLot(n.planPath, 'A', 1);
		updateLot(n.planPath, 'lot-1', 'A', 2, { status: 'dropped', why: 'kid-cells' });
		expect(reopenDroppedLots(n.planPath, ctx(), (e) => log.push(e), 3)).toEqual([]);
		expect(log.at(-1)).toMatchObject({ k: 'lot-still-dropped', lot: 'lot-1', why: 'kid-cells' });

		// The kid cell is gone (the fake cannot un-edit a cell: the same neighbourhood without it).
		const fresh = neighbourhood();
		const ctx2 = { world: fresh.world, own: new Ownership(fresh.world, () => ({}), () => new SharedCells(fresh.sharedPath, 'x', () => 0, 0).cells()), spawn: { x: -5000, y: 0, z: -5000 }, kids: [], avoid: [] };
		expect(reopenDroppedLots(n.planPath, ctx2, (e) => log.push(e), 4)).toEqual(['lot-1']);
		expect(readPlan(n.planPath)!.lots[0]).toMatchObject({ status: 'open', dropCount: 1 });
		expect(readPlan(n.planPath)!.lots[0].claimedBy).toBeUndefined();

		for (let i = 1; i < MAX_DROPS; i++) {
			claimLot(n.planPath, 'A', 10 + i);
			updateLot(n.planPath, 'lot-1', 'A', 10 + i, { status: 'dropped', why: 'kid-cells' });
			if (i < MAX_DROPS - 1) expect(reopenDroppedLots(n.planPath, ctx2, () => undefined, 20 + i)).toEqual(['lot-1']);
		}
		expect(readPlan(n.planPath)!.lots[0].dropCount).toBe(MAX_DROPS);
		expect(reopenDroppedLots(n.planPath, ctx2, () => undefined, 99)).toEqual([]);
		expect(readPlan(n.planPath)!.lots[0].status).toBe('dropped');
	});
});
