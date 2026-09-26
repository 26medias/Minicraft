import { beforeEach, describe, expect, it } from 'vitest';
import { appraisalPatch } from '../../src/brain2/appraisal.js';
import { SelectionController, scoreInputs, scoreRows, selectInputs, type Row } from '../../src/brain2/selection.js';
import { EMOTIONAL, MERGE } from '../../src/brain2/data/weights.data.js';
import { paramsBuild, paramsExplore, paramsMine, paramsPlayer, resetCompany } from '../../src/brain2/params.js';
import { Scheduler } from '../../src/brain2/scheduler.js';
import { Store, initialState } from '../../src/brain2/store.js';
import { ManualClock } from '../../src/brain2/clock.js';
import { PIP } from '../../src/brain2/data/personalities.data.js';
import { bandOf } from '../../src/brain2/emotions.js';
import { StopSignal } from '../../src/body/stop-signal.js';
import type { LogLine } from '../../src/brain2/log.js';
import { GLOBAL_AXES, type ActionEntry, type ActiveBehaviour, type AxisId, type BehaviourKind, type Outcome, type Relation, type RelationAxis, type State, type WorldEvent } from '../../src/brain2/types.js';
import type { KidInfo } from '../../src/types.js';

const Y = 200;
function kid(name: string, x: number, z: number): KidInfo {
	return {
		name, id: name === 'Noah' ? 7 : 8, pose: { x, y: Y, z, yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 }, speedLast0_3s: 0, speedLast1s: 0,
		flying: false, inLiquid: false, lookTarget: null, lookBlock: null, lookDistance: null, lookHeldMs: 0, miningCell: null,
		placements: [], idleSinceMs: null,
	};
}
function rel(v: Partial<Record<RelationAxis, number>> = {}): Relation {
	const a = (value = 0) => ({ value, band: bandOf(value), deltas: [] });
	return { axes: { affection: a(v.affection), cooperation: a(v.cooperation), respect: a(v.respect), grievance: a(v.grievance) }, metSessions: 1, minutesTogether: 0, lastSeenT: 0 };
}
function baseState(): State {
	const s = structuredClone(initialState(PIP, { x: 0.5, y: Y, z: 0.5, yaw: 0, pitch: 0 })) as State;
	s.relations = { Noah: rel(), Mia: rel() };
	return s;
}
const setEmotions = (s: State, v: Partial<Record<(typeof GLOBAL_AXES)[number], number>>) => {
	for (const [k, x] of Object.entries(v)) s.emotions[k as (typeof GLOBAL_AXES)[number]] = { value: x, band: bandOf(x), deltas: [] };
};
const winner = (rows: Row[]): BehaviourKind => rows.reduce((a, b) => (b.total > a.total ? b : a)).behaviour;
const line = (id: number, player: string, t: number): WorldEvent => ({
	id, kind: 'line-started', t, player, cell: { x: 3, y: Y, z: 0 }, block: 'stone', salient: true,
	detail: JSON.stringify({ next: { x: 3, y: Y, z: 0 }, d: { x: 1, y: 0, z: 0 }, block: 'stone' }),
});
const answered = (s: State, social: Record<string, { near: number; help: number }>) => {
	s.selection = { id: 1, t: 0, trigger: 'test', urgent: false, social, situational: 'none', done: false };
};

