import { GLOBAL_AXES, RELATION_AXES, type Band, type State } from './types.js';
import type { Patch } from './store.js';

/** Spec §4.1 word bands, without hysteresis (hysteresis is nextBand, Task 3). */
export function bandOf(v: number): Band {
	if (v <= -0.6) return 'very low';
	if (v <= -0.2) return 'low';
	if (v < 0.2) return 'neutral';
	if (v < 0.6) return 'high';
	return 'very high';
}

const HYST = 0.03;
const EMIT = 0.01;

const ORDER: Band[] = ['very low', 'low', 'neutral', 'high', 'very high'];

/**
 * Spec §4.1: the band changes only once the value is 0.03 past an edge, in the direction it moved. The
 * direction matters after a jump: 'neutral' → 0.58 must give 'high' (gate 2: a symmetric test kept 'neutral').
 */
export function nextBand(prev: Band, v: number): Band {
	const raw = bandOf(v);
	if (raw === prev) return prev;
	const up = ORDER.indexOf(raw) > ORDER.indexOf(prev);
	const cand = bandOf(up ? v - HYST : v + HYST);
	return cand === prev ? prev : cand;
}

/**
 * One decay tick (spec §4.1, repaired twice). Drift accumulates from value + pendingDrift (so it can't
 * overshoot); it is applied once |pendingDrift| ≥ 0.01; the value snaps to the baseline once
 * |value + pendingDrift − baseline| < 0.01. `formula: 'rev2'` reproduces the old defect for the tests only.
 */
export function decayStep(
	a: { value: number; pendingDrift: number },
	baseline: number,
	halfLifeMs: number,
	dtMs: number,
	opts: { snap?: boolean; formula?: 'rev3' | 'rev2' } = {},
): { value: number; pendingDrift: number; emit: boolean } {
	const snap = opts.snap ?? true;
	const from = opts.formula === 'rev2' ? a.value : a.value + a.pendingDrift;
	if (a.value === baseline && a.pendingDrift === 0) return { value: a.value, pendingDrift: 0, emit: false };
	if (snap && Math.abs(a.value + a.pendingDrift - baseline) < EMIT) return { value: baseline, pendingDrift: 0, emit: true };
	const k = 1 - Math.pow(2, -dtMs / halfLifeMs);
	const drift = a.pendingDrift + (baseline - from) * k;
	if (Math.abs(drift) >= EMIT) return { value: a.value + drift, pendingDrift: 0, emit: true };
	return { value: a.value, pendingDrift: drift, emit: false };
}

/**
 * The decay expert's patch (spec §5.1): global axes toward the baselines, relation axes toward 0.
 * `pending` is the expert's private accumulated drift, keyed 'mood' or 'rel.<name>.<axis>'. It's kept out
 * of the store, so an unsettled axis writes a change only when the drift is applied (spec §4.1, rev 3.3).
 */
export function decayPatch(s: State, dtMs: number, pending: Map<string, number>): Patch {
	const out: Patch = [];
	const one = (id: string, path: string[], value: number, baseline: number, hl: number) => {
		const r = decayStep({ value, pendingDrift: pending.get(id) ?? 0 }, baseline, hl, dtMs);
		if (r.pendingDrift === 0) pending.delete(id); else pending.set(id, r.pendingDrift);
		if (r.value !== value) out.push({ path, value: r.value });
	};
	for (const ax of GLOBAL_AXES) one(ax, ['emotions', ax, 'value'], s.emotions[ax].value, s.personality.baselines[ax], s.personality.halfLifeMs[ax]);
	for (const [name, rel] of Object.entries(s.relations)) {
		for (const ax of RELATION_AXES) one(`rel.${name}.${ax}`, ['relations', name, 'axes', ax, 'value'], rel.axes[ax].value, 0, s.personality.relationHalfLifeMs[ax]);
	}
	return out;
}

/** Recomputes every band with hysteresis. It is applied after any emotion patch, with the same cause. */
export function bandsPatch(s: State): Patch {
	const out: Patch = [];
	for (const ax of GLOBAL_AXES) {
		const a = s.emotions[ax];
		const b = nextBand(a.band, a.value);
		if (b !== a.band) out.push({ path: ['emotions', ax, 'band'], value: b });
	}
	for (const [name, rel] of Object.entries(s.relations)) {
		for (const ax of RELATION_AXES) {
			const a = rel.axes[ax];
			const b = nextBand(a.band, a.value);
			if (b !== a.band) out.push({ path: ['relations', name, 'axes', ax, 'band'], value: b });
		}
	}
	return out;
}
