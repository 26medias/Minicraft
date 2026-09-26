import { describe, expect, it } from 'vitest';
import { BehaviourRunner } from '../../src/brain2/runner.js';
import { spiralStep, spiralsFor, type Spiral } from '../../src/brain2/behaviours/spiral.js';
import { createPerceiver } from '../../src/brain2/perception.js';
import { Ownership } from '../../src/brain2/ownership.js';
import { Tripwire } from '../../src/brain2/safety.js';
import { Store, initialState } from '../../src/brain2/store.js';
import { ManualClock } from '../../src/brain2/clock.js';
import { PIP } from '../../src/brain2/data/personalities.data.js';
import { StopSignal } from '../../src/body/stop-signal.js';
import type { Dig, Vec3 } from '../../src/brain2/types.js';
import { FakeBody, FakeWorld, id, player } from '../fake-port.js';

// A natural dirt "tower" in open air above seed 12345's terrain (surface y≈104–138): columns 200..215 × 200..215,
// y 141..220. Its surface is y 220, so feet stand at y0 = 221. Targets are placed inside it by hand; world spawn
// (the scan's anchor when no kid or build exists) is above the target column, so that column is scanned first.
const T0 = 200, T1 = 215, BOTTOM = 141, TOP = 220, Y0 = TOP + 1;
const TX = 208, TZ = 208;
const k = (c: Vec3) => `${c.x},${c.y},${c.z}`;
const flat = () => Y0;

function mineRig(o: { inventory?: Record<string, number> } = {}) {
	const clock = new ManualClock(0);
	const world = new FakeWorld();
	for (let x = T0; x <= T1; x++) for (let z = T0; z <= T1; z++) for (let y = BOTTOM; y <= TOP; y++) world.setNatural(x, y, z, 'dirt');
	const body = new FakeBody();
	body.world = world;
	body.current = { x: 212.5, y: Y0, z: 212.5, yaw: 0, pitch: 0 };
	const store = new Store(initialState(PIP, body.current), clock.now);
	store.apply([{ path: ['inventory'], value: o.inventory ?? {} }], { kind: 'body', by: 'test' });
	const own = new Ownership(world, () => store.state.owned);
	const perceiver = createPerceiver({ body, world, own, store, tuning: { followDist: 2, idleSwitchMs: 30_000, minTargetMs: 20_000 }, clock: clock.now });
	const tripwire = new Tripwire(600);
	const stop = new StopSignal(600_000);
	const logs: Array<[string, unknown]> = [];
	const runner = new BehaviourRunner({
		store, body, world, own, perceiver, tripwire, stop, clock: clock.now, noEdits: () => false, fit: async () => 'yes',
		log: (kind, d) => logs.push([kind, d]), rng: () => 0, spawn: { x: TX, y: Y0, z: TZ }, styleOverride: { editGapMs: 600 },
	});
	const see = () => store.apply(perceiver.tick(clock.t), { kind: 'perception', by: 'perceive' });
	const ticks = async (n: number) => {
		for (let i = 0; i < n; i++) {
			clock.advance(100);
			see();
			await runner.tick();
		}
	};
	const until = async (cond: () => boolean, max = 5000) => {
		for (let i = 0; i < max && !cond(); i++) await ticks(1);
		if (!cond()) throw new Error('condition never met');
	};
	const runToEnd = async (max = 5000) => {
		await until(() => store.state.behaviour === null, max);
		return store.state.memory.past[0];
	};
	const start = (block: string) => runner.start('mine', { block });
	const dig = (): Dig => store.state.digs[0];
	const mines = () => body.calls.filter((c) => c.fn === 'mine').map((c) => (c.args as number[]).join(','));
	const kid = (x: number, y: number, z: number) => {
		body.list = [player({ id: 7, name: 'Noah', x, y, z })];
		see();
	};
	return { clock, world, body, store, own, runner, tripwire, logs, see, ticks, until, runToEnd, start, dig, mines, kid };
}
type Rig = ReturnType<typeof mineRig>;
/** The spiral the bot picks for a target in the flat tower: spiralsFor's first candidate (j = 0, all equally deep). */
const expected = (t: Vec3): Spiral => spiralsFor(t, flat)[0];
const stepsOf = (sp: Spiral) => Array.from({ length: sp.lastStep + 1 }, (_, i) => spiralStep(sp, i));
/** An iron_ore target 7 below the surface (lastStep 6), with `extra` more iron_ore cells. */
function shallowIron(r: Rig, extra: Vec3[] = []): Vec3 {
	const t = { x: TX, y: Y0 - 7, z: TZ };
	for (const c of [t, ...extra]) r.world.setNatural(c.x, c.y, c.z, 'iron_ore');
	return t;
}
/** A target block 71 below the surface (lastStep 70: more than one episode's S = 67 steps). */
function deep(r: Rig, block: string): Vec3 {
	const t = { x: TX, y: 150, z: TZ };
	r.world.setNatural(t.x, t.y, t.z, block);
	return t;
}

