/**
 * Play durations, in minutes: 10..120 in 5-minute steps (23 values). The kid's
 * duration, the parent's maximum and a schedule's duration all come from this
 * list. It is a superset of the old play-limit choices [15, 20, 30, 45, 60, 90],
 * so stored limits and schedules keep validating (spec §8.3).
 */
export const DURATION_CHOICES_MIN: number[] = Array.from({ length: 23 }, (_, i) => 10 + 5 * i);

/** Play-time-remaining thresholds at which a warning fires, descending. */
export const WARNING_THRESHOLDS_MS = [5 * 60_000, 2 * 60_000];
export const WARNING_SHOW_MS = 10_000;

/** A session untouched for this long is discarded; a lock from last night clears itself. */
export const STALE_SESSION_MS = 12 * 3_600_000;

/** Longest gap one tick may add to playedMs; caps throttled or slept intervals. */
export const MAX_TICK_CREDIT_MS = 2_000;
export const TICK_MS = 1_000;
