import { describe, it, expect } from 'vitest';
import { fields, fbm2, fbm3, clamp, smooth, spline } from './fields';

describe('v3 fields', () => {
	it('caches one Fields object per seed and keys every named field', () => {
		const a = fields(5), b = fields(5), c = fields(6);
		expect(a).toBe(b); expect(a).not.toBe(c);
		for (const n of ['C', 'E', 'PV', 'T', 'HU', 'R', 'D', 'ENT', 'RAV', 'RG', 'RAVD', 'PATCH']) expect(typeof (a as any)[n]).toBe('function');
		for (const n of ['SHAPE', 'CHEESE', 'S1', 'S2', 'N1', 'N2', 'DECO']) expect(typeof (a as any)[n]).toBe('function');
	});
	it('fields are seeded per name: C and E differ at the same point', () => {
		const f = fields(9);
		expect(f.C(0.3, 0.7)).not.toBe(f.E(0.3, 0.7));
		expect(f.C(0.3, 0.7)).toBe(fields(9).C(0.3, 0.7));
	});
	it('fbm2/fbm3 stay within [-1, 1] and reduce to one octave', () => {
		const f = fields(3);
		for (let i = 0; i < 200; i++) { const v = fbm2(f.C, i * 0.37, i * 0.11, 3); expect(Math.abs(v)).toBeLessThanOrEqual(1); }
		expect(fbm2(f.C, 1.5, 2.5, 1)).toBe(f.C(1.5, 2.5));
		expect(fbm3(f.SHAPE, 1, 2, 3, 1)).toBe(f.SHAPE(1, 2, 3));
	});
	it('clamp, smooth, spline behave per §3', () => {
		expect(clamp(5, 0, 1)).toBe(1); expect(clamp(-1, 0, 1)).toBe(0);
		expect(smooth(0)).toBe(0); expect(smooth(1)).toBe(1); expect(smooth(0.5)).toBe(0.5); expect(smooth(2)).toBe(1);
		const pts: [number, number][] = [[-1, 98], [-0.55, 104], [-0.3, 113], [-0.15, 121], [0.1, 127], [0.45, 136], [1, 146]];
		expect(spline(-2, pts)).toBe(98); expect(spline(2, pts)).toBe(146); expect(spline(0.1, pts)).toBe(127);
		expect(spline(-0.225, pts)).toBeCloseTo(117, 5); // midpoint between knots: smooth(0.5) = 0.5
	});
});
