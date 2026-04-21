import { describe, it, expect } from 'vitest';
import { Chunk } from './chunk';
import { generateChunk } from './generation';
import { BLOCK_BY_NAME } from '../../data/blocks.data';
import { CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z } from './coords';

describe('generateChunk', () => {
	it('is deterministic for a given seed + chunk coord', () => {
		const a = new Chunk(3, 5);
		const b = new Chunk(3, 5);
		generateChunk(a, 12345);
		generateChunk(b, 12345);
		expect(a.blocks).toEqual(b.blocks);
	});

	it('differs across seeds', () => {
		const a = new Chunk(0, 0);
		const b = new Chunk(0, 0);
		generateChunk(a, 1);
		generateChunk(b, 2);
		expect(a.blocks).not.toEqual(b.blocks);
	});

	it('differs across chunk coords within a seed', () => {
		const a = new Chunk(0, 0);
		const b = new Chunk(1, 0);
		generateChunk(a, 42);
		generateChunk(b, 42);
		expect(a.blocks).not.toEqual(b.blocks);
	});

	it("clears the modified flag so un-touched chunks don't persist", () => {
		const c = new Chunk(0, 0);
		generateChunk(c, 1);
		expect(c.modified).toBe(false);
	});

	it('produces a grass top, dirt band, stone below', () => {
		const c = new Chunk(0, 0);
		generateChunk(c, 42);
		const grass = BLOCK_BY_NAME['grass_block'].id;
		const dirt = BLOCK_BY_NAME['dirt'].id;
		const stone = BLOCK_BY_NAME['stone'].id;

		for (let lz = 0; lz < CHUNK_SIZE_Z; lz++) {
			for (let lx = 0; lx < CHUNK_SIZE_X; lx++) {
				let topY = -1;
				for (let y = CHUNK_SIZE_Y - 1; y >= 0; y--) {
					if (c.get(lx, y, lz) !== 0) {
						topY = y;
						break;
					}
				}
				expect(topY).toBeGreaterThan(0);
				expect(c.get(lx, topY, lz)).toBe(grass);
				if (topY >= 3) {
					expect(c.get(lx, topY - 1, lz)).toBe(dirt);
					expect(c.get(lx, topY - 2, lz)).toBe(dirt);
					expect(c.get(lx, topY - 3, lz)).toBe(dirt);
					expect(c.get(lx, topY - 4, lz)).toBe(stone);
				}
			}
		}
	});
});
