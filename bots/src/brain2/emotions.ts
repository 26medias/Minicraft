import type { Band } from './types.js';
/** Spec §4.1 word bands, without hysteresis (hysteresis is nextBand, Task 3). */
export function bandOf(v: number): Band {
	if (v <= -0.6) return 'very low';
	if (v <= -0.2) return 'low';
	if (v < 0.2) return 'neutral';
	if (v < 0.6) return 'high';
	return 'very high';
}
