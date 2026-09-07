import { describe, it, expect } from 'vitest';
import {
	activeLimits, canStartNow, doneForToday, formatStartTime, gateOpen, minutesSinceMidnight, resolveWorld, sameLocalDay, sessionInForce,
	type Schedule,
} from './schedule';
import type { PlaytimeSession } from './playtime';
import type { WorldSummary } from '../persistence/adapter';
import { legacyId } from '../persistence/uuid';

const MIN = 60_000;
const H = 60 * MIN;
const at = (d: number, h: number, mi: number, mo = 8) => new Date(2026, mo, d, h, mi).getTime();
const sched = (over: Partial<Schedule> = {}): Schedule => ({
	worldId: 'w1', seed: 42, name: "Noah's World", limitMin: 45, startMin: 420, ...over,
});
const sess = (over: Partial<PlaytimeSession> = {}): PlaytimeSession => ({
	limitMs: 45 * MIN, breakMs: null, playedMs: 0, frozenAt: null, startedAt: at(7, 7, 10), updatedAt: at(7, 7, 10), ...over,
});
const world = (over: Partial<WorldSummary> = {}): WorldSummary => ({
	id: 'w1', seed: 42, name: 'W', createdAt: 0, updatedAt: 0, origin: 'local', ...over,
});

describe('gate', () => {
	it('1. opens exactly at the start minute', () => {
		expect(gateOpen(420, at(7, 6, 59))).toBe(false);
		expect(gateOpen(420, at(7, 7, 0))).toBe(true);
	});
	it('2. uses local time (20:30 Toronto is 00:30 UTC next day)', () => {
		expect(gateOpen(420, at(7, 20, 30))).toBe(true);
		expect(minutesSinceMidnight(at(7, 20, 30))).toBe(1230);
	});
	it('11. spring-forward day still opens at 07:00 local', () => {
		expect(gateOpen(420, new Date(2026, 2, 8, 6, 59).getTime())).toBe(false);
		expect(gateOpen(420, new Date(2026, 2, 8, 7, 0).getTime())).toBe(true);
		expect(minutesSinceMidnight(new Date(2026, 2, 8, 3, 0).getTime())).toBe(180);
	});
});

describe('sameLocalDay', () => {
	it('3. 19:30 and 20:30 Toronto are one local day (two UTC dates)', () => {
		expect(sameLocalDay(at(7, 19, 30), at(7, 20, 30))).toBe(true);
	});
	it('4. 23:59 and 00:01 are different days; so are the same date a month apart', () => {
		expect(sameLocalDay(at(7, 23, 59), at(8, 0, 1))).toBe(false);
		expect(sameLocalDay(new Date(2026, 7, 7, 12, 0).getTime(), new Date(2026, 8, 7, 12, 0).getTime())).toBe(false);
		expect(sameLocalDay(new Date(2025, 8, 7, 12, 0).getTime(), new Date(2026, 8, 7, 12, 0).getTime())).toBe(false);
	});
});

describe('sessionInForce', () => {
	it('5. without a schedule, mirrors the 12-hour stale rule', () => {
		const s = sess();
		expect(sessionInForce(s, null, s.updatedAt + 12 * H - MIN)).toBe(true);
		expect(sessionInForce(s, null, s.updatedAt + 12 * H + MIN)).toBe(false);
	});
	it('6. with a schedule, a 13-hour-old session from today is still in force', () => {
		const s = sess({ playedMs: 45 * MIN, frozenAt: at(7, 7, 55), updatedAt: at(7, 7, 55) });
		expect(sessionInForce(s, sched(), at(7, 20, 55))).toBe(true);
	});
	it("7. with a schedule, a 5-hour-old session from yesterday is not in force (not stale, other day)", () => {
		const s = sess({ startedAt: at(7, 23, 50), updatedAt: at(7, 23, 59) });
		expect(sessionInForce(s, sched(), at(8, 5, 0))).toBe(false);
	});
	it('8. without a schedule, a record written in the future is not in force; with one, the day rule alone decides', () => {
		const s = sess({ updatedAt: at(7, 7, 10) + 10_000 });
		expect(sessionInForce(s, null, at(7, 7, 10))).toBe(false);
		expect(sessionInForce(s, sched(), at(7, 7, 10))).toBe(true);
	});
	it('doneForToday is a frozen, no-break session stamped now', () => {
		const d = doneForToday(45, at(7, 22, 0));
		expect(d).toEqual({ limitMs: 45 * MIN, breakMs: null, playedMs: 45 * MIN, frozenAt: at(7, 22, 0), startedAt: at(7, 22, 0), updatedAt: at(7, 22, 0) });
		expect(sessionInForce(d, sched(), at(7, 23, 0))).toBe(true);
		expect(sessionInForce(d, sched(), at(8, 7, 0))).toBe(false);
	});
	it('formatStartTime renders the minute of the given day', () => {
		expect(formatStartTime(420, at(7, 12, 0))).toMatch(/7:00/);
		expect(formatStartTime(0, at(7, 12, 0))).toMatch(/12:00/);
	});
});

describe('activeLimits', () => {
	it('9. schedule wins and never has a break; options otherwise', () => {
		expect(activeLimits(sched({ limitMin: 30 }), { playLimitMin: 90, playBreakMin: 20 })).toEqual({ limitMin: 30, breakMin: null });
		expect(activeLimits(null, { playLimitMin: null, playBreakMin: 20 })).toEqual({ limitMin: null, breakMin: 20 });
		expect(activeLimits(null, { playLimitMin: 15, playBreakMin: null })).toEqual({ limitMin: 15, breakMin: null });
	});
});

describe('resolveWorld', () => {
	it('10. exact id, legacy id by local seed, not cloud seed, else null', () => {
		expect(resolveWorld(sched(), [world()])?.id).toBe('w1');
		const leg = sched({ worldId: legacyId(42) });
		expect(resolveWorld(leg, [world({ id: 'uuid-9' })])?.id).toBe('uuid-9');
		expect(resolveWorld(leg, [world({ id: 'uuid-9', origin: 'cloud' })])).toBeNull();
		expect(resolveWorld(sched({ worldId: 'nope' }), [world()])).toBeNull();
	});
});

describe('canStartNow', () => {
	it('broken is never startable; closed gate is not; frozen today is not; else yes', () => {
		expect(canStartNow({ kind: 'broken' }, null, at(7, 9, 0))).toBe(false);
		const armed = { kind: 'armed' as const, schedule: sched() };
		expect(canStartNow(armed, null, at(7, 6, 59))).toBe(false);
		expect(canStartNow(armed, null, at(7, 7, 0))).toBe(true);
		const frozen = sess({ playedMs: 45 * MIN, frozenAt: at(7, 7, 55), updatedAt: at(7, 7, 55) });
		expect(canStartNow(armed, frozen, at(7, 9, 0))).toBe(false);
		// A leftover break-mode session whose break is over is still "done" under a schedule.
		const over = sess({ breakMs: 20 * MIN, playedMs: 45 * MIN, frozenAt: at(7, 7, 55), updatedAt: at(7, 7, 55) });
		expect(canStartNow(armed, over, at(7, 9, 0))).toBe(false);
		expect(canStartNow(armed, frozen, at(8, 7, 0))).toBe(true);
		expect(canStartNow({ kind: 'none' }, frozen, at(7, 9, 0))).toBe(true);
	});
});
