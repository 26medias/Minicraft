/**
 * Layer 3, the code path of selection (spec §5.3): when to select (triggers, urgent limits, the urgent governor,
 * the 20 s minimum, keep-going), how to score (the emotional table, the social and situational votes, inertia,
 * recency, the resume bonus, the line bonus, the mask), and the merge that starts the winner under the switch cap.
 */
import type { StopSignal } from '../body/stop-signal.js';
import type { KidInfo } from '../types.js';
import { recentDeltaSum } from './appraisal.js';
import { BEHAVIOURS } from './behaviours/behaviour.js';
import type { Clock } from './clock.js';
import { LIMITS } from './data/limits.data.js';
import { EMOTIONAL, MERGE } from './data/weights.data.js';
import { every, on, type Expert, type Signal } from './experts/expert.js';
import type { LogLine, SelectInputs } from './log.js';
import { paramsBuild, paramsExplore, paramsMine, paramsPlayer, sampleCompany } from './params.js';
import type { BehaviourRunner } from './runner.js';
import type { Cause, Change, Store } from './store.js';
import { GLOBAL_AXES, RELATION_AXES, type BehaviourKind, type Outcome, type Selection, type State, type Vec3, type WorldEvent } from './types.js';

/** Scoring order, which is also the tie order (spec §5.3). */
export const ORDER: BehaviourKind[] = ['follow', 'help-build', 'build', 'mine', 'explore', 'watch', 'rest'];
const LINE_FRESH_MS = 15_000;
const PLACED_RECENT_MS = 10_000;
const RECENT_MS = 5 * 60_000;
const URGENT_NEAR = 16;
const URGENT_SAME_MS = 20_000;
const GOVERNOR_MS = 30_000;
const CAP_WINDOW_MS = 5 * 60_000;
/** A merge may switch only if fewer than this many capped switches happened in the window (spec rev 3.3). */
const CAP = 9;
const KEEP_GOING_MS = 30_000;
const KEEP_GOING_BORED_MS = 60_000;
const APPRAISAL_TRIGGER = 0.5;
const DEFAULT_TYPICAL_MAX = 60_000;

export interface Row { behaviour: BehaviourKind; emotional: number; social: number; situational: number; inertia: number; recency: number; bonus: number; masked: boolean; total: number }
export type Tables = { EMOTIONAL: typeof EMOTIONAL; MERGE: typeof MERGE };

/** The newest `line-started` from the player that is ≤ 15 s old. */
function freshLine(s: Readonly<State>, player: string | null, now: number): WorldEvent | undefined {
	if (!player) return undefined;
	return [...s.events].reverse().find((e) => e.kind === 'line-started' && e.player === player && now - e.t <= LINE_FRESH_MS);
}

/** Help-build's params from a line-started event's detail ({next, d, block}), or null. */
function lineParams(e: WorldEvent | undefined, kid: string): Record<string, unknown> | null {
	if (!e?.detail) return null;
	try {
		const d = JSON.parse(e.detail) as { next?: Vec3; d?: Vec3; block?: string };
		return d.next && d.d && d.block ? { kid, next: d.next, d: d.d, block: d.block } : null;
	} catch {
		return null;
	}
}

/**
 * Everything scoring reads, gathered from live state (logged in the `select` line). `stopActive` (not in the
 * plan's signature) masks Help-build for a kid with an active stop signal (spec §7.1).
 */
