import { describe, it, expect } from 'vitest';
import { World } from '../engine/world/world';
import { BLOCK_BY_NAME } from '../data/blocks.data';
import { detonate, tntSpec, TNT_RADIUS } from './tnt';

const tntId = BLOCK_BY_NAME['tnt'].id;
const stoneId = BLOCK_BY_NAME['stone'].id;

const neverPrimed = () => false;

describe('detonate', () => {
	it('returns origin in destroyed when origin is a solid block', () => {
		const w = new World(1);
		w.setBlock(100, 60, 100, tntId);
		const r = detonate(w, 100, 60, 100, TNT_RADIUS, neverPrimed);
		expect(r.destroyed).toContainEqual({ x: 100, y: 60, z: 100 });
	});

	it('destroys solid blocks within radius', () => {
		const w = new World(1);
		w.setBlock(100, 60, 100, tntId);
		w.setBlock(101, 60, 100, stoneId); // distance 1
		w.setBlock(103, 60, 100, stoneId); // distance 3 (on radius)
		const r = detonate(w, 100, 60, 100, TNT_RADIUS, neverPrimed);
		expect(r.destroyed).toContainEqual({ x: 101, y: 60, z: 100 });
		expect(r.destroyed).toContainEqual({ x: 103, y: 60, z: 100 });
	});

	it('spares solid blocks outside radius', () => {
		const w = new World(1);
		w.setBlock(100, 60, 100, tntId);
		w.setBlock(104, 60, 100, stoneId); // distance 4, outside
		const r = detonate(w, 100, 60, 100, TNT_RADIUS, neverPrimed);
		expect(r.destroyed).not.toContainEqual({ x: 104, y: 60, z: 100 });
	});

	it('skips out-of-bounds coords without throwing', () => {
		const w = new World(1);
		w.setBlock(1, 60, 1, tntId);
		const r = detonate(w, 1, 60, 1, TNT_RADIUS, neverPrimed);
		for (const { x, z } of r.destroyed) {
			expect(x).toBeGreaterThanOrEqual(0);
			expect(z).toBeGreaterThanOrEqual(0);
		}
	});

	it('returns TNT-in-radius as primed (not destroyed)', () => {
		const w = new World(1);
		w.setBlock(100, 60, 100, tntId);
		w.setBlock(102, 60, 100, tntId); // TNT at distance 2
		const r = detonate(w, 100, 60, 100, TNT_RADIUS, neverPrimed);
		expect(r.primed).toContainEqual({ x: 102, y: 60, z: 100, radius: 3, blockId: tntId });
		expect(r.destroyed).not.toContainEqual({ x: 102, y: 60, z: 100 });
	});

	it('respects alreadyPrimed: a primed TNT is skipped', () => {
		const w = new World(1);
		w.setBlock(100, 60, 100, tntId);
		w.setBlock(102, 60, 100, tntId);
		const r = detonate(w, 100, 60, 100, TNT_RADIUS, (x, y, z) => x === 102 && y === 60 && z === 100);
		expect(r.primed).not.toContainEqual({ x: 102, y: 60, z: 100 });
		expect(r.destroyed).not.toContainEqual({ x: 102, y: 60, z: 100 });
	});

	it('TNT_RADIUS is exposed and matches the inner radius-sphere test', () => {
		expect(TNT_RADIUS).toBe(3);
		const w = new World(1);
		w.setBlock(100, 60, 100, tntId);
		w.setBlock(100 + TNT_RADIUS, 60, 100, stoneId);
		const r = detonate(w, 100, 60, 100, TNT_RADIUS, neverPrimed);
		expect(r.destroyed).toContainEqual({ x: 100 + TNT_RADIUS, y: 60, z: 100 });
	});

	it('does not destroy unbreakable (hardness 0) blocks', () => {
		const w = new World(1);
		const bedrock = BLOCK_BY_NAME['bedrock'].id;
		w.setBlock(100, 60, 100, tntId);
		w.setBlock(101, 60, 100, bedrock);
		const r = detonate(w, 100, 60, 100, TNT_RADIUS, neverPrimed);
		expect(r.destroyed).not.toContainEqual({ x: 101, y: 60, z: 100 });
	});

	it('detonates near the top and the bottom of a 256 world without throwing', () => {
		const w = new World(1, { height: 256 });
		for (const y of [250, 1]) {
			w.setBlock(100, y, 100, tntId);
			w.setBlock(100, y + 1, 100, stoneId);
			const r = detonate(w, 100, y, 100, TNT_RADIUS, neverPrimed);
			expect(r.destroyed).toContainEqual({ x: 100, y: y + 1, z: 100 });
			for (const d of r.destroyed) expect(w.inBounds(d.x, d.y, d.z)).toBe(true);
		}
	});
	it('uses the radius it is given: 5 reaches distance 5, not 6', () => {
		// Catches detonate() ignoring its radius argument and keeping the module constant 3.
		const w = new World(1);
		w.setBlock(100, 60, 100, BLOCK_BY_NAME['big_tnt'].id);
		w.setBlock(105, 60, 100, stoneId);
		w.setBlock(106, 60, 100, stoneId);
		const r = detonate(w, 100, 60, 100, 5, neverPrimed);
		expect(r.destroyed).toContainEqual({ x: 105, y: 60, z: 100 });
		expect(r.destroyed).not.toContainEqual({ x: 106, y: 60, z: 100 });
	});

	it('primes Big and Mega TNT in the blast with their own radius, instead of destroying them', () => {
		// Catches "is TNT" left as id === BLOCK_BY_NAME.tnt.id (tnt.ts:51 today): Big/Mega would be destroyed.
		const w = new World(1);
		const big = BLOCK_BY_NAME['big_tnt'].id, mega = BLOCK_BY_NAME['mega_tnt'].id;
		w.setBlock(100, 60, 100, tntId);
		w.setBlock(102, 60, 100, big);
		w.setBlock(98, 60, 100, mega);
		const r = detonate(w, 100, 60, 100, TNT_RADIUS, neverPrimed);
		expect(r.primed).toContainEqual({ x: 102, y: 60, z: 100, radius: 5, blockId: big });
		expect(r.primed).toContainEqual({ x: 98, y: 60, z: 100, radius: 8, blockId: mega });
		expect(r.destroyed).not.toContainEqual({ x: 102, y: 60, z: 100 });
		expect(r.destroyed).not.toContainEqual({ x: 98, y: 60, z: 100 });
	});

	it('tntSpec: every tier, and null for non-TNT', () => {
		// Catches a tntSpec keyed on the name 'tnt' only.
		expect(tntSpec(tntId)).toEqual({ radius: 3, fuse: 2.5 });
		expect(tntSpec(BLOCK_BY_NAME['big_tnt'].id)).toEqual({ radius: 5, fuse: 4 });
		expect(tntSpec(BLOCK_BY_NAME['mega_tnt'].id)).toEqual({ radius: 8, fuse: 6 });
		expect(tntSpec(stoneId)).toBeNull();
		expect(tntSpec(5000)).toBeNull();
	});
});
