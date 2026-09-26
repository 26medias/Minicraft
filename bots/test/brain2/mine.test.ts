import { describe, expect, it } from 'vitest';
import { BehaviourRunner } from '../../src/brain2/runner.js';
import { BlockedError } from 'minicraft-bot';
import { LIMITS } from '../../src/brain2/data/limits.data.js';
import { exitOf, spiralStep, spiralsFor, type Spiral } from '../../src/brain2/behaviours/spiral.js';
import { BEHAVIOURS, type Behaviour } from '../../src/brain2/behaviours/behaviour.js';
import { escapeTarget } from '../../src/brain2/behaviours/mine.js';
import { createPerceiver } from '../../src/brain2/perception.js';
import { Ownership } from '../../src/brain2/ownership.js';
import { Tripwire } from '../../src/brain2/safety.js';
import { Store, initialState } from '../../src/brain2/store.js';
import { ManualClock } from '../../src/brain2/clock.js';
import { PIP } from '../../src/brain2/data/personalities.data.js';
import { StopSignal } from '../../src/body/stop-signal.js';
import type { Dig, Vec3 } from '../../src/brain2/types.js';
import type { Pose } from '../../src/types.js';
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

	// Fix round (R10). Red if the pillar area is checked only against kid-placed cells: spiralsFor's first candidate
	// (pillar 207,208) has its 3×3 right beside where Noah stands.
	it('R10: a kid standing at the best pillar → another pillar, whose 3×3 clears his body buffer', async () => {
		const r = mineRig();
		const t = { x: TX, y: Y0 - 7, z: TZ };
		r.world.setNatural(t.x, t.y, t.z, 'gold_block');              // the only one in the world: no nearer target
		const first = expected(t);
		const kid = { x: first.px - 1.5, y: Y0, z: first.pz + 0.5 };   // one column west of the pillar area
		r.kid(kid.x, kid.y, kid.z);
		r.start('gold_block');
		await r.until(() => r.store.state.digs.length === 1 || r.store.state.behaviour === null);
		const sp = r.dig().spiral;
		expect(sp).not.toEqual(first);
		expect(r.dig().target).toEqual(t);
		const kx = Math.floor(kid.x), kz = Math.floor(kid.z);
		expect(Math.max(Math.abs(sp.px - kx), Math.abs(sp.pz - kz))).toBeGreaterThan(2);
	});

	// Fix round (R10, at resume). Red if a resume checks only the leash: the dig beside Noah would resume.
	it('R10: a paused dig whose pillar is now beside a kid is not resumed', async () => {
		const r = mineRig();
		deep(r, 'stone');
		r.start('stone');
		await r.until(() => (r.store.state.digs[0]?.stepsDone ?? 0) >= 3);
		r.runner.end('interrupted', 'test');
		const paused = r.dig();
		r.kid(paused.spiral.px + 2.5, Y0, paused.spiral.pz + 0.5);     // two columns east of the pillar
		r.start('stone');
		await r.ticks(5);
		expect(r.store.state.digs.find((d) => d.id === paused.id)).toMatchObject({ status: 'paused', stepsDone: paused.stepsDone });
		if (r.store.state.behaviour) r.runner.end('interrupted', 'test');
		// Control: with Noah further off (still within the leash), it resumes.
		r.kid(paused.spiral.px + 6.5, Y0, paused.spiral.pz + 0.5);
		r.start('stone');
		expect(r.store.state.digs.find((d) => d.id === paused.id)?.status).toBe('active');
	});

	// Fix round (I2). Red if a kid block in the remaining route is left to the safety tier: 3 'kid cell buffer'
	// rejections end the episode paused, and the next Mine resumes the same dig into the same block, forever.
	it('a kid block in the remaining route → failed \'stuck (kid-block)\', the dig dropped and not resumed', async () => {
		const r = mineRig();
		const t = deep(r, 'stone');
		r.start('stone');
		await r.until(() => (r.store.state.digs[0]?.stepsDone ?? 0) >= 3);
		r.runner.end('interrupted', 'test');
		const paused = r.dig();
		const st = spiralStep(expected(t), paused.stepsDone + 2);
		const block = st.clear[0];
		r.world.set(block.x, block.y, block.z, 'cobblestone');           // Noah's block (an edited cell nobody owns)
		expect(r.own.classify(block.x, block.y, block.z)).toBe('kid');
		r.start('stone');
		expect(r.dig().status).toBe('active');                           // the recorded cells are intact: resumed
		expect(await r.runToEnd(300)).toMatchObject({ outcome: 'failed', why: 'stuck (kid-block)' });
		expect(r.store.state.digs.find((d) => d.id === paused.id)?.status).toBe('dropped');
		expect(r.mines()).not.toContain(k(block));
		r.start('stone');
		expect(r.store.state.digs.find((d) => d.id === paused.id)?.status).toBe('dropped');
	});

	// Fix round (I3). Red if leaves count as the ground: the staircase would start in the canopy (y0 = canopy + 1).
	it('a tree canopy over the target is not the ground: the spiral starts at the soil', async () => {
		const r = mineRig();
		const t = shallowIron(r);
		for (let x = TX - 3; x <= TX + 3; x++) for (let z = TZ - 3; z <= TZ + 3; z++) for (const y of [TOP + 3, TOP + 4]) r.world.setNatural(x, y, z, 'oak_leaves');
		for (let y = TOP + 1; y <= TOP + 2; y++) r.world.setNatural(TX + 3, y, TZ + 3, 'oak_log');   // the trunk, outside the pillar areas
		r.start('iron_ore');
		await r.until(() => r.store.state.digs.length === 1 || r.store.state.behaviour === null);
		expect(r.dig().spiral).toEqual(expected(t));
		expect(await r.runToEnd()).toMatchObject({ outcome: 'done' });
	});

	// Fix round (I3). Red without the pillar-area headroom check: a trunk on spiralsFor's first pillar would be
	// looked through, and the bot would stand inside it.
	it('a trunk on the best pillar → another pillar, still at the soil', async () => {
		const r = mineRig();
		const t = { x: TX, y: Y0 - 7, z: TZ };
		r.world.setNatural(t.x, t.y, t.z, 'gold_block');
		const first = expected(t);
		for (let y = TOP + 1; y <= TOP + 5; y++) r.world.setNatural(first.px, y, first.pz, 'oak_log');
		r.start('gold_block');
		await r.until(() => r.store.state.digs.length === 1 || r.store.state.behaviour === null);
		const sp = r.dig().spiral;
		expect(sp).not.toEqual(first);
		expect(sp.y0).toBe(Y0);
		expect(Math.max(Math.abs(sp.px - first.px), Math.abs(sp.pz - first.pz))).toBeGreaterThan(1);
	});

	// Fix round. Red if the 120 s episode includes the resume walk-down: a slow walk-down leaves no time to dig.
	it('the episode timer starts after the resume walk-down', async () => {
		const r = mineRig();
		deep(r, 'stone');
		r.start('stone');
		await r.until(() => (r.store.state.digs[0]?.stepsDone ?? 0) >= 10);
		r.runner.end('interrupted', 'test');
		const done = r.dig().stepsDone;
		r.body.current = { x: 212.5, y: Y0, z: 212.5, yaw: 0, pitch: 0 };
		r.start('stone');
		const from = r.mines().length;
		await r.ticks(2);                                                 // the walk-down has started
		r.clock.advance(119_500);                                         // … and is slow
		await r.until(() => r.store.state.behaviour === null || r.dig().stepsDone > done, 400);
		expect(r.mines().length).toBeGreaterThan(from);
		expect(r.dig().stepsDone).toBeGreaterThan(done);
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

/** The walkTo targets in body calls from index `from` on. */
const walksFrom = (r: Rig, from: number) => r.body.calls.slice(from).filter((c) => c.fn === 'walkTo').map((c) => c.args[0] as { x: number; z: number });
const centreOf = (c: { x: number; z: number }) => ({ x: c.x + 0.5, z: c.z + 0.5 });
/** The climb from step k: steps k−1 … 0, then the exit column beside step 0 (built here, independently of climbPath). */
const expectedClimb = (sp: Spiral, k: number) => [...Array.from({ length: k }, (_, j) => centreOf(spiralStep(sp, k - 1 - j).feet)), centreOf(exitOf(sp))];
/** Digs a deep stone staircase to ≥ 10 steps, then interrupts it: the bot is left on its last dug step. */
async function deepAndInterrupted(r: Rig): Promise<{ sp: Spiral; done: number }> {
	const t = deep(r, 'stone');
	r.start('stone');
	await r.until(() => (r.store.state.digs[0]?.stepsDone ?? 0) >= 10);
	r.runner.end('interrupted', 'test');
	const sp = expected(t), done = r.dig().stepsDone;
	const on = spiralStep(sp, done - 1).feet;
	expect(r.body.pose()).toMatchObject({ x: on.x + 0.5, y: on.y, z: on.z + 0.5 });   // down in the staircase
	return { sp, done };
}
/** Swaps BEHAVIOURS.rest for a probe that records the pose its first next() sees and ends done. */
async function withProbe(fn: (seen: Pose[]) => Promise<void>): Promise<void> {
	const seen: Pose[] = [];
	const probe: Behaviour<Record<string, unknown>, object> = {
		kind: 'rest', typicalMs: [1000, 1000], plan: () => ({}), plannedEdits: () => 0, owns: () => false,
		next: (_p, ctx) => {
			seen.push(ctx.pose);
			return 'done';
		},
	};
	const orig = BEHAVIOURS.rest;
	BEHAVIOURS.rest = probe;
	try {
		await fn(seen);
	} finally {
		BEHAVIOURS.rest = orig;
	}
}
/** The flyTo targets in body calls from index `from` on. */
const fliesFrom = (r: Rig, from: number) => r.body.calls.slice(from).filter((c) => c.fn === 'flyTo').map((c) => c.args[0] as Vec3);
/**
 * R19's escape target, checked independently: a column just outside the 3×3 pillar area (Chebyshev distance 2 from
 * the pillar), face-adjacent to the exit column, at its centre, feet y0 + 1.
 */
const expectEscape = (sp: Spiral, to: Vec3) => {
	const cx = Math.floor(to.x), cz = Math.floor(to.z), e = exitOf(sp);
	expect(Math.max(Math.abs(cx - sp.px), Math.abs(cz - sp.pz))).toBe(2);
	expect(Math.abs(cx - e.x) + Math.abs(cz - e.z)).toBe(1);
	expect(to).toEqual({ x: cx + 0.5, y: sp.y0 + 1, z: cz + 0.5 });
};
const blockAllFlights = (r: Rig) => {
	r.body.flyImpl = async () => {
		throw new BlockedError(r.body.pose(), 'wall');
	};
};
const blockAllWalks = (r: Rig) => {
	r.body.walkImpl = async () => {
		throw new BlockedError(r.body.pose(), 'wall');
	};
};

describe('Mine climbs out (ruling R17)', () => {
	// Red if the episode ends paused down in the staircase (walkTo is 2D: nothing afterwards can walk out), climbs
	// several steps in one walk, or edits on the way up.
	it('a paused episode climbs its dug steps back up, one walk each, then onto the ground beside the pillar', async () => {
		const r = mineRig();
		const t = deep(r, 'stone');
		const sp = expected(t);
		r.start('stone');
		await r.until(() => (r.store.state.digs[0]?.stepsDone ?? 0) >= 12);
		r.clock.advance(LIMITS.MINE_EPISODE_MS);
		const from = r.body.calls.length, minesBefore = r.mines().length;
		const k0 = r.dig().stepsDone;
		expect(await r.runToEnd(500)).toMatchObject({ outcome: 'paused' });
		const k1 = r.dig().stepsDone;
		expect(k1 - k0).toBeLessThanOrEqual(1);                      // at most the step in hand is finished
		expect(walksFrom(r, from).slice(-k1)).toEqual(expectedClimb(sp, k1 - 1));
		const exit = exitOf(sp);
		expect(r.body.pose()).toMatchObject({ x: exit.x + 0.5, y: Y0, z: exit.z + 0.5 });
		expect(r.mines().length - minesBefore).toBeLessThanOrEqual(3);
		expect(r.dig().status).toBe('paused');
		expect(r.tripwire.halted).toBeNull();
	});

	// Red if a done Mine stays at the bottom of its staircase.
	it('a done Mine climbs out too', async () => {
		const r = mineRig();
		const t = shallowIron(r);
		const sp = expected(t);
		r.start('iron_ore');
		expect(await r.runToEnd()).toMatchObject({ outcome: 'done' });
		const exit = exitOf(sp);
		expect(r.body.pose()).toMatchObject({ x: exit.x + 0.5, y: Y0, z: exit.z + 0.5 });
		expect(walksFrom(r, 0).slice(-(sp.lastStep + 1))).toEqual(expectedClimb(sp, sp.lastStep));
		expect(r.dig().status).toBe('done');
	});

	// Red if the runner lets another behaviour act from down in a staircase (its walks are blocked there).
	it('another behaviour starting with the bot down in a staircase: the runner climbs it out first', async () => {
		const r = mineRig();
		const { sp, done } = await deepAndInterrupted(r);
		await withProbe(async (seen) => {
			const from = r.body.calls.length;
			r.runner.start('rest', {});
			expect(await r.runToEnd(500)).toMatchObject({ behaviour: 'rest', outcome: 'done' });
			expect(walksFrom(r, from)).toEqual(expectedClimb(sp, done - 1));
			const exit = exitOf(sp);
			expect(seen[0]).toMatchObject({ x: exit.x + 0.5, y: Y0, z: exit.z + 0.5 });
		});
		expect(r.dig().status).toBe('paused');
	});

	// Red if a resume from inside the staircase walks up to step 0 first (the live fail-loop), or the runner climbs
	// the bot out of the very dig it resumes.
	it('a resume with the bot on one of the dig\'s steps goes on from there: no walk-down, no climb', async () => {
		const r = mineRig();
		const { sp, done } = await deepAndInterrupted(r);
		const from = r.body.calls.length;
		r.start('stone');
		expect(r.dig().status).toBe('active');
		await r.until(() => r.mines().length > 0 && r.body.calls.slice(from).some((c) => c.fn === 'mine'));
		const first = r.body.calls.slice(from).find((c) => c.fn === 'mine' || c.fn === 'walkTo')!;
		expect(first.fn).toBe('mine');
		expect(spiralStep(sp, done).clear.map(k)).toContain((first.args as number[]).join(','));
		expect(r.logs.filter(([kind]) => kind === 'climb')).toEqual([]);
	});

	// Red if a blocked resume walk falls to the runner's 3-failure rule (the dig stays paused and is re-picked
	// about once a second), or doesn't drop the dig.
	it('a resume walk-down blocked twice → failed \'stuck (climb)\', the dig dropped, a stuck event', async () => {
		const r = mineRig();
		const { done } = await deepAndInterrupted(r);
		r.body.current = { x: 212.5, y: Y0, z: 212.5, yaw: 0, pitch: 0 };   // on the surface: walks down from step 0
		const id0 = r.dig().id;
		blockAllWalks(r);
		const from = r.body.calls.length;
		r.start('stone');
		expect(await r.runToEnd(100)).toMatchObject({ outcome: 'failed', why: 'stuck (climb)' });
		expect(walksFrom(r, from)).toHaveLength(2);
		expect(r.store.state.digs.find((d) => d.id === id0)).toMatchObject({ status: 'dropped', stepsDone: done });
		expect(r.store.state.events.filter((e) => e.kind === 'stuck')).toEqual([expect.objectContaining({ detail: 'stuck (climb)', salient: true })]);
	});

	// Red if a blocked climb isn't bounded (the runner retries it at every start: a loop), or doesn't drop the dig.
	it('a runner climb blocked twice, and its escape flight too → the new behaviour fails \'stuck (climb)\', the dig dropped, never retried', async () => {
		const r = mineRig();
		await deepAndInterrupted(r);
		blockAllWalks(r);
		blockAllFlights(r);
		await withProbe(async (seen) => {
			const from = r.body.calls.length;
			r.runner.start('rest', {});
			expect(await r.runToEnd(100)).toMatchObject({ behaviour: 'rest', outcome: 'failed', why: 'stuck (climb)' });
			expect(walksFrom(r, from)).toHaveLength(2);
			expect(fliesFrom(r, from)).toHaveLength(1);
			expect(seen).toEqual([]);
			expect(r.dig().status).toBe('dropped');
			expect(r.store.state.events.filter((e) => e.kind === 'stuck')).toEqual([expect.objectContaining({ detail: 'stuck (climb)' })]);
			const again = r.body.calls.length;
			r.runner.start('rest', {});
			expect(await r.runToEnd(100)).toMatchObject({ outcome: 'done' });
			expect(walksFrom(r, again)).toEqual([]);
			expect(seen).toHaveLength(1);
		});
	});
});

describe('Stuck in a hole: the escape flight (ruling R19)', () => {
	// Red if a blocked climb out of the episode ends stuck down in the hole (no flight), flies somewhere other than
	// the surface just outside the pillar area, or drops a dig whose flight worked.
	it('Mine: the climb out blocked twice → flyTo the surface beside the pillar area; the episode still ends paused, the dig kept', async () => {
		const r = mineRig();
		const t = deep(r, 'stone');
		const sp = expected(t);
		r.start('stone');
		await r.until(() => (r.store.state.digs[0]?.stepsDone ?? 0) >= 12);
		blockAllWalks(r);
		r.clock.advance(LIMITS.MINE_EPISODE_MS);
		const from = r.body.calls.length;
		expect(await r.runToEnd(500)).toMatchObject({ outcome: 'paused' });
		const flights = fliesFrom(r, from);
		expect(flights).toHaveLength(1);
		expectEscape(sp, flights[0]);
		expect(r.body.pose()).toMatchObject(flights[0]);
		expect(r.dig().status).toBe('paused');
		expect(r.store.state.events.filter((e) => e.kind === 'stuck')).toEqual([]);
	});

	// Red if a blocked flight is retried forever, or if the dig isn't dropped once the flight is blocked too.
	it('Mine: the climb out and the flight both blocked → failed \'stuck (climb)\', the dig dropped', async () => {
		const r = mineRig();
		deep(r, 'stone');
		r.start('stone');
		await r.until(() => (r.store.state.digs[0]?.stepsDone ?? 0) >= 12);
		blockAllWalks(r);
		blockAllFlights(r);
		r.clock.advance(LIMITS.MINE_EPISODE_MS);
		const from = r.body.calls.length;
		expect(await r.runToEnd(500)).toMatchObject({ outcome: 'failed', why: 'stuck (climb)' });
		expect(fliesFrom(r, from)).toHaveLength(1);
		expect(r.dig().status).toBe('dropped');
		expect(r.store.state.events.filter((e) => e.kind === 'stuck')).toEqual([expect.objectContaining({ detail: 'stuck (climb)' })]);
	});

	// Red if the runner's blocked climb gives up without the flight (the bot stays in the hole all night), or drops
	// the dig although the bot got out.
	it('runner: a climb blocked twice → flyTo the surface beside the pillar area, then the new behaviour runs from there', async () => {
		const r = mineRig();
		const { sp } = await deepAndInterrupted(r);
		blockAllWalks(r);
		await withProbe(async (seen) => {
			const from = r.body.calls.length;
			r.runner.start('rest', {});
			expect(await r.runToEnd(100)).toMatchObject({ behaviour: 'rest', outcome: 'done' });
			const flights = fliesFrom(r, from);
			expect(flights).toHaveLength(1);
			expectEscape(sp, flights[0]);
			expect(seen[0]).toMatchObject(flights[0]);
		});
		expect(r.dig().status).toBe('paused');
		expect(r.store.state.events.filter((e) => e.kind === 'stuck')).toEqual([]);
	});

	// Red if the escape column ignores what stands on it (a tree trunk, the kid's block) or a kid-built ground.
	it('escapeTarget skips a column with no headroom or with non-natural ground, and is null when none qualifies', () => {
		const r = mineRig();
		const sp = expected(shallowIron(r));
		const first = escapeTarget(sp, r.world, r.own)!;
		const fx = Math.floor(first.x), fz = Math.floor(first.z);
		r.world.setNatural(fx, Y0 + 1, fz, 'oak_log');                          // a trunk where the body would be
		const second = escapeTarget(sp, r.world, r.own)!;
		expect(second).not.toEqual(first);
		expect(second.y).toBe(sp.y0 + 1);
		expect(Math.max(Math.abs(Math.floor(second.x) - sp.px), Math.abs(Math.floor(second.z) - sp.pz))).toBe(2);
		r.world.set(Math.floor(second.x), TOP, Math.floor(second.z), 'dirt');   // a player's block, not natural ground
		expect(escapeTarget(sp, r.world, r.own)).not.toEqual(second);
		for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) r.world.setNatural(sp.px + dx, Y0 + 1, sp.pz + dz, 'oak_log');
		expect(escapeTarget(sp, r.world, r.own)).toBeNull();
	});
});

// Ruling R24 (live: Mine ended 'no-entrance' within seconds near spawn, where the kid has built a lot). Kid cells
// (edited, nobody's) float on a 16-grid out to `r` from the anchor (world spawn, TX/TZ), so every pillar within
// the leash is within 13.5 of one.
describe('Mine widens its search past the leash (ruling R24)', () => {
	const kidGrid = (rig: Rig, r: number) => {
		for (let dx = -128; dx <= 128; dx += 16) {
			for (let dz = -128; dz <= 128; dz += 16) if (Math.hypot(dx, dz) <= r) rig.world.set(TX + dx, 250, TZ + dz, 'dirt');
		}
	};

	// Red if the search stops at LEASH: 'no-entrance'. Red if the dig doesn't carry the radius it was planned with,
	// or a resume checks LEASH instead: the far dig would not resume.
	it('kid cells everywhere within 32 → an entrance beyond 32 (within 64); the far dig resumes', async () => {
		const r = mineRig();
		kidGrid(r, 44);
		// A natural dirt tower 58 east of the anchor, with an iron_ore target 7 below its top.
		const X0 = TX + 50;
		for (let x = X0; x <= X0 + 16; x++) for (let z = TZ - 8; z <= TZ + 8; z++) for (let y = BOTTOM; y <= TOP; y++) r.world.setNatural(x, y, z, 'dirt');
		r.world.setNatural(TX + 58, Y0 - 7, TZ, 'iron_ore');
		r.start('iron_ore');
		await r.until(() => r.store.state.digs.length === 1 || r.store.state.behaviour === null, 3000);
		expect(r.store.state.memory.past[0]?.why).not.toBe('no-entrance');
		const d = r.dig();
		const dist = Math.hypot(d.spiral.px - TX, d.spiral.pz - TZ);
		expect(dist).toBeGreaterThan(32);
		expect(dist).toBeLessThanOrEqual(64);
		expect(d.leash).toBe(64);
		expect(r.own.kidCellWithin(d.spiral.px, d.spiral.pz, 13.5)).toBe(false);
		r.runner.end('interrupted', 'test');
		expect(r.dig().status).toBe('paused');
		r.start('iron_ore');
		expect(r.store.state.digs).toHaveLength(1);
		expect(r.dig()).toMatchObject({ id: d.id, status: 'active' });
	});

	// Red if the widening goes past 96, 'no-entrance' is lost, or the failure writes no (or more than one) line.
	it('nothing within 96 → failed no-entrance, one search-failed line with counts at 32, 64 and 96', async () => {
		const r = mineRig();
		kidGrid(r, 120);
		shallowIron(r);
		r.start('iron_ore');
		expect(await r.runToEnd(3000)).toMatchObject({ outcome: 'failed', why: 'no-entrance' });
		const lines = r.logs.filter(([kind]) => kind === 'search-failed');
		expect(lines).toHaveLength(1);
		const d = lines[0][1] as { behaviour: string; radii: Array<{ radius: number; counts: Record<string, number> }> };
		expect(d.behaviour).toBe('mine');
		expect(d.radii.map((x) => x.radius)).toEqual([32, 64, 96]);
		expect(d.radii[0].counts['kid-cells']).toBeGreaterThan(0);
		expect(d.radii[0].counts.targets).toBeGreaterThan(0);
	});
});
