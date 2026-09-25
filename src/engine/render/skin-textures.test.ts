import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { SkinTextures, loadSkinPixels, type SkinPixels } from './skin-textures';
import { SKIN_FLIP_Y } from './skin-uv';
import { skinUrl } from './skin-urls';
import { skinColor } from '../../data/skins.data';

const solid = (w: number, h: number, v: number): SkinPixels => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(v) });

describe('SkinTextures', () => {
	it('one shared, nearest-filtered texture per id, flipY = SKIN_FLIP_Y; unknown ids share the default', () => {
		const urls: string[] = [];
		const t = new SkinTextures(async (u) => { urls.push(u); return solid(64, 64, 200); });
		const a = t.get('jj');
		expect(t.get('jj')).toBe(a);
		expect(a).toBeInstanceOf(THREE.DataTexture);
		expect(a.flipY).toBe(SKIN_FLIP_Y);
		expect(a.magFilter).toBe(THREE.NearestFilter);
		expect(a.minFilter).toBe(THREE.NearestFilter);
		expect(a.generateMipmaps).toBe(false);
		expect(t.get('red')).toBe(t.get('milo'));
		expect(urls).toEqual([skinUrl('jj'), skinUrl('milo')]);
	});

	it('fills the texture when the image arrives; a legacy 64×32 image is upgraded', async () => {
		const t = new SkinTextures(async () => solid(64, 32, 90));
		const tex = t.get('enderman');
		const v0 = tex.version;
		await t.ready('enderman');
		const d = tex.image.data as Uint8Array;
		expect(tex.image.width).toBe(64);
		expect(tex.image.height).toBe(64);
		expect(d[(52 * 64 + 20) * 4]).toBe(90); // new left-leg front came from the upgrade
		expect(tex.version).toBeGreaterThan(v0); // needsUpdate was set after the fill
	});

	it("a failed load keeps the character-colour placeholder and never rejects", async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const t = new SkinTextures(async () => { throw new Error('no Image in node'); });
		const tex = t.get('mikey');
		await expect(t.ready('mikey')).resolves.toBeUndefined();
		const d = tex.image.data as Uint8Array;
		const hex = skinColor('mikey'); // e.g. '#7ED321' → literal sRGB bytes, never via THREE.Color
		expect(Array.from(d.subarray(0, 4))).toEqual([parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255]);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('loadSkinPixels rejects a size that is neither 64×64 nor 64×32', async () => {
		await expect(loadSkinPixels('jj', async () => solid(32, 32, 1))).rejects.toThrow();
	});
});
