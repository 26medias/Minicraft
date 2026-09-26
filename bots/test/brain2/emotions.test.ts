import { describe, expect, it } from 'vitest';
import { bandOf, decayPatch, decayStep, nextBand } from '../../src/brain2/emotions.js';
import { initialState } from '../../src/brain2/store.js';
import { PIP } from '../../src/brain2/data/personalities.data.js';
import type { Personality, State } from '../../src/brain2/types.js';

const pose = { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 };

const TICK = 500;
function settle(v0: number, base: number, hl: number, ms: number, opts: Parameters<typeof decayStep>[4] = {}) {
	let a = { value: v0, pendingDrift: 0 };
	let emits = 0, signChanges = 0, bandChanges = 0;
	let band = bandOf(v0);
	let sign = Math.sign(v0 - base);
	for (let t = 0; t < ms; t += TICK) {
		const r = decayStep(a, base, hl, TICK, opts);
		a = { value: r.value, pendingDrift: r.pendingDrift };
		if (r.emit) emits++;
		const s = Math.sign(a.value - base);
		if (s !== 0 && sign !== 0 && s !== sign) signChanges++;
		if (s !== 0) sign = s;
		const nb = nextBand(band, a.value);
		if (nb !== band) bandChanges++;
		band = nb;
	}
	return { value: a.value, emits, signChanges, bandChanges };
}

describe('decay (spec §4.1)', () => {
	// Red on the rev 1 rule (no accumulation): Mood stayed at 1.0 for an hour.
	it('Mood 1.0 → 0.5 ± 0.01 after one 2-min half-life', () => {
		expect(Math.abs(settle(1, 0, 120_000, 120_000).value - 0.5)).toBeLessThanOrEqual(0.01);
	});
	// Red on the rev 2 formula (drift from value only) with the snap disabled: it overshoots and crosses the baseline.
	it('never changes sign while settling (snap disabled, so the formula alone is tested)', () => {
		expect(settle(1, 0.2, 20_000, 3_600_000, { snap: false }).signChanges).toBe(0);
		expect(settle(1, 0.2, 20_000, 3_600_000, { snap: false, formula: 'rev2' }).signChanges).toBeGreaterThan(0);
	});
	// Red on the rev 2 formula with the snap disabled (185 patches against a bound of 101).
	it('emits at most ⌈d/0.01⌉ + 1 decay patches (snap disabled)', () => {
		expect(settle(1, 0, 20_000, 3_600_000, { snap: false }).emits).toBeLessThanOrEqual(101);
		expect(settle(1, 0, 20_000, 3_600_000, { snap: false, formula: 'rev2' }).emits).toBeGreaterThan(101);
	});
	// Red on the rev 3 snap (it tested value alone and got stuck at 0.0105).
	it('from d = 0.0105 it snaps to the baseline within one half-life', () => {
		expect(settle(0.0105, 0, 1_800_000, 1_800_000).value).toBe(0);
	});
	it('with the snap on, the value stops exactly at the baseline', () => {
		expect(settle(1, 0.2, 20_000, 3_600_000).value).toBe(0.2);
	});
	// Red if pendingDrift goes back into the store: each tick would then write a change even though the
	// accumulated drift never crosses 0.01 (spec §4.1, rev 3.3: pendingDrift is private to the decay expert).
	it('decayPatch writes no patch over 10 ticks while the drift stays below 0.01', () => {
		const personality: Personality = { ...PIP, baselines: { ...PIP.baselines, mood: 0 }, halfLifeMs: { ...PIP.halfLifeMs, mood: 3_600_000 } };
		const s0 = initialState(personality, pose);
		const state: State = { ...s0, emotions: { ...s0.emotions, mood: { ...s0.emotions.mood, value: 0.3 } } };
		const pending = new Map<string, number>();
		let patches = 0;
		for (let i = 0; i < 10; i++) patches += decayPatch(state, TICK, pending).length;
		expect(patches).toBe(0);
	});
});

describe('bands with ±0.03 hysteresis (spec §4.1)', () => {
	it('an axis settling onto a band edge changes band at most twice', () => {
		expect(settle(1, 0.2, 20_000, 3_600_000).bandChanges).toBeLessThanOrEqual(2);
	});
	// Red if nextBand is replaced by bandOf (no hysteresis). The rev 2 formula, with the snap off, oscillates
	// around 0.2 (a band edge). It stands in for noisy appraisal near an edge, which flipped band 61×/h in the gate probe.
	it('hysteresis absorbs oscillation around a band edge', () => {
		expect(settle(1, 0.2, 20_000, 3_600_000, { snap: false, formula: 'rev2' }).bandChanges).toBeLessThanOrEqual(2);
	});
	it('needs to cross an edge by 0.03 to change band', () => {
		expect(nextBand('neutral', 0.21)).toBe('neutral');
		expect(nextBand('neutral', 0.23)).toBe('high');
		expect(nextBand('high', 0.18)).toBe('high');
		expect(nextBand('high', 0.169)).toBe('neutral');
		expect(nextBand('neutral', 0.95)).toBe('very high');
	});
	// Red on the symmetric rule (gate 2 M4): after a jump the band stayed where it was.
	it('a jump lands in the right band', () => {
		expect(nextBand('neutral', 0.58)).toBe('high');
		expect(nextBand('very high', 0.21)).toBe('high');
		expect(nextBand('neutral', -0.58)).toBe('low');
	});
});
