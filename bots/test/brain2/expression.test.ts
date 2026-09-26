import { afterEach, describe, expect, it } from 'vitest';
import type { WalkResult } from 'minicraft-bot';
import { Expression, gestureFor, inView } from '../../src/brain2/expression.js';
import { BehaviourRunner } from '../../src/brain2/runner.js';
import { BEHAVIOURS, type Behaviour } from '../../src/brain2/behaviours/behaviour.js';
import { createPerceiver } from '../../src/brain2/perception.js';
import { Ownership } from '../../src/brain2/ownership.js';
import { Tripwire } from '../../src/brain2/safety.js';
import { Store, initialState, type Patch } from '../../src/brain2/store.js';
import { ManualClock } from '../../src/brain2/clock.js';
import { PIP } from '../../src/brain2/data/personalities.data.js';
import { bandOf } from '../../src/brain2/emotions.js';
import { StopSignal } from '../../src/body/stop-signal.js';
import type { ActionEntry, GlobalAxis, Relation, State, WorldEvent } from '../../src/brain2/types.js';
import type { KidInfo, Pose } from '../../src/types.js';
import { FakeBody, FakeWorld, player } from '../fake-port.js';

const Y = 200;
function kid(name: string, pose: Partial<Pose>): KidInfo {
	return {
		name, id: 7, pose: { x: 0, y: Y, z: 0, yaw: 0, pitch: 0, ...pose }, velocity: { x: 0, y: 0, z: 0 }, speedLast0_3s: 0, speedLast1s: 0,
		flying: false, inLiquid: false, lookTarget: null, lookBlock: null, lookDistance: null, lookHeldMs: 0, miningCell: null,
		placements: [], idleSinceMs: null,
	};
}
/** Yaw that faces from `from` toward `to` (yaw 0 faces −z). */
const yawTo = (from: { x: number; z: number }, to: { x: number; z: number }) => Math.atan2(-(to.x - from.x), -(to.z - from.z));
function rel(affection = 0): Relation {
	const a = (value = 0) => ({ value, band: bandOf(value), deltas: [] });
	return { axes: { affection: a(affection), cooperation: a(), respect: a(), grievance: a() }, metSessions: 1, minutesTogether: 0, lastSeenT: 0 };
}

const BOT = { x: 0.5, y: Y, z: 0.5 };
function rig(o: { kids?: KidInfo[]; state?: (s: State) => void } = {}) {
	const clock = new ManualClock(1000);
	const body = new FakeBody();
	body.current = { ...BOT, yaw: 0, pitch: 0 };
	const s = structuredClone(initialState(PIP, body.current)) as State;
	s.relations = { Noah: rel() };
	o.state?.(s);
	const store = new Store(s, clock.now);
	let kids = o.kids ?? [kid('Noah', { x: 0.5, z: -8, yaw: yawTo({ x: 0.5, z: -8 }, BOT) })];   // 8 in front, facing the bot
	const expr = new Expression({ store, body, clock: clock.now, kids: () => kids });
	store.subscribe((cs) => expr.onChanges(cs));
	let appraisalId = 0;
	/** An appraisal that moves axes by the given amounts; `why` lists the burst like the appraise expert (`kind#id`). */
	const appraise = (moves: Partial<Record<GlobalAxis | `rel.${string}.${'affection' | 'grievance'}`, number>>, burst: WorldEvent[] = []) => {
		const st = store.state;
		const patch: Patch = [];
		if (burst.length) patch.push({ path: ['events'], value: [...st.events, ...burst] });
		for (const [axis, d] of Object.entries(moves)) {
			const m = /^rel\.(.+)\.(\w+)$/.exec(axis);
			if (m) patch.push({ path: ['relations', m[1], 'axes', m[2], 'value'], value: st.relations[m[1]].axes[m[2] as 'affection'].value + d! });
			else patch.push({ path: ['emotions', axis, 'value'], value: st.emotions[axis as GlobalAxis].value + d! });
		}
		const why = burst.map((e) => `${e.kind === 'outcome' ? `outcome:${e.detail}` : e.kind}#${e.id}`).join(' ');
		store.apply(patch, { kind: 'appraisal', by: 'appraise', appraisalId: ++appraisalId, why });
	};
	let evId = 100;
	const event = (kind: WorldEvent['kind'], o2: Partial<WorldEvent> = {}): WorldEvent => ({ id: ++evId, kind, t: clock.t, salient: true, ...o2 });
	const step = async (n = 1) => {
		for (let i = 0; i < n; i++) {
			clock.advance(100);
			await expr.tick();
			await Promise.resolve();
		}
	};
	const calls = (fn: string) => body.calls.filter((c) => c.fn === fn);
	return { clock, body, store, expr, appraise, event, step, calls, setKids: (k: KidInfo[]) => (kids = k) };
}

