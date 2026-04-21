import { describe, it, expect } from 'vitest';
import { moveWithCollisions } from './collision';
import { World } from '../world/world';
import { BLOCK_BY_NAME } from '../../data/blocks.data';

const stone = BLOCK_BY_NAME['stone'].id;

// Player AABB: 0.6 x 1.8 x 0.6, feet at position.y
const SIZE: [number, number, number] = [0.6, 1.8, 0.6];

describe('moveWithCollisions', () => {
	it('moves freely through air', () => {
		const w = new World(1);
		const r = moveWithCollisions(w, [100, 60, 100], SIZE, [1, 0, 0]);
		expect(r.position[0]).toBeCloseTo(101);
		expect(r.vy).toBe(0);
	});

	it('stops at a wall along +x', () => {
		const w = new World(1);
		w.setBlock(12, 60, 10, stone);
		const r = moveWithCollisions(w, [11.0, 60, 10.2], SIZE, [2, 0, 0]);
		expect(r.position[0]).toBeLessThan(12);
		expect(r.vx).toBe(0);
	});

	it('sets grounded when landing on a block', () => {
		const w = new World(1);
		w.setBlock(10, 60, 10, stone);
		const r = moveWithCollisions(w, [10.2, 61.2, 10.2], SIZE, [0, -2, 0]);
		expect(r.position[1]).toBeCloseTo(61, 2);
		expect(r.grounded).toBe(true);
		expect(r.vy).toBe(0);
	});

	it('does not get stuck inside a wall that spawns around it', () => {
		const w = new World(1);
		const r = moveWithCollisions(w, [100, 60, 100], SIZE, [0, 0, 0]);
		expect(r.position).toEqual([100, 60, 100]);
	});
});
