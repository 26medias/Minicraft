/**
 * The appraisal table (spec §5.2): signed amounts per event kind, the code fallback of appraise.detect/size.
 * `rel.*` applies to the event's player (skipped without one); `outcome` events look up `outcome:<detail>`.
 */
import type { GlobalAxis, RelationAxis } from '../types.js';

export const APPRAISAL: Record<string, Partial<Record<GlobalAxis | `rel.${RelationAxis}`, number>>> = {
	'broke-my-block':    { 'rel.grievance': -0.3, 'rel.cooperation': -0.2, mood: -0.2, patience: -0.2 },
	'added-to-my-build': { 'rel.cooperation': 0.3, 'rel.affection': 0.2, 'rel.grievance': 0.2, mood: 0.2 },
	'line-started':      { 'rel.respect': 0.1, curiosity: 0.1 },
	'looking-at-me':     { 'rel.affection': 0.1, stimulation: 0.1 },
	'following-me':      { 'rel.affection': 0.2, trust: 0.2, mood: 0.1 },
	'player-arrived':    { stimulation: 0.2, mood: 0.1 },
	'player-gone':       { stimulation: -0.2, mood: -0.1 },
	'placed':            { curiosity: 0.05, stimulation: 0.05 },
	'broke':             { curiosity: 0.05 },
	'found':             { curiosity: 0.3, mood: 0.2, stimulation: 0.2 },
	'need':              { patience: -0.1, outlook: -0.1 },
	'stuck':             { patience: -0.3, confidence: -0.1 },
	'hazard':            { confidence: -0.3, mood: -0.1 },
	'outcome:done':      { mood: 0.3, outlook: 0.2, stimulation: 0.1 },
	'outcome:failed':    { outlook: -0.2, patience: -0.2, mood: -0.1 },
	'outcome:interrupted': { patience: -0.1 },
	'outcome:paused':    { outlook: 0.05 },
};
