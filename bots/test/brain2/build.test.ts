import { describe, expect, it } from 'vitest';
import { BehaviourRunner } from '../../src/brain2/runner.js';
import { build, standing, type BuildParams } from '../../src/brain2/behaviours/build.js';
import { templateOf } from '../../src/brain2/behaviours/templates.data.js';
import { evaluateSite, type Site } from '../../src/brain2/behaviours/site-search.js';
import { createPerceiver } from '../../src/brain2/perception.js';
import { Ownership } from '../../src/brain2/ownership.js';
import { Tripwire } from '../../src/brain2/safety.js';
import { Store, initialState } from '../../src/brain2/store.js';
import { ManualClock } from '../../src/brain2/clock.js';
import { PIP } from '../../src/brain2/data/personalities.data.js';
import { StopSignal } from '../../src/body/stop-signal.js';
import type { Build, Vec3 } from '../../src/brain2/types.js';
import { FakeBody, FakeWorld, id, player } from '../fake-port.js';

// A natural stone platform at y 199 in open air (seed 12345's surface is at y≈104–138), so sites sit at groundY 199
// and the bot stands at feet y 200. World spawn is in its middle; every site is ≥ 16 from it.
const Y = 200;
const P0 = 96, P1 = 175;
const SPAWN = { x: 132, y: Y, z: 132 };
const k = (c: Vec3) => `${c.x},${c.y},${c.z}`;

function buildRig(o: { inventory?: Record<string, number> } = {}) {
	const clock = new ManualClock(0);
	const world = new FakeWorld();
	for (let x = P0; x <= P1; x++) for (let z = P0; z <= P1; z++) world.setNatural(x, Y - 1, z, 'stone');
	const body = new FakeBody();
	body.world = world;
	body.current = { x: 132.5, y: Y, z: 132.5, yaw: 0, pitch: 0 };
	const store = new Store(initialState(PIP, body.current), clock.now);
	store.apply([{ path: ['inventory'], value: o.inventory ?? { stone: 400 } }], { kind: 'body', by: 'test' });
	const own = new Ownership(world, () => store.state.owned);
	const perceiver = createPerceiver({ body, world, own, store, tuning: { followDist: 2, idleSwitchMs: 30_000, minTargetMs: 20_000 }, clock: clock.now });
	const tripwire = new Tripwire(600);
	const stop = new StopSignal(600_000);
	const logs: Array<[string, unknown]> = [];
	const runner = new BehaviourRunner({
		store, body, world, own, perceiver, tripwire, stop, clock: clock.now, noEdits: () => false, fit: async () => 'yes',
		log: (kind, d) => logs.push([kind, d]), rng: () => 0, spawn: SPAWN, styleOverride: { editGapMs: 600 },
	});
	const see = () => store.apply(perceiver.tick(clock.t), { kind: 'perception', by: 'perceive' });
	const ticks = async (n: number) => {
		for (let i = 0; i < n; i++) {
			clock.advance(100);
			see();
			await runner.tick();
		}
	};
	/** Ticks until the behaviour ends (or `max` ticks). */
	const runToEnd = async (max = 20_000) => {
		for (let i = 0; i < max && store.state.behaviour; i++) await ticks(1);
		if (store.state.behaviour) throw new Error(`still running: ${JSON.stringify(store.state.behaviour)}`);
		return store.state.memory.past[0];
	};
	/** A site for `template` at origin (ox, oz) on the platform, from the site rules. */
	const siteAt = (template: string, variant: 'small' | 'medium', ox: number, oz: number): Site => {
		const t = templateOf(template, variant);
		const s = evaluateSite(ox, oz, { w: t.w, d: t.d, h: t.h, anchor: { x: ox, y: Y, z: oz }, avoid: [] }, { world, own: new Ownership(world, () => ({})), spawn: SPAWN });
		if (!s) throw new Error('no site there');
		return s;
	};
	const edits = () => body.calls.filter((c) => c.fn === 'place' || c.fn === 'break').map((c) => (c.args as number[]).slice(0, 3).join(','));
	/** A kid's block: an edited cell nobody owns. */
	const kidCell = (c: Vec3) => {
		world.set(c.x, c.y, c.z, 'dirt');
		own.onEdit({ by: 7, byName: 'Noah', byBot: false, opCount: 1, cells: [{ ...c, oldId: 0, newId: id('dirt') }] }, body.you);
	};
	return { clock, world, body, store, own, runner, tripwire, logs, see, ticks, runToEnd, siteAt, edits, kidCell };
}
type Rig = ReturnType<typeof buildRig>;
const standingCount = (r: Rig) => r.store.state.builds.filter((b) => standing(b, r.world)).length;
const params = (p: Partial<BuildParams> & { template: string }): BuildParams => ({ variant: 'small', materials: { wall: 'stone' }, ...p });

