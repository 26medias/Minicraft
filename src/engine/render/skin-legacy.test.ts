import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { join } from 'node:path';
import { upgradeLegacySkin } from './skin-legacy';
import { faceRects, type FaceName } from './skin-uv';

const W = 64;
const px = (a: Uint8ClampedArray, w: number, x: number, y: number) => Array.from(a.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));

/** 64×32: every pixel unique and opaque (r = x·4, g = y·8, b = 77). Asymmetric by construction. */
function synthetic(): Uint8ClampedArray {
	const a = new Uint8ClampedArray(W * 32 * 4);
	for (let y = 0; y < 32; y++) for (let x = 0; x < W; x++) a.set([x * 4, y * 8, 77, 255], (y * W + x) * 4);
	return a;
}

describe('upgradeLegacySkin', () => {
	it('copies rows 0–31 unchanged', () => {
		const src = synthetic();
		const out = upgradeLegacySkin(src);
		expect(out).toHaveLength(W * W * 4);
		for (let y = 0; y < 32; y++) for (let x = 0; x < W; x++) expect(px(out, W, x, y)).toEqual(px(src, W, x, y));
	});

	it('each left-limb face is the matching right-limb face, sides swapped, columns reversed (oracle: faceRects, not LEGACY_COPIES)', () => {
		const src = synthetic();
		const out = upgradeLegacySkin(src);
		// The left limb seen from outside is the mirror image of the right limb: its right side
		// shows the right limb's LEFT side and vice versa; every face is mirrored left-right.
		const pairs: Array<[[number, number], [number, number]]> = [[[0, 16], [16, 48]], [[40, 16], [32, 48]]]; // leg, arm
		const from: Record<FaceName, FaceName> = { top: 'top', bottom: 'bottom', front: 'front', back: 'back', right: 'left', left: 'right' };
		for (const [[su, sv], [du, dv]] of pairs) {
			const sr = faceRects(su, sv, 4, 12, 4), dr = faceRects(du, dv, 4, 12, 4);
			for (const f of Object.keys(from) as FaceName[]) {
				const S = sr[from[f]], D = dr[f];
				for (let y = 0; y < D.h; y++) for (let x = 0; x < D.w; x++) {
					expect(px(out, W, D.x + x, D.y + y), `${du},${dv} ${f}`).toEqual(px(src, W, S.x + S.w - 1 - x, S.y + y));
				}
			}
		}
	});

	it('leaves the new overlay areas transparent and forces the base areas opaque', () => {
		const src = synthetic();
		for (let i = 3; i < src.length; i += 4) src[i] = 10; // all nearly transparent
		const out = upgradeLegacySkin(src);
		expect(px(out, W, 2, 40)[3]).toBe(0); // right-leg pants (0,32)
		expect(px(out, W, 50, 50)[3]).toBe(0); // left sleeve (48,48)
		expect(px(out, W, 4, 60)[3]).toBe(0); // left pants (0,48)
		expect(px(out, W, 10, 10)[3]).toBe(255); // head
		expect(px(out, W, 20, 20)[3]).toBe(255); // body row band
		expect(px(out, W, 20, 52)[3]).toBe(255); // new left leg
		expect(px(out, W, 36, 52)[3]).toBe(255); // new left arm
		expect(px(out, W, 40, 10)[3]).toBe(10); // hat keeps its alpha
	});

	it('the real Enderman: 64×32, empty hat, left-leg front = mirrored right-leg front', async () => {
		const { data, info } = await sharp(join(__dirname, '../../assets/skins/enderman.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		expect([info.width, info.height]).toEqual([64, 32]);
		const src = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);
		let hatOpaque = 0;
		for (let y = 0; y < 16; y++) for (let x = 32; x < 64; x++) if (px(src, W, x, y)[3] > 0) hatOpaque++;
		expect(hatOpaque).toBe(0); // so the Notch transparency hack is not needed
		const out = upgradeLegacySkin(src);
		for (let y = 0; y < 12; y++) for (let x = 0; x < 4; x++) {
			expect(px(out, W, 20 + x, 52 + y)).toEqual(px(src, W, 4 + 3 - x, 20 + y));
		}
	});
});