describe('inView (spec §5.5)', () => {
	// 1. Red if the yaw or the pitch window is ignored, or the 20-block range.
	it('in front within 20 → true; behind → false; looking straight down → false (pitch)', () => {
		const k = (pose: Partial<Pose>) => ({ pose: { x: 0, y: Y, z: 0, yaw: 0, pitch: 0, ...pose } });
		expect(inView({ x: 0, y: Y, z: -10 }, k({}))).toBe(true);
		expect(inView({ x: 6, y: Y, z: -10 }, k({}))).toBe(true);          // 31° off his yaw
		expect(inView({ x: 0, y: Y, z: 10 }, k({}))).toBe(false);          // behind
		expect(inView({ x: 15, y: Y, z: -10 }, k({}))).toBe(false);        // 56° off
		expect(inView({ x: 0, y: Y, z: -10 }, k({ pitch: -Math.PI / 2 }))).toBe(false);
		expect(inView({ x: 0, y: Y, z: -25 }, k({}))).toBe(false);         // too far
	});
});

describe('gestures (spec §5.5)', () => {
	// 2. Red if an out-of-view gesture is queued and played once he looks.
	it('a gesture out of view is skipped, not queued', async () => {
		const r = rig({ kids: [kid('Noah', { x: 0.5, z: -8, yaw: yawTo({ x: 0.5, z: -8 }, BOT) + Math.PI })] });   // facing away
		r.appraise({ mood: 0.35 }, [r.event('found', { block: 'sand' })]);
		await r.step(3);
		expect(r.calls('move')).toHaveLength(0);
		r.setKids([kid('Noah', { x: 0.5, z: -8, yaw: yawTo({ x: 0.5, z: -8 }, BOT) })]);
		await r.step(10);
		expect(r.calls('move')).toHaveLength(0);
		expect(r.store.state.body.gesture).toBeNull();
	});

	// 3. Red if two gestures play within 5 s.
	it('at most one gesture per 5 s', async () => {
		const r = rig();
		r.appraise({ mood: 0.35 });
		await r.step();
		expect(r.store.state.body.gesture).toBe('double-hop');
		await r.step(10);
		expect(r.store.state.body.gesture).toBeNull();
		const moves = r.calls('move').length;
		expect(moves).toBe(4);                                          // two hops: up, down, up, down
		r.appraise({ mood: 0.35 });                                     // 1.1 s after the first
		await r.step(10);
		expect(r.calls('move')).toHaveLength(moves);
		await r.step(40);                                               // 5.1 s after the first
		r.appraise({ mood: 0.35 });
		await r.step(10);
		expect(r.calls('move').length).toBeGreaterThan(moves);
	});

	// 4. Red if the greeting is dropped while out of view, isn't held, or doesn't walk in front of him.
	it('the greeting waits until the bot is in view, up to 20 s, and walks in front of the kid', async () => {
		const away = yawTo({ x: 0.5, z: -8 }, BOT) + Math.PI;
		const r = rig({ kids: [kid('Noah', { x: 0.5, z: -8, yaw: away })], state: (s) => (s.relations.Noah = rel(0.5)) });
		r.appraise({ stimulation: 0.2, mood: 0.1 }, [r.event('player-arrived', { player: 'Noah' })]);
		await r.step(100);                                              // 10 s out of view
		expect(r.store.state.body.gesture).toBeNull();
		expect(r.calls('walkTo')).toHaveLength(0);
		const facing = yawTo({ x: 0.5, z: -8 }, BOT);
		r.setKids([kid('Noah', { x: 0.5, z: -8, yaw: facing })]);
		await r.step();
		expect(r.store.state.body.gesture).toBe('greeting');
		await r.step(20);
		const to = r.calls('walkTo')[0].args[0] as { x: number; z: number };
		// 2 blocks in front of him, along his view direction.
		expect(to.x).toBeCloseTo(0.5 - Math.sin(facing) * 2);
		expect(to.z).toBeCloseTo(-8 - Math.cos(facing) * 2);
		await r.step(20);
		expect(r.store.state.body.gesture).toBeNull();
		// Never in view within 20 s: dropped.
		const r2 = rig({ kids: [kid('Noah', { x: 0.5, z: -8, yaw: away })], state: (s) => (s.relations.Noah = rel(0.5)) });
		r2.appraise({ stimulation: 0.2 }, [r2.event('player-arrived', { player: 'Noah' })]);
		await r2.step(205);
		r2.setKids([kid('Noah', { x: 0.5, z: -8, yaw: facing })]);
		await r2.step(20);
		expect(r2.calls('walkTo')).toHaveLength(0);
		expect(r2.calls('move')).toHaveLength(0);
	});

	// 5. Red on the rev 2 180° walk (walking straight away from the kid).
	it('stomp-off walks perpendicular to the nearest kid', async () => {
		const r = rig({ state: (s) => (s.emotions.patience = { value: -0.4, band: 'low', deltas: [] }) });
		r.appraise({ patience: -0.2, outlook: -0.2, mood: -0.1 }, [r.event('outcome', { detail: 'failed' })]);
		await r.step(20);
		expect(r.calls('walkTo')).toHaveLength(1);
		const to = r.calls('walkTo')[0].args[0] as { x: number; z: number };
		const walk = { x: to.x - BOT.x, z: to.z - BOT.z };
		const toKid = { x: 0.5 - BOT.x, z: -8 - BOT.z };
		const deg = (Math.acos((walk.x * toKid.x + walk.z * toKid.z) / (Math.hypot(walk.x, walk.z) * Math.hypot(toKid.x, toKid.z))) * 180) / Math.PI;
		expect(Math.abs(deg - 90)).toBeLessThanOrEqual(10);
		expect(Math.hypot(walk.x, walk.z)).toBeCloseTo(3);
		expect(gestureFor([], r.store.state)).toBeNull();
	});

	// 6. Red if back-off fires on a kid approaching.
	it('back-off never fires when the cause is a kid approaching', async () => {
		const r = rig();
		r.appraise({ confidence: -0.3 }, [r.event('player-near', { player: 'Noah' })]);
		await r.step(20);
		expect(r.calls('walkTo')).toHaveLength(0);
		expect(r.store.state.body.gesture).toBeNull();
		// A hazard is a cause to back off from: 2 blocks away from its cell.
		const r2 = rig();
		r2.appraise({ confidence: -0.3, mood: -0.1 }, [r2.event('hazard', { cell: { x: 3, y: Y, z: 0 } })]);
		await r2.step(20);
		const to = r2.calls('walkTo')[0].args[0] as { x: number; z: number };
		expect(to.x).toBeCloseTo(BOT.x - 2 * (2.5 / Math.hypot(2.5, 0)));
		expect(to.z).toBeCloseTo(BOT.z);
	});

	// 8. Red if the firework is missing on a finished Build (or fires for any done).
	it('firework fx on a finished build', async () => {
		const r = rig();
		const done = r.event('outcome', { detail: 'done' });
		const entry: ActionEntry = { behaviour: 'build', params: {}, lastedMs: 60_000, outcome: 'done', why: 'done', endedT: done.t };
		r.store.apply([{ path: ['memory', 'past'], value: [entry] }], { kind: 'behaviour', by: 'runner' });
		r.appraise({ mood: 0.3, outlook: 0.2 }, [done]);
		await r.step(10);
		expect(r.calls('fx')).toEqual([{ fn: 'fx', args: [expect.objectContaining({ kind: 'firework' })] }]);
		expect(gestureFor([], r.store.state)).toBeNull();
		// A finished Mine: a double hop, no firework.
		const r2 = rig();
		const done2 = r2.event('outcome', { detail: 'done' });
		r2.store.apply([{ path: ['memory', 'past'], value: [{ ...entry, behaviour: 'mine', endedT: done2.t }] }], { kind: 'behaviour', by: 'runner' });
		r2.appraise({ mood: 0.3 }, [done2]);
		await r2.step(10);
		expect(r2.calls('move').length).toBe(4);
		expect(r2.calls('fx')).toHaveLength(0);
	});
});

