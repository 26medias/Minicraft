import { describe, it, expect } from 'vitest';
import { PlayTimer, phaseOf, isStale, type PlaytimeSession } from './playtime';
import { MAX_TICK_CREDIT_MS, STALE_SESSION_MS } from '../data/playtime.data';

const MIN = 60_000;
const T0 = 1_700_000_000_000;

function session(over: Partial<PlaytimeSession> = {}): PlaytimeSession {
	return { limitMs: 30 * MIN, breakMs: 20 * MIN, playedMs: 0, frozenAt: null, updatedAt: T0, ...over };
}

/** Drive one visible tick per second from `from` to `to` (exclusive), collecting events. */
function play(timer: PlayTimer, from: number, to: number, visible = true) {
	const events = [];
	for (let t = from; t < to; t += 1000) events.push(...timer.tick(t, visible));
	return events;
}

describe('phaseOf', () => {
	it('is playing while not frozen', () => {
		expect(phaseOf(session(), T0)).toBe('playing');
	});
	it('is break forever when frozen with no break', () => {
		const s = session({ breakMs: null, frozenAt: T0 });
		expect(phaseOf(s, T0 + 100 * 3_600_000)).toBe('break');
	});
	it('is break until frozenAt + breakMs, then over', () => {
		const s = session({ frozenAt: T0 });
		expect(phaseOf(s, T0 + 20 * MIN - 1)).toBe('break');
		expect(phaseOf(s, T0 + 20 * MIN)).toBe('over');
	});
});

describe('isStale', () => {
	it('is stale after STALE_SESSION_MS since updatedAt', () => {
		expect(isStale(session(), T0 + STALE_SESSION_MS)).toBe(false);
		expect(isStale(session(), T0 + STALE_SESSION_MS + 1)).toBe(true);
	});
	it('is stale when updatedAt is in the future beyond one tick credit', () => {
		expect(isStale(session({ updatedAt: T0 + MAX_TICK_CREDIT_MS }), T0)).toBe(false);
		expect(isStale(session({ updatedAt: T0 + MAX_TICK_CREDIT_MS + 1 }), T0)).toBe(true);
	});
});

describe('PlayTimer play phase', () => {
	it('accrues play time only on visible ticks', () => {
		const timer = new PlayTimer(session(), T0);
		play(timer, T0 + 1000, T0 + 11_000);
		expect(timer.session.playedMs).toBe(10_000);
		play(timer, T0 + 11_000, T0 + 21_000, false);
		expect(timer.session.playedMs).toBe(10_000);
	});

	it('credits at most MAX_TICK_CREDIT_MS for one tick', () => {
		const timer = new PlayTimer(session(), T0);
		timer.tick(T0 + 10 * MIN, true);
		expect(timer.session.playedMs).toBe(MAX_TICK_CREDIT_MS);
	});

	it('adds nothing when the clock goes backwards', () => {
		const timer = new PlayTimer(session(), T0);
		timer.tick(T0 + 1000, true);
		timer.tick(T0 - 5 * MIN, true);
		expect(timer.session.playedMs).toBe(1000);
		// Ticks resume from the new clock; the next second credits one second.
		timer.tick(T0 - 5 * MIN + 1000, true);
		expect(timer.session.playedMs).toBe(2000);
	});

	it('sets dirty and updatedAt only on ticks that changed something', () => {
		const timer = new PlayTimer(session(), T0);
		timer.tick(T0, true);
		expect(timer.dirty).toBe(false);
		timer.tick(T0 + 1000, true);
		expect(timer.dirty).toBe(true);
		expect(timer.session.updatedAt).toBe(T0 + 1000);
		timer.tick(T0 + 2000, false);
		expect(timer.dirty).toBe(false);
	});

	it('remainingMs never goes below zero', () => {
		const timer = new PlayTimer(session({ playedMs: 31 * MIN }), T0);
		expect(timer.remainingMs()).toBe(0);
	});
});

describe('PlayTimer warnings', () => {
	it('fires warn(5) then warn(2) once each at the thresholds', () => {
		const timer = new PlayTimer(session({ playedMs: 24 * MIN }), T0);
		const events = play(timer, T0, T0 + 5 * MIN);
		expect(events).toEqual([
			{ type: 'warn', minutesLeft: 5 },
			{ type: 'warn', minutesLeft: 2 },
		]);
	});

	it('fires only the lowest crossed threshold on the first tick', () => {
		const timer = new PlayTimer(session({ playedMs: 30 * MIN - 90_000 }), T0);
		expect(timer.tick(T0, true)).toEqual([{ type: 'warn', minutesLeft: 2 }]);
		expect(play(timer, T0 + 1000, T0 + 60_000)).toEqual([]);
	});

	it('announces once when both thresholds are crossed by the same tick', () => {
		// Reachable only on a resume (each tick credits at most 2 s); the session is
		// mutated directly to reach the state, which is what a resume looks like.
		const timer = new PlayTimer(session({ playedMs: 24 * MIN }), T0);
		timer.session.playedMs = 29 * MIN;
		expect(timer.tick(T0 + 1000, false)).toEqual([{ type: 'warn', minutesLeft: 1 }]);
		expect(play(timer, T0 + 2000, T0 + 30_000)).toEqual([]);
	});

	it('rounds up: 3 min 20 s left says 4', () => {
		const timer = new PlayTimer(session({ playedMs: 30 * MIN - 200_000 }), T0);
		expect(timer.tick(T0, true)).toEqual([{ type: 'warn', minutesLeft: 4 }]);
	});

	it('reports at least 1 minute', () => {
		const timer = new PlayTimer(session({ playedMs: 30 * MIN - 500 }), T0);
		expect(timer.tick(T0, true)).toEqual([{ type: 'warn', minutesLeft: 1 }]);
	});
});

