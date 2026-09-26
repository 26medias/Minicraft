import { isStale, type PlaytimeSession } from './playtime';
import { formatDuration } from './session-policy';

/**
 * One scheduled play session (docs/playtime.md). `worldId: null` lets the kid
 * choose among that mode's worlds. The plan stays until a parent ends or
 * replaces it, even once used up: the next session needs the next plan.
 */
export type Plan = {
	/** Kept by Change; a new plan gets a new one. The play session carries it as `planId`. */
	id: string;
	mode: 'solo' | 'mp';
	worldId: string | null;
	worldName: string | null;
	/** Wall clock when play may start. */
	startAt: number;
	limitMin: number;
	/** Added by the parent's +15 min. */
	extraMin: number;
	/** Wall clock when the plan was made. */
	createdAt: number;
};

/** A parental control fails closed: a present-but-invalid record is `broken`, not `none`. */
export type LoadedPlan =
	| { kind: 'none' }
	| { kind: 'broken' }
	| { kind: 'set'; plan: Plan };

export type PlanPhase = 'wait' | 'play' | 'done';

export function planActive(loaded: LoadedPlan): boolean {
	return loaded.kind !== 'none';
}

/** The plan's limit, extras included. */
export function planLimitMs(plan: Plan): number {
	return (plan.limitMin + plan.extraMin) * 60_000;
}

/** The stored session if it belongs to this plan. */
function planSession(stored: PlaytimeSession | null, plan: Plan): PlaytimeSession | null {
	return stored && stored.planId === plan.id ? stored : null;
}

/** The end of the local day `startAt` falls on: a plan's unused minutes die with it. */
export function planDayEnd(plan: Plan): number {
	const d = new Date(plan.startAt);
	d.setHours(24, 0, 0, 0);
	return d.getTime();
}

/** What a running game compares each tick: a different value means the parent changed the plan. +15 is not a change. */
export function planKey(loaded: LoadedPlan): string {
	if (loaded.kind !== 'set') return loaded.kind;
	const p = loaded.plan;
	return `${p.id}:${p.startAt}:${p.limitMin}:${p.mode}:${p.worldId ?? '*'}`;
}

/**
 * The session for a game started at `now`.
 *
 * Under a plan: the plan's session carries its played time; its limit is always
 * recomputed from the plan (+15 applies at the next Play); it is frozen iff
 * played ≥ limit. The kid's duration is ignored. Broken plan: an already-locked
 * session (fails closed even past the menu's gate).
 *
 * No plan: the stored session if not stale (a frozen one is not escaped by
 * picking "No limit"), else a new one of `chosenMin`, else no timer.
 */
export function resolveSession(
	stored: PlaytimeSession | null,
	chosenMin: number | null,
	loaded: LoadedPlan,
	now: number,
): PlaytimeSession | null {
	if (loaded.kind === 'broken') return { limitMs: 60_000, breakMs: null, playedMs: 60_000, frozenAt: now, startedAt: now, updatedAt: now };
	if (loaded.kind === 'set') {
		const base = planSession(stored, loaded.plan);
		const limitMs = planLimitMs(loaded.plan);
		const playedMs = base?.playedMs ?? 0;
		const over = playedMs >= limitMs || now >= planDayEnd(loaded.plan);
		return {
			limitMs,
			breakMs: null,
			playedMs,
			frozenAt: over ? (base?.frozenAt ?? now) : null,
			startedAt: base?.startedAt ?? now,
			updatedAt: now,
			planId: loaded.plan.id,
		};
	}
	// Free play never inherits a plan's session.
	if (stored && stored.planId === undefined && !isStale(stored, now)) return stored;
	if (chosenMin === null) return null;
	return { limitMs: chosenMin * 60_000, breakMs: null, playedMs: 0, frozenAt: null, startedAt: now, updatedAt: now };
}

/** Played time of the plan's session, in ms. */
export function planPlayedMs(plan: Plan, stored: PlaytimeSession | null): number {
	return planSession(stored, plan)?.playedMs ?? 0;
}

export function planPhase(plan: Plan, stored: PlaytimeSession | null, now: number): PlanPhase {
	if (now < plan.startAt) return 'wait';
	if (now >= planDayEnd(plan)) return 'done';
	// +15 after done unfreezes: only played vs the current limit decides.
	return planPlayedMs(plan, stored) >= planLimitMs(plan) ? 'done' : 'play';
}

