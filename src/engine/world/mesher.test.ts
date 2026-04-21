import { describe, it, expect } from 'vitest';
import { Chunk } from './chunk';
import { meshChunk } from './mesher';
import { BLOCK_BY_NAME } from '../../data/blocks.data';

const stone = BLOCK_BY_NAME['stone'].id;

function uvStub() {
	return [0, 0, 1, 1] as [number, number, number, number];
}

describe('meshChunk', () => {
	it('empty chunk produces no geometry', () => {
		const c = new Chunk(0, 0);
		const mesh = meshChunk(c, {}, uvStub);
		expect(mesh.indices.length).toBe(0);
	});

	it('one isolated block produces 6 faces (36 indices, 24 vertices)', () => {
		const c = new Chunk(0, 0);
		c.set(5, 5, 5, stone);
		const mesh = meshChunk(c, {}, uvStub);
		expect(mesh.indices.length).toBe(36);
		expect(mesh.positions.length).toBe(24 * 3);
		expect(mesh.uvs.length).toBe(24 * 2);
	});

	it('two adjacent blocks share a hidden face (10 faces, not 12)', () => {
		const c = new Chunk(0, 0);
		c.set(5, 5, 5, stone);
		c.set(6, 5, 5, stone);
		const mesh = meshChunk(c, {}, uvStub);
		expect(mesh.indices.length).toBe(10 * 6);
	});

	it('emits face toward missing neighbor (world edge)', () => {
		const c = new Chunk(0, 0);
		c.set(0, 5, 5, stone);
		// no nx neighbor => the nx face is emitted (world boundary)
		const mesh = meshChunk(c, {}, uvStub);
		expect(mesh.indices.length).toBe(36);
	});

	it('uses the neighbor chunk when provided at a chunk edge', () => {
		const c = new Chunk(0, 0);
		c.set(15, 5, 5, stone); // x = CHUNK_SIZE_X - 1

		const nx = new Chunk(1, 0);
		nx.set(0, 5, 5, stone); // touches c at +x boundary

		const mesh = meshChunk(c, { px: nx }, uvStub);
		// c's +x face should be hidden by nx's block
		expect(mesh.indices.length).toBe(5 * 6);
	});
});
