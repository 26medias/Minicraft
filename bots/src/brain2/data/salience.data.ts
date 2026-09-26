/** Salience and event-detection constants (spec §5.1, §4.4). */
import type { WorldEventKind } from '../types.js';
export const SALIENCE = {
	NEAR: 16,
	BUCKET_WINDOW_MS: 10_000,
	KEEP_MS: 60_000,
	KEEP_MAX: 30,
	ALWAYS: ['broke-my-block', 'line-started', 'looking-at-me', 'player-arrived', 'player-gone', 'found', 'need', 'stuck', 'hazard', 'outcome'] as WorldEventKind[],
	BUCKETED: ['placed', 'broke', 'added-to-my-build'] as WorldEventKind[],
	LOOK_RANGE: 8,
	LOOK_CONE_DEG: 12,
	LOOK_HOLD_MS: 2000,
	FOLLOW_RANGE: 6,
	FOLLOW_HOLD_MS: 5000,
	FOLLOW_MOVE: 3,
	FOLLOW_EVERY_MS: 60_000,
};
export function bucket(n: number): 0 | 1 | 2 {
	return n === 0 ? 0 : n <= 3 ? 1 : 2;
}
