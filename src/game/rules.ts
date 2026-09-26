import { isStale, type PlaytimeSession } from './playtime';
import { formatDuration } from './session-policy';

/**
 * The parent's everyday rules. `startMin`: no play before this many minutes
 * after local midnight (null = any time). `dailyMin`: play minutes per day
 * (null = no daily limit; the kid picks a duration per sitting instead).
 */
export type Rules = { startMin: number | null; dailyMin: number | null };

/** A parental control fails closed: a present-but-invalid record is `broken`, not `none`. */
export type LoadedRules =
	| { kind: 'none' }
	| { kind: 'broken' }
	| { kind: 'set'; rules: Rules };

/** Today-only changes from the Parents screen; a record from another day means nothing. */
export type Today = { day: string; extraMin: number; unlimited: boolean };

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

/** The local day of `now`, as the key of a Today record. */
export function dayKey(now: number): string {
	const d = new Date(now);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Locale short time for `startMin` on the day of `now`. On a spring-forward day a time inside the missing hour renders an hour late; cosmetic. */
export function formatStartTime(startMin: number, now: number): string {
	const d = new Date(now);
	d.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
	return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Rules that reach the kid at all. Broken counts: it locks. */
export function rulesActive(loaded: LoadedRules): boolean {
	return loaded.kind !== 'none';
}

function rulesOf(loaded: LoadedRules): Rules | null {
	return loaded.kind === 'set' ? loaded.rules : null;
}

/** Today's extras; a record dated another day gives none. */
export function extrasFor(today: Today | null, now: number): { extraMin: number; unlimited: boolean } {
	if (today === null || today.day !== dayKey(now)) return { extraMin: 0, unlimited: false };
	return { extraMin: today.extraMin, unlimited: today.unlimited };
}

/**
 * The session for a game started at `now`.
 *
 * Under a daily limit the session is the day's: a stored session started today
 * carries its played time, and its limit is always recomputed from today's rules
 * (daily + extras), so a rule change or "+15 min" applies at the next Play. A
 * session from another day is ignored. "No limit today" gives no timer.
 *
 * Without a daily limit: the stored session if not stale (a frozen one is not
 * escaped by picking "No limit"), else a new one of `chosenMin`, else no timer.
 */
export function resolveSession(
	stored: PlaytimeSession | null,
	chosenMin: number | null,
	loaded: LoadedRules,
	today: Today | null,
	now: number,
): PlaytimeSession | null {
	if (loaded.kind === 'broken') return null;
	const daily = rulesOf(loaded)?.dailyMin ?? null;
	if (daily !== null) {
		const ex = extrasFor(today, now);
		if (ex.unlimited) return null;
		const limitMs = (daily + ex.extraMin) * 60_000;
		const base = stored && sameLocalDay(stored.startedAt, now) ? stored : null;
		const playedMs = base?.playedMs ?? 0;
		return {
			limitMs,
			breakMs: null,
			playedMs,
			frozenAt: playedMs >= limitMs ? (base?.frozenAt ?? now) : null,
			startedAt: base?.startedAt ?? now,
			updatedAt: now,
		};
	}
	if (stored && !isStale(stored, now)) return stored;
	if (chosenMin === null) return null;
	return { limitMs: chosenMin * 60_000, breakMs: null, playedMs: 0, frozenAt: null, startedAt: now, updatedAt: now };
}

export type PlayStatus = {
	canPlay: boolean;
	/** What the kid reads on the menu; null when there is nothing to say. */
	line: string | null;
	/** The kid picks a duration (no daily limit applies). */
	kidPicks: boolean;
	/** The freeze screen's text; undefined keeps ASK A PARENT. */
	lockedText: string | undefined;
};

export type StatusInput = { rules: LoadedRules; session: PlaytimeSession | null; today: Today | null; now: number };

function minutes(n: number): string {
	return `${n} minute${n === 1 ? '' : 's'}`;
}

/** Where the kid stands. The menu and main.ts's belt-and-braces gate both read this. */
export function playStatus(i: StatusInput): PlayStatus {
	if (i.rules.kind === 'broken') {
		return { canPlay: false, line: "Something's wrong · ask a parent", kidPicks: false, lockedText: undefined };
	}
	const r = rulesOf(i.rules);
	const time = r?.startMin != null ? formatStartTime(r.startMin, i.now) : null;
	const daily = r?.dailyMin ?? null;
	const lockedText = daily !== null ? `PLAY AGAIN TOMORROW${time ? ` AT ${time.toUpperCase()}` : ''}` : undefined;
	if (r?.startMin != null && !gateOpen(r.startMin, i.now)) {
		return { canPlay: false, line: `Play at ${time}`, kidPicks: false, lockedText };
	}
	if (daily !== null) {
		if (extrasFor(i.today, i.now).unlimited) return { canPlay: true, line: 'No time limit today', kidPicks: false, lockedText };
		const s = resolveSession(i.session, null, i.rules, i.today, i.now)!;
		const left = Math.ceil((s.limitMs - s.playedMs) / 60_000);
		if (s.frozenAt !== null || left <= 0) {
			return { canPlay: false, line: `All done for today · play again tomorrow${time ? ` at ${time}` : ''}`, kidPicks: false, lockedText };
		}
		return { canPlay: true, line: `${minutes(left)} left today`, kidPicks: false, lockedText };
	}
	if (i.session && !isStale(i.session, i.now) && i.session.frozenAt !== null) {
		return { canPlay: false, line: "Time's up · ask a parent", kidPicks: false, lockedText };
	}
	return { canPlay: true, line: null, kidPicks: true, lockedText };
}

/** The rules in one plain sentence, for the Parents screen's saved message. */
export function rulesSentence(rules: Rules, now: number): string {
	const how = rules.dailyMin === null ? 'as long as they like' : `${formatDuration(rules.dailyMin)} a day`;
	const when = rules.startMin === null ? 'at any time' : `from ${formatStartTime(rules.startMin, now)}`;
	return `Play ${how}, ${when}.`;
}

/** The Parents screen's "Today" line: how today stands, in the parent's words. */
export function todaySummary(i: StatusInput): string {
	if (i.rules.kind === 'broken') return 'The saved rules are damaged, so play is locked. Save the rules again to fix it.';
	const r = rulesOf(i.rules);
	const daily = r?.dailyMin ?? null;
	const gate = r?.startMin != null && !gateOpen(r.startMin, i.now) ? ` Play opens at ${formatStartTime(r.startMin, i.now)}.` : '';
	if (daily === null) {
		const live = i.session && !isStale(i.session, i.now) ? i.session : null;
		if (live?.frozenAt != null) return `Time's up, play is locked.${gate}`;
		if (live) return `Playing: ${formatDuration(Math.max(1, Math.ceil((live.limitMs - live.playedMs) / 60_000)))} left in this sitting.${gate}`;
		return `No daily limit.${gate}`;
	}
	const ex = extrasFor(i.today, i.now);
	if (ex.unlimited) return `No limit today. Back to ${formatDuration(daily)} tomorrow.${gate}`;
	const s = resolveSession(i.session, null, i.rules, i.today, i.now)!;
	const played = Math.min(Math.floor(s.playedMs / 60_000), daily + ex.extraMin);
	const extra = ex.extraMin > 0 ? ` (${formatDuration(daily)} + ${formatDuration(ex.extraMin)} extra)` : '';
	const done = s.frozenAt !== null || s.playedMs >= s.limitMs ? ' All done for today.' : '';
	return `Played ${formatDuration(played)} of ${formatDuration(daily + ex.extraMin)} today${extra}.${done}${gate}`;
}
