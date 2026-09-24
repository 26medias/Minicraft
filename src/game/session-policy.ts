import type { LoadedSchedule } from './schedule';

const MIN_DURATION = 10;
const TOP_DURATION = 120;
const STEP = 5;

/**
 * Spec §8.1: keep the stored session across this page load? Without a PIN a
 * refresh discards it (honour system), except under an active schedule ("all
 * done for today" can't be refreshed away) and on a multiplayer reconnect
 * reload (a wifi blip must not reset the timer).
 */
export function sessionPolicy(pinSet: boolean, scheduleActive: boolean, autojoin: boolean): 'keep' | 'discard' {
	return pinSet || scheduleActive || autojoin ? 'keep' : 'discard';
}

/** The `scheduleActive` input to sessionPolicy. A broken schedule counts as active: a parental control fails closed. */
export function scheduleActive(loaded: LoadedSchedule): boolean {
	return loaded.kind !== 'none';
}

/** The duration control's default (spec §8): No limit under No limit, else 30 min clamped to the maximum. */
export function defaultDuration(maxMin: number | null): number | null {
	return maxMin === null ? null : Math.min(30, maxMin);
}

/**
 * The chosen duration, fitted to the parent's maximum. The 10-minute floor
 * applies even under No limit; No limit chosen under a maximum becomes the
 * maximum.
 */
export function clampDuration(chosen: number | null, maxMin: number | null): number | null {
	if (chosen === null) return maxMin;
	const floored = Math.max(MIN_DURATION, chosen);
	if (maxMin === null) return floored;
	return Math.min(floored, maxMin);
}

/**
 * One press of − or +: 5-minute steps from 10 up to the maximum. Under No
 * limit, + past 120 gives No limit, and − from No limit gives 120.
 */
export function stepDuration(cur: number | null, dir: 1 | -1, maxMin: number | null): number | null {
	const c = clampDuration(cur, maxMin);
	if (c === null) return dir === 1 ? null : TOP_DURATION;
	const next = c + STEP * dir;
	if (next < MIN_DURATION) return MIN_DURATION;
	const top = maxMin ?? TOP_DURATION;
	if (next > top) return maxMin === null ? null : maxMin;
	return next;
}

/** "No limit", "30 min", "1 h", "1 h 30 min". */
export function formatDuration(min: number | null): string {
	if (min === null) return 'No limit';
	if (min < 60) return `${min} min`;
	const h = Math.floor(min / 60);
	const m = min % 60;
	return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
