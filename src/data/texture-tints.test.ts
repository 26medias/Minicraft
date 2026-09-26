// src/data/texture-tints.test.ts
import { describe, it, expect } from 'vitest';
import { HUE_EXEMPT, TEXTURE_TINTED, UNTINTED_GREY, requiredTextureNames } from './texture-sources';
import { TEXTURE_TINTS } from '../../scripts/build-atlas-tints';
import { hueSat, meanLum, meanRgb } from './texture-import';
import { readTile } from './texture-test-util';

function tinted(t: Uint8Array, c: [number, number, number]) {
	const o = new Uint8Array(t);
	for (let i = 0; i < o.length; i += 4) for (let k = 0; k < 3; k++) o[i + k] = Math.round((t[i + k] * c[k]) / 255);
	return o;
}
const leafy = requiredTextureNames().filter((n) => n.endsWith('_leaves') || n === 'grass_block_top');

describe('texture tints (spec §5.2)', () => {
	it('TEXTURE_TINTS keys are exactly TEXTURE_TINTED', () => {
		expect(Object.keys(TEXTURE_TINTS).sort()).toEqual([...TEXTURE_TINTED].sort());
	});
	it('(a) every tinted texture is a grey mask: saturation of mean RGB < 0.30', async () => {
		for (const n of TEXTURE_TINTED) expect(hueSat(meanRgb(await readTile(n))).sat, n).toBeLessThan(0.3);
	});
	it('(b) every grey leaves/grass-top texture is tinted or on UNTINTED_GREY', async () => {
		for (const n of leafy) if (hueSat(meanRgb(await readTile(n))).sat < 0.27)
			expect(TEXTURE_TINTED.includes(n) || UNTINTED_GREY.includes(n), n).toBe(true);
	});
	it('(c) after tinting, foliage is green, saturated and not near-black (except HUE_EXEMPT)', async () => {
		for (const n of leafy) {
			if (HUE_EXEMPT.includes(n)) continue;
			const t = await readTile(n), c = TEXTURE_TINTS[n];
			const out = c ? tinted(t, c) : t;
			const { hue, sat } = hueSat(meanRgb(out));
			expect(hue, `${n} hue`).toBeGreaterThanOrEqual(45); expect(hue, `${n} hue`).toBeLessThanOrEqual(150);
			expect(sat, `${n} sat`).toBeGreaterThan(0.25);
			expect(meanLum(out), `${n} lum`).toBeGreaterThan(40);
		}
	});
	it('(d) birch_leaves is tinted', () => expect(TEXTURE_TINTED).toContain('birch_leaves'));
});
