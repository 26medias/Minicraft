import { describe, it, expect } from 'vitest';
import { distanceGain, hitsDue, makeBoomGate, makeSplashDetector, makeThrottle, nextTrack } from './rules';

describe('hitsDue', () => {
	it('plays one at the start, then one every 250 ms', () => {
		expect(hitsDue(0, 1000)).toBe(1);
		expect(hitsDue(249, 1000)).toBe(1);
		expect(hitsDue(250, 1000)).toBe(2);
		expect(hitsDue(750, 1000)).toBe(4);
	});

	it('skips a hit less than 100 ms before the break', () => {
		// 1000 ms mine: hits at 0, 250, 500, 750; none at 1000 (the break)
		expect(hitsDue(999, 1000)).toBe(4);
		// 800 ms mine: the 750 hit is 50 ms before the break, so it is skipped
		expect(hitsDue(799, 800)).toBe(3);
	});

	it('fast blocks play no hits', () => {
		expect(hitsDue(0, 250)).toBe(0);
		expect(hitsDue(200, 299)).toBe(0);
		expect(hitsDue(0, 300)).toBe(1);
	});
});

describe('throttles', () => {
	it('opens at most once per period', () => {
		const t = makeThrottle(500);
		expect([t(0), t(100), t(499), t(500), t(900), t(1000)]).toEqual([true, false, false, true, false, true]);
	});

	it('a TNT wall of 20 booms in 2 s plays a few, never more than 3 at once', () => {
		const gate = makeBoomGate();
		const played = [];
		for (let i = 0; i < 20; i++) if (gate(i * 100)) played.push(i * 100);
		expect(played).toEqual([0, 300, 600]);
		// the first boom has finished ringing at 2500 ms, so one more may start
		expect(gate(2500)).toBe(true);
	});
});

describe('splash', () => {
	it('splashes on a real fall into water', () => {
		const s = makeSplashDetector();
		s(0, false, 0);
		expect(s(1500, true, -9)).toBe(true);
	});

	it('does not splash while swimming and hopping at the surface', () => {
		const s = makeSplashDetector();
		let splashes = 0;
		// in water, hop out for 0.67 s, back in at 8 blocks/s, repeat
		for (let k = 0; k < 10; k++) {
			const t = k * 1000;
			if (s(t, true, 0)) splashes++;
			if (s(t + 100, false, 8)) splashes++;
			if (s(t + 770, true, -8)) splashes++;
		}
		expect(splashes).toBe(0);
	});

	it('does not splash on a slow step into water, or when the world starts in water', () => {
		const s = makeSplashDetector();
		expect(s(0, true, 0)).toBe(false);
		s(100, false, 0);
		expect(s(3000, true, -2)).toBe(false);
	});
});

describe('distanceGain', () => {
	it('is full next to you and silent from 32 blocks', () => {
		expect(distanceGain(0)).toBe(1);
		expect(distanceGain(16)).toBeCloseTo(0.25);
		expect(distanceGain(32)).toBe(0);
		expect(distanceGain(100)).toBe(0);
	});
});

describe('nextTrack', () => {
	it('never plays the same track twice in a row and reaches every other track', () => {
		let seed = 1;
		const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
		let prev: number | null = null;
		const seen = new Set<number>();
		for (let i = 0; i < 400; i++) {
			const n = nextTrack(prev, 4, rng);
			expect(n).not.toBe(prev);
			expect(n).toBeGreaterThanOrEqual(0);
			expect(n).toBeLessThan(4);
			seen.add(n);
			prev = n;
		}
		expect(seen.size).toBe(4);
	});
});

describe('crossfadeLoop', () => {
	it('makes the wrap from the end to the loop start continuous', async () => {
		const { crossfadeLoop } = await import('./engine');
		// a ramp 0..1 wraps with a jump of 1; after the crossfade the wrap is one normal step
		const len = 1000;
		const ch = Float32Array.from({ length: len }, (_, i) => i / len);
		const n = crossfadeLoop([ch], 50);
		expect(n).toBe(50);
		const wrapJump = Math.abs(ch[n] - ch[len - 1]);
		expect(wrapJump).toBeLessThan(0.01);
		// untouched in the middle
		expect(ch[500]).toBeCloseTo(0.5);
	});
});
