import { describe, it, expect } from 'vitest';
import { World } from './world';
import { BLOCK_BY_NAME, AIR } from '../../data/blocks.data';
import { fillChunkLights, updateLightsForBlockChange } from './lighting';
import { CHUNK_SIZE_Y, indexOf } from './coords';

const stone = BLOCK_BY_NAME['stone'].id;
const glass = BLOCK_BY_NAME['glass'].id;

function emptyWorld(): World {
	const w = new World(1);
	const c = w.ensureChunk(0, 0);
	c.blocks.fill(AIR);
	c.lights.fill(0);
	c.liquidFrontier.clear();
	return w;
}

describe('fillChunkLights — skylight', () => {
	it('fills a fully-open column with skyLight=15 all the way down', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		fillChunkLights(w, c);
		for (let y = 0; y < CHUNK_SIZE_Y; y++) {
			expect(c.getSky(0, y, 0)).toBe(15);
		}
	});

	it('drops skyLight to 0 directly below an opaque ceiling with no side path', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		// Fully seal a 3x3x4 box at x=4..6, z=4..6, y=36..40.
		// Roof at y=40, floor at y=36, walls on perimeter for y=36..40.
		for (let y = 36; y <= 40; y++) {
			for (let dx = 4; dx <= 6; dx++) {
				for (let dz = 4; dz <= 6; dz++) {
					if (y === 40 || y === 36 || dx === 4 || dx === 6 || dz === 4 || dz === 6) {
						c.blocks[indexOf(dx, y, dz)] = stone;
					}
				}
			}
		}
		fillChunkLights(w, c);
		expect(c.getSky(5, 39, 5)).toBe(0);
		expect(c.getSky(5, 38, 5)).toBe(0);
	});

	it('skylight passes through glass unchanged (filter 0)', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		c.blocks[indexOf(5, 40, 5)] = glass;
		fillChunkLights(w, c);
		expect(c.getSky(5, 39, 5)).toBe(15);
	});

	it('skylight attenuates by 2 per block horizontally under an overhang', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		for (let dx = 0; dx <= 7; dx++)
			for (let dz = 0; dz < 16; dz++) c.blocks[indexOf(dx, 40, dz)] = stone;
		fillChunkLights(w, c);
		expect(c.getSky(8, 39, 5)).toBe(15);
		expect(c.getSky(7, 39, 5)).toBe(13); // was 14
		expect(c.getSky(6, 39, 5)).toBe(11); // was 13
		expect(c.getSky(5, 39, 5)).toBe(9); // was 12
	});
});

const lamp = BLOCK_BY_NAME['lamp'].id;
const lava = BLOCK_BY_NAME['lava'].id;

describe('fillChunkLights — block light', () => {
	it('a lamp radiates outward with distance decay', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		for (let dx = 0; dx < 16; dx++)
			for (let dz = 0; dz < 16; dz++) c.blocks[indexOf(dx, 63, dz)] = stone;
		c.blocks[indexOf(5, 30, 5)] = lamp;
		fillChunkLights(w, c, () => '#FFFFFF');
		const r5 = c.getBlockR(5, 30, 5);
		expect(r5).toBeGreaterThanOrEqual(14);
		expect(c.getBlockR(6, 30, 5)).toBeGreaterThanOrEqual(13);
		expect(c.getBlockR(5, 30, 6)).toBeGreaterThanOrEqual(13);
		// x=15 is 10 steps away from x=5; at 1 attenuation/step from level 15, value = 5
		expect(c.getBlockR(15, 30, 5)).toBeLessThan(7);
	});

	it('a red lamp produces nonzero R and zero G/B', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		c.blocks[indexOf(5, 30, 5)] = lamp;
		fillChunkLights(w, c, () => '#FF0000');
		expect(c.getBlockR(6, 30, 5)).toBeGreaterThan(0);
		expect(c.getBlockG(6, 30, 5)).toBe(0);
		expect(c.getBlockB(6, 30, 5)).toBe(0);
	});

	it('two lamps of different colors blend per-channel via max, not sum', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		c.blocks[indexOf(5, 30, 5)] = lamp;
		c.blocks[indexOf(7, 30, 5)] = lamp;
		fillChunkLights(w, c, (x, _y, _z) => {
			if (x === 5) return '#FF0000';
			if (x === 7) return '#0000FF';
			return '#FFFFFF';
		});
		const r = c.getBlockR(6, 30, 5);
		const b = c.getBlockB(6, 30, 5);
		expect(r).toBeGreaterThan(0);
		expect(b).toBeGreaterThan(0);
		expect(r).toBeLessThanOrEqual(15);
		expect(b).toBeLessThanOrEqual(15);
	});

	it('lava emits orange-red light at level 12', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		c.blocks[indexOf(5, 30, 5)] = lava;
		fillChunkLights(w, c, () => '#FFFFFF');
		expect(c.getBlockR(5, 30, 5)).toBeGreaterThanOrEqual(11);
		expect(c.getBlockR(5, 30, 5)).toBeGreaterThan(c.getBlockB(5, 30, 5));
	});
});

