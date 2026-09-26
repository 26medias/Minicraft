/** The gesture table's thresholds and timings (spec §5.5, rev 3). */
export const GESTURES = {
	/** A gesture fires only for a bot inside some kid's view: this close, and this far off his yaw and pitch. */
	VIEW_RANGE: 20, VIEW_YAW_DEG: 50, VIEW_PITCH_DEG: 35,
	/** At most one gesture per this many ms. */
	EVERY_MS: 5000,
	/** The greeting is held this long for the bot to come into the kid's view. */
	GREETING_HOLD_MS: 20_000,
	/** A running gesture is cleared after this long, whatever it waits for (a stuck walk never freezes the runner). */
	MAX_MS: 8000,
	HOP_Y: 0.6, HOP_MS: 150,
	/** The style hop after a walk arrives (not a gesture). */
	STEP_HOP_Y: 0.4, STEP_HOP_WINDOW_MS: 200,
	TURN_STEPS: 12, TURN_STEP_MS: 50,
	SLOW_TURN_MS: 1500, SLOW_TURN_PAUSE_MS: 2000,
	LOOK_MS: 1500, ORE_LOOK_MS: 3000,
	TURN_AWAY_MS: 1500,
	BACK_OFF: 2, STOMP_OFF: 3, GREETING_IN_FRONT: 2,
	/** The table's thresholds, first match wins. */
	MOOD_UP: 0.3, MOOD_DOWN: -0.2, CONFIDENCE_DOWN: -0.2, AFFECTION_UP: 0.15, GRIEVANCE_DOWN: -0.2, CURIOSITY_UP: 0.2,
	PATIENCE_LOW: -0.5, GREETING_AFFECTION: 0.3,
} as const;