describe('Build (spec §6, §6.1)', () => {
	// Red if a template cell is skipped or placed with the wrong block, the build isn't recorded/marked done, or
	// the placed cells aren't owned.
	it('builds a small tower to done from a stocked inventory', async () => {
		const r = buildRig();
		const site = r.siteAt('tower', 'small', 150, 150);
		r.runner.start('build', params({ template: 'tower', site }) as unknown as Record<string, unknown>);
		expect(await r.runToEnd()).toMatchObject({ behaviour: 'build', outcome: 'done' });
		const t = templateOf('tower', 'small');
		for (const c of t.cells) {
			const w = { x: site.origin.x + c.x, y: site.origin.y + c.y, z: site.origin.z + c.z };
			expect(r.world.getBlock(w.x, w.y, w.z), k(w)).toBe(id('stone'));
			expect(r.store.state.owned[k(w)]).toBe(id('stone'));
		}
		for (const g of t.doorGaps) expect(r.world.getBlock(site.origin.x + g.x, site.origin.y + g.y, site.origin.z + g.z)).toBe(0);
		expect(r.store.state.builds).toHaveLength(1);
		expect(r.store.state.builds[0]).toMatchObject({ template: 'tower', variant: 'small', origin: site.origin, status: 'done' });
		expect(r.store.state.builds[0].cells).toHaveLength(t.cells.length);
		expect(r.tripwire.halted).toBeNull();
		// The bot never stood inside the footprint.
		for (const c of r.body.calls.filter((x) => x.fn === 'walkTo' || x.fn === 'flyTo')) {
			const p = c.args[0] as { x: number; z: number };
			const inside = p.x > site.origin.x - 0.3 && p.x < site.origin.x + t.w + 0.3 && p.z > site.origin.z - 0.3 && p.z < site.origin.z + t.d + 0.3;
			expect(inside, JSON.stringify(p)).toBe(false);
		}
	});

	// Criterion 8. Red with TRIP_RATE_FACTOR set so the limit is 30 edits / 60 s (rev 1's value): the fastest
	// pacing (600 ms) trips the rate. Also red if levelling or placements exceed plannedEdits (overrun), or one
	// cell is edited 3 times (churn).
	it('criterion 8: a medium house with levelling at the fastest pacing never trips the tripwire', async () => {
		const r = buildRig();
		const ox = 140, oz = 150;
		const bumps = [[ox, oz], [ox + 3, oz + 2], [ox + 6, oz + 6]];
		const holes = [[ox + 1, oz + 4], [ox + 5, oz + 1], [ox + 2, oz + 6]];
		for (const [x, z] of bumps) r.world.setNatural(x, Y, z, 'dirt');
		for (const [x, z] of holes) {
			r.world.setNatural(x, Y - 1, z, 'air');
			r.world.setNatural(x, Y - 2, z, 'stone');
		}
		const site = r.siteAt('house', 'medium', ox, oz);
		expect(site.digs.length + site.fills.length).toBeGreaterThanOrEqual(5);
		r.runner.start('build', params({ template: 'house', variant: 'medium', site }) as unknown as Record<string, unknown>);
		expect(await r.runToEnd()).toMatchObject({ outcome: 'done' });
		expect(r.tripwire.halted).toBeNull();
		for (const d of site.digs) expect(r.world.getBlock(d.x, d.y, d.z), k(d)).toBe(id('stone'));   // dug, then floored
		for (const f of site.fills) expect(r.world.getBlock(f.x, f.y, f.z), k(f)).not.toBe(0);
		expect(r.store.state.builds[0].status).toBe('done');
		const t = templateOf('house', 'medium');
		expect(r.edits()).toHaveLength(site.digs.length + site.fills.length + t.cells.length);
	});

	// Red if running out writes no need event (the runner's rule), or doesn't end failed 'need stone'.
	it('needs: runs out of material → failed \'need stone\' → a salient need event', async () => {
		const r = buildRig({ inventory: { stone: 5 } });
		r.runner.start('build', params({ template: 'tower', site: r.siteAt('tower', 'small', 150, 150) }) as unknown as Record<string, unknown>);
		expect(await r.runToEnd()).toMatchObject({ outcome: 'failed', why: 'need stone' });
		expect(r.edits()).toHaveLength(5);
		expect(r.store.state.events.filter((e) => e.kind === 'need')).toEqual([expect.objectContaining({ block: 'stone', salient: true })]);
		expect(r.store.state.builds[0].status).toBe('building');
	});

	// Red if a site cell turning kid is ignored (the bot builds around the kid's block), if it doesn't replan to
	// a site clear of the kid cell, or replans a second time instead of failing.
	it('replans once when a site cell turns kid, then fails on the second', async () => {
		const r = buildRig();
		const site = r.siteAt('house', 'small', 150, 150);
		r.runner.start('build', params({ template: 'house', site }) as unknown as Record<string, unknown>);
		while (r.edits().length < 4) await r.ticks(1);
		const first = { x: 152, y: site.origin.y + 3, z: 152 };             // a roof cell, not placed yet
		r.kidCell(first);
		for (let i = 0; i < 400 && r.store.state.builds[0].origin.x === 150 && r.store.state.builds[0].origin.z === 150; i++) await r.ticks(1);
		const moved = r.store.state.builds[0].origin;
		expect(moved).not.toEqual(site.origin);
		expect(Math.hypot(moved.x + 2.5 - first.x, moved.z + 2.5 - first.z)).toBeGreaterThanOrEqual(14.5);
		expect(r.store.state.behaviour?.kind).toBe('build');
		const n = r.edits().length;
		while (r.edits().length < n + 3) await r.ticks(1);
		r.kidCell({ x: moved.x + 2, y: moved.y + 3, z: moved.z + 2 });
		expect(await r.runToEnd()).toMatchObject({ outcome: 'failed', why: 'site taken' });
		expect(r.tripwire.halted).toBeNull();
	});

	// Review Focus 5. Red if the runner spins on the rejections, writes no stuck event, or the rejections count as
	// plan vetoes (the tripwire halts).
	it('Review Focus 5 — kid inside footprint', async () => {
		const r = buildRig();
		const site = r.siteAt('tower', 'small', 150, 150);
		r.body.current = { x: 148, y: Y, z: 150.5, yaw: 0, pitch: 0 };       // on the ring, in reach of the first cell
		r.body.list = [player({ id: 7, name: 'Noah', x: 150.5, y: Y, z: 150.5 })];   // standing on the first floor cell
		r.see();
		r.runner.start('build', params({ template: 'tower', site }) as unknown as Record<string, unknown>);
		expect(await r.runToEnd(20)).toMatchObject({ outcome: 'failed', why: 'kid body buffer' });
		expect(r.store.state.events.filter((e) => e.kind === 'stuck')).toEqual([expect.objectContaining({ detail: 'kid body buffer', salient: true })]);
		expect(r.tripwire.halted).toBeNull();
		expect(r.edits()).toEqual([]);
	});

	/** Three small walls built by the real Build (site search, no site given), then a renew. */
	async function threeThenRenew() {
		const r = buildRig({ inventory: { stone: 100 } });
		for (let i = 0; i < 3; i++) {
			r.runner.start('build', params({ template: 'wall' }) as unknown as Record<string, unknown>);
			expect(await r.runToEnd()).toMatchObject({ outcome: 'done' });
		}
		expect(standingCount(r)).toBe(3);
		const old = r.store.state.builds[0];
		r.runner.start('build', params({ template: 'wall', renew: true }) as unknown as Record<string, unknown>);
		const end = await r.runToEnd();
		return { r, old, end };
	}

	// Red on rev 3's "≥ 50% bot cells" standing rule (the dismantled wall's cells are bot cells holding air: it
	// would still count, making 4), or if renew doesn't take the oldest apart first, or doesn't mark it dismantled.
	it('renew: with 3 standing builds, dismantles the oldest (blocks back to inventory), builds elsewhere; the old becomes \'dismantled\', and the count of standing builds stays 3', async () => {
		const { r, old, end } = await threeThenRenew();
		expect(end).toMatchObject({ outcome: 'done' });
		const b = r.store.state.builds;
		expect(b).toHaveLength(4);
		expect(b[0]).toMatchObject({ id: old.id, status: 'dismantled' });
		expect(b[3].status).toBe('done');
		for (const c of old.cells) expect(r.world.getBlock(c.cell.x, c.cell.y, c.cell.z)).toBe(0);
		expect(standingCount(r)).toBe(3);
		expect(r.store.state.inventory.stone).toBe(100 - 21 * 4 + 21);
		const oldKeys = new Set(old.cells.map((c) => k(c.cell)));
		expect(b[3].cells.some((c) => oldKeys.has(k(c.cell)))).toBe(false);
		// The dismantle came first: the renew's first 21 edits are breaks of the old wall.
		const renewCalls = r.body.calls.filter((c) => c.fn === 'place' || c.fn === 'break').slice(63);
		expect(renewCalls.slice(0, 21).every((c) => c.fn === 'break' && oldKeys.has((c.args as number[]).slice(0, 3).join(',')))).toBe(true);
	});

	// Criterion 8. Red if the renewed build reuses the old footprint (each of its cells: placed, broken, placed = 3
	// edits, the churn rule), or the renew's breaks aren't in plannedEdits (overrun).
	it('criterion 8: renew never edits one cell 3 times', async () => {
		const { r } = await threeThenRenew();
		const counts = new Map<string, number>();
		for (const e of r.edits()) counts.set(e, (counts.get(e) ?? 0) + 1);
		expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
		expect(r.tripwire.halted).toBeNull();
	});

	// Rule 10, R5. Red if plan() accepts a liquid, CRAFTED_ONLY, ore or unknown material (or the runner doesn't end at once).
	it('never places a CRAFTED_ONLY or liquid block even if materials name one', () => {
		for (const bad of ['water', 'lava', 'big_tnt', 'coal_ore', 'oak_planks', 'no_such_block']) {
			const r = buildRig({ inventory: { stone: 100, [bad]: 100 } });
			r.runner.start('build', params({ template: 'tower', materials: { wall: 'stone', roof: bad }, site: r.siteAt('tower', 'small', 150, 150) }) as unknown as Record<string, unknown>);
			expect(r.store.state.behaviour, bad).toBeNull();
			expect(r.store.state.memory.past[0], bad).toMatchObject({ behaviour: 'build', outcome: 'failed', why: 'bad material' });
			expect(r.store.state.events.some((e) => e.kind === 'stuck')).toBe(false);
			expect(r.store.state.builds).toEqual([]);
		}
		const r = buildRig();
		const ctx = { world: r.world } as unknown as Parameters<typeof build.plan>[1];
		expect(build.plan(params({ template: 'tower', materials: { wall: 'water' } }), ctx)).toEqual({ failed: 'bad material' });
	});

	// Red if standing counts cells by ownership or by "any block", or rounds 40% up.
	it('a half-built stub (40% of the template placed) is not standing', () => {
		const world = new FakeWorld();
		const t = templateOf('house', 'small');
		const cells = t.cells.map((c) => ({ cell: { x: 300 + c.x, y: Y + c.y, z: 300 + c.z }, block: 'stone' }));
		const b: Build = { id: 'b1', template: 'house', variant: 'small', origin: { x: 300, y: Y, z: 300 }, cells, status: 'building' };
		const n40 = Math.floor(cells.length * 0.4);
		for (const c of cells.slice(0, n40)) world.set(c.cell.x, c.cell.y, c.cell.z, 'stone');
		expect(standing(b, world)).toBe(false);
		for (const c of cells.slice(n40)) world.set(c.cell.x, c.cell.y, c.cell.z, 'dirt');   // the rest filled with another block
		expect(standing(b, world)).toBe(false);
		for (const c of cells.slice(0, Math.ceil(cells.length / 2))) world.set(c.cell.x, c.cell.y, c.cell.z, 'stone');
		expect(standing(b, world)).toBe(true);
	});
});
