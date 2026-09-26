import { describe, it, expect } from 'vitest';
import {
	planAllows, planKey, countdownText, formatWhen, nextStartAt, planPhase, planSentence, planSummary, playStatus, resolveSession,
	type LoadedPlan, type Plan,
} from './plan';
import type { PlaytimeSession } from './playtime';
import { STALE_SESSION_MS } from '../data/playtime.data';

const MIN = 60_000;
/** 2026-09-07 at hh:mm, local time. */
const at = (h: number, m = 0, day = 7) => new Date(2026, 8, day, h, m).getTime();
const none: LoadedPlan = { kind: 'none' };
const broken: LoadedPlan = { kind: 'broken' };
const plan = (over: Partial<Plan> = {}): Plan => ({
	id: 'p1', mode: 'solo', worldId: 'w1', worldName: 'Big Crafting', startAt: at(7), limitMin: 45, extraMin: 0, createdAt: at(21, 0, 6), ...over,
});
const set = (over: Partial<Plan> = {}): LoadedPlan => ({ kind: 'set', plan: plan(over) });
function session(over: Partial<PlaytimeSession> = {}): PlaytimeSession {
	return { limitMs: 45 * MIN, breakMs: null, playedMs: 0, frozenAt: null, startedAt: at(7, 5), updatedAt: at(7, 5), planId: 'p1', ...over };
}

describe('resolveSession under a plan', () => {
	it('nothing stored → a new session of the plan\'s minutes; the kid\'s choice is ignored', () => {
		expect(resolveSession(null, 10, set(), at(7, 1))).toEqual({
			limitMs: 45 * MIN, breakMs: null, playedMs: 0, frozenAt: null, startedAt: at(7, 1), updatedAt: at(7, 1), planId: 'p1',
		});
	});
	it('the plan\'s session carries its played time across reloads', () => {
		const got = resolveSession(session({ playedMs: 20 * MIN }), null, set(), at(9))!;
		expect(got.playedMs).toBe(20 * MIN);
		expect(got.frozenAt).toBeNull();
	});
	it("another plan's session, or a free-play one, never counts", () => {
		const old = session({ planId: 'p0', playedMs: 45 * MIN, frozenAt: at(6, 45) });
		expect(resolveSession(session({ planId: undefined, playedMs: 45 * MIN, frozenAt: at(6) }), null, set(), at(7, 1))!.playedMs).toBe(0);
		const got = resolveSession(old, null, set(), at(7, 1))!;
		expect(got.playedMs).toBe(0);
		expect(got.frozenAt).toBeNull();
	});
	it('used up → locked; +15 unfreezes with 15 minutes', () => {
		const done = session({ playedMs: 45 * MIN, frozenAt: at(8) });
		expect(resolveSession(done, null, set(), at(9))!.frozenAt).toBe(at(8));
		const more = resolveSession(done, null, set({ extraMin: 15 }), at(9))!;
		expect(more.frozenAt).toBeNull();
		expect(more.limitMs).toBe(60 * MIN);
	});
	it('broken plan → an already-locked session', () => {
		expect(resolveSession(null, 30, broken, at(9))!.frozenAt).toBe(at(9));
	});
});

describe('resolveSession without a plan (free play)', () => {
	const T0 = at(9);
	it('the chosen duration, the stored session while fresh, No limit → no timer', () => {
		expect(resolveSession(null, 30, none, T0)!.limitMs).toBe(30 * MIN);
		expect(resolveSession(null, null, none, T0)).toBeNull();
		const stored = session({ startedAt: T0, updatedAt: T0, playedMs: 10 * MIN, limitMs: 30 * MIN, planId: undefined });
		expect(resolveSession(stored, null, none, T0 + MIN)).toEqual(stored);
		expect(resolveSession(stored, null, none, T0 + STALE_SESSION_MS + 1)).toBeNull();
	});
	it("a plan's leftover session never follows into free play", () => {
		const leftover = session({ startedAt: T0, updatedAt: T0, playedMs: 45 * MIN, frozenAt: T0 });
		expect(resolveSession(leftover, null, none, T0 + MIN)).toBeNull();
		expect(playStatus({ plan: none, session: leftover, now: T0 + MIN }).canPlay).toBe(true);
	});
});

describe('planPhase', () => {
	it('wait before the start, play after, done once used up', () => {
		expect(planPhase(plan(), null, at(5))).toBe('wait');
		expect(planPhase(plan(), null, at(7))).toBe('play');
		expect(planPhase(plan(), session({ playedMs: 44 * MIN }), at(9))).toBe('play');
		expect(planPhase(plan(), session({ playedMs: 45 * MIN, frozenAt: at(8) }), at(9))).toBe('done');
		expect(planPhase(plan({ extraMin: 15 }), session({ playedMs: 45 * MIN, frozenAt: at(8) }), at(9))).toBe('play');
	});
	it('the lock is sticky: done stays done the next day', () => {
		expect(planPhase(plan(), session({ playedMs: 45 * MIN, frozenAt: at(8) }), at(9, 0, 9))).toBe('done');
	});
	it('unused minutes die with the start day (no 5 am leftovers)', () => {
		expect(planPhase(plan(), session({ playedMs: 20 * MIN }), at(23, 59))).toBe('play');
		expect(planPhase(plan(), session({ playedMs: 20 * MIN }), at(5, 0, 8))).toBe('done');
		expect(resolveSession(session({ playedMs: 20 * MIN }), null, set(), at(5, 0, 8))!.frozenAt).not.toBeNull();
	});
});