/** A runner stand-in that records start/end and writes what the real one writes (behaviour, memory, the outcome event). */
class FakeRunner {
	starts: Array<{ kind: BehaviourKind; params: Record<string, unknown>; t: number }> = [];
	ends: Array<{ outcome: Outcome; why: string; t: number; kind: BehaviourKind; kid: unknown }> = [];
	constructor(private readonly store: Store, private readonly clock: () => number) {}
	start(kind: BehaviourKind, params: Record<string, unknown>): void {
		if (this.store.state.behaviour) this.end('interrupted', `switched to ${kind}`);
		const t = this.clock();
		this.starts.push({ kind, params, t });
		const b: ActiveBehaviour = { kind, params, startedT: t, step: 0, rejections: 0, failures: 0, plannedEdits: 0, progress: '', lastResults: [] };
		this.store.apply([{ path: ['behaviour'], value: b }], { kind: 'behaviour', by: 'runner' });
	}
	end(outcome: Outcome, why: string): void {
		const b = this.store.state.behaviour;
		if (!b) return;
		const t = this.clock();
		this.ends.push({ outcome, why, t, kind: b.kind, kid: b.params.kid });
		const entry: ActionEntry = { behaviour: b.kind, params: b.params, lastedMs: t - b.startedT, outcome, why, endedT: t };
		const ev: WorldEvent = { id: this.store.nextEventId(), kind: 'outcome', t, detail: outcome, salient: true, player: typeof b.params.kid === 'string' ? b.params.kid : undefined };
		this.store.apply([
			{ path: ['memory', 'past'], value: [entry, ...this.store.state.memory.past].slice(0, 20) },
			{ path: ['behaviour'], value: null },
			{ path: ['events'], value: [...this.store.state.events, ev].slice(-30) },
		], { kind: 'behaviour', by: 'runner' });
	}
	/** Switches (a change of kind or target) not caused by an outcome, a stop signal or a hazard. */
	switches(since = -Infinity): number {
		return this.ends.filter((e) => e.t >= since && e.why.startsWith('switch:') && !/switch: (stop|hazard)/.test(e.why)).length;
	}
}

function rig(o: { state?: State; kids?: KidInfo[]; noCap?: boolean; noEdits?: boolean } = {}) {
	const clock = new ManualClock(0);
	const store = new Store(o.state ?? baseState(), clock.now);
	let kids = o.kids ?? [];
	const stop = new StopSignal(600_000);
	const runner = new FakeRunner(store, clock.now);
	const lines: LogLine[] = [];
	const ctl = new SelectionController({
		store, clock: clock.now, kidsNow: () => kids, stop, noEdits: () => o.noEdits ?? false, runner, log: (l) => lines.push(l),
		params: { player: paramsPlayer, explore: paramsExplore, mine: paramsMine, build: paramsBuild }, noCap: o.noCap,
	});
	const sched = new Scheduler({ store, clock: clock.now, engines: () => ({ laya: null, llm: null }), onCall: () => {} });
	for (const e of [ctl.request, ctl.social, ctl.situational, ctl.merge]) sched.register(e);
	const push = (e: Omit<WorldEvent, 'id' | 't' | 'salient'> & { salient?: boolean }) => {
		const full: WorldEvent = { salient: true, ...e, id: store.nextEventId(), t: clock.t };
		store.apply([{ path: ['events'], value: [...store.state.events, full].slice(-30) }], { kind: 'perception', by: 'test' });
		return full;
	};
	const step = async (n = 1) => {
		for (let i = 0; i < n; i++) {
			clock.advance(100);
			await sched.tick();
		}
	};
	const selects = () => lines.filter((l): l is Extract<LogLine, { k: 'select' }> => l.k === 'select');
	return { clock, store, stop, runner, ctl, sched, lines, selects, push, step, setKids: (k: KidInfo[]) => (kids = k) };
}

beforeEach(() => resetCompany());