describe('Mine (spec §6.2)', () => {
	// Red if the vein isn't followed (only the target), N isn't the cap, or it doesn't end done.
	it('mines up to 8 target blocks from a shallow target and ends done', async () => {
		const r = mineRig();
		const cluster: Vec3[] = [];
		for (const x of [TX + 1, TX + 2]) for (const z of [TZ - 1, TZ, TZ + 1]) for (const y of [Y0 - 8, Y0 - 7, Y0 - 6]) cluster.push({ x, y, z });
		const t = shallowIron(r, cluster);
		r.start('iron_ore');
		expect(await r.runToEnd()).toMatchObject({ behaviour: 'mine', outcome: 'done' });
		expect(r.store.state.inventory.iron_ore).toBe(8);
		expect(r.mines()).toContain(k(t));
		expect(r.dig()).toMatchObject({ block: 'iron_ore', status: 'done', target: t, spiral: expected(t) });
		expect(r.tripwire.halted).toBeNull();
	});

	// Criterion 8. Red if the floor fills or the episode's breaks exceed plannedEdits (overrun), the pace breaks the
	// rate, or the episode doesn't pause at 120 s.
	it('criterion 8: a full 120 s stone episode at 600 ms pacing, including a cave crossing with floor fills, never trips the tripwire, and ends paused', async () => {
		const r = mineRig({ inventory: { stone: 10 } });
		const t = deep(r, 'stone');
		const steps = stepsOf(expected(t));
		for (const i of [5, 6]) r.world.setNatural(steps[i].floor.x, steps[i].floor.y, steps[i].floor.z, 'air');   // a cave under 2 steps
		// plannedEdits, by x-ray: the non-air cells of the next S = 67 steps, their air floors (exactly 2), plus N = 8.
		let want = 8;
		for (const st of steps.slice(0, 67)) {
			want += st.clear.filter((c) => r.world.getBlock(c.x, c.y, c.z) !== 0).length;
			if (r.world.getBlock(st.floor.x, st.floor.y, st.floor.z) === 0) want++;
		}
		r.start('stone');
		await r.until(() => r.store.state.digs.length === 1);
		expect(r.store.state.behaviour?.plannedEdits).toBe(want);
		const end = await r.runToEnd(2000);
		expect(end).toMatchObject({ outcome: 'paused' });
		expect(end.lastedMs).toBeGreaterThanOrEqual(120_000);
		expect(r.tripwire.halted).toBeNull();
		for (const i of [5, 6]) expect(r.world.isSolid(r.world.getBlock(steps[i].floor.x, steps[i].floor.y, steps[i].floor.z)), `floor ${i}`).toBe(true);
		expect(r.body.calls.filter((c) => c.fn === 'place')).toHaveLength(2);
		expect(r.dig().status).toBe('paused');
		expect(r.dig().stepsDone).toBeGreaterThan(40);
	});

	// Red if the resume walks straight to step k: walkTo is 2D, so it would stop on the step k mod 8 above (gate 2).
	it('resume walks down every dug step in order, then continues from stepsDone', async () => {
		const r = mineRig();
		const t = deep(r, 'stone');
		r.start('stone');
		await r.until(() => (r.store.state.digs[0]?.stepsDone ?? 0) >= 10);
		r.runner.end('interrupted', 'test');
		expect(r.dig().status).toBe('paused');
		const done = r.dig().stepsDone;
		r.body.current = { x: 212.5, y: Y0, z: 212.5, yaw: 0, pitch: 0 };
		const from = r.body.calls.length;
		r.start('stone');
		expect(r.dig().status).toBe('active');
		await r.until(() => r.dig().stepsDone > done);
		const after = r.body.calls.slice(from);
		const walks = after.filter((c) => c.fn === 'walkTo').map((c) => c.args[0]);
		const steps = stepsOf(expected(t));
		expect(walks.slice(0, done)).toEqual(steps.slice(0, done).map((s) => ({ x: s.feet.x + 0.5, z: s.feet.z + 0.5 })));
		const firstMine = after.find((c) => c.fn === 'mine')!.args as number[];
		expect(steps[done].clear.map(k)).toContain(firstMine.join(','));
	});

	// Spec §6 "at resume". Red if the leash is checked only at the start: the far dig would resume.
	it('resume re-checks the leash: a paused dig whose pillar is now > 32 from the kid is not resumed', async () => {
		const r = mineRig();
		deep(r, 'stone');
		r.start('stone');
		await r.until(() => (r.store.state.digs[0]?.stepsDone ?? 0) >= 3);
		r.runner.end('interrupted', 'test');
		const paused = r.dig();
		const far = { x: TX + 42, z: TZ };
		r.kid(far.x + 0.5, r.world.surfaceY(far.x, far.z) + 1, far.z + 0.5);
		r.start('stone');
		await r.ticks(60);
		expect(r.store.state.digs[0]).toMatchObject({ id: paused.id, status: 'paused', stepsDone: paused.stepsDone });
		if (r.store.state.behaviour) r.runner.end('interrupted', 'test');
		// Control: with the kid back within the leash, the same dig resumes.
		r.kid(TX + 10.5, Y0, TZ + 0.5);
		r.start('stone');
		expect(r.store.state.digs[0]).toMatchObject({ id: paused.id, status: 'active' });
	});

	// Spec §6.2. Red if an air floor is stepped over, or the bot re-routes (mines elsewhere) instead of ending.
	it('stuck (gap) with an empty inventory; never re-routes', async () => {
		const r = mineRig();
		const t = shallowIron(r);
		const s0 = stepsOf(expected(t))[0];
		r.world.setNatural(s0.floor.x, s0.floor.y, s0.floor.z, 'air');
		r.start('iron_ore');
		expect(await r.runToEnd()).toMatchObject({ outcome: 'failed', why: 'stuck (gap)' });
		expect(r.store.state.events.filter((e) => e.kind === 'stuck')).toEqual([expect.objectContaining({ detail: 'stuck (gap)', salient: true })]);
		expect(r.mines()).toEqual([]);
		expect(r.body.calls.filter((c) => c.fn === 'place')).toEqual([]);
		expect(r.dig().status).toBe('paused');
	});

	// Red if a liquid next to a cell to clear doesn't end the episode (the safety tier would reject it 3 times and
	// the dig would stay paused, retrying the same spiral), or no hazard event is written.
	it('hazard: natural water next to a cell to clear → failed hazard, dig dropped, hazard event', async () => {
		const r = mineRig();
		const t = shallowIron(r);
		const sp = expected(t);
		const s2 = spiralStep(sp, 2);
		const mid = s2.clear[1];
		const out = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: mid.x + dx, y: mid.y, z: mid.z + dz }))
			.find((c) => Math.max(Math.abs(c.x - sp.px), Math.abs(c.z - sp.pz)) === 2)!;
		r.world.setNatural(out.x, out.y, out.z, 'water');
		r.start('iron_ore');
		expect(await r.runToEnd()).toMatchObject({ outcome: 'failed', why: 'hazard' });
		expect(r.store.state.events.filter((e) => e.kind === 'hazard')).toEqual([expect.objectContaining({ salient: true })]);
		expect(r.dig().status).toBe('dropped');
		for (const c of s2.clear) expect(r.mines()).not.toContain(k(c));
	});

	// Red if uncovered ores write no found event, write it twice for one cell, or the ore is mined.
	it('found: an uncovered coal_ore that isn\'t the target → found event once', async () => {
		const r = mineRig();
		const t = shallowIron(r);
		const sp = expected(t);
		// A pillar cell beside two edge steps (steps 1 and 3 both clear this y): uncovered twice, reported once.
		const s1 = spiralStep(sp, 1), s3 = spiralStep(sp, 3);
		const y = s1.clear.map((c) => c.y).find((yy) => s3.clear.some((c) => c.y === yy))!;
		const coal = { x: sp.px, y, z: sp.pz };
		expect(Math.abs(s1.feet.x - sp.px) + Math.abs(s1.feet.z - sp.pz)).toBe(1);
		expect(Math.abs(s3.feet.x - sp.px) + Math.abs(s3.feet.z - sp.pz)).toBe(1);
		r.world.setNatural(coal.x, coal.y, coal.z, 'coal_ore');
		r.start('iron_ore');
		expect(await r.runToEnd()).toMatchObject({ outcome: 'done' });
		expect(r.store.state.events.filter((e) => e.kind === 'found')).toEqual([expect.objectContaining({ cell: coal, block: 'coal_ore', salient: true })]);
		expect(r.world.getBlock(coal.x, coal.y, coal.z)).toBe(id('coal_ore'));
	});

	// R14. Red if deep targets are refused, or the paused-dig cap isn't enforced (or counts a resume as a new dig).
	it('R14: a deep diamond target is allowed; paused digs accumulate up to 3, then \'too many digs\'', async () => {
		const r = mineRig();
		const t = deep(r, 'diamond_ore');
		r.start('diamond_ore');
		await r.until(() => r.store.state.digs.length === 1);
		expect(r.dig()).toMatchObject({ target: t, status: 'active' });
		expect(r.dig().spiral.lastStep).toBe(70);
		r.runner.end('interrupted', 'test');
		const other = (n: number, block: string): Dig => ({ id: `d${n}`, block, entrance: { x: 300, y: 120, z: 300 }, target: { x: 300, y: 60, z: 300 }, stepsDone: 0, cells: [], status: 'paused', spiral: { px: 299, pz: 300, y0: 120, phase: 0, lastStep: 59 } });
		r.store.apply([{ path: ['digs'], value: [...r.store.state.digs, other(2, 'gold_ore'), other(3, 'lapis_ore')] }], { kind: 'body', by: 'test' });
		r.start('coal_ore');
		expect(r.store.state.memory.past[0]).toMatchObject({ behaviour: 'mine', outcome: 'failed', why: 'too many digs' });
		r.start('diamond_ore');                              // a resume adds no dig
		expect(r.store.state.behaviour?.kind).toBe('mine');
		expect(r.dig().status).toBe('active');
		expect(r.store.state.digs).toHaveLength(3);
	});

	// Review Focus 5. Red if the runner spins, writes no stuck event, counts the rejections as plan vetoes (the
	// tripwire halts), or the dig is left active.
	it('Review Focus 5 — kid inside the staircase → failed \'kid body buffer\', a stuck event, tripwire null', async () => {
		const r = mineRig();
		shallowIron(r);
		r.start('iron_ore');
		await r.until(() => (r.store.state.digs[0]?.stepsDone ?? 0) >= 2);
		const p = r.body.pose();
		r.kid(p.x, p.y, p.z);                                // Noah climbs down beside the bot, onto step 1
		const n = r.mines().length;
		expect(await r.runToEnd(50)).toMatchObject({ outcome: 'failed', why: 'kid body buffer' });
		expect(r.store.state.events.filter((e) => e.kind === 'stuck')).toEqual([expect.objectContaining({ detail: 'kid body buffer', salient: true })]);
		expect(r.tripwire.halted).toBeNull();
		expect(r.mines()).toHaveLength(n);
		expect(r.dig().status).toBe('paused');
	});

	// Criterion 7. Red if the kid-cell rule is missing at plan time: the target's own spirals (≤ 7 from the kid's
	// block) would be chosen.
	it('the pillar area is ≥ 12 from kid cells at plan time', async () => {
		const r = mineRig();
		deep(r, 'stone');
		const kidCell = { x: TX, y: Y0, z: TZ + 5 };
		r.world.set(kidCell.x, kidCell.y, kidCell.z, 'dirt');   // an edited cell nobody owns: a kid cell
		r.start('stone');
		await r.until(() => r.store.state.digs.length === 1 || r.store.state.behaviour === null);
		const sp = r.dig().spiral;
		expect(Math.hypot(sp.px - kidCell.x, sp.pz - kidCell.z)).toBeGreaterThanOrEqual(13.5);
		expect(r.own.kidCellWithin(sp.px, sp.pz, 13.5)).toBe(false);
	});

	// Red if vein mining ignores safeToMine: the pillar and the last step's floor hold target blocks next to mined ones.
	it('vein mining never breaks a floor or the pillar', async () => {
		const r = mineRig();
		const t0 = { x: TX, y: Y0 - 7, z: TZ };
		const sp = expected(t0);
		const last = spiralStep(sp, sp.lastStep);
		const pillar = [{ x: sp.px, y: t0.y, z: sp.pz }, { x: sp.px, y: t0.y - 1, z: sp.pz }];
		const below = { x: t0.x, y: t0.y - 1, z: t0.z };            // safe: no step uses the target's column
		const aside = { x: t0.x + 1, y: t0.y, z: t0.z };            // safe: outside the ring
		shallowIron(r, [...pillar, last.floor, below, aside]);
		expect(Math.abs(last.floor.x - below.x) + Math.abs(last.floor.z - below.z) + Math.abs(last.floor.y - below.y)).toBe(1);
		r.start('iron_ore');
		expect(await r.runToEnd()).toMatchObject({ outcome: 'done' });
		expect(r.dig().spiral).toEqual(sp);
		for (const c of [...pillar, last.floor]) expect(r.world.getBlock(c.x, c.y, c.z), k(c)).toBe(id('iron_ore'));
		expect(r.store.state.inventory.iron_ore).toBe(3);
	});

	// Spec §6.2 ending. Red if either failure leaves the dig active or drops it (both are fixable: more inventory,
	// the kid moving away), or a resume doesn't pick it up.
	it('after stuck (gap) and after kid body buffer, the dig is paused and resumable', async () => {
		const gap = mineRig();
		const t = shallowIron(gap);
		const s0 = stepsOf(expected(t))[0];
		gap.world.setNatural(s0.floor.x, s0.floor.y, s0.floor.z, 'air');
		gap.start('iron_ore');
		expect(await gap.runToEnd()).toMatchObject({ why: 'stuck (gap)' });
		expect(gap.dig().status).toBe('paused');
		gap.store.apply([{ path: ['inventory'], value: { dirt: 3 } }], { kind: 'body', by: 'test' });
		gap.start('iron_ore');
		expect(gap.dig().status).toBe('active');
		expect(await gap.runToEnd()).toMatchObject({ outcome: 'done' });
		expect(gap.store.state.digs).toHaveLength(1);

		const kid = mineRig();
		shallowIron(kid);
		kid.start('iron_ore');
		await kid.until(() => (kid.store.state.digs[0]?.stepsDone ?? 0) >= 2);
		const p = kid.body.pose();
		kid.kid(p.x, p.y, p.z);
		expect(await kid.runToEnd(50)).toMatchObject({ why: 'kid body buffer' });
		expect(kid.dig().status).toBe('paused');
		kid.body.list = [];
		kid.see();
		kid.start('iron_ore');
		expect(kid.dig().status).toBe('active');
		expect(await kid.runToEnd()).toMatchObject({ outcome: 'done' });
		expect(kid.store.state.digs).toHaveLength(1);
	});
});
