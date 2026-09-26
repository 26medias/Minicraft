/** Selection weights (spec §5.3): starting values, tuned later through `replay --data` (Task 21). */
import type { BehaviourKind, GlobalAxis, RelationAxis } from '../types.js';

/** select.emotional: bias + Σ w·value per behaviour. A `rel.*` term reads the selected player's relation. */
export const EMOTIONAL: Record<BehaviourKind, { bias: number; w: Partial<Record<GlobalAxis | `rel.${RelationAxis}`, number>> }> = {
	follow:       { bias: 0.1, w: { 'rel.affection': 0.6, trust: 0.3, confidence: -0.2, stimulation: -0.1 } },
	'help-build': { bias: 0.0, w: { 'rel.cooperation': 0.5, 'rel.affection': 0.4, mood: 0.2, patience: 0.2 } },
	build:        { bias: 0.2, w: { outlook: 0.5, mood: 0.3, patience: 0.3, stimulation: -0.3 } },
	mine:         { bias: 0.1, w: { curiosity: 0.4, confidence: 0.4, stimulation: -0.2 } },
	explore:      { bias: 0.1, w: { curiosity: 0.5, confidence: 0.3, stimulation: -0.4 } },
	watch:        { bias: 0.0, w: { 'rel.respect': 0.5, curiosity: 0.3, confidence: -0.2 } },
	rest:         { bias: 0.0, w: { stimulation: 0.5, confidence: -0.3, mood: -0.3, patience: -0.3 } },
};

/** select.merge weights (spec §5.3). */
export const MERGE: { emotional: number; social: number; situational: number; inertia: number; recency: number; recencyBad: number; resume: number; lineBonus: number } = {
	emotional: 1.0, social: 1.0, situational: 0.3, inertia: 0.6, recency: 0.5, recencyBad: 0.8, resume: 0.4, lineBonus: 1.5,
};
