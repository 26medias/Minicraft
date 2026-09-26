// When sounds play (sound spec §1, §4, §7): pure functions of time and state, so they are tested
// without audio. Times are in milliseconds.

export const HIT_EVERY_MS = 250;
/** No timed hit this close to the break: the break sound covers it (kid-lens review #4). */
export const HIT_BEFORE_BREAK_MS = 100;
/** Blocks that break faster than this play no hits at all, only the break. */
export const HITLESS_UNDER_MS = 300;
export const PICKUP_EVERY_MS = 500;

/**
 * How many hits are due for a mine that has run `elapsedMs` of `durationMs`, counting the one at
 * the start. The caller plays one each time this number goes up.
 */
export function hitsDue(elapsedMs: number, durationMs: number): number {
	if (durationMs < HITLESS_UNDER_MS) return 0;
	const lastAllowed = durationMs - HIT_BEFORE_BREAK_MS;
	const t = Math.min(elapsedMs, lastAllowed);
	if (t < 0) return 0;
	return Math.floor(t / HIT_EVERY_MS) + 1;
}

/** A gate that opens at most once every `everyMs`. */
export function makeThrottle(everyMs: number): (now: number) => boolean {
	let last = -Infinity;
	return (now) => {
		if (now - last < everyMs) return false;
		last = now;
		return true;
	};
}

export const BOOM_EVERY_MS = 250;
export const BOOM_MAX_AT_ONCE = 3;
export const BOOM_LENGTH_MS = 2500;

/** TNT chains (kid-lens review #2): a boom at most every 250 ms, and at most 3 ringing at once. */
export function makeBoomGate(): (now: number) => boolean {
	const started: number[] = [];
	return (now) => {
		while (started.length && now - started[0] >= BOOM_LENGTH_MS) started.shift();
		if (started.length >= BOOM_MAX_AT_ONCE) return false;
		if (started.length && now - started[started.length - 1] < BOOM_EVERY_MS) return false;
		started.push(now);
		return true;
	};
}

export const SPLASH_MIN_DRY_MS = 1000;
export const SPLASH_MIN_SPEED = 5;

/**
 * Splash (kid-lens review #5): the feet enter water after at least a second out of it, falling
 * faster than 5 blocks/s. Swimming at the surface and hopping does not splash.
 */
export function makeSplashDetector(): (now: number, feetInWater: boolean, vy: number) => boolean {
	let wasIn = true; // entering a world already in water is not a splash
	let dryFrom = -Infinity;
	return (now, feetInWater, vy) => {
		let splash = false;
		if (feetInWater && !wasIn) splash = now - dryFrom >= SPLASH_MIN_DRY_MS && -vy > SPLASH_MIN_SPEED;
		if (!feetInWater && wasIn) dryFrom = now;
		wasIn = feetInWater;
		return splash;
	};
}

/** Other players' sounds fade with distance (spec §4). */
export function distanceGain(d: number, range = 32): number {
	const x = Math.min(1, Math.max(0, 1 - d / range));
	return x * x;
}

// --- Music (spec §7) ----------------------------------------------------------------------------

export const FIRST_TRACK_MS: [number, number] = [20_000, 60_000];
export const TRACK_GAP_MS: [number, number] = [120_000, 300_000];

export function between([lo, hi]: [number, number], rng: () => number): number {
	return lo + (hi - lo) * rng();
}

/** A shuffled pick that never repeats the previous track (when there is more than one). */
export function nextTrack(prev: number | null, count: number, rng: () => number): number {
	if (count <= 1) return 0;
	if (prev === null) return Math.floor(rng() * count);
	const i = Math.floor(rng() * (count - 1));
	return i >= prev ? i + 1 : i;
}