describe('gestures and the runner (spec §5.5, §7.3)', () => {
	const saved = BEHAVIOURS.watch;
	afterEach(() => {
		BEHAVIOURS.watch = saved;
	});
	/** A behaviour that walks back and forth between two points, forever. */
	const walker: Behaviour<object, { i: number }> = {
		kind: 'watch', typicalMs: [1000, 2000],
		plan: () => ({ i: 0 }),
		next: (p) => ({ kind: 'walk', to: p.i % 2 === 0 ? { x: 10.5, z: 0.5 } : { x: 0.5, z: 0.5 }, speed: 1 }),
		plannedEdits: () => 0,
		owns: () => false,
		onResult: (p, _a, ok) => ((p.i += ok ? 1 : 0), []),
	};
	function withRunner(o: { mood?: number; stimulation?: number } = {}) {
		const clock = new ManualClock(1000);
		const world = new FakeWorld();
		const body = new FakeBody();
		body.current = { ...BOT, yaw: 0, pitch: 0 };
		const s = structuredClone(initialState(PIP, body.current)) as State;
		s.relations = { Noah: rel() };
		if (o.mood !== undefined) s.emotions.mood = { value: o.mood, band: bandOf(o.mood), deltas: [] };
		if (o.stimulation !== undefined) s.emotions.stimulation = { value: o.stimulation, band: bandOf(o.stimulation), deltas: [] };
		const store = new Store(s, clock.now);
		const own = new Ownership(world, () => store.state.owned);
		body.list = [player({ id: 7, name: 'Noah', x: 0.5, y: Y, z: -8, yaw: yawTo({ x: 0.5, z: -8 }, BOT) })];
		const perceiver = createPerceiver({ body, world, own, store, tuning: { followDist: 2, idleSwitchMs: 30_000, minTargetMs: 20_000 }, clock: clock.now });
		const runner = new BehaviourRunner({
			store, body, world, own, perceiver, tripwire: new Tripwire(600), stop: new StopSignal(600_000), clock: clock.now, noEdits: () => false,
			fit: async () => 'yes', log: () => {}, rng: () => 0, spawn: { x: 256, y: 120, z: 256 },
		});
		const expr = new Expression({ store, body, clock: clock.now, kids: () => perceiver.kids(), lastArrivalT: () => runner.lastArrivalT, busy: () => runner.busy });
		store.subscribe((cs) => expr.onChanges(cs));
		BEHAVIOURS.watch = walker;
		const step = async () => {
			clock.advance(100);
			store.apply(perceiver.tick(clock.t), { kind: 'perception', by: 'perceive' });
			void runner.tick();
			for (let i = 0; i < 5; i++) await Promise.resolve();
			await expr.tick();
			for (let i = 0; i < 5; i++) await Promise.resolve();
		};
		const seq = () => body.calls.filter((c) => c.fn === 'walkTo' || c.fn === 'move').map((c) => c.fn);
		return { clock, body, store, runner, expr, step, seq };
	}

	// 7. Red if the runner acts during a gesture, counts the cancelled walk as a failure, or doesn't reissue it.
	it('the runner pauses during a gesture and reissues its walk after', async () => {
		const r = withRunner();
		const pending: Array<(v: WalkResult) => void> = [];
		r.body.walkImpl = () => new Promise<WalkResult>((res) => pending.push(res));
		r.runner.start('watch', {});
		await r.step();
		expect(r.seq()).toEqual(['walkTo']);
		r.store.apply([{ path: ['emotions', 'mood', 'value'], value: 0.5 }], { kind: 'appraisal', by: 'appraise', appraisalId: 1, why: '' });
		for (let i = 0; i < 3; i++) await r.step();
		expect(r.store.state.body.gesture).toBe('double-hop');
		expect(r.seq().filter((f) => f === 'walkTo')).toHaveLength(1);   // paused: no new walk during the gesture
		for (let i = 0; i < 10; i++) await r.step();
		expect(r.store.state.body.gesture).toBeNull();
		expect(r.seq().slice(0, 2)).toEqual(['walkTo', 'move']);
		expect(r.seq().at(-1)).toBe('walkTo');
		expect(r.seq().filter((f) => f === 'walkTo')).toHaveLength(2);
		expect(r.store.state.behaviour).toMatchObject({ kind: 'watch', failures: 0 });
	});

	// 9. Red if it hops mid-walk (move() would cancel the walk), without a fresh arrival, or with a calm style.
	it('hops only right after a walk arrives, only when stimulation and mood are both ≥ 0.4, and never cancels a walk in flight', async () => {
		const r = withRunner({ mood: 0.5, stimulation: 0.5 });
		let n = 0;
		const pending: Array<(v: WalkResult) => void> = [];
		// The first walk arrives at once; the second stays in flight.
		r.body.walkImpl = () => (n++ === 0 ? Promise.resolve('arrived' as const) : new Promise<WalkResult>((res) => pending.push(res)));
		r.runner.start('watch', {});
		await r.step();                                                    // walk 1 arrives
		expect(r.runner.lastArrivalT).toBe(r.clock.t);
		expect(r.seq()).toEqual(['walkTo', 'move']);                       // the hop: up
		const up = r.body.calls.find((c) => c.fn === 'move')!.args[0] as { y: number };
		expect(up.y).toBeCloseTo(Y + 0.4);
		for (let i = 0; i < 5; i++) await r.step();                        // walk 2 goes out and stays in flight
		expect(r.seq()).toEqual(['walkTo', 'move', 'walkTo']);             // no landing move: it would cancel walk 2
		expect(r.runner.busy).toBe(true);
		expect(r.store.state.behaviour?.failures).toBe(0);
		// A calm bot never hops.
		const calm = withRunner({ mood: 0.3, stimulation: 0.5 });
		calm.body.walkImpl = () => Promise.resolve('arrived');
		calm.runner.start('watch', {});
		for (let i = 0; i < 5; i++) await calm.step();
		expect(calm.seq().every((f) => f === 'walkTo')).toBe(true);
	});
});
