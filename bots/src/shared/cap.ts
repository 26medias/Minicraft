/**
 * The build cap: builder, architect and helper bots stop building once they've made `--max-builds` builds (default
 * 10) in the last rolling hour; the decorator once it's made `--max-decorations` (default 30) in the last hour; the
 * landscaper's `--max-blasts` (default 15, landscaper.ts) works the same way. These are a safety valve against a
 * runaway loop, not a throttle — the defaults are generous on purpose, so a big world keeps visibly being built on,
 * mined and blown up. The village bot builds one village at a time, then may start a new one 1 hour after the last
 * one finished (its own logic, not this module). The count comes from the bot's persisted records (each one carries
 * a `t`), so it holds across restarts and empties out again as records age past the hour. A capped bot stays online
 * and only wanders and looks around near its builds: no more edits, except that a --join-plan bot still claims the
 * plan's open lots (lot builds never count: the plan bounds them).
 */
export const HOUR_MS = 60 * 60_000;
export const DEFAULT_MAX_BUILDS = 10;
export const DEFAULT_MAX_DECORATIONS = 30;

type CapRecord = { status: string; placed: readonly string[]; lot?: string; t: number };

/**
 * A record counts once it put a block in the world (or finished): an attempt that placed nothing litters nothing.
 * A build on a claimed plan lot never counts: the foreman's plan bounds those.
 */
export function countsTowardCap(r: CapRecord): boolean {
	return !r.lot && (r.status === 'done' || r.placed.length > 0);
}

/** How many of `times` fall within `windowMs` (default a rolling hour) of `now`. */
export function windowCount(times: readonly number[], now: number, windowMs = HOUR_MS): number {
	return times.filter((t) => now - t < windowMs).length;
}

/** True once `windowCount(times, now, windowMs) >= max`. */
export function windowReached(times: readonly number[], now: number, max: number, windowMs = HOUR_MS): boolean {
	return windowCount(times, now, windowMs) >= max;
}

/**
 * Milliseconds until a slot frees: the time until enough of `times` within the window age past `windowMs` that the
 * count drops under `max` again. 0 once the count is already under the cap.
 */
export function msUntilSlot(times: readonly number[], now: number, max: number, windowMs = HOUR_MS): number {
	const inWindow = [...times.filter((t) => now - t < windowMs)].sort((a, b) => a - b);
	if (inWindow.length < max) return 0;
	return Math.max(0, windowMs - (now - inWindow[inWindow.length - max]));
}

/** `msUntilSlot` rounded up to whole minutes, never below 1 once it's actually waiting (0 stays 0). */
export function minutesUntilSlot(ms: number): number {
	return ms <= 0 ? 0 : Math.max(1, Math.ceil(ms / 60_000));
}

const timesOf = (records: ReadonlyArray<CapRecord>): number[] => records.filter(countsTowardCap).map((r) => r.t);

export function capCount(records: ReadonlyArray<CapRecord>, now: number, windowMs = HOUR_MS): number {
	return windowCount(timesOf(records), now, windowMs);
}

export function capReached(records: ReadonlyArray<CapRecord>, max: number, now: number, windowMs = HOUR_MS): boolean {
	return windowReached(timesOf(records), now, max, windowMs);
}

export function capMsUntilSlot(records: ReadonlyArray<CapRecord>, max: number, now: number, windowMs = HOUR_MS): number {
	return msUntilSlot(timesOf(records), now, max, windowMs);
}
