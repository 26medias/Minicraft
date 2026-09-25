import { describe, it, expect } from 'vitest';
import { faceRects, partSpecs, boxUVs, FACE_ORDER, FACE_CORNERS, cornerPx, pxToUv, SKIN_FLIP_Y } from './skin-uv';

describe('faceRects', () => {
	it('head (0,0) 8×8×8', () => {
		expect(faceRects(0, 0, 8, 8, 8)).toEqual({
			right: { x: 0, y: 8, w: 8, h: 8 }, front: { x: 8, y: 8, w: 8, h: 8 },
			left: { x: 16, y: 8, w: 8, h: 8 }, back: { x: 24, y: 8, w: 8, h: 8 },
			top: { x: 8, y: 0, w: 8, h: 8 }, bottom: { x: 16, y: 0, w: 8, h: 8 },
		});
	});
	it('classic right arm (40,16) 4×12×4', () => {
		expect(faceRects(40, 16, 4, 12, 4)).toEqual({
			right: { x: 40, y: 20, w: 4, h: 12 }, front: { x: 44, y: 20, w: 4, h: 12 },
			left: { x: 48, y: 20, w: 4, h: 12 }, back: { x: 52, y: 20, w: 4, h: 12 },
			top: { x: 44, y: 16, w: 4, h: 4 }, bottom: { x: 48, y: 16, w: 4, h: 4 },
		});
	});
	it('slim right arm (40,16) 3×12×4', () => {
		expect(faceRects(40, 16, 3, 12, 4)).toEqual({
			right: { x: 40, y: 20, w: 4, h: 12 }, front: { x: 44, y: 20, w: 3, h: 12 },
			left: { x: 47, y: 20, w: 4, h: 12 }, back: { x: 51, y: 20, w: 3, h: 12 },
			top: { x: 44, y: 16, w: 3, h: 4 }, bottom: { x: 47, y: 16, w: 3, h: 4 },
		});
	});
});

describe('partSpecs', () => {
	it('classic and slim pivots/offsets match vanilla (spec §5)', () => {
		const c = Object.fromEntries(partSpecs(false).map((p) => [p.name, p]));
		const s = Object.fromEntries(partSpecs(true).map((p) => [p.name, p]));
		expect(c.head).toMatchObject({ size: [8, 8, 8], pivot: [0, 24, 0], offset: [0, 4, 0], base: [0, 0], overlay: [32, 0], inflate: 0.5 });
		expect(c.body).toMatchObject({ size: [8, 12, 4], pivot: [0, 24, 0], offset: [0, -6, 0], base: [16, 16], overlay: [16, 32], inflate: 0.25 });
		expect(c.rightArm).toMatchObject({ size: [4, 12, 4], pivot: [5, 22, 0], offset: [1, -4, 0], base: [40, 16], overlay: [40, 32] });
		expect(c.leftArm).toMatchObject({ size: [4, 12, 4], pivot: [-5, 22, 0], offset: [-1, -4, 0], base: [32, 48], overlay: [48, 48] });
		expect(s.rightArm).toMatchObject({ size: [3, 12, 4], pivot: [5, 21.5, 0], offset: [0.5, -4, 0] });
		expect(s.leftArm).toMatchObject({ size: [3, 12, 4], pivot: [-5, 21.5, 0], offset: [-0.5, -4, 0] });
		expect(c.rightLeg).toMatchObject({ size: [4, 12, 4], pivot: [1.9, 12, 0], offset: [0, -6, 0], base: [0, 16], overlay: [0, 32] });
		expect(c.leftLeg).toMatchObject({ size: [4, 12, 4], pivot: [-1.9, 12, 0], offset: [0, -6, 0], base: [16, 48], overlay: [0, 48] });
	});
});

describe('boxUVs', () => {
	it('writes each vertex at the corner §5 assigns it', () => {
		const rects = faceRects(0, 0, 8, 8, 8);
		const uv = boxUVs(rects);
		expect(uv).toHaveLength(48);
		FACE_ORDER.forEach((face, f) => {
			FACE_CORNERS[face].forEach((corner, k) => {
				const [px, py] = cornerPx(rects[face], corner);
				const [u, v] = pxToUv(px, py);
				expect(uv[(f * 4 + k) * 2]).toBeCloseTo(u, 9);
				expect(uv[(f * 4 + k) * 2 + 1]).toBeCloseTo(v, 9);
			});
		});
		expect(FACE_CORNERS.top).toEqual(['BR', 'BL', 'TR', 'TL']);
		expect(FACE_CORNERS.bottom).toEqual(['TR', 'TL', 'BR', 'BL']);
		expect(FACE_CORNERS.front).toEqual(['TL', 'TR', 'BL', 'BR']);
		expect(pxToUv(0, 16)).toEqual([0, SKIN_FLIP_Y ? 0.75 : 0.25]);
	});
});
