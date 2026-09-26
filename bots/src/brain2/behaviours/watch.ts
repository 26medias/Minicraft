import { EYE_HEIGHT } from 'minicraft-bot';
import type { Behaviour } from './behaviour.js';

export interface WatchParams { kid: string }
export interface WatchPlan { kid: string; until: number; lastLook: number }

/** Watch {P} (spec §6): stay at the style distance and look at what P looks at; 30–60 s. */
export const WATCH: Behaviour<WatchParams, WatchPlan> = {
	kind: 'watch',
	typicalMs: [30_000, 60_000],
	plan: (p, ctx) => ({ kid: p.kid, until: ctx.now + 30_000 + ctx.rng() * 30_000, lastLook: -Infinity }),
	next(pl, ctx) {
		const k = ctx.kids.find((x) => x.name === pl.kid);
		if (!k) return { failed: 'kid gone' };
		if (ctx.now >= pl.until) return 'done';
		const dx = ctx.pose.x - k.pose.x, dz = ctx.pose.z - k.pose.z;
		const d = Math.hypot(dx, dz);
		const want = ctx.style.distance;
		if (d > want + 1) {
			// The point at the style distance on the line from the kid to the bot.
			const to = { x: k.pose.x + (dx / d) * want, z: k.pose.z + (dz / d) * want };
			return { kind: 'walk', to, speed: ctx.style.walkSpeed };
		}
		if (ctx.now - pl.lastLook >= ctx.style.lookEveryMs) {
			const t = k.lookTarget;
			return { kind: 'look', at: t ? { x: t.x + 0.5, y: t.y + 0.5, z: t.z + 0.5 } : { x: k.pose.x, y: k.pose.y + EYE_HEIGHT, z: k.pose.z } };
		}
		return { kind: 'wait', ms: 500 };
	},
	plannedEdits: () => 0,
	owns: () => false,
	onResult(pl, a, _ok, ctx) {
		if (a.kind === 'look') pl.lastLook = ctx.now;
		return [];
	},
};
