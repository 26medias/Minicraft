import { describe, it, expect } from 'vitest';
import { Chunk } from './chunk';
import { meshChunk } from './mesher';
import { BLOCK_BY_NAME } from '../../data/blocks.data';
import { World } from './world';
import { indexOf } from './coords';
import { fillChunkLights } from './lighting';

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

	it('side face maps world y=0 to v0 and y=1 to v1 (not upside-down)', () => {
		const c = new Chunk(0, 0);
		c.set(5, 5, 5, stone);
		// Distinguishable corners so u0/v0/u1/v1 are each identifiable in the output.
		const uv = (): [number, number, number, number] => [0.1, 0.2, 0.8, 0.9];
		const mesh = meshChunk(c, {}, uv);
		// FACE_ORDER starts with 'px'. Its corners are ordered [y=0, y=0, y=1, y=1].
		// Expected UV layout (u, v) per corner: (u0, v0), (u1, v0), (u1, v1), (u0, v1).
		// toBeCloseTo accounts for Float32Array rounding.
		expect(mesh.uvs[0]).toBeCloseTo(0.1); // corner 0 U = u0
		expect(mesh.uvs[1]).toBeCloseTo(0.2); // corner 0 V = v0  (bottom of tile, y=0)
		expect(mesh.uvs[2]).toBeCloseTo(0.8); // corner 1 U = u1
		expect(mesh.uvs[3]).toBeCloseTo(0.2); // corner 1 V = v0  (bottom of tile, y=0)
		expect(mesh.uvs[4]).toBeCloseTo(0.8); // corner 2 U = u1
		expect(mesh.uvs[5]).toBeCloseTo(0.9); // corner 2 V = v1  (top of tile, y=1)
		expect(mesh.uvs[6]).toBeCloseTo(0.1); // corner 3 U = u0
		expect(mesh.uvs[7]).toBeCloseTo(0.9); // corner 3 V = v1  (top of tile, y=1)
	});
});

describe('meshChunk — per-vertex colors from lightmap', () => {
	it('mesh includes a colors attribute matching positions in length', () => {
		const w = new World(1);
		const c = w.ensureChunk(0, 0);
		c.blocks[indexOf(1, 30, 1)] = BLOCK_BY_NAME['stone'].id;
		fillChunkLights(w, c);
		const mesh = meshChunk(c, w.neighbors(c), (_id, _face) => [0, 0, 1, 1]);
		expect(mesh.colors).toBeInstanceOf(Float32Array);
		expect(mesh.colors.length).toBe(mesh.positions.length);
	});

	it('a fully-lit vertex (sky=15) has a bright RGB', () => {
		const w = new World(1);
		const c = w.ensureChunk(0, 0);
		c.blocks.fill(0);
		c.blocks[indexOf(5, 30, 5)] = BLOCK_BY_NAME['stone'].id;
		fillChunkLights(w, c);
		const mesh = meshChunk(c, w.neighbors(c), (_id, _face) => [0, 0, 1, 1]);
		let topFaceVertexCount = 0;
		for (let i = 0; i < mesh.normals.length; i += 3) {
			if (mesh.normals[i + 1] > 0.9) {
				const r = mesh.colors[i];
				const g = mesh.colors[i + 1];
				const b = mesh.colors[i + 2];
				expect(Number.isNaN(r)).toBe(false);
				expect(Number.isNaN(g)).toBe(false);
				expect(Number.isNaN(b)).toBe(false);
				expect(r + g + b).toBeGreaterThan(1.5);
				topFaceVertexCount++;
			}
		}
		expect(topFaceVertexCount).toBe(4); // all 4 top-face corners are bright
	});
});
