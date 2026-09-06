import {
	MAX_TICK_CREDIT_MS,
	STALE_SESSION_MS,
	WARNING_THRESHOLDS_MS,
} from '../data/playtime.data';

/**
 * The persisted play-time session. Phase is derived from these fields and
 * `now`, never stored. Play time (`playedMs`) counts only visible ticks; the
 * break (`frozenAt + breakMs`) is wall clock so closing the tab cannot shorten it.
 */
export type PlaytimeSession = {
	limitMs: number;
	/** null = until a grown-up presses Unlock on the menu. */
	breakMs: number | null;
	playedMs: number;
	/** Wall clock when the limit was hit; null while playing. */
	frozenAt: number | null;
	/** Wall clock of the last write; drives staleness. */
	updatedAt: number;
};

export type PlaytimePhase = 'playing' | 'break' | 'over';

export type PlaytimeEvent =
	| { type: 'warn'; minutesLeft: number }
	| { type: 'freeze'; breakEndsAt: number | null }
	| { type: 'break-over' };

export function phaseOf(session: PlaytimeSession, now: number): PlaytimePhase {
	if (session.frozenAt === null) return 'playing';
	if (session.breakMs === null) return 'break';
	return now < session.frozenAt + session.breakMs ? 'break' : 'over';
}

/**
 * A session untouched for STALE_SESSION_MS is discarded so a no-break lock
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
	private breakOverFired = false;

	constructor(session: PlaytimeSession, now: number) {
		this.session = { ...session };
		this.lastNow = now;
		this.firedThreshold = WARNING_THRESHOLDS_MS.map(() => false);
	}

	/**
	 * Advance to `now`. Play time accrues only when `visible`, by at most
	 * MAX_TICK_CREDIT_MS per call. A `now` earlier than the previous one (clock
	 * set back by Δ) adds nothing and never un-fires anything; a running break
	 * is re-anchored by Δ so its remaining time is unchanged and keeps counting
	 * down. Returns the events that fired, in order.
	 */
	tick(now: number, visible: boolean): PlaytimeEvent[] {
		const events: PlaytimeEvent[] = [];
		this.dirty = false;
		const s = this.session;
		const raw = now - this.lastNow;
		const delta = Math.max(0, Math.min(raw, MAX_TICK_CREDIT_MS));
		if (raw < 0 && s.frozenAt !== null) {
			// Clock went back: shift the break anchor with it. A monotonic clamp
			// would instead freeze the countdown for as long as the jump.
			s.frozenAt += raw;
			s.updatedAt = now;
			this.dirty = true;
		}
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
				events.push({
					type: 'freeze',
					breakEndsAt: s.breakMs === null ? null : s.frozenAt + s.breakMs,
				});
			}
			if (s.breakMs !== null && !this.breakOverFired && now >= s.frozenAt + s.breakMs) {
				this.breakOverFired = true;
				events.push({ type: 'break-over' });
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

	/** Break time left as of the last tick; Infinity when there is no break or no freeze yet. */
	breakRemainingMs(): number {
		const s = this.session;
		if (s.frozenAt === null || s.breakMs === null) return Infinity;
		return Math.max(0, s.frozenAt + s.breakMs - this.lastNow);
	}
}
