import type { State } from './types.js';

/** How the bot moves and edits, from its emotions (spec §5.5). */
export interface Style { walkSpeed: number; editGapMs: number; lookEveryMs: number; distance: number; hopBetweenSteps: boolean; slow: boolean }

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The style of the current state (spec §5.5). Pure. */
export function styleOf(s: Readonly<State>): Style {
	const e = s.emotions;
	const stim = e.stimulation.value, mood = e.mood.value;
	return {
		walkSpeed: clamp(0.6 + 0.2 * stim + 0.2 * mood, 0.4, 1),
		editGapMs: clamp(1300 - 700 * Math.max(stim, mood), 600, 2000),
		lookEveryMs: clamp(4000 - 2500 * e.curiosity.value, 1000, 6000),
		distance: clamp(s.personality.preferredDistance - 1.5 * e.confidence.value - 1.5 * e.affection.value, 1.5, 8),
		hopBetweenSteps: stim >= 0.4 && mood >= 0.4,
		slow: mood < -0.4,
	};
}