describe('scoring (spec §5.3)', () => {
	// 1. Red if a weight row or the social term is wired to the wrong behaviour.
	it('scores: a very-fond kid makes Follow win; a bored, curious bot picks Explore; overstimulated picks Rest', () => {
		const fond = baseState();
		fond.relations.Noah = rel({ affection: 0.9 });
		setEmotions(fond, { trust: 0.3 });
		answered(fond, { Noah: { near: 1, help: 0 } });
		expect(winner(scoreRows(fond, [kid('Noah', 4, 0)], 0, 'Noah', false))).toBe('follow');

		const bored = baseState();
		setEmotions(bored, { curiosity: 0.9, stimulation: -0.8, confidence: 0.3 });
		answered(bored, {});
		expect(winner(scoreRows(bored, [], 0, null, false))).toBe('explore');

		const over = baseState();
		setEmotions(over, { stimulation: 1, mood: -0.2 });
		answered(over, {});
		expect(winner(scoreRows(over, [], 0, null, false))).toBe('rest');
	});

	// 2. Red if a mask is missing: a masked behaviour must be −∞ whatever its score.
	it('masks: no kid → no Follow/Watch/Help-build; edits halted → no Build/Mine/Help-build', () => {
		const s = baseState();
		s.inventory = { stone: 50 };
		answered(s, {});
		const noKid = scoreRows(s, [], 0, null, false);
		for (const b of ['follow', 'watch', 'help-build'] as const) expect(noKid.find((r) => r.behaviour === b)).toMatchObject({ masked: true, total: -Infinity });
		expect(noKid.find((r) => r.behaviour === 'build')!.masked).toBe(false);
		s.events = [line(1, 'Noah', 0)];
		answered(s, { Noah: { near: 1, help: 1 } });
		const withKid = scoreRows(s, [kid('Noah', 4, 0)], 1000, 'Noah', false);
		expect(withKid.find((r) => r.behaviour === 'help-build')!.masked).toBe(false);
		const halted = scoreRows(s, [kid('Noah', 4, 0)], 1000, 'Noah', true);
		for (const b of ['build', 'mine', 'help-build'] as const) expect(halted.find((r) => r.behaviour === b)!.masked).toBe(true);
		s.body.editsHalted = 'rate';
		const tripped = scoreRows(s, [kid('Noah', 4, 0)], 1000, 'Noah', false);
		for (const b of ['build', 'mine', 'help-build'] as const) expect(tripped.find((r) => r.behaviour === b)!.masked).toBe(true);
		// No building block held: Build is masked (its plan would fail at once).
		const empty = baseState();
		answered(empty, {});
		expect(scoreRows(empty, [], 0, null, false).find((r) => r.behaviour === 'build')!.masked).toBe(true);
		// A stop active for the player masks Help-build.
		s.body.editsHalted = null;
		const stopped = selectInputs(s, [kid('Noah', 4, 0)], 1000, 'Noah', false, (k) => k === 'Noah');
		expect(stopped.masked).toContain('help-build');
	});

	// 4. Red if lineBonus < the grievance penalty (criterion 7, R13): set MERGE.lineBonus to 0.3 and this fails.
	it('criterion 7 R13 fixture (code path): grievance pinned at −1 toward Noah, a fresh line → Help-build still wins', async () => {
		const s = baseState();
		// The worst relation: he broke my things (grievance −1, cooperation −1), and everything else about him at −1 too.
		s.relations.Noah = rel({ grievance: -1, cooperation: -1, affection: -1, respect: -1 });
		setEmotions(s, { mood: -1, patience: -1 });
		const r = rig({ state: s, kids: [kid('Noah', 5, 0)] });
		await r.step();                                    // start
		r.push({ kind: 'line-started', player: 'Noah', cell: { x: 3, y: Y, z: 0 }, block: 'stone', detail: JSON.stringify({ next: { x: 3, y: Y, z: 0 }, d: { x: 1, y: 0, z: 0 }, block: 'stone' }) });
		await r.step();
		expect(r.store.state.behaviour?.kind).toBe('help-build');
		expect(r.store.state.behaviour?.params).toMatchObject({ kid: 'Noah', next: { x: 3, y: Y, z: 0 }, d: { x: 1, y: 0, z: 0 }, block: 'stone' });
	});

	// 5. Red if the bonus leaks without a line from the selected player (here Mia lays one, Noah doesn't).
	it('criterion 7 negative fixtures: kid near, not laying a line, across 20 random emotional states → Help-build wins ≤ 20%', () => {
		let seed = 7;
		const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
		let wins = 0;
		for (let i = 0; i < 20; i++) {
			const s = baseState();
			s.inventory = { stone: 40 };
			for (const a of GLOBAL_AXES) setEmotions(s, { [a]: rnd() });
			s.relations.Noah = rel({ affection: rnd(), cooperation: rnd(), respect: rnd(), grievance: rnd() });
			s.events = [line(1, 'Mia', 0)];
			answered(s, { Noah: { near: 0.5, help: 0.5 }, Mia: { near: 0.5, help: 1 } });
			if (winner(scoreRows(s, [kid('Noah', 4, 0), kid('Mia', 30, 0)], 1000, 'Noah', false)) === 'help-build') wins++;
		}
		expect(wins).toBeLessThanOrEqual(4);
	});

	// Ruling R17. Red if the resume bonus outranks a Mine that just failed: the outcome trigger re-picked the same
	// failing Mine about once a second (batch F concern 1).
	it('a paused dig\'s resume bonus does not re-pick a Mine that just failed; a paused or stale Mine still resumes', () => {
		const s = baseState();
		s.inventory = { stone: 40 };
		s.digs = [{ id: 'd1', block: 'stone', entrance: { x: 0, y: Y, z: 0 }, target: { x: 1, y: Y - 20, z: 0 }, stepsDone: 5, cells: [], status: 'paused', spiral: { px: 0, pz: 0, y0: Y, phase: 7, lastStep: 19 } }];
		const past = (outcome: Outcome, endedT: number): ActionEntry => ({ behaviour: 'mine', params: { block: 'stone' }, lastedMs: 500, outcome, why: outcome === 'failed' ? 'same action failed 3 times' : outcome, endedT });
		const mineRow = (t: number) => scoreRows(s, [], t, null, false).find((r) => r.behaviour === 'mine')!;
		s.memory.past = [past('failed', 1000)];
		expect(selectInputs(s, [], 2000, null, false).recency.mine).toBe('bad');
		expect(mineRow(2000).recency).toBeLessThan(0);
		expect(selectInputs(s, [], 1000 + 5 * 60_000 + 1, null, false).recency.mine).toBe('resume');   // no longer recent
		s.memory.past = [past('paused', 1000)];
		expect(selectInputs(s, [], 2000, null, false).recency.mine).toBe('resume');
		expect(mineRow(2000).recency).toBeGreaterThan(0);
	});

	// brain2-productive. Red if the running behaviour is penalised as 'recent' by its own earlier episode: a resumed
	// Mine (its dig active, not paused) scored −0.5 and lost to Rest at the first appraisal trigger, 20 s into every episode.
	it('the running behaviour gets no recency penalty from its own earlier episode; others still do', () => {
		const s = baseState();
		s.inventory = { stone: 40 };
		s.digs = [{ id: 'd1', block: 'stone', entrance: { x: 0, y: Y, z: 0 }, target: { x: 1, y: Y - 20, z: 0 }, stepsDone: 5, cells: [], status: 'active', spiral: { px: 0, pz: 0, y0: Y, phase: 7, lastStep: 19 } }];
		s.memory.past = [
			{ behaviour: 'mine', params: { block: 'stone' }, lastedMs: 20_000, outcome: 'paused', why: 'switch: appraisal', endedT: 1000 },
			{ behaviour: 'explore', params: {}, lastedMs: 2000, outcome: 'done', why: 'done', endedT: 900 },
		];
		s.behaviour = { kind: 'mine', params: { block: 'stone' }, startedT: 1500, step: 3, rejections: 0, failures: 0, plannedEdits: 30, progress: '', lastResults: [] } as ActiveBehaviour;
		const inputs = selectInputs(s, [], 21_500, null, false);
		expect(inputs.recency.mine).toBe('none');
		expect(inputs.recency.explore).toBe('recent');
		expect(scoreRows(s, [], 21_500, null, false).find((r) => r.behaviour === 'mine')!.recency).toBe(0);
	});

	// Red if scoreRows drifts from scoreInputs over selectInputs (replay relies on it, Task 21).
	it('scoreRows = scoreInputs(selectInputs(…)) with the live tables', () => {
		const s = baseState();
		s.events = [line(1, 'Noah', 0)];
		answered(s, { Noah: { near: 1, help: 1 } });
		const kids = [kid('Noah', 4, 0)];
		expect(scoreRows(s, kids, 1000, 'Noah', false)).toEqual(scoreInputs(selectInputs(s, kids, 1000, 'Noah', false), { EMOTIONAL, MERGE }));
	});
});