export function selectInputs(s: Readonly<State>, kids: KidInfo[], now: number, player: string | null, noEdits: boolean, stopActive: (kid: string) => boolean = () => false): SelectInputs {
	const emotions = Object.fromEntries(GLOBAL_AXES.map((a) => [a, s.emotions[a].value])) as SelectInputs['emotions'];
	const r = player ? s.relations[player] : undefined;
	const relation = r ? (Object.fromEntries(RELATION_AXES.map((a) => [a, r.axes[a].value])) as SelectInputs['relation']) : null;
	const typicalMaxMs = Object.fromEntries(ORDER.map((k) => [k, BEHAVIOURS[k]?.typicalMs[1] ?? DEFAULT_TYPICAL_MAX])) as SelectInputs['typicalMaxMs'];
	const pausedDigs = s.digs.filter((d) => d.status === 'paused');
	const recency = Object.fromEntries(ORDER.map((k) => {
		if (k === 'mine' && pausedDigs.length > 0) return [k, 'resume'];
		const last = s.memory.past.find((e) => e.behaviour === k);
		if (!last || now - last.endedT > RECENT_MS) return [k, 'none'];
		return [k, last.outcome === 'abandoned' || last.outcome === 'failed' ? 'bad' : 'recent'];
	})) as SelectInputs['recency'];
	const line = freshLine(s, player, now);
	const lineFresh = !!player && lineParams(line, player) !== null;
	const sel = s.selection;
	const masked: BehaviourKind[] = [];
	const mask = (k: BehaviourKind) => {
		if (!masked.includes(k)) masked.push(k);
	};
	const present = player !== null && kids.some((k) => k.name === player);
	if (!present) ['follow', 'watch', 'help-build'].forEach((k) => mask(k as BehaviourKind));
	if (!lineFresh || (player && stopActive(player))) mask('help-build');
	if (noEdits || s.body.editsHalted) ['build', 'mine', 'help-build'].forEach((k) => mask(k as BehaviourKind));
	if (pausedDigs.length >= LIMITS.MAX_PAUSED_DIGS && !pausedDigs.some((d) => d.block === paramsMine(s).block)) mask('mine');
	// Build's plan fails at once without a building block (and paramsBuild renews at the cap, spec §6).
	if (!paramsBuild(s).materials.wall) mask('build');
	return {
		emotions, relation, current: s.behaviour?.kind ?? null, startedAgoMs: s.behaviour ? now - s.behaviour.startedT : 0, typicalMaxMs,
		recency, lineFresh, social: player && sel?.social?.[player] ? sel.social[player] : null,
		situational: sel && sel.situational && sel.situational !== 'none' ? sel.situational.behaviour : null,
		masked: ORDER.filter((k) => masked.includes(k)),
	};
}

/**
 * Pure scoring from inputs and tables. Replay (Task 21) calls this with overridden tables. The emotional, social
 * and situational terms are unweighted; inertia, recency and bonus are the MERGE-scaled amounts (spec §5.3 as the
 * plan defines them); total = Σ MERGE weights × the first three + the other three, or −∞ when masked.
 */
export function scoreInputs(inputs: SelectInputs, tables: Tables): Row[] {
	const M = tables.MERGE;
	return ORDER.map((behaviour) => {
		const row = tables.EMOTIONAL[behaviour];
		let emotional = row.bias;
		for (const [term, w] of Object.entries(row.w) as Array<[string, number]>) {
			emotional += w * (term.startsWith('rel.') ? (inputs.relation?.[term.slice(4) as keyof NonNullable<SelectInputs['relation']>] ?? 0) : inputs.emotions[term as keyof SelectInputs['emotions']]);
		}
		const so = inputs.social;
		const social = !so ? 0 : behaviour === 'follow' ? so.near : behaviour === 'watch' ? 0.6 * so.near : behaviour === 'help-build' ? so.help : 0;
		const situational = inputs.situational === behaviour ? 1 : 0;
		const inertia = inputs.current === behaviour ? M.inertia * Math.min(1, inputs.startedAgoMs / inputs.typicalMaxMs[behaviour]) : 0;
		const rec = inputs.recency[behaviour];
		const recency = rec === 'recent' ? -M.recency : rec === 'bad' ? -M.recencyBad : rec === 'resume' ? M.resume : 0;
		const bonus = behaviour === 'help-build' && inputs.lineFresh ? M.lineBonus : 0;
		const masked = inputs.masked.includes(behaviour);
		const total = masked ? -Infinity : M.emotional * emotional + M.social * social + M.situational * situational + inertia + recency + bonus;
		return { behaviour, emotional, social, situational, inertia, recency, bonus, masked, total };
	});
}