describe('PlayTimer freeze and break', () => {
	it('fires freeze exactly once when play time reaches the limit, with no warn on that tick', () => {
		const timer = new PlayTimer(session({ playedMs: 30 * MIN - 1000 }), T0);
		timer.tick(T0, true); // warn(1)
		const events = timer.tick(T0 + 1000, true);
		expect(events).toEqual([{ type: 'freeze', breakEndsAt: T0 + 1000 + 20 * MIN }]);
		expect(timer.session.frozenAt).toBe(T0 + 1000);
		expect(timer.dirty).toBe(true);
		expect(timer.tick(T0 + 2000, true)).toEqual([]);
		expect(timer.phase()).toBe('break');
	});

	it('fires freeze on the first tick when constructed already frozen', () => {
		const timer = new PlayTimer(session({ playedMs: 30 * MIN, frozenAt: T0 - 5 * MIN }), T0);
		expect(timer.tick(T0, true)).toEqual([{ type: 'freeze', breakEndsAt: T0 + 15 * MIN }]);
		expect(timer.breakRemainingMs()).toBe(15 * MIN);
	});

	it('freezes with breakEndsAt null and never fires break-over when there is no break', () => {
		const timer = new PlayTimer(session({ breakMs: null, playedMs: 30 * MIN }), T0);
		expect(timer.tick(T0, true)).toEqual([{ type: 'freeze', breakEndsAt: null }]);
		expect(play(timer, T0 + 1000, T0 + 2 * 3_600_000)).toEqual([]);
		expect(timer.phase()).toBe('break');
		expect(timer.breakRemainingMs()).toBe(Infinity);
	});

	it('fires break-over exactly once when the break ends', () => {
		const timer = new PlayTimer(session({ playedMs: 30 * MIN, frozenAt: T0 }), T0);
		timer.tick(T0, true);
		expect(play(timer, T0 + 1000, T0 + 20 * MIN)).toEqual([]);
		expect(timer.tick(T0 + 20 * MIN, true)).toEqual([{ type: 'break-over' }]);
		expect(timer.tick(T0 + 20 * MIN + 1000, true)).toEqual([]);
		expect(timer.phase()).toBe('over');
	});

	it('fires [freeze, break-over] in one tick when constructed past the break end', () => {
		const timer = new PlayTimer(session({ playedMs: 30 * MIN, frozenAt: T0 - 25 * MIN }), T0);
		expect(timer.tick(T0, true)).toEqual([
			{ type: 'freeze', breakEndsAt: T0 - 5 * MIN },
			{ type: 'break-over' },
		]);
	});

	it('does not accrue play time while frozen', () => {
		const timer = new PlayTimer(session({ playedMs: 30 * MIN, frozenAt: T0 }), T0);
		play(timer, T0, T0 + 10_000);
		expect(timer.session.playedMs).toBe(30 * MIN);
	});

	it('re-anchors the break when the clock is set back so the countdown stays honest', () => {
		const timer = new PlayTimer(session({ playedMs: 30 * MIN, frozenAt: T0 }), T0);
		timer.tick(T0, true);
		timer.tick(T0 + 19 * MIN, true);
		expect(timer.breakRemainingMs()).toBe(1 * MIN);
		timer.tick(T0 + 5 * MIN, true); // clock set back 14 minutes
		expect(timer.breakRemainingMs()).toBe(1 * MIN);
		expect(timer.session.frozenAt).toBe(T0 - 14 * MIN);
		expect(timer.dirty).toBe(true);
		expect(timer.phase()).toBe('break');
		// One more minute on the new clock and the break is over, not 15 minutes later.
		expect(play(timer, T0 + 5 * MIN + 1000, T0 + 6 * MIN)).toEqual([]);
		expect(timer.tick(T0 + 6 * MIN, true)).toEqual([{ type: 'break-over' }]);
	});
});

describe('PlayTimer full sequence', () => {
	it('warns at 25 and 28 minutes, freezes at 30, break-over at 50', () => {
		const timer = new PlayTimer(session(), T0);
		const events = play(timer, T0, T0 + 51 * MIN);
		expect(events).toEqual([
			{ type: 'warn', minutesLeft: 5 },
			{ type: 'warn', minutesLeft: 2 },
			{ type: 'freeze', breakEndsAt: T0 + 30 * MIN + 20 * MIN },
			{ type: 'break-over' },
		]);
	});
});