describe('the selection controller (spec §5.3)', () => {
	// 3. Red if line-started isn't urgent or the flat bonus is missing.
	it('line-started from a kid within 16 is urgent and Help-build wins (the flat bonus)', async () => {
		const r = rig({ kids: [kid('Noah', 10, 0)] });
		await r.step();
		const first = r.store.state.behaviour!;
		await r.step(20);                                  // well inside the 20 s minimum
		r.push({ kind: 'line-started', player: 'Noah', cell: { x: 3, y: Y, z: 0 }, block: 'stone', detail: JSON.stringify({ next: { x: 3, y: Y, z: 0 }, d: { x: 1, y: 0, z: 0 }, block: 'stone' }) });
		await r.step();
		expect(r.store.state.selection).toMatchObject({ trigger: 'line-started', urgent: true, done: true });
		expect(r.store.state.behaviour).toMatchObject({ kind: 'help-build', params: { kid: 'Noah' } });
		expect(r.runner.ends.at(-1)).toMatchObject({ kind: first.kind, why: 'switch: line-started' });
		// A line 20 blocks away is not a trigger.
		const far = rig({ kids: [kid('Noah', 20, 0)] });
		await far.step();
		const id = far.store.state.selection!.id;
		await far.step(20);
		far.push({ kind: 'line-started', player: 'Noah', cell: { x: 20, y: Y, z: 0 }, block: 'stone', detail: '{}' });
		await far.step();
		expect(far.store.state.selection!.id).toBe(id);
	});

	// 6. Red if normal triggers interrupt inside the 20 s minimum, or if an outcome waits for it.
	it('a normal trigger inside the 20 s minimum is held; an outcome is not', async () => {
		const r = rig({ kids: [] });
		await r.step();
		const id0 = r.store.state.selection!.id;
		await r.step(50);                                   // t = 5.1 s
		r.push({ kind: 'player-arrived', player: 'Mia' });
		r.setKids([kid('Mia', 5, 0)]);
		await r.step();
		expect(r.store.state.selection!.id).toBe(id0);      // held
		await r.step(140);                                  // t = 19.2 s
		expect(r.store.state.selection!.id).toBe(id0);
		await r.step(10);                                   // the minimum is up
		expect(r.store.state.selection).toMatchObject({ id: id0 + 1, trigger: 'player-arrived', urgent: false });
		// An outcome selects at once, whatever the minimum.
		const r2 = rig({ kids: [] });
		await r2.step();
		const id2 = r2.store.state.selection!.id;
		await r2.step(30);
		r2.runner.end('done', 'done');
		await r2.step();
		expect(r2.store.state.selection).toMatchObject({ id: id2 + 1, trigger: 'outcome:done' });
		expect(r2.store.state.behaviour).not.toBeNull();
	});

	// 7. Red if the per-kind-per-kid limit or the "already serves him" rule is missing.
	it('urgent limits: the same kind from the same kid within 20 s is ignored; it never interrupts a behaviour serving that kid', async () => {
		const r = rig({ kids: [kid('Noah', 5, 0), kid('Mia', 8, 0)] });
		await r.step();
		r.push({ kind: 'looking-at-me', player: 'Mia' });
		await r.step();
		expect(r.store.state.selection).toMatchObject({ trigger: 'looking-at-me', urgent: true });
		expect(r.store.state.behaviour?.params.kid).toBe('Mia');
		await r.step(5);
		r.push({ kind: 'hazard', detail: 'hazard' });       // back to Noah (the nearest), so nothing serves Mia now
		await r.step();
		expect(r.store.state.behaviour?.params.kid).toBe('Noah');
		const id1 = r.store.state.selection!.id;
		await r.step(90);                                   // t ≈ 10 s: the same kind from Mia again
		r.push({ kind: 'looking-at-me', player: 'Mia' });
		await r.step(250);                                  // past the minimum: a downgraded (held) trigger would have fired
		expect(r.store.state.selection!.id).toBe(id1);      // dropped, not downgraded
		// Help-build {Noah} running: Noah's looking-at-me is dropped.
		const r2 = rig({ kids: [kid('Noah', 5, 0)] });
		await r2.step();
		r2.push({ kind: 'line-started', player: 'Noah', cell: { x: 3, y: Y, z: 0 }, block: 'stone', detail: JSON.stringify({ next: { x: 3, y: Y, z: 0 }, d: { x: 1, y: 0, z: 0 }, block: 'stone' }) });
		await r2.step();
		expect(r2.store.state.behaviour).toMatchObject({ kind: 'help-build', params: { kid: 'Noah' } });
		const id2 = r2.store.state.selection!.id;
		await r2.step(350);                                  // past the governor and the minimum
		r2.push({ kind: 'looking-at-me', player: 'Noah' });
		await r2.step(300);
		expect(r2.store.state.selection!.id).toBe(id2);
		expect(r2.store.state.behaviour).toMatchObject({ kind: 'help-build', params: { kid: 'Noah' } });
	});

	// 9. Red if stop signals or hazards are downgraded by the governor.
	it('stop signals and hazards bypass the governor', async () => {
		const r = rig({ kids: [kid('Noah', 5, 0), kid('Mia', 8, 0)] });
		await r.step();
		r.push({ kind: 'looking-at-me', player: 'Mia' });
		await r.step();
		expect(r.store.state.selection).toMatchObject({ urgent: true });
		expect(r.runner.ends.length).toBe(1);               // an urgent switch now: the governor is armed for 30 s
		await r.step(30);
		r.push({ kind: 'looking-at-me', player: 'Noah' });
		await r.step();
		expect(r.store.state.selection).toMatchObject({ trigger: 'looking-at-me', urgent: true });
		expect(r.selects().at(-1)!.player).toBe('Mia');     // Noah's was downgraded to normal and held: no new selection
		r.push({ kind: 'hazard', detail: 'hazard' });
		await r.step();
		expect(r.store.state.selection).toMatchObject({ trigger: 'hazard', urgent: true, done: true });
		await r.step(10);
		r.push({ kind: 'broke-my-block', player: 'Mia', cell: { x: 1, y: Y, z: 1 }, detail: 'stop' });
		await r.step();
		expect(r.store.state.selection).toMatchObject({ trigger: 'stop', urgent: true, done: true });
	});

	// 10. Red if keep-going ignores Stimulation's band, or fires on an engaged behaviour past 60 s but under typicalMs.
	it('keep-going: a Watch past 60 s while bored triggers a selection; an engaged Follow at 150 s (under typicalMs) does not', async () => {
		const bored = baseState();
		setEmotions(bored, { stimulation: -0.5 });
		const r = rig({ state: bored, kids: [kid('Noah', 5, 0)] });
		r.runner.start('watch', { kid: 'Noah' });
		await r.step(595);                                  // t = 59.5 s
		expect(r.store.state.selection).toBeNull();
		await r.step(10);                                   // the 60 s check
		expect(r.store.state.selection).toMatchObject({ trigger: 'keep-going', urgent: false });

		// Engaged, past 60 s (so an "always bored" check would fire) but under Follow's typicalMs[1] = 180 s.
		const engaged = baseState();
		setEmotions(engaged, { stimulation: 0.5 });
		const e = rig({ state: engaged, kids: [kid('Noah', 5, 0)] });
		e.runner.start('follow', { kid: 'Noah' });
		await e.step(1500);                                 // 150 s: five keep-going checks
		expect(e.store.state.selection).toBeNull();
	});

	// 11. Red if a switch isn't logged, or the line lacks the inputs and the rows (criterion 6).
	it('every switch logs a select line with the rows', async () => {
		const r = rig({ kids: [kid('Noah', 5, 0), kid('Mia', 8, 0)] });
		await r.step();
		r.push({ kind: 'looking-at-me', player: 'Mia' });
		await r.step();
		r.runner.end('failed', 'test');
		await r.step();
		expect(r.selects()).toHaveLength(3);
		for (const l of r.selects()) {
			expect(l.rows.map((x) => x.behaviour)).toEqual(['follow', 'help-build', 'build', 'mine', 'explore', 'watch', 'rest']);
			expect(l.inputs.emotions.mood).toBe(PIP.baselines.mood);
			expect(l.winner).not.toBeNull();
		}
		expect(r.selects()[1]).toMatchObject({ trigger: 'looking-at-me', urgent: true, player: 'Mia', winner: r.runner.starts[1].kind });
		expect(r.selects()[1].rows.find((x) => x.behaviour === 'follow')!.social).toBe(0.5);
		expect(r.selects()[2].inputs.recency).toMatchObject({ [r.runner.starts[1].kind]: 'bad' });
	});
});