function scoreLive(s: Readonly<State>, kids: KidInfo[], now: number, player: string | null, noEdits: boolean, stopActive?: (kid: string) => boolean) {
	const inputs = selectInputs(s, kids, now, player, noEdits, stopActive);
	return { inputs, rows: scoreInputs(inputs, { EMOTIONAL, MERGE }) };
}

/** = scoreInputs(selectInputs(…), { EMOTIONAL, MERGE }). The only live path, so live and replay can't drift apart. */
export function scoreRows(s: Readonly<State>, kids: KidInfo[], now: number, player: string | null, noEdits: boolean, stopActive?: (kid: string) => boolean): Row[] {
	return scoreLive(s, kids, now, player, noEdits, stopActive).rows;
}

/** The highest total, ties by ORDER; null when everything is masked. */
export function winnerOf(rows: Row[]): BehaviourKind | null {
	let best: Row | null = null;
	for (const r of rows) if (r.total !== -Infinity && (!best || r.total > best.total)) best = r;
	return best?.behaviour ?? null;
}

/** Social code fallback per kid (spec §5.3): near from the relation and trust; help from a fresh line or a recent placement. */
export function socialCode(s: Readonly<State>, kids: string[], now: number): Record<string, { near: number; help: number }> {
	const out: Record<string, { near: number; help: number }> = {};
	for (const k of kids) {
		const r = s.relations[k];
		const x = r ? r.axes.affection.value + 0.5 * s.emotions.trust.value + 0.5 * r.axes.grievance.value : 0.5 * s.emotions.trust.value;
		const near = x > 0.3 ? 1 : x < -0.3 ? 0 : 0.5;
		const help = freshLine(s, k, now) ? 1 : s.events.some((e) => e.kind === 'placed' && e.player === k && now - e.t <= PLACED_RECENT_MS) ? 0.5 : 0;
		out[k] = { near, help };
	}
	return out;
}

type TriggerKind = 'start' | 'outcome' | 'stop' | 'hazard' | 'target-gone' | 'line-started' | 'looking-at-me' | 'player-arrived' | 'player-gone' | 'appraisal' | 'keep-going';
interface Cand { kind: TriggerKind; trigger: string; player: string | null; urgent: boolean }
interface Meta { player: string | null; kind: TriggerKind }
/** Switches caused by these are never capped (spec rev 3.3); stop and hazard also bypass the governor. */
const EXEMPT = new Set<TriggerKind>(['start', 'outcome', 'stop', 'hazard']);
const PRIORITY: TriggerKind[] = ['stop', 'hazard', 'target-gone', 'outcome', 'start', 'line-started', 'looking-at-me', 'player-gone', 'player-arrived', 'appraisal', 'keep-going'];

export interface SelectionDeps {
	store: Store; clock: Clock; kidsNow: () => KidInfo[]; stop: StopSignal; noEdits: () => boolean;
	runner: Pick<BehaviourRunner, 'start' | 'end'>;           // merge starts and ends behaviours (gate 2)
	log: (l: LogLine) => void;                                // merge writes the `select` line
	params: { player: typeof paramsPlayer; explore: typeof paramsExplore; mine: typeof paramsMine; build: typeof paramsBuild };
	/** Tests only: disables the switch cap (criterion 1's mutation). */
	noCap?: boolean;
}

const CAUSE = (by: string, why?: string): Cause => ({ kind: 'selection', by, why });
const selectionChanged = (sig: Signal, test: (sel: Selection | null, c: Change) => boolean): boolean =>
	sig.changes.some((c) => c.path.startsWith('selection') && test(c.path === 'selection' ? (c.new as Selection | null) : null, c));

