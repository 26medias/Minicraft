import { WARNING_SHOW_MS } from '../data/playtime.data';
import { PlayTimer, phaseOf, type PlaytimeSession } from './playtime';
import { sessionInForce, type Schedule } from './schedule';

/** The stored session if it is still in force, otherwise a fresh one from the options. */
export function resolveSession(
	stored: PlaytimeSession | null,
	limitMin: number,
	breakMin: number | null,
	now: number,
	schedule: Schedule | null = null,
): PlaytimeSession {
	if (stored && sessionInForce(stored, schedule, now)) {
		// Under a schedule any in-force session belongs to today, break or not: a
		// break written by a stale unscheduled tab must not reopen the day.
		if (schedule) return { ...stored, breakMs: null };
		if (phaseOf(stored, now) !== 'over') return stored;
	}
	return {
		limitMs: limitMin * 60_000,
		breakMs: breakMin === null ? null : breakMin * 60_000,
		playedMs: 0,
		frozenAt: null,
		startedAt: now,
		updatedAt: now,
	};
}

export type PlaytimeOverlayLike = {
	warn(text: string, ms: number): void;
	freeze(breakEndsAt: number | null, lockedText?: string): void;
	setBreakRemaining(ms: number): void;
	offerPlayAgain(onClick: () => void): void;
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
	/** Shown instead of ASK A GROWN-UP on a no-break freeze (schedule mode). */
	lockedText?: string;
};

/**
 * Drives a PlayTimer from a 1 s interval and turns its events into overlay
 * and game calls. Pure orchestration: no DOM, no storage, so the dispatch
 * rules can be unit-tested with fake deps.
 */
export class PlaytimeController {
	private timer: PlayTimer;

	constructor(
		session: PlaytimeSession,
		private deps: PlaytimeDeps,
	) {
		this.timer = new PlayTimer(session, deps.now());
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
		const events = this.timer.tick(this.deps.now(), this.deps.visible());
		if (this.timer.dirty) this.deps.save(this.timer.session);
		for (const ev of events) {
			if (ev.type === 'warn') {
				overlay.warn(`END IN ${ev.minutesLeft} MINUTE${ev.minutesLeft === 1 ? '' : 'S'}`, WARNING_SHOW_MS);
			} else if (ev.type === 'freeze') {
				this.deps.freeze();
				overlay.freeze(ev.breakEndsAt, this.deps.lockedText);
			} else {
				overlay.offerPlayAgain(() => this.playAgain());
			}
		}
		// Only a real break has a countdown; a no-break freeze shows ASK A GROWN-UP.
		if (this.timer.phase() === 'break' && this.timer.session.breakMs !== null) {
			overlay.setBreakRemaining(this.timer.breakRemainingMs());
		}
	}

	playAgain(): void {
		const now = this.deps.now();
		const fresh: PlaytimeSession = {
			limitMs: this.timer.session.limitMs,
			breakMs: this.timer.session.breakMs,
			playedMs: 0,
			frozenAt: null,
			startedAt: now,
			updatedAt: now,
		};
		this.deps.save(fresh);
		this.timer = new PlayTimer(fresh, now);
		this.deps.overlay.unfreeze();
		this.deps.resume();
	}
}