describe('the selection controller: fix round (batch E review)', () => {
	/** An appraisal the way the appraise expert writes it: real deltas, cause kind 'appraisal'. */
	const appraise = (r: ReturnType<typeof rig>, id: number, moves: Record<string, number>) =>
		r.store.apply(appraisalPatch(r.store.state, Object.entries(moves).map(([axis, amount]) => ({ axis: axis as AxisId, amount, because: 'test' })), id, r.clock.t),
			{ kind: 'appraisal', by: 'appraise', appraisalId: id });

	// 13. Red if the appraisal trigger re-counts the deltas it already fired on (a small later appraisal re-fires).
	it('the appraisal trigger counts only deltas newer than the appraisal it last fired on', async () => {
		const s = baseState();
		setEmotions(s, { stimulation: 0.5 });
		const r = rig({ state: s, kids: [kid('Noah', 5, 0)] });
		r.runner.start('follow', { kid: 'Noah' });
		await r.step(210);                                  // t = 21 s: past the minimum
		expect(r.store.state.selection).toBeNull();
		appraise(r, 1, { mood: 0.3, curiosity: 0.3 });      // Σ 0.6 > 0.5
		await r.step();
		expect(r.store.state.selection).toMatchObject({ trigger: 'appraisal' });
		const id = r.store.state.selection!.id;
		await r.step(10);
		appraise(r, 2, { mood: 0.1 });                      // Σ 0.7 in 10 s, but only 0.1 is new
		await r.step(250);                                  // past any minimum: a held re-fire would show
		expect(r.store.state.selection!.id).toBe(id);
		appraise(r, 3, { mood: 0.3, outlook: 0.3 });        // a new Σ 0.6 fires again
		await r.step(250);
		expect(r.store.state.selection!.id).toBeGreaterThan(id);
		expect(r.selects().at(-1)!.trigger).toBe('appraisal');
	});

	// 14. Red if a held downgraded line is overwritten by a later normal trigger (Noah lost as player, Help-build masked).
	it('a held urgent-origin trigger is not replaced by a later normal one', async () => {
		const r = rig({ kids: [kid('Noah', 5, 0), kid('Mia', 8, 0)] });
		await r.step();
		r.push({ kind: 'looking-at-me', player: 'Mia' });   // an urgent switch: the governor is armed, the minimum restarts
		await r.step();
		expect(r.store.state.behaviour?.params.kid).toBe('Mia');
		const id = r.store.state.selection!.id;
		await r.step(100);                                  // 10 s in: fresh enough to still count when the minimum is up
		r.push({ kind: 'line-started', player: 'Noah', cell: { x: 3, y: Y, z: 0 }, block: 'stone', detail: JSON.stringify({ next: { x: 3, y: Y, z: 0 }, d: { x: 1, y: 0, z: 0 }, block: 'stone' }) });
		await r.step();
		expect(r.store.state.selection!.id).toBe(id);       // downgraded by the governor, held
		await r.step(20);
		r.push({ kind: 'player-arrived', player: 'Leo' });  // a later normal trigger, no player
		await r.step(100);                                  // the minimum is up
		expect(r.store.state.selection).toMatchObject({ id: id + 1, trigger: 'line-started', urgent: false });
		expect(r.store.state.behaviour).toMatchObject({ kind: 'help-build', params: { kid: 'Noah' } });
	});
});

