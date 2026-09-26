import { describe, it, expect } from 'vitest';
import {
	dayChanged, dayKey, playStatus, resolveSession, rulesChangeClearsSession, rulesSentence, todaySummary,
	type LoadedRules, type Today,
} from './rules';
import type { PlaytimeSession } from './playtime';
import { STALE_SESSION_MS } from '../data/playtime.data';

const MIN = 60_000;
const T0 = 1_700_000_000_000;
const none: LoadedRules = { kind: 'none' };
const broken: LoadedRules = { kind: 'broken' };
const rules = (startMin: number | null, dailyMin: number | null): LoadedRules => ({ kind: 'set', rules: { startMin, dailyMin } });
/** 2026-09-07 at hh:mm, local time. */
const at = (h: number, m = 0, day = 7) => new Date(2026, 8, day, h, m).getTime();
const today = (now: number, extraMin = 0, unlimited = false): Today => ({ day: dayKey(now), extraMin, unlimited });

function session(over: Partial<PlaytimeSession> = {}): PlaytimeSession {
	return { limitMs: 30 * MIN, breakMs: null, playedMs: 0, frozenAt: null, updatedAt: T0, startedAt: T0, ...over };
}

describe('resolveSession without a daily limit (the kid picks)', () => {
	it('creates a fresh session from the chosen duration when nothing is stored', () => {
		expect(resolveSession(null, 30, none, null, T0)).toEqual(session());
	});
	it('No limit and nothing stored → no timer', () => {
		expect(resolveSession(null, null, none, null, T0)).toBeNull();
		expect(resolveSession(session({ playedMs: 5 * MIN }), null, none, null, T0 + STALE_SESSION_MS + 1)).toBeNull();
	});
	it('a stored session wins over the chosen duration, No limit included', () => {
		const stored = session({ playedMs: 10 * MIN });
		expect(resolveSession(stored, 15, none, null, T0 + MIN)).toEqual(stored);
		expect(resolveSession(stored, null, none, null, T0 + MIN)).toEqual(stored);
		const frozen = session({ playedMs: 30 * MIN, frozenAt: T0 });
		expect(resolveSession(frozen, null, none, null, T0 + 3 * 60 * MIN)).toEqual(frozen);
	});
	it('a stale session is replaced', () => {
		const now = T0 + STALE_SESSION_MS + 1;
		expect(resolveSession(session({ playedMs: 5 * MIN }), 30, none, null, now)).toEqual(session({ updatedAt: now, startedAt: now }));
	});
	it('a start time alone does not make the session per day', () => {
		const stored = session({ playedMs: 10 * MIN });
		expect(resolveSession(stored, 30, rules(420, null), null, T0 + MIN)).toEqual(stored);
	});
	it('broken rules → a locked session (fails closed even past the menu gate)', () => {
		expect(resolveSession(null, 30, broken, null, T0)!.frozenAt).toBe(T0);
		expect(resolveSession(null, null, broken, null, T0)!.frozenAt).toBe(T0);
	});
});

