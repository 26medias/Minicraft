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
