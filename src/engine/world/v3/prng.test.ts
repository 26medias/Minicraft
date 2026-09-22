import { describe, it, expect } from 'vitest';
import { mix32, streamSeed, subSeed, mulberry32, hashv, F } from './prng';

describe('v3 prng', () => {
	it('mix32 is the murmur3 finaliser (known vector) and returns unsigned', () => {
		expect(mix32(0)).toBe(0);
		expect(mix32(1)).toBe(1364076727); // murmur3 fmix32(1), computed with the reference formula
		expect(mix32(0xffffffff)).toBeGreaterThanOrEqual(0);
	});
	it('streamSeed separates seed, chunk and feature', () => {
		const a = streamSeed(1, 0, 0, F.ORE);
		expect(streamSeed(2, 0, 0, F.ORE)).not.toBe(a);
		expect(streamSeed(1, 1, 0, F.ORE)).not.toBe(a);
		expect(streamSeed(1, 0, 1, F.ORE)).not.toBe(a);
		expect(streamSeed(1, 0, 0, F.TREE)).not.toBe(a);
		expect(streamSeed(1, 0, 0, F.ORE)).toBe(a);
	});
	it('sub-streams of one base differ per index and are stable', () => {
		const base = streamSeed(7, 3, 4, F.ORE);
		expect(subSeed(base, 0)).not.toBe(subSeed(base, 1));
		expect(subSeed(base, 5)).toBe(subSeed(base, 5));
	});
	it('mulberry32 yields [0,1) and is reproducible', () => {
		const a = mulberry32(123), b = mulberry32(123);
		for (let i = 0; i < 1000; i++) { const v = a(); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); expect(b()).toBe(v); }
	});
	it('hashv is unsigned and depends on all three coordinates', () => {
		expect(hashv(1, 2, 3)).toBeGreaterThanOrEqual(0);
		expect(hashv(1, 2, 3)).not.toBe(hashv(2, 2, 3));
		expect(hashv(1, 2, 3)).not.toBe(hashv(1, 3, 3));
		expect(hashv(1, 2, 3)).not.toBe(hashv(1, 2, 4));
		expect(hashv(-5, 0, 511)).toBe(hashv(-5, 0, 511));
	});
});
