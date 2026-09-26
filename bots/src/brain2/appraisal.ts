/**
 * Layer 2, the code path of appraisal (spec §5.2): a burst of salient events becomes signed deltas on the global
 * axes and on the relation axes of the players involved, from the APPRAISAL table. The model engines (part 2)
 * propose; this is also their fallback.
 */
import { APPRAISAL } from './data/appraisal.data.js';
import { bandsPatch } from './emotions.js';
import { debounce, type Expert } from './experts/expert.js';
import type { Cause, Patch } from './store.js';
import { GLOBAL_AXES, RELATION_AXES, type AxisId, type AxisState, type GlobalAxis, type RelationAxis, type State, type WorldEvent } from './types.js';

export interface AppraisalDelta { axis: AxisId; amount: number; because: string }

/** Per-burst, per-axis clamp of the summed amount (spec §5.2). */
const MAX_AMOUNT = 0.4;
/** Deltas kept per axis. */
const KEEP_DELTAS = 10;
/** The selection trigger's window for Σ|Δ| (spec §5.3). */
const RECENT_MS = 10_000;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const tableKey = (e: WorldEvent): string => (e.kind === 'outcome' ? `outcome:${e.detail}` : e.kind);
const describe = (e: WorldEvent): string => (e.kind === 'outcome' ? `${e.detail}` : e.kind) + (e.player ? ` by ${e.player}` : '');

/**
 * The code appraisal (spec §5.2): the table amounts summed per axis over the whole burst, each sum clamped to ±0.4.
 * A `rel.*` term applies to the event's player; without a player (or a relation for him) it is skipped.
 */
export function appraiseCode(s: Readonly<State>, burst: WorldEvent[]): AppraisalDelta[] {
	const sums = new Map<AxisId, { amount: number; because: string[] }>();
	for (const e of burst) {
		const row = APPRAISAL[tableKey(e)];
		if (!row) continue;
		for (const [term, amount] of Object.entries(row) as Array<[string, number]>) {
			let axis: AxisId;
			if (term.startsWith('rel.')) {
				if (!e.player || !s.relations[e.player]) continue;
				axis = `rel.${e.player}.${term.slice(4) as RelationAxis}`;
			} else axis = term as GlobalAxis;
			const cur = sums.get(axis) ?? { amount: 0, because: [] };
			cur.amount += amount;
			const d = describe(e);
			if (!cur.because.includes(d)) cur.because.push(d);
			sums.set(axis, cur);
		}
	}
	return [...sums].filter(([, v]) => v.amount !== 0).map(([axis, v]) => ({ axis, amount: clamp(v.amount, -MAX_AMOUNT, MAX_AMOUNT), because: v.because.join(', ') }));
}

/** The path of an axis's state: ['emotions', ax] or ['relations', name, 'axes', ax]. null for an unknown axis. */
function axisPath(s: Readonly<State>, axis: AxisId): string[] | null {
	if ((GLOBAL_AXES as readonly string[]).includes(axis)) return ['emotions', axis];
	const m = /^rel\.(.+)\.([a-z]+)$/.exec(axis);
	if (!m || !(RELATION_AXES as readonly string[]).includes(m[2]) || !s.relations[m[1]]) return null;
	return ['relations', m[1], 'axes', m[2]];
}

/**
 * Applies deltas (spec §5.2): value = clamp(value + clamp(amount, ±0.4), −1, 1); a Delta is pushed (keep 10);
 * then the bands are recomputed with hysteresis.
 */
export function appraisalPatch(s: Readonly<State>, deltas: AppraisalDelta[], appraisalId: number, now: number): Patch {
	const out: Patch = [];
	const next = { ...s, emotions: { ...s.emotions }, relations: { ...s.relations } } as State;
	for (const d of deltas) {
		const path = axisPath(next, d.axis);
		if (!path) continue;
		const amount = clamp(d.amount, -MAX_AMOUNT, MAX_AMOUNT);
		const a: AxisState = path[0] === 'emotions' ? next.emotions[path[1] as GlobalAxis] : next.relations[path[1]].axes[path[3] as RelationAxis];
		const updated: AxisState = {
			...a,
			value: clamp(a.value + amount, -1, 1),
			deltas: [...a.deltas, { amount, cause: d.because, t: now, appraisalId }].slice(-KEEP_DELTAS),
		};
		if (path[0] === 'emotions') next.emotions[path[1] as GlobalAxis] = updated;
		else {
			const rel = next.relations[path[1]];
			next.relations[path[1]] = { ...rel, axes: { ...rel.axes, [path[3]]: updated } };
		}
		out.push({ path: [...path, 'value'], value: updated.value }, { path: [...path, 'deltas'], value: updated.deltas });
	}
	return [...out, ...bandsPatch(next)];
}

/** Σ|Δ| over every axis's deltas with t in the last 10 s (spec §5.3). Decay writes no deltas, so it never counts. */
export function recentDeltaSum(s: Readonly<State>, now: number): number {
	const sum = (a: AxisState) => a.deltas.filter((d) => now - d.t <= RECENT_MS).reduce((n, d) => n + Math.abs(d.amount), 0);
	let n = 0;
	for (const ax of GLOBAL_AXES) n += sum(s.emotions[ax]);
	for (const rel of Object.values(s.relations)) for (const ax of RELATION_AXES) n += sum(rel.axes[ax]);
	return n;
}

/** The next appraisal id, from the state: 1 + the largest id among the kept deltas (the newest is always kept). */
function nextAppraisalId(s: Readonly<State>): number {
	let m = 0;
	const see = (a: AxisState) => {
		for (const d of a.deltas) m = Math.max(m, d.appraisalId);
	};
	for (const ax of GLOBAL_AXES) see(s.emotions[ax]);
	for (const rel of Object.values(s.relations)) for (const ax of RELATION_AXES) see(rel.axes[ax]);
	return m + 1;
}

interface AppraiseSlice { state: Readonly<State>; burst: WorldEvent[] }
interface AppraiseProposal { deltas: AppraisalDelta[]; t: number; why: string }

/** The burst's events as `kind[:detail]#id`, for the cause (Expression reads the ids back, Task 16). */
const burstWhy = (burst: WorldEvent[]): string => burst.map((e) => `${tableKey(e)}#${e.id}`).join(' ');

function propose(sl: AppraiseSlice): AppraiseProposal {
	return { deltas: appraiseCode(sl.state, sl.burst), t: sl.burst.reduce((m, e) => Math.max(m, e.t), 0), why: burstWhy(sl.burst) };
}

/**
 * The appraisal expert, code engine (spec §5.2): debounced {quietMs 1000, maxWaitMs 3000} on salient events.
 * Deltas are stamped with the burst's newest event time (merge has no clock; it's ≤ maxWaitMs before now).
 */
export const appraiseExpert: Expert<AppraiseSlice, AppraiseProposal> = {
	name: 'appraise',
	layer: 2,
	trigger: debounce((sig) => sig.events.some((e) => e.salient), { quietMs: 1000, maxWaitMs: 3000 }),
	engine: 'code',
	priority: 1,
	reads: (state, sig) => ({ state, burst: sig.events.filter((e) => e.salient) }),
	materialKey: (sl) => sl.burst.map((e) => e.id).join(','),
	run: async (sl) => propose(sl),
	merge(p, s) {
		const id = nextAppraisalId(s);
		const cause: Cause = { kind: 'appraisal', by: 'appraise', appraisalId: id, why: p.why };
		return { patch: p.deltas.length ? appraisalPatch(s, p.deltas, id, p.t) : [], cause };
	},
	fallback: (sl) => propose(sl),
};
