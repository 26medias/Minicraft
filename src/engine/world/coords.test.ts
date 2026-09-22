import { describe, it, expect } from 'vitest';
import {
	CHUNK_SIZE_X, CHUNK_SIZE_Z, WORLD_CHUNKS_X, LEGACY_HEIGHT,
	blocksPerChunk, indexOf, worldToChunk, inBounds,
} from './coords';

describe('coords', () => {
	it('has the documented chunk footprint', () => {
		expect(CHUNK_SIZE_X).toBe(16);
		expect(CHUNK_SIZE_Z).toBe(16);
		expect(LEGACY_HEIGHT).toBe(64);
	});

	it('blocksPerChunk accepts exactly the two world heights', () => {
		expect(blocksPerChunk(64)).toBe(16384);
		expect(blocksPerChunk(256)).toBe(65536);
		expect(() => blocksPerChunk(128)).toThrow(RangeError);
		expect(() => blocksPerChunk(Number.NaN)).toThrow(RangeError);
		expect(() => blocksPerChunk(undefined as unknown as number)).toThrow(RangeError);
	});

	it('indexOf is bijective within a chunk at both heights', () => {
		for (const h of [64, 256]) {
			const seen = new Set<number>();
			for (let y = 0; y < h; y++)
				for (let z = 0; z < CHUNK_SIZE_Z; z++)
					for (let x = 0; x < CHUNK_SIZE_X; x++) {
						const i = indexOf(x, y, z);
						expect(i).toBeGreaterThanOrEqual(0);
						expect(i).toBeLessThan(blocksPerChunk(h));
						expect(seen.has(i)).toBe(false);
						seen.add(i);
					}
			expect(seen.size).toBe(blocksPerChunk(h));
		}
	});

	it('worldToChunk splits into chunk + local coords', () => {
		expect(worldToChunk(0, 0)).toEqual({ cx: 0, cz: 0, lx: 0, lz: 0 });
		expect(worldToChunk(15, 15)).toEqual({ cx: 0, cz: 0, lx: 15, lz: 15 });
		expect(worldToChunk(16, 0)).toEqual({ cx: 1, cz: 0, lx: 0, lz: 0 });
		expect(worldToChunk(17, 32)).toEqual({ cx: 1, cz: 2, lx: 1, lz: 0 });
	});

	it('inBounds respects the finite world at the given height', () => {
		expect(inBounds(0, 0, 0, 64)).toBe(true);
		expect(inBounds(CHUNK_SIZE_X * WORLD_CHUNKS_X - 1, 0, 0, 64)).toBe(true);
		expect(inBounds(CHUNK_SIZE_X * WORLD_CHUNKS_X, 0, 0, 64)).toBe(false);
		expect(inBounds(0, -1, 0, 64)).toBe(false);
		expect(inBounds(0, 64, 0, 64)).toBe(false);
		expect(inBounds(0, 64, 0, 256)).toBe(true);
		expect(inBounds(0, 255, 0, 256)).toBe(true);
		expect(inBounds(0, 256, 0, 256)).toBe(false);
	});
});
