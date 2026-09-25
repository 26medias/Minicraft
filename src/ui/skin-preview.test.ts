import { describe, it, expect } from 'vitest';
import { frontPixels, facePixels } from './skin-preview';

/** Skin where every pixel encodes its own coordinates (r = x, g = y, b = 1, a = 255). */
function coords(): Uint8ClampedArray {
	const a = new Uint8ClampedArray(64 * 64 * 4);
	for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) a.set([x, y, 1, 255], (y * 64 + x) * 4);
	return a;
}
const at = (a: Uint8ClampedArray, w: number, x: number, y: number) => Array.from(a.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));

/** Clears alpha in every overlay area (hat, jacket/sleeve/pants rows, left sleeve and pants). */
function noOverlays(a: Uint8ClampedArray): Uint8ClampedArray {
	const clear = (x0: number, y0: number, x1: number, y1: number) => {
		for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) a[(y * 64 + x) * 4 + 3] = 0;
	};
	clear(32, 0, 64, 16); clear(0, 32, 64, 48); clear(0, 48, 16, 64); clear(48, 48, 64, 64);
	return a;
}

describe('skin previews', () => {
	it('front: head, body, arms (char right on viewer left), legs from the vanilla front rects', () => {
		const f = frontPixels(noOverlays(coords()), false);
		expect(at(f, 16, 4, 0)).toEqual([8, 8, 1, 255]); // head front TL
		expect(at(f, 16, 4, 8)).toEqual([20, 20, 1, 255]); // body front TL
		expect(at(f, 16, 0, 8)).toEqual([44, 20, 1, 255]); // right arm front TL, viewer's left
		expect(at(f, 16, 12, 8)).toEqual([36, 52, 1, 255]); // left arm front TL
		expect(at(f, 16, 4, 20)).toEqual([4, 20, 1, 255]); // right leg front TL
		expect(at(f, 16, 8, 20)).toEqual([20, 52, 1, 255]); // left leg front TL
		// Each base part's bottom-right pixel.
		expect(at(f, 16, 11, 7)).toEqual([15, 15, 1, 255]); // head BR
		expect(at(f, 16, 11, 19)).toEqual([27, 31, 1, 255]); // body BR
		expect(at(f, 16, 3, 19)).toEqual([47, 31, 1, 255]); // right arm BR
		expect(at(f, 16, 15, 19)).toEqual([39, 63, 1, 255]); // left arm BR
		expect(at(f, 16, 7, 31)).toEqual([7, 31, 1, 255]); // right leg BR
		expect(at(f, 16, 11, 31)).toEqual([23, 63, 1, 255]); // left leg BR
	});

	it('slim arms are 3 px: the outer column is empty', () => {
		const f = frontPixels(noOverlays(coords()), true);
		expect(at(f, 16, 0, 10)[3]).toBe(0);
		expect(at(f, 16, 1, 10)).toEqual([44, 22, 1, 255]);
		expect(at(f, 16, 15, 10)[3]).toBe(0);
	});

	it('an opaque hat pixel covers the face; a transparent one does not', () => {
		const skin = coords();
		skin.set([250, 0, 0, 255], (8 * 64 + 40) * 4); // hat front TL opaque
		skin.set([250, 0, 0, 0], (8 * 64 + 41) * 4); // next one transparent
		const face = facePixels(skin);
		expect(at(face, 8, 0, 0)).toEqual([250, 0, 0, 255]);
		expect(at(face, 8, 1, 0)).toEqual([9, 8, 1, 255]);
	});

	it('every overlay front covers its part, corner to corner', () => {
		// [overlay front rect x, y, w, h] → [preview x, y] (classic arms)
		const cases: Array<[string, number, number, number, number, number, number]> = [
			['hat', 40, 8, 8, 8, 4, 0], ['jacket', 20, 36, 8, 12, 4, 8],
			['rightSleeve', 44, 36, 4, 12, 0, 8], ['leftSleeve', 52, 52, 4, 12, 12, 8],
			['rightPants', 4, 36, 4, 12, 4, 20], ['leftPants', 4, 52, 4, 12, 8, 20],
		];
		for (const [name, x, y, w, h, dx, dy] of cases) {
			const skin = noOverlays(coords());
			skin.set([250, 1, 2, 255], (y * 64 + x) * 4); // TL marker
			skin.set([250, 3, 4, 255], ((y + h - 1) * 64 + x + w - 1) * 4); // BR marker
			const f = frontPixels(skin, false);
			expect(at(f, 16, dx, dy), `${name} TL`).toEqual([250, 1, 2, 255]);
			expect(at(f, 16, dx + w - 1, dy + h - 1), `${name} BR`).toEqual([250, 3, 4, 255]);
		}
	});
});
