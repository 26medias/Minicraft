import { isStale, phaseOf, type PlaytimeSession } from './playtime';
import type { WorldSummary } from '../persistence/adapter';
import { isLegacyId, seedFromLegacyId } from '../persistence/uuid';

/** The parent's saved daily schedule. No break: the limit ends play for the day. */
export type Schedule = {
	worldId: string;
	seed: number;
	name: string;
	limitMin: number;
	/** Minutes after local midnight, 0..1439. */
	startMin: number;
};

/** A parental control fails closed: a present-but-invalid record is `broken`, not `none`. */
export type LoadedSchedule =
	| { kind: 'none' }
	| { kind: 'broken' }
	| { kind: 'armed'; schedule: Schedule };

export function minutesSinceMidnight(now: number): number {
	const d = new Date(now);
	return d.getHours() * 60 + d.getMinutes();
}

export function gateOpen(startMin: number, now: number): boolean {
	return minutesSinceMidnight(now) >= startMin;
}

export function sameLocalDay(a: number, b: number): boolean {
	const x = new Date(a);
	const y = new Date(b);
	return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/**
 * Without a schedule: `isStale` (the 12-hour rule plus the future-updatedAt
 * guard). With one: the session belongs to the local day it started on,
 * however long ago it was touched, so a lock reached at 07:45 holds until
 * tomorrow's start time.
 */
export function sessionInForce(session: PlaytimeSession, schedule: Schedule | null, now: number): boolean {
	if (schedule === null) return !isStale(session, now);
	// The day rule alone: a record dated today holds today even if the clock was
	// set back (the future-updatedAt guard would otherwise hand out a fresh session).
	return sameLocalDay(session.startedAt, now);
}

/** The session Save writes when the start time has already passed today, so the schedule bites tonight. */
export function doneForToday(limitMin: number, now: number): PlaytimeSession {
	const limitMs = limitMin * 60_000;
	return { limitMs, breakMs: null, playedMs: limitMs, frozenAt: now, startedAt: now, updatedAt: now };
}

export function activeLimits(
	schedule: Schedule | null,
	opts: { playLimitMin: number | null; playBreakMin: number | null },
): { limitMin: number | null; breakMin: number | null } {
	if (schedule) return { limitMin: schedule.limitMin, breakMin: null };
	return { limitMin: opts.playLimitMin, breakMin: opts.playBreakMin };
}

/** Locale short time for `startMin` on the day of `now`. On a spring-forward day a time inside the missing hour renders an hour late; cosmetic. */
export function formatStartTime(startMin: number, now: number): string {
	const d = new Date(now);
	d.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
	return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** A legacy world is re-listed under a fresh uuid after its first play; match it by seed. */
export function resolveWorld(schedule: Schedule, worlds: WorldSummary[]): WorldSummary | null {
	const exact = worlds.find((w) => w.id === schedule.worldId);
	if (exact) return exact;
	if (!isLegacyId(schedule.worldId)) return null;
	const seed = seedFromLegacyId(schedule.worldId);
	return worlds.find((w) => w.origin === 'local' && w.seed === seed) ?? null;
}

/** The gate the menu callback checks before startGame; the menu model agrees with it. */
export function canStartNow(loaded: LoadedSchedule, session: PlaytimeSession | null, now: number): boolean {
	if (loaded.kind === 'none') return true;
	if (loaded.kind === 'broken') return false;
	const s = loaded.schedule;
	if (!gateOpen(s.startMin, now)) return false;
	// Any in-force session that is not playing is "done for today" (a break, if a
	// stale unscheduled tab wrote one, does not reopen the day).
	if (session && sessionInForce(session, s, now) && phaseOf(session, now) !== 'playing') return false;
	return true;
}
