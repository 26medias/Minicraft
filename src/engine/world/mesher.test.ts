import { describe, it, expect } from 'vitest';
import { Chunk } from './chunk';
import { meshChunk } from './mesher';
import { BLOCK_BY_NAME } from '../../data/blocks.data';
import { World } from './world';
import { indexOf } from './coords';
import { fillChunkLights } from './lighting';
import { computeChunkShadows } from './shadows';

const stone = BLOCK_BY_NAME['stone'].id;

function uvStub() {
	return [0, 0, 1, 1] as [number, number, number, number];
}

describe('meshChunk', () => {
	it('empty chunk produces no geometry', () => {
		const c = new Chunk(0, 0);
		const result = meshChunk(c, {}, uvStub);
		expect(result.opaque.indices.length).toBe(0);
	});

	it('one isolated block produces 6 faces (36 indices, 24 vertices)', () => {
		const c = new Chunk(0, 0);
		c.set(5, 5, 5, stone);
		const result = meshChunk(c, {}, uvStub);
		expect(result.opaque.indices.length).toBe(36);
		expect(result.opaque.positions.length).toBe(24 * 3);
		expect(result.opaque.uvs.length).toBe(24 * 2);
	});

	it('two adjacent blocks share a hidden face (10 faces, not 12)', () => {
		const c = new Chunk(0, 0);
		c.set(5, 5, 5, stone);
		c.set(6, 5, 5, stone);
		const result = meshChunk(c, {}, uvStub);
		expect(result.opaque.indices.length).toBe(10 * 6);
	});

	it('emits face toward missing neighbor (world edge)', () => {
		const c = new Chunk(0, 0);
		c.set(0, 5, 5, stone);
		// no nx neighbor => the nx face is emitted (world boundary)
		const result = meshChunk(c, {}, uvStub);
		expect(result.opaque.indices.length).toBe(36);
	});

	it('uses the neighbor chunk when provided at a chunk edge', () => {
		const c = new Chunk(0, 0);
		c.set(15, 5, 5, stone); // x = CHUNK_SIZE_X - 1

		const nx = new Chunk(1, 0);
		nx.set(0, 5, 5, stone); // touches c at +x boundary

		const result = meshChunk(c, { px: nx }, uvStub);
		// c's +x face should be hidden by nx's block
		expect(result.opaque.indices.length).toBe(5 * 6);
	});

	it('side face maps world y=0 to v0 and y=1 to v1 (not upside-down)', () => {
		const c = new Chunk(0, 0);
		c.set(5, 5, 5, stone);
		// Distinguishable corners so u0/v0/u1/v1 are each identifiable in the output.
		const uv = (): [number, number, number, number] => [0.1, 0.2, 0.8, 0.9];
		const result = meshChunk(c, {}, uv);
		// FACE_ORDER starts with 'px'. Its corners are ordered [y=0, y=0, y=1, y=1].
		// Expected UV layout (u, v) per corner: (u0, v0), (u1, v0), (u1, v1), (u0, v1).
		// toBeCloseTo accounts for Float32Array rounding.
		expect(result.opaque.uvs[0]).toBeCloseTo(0.1); // corner 0 U = u0
		expect(result.opaque.uvs[1]).toBeCloseTo(0.2); // corner 0 V = v0  (bottom of tile, y=0)
		expect(result.opaque.uvs[2]).toBeCloseTo(0.8); // corner 1 U = u1
		expect(result.opaque.uvs[3]).toBeCloseTo(0.2); // corner 1 V = v0  (bottom of tile, y=0)
		expect(result.opaque.uvs[4]).toBeCloseTo(0.8); // corner 2 U = u1
		expect(result.opaque.uvs[5]).toBeCloseTo(0.9); // corner 2 V = v1  (top of tile, y=1)
		expect(result.opaque.uvs[6]).toBeCloseTo(0.1); // corner 3 U = u0
		expect(result.opaque.uvs[7]).toBeCloseTo(0.9); // corner 3 V = v1  (top of tile, y=1)
	});
});

describe('meshChunk — per-vertex colors from lightmap', () => {
	it('mesh includes a colors attribute matching positions in length', () => {
		const w = new World(1);
		const c = w.ensureChunk(0, 0);
		c.blocks[indexOf(1, 30, 1)] = BLOCK_BY_NAME['stone'].id;
		fillChunkLights(w, c);
		const result = meshChunk(c, w.neighbors(c), (_id, _face) => [0, 0, 1, 1]);
		expect(result.opaque.colors).toBeInstanceOf(Float32Array);
		expect(result.opaque.colors.length).toBe(result.opaque.positions.length);
	});

	it('a fully-lit vertex (sky=15) has a bright RGB', () => {
		const w = new World(1);
		const c = w.ensureChunk(0, 0);
		c.blocks.fill(0);
		c.blocks[indexOf(5, 30, 5)] = BLOCK_BY_NAME['stone'].id;
		fillChunkLights(w, c);
		computeChunkShadows(w, c);
		const result = meshChunk(c, w.neighbors(c), (_id, _face) => [0, 0, 1, 1]);
		const mesh = result.opaque;
		let topFaceVertexCount = 0;
		for (let i = 0; i < mesh.normals.length; i += 3) {
			if (mesh.normals[i + 1] > 0.9) {
				const r = mesh.colors[i];
				const g = mesh.colors[i + 1];
				const b = mesh.colors[i + 2];
				expect(Number.isNaN(r)).toBe(false);
				expect(Number.isNaN(g)).toBe(false);
				expect(Number.isNaN(b)).toBe(false);
				// With shadow computation: open sky voxel is sunlit=1, so shadowFactor=1.0.
				// r+g+b must exceed 1.5 for clearly sunlit geometry.
				expect(r + g + b).toBeGreaterThan(1.5);
				topFaceVertexCount++;
			}
		}
		expect(topFaceVertexCount).toBe(4); // all 4 top-face corners are bright
	});
});

