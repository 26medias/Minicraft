import type { Personality } from '../types.js';

const MIN = 60_000;

/** Pip: shy, curious builder (spec §4.1 starting half-lives; baselines per personality). */
export const PIP: Personality = {
	name: 'Pip',
	summary: 'a shy, curious little builder',
	baselines: { mood: 0.1, confidence: -0.3, trust: 0, affection: 0, curiosity: 0.3, patience: 0.1, outlook: 0.1, stimulation: 0 },
	halfLifeMs: { patience: 20_000, stimulation: 1 * MIN, mood: 2 * MIN, curiosity: 3 * MIN, confidence: 5 * MIN, outlook: 10 * MIN, trust: 30 * MIN, affection: 30 * MIN },
	relationHalfLifeMs: { grievance: 30 * MIN, affection: 240 * MIN, cooperation: 240 * MIN, respect: 240 * MIN },
	favouriteTemplate: 'tower',
	favouriteBlock: 'stone',
	preferredDistance: 4,
};

/** Rex: bold, restless explorer (criterion 3's second personality). */
export const REX: Personality = {
	name: 'Rex',
	summary: 'a bold, restless explorer',
	baselines: { mood: 0.2, confidence: 0.5, trust: 0.1, affection: 0.1, curiosity: 0.6, patience: -0.2, outlook: 0.3, stimulation: 0.2 },
	halfLifeMs: { ...PIP.halfLifeMs },
	relationHalfLifeMs: { ...PIP.relationHalfLifeMs },
	favouriteTemplate: 'wall',
	favouriteBlock: 'oak_log',
	preferredDistance: 2,
};

export const PERSONALITIES: Record<string, Personality> = { pip: PIP, rex: REX };
