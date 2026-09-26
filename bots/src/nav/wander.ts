/**
 * Idle movement for the builder family (builder, decorator, village, helper, architect, foreman): the rest-between-
 * builds hop, the capped bot's wander near its builds, the foreman's stroll. Every step goes through the shared
 * navigator with the body's StuckWatchdog (never a raw walkTo/flyTo), to a standable open-sky cell within WANDER_MAX
 * of the centre. After FAIL_LIMIT navigator failures in a row the bot stands still and looks around for
 * STILL_MS instead of retrying against a wall.
 */
import { groundTop } from '../brain2/behaviours/site-search.js';
import type { Body, WorldView } from '../port.js';
import type { Vec3 } from '../types.js';
import { bodyFits, isSubmerged, navigate, nearestOpenSky, openSky, StuckWatchdog } from './navigate.js';

/** Wander destinations stay within this many blocks (horizontally) of the centre. */
export const WANDER_MAX = 12;
/** How far the escape (bot currently submerged) looks for a dry open-sky cell. */
export const ESCAPE_SEARCH = 16;
/** Navigator failures in a row before the bot stops trying to move for a while. */
export const FAIL_LIMIT = 2;
/** How long it only looks around after FAIL_LIMIT failures. */
export const STILL_MS = 60_000;
/** One idle step's navigation gives up after this long (a hung walk is a failure). */
export const STEP_MS = 20_000;

/** The feet cell on top of column (x, z) when a body fits there under open sky; null otherwise. */
export function standable(world: WorldView, x: number, z: number): Vec3 | null {
	const bx = Math.floor(x), bz = Math.floor(z);
	const g = groundTop(world, bx, bz);
	if (g < 0) return null;
	const y = g + 1;
	if (!bodyFits(world, bx, y, bz) || !openSky(world, bx, bz, y)) return null;
	return { x: bx + 0.5, y, z: bz + 0.5 };
}

/**
 * A standable open-sky cell at distance [minR, maxR] (clamped to WANDER_MAX) from `c` in a random direction; tries
 * up to 16 directions, null when none is standable.
 */
export function pickWanderSpot(world: WorldView, c: { x: number; z: number }, rng: () => number, minR = 2, maxR = WANDER_MAX): Vec3 | null {
	const hi = Math.min(maxR, WANDER_MAX), lo = Math.min(minR, hi);
	for (let i = 0; i < 16; i++) {
		// A random start, then spread round the circle and outward (a bad rng still tries every side).
		const a = (rng() + i * 0.618) * Math.PI * 2, r = lo + ((rng() + i * 0.382) % 1) * (hi - lo);
		const s = standable(world, c.x + Math.cos(a) * r, c.z + Math.sin(a) * r);
		if (s && Math.hypot(s.x - c.x, s.z - c.z) <= WANDER_MAX + 1) return s;
	}
	return null;
}

export interface Wanderer {
	/**
	 * One idle move to `spot` (null: none found) through the navigator. Returns false (and only looks around) when
	 * the bot is standing still after repeated failures or there is no spot.
	 */
	go(spot: Vec3 | null, alive: () => boolean): Promise<boolean>;
	/** Consecutive navigator failures (for tests and logs). */
	readonly fails: number;
}

export function wanderer(body: Body, world: WorldView, o: { rng: () => number; clock: () => number; log: (e: Record<string, unknown>) => void }): Wanderer {
	let fails = 0, stillUntil = 0;
	const lookAround = () => {
		const p = body.pose(), a = o.rng() * Math.PI * 2;
		body.lookAt(p.x + Math.cos(a) * 8, p.y + 1 + o.rng() * 2, p.z + Math.sin(a) * 8);
	};
	return {
		get fails() {
			return fails;
		},
		async go(spot, alive) {
			if (o.clock() < stillUntil || !spot) {
				lookAround();
				return false;
			}
			if (fails >= FAIL_LIMIT) fails = 0; // the still spell is over: try moving again
			const p = body.pose();
			// Submerged (in the water — e.g. a hole in lake ice — or under a solid/ice ceiling): the nearest dry
			// open-sky cell within ESCAPE_SEARCH wins over the picked spot; failing that, `spot` itself is now
			// always dry and open-sky, and navigate flies when the walk there is blocked.
			const submerged = isSubmerged(world, p);
			const escape = submerged ? nearestOpenSky(world, p.x, Math.floor(p.y), p.z, ESCAPE_SEARCH) : null;
			if (submerged && !escape) {
				// No dry open sky within ESCAPE_SEARCH either (e.g. a wide ice sheet over water): swimming toward
				// `spot` still moves the pose, so the StuckWatchdog's own move-based check never escalates. Take its
				// last-resort move ourselves — straight up to the first standable open-sky cell above this column
				// (the ice's top, if that's what's overhead) — then keep wandering from there.
				const up = standable(world, p.x, p.z);
				if (up) {
					body.move(up);
					fails = 0;
					o.log({ k: 'unstick', level: 3, how: 'teleport-up', reason: 'submerged', at: { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 }, t: o.clock() });
					return true;
				}
			}
			const dest = escape ?? spot;
			const t0 = o.clock();
			const live = () => alive() && o.clock() - t0 < STEP_MS;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const r = await Promise.race([
				navigate(body, world, { x: dest.x, z: dest.z }, { alive: live, log: (e) => o.log({ ...e, t: o.clock() }), watchdog: StuckWatchdog.for(body, world) }),
				new Promise<{ ok: false; reason: string }>((res) => (timer = setTimeout(() => res({ ok: false, reason: 'timeout' }), STEP_MS))),
			]);
			clearTimeout(timer);
			if (r.ok) {
				fails = 0;
				return true;
			}
			if (!alive()) return false;
			fails++;
			StuckWatchdog.for(body, world).clear();
			o.log({ k: 'wander-fail', t: o.clock(), to: dest, reason: r.reason, fails });
			if (fails >= FAIL_LIMIT) {
				stillUntil = o.clock() + STILL_MS;
				o.log({ k: 'wander-still', t: o.clock(), ms: STILL_MS });
			}
			lookAround();
			return false;
		},
	};
}
