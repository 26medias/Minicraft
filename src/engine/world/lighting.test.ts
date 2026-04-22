import { describe, it, expect } from 'vitest';
import { World } from './world';
import { BLOCK_BY_NAME, AIR } from '../../data/blocks.data';
import { fillChunkLights } from './lighting';
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

	it('skylight attenuates by 1 per block horizontally under an overhang', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		for (let dx = 0; dx <= 7; dx++) for (let dz = 0; dz < 16; dz++) c.blocks[indexOf(dx, 40, dz)] = stone;
		fillChunkLights(w, c);
		expect(c.getSky(8, 39, 5)).toBe(15);
		expect(c.getSky(7, 39, 5)).toBe(14);
		expect(c.getSky(6, 39, 5)).toBe(13);
		expect(c.getSky(5, 39, 5)).toBe(12);
	});
});
