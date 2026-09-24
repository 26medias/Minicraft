import { describe, it, expect } from 'vitest';
import { PlayTimer, phaseOf, isStale, type PlaytimeSession } from './playtime';
import { MAX_TICK_CREDIT_MS, STALE_SESSION_MS } from '../data/playtime.data';

const MIN = 60_000;
const T0 = 1_700_000_000_000;

function session(over: Partial<PlaytimeSession> = {}): PlaytimeSession {
	return { limitMs: 30 * MIN, breakMs: null, playedMs: 0, frozenAt: null, startedAt: T0, updatedAt: T0, ...over };
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
	it('is break forever once frozen (no break ever ends)', () => {
		const s = session({ frozenAt: T0 });
		expect(phaseOf(s, T0)).toBe('break');
		expect(phaseOf(s, T0 + 20 * MIN)).toBe('break');
		expect(phaseOf(s, T0 + 100 * 3_600_000)).toBe('break');
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

describe('PlayTimer freeze (no break time)', () => {
	it('fires freeze exactly once when play time reaches the limit, with no warn on that tick', () => {
		const timer = new PlayTimer(session({ playedMs: 30 * MIN - 1000 }), T0);
		timer.tick(T0, true); // warn(1)
		const events = timer.tick(T0 + 1000, true);
		expect(events).toEqual([{ type: 'freeze' }]);
		expect(timer.session.frozenAt).toBe(T0 + 1000);
		expect(timer.dirty).toBe(true);
		expect(timer.tick(T0 + 2000, true)).toEqual([]);
		expect(timer.phase()).toBe('break');
	});

	it('fires freeze on the first tick when constructed already frozen', () => {
		const timer = new PlayTimer(session({ playedMs: 30 * MIN, frozenAt: T0 - 5 * MIN }), T0);
		expect(timer.tick(T0, true)).toEqual([{ type: 'freeze' }]);
	});

	it('a freeze stays frozen: no further event for hours, phase stays break', () => {
		const timer = new PlayTimer(session({ playedMs: 30 * MIN }), T0);
		expect(timer.tick(T0, true)).toEqual([{ type: 'freeze' }]);
		expect(play(timer, T0 + 1000, T0 + 2 * 3_600_000)).toEqual([]);
		expect(timer.phase()).toBe('break');
		expect(timer.session.frozenAt).toBe(T0);
	});

	it('constructed frozen long ago fires only freeze (there is no break-over)', () => {
		const timer = new PlayTimer(session({ playedMs: 30 * MIN, frozenAt: T0 - 25 * MIN }), T0);
		expect(timer.tick(T0, true)).toEqual([{ type: 'freeze' }]);
		expect(timer.phase()).toBe('break');
	});

	it('does not accrue play time while frozen', () => {
		const timer = new PlayTimer(session({ playedMs: 30 * MIN, frozenAt: T0 }), T0);
		play(timer, T0, T0 + 10_000);
		expect(timer.session.playedMs).toBe(30 * MIN);
	});

	it('a clock set back while frozen stays frozen and fires nothing', () => {
		const timer = new PlayTimer(session({ playedMs: 30 * MIN, frozenAt: T0 }), T0);
		timer.tick(T0, true);
		timer.tick(T0 + 19 * MIN, true);
		expect(timer.tick(T0 + 5 * MIN, true)).toEqual([]); // clock set back 14 minutes
		expect(play(timer, T0 + 5 * MIN + 1000, T0 + 60 * MIN)).toEqual([]);
		expect(timer.phase()).toBe('break');
		expect(timer.session.playedMs).toBe(30 * MIN);
	});
});

describe('PlayTimer full sequence', () => {
	it('warns at 25 and 28 minutes, freezes at 30, and stays frozen', () => {
		const timer = new PlayTimer(session(), T0);
		const events = play(timer, T0, T0 + 51 * MIN);
		expect(events).toEqual([
			{ type: 'warn', minutesLeft: 5 },
			{ type: 'warn', minutesLeft: 2 },
			{ type: 'freeze' },
		]);
		expect(timer.phase()).toBe('break');
	});
});

describe('remainingAt (plan I2, E5: the leaver\'s big 10…1 is drawn per frame)', () => {
	it('is the time left as if a visible tick ran at `now`, capped like a tick, never below 0', () => {
		const t = new PlayTimer(session({ limitMs: 20_000, playedMs: 5_000 }), T0);
		expect(t.remainingAt(T0)).toBe(15_000);
		expect(t.remainingAt(T0 + 400)).toBe(14_600);
		expect(t.remainingAt(T0 + 60_000)).toBe(15_000 - MAX_TICK_CREDIT_MS);
		expect(t.remainingAt(T0 - 500)).toBe(15_000);
		t.tick(T0 + 1000, true);
		expect(t.remainingAt(T0 + 1000)).toBe(14_000);
		expect(t.remainingAt(T0 + 1250)).toBe(13_750);
		const done = new PlayTimer(session({ limitMs: 20_000, playedMs: 19_900 }), T0);
		expect(done.remainingAt(T0 + 1500)).toBe(0);
	});

	it('is 0 once frozen', () => {
		const t = new PlayTimer(session({ limitMs: 20_000, playedMs: 20_000, frozenAt: T0 }), T0);
		expect(t.remainingAt(T0 + 300)).toBe(0);
	});

	/** Ticks every 1000 ms ± `jitter` (a busy main thread), frames every `frameMs`; the seconds shown in the last 10 s. */
	function shown(jitter: number, frameMs: number, perFrame: boolean): number[] {
		let seed = 12345;
		const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
		const t = new PlayTimer(session({ limitMs: 60_000, playedMs: 60_000 - 12_300 }), T0);
		const out: number[] = [];
		let nextTick = T0 + 1000;
		for (let now = T0; now < T0 + 20_000; now += frameMs) {
			if (now >= nextTick) {
				t.tick(now, true);
				nextTick += 1000 + (rnd() * 2 - 1) * jitter;
			}
			const s = Math.ceil((perFrame ? t.remainingAt(now) : t.remainingMs()) / 1000);
			if (s >= 1 && s <= 10 && out[out.length - 1] !== s) out.push(s);
		}
		return out;
	}

	it('drawn per frame from remainingAt, every second 10…1 shows once, in order, even with jittery ticks', () => {
		for (const [jitter, frame] of [[0, 16], [400, 16], [400, 250], [900, 100]]) {
			expect(shown(jitter, frame, true), `jitter ${jitter} ms, frames every ${frame} ms`).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
		}
	});

	it('instrument check: drawn from the tick value alone, jittery ticks skip seconds (what E5 caught)', () => {
		expect(shown(400, 16, false)).not.toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
	});
});
