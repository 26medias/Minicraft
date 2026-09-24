import { WARNING_SHOW_MS } from '../data/playtime.data';
import { PlayTimer, type PlaytimeSession } from './playtime';
import { sessionInForce, type Schedule } from './schedule';

/**
 * The session for this game (spec §8.1, plan P1 re-gate):
 * - the stored session when it is in force, whatever `limitMin` is, so a
 *   frozen session is not escaped by picking "No limit";
 * - otherwise a new session when `limitMin !== null`;
 * - otherwise null: No limit, no controller.
 */
export function resolveSession(
	stored: PlaytimeSession | null,
	limitMin: number | null,
	now: number,
	schedule: Schedule | null = null,
): PlaytimeSession | null {
	if (stored && sessionInForce(stored, schedule, now)) return stored;
	if (limitMin === null) return null;
	return {
		limitMs: limitMin * 60_000,
		breakMs: null,
		playedMs: 0,
		frozenAt: null,
		startedAt: now,
		updatedAt: now,
	};
}

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
	/** Shown instead of ASK A PARENT on a freeze (schedule mode). */
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
			} else {
				this.deps.freeze();
				overlay.freeze(this.deps.lockedText);
			}
		}
	}
}
