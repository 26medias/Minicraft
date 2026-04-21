import { describe, it, expect } from 'vitest';
import {
	CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z,
	WORLD_CHUNKS_X,
	BLOCKS_PER_CHUNK,
	indexOf, worldToChunk, inBounds,
} from './coords';

describe('coords', () => {
	it('has the documented chunk shape', () => {
		expect(CHUNK_SIZE_X).toBe(16);
		expect(CHUNK_SIZE_Y).toBe(64);
		expect(CHUNK_SIZE_Z).toBe(16);
		expect(BLOCKS_PER_CHUNK).toBe(16 * 64 * 16);
	});

	it('indexOf is bijective within a chunk', () => {
		const seen = new Set<number>();
		for (let y = 0; y < CHUNK_SIZE_Y; y++) {
			for (let z = 0; z < CHUNK_SIZE_Z; z++) {
				for (let x = 0; x < CHUNK_SIZE_X; x++) {
					const i = indexOf(x, y, z);
					expect(i).toBeGreaterThanOrEqual(0);
					expect(i).toBeLessThan(BLOCKS_PER_CHUNK);
					expect(seen.has(i)).toBe(false);
					seen.add(i);
				}
			}
		}
		expect(seen.size).toBe(BLOCKS_PER_CHUNK);
	});

	it('worldToChunk splits into chunk + local coords', () => {
		expect(worldToChunk(0, 0)).toEqual({ cx: 0, cz: 0, lx: 0, lz: 0 });
		expect(worldToChunk(15, 15)).toEqual({ cx: 0, cz: 0, lx: 15, lz: 15 });
		expect(worldToChunk(16, 0)).toEqual({ cx: 1, cz: 0, lx: 0, lz: 0 });
		expect(worldToChunk(17, 32)).toEqual({ cx: 1, cz: 2, lx: 1, lz: 0 });
	});

	it('inBounds respects the finite world', () => {
		expect(inBounds(0, 0, 0)).toBe(true);
		expect(inBounds(CHUNK_SIZE_X * WORLD_CHUNKS_X - 1, 0, 0)).toBe(true);
		expect(inBounds(CHUNK_SIZE_X * WORLD_CHUNKS_X, 0, 0)).toBe(false);
		expect(inBounds(0, -1, 0)).toBe(false);
		expect(inBounds(0, CHUNK_SIZE_Y, 0)).toBe(false);
	});
});
