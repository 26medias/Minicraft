import {
	MAX_TICK_CREDIT_MS,
	STALE_SESSION_MS,
	WARNING_THRESHOLDS_MS,
} from '../data/playtime.data';

/**
 * The persisted play-time session. Phase is derived from these fields and
 * `now`, never stored. Play time (`playedMs`) counts only visible ticks.
 * There is no break time (spec §8.3): once frozen, a session stays frozen
 * until a new session per the refresh rule (spec §8.1), a Parents reset, or
 * the 12 h stale rule.
 */
export type PlaytimeSession = {
	limitMs: number;
	/** Always null: break time was removed. Kept so stored records keep their shape. */
	breakMs: null;
	playedMs: number;
	/** Wall clock when the limit was hit; null while playing. */
	frozenAt: number | null;
	/** Wall clock when this session was created; under a schedule, the day it belongs to. */
	startedAt: number;
	/** Wall clock of the last write; drives staleness. */
	updatedAt: number;
};

/** 'break' = frozen at the limit; it never ends by itself. */
export type PlaytimePhase = 'playing' | 'break';

export type PlaytimeEvent =
	| { type: 'warn'; minutesLeft: number }
	| { type: 'freeze' };

/** `_now` is kept so callers need not change; with no break time the phase no longer depends on it. */
export function phaseOf(session: PlaytimeSession, _now: number): PlaytimePhase {
	return session.frozenAt === null ? 'playing' : 'break';
}

/**
 * A session untouched for STALE_SESSION_MS is discarded so a lock
 * from last night does not need re-arming every morning. A session written
 * under a clock that has since been set back is garbage too.
 */
export function isStale(session: PlaytimeSession, now: number): boolean {
	return now - session.updatedAt > STALE_SESSION_MS || session.updatedAt > now + MAX_TICK_CREDIT_MS;
}

export class PlayTimer {
	readonly session: PlaytimeSession;
	/** True when the last tick changed something worth persisting. */
	dirty = false;
	private lastNow: number;
	private firedThreshold: boolean[];
	private freezeFired = false;

	constructor(session: PlaytimeSession, now: number) {
		this.session = { ...session };
		this.lastNow = now;
		this.firedThreshold = WARNING_THRESHOLDS_MS.map(() => false);
	}

	/**
	 * Advance to `now`. Play time accrues only when `visible`, by at most
	 * MAX_TICK_CREDIT_MS per call. A `now` earlier than the previous one (clock
	 * set back) adds nothing and never un-fires anything. Returns the events
	 * that fired, in order.
	 */
	tick(now: number, visible: boolean): PlaytimeEvent[] {
		const events: PlaytimeEvent[] = [];
		this.dirty = false;
		const s = this.session;
		const delta = Math.max(0, Math.min(now - this.lastNow, MAX_TICK_CREDIT_MS));
		this.lastNow = now;

		if (s.frozenAt === null) {
			if (visible && delta > 0) {
				s.playedMs = Math.min(s.limitMs, s.playedMs + delta);
				s.updatedAt = now;
				this.dirty = true;
			}
			if (s.playedMs >= s.limitMs) {
				s.frozenAt = now;
				s.updatedAt = now;
				this.dirty = true;
			}
		}

		if (s.frozenAt !== null) {
			if (!this.freezeFired) {
				this.freezeFired = true;
				events.push({ type: 'freeze' });
			}
			return events;
		}

		// Warnings: mark every crossed threshold fired, announce once if any was new.
		const remaining = this.remainingMs();
		let fired = false;
		for (let i = 0; i < WARNING_THRESHOLDS_MS.length; i++) {
			if (remaining <= WARNING_THRESHOLDS_MS[i] && !this.firedThreshold[i]) {
				this.firedThreshold[i] = true;
				fired = true;
			}
		}
		if (fired) {
			events.push({ type: 'warn', minutesLeft: Math.max(1, Math.ceil(remaining / 60_000)) });
		}
		return events;
	}

	phase(): PlaytimePhase {
		return phaseOf(this.session, this.lastNow);
	}

	remainingMs(): number {
		return Math.max(0, this.session.limitMs - this.session.playedMs);
	}

	/**
	 * The time left as if a visible tick ran at `now` (the same MAX_TICK_CREDIT_MS cap), without
	 * changing anything. For a display drawn every frame: the 1 s tick's own value skips a second
	 * whenever the interval runs late (plan I2, E5). 0 once frozen.
	 */
	remainingAt(now: number): number {
		if (this.session.frozenAt !== null) return 0;
		const pending = Math.max(0, Math.min(now - this.lastNow, MAX_TICK_CREDIT_MS));
		return Math.max(0, this.remainingMs() - pending);
	}
}
