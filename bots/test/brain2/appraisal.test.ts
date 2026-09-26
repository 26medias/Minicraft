import { describe, expect, it } from 'vitest';
import { appraisalPatch, appraiseCode, appraiseExpert, recentDeltaSum } from '../../src/brain2/appraisal.js';
import { decayPatch } from '../../src/brain2/emotions.js';
import { Scheduler } from '../../src/brain2/scheduler.js';
import { Store, initialState } from '../../src/brain2/store.js';
import { ManualClock } from '../../src/brain2/clock.js';
import { PIP } from '../../src/brain2/data/personalities.data.js';
import type { Relation, State, WorldEvent } from '../../src/brain2/types.js';

const Y = 200;
function rel(): Relation {
	const a = () => ({ value: 0, band: 'neutral' as const, deltas: [] });
	return { axes: { affection: a(), cooperation: a(), respect: a(), grievance: a() }, metSessions: 1, minutesTogether: 0, lastSeenT: 0 };
}
function state(): State {
	const s = structuredClone(initialState(PIP, { x: 0, y: Y, z: 0, yaw: 0, pitch: 0 })) as State;
	s.relations = { Noah: rel(), Mia: rel() };
	return s;
}
let nextId = 1;
const ev = (kind: WorldEvent['kind'], o: Partial<WorldEvent> = {}): WorldEvent => ({ id: nextId++, kind, t: 0, salient: true, ...o });
/** Applies appraiseCode + appraisalPatch to a plain state (a Store stand-in). */
function appraise(s: State, burst: WorldEvent[], id: number, now: number): State {
	const store = new Store(s, () => now);
	store.apply(appraisalPatch(store.state, appraiseCode(store.state, burst), id, now), { kind: 'appraisal', by: 'test', appraisalId: id });
	return structuredClone(store.state) as State;
}

describe('code appraisal (spec §5.2)', () => {
	// 1. Red if a rel.* term lands on the wrong player (or on the global affection axis), or mood isn't lowered.
	it("broke-my-block lowers the breaker's grievance and my mood; the relation is keyed by the event's player", () => {
		const s = appraise(state(), [ev('broke-my-block', { player: 'Noah' })], 1, 1000);
		expect(s.relations.Noah.axes.grievance.value).toBeCloseTo(-0.3);
		expect(s.relations.Noah.axes.cooperation.value).toBeCloseTo(-0.2);
		expect(s.relations.Mia.axes.grievance.value).toBe(0);
		expect(s.emotions.mood.value).toBeCloseTo(PIP.baselines.mood - 0.2);
		expect(s.emotions.patience.value).toBeCloseTo(PIP.baselines.patience - 0.2);
		expect(s.emotions.affection.value).toBe(PIP.baselines.affection);
		// Without a player, rel.* terms are skipped; the global terms still apply.
		const t = appraise(state(), [ev('broke-my-block')], 1, 1000);
		expect(t.relations.Noah.axes.grievance.value).toBe(0);
		expect(t.emotions.mood.value).toBeCloseTo(PIP.baselines.mood - 0.2);
	});

	// 2. Red if the per-axis sum isn't clamped to ±0.4 before it's applied, or the value leaves [−1, 1].
	it('amounts are clamped to ±0.4 and values to [−1, 1]', () => {
		const burst = Array.from({ length: 5 }, () => ev('found'));
		const d = appraiseCode(state(), burst);
		expect(d.find((x) => x.axis === 'curiosity')!.amount).toBeCloseTo(0.4);   // 5 × 0.3 = 1.5 → 0.4
		let s = state();
		for (let i = 1; i <= 5; i++) s = appraise(s, burst, i, i * 1000);
		expect(s.emotions.curiosity.value).toBe(1);
		expect(s.emotions.curiosity.band).toBe('very high');
		expect(s.emotions.curiosity.deltas.at(-1)!.amount).toBeCloseTo(0.4);
	});

	// 3. Red if decay counts toward Σ|Δ| (rev 2 M2): decay writes values, never deltas.
	it('an appraisal writes a Delta with its appraisalId; decay never writes deltas', () => {
		let s = appraise(state(), [ev('found')], 7, 5000);
		expect(s.emotions.curiosity.deltas).toEqual([{ amount: 0.3, cause: expect.any(String), t: 5000, appraisalId: 7 }]);
		expect(recentDeltaSum(s, 5000)).toBeCloseTo(0.7);           // curiosity 0.3 + mood 0.2 + stimulation 0.2
		expect(recentDeltaSum(s, 16_000)).toBe(0);                  // older than 10 s
		// Far from the baselines, decay moves every axis, and writes no delta.
		s = state();
		for (const a of Object.keys(s.emotions) as Array<keyof State['emotions']>) s.emotions[a].value = 1;
		const pending = new Map<string, number>();
		const p = decayPatch(s, 30_000, pending);
		expect(p.length).toBeGreaterThan(0);
		expect(p.every((op) => !op.path.includes('deltas'))).toBe(true);
		const store = new Store(s, () => 30_000);
		store.apply(p, { kind: 'decay', by: 'decay' });
		expect(recentDeltaSum(store.state, 30_000)).toBe(0);
	});

	// 4. Red if the trigger fires on non-salient events, or isn't debounced {1000, 3000}.
	it('the expert is debounced {1000, 3000} on salient events only', async () => {
		expect(appraiseExpert.trigger).toMatchObject({ kind: 'debounce', quietMs: 1000, maxWaitMs: 3000 });
		expect(appraiseExpert.engine).toBe('code');
		const clock = new ManualClock(0);
		const store = new Store(state(), clock.now);
		const sched = new Scheduler({ store, clock: clock.now, engines: () => ({ laya: null, llm: null }), onCall: () => {} });
		sched.register(appraiseExpert);
		const push = (e: Omit<WorldEvent, 'id' | 't'>) => store.apply([{ path: ['events'], value: [...store.state.events, { ...e, id: store.nextEventId(), t: clock.t }] }], { kind: 'perception', by: 'test' });
		const step = async (n: number) => {
			for (let i = 0; i < n; i++) {
				clock.advance(100);
				await sched.tick();
			}
		};
		push({ kind: 'placed', player: 'Noah', salient: false });
		await step(40);
		expect(store.state.emotions.curiosity.value).toBe(PIP.baselines.curiosity);   // non-salient: never appraised
		push({ kind: 'found', salient: true, block: 'sand' });
		await step(9);
		expect(store.state.emotions.curiosity.deltas).toHaveLength(0);                 // quiet 1000 not yet up
		await step(2);
		expect(store.state.emotions.curiosity.deltas).toHaveLength(1);
		// A burst that keeps going is appraised by maxWaitMs = 3000.
		for (let i = 0; i < 25; i++) {
			push({ kind: 'looking-at-me', player: 'Noah', salient: true });
			await step(2);
		}
		expect(store.state.relations.Noah.axes.affection.deltas.length).toBeGreaterThanOrEqual(1);
		const ids = store.state.relations.Noah.axes.affection.deltas.map((d) => d.appraisalId);
		expect(new Set(ids).size).toBe(ids.length);
		expect(Math.min(...ids)).toBeGreaterThan(store.state.emotions.curiosity.deltas[0].appraisalId);
	});
});
