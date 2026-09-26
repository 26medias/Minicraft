import { WARNING_SHOW_MS } from '../data/playtime.data';
import { PlayTimer, type PlaytimeSession } from './playtime';

export type PlaytimeOverlayLike = {
	warn(text: string, ms: number): void;
	freeze(lockedText?: string): void;
	unfreeze(): void;
};

export type PlaytimeDeps = {
	overlay: PlaytimeOverlayLike;
	/** Pause the loop, clear input, release pointer lock, flush autosave. */
	freeze(): void;
	/** Unpause the loop, clear input, request pointer lock. */
	resume(): void;
	save(s: PlaytimeSession): void;
	now(): number;
	visible(): boolean;
	/** Shown instead of ASK A PARENT on a freeze (under a daily limit). */
	lockedText?: string;
	/** Checked every tick: a text means "stop now" (the day changed under parent rules). */
	expired?: () => string | null;
};

/**
 * Drives a PlayTimer from a 1 s interval and turns its events into overlay
 * and game calls. Pure orchestration: no DOM, no storage, so the dispatch
 * rules can be unit-tested with fake deps.
 */
export class PlaytimeController {
	private timer: PlayTimer;
	private expiredFired = false;

	constructor(
		session: PlaytimeSession,
		private deps: PlaytimeDeps,
	) {
		this.timer = new PlayTimer(session, deps.now());
	}

	/** Play time left in this session (0 once frozen). */
	remainingMs(): number {
		return this.timer.remainingMs();
	}

	/** The time left at `now`, between ticks (see PlayTimer.remainingAt): for a per-frame display. */
	remainingAt(now: number): number {
		return this.timer.remainingAt(now);
	}

	/**
	 * DEV oracle (plan I1, E5): set the time left to `ms` on the live session, then tick. No fast
	 * clock: the rest runs in real time.
	 */
	setRemaining(ms: number): void {
		const s = this.timer.session;
		s.playedMs = Math.max(0, Math.min(s.limitMs, s.limitMs - ms));
		this.deps.save(s);
		this.tick();
	}

	/** Never throws: an exception would kill the interval and the whole limit. */
	tick(): void {
		try {
			this.tickUnsafe();
		} catch (e) {
			console.error('playtime tick failed', e);
		}
	}

	private tickUnsafe(): void {
		const { overlay } = this.deps;
		if (this.expiredFired) return;
		const stop = this.timer.session.frozenAt === null ? this.deps.expired?.() ?? null : null;
		if (stop !== null) {
			this.expiredFired = true;
			this.deps.freeze();
			overlay.freeze(stop);
			return;
		}
		const events = this.timer.tick(this.deps.now(), this.deps.visible());
		if (this.timer.dirty) this.deps.save(this.timer.session);
		for (const ev of events) {
			if (ev.type === 'warn') {
				overlay.warn(`END IN ${ev.minutesLeft} MINUTE${ev.minutesLeft === 1 ? '' : 'S'}`, WARNING_SHOW_MS);
			} else {
				this.deps.freeze();
				overlay.freeze(this.deps.lockedText);
			}
		}
	}
}
