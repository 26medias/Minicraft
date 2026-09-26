import { EYE_HEIGHT } from 'minicraft-bot';
import type { Vec3 } from '../types.js';
import { LIMITS } from '../data/limits.data.js';
import type { Behaviour } from './behaviour.js';

export interface RestPlan { spot: Vec3; until: number; lastLook: number; walked: boolean }

const hdist = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
/** Close enough to the spot to rest there. */
const THERE = 1.5;

/**
 * Rest (spec §6): the latest build within the leash of the nearest kid (or of the bot with no kid),
 * else where it stands; go there, idle and look around slowly; 30–90 s. Stimulation's half-life is
 * halved while resting (emotions.ts decayPatch).
 */
export const REST: Behaviour<Record<string, never>, RestPlan> = {
	kind: 'rest',
	typicalMs: [30_000, 90_000],
	plan(_p, ctx) {
		const nearest = [...ctx.kids].sort((a, b) => hdist(a.pose, ctx.pose) - hdist(b.pose, ctx.pose))[0];
		const anchor = nearest ? nearest.pose : ctx.pose;
		const build = [...ctx.state.builds].reverse().find((b) => hdist(b.origin, anchor) <= LIMITS.LEASH);
		const spot = build ? { ...build.origin } : { x: ctx.pose.x, y: ctx.pose.y, z: ctx.pose.z };
		return { spot, until: ctx.now + 30_000 + ctx.rng() * 60_000, lastLook: -Infinity, walked: false };
	},
	next(pl, ctx) {
		if (ctx.now >= pl.until) return 'done';
		if (!pl.walked && hdist(ctx.pose, pl.spot) > THERE) return { kind: 'walk', to: { x: pl.spot.x, z: pl.spot.z }, speed: ctx.style.walkSpeed };
		if (ctx.now - pl.lastLook >= ctx.style.lookEveryMs) {
			const yaw = ctx.rng() * 2 * Math.PI;
			return { kind: 'look', at: { x: ctx.pose.x - Math.sin(yaw) * 5, y: ctx.pose.y + EYE_HEIGHT, z: ctx.pose.z - Math.cos(yaw) * 5 } };
		}
		return { kind: 'wait', ms: 500 };
	},
	plannedEdits: () => 0,
	owns: () => false,
	onResult(pl, a, _ok, ctx) {
		// One walk attempt: arrived or not, it rests where it ends up (a cancelled walk is reissued by the runner).
		if (a.kind === 'walk') pl.walked = true;
		if (a.kind === 'look') pl.lastLook = ctx.now;
		return [];
	},
};
