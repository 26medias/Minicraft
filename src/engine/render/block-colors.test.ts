import { describe, expect, it } from 'vitest';
import { BLOCK_BY_NAME, BLOCKS, type Face } from '../../data/blocks.data';
import { buildColorTable, type ColorAtlas } from './block-colors';
import type { TileRect } from './uv-table';

const GRASS = BLOCK_BY_NAME['grass_block'].id;
const STONE = BLOCK_BY_NAME['stone'].id;

/**
 * An 8×8 atlas of four 4×4 tiles. Grass's top face is tile (0,0), its side tile (4,0); stone is (0,4).
 * Tile (4,4) is half transparent.
 */
function fakeAtlas(): ColorAtlas {
	const size = 8;
	const pixels = new Uint8ClampedArray(size * size * 4);
	const put = (x: number, y: number, r: number, g: number, b: number, a = 255) => {
		const o = (y * size + x) * 4;
		pixels[o] = r; pixels[o + 1] = g; pixels[o + 2] = b; pixels[o + 3] = a;
	};
	for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
		// Grass top: a checkerboard of (100,200,0) and (0,100,50): mean (50,150,25).
		if ((x + y) % 2 === 0) put(x, y, 100, 200, 0); else put(x, y, 0, 100, 50);
		put(x + 4, y, 255, 0, 0); // grass side: red, must not be used
		put(x, y + 4, 120, 120, 120); // stone
		// Leaves-like: opaque (0,80,0) on the left half, transparent white on the right half.
		if (x < 2) put(x + 4, y + 4, 0, 80, 0); else put(x + 4, y + 4, 255, 255, 255, 0);
	}
	const rects: Record<string, TileRect> = {
		top: { u: 0, v: 0, w: 4, h: 4 },
		side: { u: 4, v: 0, w: 4, h: 4 },
		stone: { u: 0, v: 4, w: 4, h: 4 },
		leaf: { u: 4, v: 4, w: 4, h: 4 },
	};
	const LEAVES = BLOCK_BY_NAME['oak_leaves'].id;
	return {
		size,
		pixels,
		tileRect: (id: number, face: Face) => {
			if (id === GRASS) return face === 'py' ? rects.top : rects.side;
			if (id === STONE) return rects.stone;
			if (id === LEAVES) return rects.leaf;
			return null;
		},
	};
}

describe('buildColorTable (T11)', () => {
	it('gives each block the mean colour of its top face', () => {
		const t = buildColorTable(fakeAtlas());
		expect(t.length).toBe(BLOCKS.length * 3);
		expect([t[GRASS * 3], t[GRASS * 3 + 1], t[GRASS * 3 + 2]]).toEqual([50, 150, 25]);
		expect([t[STONE * 3], t[STONE * 3 + 1], t[STONE * 3 + 2]]).toEqual([120, 120, 120]);
	});

	it('ignores transparent pixels', () => {
		const t = buildColorTable(fakeAtlas());
		const L = BLOCK_BY_NAME['oak_leaves'].id;
		expect([t[L * 3], t[L * 3 + 1], t[L * 3 + 2]]).toEqual([0, 80, 0]);
	});

	it('gives an untextured block a neutral grey, not black', () => {
		const t = buildColorTable(fakeAtlas());
		const id = BLOCK_BY_NAME['sand'].id;
		expect([t[id * 3], t[id * 3 + 1], t[id * 3 + 2]]).toEqual([128, 128, 128]);
	});
});
