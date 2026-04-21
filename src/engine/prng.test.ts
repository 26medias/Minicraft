import { describe, it, expect } from 'vitest';
import { createPrng } from './prng';

describe('createPrng', () => {
	it('is deterministic for a given seed', () => {
		const a = createPrng(42);
		const b = createPrng(42);
		for (let i = 0; i < 100; i++) {
			expect(a.float()).toBe(b.float());
		}
	});

	it('differs across seeds', () => {
		const a = createPrng(1);
		const b = createPrng(2);
		let diffs = 0;
		for (let i = 0; i < 10; i++) if (a.float() !== b.float()) diffs++;
		expect(diffs).toBeGreaterThan(5);
	});

	it('returns floats in [0, 1)', () => {
		const r = createPrng(0);
		for (let i = 0; i < 1000; i++) {
			const v = r.float();
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(1);
		}
	});

	it('intBetween returns in range', () => {
		const r = createPrng(7);
		for (let i = 0; i < 1000; i++) {
			const v = r.intBetween(3, 10);
			expect(v).toBeGreaterThanOrEqual(3);
			expect(v).toBeLessThanOrEqual(10);
		}
	});
});
