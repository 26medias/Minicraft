import type { Behaviour } from './behaviour.js';

export interface FollowParams { kid: string }
export interface FollowPlan { kid: string }

/** Follow {P} (spec §6): today's standing-intent follow, driven by the runner one `follow-tick` at a time. */
export const FOLLOW: Behaviour<FollowParams, FollowPlan> = {
	kind: 'follow',
	typicalMs: [60_000, 180_000],
	plan: (p) => ({ kid: p.kid }),
	next: (pl, ctx) => (ctx.kids.some((k) => k.name === pl.kid) ? { kind: 'follow-tick', kid: pl.kid } : { failed: 'kid gone' }),
	plannedEdits: () => 0,
	owns: () => false,
};
