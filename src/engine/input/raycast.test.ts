import { describe, it, expect } from 'vitest';
import { raycastVoxel } from './raycast';
import { World } from '../world/world';
import { BLOCK_BY_NAME } from '../../data/blocks.data';

const stone = BLOCK_BY_NAME['stone'].id;

describe('raycastVoxel', () => {
	it('returns null when nothing is hit', () => {
		const w = new World(1, { height: 64 });
		const hit = raycastVoxel(w, [8, 63, 8], [0, 1, 0], 10);
		expect(hit).toBeNull();
	});

	it('hits the block directly ahead with correct face', () => {
		const w = new World(1);
		w.setBlock(10, 50, 10, stone);
		const hit = raycastVoxel(w, [5, 50.5, 10.5], [1, 0, 0], 20);
		expect(hit).not.toBeNull();
		expect(hit!.x).toBe(10);
		expect(hit!.y).toBe(50);
		expect(hit!.z).toBe(10);
		expect(hit!.face).toBe('nx'); // entered from -x
	});

	it('respects max distance', () => {
		const w = new World(1);
		w.setBlock(10, 50, 10, stone);
		const hit = raycastVoxel(w, [5, 50.5, 10.5], [1, 0, 0], 3);
		expect(hit).toBeNull();
	});

	it('hits first block, not further blocks behind it', () => {
		const w = new World(1);
		w.setBlock(8, 50, 10, stone);
		w.setBlock(10, 50, 10, stone);
		const hit = raycastVoxel(w, [5, 50.5, 10.5], [1, 0, 0], 20);
		expect(hit!.x).toBe(8);
	});

	it('hits the v2 surface (y >= 64) looking straight down from y=140', () => {
		const w = World.create(5);
		const hit = raycastVoxel(w, [200.5, 140, 200.5], [0, -1, 0], 40);
		expect(hit).not.toBeNull();
		expect(hit!.y).toBeGreaterThanOrEqual(64);
		expect(hit!.y).toBeLessThanOrEqual(130);
	});
});