describe('resolveSession under a daily limit', () => {
	const r = rules(420, 45);
	it('nothing stored → a new session of the daily minutes; the kid\'s choice is ignored', () => {
		const now = at(8);
		expect(resolveSession(null, 10, r, null, now)).toEqual({
			limitMs: 45 * MIN, breakMs: null, playedMs: 0, frozenAt: null, startedAt: now, updatedAt: now,
		});
	});
	it("today's session carries its played time, even 13 hours later (no per-sitting refill)", () => {
		const s = session({ startedAt: at(7, 10), updatedAt: at(7, 40), playedMs: 30 * MIN });
		const got = resolveSession(s, null, r, null, at(20, 40))!;
		expect(got.playedMs).toBe(30 * MIN);
		expect(got.limitMs).toBe(45 * MIN);
		expect(got.frozenAt).toBeNull();
	});
	it("a used-up day stays locked", () => {
		const s = session({ startedAt: at(7, 10), playedMs: 45 * MIN, frozenAt: at(8) });
		expect(resolveSession(s, null, r, null, at(12))!.frozenAt).toBe(at(8));
	});
	it("yesterday's session is ignored", () => {
		const s = session({ startedAt: at(7, 10, 6), playedMs: 45 * MIN, frozenAt: at(8, 0, 6) });
		const got = resolveSession(s, null, r, null, at(7, 5))!;
		expect(got.playedMs).toBe(0);
		expect(got.frozenAt).toBeNull();
	});
	it('+15 min today unfreezes a used-up day with 15 minutes', () => {
		const now = at(12);
		const s = session({ startedAt: at(7, 10), playedMs: 45 * MIN, frozenAt: at(8) });
		const got = resolveSession(s, null, r, today(now, 15), now)!;
		expect(got.limitMs).toBe(60 * MIN);
		expect(got.frozenAt).toBeNull();
	});
	it("yesterday's extras do not count", () => {
		const s = session({ startedAt: at(7, 10), playedMs: 45 * MIN, frozenAt: at(8) });
		expect(resolveSession(s, null, r, today(at(12, 0, 6), 15), at(12))!.frozenAt).toBe(at(8));
	});
	it('No limit today → an unfrozen day-long timer (so the day change can still stop the game)', () => {
		const now = at(12);
		const s = session({ startedAt: at(7, 10), playedMs: 45 * MIN, frozenAt: at(8) });
		const got = resolveSession(s, null, r, today(now, 0, true), now)!;
		expect(got.frozenAt).toBeNull();
		expect(got.limitMs).toBeGreaterThanOrEqual(24 * 60 * MIN);
		expect(got.playedMs).toBe(45 * MIN);
	});
	it('a new daily limit applies to the time already played today', () => {
		const s = session({ startedAt: at(7, 10), playedMs: 30 * MIN, limitMs: 60 * MIN });
		const got = resolveSession(s, null, rules(null, 20), null, at(9))!;
		expect(got.limitMs).toBe(20 * MIN);
		expect(got.frozenAt).toBe(at(9));
	});
});

describe('playStatus', () => {
	const st = (loaded: LoadedRules, s: PlaytimeSession | null, now: number, t: Today | null = null) =>
		playStatus({ rules: loaded, session: s, today: t, now });
	it('no rules: the kid picks, nothing to say', () => {
		expect(st(none, null, at(5))).toMatchObject({ canPlay: true, line: null, kidPicks: true, lockedText: undefined });
	});
	it('broken rules lock', () => {
		expect(st(broken, null, at(12))).toMatchObject({ canPlay: false, kidPicks: false });
	});
	it('before the start time: locked with the time', () => {
		const got = st(rules(420, null), null, at(5));
		expect(got.canPlay).toBe(false);
		expect(got.line).toMatch(/^Play at 7:00/);
	});
	it('after the start time with no daily limit: the kid picks', () => {
		expect(st(rules(420, null), null, at(7))).toMatchObject({ canPlay: true, kidPicks: true });
	});
	it('daily limit: minutes left today', () => {
		const s = session({ startedAt: at(7, 10), playedMs: 30 * MIN });
		expect(st(rules(420, 45), s, at(9))).toMatchObject({ canPlay: true, line: '15 minutes left today', kidPicks: false });
		expect(st(rules(420, 45), null, at(9)).line).toBe('45 minutes left today');
	});
	it('daily limit used up: all done, and Play is refused (no green Play that leads to TIME\'S UP)', () => {
		const s = session({ startedAt: at(7, 10), playedMs: 45 * MIN, frozenAt: at(8) });
		const got = st(rules(420, 45), s, at(9));
		expect(got.canPlay).toBe(false);
		expect(got.line).toMatch(/^All done for today · play again tomorrow at 7:00/);
		expect(got.lockedText).toMatch(/^PLAY AGAIN TOMORROW AT 7:00/);
	});
	it('daily limit and no start time: "play again tomorrow"', () => {
		const s = session({ startedAt: at(7, 10), playedMs: 45 * MIN, frozenAt: at(8) });
		expect(st(rules(null, 45), s, at(9)).line).toBe('All done for today · play again tomorrow');
		expect(st(rules(null, 45), s, at(9)).lockedText).toBe('PLAY AGAIN TOMORROW');
	});
	it('No limit today', () => {
		expect(st(rules(420, 45), null, at(9), today(at(9), 0, true))).toMatchObject({ canPlay: true, line: 'No time limit today' });
	});
	it('no daily limit, a frozen sitting: time is up until a parent resets', () => {
		const s = session({ updatedAt: at(9), playedMs: 30 * MIN, frozenAt: at(9) });
		expect(st(none, s, at(9, 5))).toMatchObject({ canPlay: false, line: "Time's up · ask a parent" });
	});
});

