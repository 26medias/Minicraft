import { skinOf } from '../data/skins.data';
import { loadSkinPixels } from '../engine/render/skin-textures';

type Blit = { sx: number; sy: number; w: number; h: number; dx: number; dy: number };

function compose(skin: Uint8ClampedArray, w: number, h: number, blits: Blit[]): Uint8ClampedArray {
	const out = new Uint8ClampedArray(w * h * 4);
	for (const b of blits) {
		for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
			const s = ((b.sy + y) * 64 + b.sx + x) * 4;
			if (skin[s + 3] < 128) continue;
			out.set(skin.subarray(s, s + 4), ((b.dy + y) * w + b.dx + x) * 4);
		}
	}
	return out;
}

/** The character's front, 16×32: base then overlay for each part. Char's right is on the viewer's left. */
export function frontPixels(skin: Uint8ClampedArray, slim: boolean): Uint8ClampedArray {
	const aw = slim ? 3 : 4;
	return compose(skin, 16, 32, [
		{ sx: 8, sy: 8, w: 8, h: 8, dx: 4, dy: 0 }, { sx: 40, sy: 8, w: 8, h: 8, dx: 4, dy: 0 },
		{ sx: 20, sy: 20, w: 8, h: 12, dx: 4, dy: 8 }, { sx: 20, sy: 36, w: 8, h: 12, dx: 4, dy: 8 },
		{ sx: 44, sy: 20, w: aw, h: 12, dx: 4 - aw, dy: 8 }, { sx: 44, sy: 36, w: aw, h: 12, dx: 4 - aw, dy: 8 },
		{ sx: 36, sy: 52, w: aw, h: 12, dx: 12, dy: 8 }, { sx: 52, sy: 52, w: aw, h: 12, dx: 12, dy: 8 },
		{ sx: 4, sy: 20, w: 4, h: 12, dx: 4, dy: 20 }, { sx: 4, sy: 36, w: 4, h: 12, dx: 4, dy: 20 },
		{ sx: 20, sy: 52, w: 4, h: 12, dx: 8, dy: 20 }, { sx: 4, sy: 52, w: 4, h: 12, dx: 8, dy: 20 },
	]);
}

/** The face with its hat, 8×8. */
export function facePixels(skin: Uint8ClampedArray): Uint8ClampedArray {
	return compose(skin, 8, 8, [{ sx: 8, sy: 8, w: 8, h: 8, dx: 0, dy: 0 }, { sx: 40, sy: 8, w: 8, h: 8, dx: 0, dy: 0 }]);
}

/** Draws a preview into `canvas` once the skin decodes (CSS scales it with image-rendering: pixelated). */
export function paintPreview(canvas: HTMLCanvasElement, id: string, kind: 'front' | 'face'): void {
	const row = skinOf(id);
	const [w, h] = kind === 'front' ? [16, 32] : [8, 8];
	canvas.width = w;
	canvas.height = h;
	loadSkinPixels(row.id).then((px) => {
		const data = kind === 'front' ? frontPixels(px, row.slim) : facePixels(px);
		canvas.getContext('2d')?.putImageData(new ImageData(data, w, h), 0, 0);
	}, (e) => console.warn(`skin preview ${id} failed`, e));
}