describe('meshChunk — ambient occlusion', () => {
	it('vertex adjacent to two solid blocks above is darker than one with zero', () => {
		const w = new World(1);
		const c = w.ensureChunk(0, 0);
		c.blocks.fill(0);
		// The face block itself.
		c.blocks[indexOf(5, 30, 5)] = BLOCK_BY_NAME['stone'].id;
		// Two "towers" above the face — these are the edge voxels for the top-face corner at (6, 31, 6).
		c.blocks[indexOf(6, 31, 5)] = BLOCK_BY_NAME['stone'].id;
		c.blocks[indexOf(5, 31, 6)] = BLOCK_BY_NAME['stone'].id;
		fillChunkLights(w, c);
		const result = meshChunk(c, w.neighbors(c), (_id, _face) => [0, 0, 1, 1]);
		const mesh = result.opaque;
		const verts: { pos: [number, number, number]; rgb: [number, number, number] }[] = [];
		for (let i = 0; i < mesh.positions.length; i += 3) {
			const px = mesh.positions[i],
				py = mesh.positions[i + 1],
				pz = mesh.positions[i + 2];
			const ny = mesh.normals[i + 1];
			// Top face of (5, 30, 5) — corners at py=31, x in [5,6], z in [5,6].
			if (ny > 0.9 && py === 31 && px >= 5 && px <= 6 && pz >= 5 && pz <= 6) {
				verts.push({
					pos: [px, py, pz],
					rgb: [mesh.colors[i], mesh.colors[i + 1], mesh.colors[i + 2]],
				});
			}
		}
		const cornerWithAO = verts.find((v) => v.pos[0] === 6 && v.pos[2] === 6);
		const cornerWithoutAO = verts.find((v) => v.pos[0] === 5 && v.pos[2] === 5);
		expect(cornerWithAO).toBeDefined();
		expect(cornerWithoutAO).toBeDefined();
		const sumAO = cornerWithAO!.rgb.reduce((a, b) => a + b, 0);
		const sumNoAO = cornerWithoutAO!.rgb.reduce((a, b) => a + b, 0);
		expect(sumAO).toBeLessThan(sumNoAO);
	});
});

describe('meshChunk — opaque + liquid split', () => {
	it('returns an object with opaque and liquid meshes', () => {
		const w = new World(1);
		const c = w.ensureChunk(0, 0);
		c.blocks.fill(0);
		c.blocks[indexOf(5, 30, 5)] = BLOCK_BY_NAME['stone'].id;
		c.blocks[indexOf(5, 31, 5)] = BLOCK_BY_NAME['water'].id;
		fillChunkLights(w, c);
		const result = meshChunk(c, w.neighbors(c), (_id, _face) => [0, 0, 1, 1]);
		expect(result.opaque).toBeDefined();
		expect(result.liquid).toBeDefined();
		expect(result.opaque.positions.length).toBeGreaterThan(0);
		expect(result.liquid!.positions.length).toBeGreaterThan(0);
	});

	it('water-water adjacency emits no face; water-air emits the water face', () => {
		const w = new World(1);
		const c = w.ensureChunk(0, 0);
		c.blocks.fill(0);
		c.blocks[indexOf(5, 30, 5)] = BLOCK_BY_NAME['water'].id;
		c.blocks[indexOf(6, 30, 5)] = BLOCK_BY_NAME['water'].id;
		fillChunkLights(w, c);
		const result = meshChunk(c, w.neighbors(c), (_id, _face) => [0, 0, 1, 1]);
		// 2 water blocks × 6 faces - 2 shared faces = 10 faces = 40 vertices = 120 position values.
		expect(result.liquid).not.toBeNull();
		expect(result.liquid!.positions.length).toBe(120);
	});
});

describe('translucent pass', () => {
	const glass = BLOCK_BY_NAME['blue_stained_glass'].id;
	it('emits a translucent block in its own bucket, not the opaque one', () => {
		const c = new Chunk(0, 0);
		c.set(5, 5, 5, glass);
		const r = meshChunk(c, {}, uvStub);
		expect(r.opaque.indices.length).toBe(0);
		expect(r.translucent!.indices.length).toBe(36);
	});
	it('an opaque neighbour still emits its face toward stained glass', () => {
		const c = new Chunk(0, 0);
		c.set(5, 5, 5, glass);
		c.set(6, 5, 5, stone);
		const r = meshChunk(c, {}, uvStub);
		expect(r.opaque.indices.length).toBe(36);      // all six stone faces (glass is see-through)
		expect(r.translucent!.indices.length).toBe(30); // glass hides its face against stone
	});
	it('two adjacent identical stained glass blocks share no face', () => {
		const c = new Chunk(0, 0);
		c.set(5, 5, 5, glass);
		c.set(6, 5, 5, glass);
		const r = meshChunk(c, {}, uvStub);
		expect(r.translucent!.indices.length).toBe(60);
	});
});