describe('save-load lighting regression', () => {
	it("regression: skylight is correct after a chunk's blocks are replaced (simulating save-load)", () => {
		const w = new World(1);
		// Let the world generate a chunk normally (creates terrain + fills lights).
		const c = w.ensureChunk(0, 0);
		// Find the top solid block of column (5, 5).
		let topSolid = -1;
		for (let y = 63; y >= 0; y--) {
			if (c.blocks[indexOf(5, y, 5)] !== AIR) {
				topSolid = y;
				break;
			}
		}
		expect(topSolid).toBeGreaterThan(0);
		// Simulate "kid dug a straight-down shaft that was not in the generated world":
		// replace blocks in column (5, 5) from topSolid down to some depth with air,
		// via direct block-array mutation (mimicking c.blocks.set from a save).
		for (let y = topSolid; y >= 10; y--) {
			c.blocks[indexOf(5, y, 5)] = AIR;
		}
		// BEFORE the fix: lights would still reflect the original generated column — skyLight
		// at deep shaft voxels would be 0.
		// AFTER the fix: callers must re-run fillChunkLights once blocks settle.
		fillChunkLights(w, c);
		// The shaft column should now be lit top to bottom.
		for (let y = topSolid; y >= 10; y--) {
			expect(c.getSky(5, y, 5)).toBe(15);
		}
	});
});

describe('updateLightsForBlockChange', () => {
	it('mining a lamp clears its propagated light locally', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		c.blocks[indexOf(5, 30, 5)] = lamp;
		fillChunkLights(w, c, () => '#FFFFFF');
		expect(c.getBlockR(6, 30, 5)).toBeGreaterThan(0);

		c.blocks[indexOf(5, 30, 5)] = AIR;
		updateLightsForBlockChange(w, 5, 30, 5, () => '#FFFFFF');
		expect(c.getBlockR(5, 30, 5)).toBe(0);
		expect(c.getBlockR(6, 30, 5)).toBe(0);
	});

	it('breaking a wall between dark and lit re-floods light into the dark side', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		// Roof everywhere so skylight doesn't confuse.
		for (let dx = 0; dx < 16; dx++)
			for (let dz = 0; dz < 16; dz++) c.blocks[indexOf(dx, 63, dz)] = stone;
		// Wall at x=8 for y=10..40.
		for (let y = 10; y <= 40; y++)
			for (let dz = 0; dz < 16; dz++) c.blocks[indexOf(8, y, dz)] = stone;
		// Lamp at (4, 30, 5).
		c.blocks[indexOf(4, 30, 5)] = lamp;
		fillChunkLights(w, c, () => '#FFFFFF');
		expect(c.getBlockR(7, 30, 5)).toBeGreaterThan(0);
		expect(c.getBlockR(9, 30, 5)).toBe(0);

		// Remove one block from the wall at (8, 30, 5).
		c.blocks[indexOf(8, 30, 5)] = AIR;
		updateLightsForBlockChange(w, 8, 30, 5, () => '#FFFFFF');
		expect(c.getBlockR(9, 30, 5)).toBeGreaterThan(0);
	});

	it('placing a lamp in a dark room lights it up', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		// Sealed 5x11x5 box at (0..5)×(20..30)×(0..5) with floor/roof/walls.
		for (let y = 20; y <= 30; y++) {
			for (let dx = 0; dx <= 5; dx++) {
				for (let dz = 0; dz <= 5; dz++) {
					if (y === 20 || y === 30 || dx === 0 || dx === 5 || dz === 0 || dz === 5) {
						c.blocks[indexOf(dx, y, dz)] = stone;
					}
				}
			}
		}
		// Roof over the rest of the chunk too so no stray skylight leaks in from outside the box.
		for (let dx = 0; dx < 16; dx++)
			for (let dz = 0; dz < 16; dz++) c.blocks[indexOf(dx, 63, dz)] = stone;
		fillChunkLights(w, c, () => '#FFFFFF');
		expect(c.getBlockR(3, 25, 3)).toBe(0);

		c.blocks[indexOf(3, 25, 3)] = lamp;
		updateLightsForBlockChange(w, 3, 25, 3, () => '#FFFFFF');
		expect(c.getBlockR(3, 25, 3)).toBeGreaterThan(0);
		expect(c.getBlockR(2, 25, 3)).toBeGreaterThan(0);
	});

	it('closing a sky opening clears skylight from the shaft below', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		// Roof everywhere so only the specific column has sky access.
		for (let dx = 0; dx < 16; dx++)
			for (let dz = 0; dz < 16; dz++) c.blocks[indexOf(dx, 63, dz)] = stone;
		// Open a 1-wide shaft at column (5, 5): remove the roof at (5, 63, 5), leave air all the way down to y=20.
		c.blocks[indexOf(5, 63, 5)] = AIR;
		// Fill the whole lower region with air (y 20..62) is already air by default (emptyWorld clears to AIR).
		fillChunkLights(w, c);
		// Confirm the shaft is lit full-column.
		expect(c.getSky(5, 62, 5)).toBe(15);
		expect(c.getSky(5, 40, 5)).toBe(15);
		expect(c.getSky(5, 25, 5)).toBe(15);

		// Close the hole: place a stone block at (5, 63, 5).
		c.blocks[indexOf(5, 63, 5)] = stone;
		updateLightsForBlockChange(w, 5, 63, 5);

		// Shaft below the new stone should go dark (no sky access via any path in this sealed chunk).
		expect(c.getSky(5, 62, 5)).toBe(0);
		expect(c.getSky(5, 40, 5)).toBe(0);
		expect(c.getSky(5, 25, 5)).toBe(0);
	});
});
