import * as THREE from 'three';
import { skinOf } from '../../data/skins.data';
import { skinUrl } from './skin-urls';
import { SKIN_FLIP_Y, SKIN_SIZE } from './skin-uv';
import { upgradeLegacySkin } from './skin-legacy';

export type SkinPixels = { width: number; height: number; data: Uint8ClampedArray };
export type SkinLoad = (url: string) => Promise<SkinPixels>;

/**
 * Decodes a PNG URL in the browser (tests inject their own load: node has no Image). Browsers with
 * fingerprinting protection (Brave, Firefox resistFingerprinting) may add noise to getImageData;
 * skins can speckle there — acceptable for the family.
 */
export const browserLoad: SkinLoad = async (url) => {
	const img = new Image();
	img.src = url;
	await img.decode();
	const c = document.createElement('canvas');
	c.width = img.naturalWidth;
	c.height = img.naturalHeight;
	const ctx = c.getContext('2d');
	if (!ctx) throw new Error('no 2d context');
	ctx.drawImage(img, 0, 0);
	const d = ctx.getImageData(0, 0, c.width, c.height);
	return { width: d.width, height: d.height, data: d.data };
};

/** A skin's 64×64 RGBA pixels (legacy 64×32 upgraded), top row first. */
export async function loadSkinPixels(id: string, load: SkinLoad = browserLoad): Promise<Uint8ClampedArray> {
	const p = await load(skinUrl(id));
	if (p.width === 64 && p.height === 64) return p.data;
	if (p.width === 64 && p.height === 32) return upgradeLegacySkin(p.data);
	throw new Error(`skin ${id}: unsupported size ${p.width}×${p.height}`);
}

/**
 * One texture per skin, shared by every avatar wearing it; never disposed per avatar. The texture
 * exists (blank) at once so meshes build synchronously, and fills in when the image decodes.
 */
export class SkinTextures {
	private readonly tex = new Map<string, THREE.DataTexture>();
	private readonly pending = new Map<string, Promise<void>>();

	constructor(private readonly load: SkinLoad = browserLoad) {}

	get(id: string): THREE.DataTexture {
		const key = skinOf(id).id;
		let t = this.tex.get(key);
		if (t) return t;
		// Until the image decodes (or if it never does) the figure shows in the character's colour, not black.
		// The hex's own sRGB bytes: THREE.Color would convert to linear (ColorManagement is on) and darken it.
		const blank = new Uint8Array(SKIN_SIZE * SKIN_SIZE * 4);
		const n = parseInt(skinOf(key).color.slice(1), 16);
		for (let i = 0; i < blank.length; i += 4) blank.set([(n >> 16) & 255, (n >> 8) & 255, n & 255, 255], i);
		t = new THREE.DataTexture(blank, SKIN_SIZE, SKIN_SIZE);
		t.flipY = SKIN_FLIP_Y;
		t.magFilter = THREE.NearestFilter;
		t.minFilter = THREE.NearestFilter;
		t.generateMipmaps = false;
		t.colorSpace = THREE.SRGBColorSpace;
		t.needsUpdate = true;
		this.tex.set(key, t);
		const tt = t;
		this.pending.set(key, loadSkinPixels(key, this.load).then(
			(px) => { (tt.image.data as Uint8Array).set(px); tt.needsUpdate = true; },
			(e) => { console.warn(`skin ${key} failed to load`, e); },
		));
		return t;
	}

	/** Resolves once `id`'s image has been applied (or failed). */
	async ready(id: string): Promise<void> {
		this.get(id);
		await this.pending.get(skinOf(id).id);
	}
}
