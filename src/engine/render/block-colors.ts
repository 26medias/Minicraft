// Per-block minimap colours (spec §7.6): the mean top-face colour from the atlas, 3 bytes per id.
import { BLOCKS, type BlockId, type Face } from '../../data/blocks.data';
import type { LoadedAtlas } from './atlas';
import type { TileRect } from './uv-table';

/** What the colour table needs from an atlas: its RGBA pixels and each block's face rect. */
export type ColorAtlas = {
	size: number;
	/** RGBA, row-major, `size × size`. */
	pixels: ArrayLike<number>;
	tileRect: (id: BlockId, face: Face) => TileRect | null;
};

/** Colour of a block with no top texture (air, tombstones): neutral grey, never black. */
const UNTEXTURED = 128;

/** `[r, g, b]` at `id * 3`: the mean of the top face's opaque pixels (alpha > 0). */
export function buildColorTable(atlas: ColorAtlas): Uint8Array {
	const table = new Uint8Array(BLOCKS.length * 3).fill(UNTEXTURED);
	const { size, pixels } = atlas;
	for (let id = 0; id < BLOCKS.length; id++) {
		const rect = atlas.tileRect(id, 'py');
		if (!rect) continue;
		let r = 0, g = 0, b = 0, n = 0;
		for (let y = rect.v; y < rect.v + rect.h; y++) {
			for (let x = rect.u; x < rect.u + rect.w; x++) {
				const o = (y * size + x) * 4;
				if (pixels[o + 3] === 0) continue;
				r += pixels[o]; g += pixels[o + 1]; b += pixels[o + 2]; n++;
			}
		}
		if (n === 0) continue;
		table[id * 3] = Math.round(r / n);
		table[id * 3 + 1] = Math.round(g / n);
		table[id * 3 + 2] = Math.round(b / n);
	}
	return table;
}

/** Reads the loaded atlas image back through a 2D canvas (browser only) and builds the table. */
export function colorTableFromAtlas(atlas: LoadedAtlas): Uint8Array {
	const img = atlas.texture.image as CanvasImageSource;
	const canvas = document.createElement('canvas');
	canvas.width = atlas.size;
	canvas.height = atlas.size;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) return new Uint8Array(BLOCKS.length * 3).fill(UNTEXTURED);
	ctx.drawImage(img, 0, 0);
	const pixels = ctx.getImageData(0, 0, atlas.size, atlas.size).data;
	return buildColorTable({ size: atlas.size, pixels, tileRect: atlas.tileRect });
}
