import { describe, it, expect } from 'vitest';
import { World } from './world';
import { BLOCK_BY_NAME, AIR } from '../../data/blocks.data';
import { fillChunkLights } from './lighting';
import { computeChunkShadows } from './shadows';
import { indexOf } from './coords';

const stone = BLOCK_BY_NAME['stone'].id;

function emptyWorld(): World {
	const w = new World(1);
	const c = w.ensureChunk(0, 0);
	c.blocks.fill(AIR);
	c.lights.fill(0);
	c.liquidFrontier.clear();
	return w;
}

describe('computeChunkShadows', () => {
	it('opaque block is always in shadow (sunlit=0) regardless of position', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		c.blocks[indexOf(5, 40, 5)] = stone;
		fillChunkLights(w, c);
		computeChunkShadows(w, c);
		expect(c.sunlit[indexOf(5, 40, 5)]).toBe(0);
	});

	it('air voxel under open sky is sunlit (sunlit=1)', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		fillChunkLights(w, c);
		computeChunkShadows(w, c);
		// Any air voxel at mid-height, nothing blocking toward NW-up sun.
		expect(c.sunlit[indexOf(5, 30, 5)]).toBe(1);
	});

	it('air voxel under a roof is in shadow', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		// Roof over entire chunk at y=40.
		for (let dx = 0; dx < 16; dx++)
			for (let dz = 0; dz < 16; dz++) c.blocks[indexOf(dx, 40, dz)] = stone;
		fillChunkLights(w, c);
		computeChunkShadows(w, c);
		// Under the roof, enclosed by skylight=0 OR blocked by ray cast: sunlit=0.
		expect(c.sunlit[indexOf(5, 20, 5)]).toBe(0);
	});

	it("voxel directly SE of a tall pillar is in the pillar's shadow", () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		// Tall pillar at (5, 30..40, 5). Test a voxel 1 step SE of the pillar at y=30.
		for (let y = 30; y <= 40; y++) c.blocks[indexOf(5, y, 5)] = stone;
		fillChunkLights(w, c);
		computeChunkShadows(w, c);
		// SE direction for sun=[-0.5, 1, -0.3] means +x, +z is NOT the shadow direction.
		// Shadow direction is opposite the sun dir, so +x direction is where shadows fall
		// (sun dx is -0.5, so shadow dx is +0.5). +z too (sun dz is -0.3).
		// So a voxel at (6, 30, 5) should be in shadow from the pillar.
		expect(c.sunlit[indexOf(6, 30, 5)]).toBe(0);
	});

	it('voxel NW of the pillar (upwind of shadow) is still sunlit', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		for (let y = 30; y <= 40; y++) c.blocks[indexOf(5, y, 5)] = stone;
		fillChunkLights(w, c);
		computeChunkShadows(w, c);
		// NW of pillar: (4, 30, 4) — ray toward NW-up doesn't hit the pillar.
		expect(c.sunlit[indexOf(4, 30, 4)]).toBe(1);
	});
});