export class SelectionController {
	/** The code expert that decides whether to request a selection (writes state.selection). */
	readonly request: Expert<{ sig: Signal }, { sel: Selection | null }>;
	/** Code fallback of select.social (Task 20 adds the model engine). */
	readonly social: Expert<{ id: number | null; social: Record<string, { near: number; help: number }> }, { id: number | null; social: Record<string, { near: number; help: number }> }>;
	/** select.situational: in the code path its fallback is 'none'. */
	readonly situational: Expert<{ id: number | null }, { id: number | null; situational: Selection['situational'] }>;
	/** Merges once social and situational are answered; logs a `select` line; starts the winner via the runner. */
	readonly merge: Expert<{ sel: Selection | null }, { id: number | null }>;

	private started = false;
	private nextId = 0;
	private readonly meta = new Map<number, Meta>();
	private held: Cand | null = null;
	private readonly urgentSeen = new Map<string, number>();
	private switches: Array<{ t: number; capped: boolean; urgent: boolean }> = [];
	private lastKeepGoing: number;
	/** Outcome events written by the merge's own switches: not "the behaviour ended". */
	private readonly ownOutcomes = new Set<number>();

	constructor(private readonly d: SelectionDeps) {
		this.lastKeepGoing = d.clock();
		this.request = {
			name: 'select.request', layer: 3, trigger: every(100), engine: 'code', priority: 0,
			reads: (_s, sig) => ({ sig }),
			materialKey: () => '',
			run: async (sl) => ({ sel: this.decide(sl.sig) }),
			merge: (p) => ({ patch: p.sel ? [{ path: ['selection'], value: p.sel }] : [], cause: CAUSE('select.request', p.sel?.trigger) }),
			fallback: () => ({ sel: null }),
		};
		const asked = (sig: Signal) => selectionChanged(sig, (sel) => !!sel && !sel.done && (sel.social === null || sel.situational === null));
		const socialOf = (s: Readonly<State>) => ({ id: s.selection && !s.selection.done ? s.selection.id : null, social: socialCode(s, this.d.kidsNow().map((k) => k.name), this.d.clock()) });
		this.social = {
			name: 'select.social', layer: 3, trigger: on(asked), engine: 'code', priority: 2,
			reads: (s) => socialOf(s),
			materialKey: (sl) => JSON.stringify(sl),
			run: async (sl) => sl,
			merge: (p, s) => ({ patch: p.id !== null && s.selection?.id === p.id && s.selection.social === null ? [{ path: ['selection', 'social'], value: p.social }] : [], cause: CAUSE('select.social') }),
			fallback: (sl) => sl,
		};
		this.situational = {
			name: 'select.situational', layer: 3, trigger: on(asked), engine: 'code', priority: 3,
			reads: (s) => ({ id: s.selection && !s.selection.done ? s.selection.id : null }),
			materialKey: (sl) => String(sl.id),
			run: async (sl) => ({ id: sl.id, situational: 'none' as const }),
			merge: (p, s) => ({
				patch: p.id !== null && s.selection?.id === p.id && s.selection.situational === null ? [{ path: ['selection', 'situational'], value: p.situational }] : [],
				cause: CAUSE('select.situational'),
			}),
			fallback: (sl) => ({ id: sl.id, situational: 'none' }),
		};
		this.merge = {
			name: 'select.merge', layer: 3, trigger: on((sig) => selectionChanged(sig, () => true)), engine: 'code', priority: 0,
			reads: (s) => ({ sel: s.selection }),
			materialKey: (sl) => String(sl.sel?.id ?? ''),
			run: async (sl) => ({ id: this.mergeNow(sl.sel) }),
			merge: (p, s) => ({ patch: p.id !== null && s.selection?.id === p.id ? [{ path: ['selection', 'done'], value: true }] : [], cause: CAUSE('select.merge') }),
			fallback: () => ({ id: null }),
		};
	}

	/** Capped switches in the 5 min window ending now (for the TUI and tests). */
	cappedSwitches(now: number): number {
		return this.switches.filter((x) => x.capped && now - x.t < CAP_WINDOW_MS).length;
	}

	// ── requesting ──

