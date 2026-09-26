/**
 * "Showtime": when a kid is online, the builder family (and brain2's Build) prefer a site he can watch go up — 15 to
 * 30 blocks from him, roughly in front of him (within ±70° of where he faces). Only a preference: every site rule still
 * applies, and the plain search result stands when no site qualifies.
 */
import type { Body } from '../port.js';

export const SHOW_MIN = 15;
export const SHOW_MAX = 30;
export const SHOW_CONE_DEG = 70;

/** Where the kid stands and faces (yaw: the SDK's, facing (−sin yaw, −cos yaw)). */
export interface Showtime { x: number; z: number; yaw: number }

/** True when column (x, z) is 15–30 from the kid horizontally and within ±70° of his facing. */
export function inShowtime(s: Showtime, x: number, z: number): boolean {
	const dx = x - s.x, dz = z - s.z;
	const d = Math.hypot(dx, dz);
	if (d < SHOW_MIN || d > SHOW_MAX) return false;
	const cos = (dx * -Math.sin(s.yaw) + dz * -Math.cos(s.yaw)) / d;
	return cos >= Math.cos((SHOW_CONE_DEG * Math.PI) / 180) - 1e-9;
}

/** The nearest kid (non-bot player with a pose) to the bot, as a Showtime; null when none is online. */
export function showtimeOf(body: Body): Showtime | null {
	const p = body.pose();
	let best: Showtime | null = null, bestD = Infinity;
	for (const k of body.players()) {
		if (k.bot || !k.hasPos) continue;
		const d = Math.hypot(k.x - p.x, k.z - p.z);
		if (d < bestD) {
			bestD = d;
			best = { x: k.x, z: k.z, yaw: k.yaw };
		}
	}
	return best;
}