describe('playStatus', () => {
	const st = (loaded: LoadedPlan, s: PlaytimeSession | null, now: number) => playStatus({ plan: loaded, session: s, now });
	it('no plan: free play, the kid picks', () => {
		expect(st(none, null, at(5))).toMatchObject({ canPlay: true, line: null, kidPicks: true, freezeTitle: undefined });
	});
	it('wait: locked, with the start time and a coarse countdown', () => {
		const got = st(set(), null, at(4, 50));
		expect(got.canPlay).toBe(false);
		expect(got.line).toMatch(/^Not yet · play at 7:00.* · in 2 hours$/);
		expect(got.kidPicks).toBe(false);
	});
	it('play: minutes left', () => {
		expect(st(set(), session({ playedMs: 20 * MIN }), at(9))).toMatchObject({ canPlay: true, line: '25 minutes left', phase: 'play' });
	});
	it('done: locked, friendly, and the freeze says so', () => {
		expect(st(set(), session({ playedMs: 45 * MIN, frozenAt: at(8) }), at(9))).toMatchObject({
			canPlay: false, line: 'All done! · your world is saved', freezeTitle: 'ALL DONE!', lockedText: 'GREAT BUILDING · YOUR WORLD IS SAVED',
		});
	});
	it('broken: locked', () => {
		expect(st(broken, null, at(9))).toMatchObject({ canPlay: false, phase: 'broken' });
	});
	it('free play with a frozen sitting: time is up until a parent resets', () => {
		const s = session({ startedAt: at(9), updatedAt: at(9), frozenAt: at(9), planId: undefined });
		expect(st(none, s, at(9, 5))).toMatchObject({ canPlay: false, line: "Time's up · ask a parent" });
	});
});

describe('times and words', () => {
	it('nextStartAt: later today, else tomorrow; malformed → null', () => {
		expect(nextStartAt('07:00', at(5))).toBe(at(7));
		expect(nextStartAt('07:00', at(21))).toBe(at(7, 0, 8));
		expect(nextStartAt('07:00', at(7))).toBe(at(7, 0, 8));
		expect(nextStartAt('7:00', at(5))).toBeNull();
		expect(nextStartAt('25:00', at(5))).toBeNull();
	});
	it('countdownText is coarse and never shows seconds', () => {
		expect(countdownText(at(7), at(4, 50))).toBe('in 2 hours');
		expect(countdownText(at(7), at(5, 30))).toBe('in 1 hour');
		expect(countdownText(at(7), at(6, 17))).toBe('in 45 minutes');
		expect(countdownText(at(7), at(6, 50))).toBe('in 10 minutes');
		expect(countdownText(at(7), at(6, 59) + 30_000)).toBe('in 1 minute');
	});
	it('formatWhen and planSentence read like a sentence', () => {
		expect(formatWhen(at(7, 0, 8), at(21))).toMatch(/^tomorrow, 7:00/);
		expect(planSentence({ worldName: 'Big Crafting', startAt: at(7, 0, 8), limitMin: 45 }, at(21))).toMatch(/^Big Crafting · tomorrow, 7:00.* · 45 min$/);
		expect(planSentence({ worldName: null, startAt: at(21), limitMin: 30 }, at(21))).toBe('any world · now · 30 min');
	});
	it('planSummary for the parent', () => {
		expect(planSummary(set(), null, at(5))).toMatch(/^Starts today, 7:00.*, for 45 min\.$/);
		expect(planSummary(set({ extraMin: 15 }), session({ playedMs: 20 * MIN + 30_000 }), at(9))).toBe('Played 20 min of 1 h (45 min + 15 min extra).');
		expect(planSummary(set(), session({ playedMs: 45 * MIN, frozenAt: at(8) }), at(9))).toBe('Played 45 min of 45 min. All done.');
	});
});

describe('planAllows (every way into a game)', () => {
	const i = (loaded: LoadedPlan, now = at(9), s: PlaytimeSession | null = null) => ({ plan: loaded, session: s, now });
	it('no plan: anything free play allows', () => {
		expect(planAllows({ mode: 'mp', worldId: 'x' }, i(none))).toBe(true);
	});
	it('a locked solo plan: only that world, only solo, only while playable', () => {
		expect(planAllows({ mode: 'solo', worldId: 'w1' }, i(set()))).toBe(true);
		expect(planAllows({ mode: 'solo', worldId: 'w2' }, i(set()))).toBe(false);
		expect(planAllows({ mode: 'mp', worldId: 'w1' }, i(set()))).toBe(false);
		expect(planAllows({ mode: 'solo', worldId: 'w1' }, i(set(), at(5)))).toBe(false);
		expect(planAllows({ mode: 'solo', worldId: 'w1' }, i(set(), at(9), session({ playedMs: 45 * MIN, frozenAt: at(8) })))).toBe(false);
	});
	it('let him choose: any world of that mode', () => {
		expect(planAllows({ mode: 'mp', worldId: 'any' }, i(set({ mode: 'mp', worldId: null, worldName: null })))).toBe(true);
		expect(planAllows({ mode: 'solo', worldId: 'any' }, i(set({ mode: 'mp', worldId: null, worldName: null })))).toBe(false);
	});
	it('broken: nothing', () => {
		expect(planAllows({ mode: 'solo', worldId: 'w1' }, i(broken))).toBe(false);
	});
});

describe('planKey (what a running game watches)', () => {
	it('changes with a new plan, a Change or the end; not with +15', () => {
		expect(planKey(set())).toBe(planKey(set({ extraMin: 15 })));
		expect(planKey(set())).not.toBe(planKey(set({ id: 'p2' })));
		expect(planKey(set())).not.toBe(planKey(set({ limitMin: 30 })));
		expect(planKey(set())).not.toBe(planKey(set({ startAt: at(8) })));
		expect(planKey(set())).not.toBe(planKey(none));
		expect(planKey(none)).not.toBe(planKey(broken));
	});
});