describe('rulesSentence and todaySummary', () => {
	it('say the rules in plain words', () => {
		expect(rulesSentence({ startMin: null, dailyMin: null }, at(9))).toBe('Play as long as they like, at any time.');
		expect(rulesSentence({ startMin: 420, dailyMin: 45 }, at(9))).toMatch(/^Play 45 min a day, from 7:00/);
		expect(rulesSentence({ startMin: null, dailyMin: 90 }, at(9))).toBe('Play 1 h 30 min a day, at any time.');
	});
	it('today, under a daily limit', () => {
		const s = session({ startedAt: at(7, 10), playedMs: 20 * MIN + 30_000 });
		const sum = (t: Today | null) => todaySummary({ rules: rules(null, 45), session: s, today: t, now: at(9) });
		expect(sum(null)).toBe('Played 20 min of 45 min today.');
		expect(sum(today(at(9), 15))).toBe('Played 20 min of 1 h today (45 min + 15 min extra).');
		expect(sum(today(at(9), 0, true))).toBe('No limit today. Back to 45 min tomorrow.');
	});
	it('today, used up', () => {
		const s = session({ startedAt: at(7, 10), playedMs: 45 * MIN, frozenAt: at(8) });
		expect(todaySummary({ rules: rules(null, 45), session: s, today: null, now: at(9) })).toBe('Played 45 min of 45 min today. All done for today.');
	});
	it('before the start time, it says when play opens', () => {
		expect(todaySummary({ rules: rules(420, 45), session: null, today: null, now: at(5) })).toMatch(/^Played 0 min of 45 min today\. Play opens at 7:00/);
	});
});

describe('rule changes and the day change', () => {
	it('lifting the daily limit clears the day\'s session; other saves do not', () => {
		expect(rulesChangeClearsSession(rules(420, 30), { startMin: 420, dailyMin: null })).toBe(true);
		expect(rulesChangeClearsSession(broken, { startMin: null, dailyMin: null })).toBe(true);
		expect(rulesChangeClearsSession(rules(420, 30), { startMin: 420, dailyMin: 45 })).toBe(false);
		expect(rulesChangeClearsSession(rules(420, null), { startMin: 480, dailyMin: null })).toBe(false);
		expect(rulesChangeClearsSession(none, { startMin: null, dailyMin: null })).toBe(false);
	});
	it('after the clear, a used-up day under a lifted limit lets the kid pick again', () => {
		// The scenario both reviews hit: 30 min a day used up, then "No limit" per day.
		expect(playStatus({ rules: rules(null, null), session: null, today: null, now: at(9) })).toMatchObject({ canPlay: true, kidPicks: true });
	});
	it('a game under rules stops when the local day changes; without rules it does not', () => {
		const start = dayKey(at(23, 50));
		expect(dayChanged(rules(420, 45), start, at(23, 59))).toBe(false);
		expect(dayChanged(rules(420, 45), start, at(0, 1, 8))).toBe(true);
		expect(dayChanged(rules(420, null), start, at(0, 1, 8))).toBe(true);
		expect(dayChanged(broken, start, at(0, 1, 8))).toBe(true);
		expect(dayChanged(none, start, at(0, 1, 8))).toBe(false);
	});
});
