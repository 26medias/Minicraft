/**
 * Minecraft skin UV maths (spec §5). Pure: no three. Skin pixels, y downward, 64×64.
 * The character faces −z; its right is +x. BoxGeometry groups: +x, −x, +y, −y, +z, −z.
 */
export const SKIN_SIZE = 64;
/** World units per skin pixel: the 32-px-tall model is 1.8 blocks. */
export const PX = 1.8 / 32;
/** Textures are DataTextures built from top-down rows, uploaded unflipped. */
export const SKIN_FLIP_Y = false;

export type Rect = { x: number; y: number; w: number; h: number };
export type FaceName = 'right' | 'left' | 'top' | 'bottom' | 'back' | 'front';
export type Corner = 'TL' | 'TR' | 'BL' | 'BR';

/** BoxGeometry's group order: +x (char right), −x, +y, −y, +z (back), −z (front). */
export const FACE_ORDER: readonly FaceName[] = ['right', 'left', 'top', 'bottom', 'back', 'front'];

const SIDE = ['TL', 'TR', 'BL', 'BR'] as const;
/**
 * Which rect corner each BoxGeometry vertex (v0..v3) of a face takes. Sides: v0 is the top-left seen
 * from outside. Top and bottom (vanilla): the rect's left column is at the character's right (+x) and
 * its last row at the front (−z).
 */
export const FACE_CORNERS: Record<FaceName, readonly [Corner, Corner, Corner, Corner]> = {
	right: SIDE, left: SIDE, back: SIDE, front: SIDE,
	top: ['BR', 'BL', 'TR', 'TL'],
	bottom: ['TR', 'TL', 'BR', 'BL'],
};

/** Vanilla box layout for a w×h×d box whose texture origin is (u, v). */
export function faceRects(u: number, v: number, w: number, h: number, d: number): Record<FaceName, Rect> {
	return {
		right: { x: u, y: v + d, w: d, h },
		front: { x: u + d, y: v + d, w, h },
		left: { x: u + d + w, y: v + d, w: d, h },
		back: { x: u + 2 * d + w, y: v + d, w, h },
		top: { x: u + d, y: v, w, h: d },
		bottom: { x: u + d + w, y: v, w, h: d },
	};
}

export function cornerPx(r: Rect, c: Corner): [number, number] {
	return [c === 'TL' || c === 'BL' ? r.x : r.x + r.w, c === 'TL' || c === 'TR' ? r.y : r.y + r.h];
}

export function pxToUv(px: number, py: number): [number, number] {
	return [px / SKIN_SIZE, SKIN_FLIP_Y ? 1 - py / SKIN_SIZE : py / SKIN_SIZE];
}

/** The `uv` attribute (24 vertices × 2) for a BoxGeometry with these face rects. */
export function boxUVs(rects: Record<FaceName, Rect>): Float32Array {
	const out = new Float32Array(48);
	FACE_ORDER.forEach((face, f) => {
		FACE_CORNERS[face].forEach((corner, k) => {
			const [u, v] = pxToUv(...cornerPx(rects[face], corner));
			out[(f * 4 + k) * 2] = u;
			out[(f * 4 + k) * 2 + 1] = v;
		});
	});
	return out;
}

export type PartName = 'head' | 'body' | 'rightArm' | 'leftArm' | 'rightLeg' | 'leftLeg';
export const PART_NAMES: readonly PartName[] = ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'];

/** Skin px, origin at the feet, y up. `offset` is the box centre relative to the pivot. */
export type PartSpec = {
	name: PartName;
	size: [number, number, number];
	pivot: [number, number, number];
	offset: [number, number, number];
	base: [number, number];
	overlay: [number, number];
	inflate: number;
};

export function partSpecs(slim: boolean): PartSpec[] {
	const aw = slim ? 3 : 4;
	const ay = slim ? 21.5 : 22;
	const ao = aw / 2 - 1;
	return [
		{ name: 'head', size: [8, 8, 8], pivot: [0, 24, 0], offset: [0, 4, 0], base: [0, 0], overlay: [32, 0], inflate: 0.5 },
		{ name: 'body', size: [8, 12, 4], pivot: [0, 24, 0], offset: [0, -6, 0], base: [16, 16], overlay: [16, 32], inflate: 0.25 },
		{ name: 'rightArm', size: [aw, 12, 4], pivot: [5, ay, 0], offset: [ao, -4, 0], base: [40, 16], overlay: [40, 32], inflate: 0.25 },
		{ name: 'leftArm', size: [aw, 12, 4], pivot: [-5, ay, 0], offset: [-ao, -4, 0], base: [32, 48], overlay: [48, 48], inflate: 0.25 },
		{ name: 'rightLeg', size: [4, 12, 4], pivot: [1.9, 12, 0], offset: [0, -6, 0], base: [0, 16], overlay: [0, 32], inflate: 0.25 },
		{ name: 'leftLeg', size: [4, 12, 4], pivot: [-1.9, 12, 0], offset: [0, -6, 0], base: [16, 48], overlay: [0, 48], inflate: 0.25 },
	];
}
