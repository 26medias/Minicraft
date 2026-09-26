/** The batch's numeric constants (spec, verbatim; see the batch brief's Global Constraints table). */
export const LIMITS = {
	EDIT_GAP_MIN_MS: 600, STOP_SIGNAL_MS: 600_000, STOP_RADIUS: 16, LEASH: 32, SITE_KID_DIST: 12, SITE_SPAWN_DIST: 16,
	MAX_STANDING_BUILDS: 3, MAX_PAUSED_DIGS: 3, MIN_BEHAVIOUR_MS: 20_000, MINE_EPISODE_MS: 120_000, MINE_N: 8,
	TRIP_RATE_FACTOR: 1.2, TRIP_CHURN: 3, TRIP_CHURN_WINDOW_MS: 600_000, TRIP_OVERRUN: 1.1,
	/** Ruling R24: a Build site or Mine target search that finds nothing within LEASH widens to the next radius. */
	LEASH_STEPS: [32, 64, 96],
} as const;
