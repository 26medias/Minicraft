/** Choices offered on the main menu, in minutes. Order is display order. */
export const PLAY_LIMIT_CHOICES_MIN = [15, 20, 30, 45, 60, 90];
export const PLAY_BREAK_CHOICES_MIN = [10, 15, 20, 30, 60];

/** Play-time-remaining thresholds at which a warning fires, descending. */
export const WARNING_THRESHOLDS_MS = [5 * 60_000, 2 * 60_000];
export const WARNING_SHOW_MS = 10_000;

/** A session untouched for this long is discarded; a no-break lock clears itself. */
export const STALE_SESSION_MS = 12 * 3_600_000;

/** Longest gap one tick may add to playedMs; caps throttled or slept intervals. */
export const MAX_TICK_CREDIT_MS = 2_000;
export const TICK_MS = 1_000;
