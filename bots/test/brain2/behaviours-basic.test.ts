import { describe, expect, it } from 'vitest';
import { EYE_HEIGHT } from 'minicraft-bot';
import { BEHAVIOURS, type BehaviourCtx } from '../../src/brain2/behaviours/behaviour.js';
import { styleOf, type Style } from '../../src/brain2/style.js';
import { Ownership } from '../../src/brain2/ownership.js';
import { initialState } from '../../src/brain2/store.js';
import { PIP } from '../../src/brain2/data/personalities.data.js';
import type { Action, State } from '../../src/brain2/types.js';
import type { KidInfo } from '../../src/types.js';
import { FakeWorld } from '../fake-port.js';

const Y = 200;
const STYLE: Style = { walkSpeed: 0.8, editGapMs: 1000, lookEveryMs: 3000, distance: 4, hopBetweenSteps: false, slow: false };

function kid(name: string, x: number, z: number, over: Partial<KidInfo> = {}): KidInfo {
	return {
		name, id: 7, pose: { x, y: Y, z, yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 }, speedLast0_3s: 0, speedLast1s: 0,
		flying: false, inLiquid: false, lookTarget: null, lookBlock: null, lookDistance: null, lookHeldMs: 0, miningCell: null,
		placements: [], idleSinceMs: null, ...over,
	};
}
function ctx(over: Partial<BehaviourCtx> = {}): BehaviourCtx {
	const world = new FakeWorld();
	const state = initialState(PIP, { x: 0.5, y: Y, z: 0.5, yaw: 0, pitch: 0 });
	return {
		state, world, own: new Ownership(world, () => ({})), kids: [], now: 0, style: STYLE, pose: { x: 0.5, y: Y, z: 0.5, yaw: 0, pitch: 0 },
		mustMine: false, rng: () => 0, spawn: { x: 256, y: 120, z: 256 }, stopActive: () => false, event: () => [], ...over,
	};
}
const plan = <PL>(kind: 'follow' | 'watch' | 'rest', params: Record<string, unknown>, c: BehaviourCtx): PL => {
	const p = BEHAVIOURS[kind]!.plan(params, c);
	if (p && typeof p === 'object' && 'failed' in p) throw new Error(String(p.failed));
	return p as PL;
};
const edit = (cell = { x: 1, y: Y, z: 1 }): Action => ({ kind: 'place', cell, block: 'stone' });