/** Criterion 1's two-kid fixture: Noah's line-started and Mia's looking-at-me alternate every c seconds for 5 minutes. */
async function twoKids(c: number, noCap: boolean) {
	const r = rig({ kids: [kid('Noah', 5, 0), kid('Mia', -5, 0)], noCap });
	let n = 0;
	for (let t = 0; t < 3000; t++) {
		if (t % (c * 10) === 0) {
			if (n++ % 2 === 0) r.push({ kind: 'line-started', player: 'Noah', cell: { x: 3, y: Y, z: n }, block: 'stone', detail: JSON.stringify({ next: { x: 3, y: Y, z: n }, d: { x: 1, y: 0, z: 0 }, block: 'stone' }) });
			else r.push({ kind: 'looking-at-me', player: 'Mia' });
		}
		await r.step();
	}
	return r;
}

describe('criterion 1: the switch cap (spec rev 3.3)', () => {
	// 8. The instrument for the cap: the governor alone allowed 11–17 switches (gate 2 B1). Red without the cap.
	it('criterion 1 two-kid fixture', async () => {
		const uncapped: Record<number, number> = {};
		const capped: Record<number, number> = {};
		for (const c of [3, 4, 5, 7]) {
			capped[c] = (await twoKids(c, false)).runner.switches();
			expect(capped[c], `c = ${c} s`).toBeLessThanOrEqual(10);
			uncapped[c] = (await twoKids(c, true)).runner.switches();
		}
		for (const c of [3, 4, 5]) expect(uncapped[c], `uncapped c = ${c} s`).toBeGreaterThan(10);
	});

	// 12. Red if the cap also blocks idle merges (the bot would idle for up to 5 minutes).
	it('a merge with no active behaviour is never capped', async () => {
		const r = await twoKids(3, false);
		expect(r.ctl.cappedSwitches(r.clock.t)).toBeGreaterThanOrEqual(9);   // the cap is full
		const starts = r.runner.starts.length;
		// Idle by a non-exempt path: the behaviour is cleared with no outcome event, then a kid looks at the bot.
		r.store.apply([{ path: ['behaviour'], value: null }], { kind: 'behaviour', by: 'test' });
		await r.step();
		expect(r.runner.starts.length).toBe(starts);
		r.push({ kind: 'looking-at-me', player: 'Noah' });
		await r.step(5);
		expect(r.store.state.selection).toMatchObject({ trigger: 'looking-at-me' });
		expect(r.ctl.cappedSwitches(r.clock.t)).toBeGreaterThanOrEqual(9);   // still full: only the idle rule starts it
		expect(r.runner.starts.length).toBe(starts + 1);
		expect(r.store.state.behaviour).not.toBeNull();
	});
});
