import { describe, it, expect } from 'vitest';
import { World } from './world';
import { BLOCK_BY_NAME, AIR } from '../../data/blocks.data';
import { CHUNK_SIZE_X, WORLD_SIZE_X } from './coords';

describe('World', () => {
	it('generates a chunk on demand', () => {
		const w = new World(42);
		const c = w.ensureChunk(0, 0);
		expect(c.cx).toBe(0);
		expect(c.cz).toBe(0);
	});

	it('returns cached chunk on repeat access', () => {
		const w = new World(42);
		const a = w.ensureChunk(1, 2);
		const b = w.ensureChunk(1, 2);
		expect(a).toBe(b);
	});

	it('reads a block at world coords', () => {
		const w = new World(42);
		const air = w.getBlock(0, 63, 0);
		expect(air).toBe(AIR);
	});

	it('writes a block at world coords and marks chunk modified', () => {
		const w = new World(42);
		const stone = BLOCK_BY_NAME['stone'].id;
		w.setBlock(18, 50, 34, stone);
		expect(w.getBlock(18, 50, 34)).toBe(stone);
		const chunk = w.ensureChunk(1, 2);
		expect(chunk.modified).toBe(true);
	});

	it('treats out-of-bounds as air and rejects writes', () => {
		const w = new World(42);
		expect(w.getBlock(-1, 0, 0)).toBe(AIR);
		expect(w.getBlock(WORLD_SIZE_X, 0, 0)).toBe(AIR);
		const stone = BLOCK_BY_NAME['stone'].id;
		w.setBlock(WORLD_SIZE_X, 0, 0, stone); // no throw
		expect(w.getBlock(WORLD_SIZE_X, 0, 0)).toBe(AIR);
	});

	it('lists only modified chunks', () => {
		const w = new World(1);
		w.ensureChunk(0, 0); // generated but not modified
		const stone = BLOCK_BY_NAME['stone'].id;
		w.setBlock(CHUNK_SIZE_X + 1, 20, 0, stone); // chunk (1, 0)
		const modified = w.modifiedChunks();
		expect(modified.length).toBe(1);
		expect(modified[0].cx).toBe(1);
		expect(modified[0].cz).toBe(0);
	});

	it('exposes the 4 horizontal neighbors for meshing', () => {
		const w = new World(1);
		const center = w.ensureChunk(5, 5);
		const n = w.neighbors(center);
		expect(n.px?.cx).toBe(6);
		expect(n.nx?.cx).toBe(4);
		expect(n.pz?.cz).toBe(6);
		expect(n.nz?.cz).toBe(4);
	});
});
