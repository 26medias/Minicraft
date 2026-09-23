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

describe('embedded in a block (Noah #1: lava turned to obsidian around him in a water-filled pit, then he was under the bedrock)', () => {
	// A whole solid layer where the feet are (the pit floor turned to obsidian), a solid floor under it.
	const pit = () => {
		const w = new World(1);
		for (let x = 90; x <= 110; x++) for (let z = 90; z <= 110; z++) { w.setBlock(x, 59, z, stone); w.setBlock(x, 60, z, stone); }
		return w;
	};

	it('alternating swim-up / sink moves while embedded never carry the player down (was: one block per cycle, 60 → 57)', () => {
		const w = pit();
		let p: [number, number, number] = [100.5, 60.0001, 100.5];
		for (let k = 0; k < 12; k++) p = moveWithCollisions(w, p, SIZE, [0, k % 2 === 0 ? 0.1 : -0.1, 0]).position;
		expect(p[1]).toBeGreaterThanOrEqual(60);
	});

	it('a player inside a solid block is pushed up to the first free space', () => {
		const w = pit();
		const r = moveWithCollisions(w, [100.5, 60.0001, 100.5], SIZE, [0, -0.1, 0]);
		expect(r.position[1]).toBeGreaterThanOrEqual(61);
		expect(r.position[1]).toBeLessThan(61.2);
	});

	it('an upward move into a ceiling still stops under it (unchanged behaviour)', () => {
		const w = new World(1);
		w.setBlock(100, 63, 100, stone);
		const r = moveWithCollisions(w, [100.5, 61.0001, 100.5], SIZE, [0, 0.5, 0]);
		expect(r.position[1]).toBeGreaterThan(61);
		expect(r.position[1] + SIZE[1]).toBeLessThanOrEqual(63);
		expect(r.vy).toBe(0);
	});
});