describe('style (spec §5.5)', () => {
	it('maps the emotions to the pacing and the distance', () => {
		const s = initialState(PIP, { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
		const st = styleOf(s);
		// PIP: mood 0.1, stimulation 0, curiosity 0.3, confidence −0.3, affection 0, preferredDistance 4.
		expect(st.walkSpeed).toBeCloseTo(0.62);
		expect(st.editGapMs).toBeCloseTo(1230);
		expect(st.lookEveryMs).toBeCloseTo(3250);
		expect(st.distance).toBeCloseTo(4.45);
		expect(st).toMatchObject({ hopBetweenSteps: false, slow: false });
		const hi = structuredClone(s) as State;
		for (const a of ['mood', 'stimulation', 'confidence', 'affection', 'curiosity'] as const) hi.emotions[a].value = 1;
		expect(styleOf(hi)).toMatchObject({ walkSpeed: 1, editGapMs: 600, lookEveryMs: 1500, distance: 1.5, hopBetweenSteps: true });
		hi.emotions.mood.value = -0.5;
		expect(styleOf(hi).slow).toBe(true);
	});
});

describe('Follow (spec §6)', () => {
	it('a follow-tick every tick while the kid is present; failed when he is gone; no edits', () => {
		const f = BEHAVIOURS.follow!;
		const c = ctx({ kids: [kid('Noah', 10, 10)] });
		const p = plan('follow', { kid: 'Noah' }, c);
		expect(f.next(p, c)).toEqual({ kind: 'follow-tick', kid: 'Noah' });
		expect(f.next(p, c)).toEqual({ kind: 'follow-tick', kid: 'Noah' });
		expect(f.next(p, ctx())).toEqual({ failed: 'kid gone' });
		expect(f.plannedEdits(p)).toBe(0);
		expect(f.owns(p, edit())).toBe(false);
	});
});

describe('Watch (spec §6)', () => {
	it('walks to the style distance when farther than distance + 1', () => {
		const w = BEHAVIOURS.watch!;
		const c = ctx({ kids: [kid('Noah', 20.5, 0.5)] });
		const p = plan('watch', { kid: 'Noah' }, c);
		const a = w.next(p, c) as Extract<Action, { kind: 'walk' }>;
		expect(a.kind).toBe('walk');
		expect(a.to.x).toBeCloseTo(16.5);  // 4 blocks from Noah, on the line from him to the bot
		expect(a.to.z).toBeCloseTo(0.5);
	});
	it('looks at his look target (or his eye) every lookEveryMs, and waits between', () => {
		const w = BEHAVIOURS.watch!;
		const noah = kid('Noah', 4.5, 0.5, { lookTarget: { x: 9, y: Y, z: 3 } });
		let c = ctx({ kids: [noah] });
		const p = plan('watch', { kid: 'Noah' }, c);
		const a = w.next(p, c);
		expect(a).toEqual({ kind: 'look', at: { x: 9.5, y: Y + 0.5, z: 3.5 } });
		w.onResult?.(p, a as Action, true, c);
		c = ctx({ kids: [noah], now: 1000 });
		expect((w.next(p, c) as Action).kind).toBe('wait');
		c = ctx({ kids: [kid('Noah', 4.5, 0.5)], now: 3000 });
		expect(w.next(p, c)).toEqual({ kind: 'look', at: { x: 4.5, y: Y + EYE_HEIGHT, z: 0.5 } });
	});
	it('done after a duration in [30 s, 60 s] chosen at plan time; failed when the kid is gone', () => {
		const w = BEHAVIOURS.watch!;
		const k = [kid('Noah', 4.5, 0.5)];
		const lo = plan('watch', { kid: 'Noah' }, ctx({ kids: k, rng: () => 0 }));
		expect(w.next(lo, ctx({ kids: k, now: 29_999 }))).not.toBe('done');
		expect(w.next(lo, ctx({ kids: k, now: 30_000 }))).toBe('done');
		const hi = plan('watch', { kid: 'Noah' }, ctx({ kids: k, rng: () => 0.999999 }));
		expect(w.next(hi, ctx({ kids: k, now: 59_000 }))).not.toBe('done');
		expect(w.next(hi, ctx({ kids: k, now: 60_000 }))).toBe('done');
		expect(w.next(lo, ctx())).toEqual({ failed: 'kid gone' });
		expect(w.plannedEdits(lo)).toBe(0);
		expect(w.owns(lo, edit())).toBe(false);
	});
});

describe('Rest (spec §6)', () => {
	const build = (id: string, x: number, z: number) => ({ id, template: 'tower', variant: 'small' as const, origin: { x, y: Y, z }, cells: [], status: 'done' as const });
	it('rests at the latest build within the leash of the nearest kid, else where it stands', () => {
		const r = BEHAVIOURS.rest!;
		const state = initialState(PIP, { x: 0.5, y: Y, z: 0.5, yaw: 0, pitch: 0 });
		state.builds = [build('a', 30, 0), build('b', 200, 200), build('c', 40, 10)];
		const c = ctx({ state, kids: [kid('Noah', 50, 10)] });
		const p = plan<{ spot: { x: number; z: number } }>('rest', {}, c);
		expect(p.spot).toMatchObject({ x: 40, z: 10 });   // 'c' is the latest within 32 of Noah ('b' is the latest overall)
		expect(r.next(p, c)).toMatchObject({ kind: 'walk', to: { x: 40, z: 10 } });
		const alone = plan<{ spot: { x: number; z: number } }>('rest', {}, ctx({ state }));
		expect(alone.spot).toMatchObject({ x: 30, z: 0 });  // no kid: within 32 of the bot
		const none = plan<{ spot: { x: number; z: number } }>('rest', {}, ctx({ kids: [kid('Noah', 50, 10)] }));
		expect(none.spot).toMatchObject({ x: 0.5, z: 0.5 });
	});
	it('looks around every lookEveryMs once there, and is done after [30 s, 90 s]', () => {
		const r = BEHAVIOURS.rest!;
		const p = plan('rest', {}, ctx({ rng: () => 0 }));
		const a = r.next(p, ctx());
		expect((a as Action).kind).toBe('look');
		r.onResult?.(p, a as Action, true, ctx());
		expect((r.next(p, ctx({ now: 1000 })) as Action).kind).toBe('wait');
		expect((r.next(p, ctx({ now: 3000 })) as Action).kind).toBe('look');
		expect(r.next(p, ctx({ now: 30_000 }))).toBe('done');
		const hi = plan('rest', {}, ctx({ rng: () => 0.999999 }));
		expect(r.next(hi, ctx({ now: 89_000 }))).not.toBe('done');
		expect(r.next(hi, ctx({ now: 90_000 }))).toBe('done');
		expect(r.plannedEdits(p)).toBe(0);
	});
});
