import { describe, it, expect } from 'vitest';
import { Chunk } from './chunk';
import { BLOCKS_PER_CHUNK } from './coords';

describe('Chunk', () => {
	it('initialises to all air', () => {
		const c = new Chunk(0, 0);
		expect(c.blocks.length).toBe(BLOCKS_PER_CHUNK);
		for (let i = 0; i < BLOCKS_PER_CHUNK; i++) {
			expect(c.blocks[i]).toBe(0);
		}
		expect(c.modified).toBe(false);
	});

	it('starts dirty (needs meshing)', () => {
		const c = new Chunk(0, 0);
		expect(c.dirty).toBe(true);
	});

	it('get/set round-trip', () => {
		const c = new Chunk(3, 7);
		c.set(1, 2, 3, 42);
		expect(c.get(1, 2, 3)).toBe(42);
	});

	it('marks dirty and modified on a real change', () => {
		const c = new Chunk(0, 0);
		c.dirty = false;
		c.set(5, 5, 5, 1);
		expect(c.dirty).toBe(true);
		expect(c.modified).toBe(true);
	});

	it('does not mark dirty when writing the same value', () => {
		const c = new Chunk(0, 0);
		c.set(5, 5, 5, 1);
		c.modified = false;
		c.dirty = false;
		c.set(5, 5, 5, 1);
		expect(c.dirty).toBe(false);
		expect(c.modified).toBe(false);
	});
});

describe('Chunk lightmap', () => {
	it('lights array is allocated and initially all zero', () => {
		const c = new Chunk(0, 0);
		expect(c.lights.length).toBe(BLOCKS_PER_CHUNK);
		for (let i = 0; i < BLOCKS_PER_CHUNK; i++) {
			expect(c.lights[i]).toBe(0);
		}
	});

	it('setSky / getSky round-trip for values 0-15', () => {
		const c = new Chunk(0, 0);
		for (let v = 0; v <= 15; v++) {
			c.setSky(1, 2, 3, v);
			expect(c.getSky(1, 2, 3)).toBe(v);
		}
	});

	it('setBlockRGB / getBlockR/G/B round-trip independently', () => {
		const c = new Chunk(0, 0);
		c.setBlockRGB(5, 6, 7, 15, 10, 3);
		expect(c.getBlockR(5, 6, 7)).toBe(15);
		expect(c.getBlockG(5, 6, 7)).toBe(10);
		expect(c.getBlockB(5, 6, 7)).toBe(3);
	});

	it('setting one channel does not affect the others', () => {
		const c = new Chunk(0, 0);
		c.setBlockRGB(5, 6, 7, 15, 10, 3);
		c.setSky(5, 6, 7, 7);
		expect(c.getSky(5, 6, 7)).toBe(7);
		expect(c.getBlockR(5, 6, 7)).toBe(15);
		expect(c.getBlockG(5, 6, 7)).toBe(10);
		expect(c.getBlockB(5, 6, 7)).toBe(3);
	});

	it('values above 15 are masked to 4 bits', () => {
		const c = new Chunk(0, 0);
		c.setSky(0, 0, 0, 31);
		expect(c.getSky(0, 0, 0)).toBe(15);
	});
});

describe('Chunk.liquidFrontier', () => {
	it('is an empty Set on a fresh chunk', () => {
		const c = new Chunk(0, 0);
		expect(c.liquidFrontier.size).toBe(0);
	});
});