/** Locale short time, e.g. "7:00 AM". */
export function formatClock(at: number): string {
	return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function sameLocalDay(a: number, b: number): boolean {
	const x = new Date(a);
	const y = new Date(b);
	return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** "today, 7:00 AM", "tomorrow, 7:00 AM", or a weekday for anything later. */
export function formatWhen(at: number, now: number): string {
	const clock = formatClock(at);
	if (sameLocalDay(at, now)) return `today, ${clock}`;
	if (sameLocalDay(at, now + 24 * 3_600_000)) return `tomorrow, ${clock}`;
	return `${new Date(at).toLocaleDateString([], { weekday: 'long' })}, ${clock}`;
}

/**
 * The start of a plan set at `now` for the local wall-clock time "HH:MM": today
 * if that is still ahead, else tomorrow. null for a malformed time.
 */
export function nextStartAt(raw: string, now: number): number | null {
	const m = /^(\d{2}):(\d{2})$/.exec(raw);
	if (!m) return null;
	const h = Number(m[1]);
	const min = Number(m[2]);
	if (h > 23 || min > 59) return null;
	const d = new Date(now);
	d.setHours(h, min, 0, 0);
	if (d.getTime() <= now) d.setDate(d.getDate() + 1);
	return d.getTime();
}

/**
 * The wait countdown, coarse on purpose (never seconds): "in 2 hours",
 * "in 1 hour", "in 45 minutes" … "in 1 minute".
 */
export function countdownText(startAt: number, now: number): string {
	const min = Math.max(1, Math.ceil((startAt - now) / 60_000));
	if (min >= 120) return `in ${Math.floor(min / 60)} hours`;
	if (min >= 60) return 'in 1 hour';
	if (min > 15) return `in ${Math.ceil(min / 5) * 5} minutes`;
	return `in ${min} minute${min === 1 ? '' : 's'}`;
}

export type PlayStatus = {
	canPlay: boolean;
	/** What the kid reads ("headline · sub"); null when there is nothing to say. */
	line: string | null;
	/** The kid picks a duration (no plan). */
	kidPicks: boolean;
	phase: PlanPhase | 'broken' | null;
	/** The freeze screen's title and line; undefined keeps TIME'S UP / ASK A PARENT. */
	freezeTitle: string | undefined;
	lockedText: string | undefined;
};

export type StatusInput = { plan: LoadedPlan; session: PlaytimeSession | null; now: number };

/** Where the kid stands. The menu and main.ts's belt-and-braces gate both read this. */
export function playStatus(i: StatusInput): PlayStatus {
	if (i.plan.kind === 'broken') {
		return { canPlay: false, line: "Something's wrong · ask a parent", kidPicks: false, phase: 'broken', freezeTitle: undefined, lockedText: undefined };
	}
	if (i.plan.kind === 'set') {
		const p = i.plan.plan;
		const locked = { freezeTitle: 'ALL DONE!', lockedText: 'GREAT BUILDING · YOUR WORLD IS SAVED' };
		const phase = planPhase(p, i.session, i.now);
		if (phase === 'wait') {
			return { canPlay: false, line: `Not yet · play at ${formatClock(p.startAt)} · ${countdownText(p.startAt, i.now)}`, kidPicks: false, phase, ...locked };
		}
		if (phase === 'done') return { canPlay: false, line: 'All done! · your world is saved', kidPicks: false, phase, ...locked };
		const left = Math.max(1, Math.ceil((planLimitMs(p) - planPlayedMs(p, i.session)) / 60_000));
		return { canPlay: true, line: `${left} minute${left === 1 ? '' : 's'} left`, kidPicks: false, phase, ...locked };
	}
	if (i.session && i.session.planId === undefined && !isStale(i.session, i.now) && i.session.frozenAt !== null) {
		return { canPlay: false, line: "Time's up · ask a parent", kidPicks: false, phase: null, freezeTitle: undefined, lockedText: undefined };
	}
	return { canPlay: true, line: null, kidPicks: true, phase: null, freezeTitle: undefined, lockedText: undefined };
}

/** The plan in one sentence, for the dialog's OK button and the parent's messages. */
export function planSentence(p: Pick<Plan, 'worldName' | 'startAt' | 'limitMin'>, now: number): string {
	const where = p.worldName ?? 'any world';
	const when = p.startAt <= now ? 'now' : formatWhen(p.startAt, now);
	return `${where} · ${when} · ${formatDuration(p.limitMin)}`;
}

/** The parent's status line on the locked screen. */
export function planSummary(loaded: LoadedPlan, stored: PlaytimeSession | null, now: number): string {
	if (loaded.kind === 'broken') return 'The saved schedule could not be read, so play is locked. End it or make a new one.';
	if (loaded.kind === 'none') return 'No schedule: free play.';
	const p = loaded.plan;
	const limit = formatDuration(p.limitMin + p.extraMin);
	const extra = p.extraMin > 0 ? ` (${formatDuration(p.limitMin)} + ${formatDuration(p.extraMin)} extra)` : '';
	const phase = planPhase(p, stored, now);
	if (phase === 'wait') return `Starts ${formatWhen(p.startAt, now)}, for ${limit}${extra}.`;
	const played = Math.min(Math.floor(planPlayedMs(p, stored) / 60_000), p.limitMin + p.extraMin);
	return `Played ${formatDuration(played)} of ${limit}${extra}.${phase === 'done' ? ' All done.' : ''}`;
}

/**
 * The gate at every way into a game (menu actions and the multiplayer autojoin
 * reload): no plan → free play decides; under a plan → phase play, the plan's
 * mode, and its world when one is locked.
 */
export function planAllows(target: { mode: 'solo' | 'mp'; worldId: string }, i: StatusInput): boolean {
	const st = playStatus(i);
	if (!st.canPlay) return false;
	if (i.plan.kind !== 'set') return true;
	const p = i.plan.plan;
	return target.mode === p.mode && (p.worldId === null || p.worldId === target.worldId);
}
