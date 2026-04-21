import { describe, it, expect } from 'vitest';
import { World } from '../engine/world/world';
import { BLOCK_BY_NAME } from '../data/blocks.data';
import { detonate, TNT_RADIUS } from './tnt';

const tntId = BLOCK_BY_NAME['tnt'].id;
const stoneId = BLOCK_BY_NAME['stone'].id;

const neverPrimed = () => false;

describe('detonate', () => {
	it('returns origin in destroyed when origin is a solid block', () => {
		const w = new World(1);
		w.setBlock(100, 60, 100, tntId);
		const r = detonate(w, 100, 60, 100, neverPrimed);
		expect(r.destroyed).toContainEqual([100, 60, 100]);
	});

	it('destroys solid blocks within radius', () => {
		const w = new World(1);
		w.setBlock(100, 60, 100, tntId);
		w.setBlock(101, 60, 100, stoneId); // distance 1
		w.setBlock(103, 60, 100, stoneId); // distance 3 (on radius)
		const r = detonate(w, 100, 60, 100, neverPrimed);
		expect(r.destroyed).toContainEqual([101, 60, 100]);
		expect(r.destroyed).toContainEqual([103, 60, 100]);
	});

	it('spares solid blocks outside radius', () => {
		const w = new World(1);
		w.setBlock(100, 60, 100, tntId);
		w.setBlock(104, 60, 100, stoneId); // distance 4, outside
		const r = detonate(w, 100, 60, 100, neverPrimed);
		expect(r.destroyed).not.toContainEqual([104, 60, 100]);
	});

	it('skips out-of-bounds coords without throwing', () => {
		const w = new World(1);
		w.setBlock(1, 60, 1, tntId);
		const r = detonate(w, 1, 60, 1, neverPrimed);
		for (const [x, , z] of r.destroyed) {
			expect(x).toBeGreaterThanOrEqual(0);
			expect(z).toBeGreaterThanOrEqual(0);
		}
	});

	it('returns TNT-in-radius as primed (not destroyed)', () => {
		const w = new World(1);
		w.setBlock(100, 60, 100, tntId);
		w.setBlock(102, 60, 100, tntId); // TNT at distance 2
		const r = detonate(w, 100, 60, 100, neverPrimed);
		expect(r.primed).toContainEqual([102, 60, 100]);
		expect(r.destroyed).not.toContainEqual([102, 60, 100]);
	});

	it('respects alreadyPrimed: a primed TNT is skipped', () => {
		const w = new World(1);
		w.setBlock(100, 60, 100, tntId);
		w.setBlock(102, 60, 100, tntId);
		const r = detonate(w, 100, 60, 100, (x, y, z) => x === 102 && y === 60 && z === 100);
		expect(r.primed).not.toContainEqual([102, 60, 100]);
		expect(r.destroyed).not.toContainEqual([102, 60, 100]);
	});

	it('TNT_RADIUS is exposed and matches the inner radius-sphere test', () => {
		expect(TNT_RADIUS).toBe(3);
		const w = new World(1);
		w.setBlock(100, 60, 100, tntId);
		w.setBlock(100 + TNT_RADIUS, 60, 100, stoneId);
		const r = detonate(w, 100, 60, 100, neverPrimed);
		expect(r.destroyed).toContainEqual([100 + TNT_RADIUS, 60, 100]);
	});
});