	private candidates(sig: Signal, s: Readonly<State>, now: number): Cand[] {
		const cur = s.behaviour;
		const out: Cand[] = [];
		const add = (kind: TriggerKind, player: string | null, urgent: boolean, trigger: string = kind) => out.push({ kind, trigger, player, urgent });
		if (!this.started) {
			this.started = true;
			if (!cur) add('start', null, false);
		}
		const pose = s.body.pose;
		const kids = this.d.kidsNow();
		for (const e of sig.events) {
			switch (e.kind) {
				case 'outcome':
					if (!this.ownOutcomes.delete(e.id) && !cur) add('outcome', null, false, `outcome:${e.detail}`);
					break;
				case 'hazard':
					add('hazard', e.player ?? null, true);
					break;
				case 'broke-my-block':
					if (e.detail === 'stop' && e.player) add('stop', e.player, true);
					break;
				case 'player-gone':
					if (e.player && cur?.params.kid === e.player) add('target-gone', e.player, true);
					else add('player-gone', null, false);
					break;
				case 'player-arrived':
					add('player-arrived', null, false);
					break;
				case 'line-started': {
					const k = kids.find((x) => x.name === e.player);
					const at = k ? k.pose : e.cell;
					if (e.player && at && Math.hypot(at.x - pose.x, at.y - pose.y, at.z - pose.z) <= URGENT_NEAR) add('line-started', e.player, true);
					break;
				}
				case 'looking-at-me':
					if (e.player) add('looking-at-me', e.player, true);
					break;
				default:
					break;
			}
		}
		if (sig.changes.some((c) => c.cause.kind === 'appraisal') && recentDeltaSum(s, now) > APPRAISAL_TRIGGER) add('appraisal', null, false);
		if (now - this.lastKeepGoing >= KEEP_GOING_MS) {
			this.lastKeepGoing = now;
			if (cur) {
				const ran = now - cur.startedT;
				const typicalMax = BEHAVIOURS[cur.kind]?.typicalMs[1] ?? DEFAULT_TYPICAL_MAX;
				const bored = s.emotions.stimulation.band === 'low' || s.emotions.stimulation.band === 'very low';
				const failing = cur.lastResults.length >= 3 && cur.lastResults.slice(-3).every((ok) => !ok);
				if (ran > typicalMax || (bored && ran >= KEEP_GOING_BORED_MS) || failing) add('keep-going', null, false);
			}
		}
		return out.sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));
	}

	/** Whether the current behaviour already serves the trigger's player (then an urgent trigger is dropped). */
	private serves(c: Cand, s: Readonly<State>): boolean {
		const cur = s.behaviour;
		if (!cur || !c.player) return false;
		// A line is served only by Help-build for him (spec §5.3's example): following him must still let his line in (criterion 7).
		if (c.kind === 'line-started') return cur.kind === 'help-build' && cur.params.kid === c.player;
		if (c.kind === 'looking-at-me') return cur.params.kid === c.player;
		return false;
	}

	private decide(sig: Signal): Selection | null {
		const s = this.d.store.state;
		const now = this.d.clock();
		sampleCompany(s, now);
		const cur = s.behaviour;
		const minUp = !cur || now - cur.startedT >= LIMITS.MIN_BEHAVIOUR_MS;
		for (const c0 of this.candidates(sig, s, now)) {
			const c = { ...c0 };
			if (c.urgent) {
				const key = `${c.kind}|${c.player ?? ''}`;
				if (now - (this.urgentSeen.get(key) ?? -Infinity) < URGENT_SAME_MS || this.serves(c, s)) continue;   // dropped
				this.urgentSeen.set(key, now);
				const recentUrgent = this.switches.some((x) => x.urgent && now - x.t < GOVERNOR_MS);
				if (recentUrgent && c.kind !== 'stop' && c.kind !== 'hazard') c.urgent = false;           // the governor downgrades it
			}
			if (!c.urgent && c.kind !== 'outcome' && c.kind !== 'start' && !minUp) {
				this.held = c;                                                                            // held until the minimum is up
				return null;
			}
			return this.open(c, s, now);
		}
		if (this.held && minUp && cur) return this.open(this.held, s, now);
		return null;
	}

	private open(c: Cand, s: Readonly<State>, now: number): Selection {
		this.held = null;
		const id = ++this.nextId;
		const player = this.d.params.player(s, this.d.kidsNow(), now, c.player ?? undefined);
		this.meta.set(id, { player, kind: c.kind });
		if (this.meta.size > 50) this.meta.delete(Math.min(...this.meta.keys()));
		return { id, t: now, trigger: c.trigger, urgent: c.urgent, social: null, situational: null, done: false };
	}

	// ── merging ──

	private paramsFor(kind: BehaviourKind, sel: Selection, player: string | null, s: Readonly<State>, kids: KidInfo[], now: number): Record<string, unknown> {
		if (sel.situational && sel.situational !== 'none' && sel.situational.behaviour === kind) return sel.situational.params;
		const p = this.d.params;
		switch (kind) {
			case 'follow':
			case 'watch':
				return { kid: player ?? kids[0]?.name };
			case 'help-build':
				return lineParams(freshLine(s, player, now), player ?? '') ?? {};
			case 'build':
				return { ...p.build(s) };
			case 'mine':
				return { ...p.mine(s) };
			case 'explore': {
				const pose = s.body.pose;
				const near = [...kids].sort((a, b) => Math.hypot(a.pose.x - pose.x, a.pose.z - pose.z) - Math.hypot(b.pose.x - pose.x, b.pose.z - pose.z))[0];
				const anchor = near ? near.pose : s.builds.at(-1)?.origin ?? pose;
				return { dir: p.explore(s, { x: anchor.x, y: anchor.y, z: anchor.z }, { x: pose.x, y: pose.y, z: pose.z }).dir };
			}
			case 'rest':
				return {};
		}
	}

	/** Returns the merged selection's id, or null when it isn't ready. */
	private mergeNow(sel: Selection | null): number | null {
		if (!sel || sel.done || sel.social === null || sel.situational === null) return null;
		const s = this.d.store.state;
		const now = this.d.clock();
		const kids = this.d.kidsNow();
		const m = this.meta.get(sel.id) ?? { player: null, kind: 'keep-going' as TriggerKind };
		const { inputs, rows } = scoreLive(s, kids, now, m.player, this.d.noEdits(), (k) => this.d.stop.activeFor(k, now));
		let winner = winnerOf(rows) ?? (kids.length > 0 ? 'watch' : 'rest');
		let params = this.paramsFor(winner, sel, m.player, s, kids, now);
		const cur = s.behaviour;
		if (!cur) this.d.runner.start(winner, params);                            // no active behaviour: never capped
		else if (cur.kind !== winner || (cur.params.kid ?? null) !== (params.kid ?? null)) {
			const exempt = EXEMPT.has(m.kind);
			if (exempt || this.d.noCap || this.cappedSwitches(now) < CAP) {
				const outcome: Outcome = cur.kind === 'mine' ? 'paused' : 'interrupted';
				const floor = s.events.reduce((n, e) => Math.max(n, e.id), 0);
				this.d.runner.end(outcome, `switch: ${sel.trigger}`);
				for (const e of this.d.store.state.events) if (e.kind === 'outcome' && e.id > floor) this.ownOutcomes.add(e.id);
				this.d.runner.start(winner, params);
				this.switches = this.switches.filter((x) => now - x.t < CAP_WINDOW_MS);
				this.switches.push({ t: now, capped: !exempt, urgent: sel.urgent });
			} else {
				winner = cur.kind;                                                // capped out: keep the current behaviour
				params = cur.params;
			}
		}
		this.d.log({ k: 'select', t: now, selectionId: sel.id, trigger: sel.trigger, urgent: sel.urgent, player: m.player, inputs, rows, winner, params });
		return sel.id;
	}
}
