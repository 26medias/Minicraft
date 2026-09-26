import { describe, expect, it } from 'vitest';
import { BUSY_NAMES, POLES, ago, assertBudget, axisLine, busyState, eventSentence, memoryLine, roundSeconds, words } from '../../src/brain2/render.js';
import { initialState } from '../../src/brain2/store.js';
import { PIP } from '../../src/brain2/data/personalities.data.js';
import { GLOBAL_AXES, RELATION_AXES, type Relation, type State } from '../../src/brain2/types.js';

/** Task 18: the shared prompt renderers (spec §4.3) and the prompt-budget harness (spec §3.1). */

function rel(): Relation {
	const a = () => ({ value: 0, band: 'neutral' as const, deltas: [] });
	return { axes: { affection: a(), cooperation: a(), respect: a(), grievance: a() }, metSessions: 1, minutesTogether: 0, lastSeenT: 0 };
}
function state(): State {
	const s = structuredClone(initialState(PIP, { x: 0, y: 70, z: 0, yaw: 0, pitch: 0 })) as State;
	s.relations = { Noah: rel() };
	return s;
}

describe('roundSeconds and ago (spec §4.3)', () => {
	// Red if seconds aren't rounded (a prompt would carry 12.4 or 94), or the 5 s / 30 s split is at the wrong edge.
	it.each([
		[12_400, 10],
		[47_000, 45],
		[95_000, 90],
		[104_000, 90],
		[2_000, 0],
		[57_600, 60],
		[60_000, 60],
		[76_000, 90],
	])('%i ms → %i s', (ms, s) => {
		expect(roundSeconds(ms)).toBe(s);
	});

	it("says 'just now' under 5 s, else the rounded seconds", () => {
		expect(ago(0)).toBe('just now');
		expect(ago(4_999)).toBe('just now');
		expect(ago(5_000)).toBe('5 s ago');
		expect(ago(94_000)).toBe('90 s ago');
	});

	it('counts whitespace-separated words', () => {
		expect(words('  one two\tthree\nfour  ')).toBe(4);
		expect(words('')).toBe(0);
	});
});

describe('memoryLine (spec §4.3)', () => {
	// Red if the renderer prints raw seconds (94) instead of rounded (90), a timestamp, or the wrong order.
	it('matches the spec example, with rounded seconds', () => {
		const s = state();
		const now = 1_000_000;
		s.memory.current = { behaviour: 'explore', params: {}, lastedMs: 0, outcome: 'done', why: '', endedT: 0, startedT: now - 10_200 };
		s.memory.past = [
			{ behaviour: 'build', params: { template: 'tower' }, lastedMs: 94_000, outcome: 'done', why: 'finished', endedT: now - 11_000 },
			{ behaviour: 'follow', params: { kid: 'Noah' }, lastedMs: 40_000, outcome: 'interrupted', why: 'Noah flew away', endedT: now - 120_000 },
		];
		expect(memoryLine(s, now)).toBe('Now: Explore, started 10 s ago. Before: Build tower 90 s (done). Follow Noah 40 s (interrupted: Noah flew away).');
	});

	it('says so when there is nothing yet', () => {
		expect(memoryLine(state(), 0)).toBe('Now: nothing yet.');
	});
});

describe('axisLine, POLES and eventSentence', () => {
	it('prints the band and the pole it leans toward', () => {
		const s = state();
		s.emotions.mood = { value: 0.3, band: 'high', deltas: [] };
		expect(axisLine('mood', s)).toBe('My mood is high (the happy side).');
		s.relations.Noah.axes.grievance = { value: -0.7, band: 'very low', deltas: [] };
		expect(axisLine('rel.Noah.grievance', s)).toBe('My gratitude to Noah is very low (the resentful side).');
		s.emotions.patience = { value: 0, band: 'neutral', deltas: [] };
		expect(axisLine('patience', s)).toBe('My patience is neutral.');
	});

	it('has two poles for every global and relation axis; grievance runs resentful → grateful', () => {
		for (const a of [...GLOBAL_AXES, ...RELATION_AXES]) expect(POLES[a]).toHaveLength(2);
		expect(POLES.grievance).toEqual(['resentful', 'grateful']);
		expect(POLES.mood).toEqual(['unhappy', 'happy']);
	});

	it("names the build a broken block belonged to, with a rounded 'ago'", () => {
		const s = state();
		s.builds = [{ id: 'b1', template: 'tower', variant: 'small', origin: { x: 0, y: 70, z: 0 }, cells: [{ cell: { x: 1, y: 71, z: 2 }, block: 'stone' }], status: 'done' }];
		const ev = { id: 1, kind: 'broke-my-block' as const, t: 1_000, player: 'Noah', cell: { x: 1, y: 71, z: 2 }, salient: true };
		expect(eventSentence(ev, 6_200, s)).toBe('Noah broke a block of my tower 5 s ago.');
		expect(eventSentence(ev, 2_000)).toBe('Noah broke a block of my build just now.');
	});
});

describe('the prompt-budget harness (spec §3.1)', () => {
	it('busyState has 8 players, 30 events, 20 past actions and full relations', () => {
		const s = busyState();
		expect(Object.keys(s.relations).sort()).toEqual([...BUSY_NAMES].sort());
		expect(BUSY_NAMES).toHaveLength(8);
		expect(s.events).toHaveLength(30);
		expect(s.memory.past).toHaveLength(20);
		for (const r of Object.values(s.relations)) for (const a of RELATION_AXES) expect(r.axes[a].deltas.length).toBeGreaterThan(0);
	});

	// Red if assertBudget counts characters or tokens instead of words, or lets an over-budget prompt through.
	it('throws on 61 words, with the counts', () => {
		const prompt = Array.from({ length: 61 }, (_, i) => `w${i}`).join(' ');
		expect(() => assertBudget(prompt, 60, ['Noah'], BUSY_NAMES)).toThrow(/61 words.*60/);
		expect(() => assertBudget(prompt.split(' ').slice(0, 60).join(' '), 60, ['Noah'], BUSY_NAMES)).not.toThrow();
	});

	// Red if it doesn't look for other players' names (a renderer leaking the state would pass).
	it('throws on a prompt mentioning Mia when only Noah is allowed', () => {
		expect(() => assertBudget('Noah and Mia are building.', 60, ['Noah'], BUSY_NAMES)).toThrow(/Mia/);
		expect(() => assertBudget('Noah is building.', 60, ['Noah'], BUSY_NAMES)).not.toThrow();
	});

	// The harness itself: a renderer that leaks the state goes red on both assertions.
	it('catches a leaky renderer (memoryLine of the busy state) on both counts', () => {
		const s = busyState();
		const leaky = `${axisLine('mood', s)} ${memoryLine(s, 10_000_000)} ${s.events.map((e) => eventSentence(e, 10_000_000, s)).join(' ')}`;
		expect(words(leaky)).toBeGreaterThan(60);
		expect(() => assertBudget(leaky, 10_000, ['Noah'], BUSY_NAMES)).toThrow(/names not allowed/);
	});
});
