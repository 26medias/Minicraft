// src/data/texture-import.test.ts
import { describe, it, expect } from 'vitest';
import {
	TILE, alphaZeroFraction, clipFraction, composite, deltaE, hueSat, lumStd, meanLum, normaliseAlpha,
} from './texture-import';

const px = (r: number, g: number, b: number, a = 255) => [r, g, b, a];
function tileOf(fn: (i: number) => number[]): Uint8Array {
	const out = new Uint8Array(TILE * TILE * 4);
	for (let i = 0; i < TILE * TILE; i++) out.set(fn(i), i * 4);
	return out;
}

describe('texture-import pixel rules', () => {
	it('meanLum ignores alpha-0 pixels', () => {
		const t = tileOf((i) => (i % 2 ? px(255, 255, 255) : px(0, 0, 0, 0)));
		expect(meanLum(t)).toBeCloseTo(255, 0);
	});
	it('lumStd is 0 for a flat tile and > 0 for a checker', () => {
		expect(lumStd(tileOf(() => px(90, 90, 90)))).toBe(0);
		expect(lumStd(tileOf((i) => (i % 2 ? px(0, 0, 0) : px(200, 200, 200))))).toBeGreaterThan(50);
	});
	it('clipFraction counts pixels with any channel at 255', () => {
		expect(clipFraction(tileOf((i) => (i < 64 ? px(255, 10, 10) : px(10, 10, 10))))).toBeCloseTo(0.25, 5);
	});
	it('hueSat of a pure green is 120° and 1', () => {
		expect(hueSat([0, 200, 0])).toEqual({ hue: 120, sat: 1 });
	});
	it('deltaE is 0 for equal colours and large for black vs white', () => {
		expect(deltaE([10, 20, 30], [10, 20, 30])).toBe(0);
		expect(deltaE([0, 0, 0], [255, 255, 255])).toBeGreaterThan(99);
	});
	it('alphaZeroFraction counts only fully transparent pixels', () => {
		expect(alphaZeroFraction(tileOf((i) => (i < 128 ? px(1, 1, 1, 0) : px(1, 1, 1, 140))))).toBe(0.5);
	});
	it('normaliseAlpha: opaque fills holes from the nearest opaque neighbour and forces 255', () => {
		const t = tileOf((i) => (i === 0 ? px(0, 0, 0, 0) : px(50, 60, 70, 140)));
		const o = normaliseAlpha(t, 'opaque');
		expect([...o.slice(0, 4)]).toEqual([50, 60, 70, 255]);
		for (let i = 3; i < o.length; i += 4) expect(o[i]).toBe(255);
	});
	it('normaliseAlpha: cutout snaps to 0/255 at 128; translucent and keep leave alpha alone', () => {
		const t = tileOf((i) => px(9, 9, 9, i % 2 ? 127 : 128));
		const c = normaliseAlpha(t, 'cutout');
		expect(c[3]).toBe(255); expect(c[7]).toBe(0);
		expect(normaliseAlpha(t, 'keep')).toEqual(t);
		expect(normaliseAlpha(t, 'translucent')).toEqual(t);
	});
	it('composite puts an overlay over a base; overlayAlpha scales the overlay', () => {
		const base = tileOf(() => px(100, 100, 100));
		const over = tileOf((i) => (i === 0 ? px(0, 0, 0, 48) : px(0, 0, 0, 0)));
		const once = composite(base, over, 1);
		const thrice = composite(base, over, 3);
		expect(once[0]).toBeGreaterThan(thrice[0]);                  // ×3 overlay is darker
		expect([...once.slice(4, 8)]).toEqual([100, 100, 100, 255]); // untouched pixel
		expect(once[3]).toBe(255);
	});
});
