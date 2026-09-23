import { describe, it, expect } from 'vitest';
import { makeLoop } from './test-loop';
import { AIR, BLOCK_BY_NAME, type BlockId } from '../data/blocks.data';
import { countOf, onRemoved } from './inventory';
import type { Inventory } from '../data/crafting.data';
import { TNT_CHAIN_FUSE } from './tnt';

const tnt = BLOCK_BY_NAME['tnt'].id;
const big = BLOCK_BY_NAME['big_tnt'].id;
const mega = BLOCK_BY_NAME['mega_tnt'].id;
const stone = BLOCK_BY_NAME['stone'].id;
// makeLoop() clears chunk (16,16) = x,z 256..271 of a 64-high v1 world: everything below is in open air.
const O = { x: 260, y: 40, z: 260 };
const hit = (x: number, y: number, z: number) => ({ x, y, z, face: 'py' as const, distance: 0 });

/** A loop whose TNT removals are counted exactly as main.ts counts them (onBlocksRemoved → onRemoved). */
function counted() {
	const h = makeLoop();
	let inv: Inventory = {};
	h.loop.onBlocksRemoved = (removed) => { inv = onRemoved(inv, removed.map((r) => r.blockId)).inv; };
	return { ...h, inv: () => inv };
}

describe('TNT tiers in the loop (spec §6)', () => {
	it('each tier ignites with its own fuse: Big waits 4 s, not 2.5 s', () => {
		// Catches igniteTnt still passing the global TNT_PRIME_FUSE for every tier.
		const { loop, world } = makeLoop();
		world.setBlock(O.x, O.y, O.z, big);
		world.setBlock(O.x + 1, O.y, O.z, stone);
		expect(loop.ignite(hit(O.x, O.y, O.z))).toBe(true);
		loop.simulate(3.0);
		expect(world.getBlock(O.x + 1, O.y, O.z)).toBe(stone);
		loop.simulate(1.1);
		expect(world.getBlock(O.x + 1, O.y, O.z)).toBe(AIR);
	});

	it('Mega TNT blasts radius 8; plain TNT still radius 3', () => {
		// Catches a single global radius (TNT_RADIUS) used for every tier.
		const { loop, world } = makeLoop();
		world.setBlock(O.x, O.y, O.z, mega);
		world.setBlock(O.x + 8, O.y, O.z, stone);
		world.setBlock(O.x, O.y, O.z + 9, stone);
		loop.ignite(hit(O.x, O.y, O.z));
		loop.simulate(6.1);
		expect(world.getBlock(O.x + 8, O.y, O.z)).toBe(AIR);
		expect(world.getBlock(O.x, O.y, O.z + 9)).toBe(stone);

		const p = makeLoop();
		p.world.setBlock(O.x, O.y, O.z, tnt);
		p.world.setBlock(O.x + 3, O.y, O.z, stone);
		p.world.setBlock(O.x + 4, O.y, O.z, stone);
		p.loop.ignite(hit(O.x, O.y, O.z));
		p.loop.simulate(2.6);
		expect(p.world.getBlock(O.x + 3, O.y, O.z)).toBe(AIR);
		expect(p.world.getBlock(O.x + 4, O.y, O.z)).toBe(stone);
	});

	it('radius is fixed when the TNT is primed, not read again at detonation', () => {
		// Catches detonateAt looking up BLOCKS[world.getBlock(origin)].tnt when the fuse runs out:
		// the cell is swapped to plain TNT behind the fuse's back (a raw setBlock, so the fuse survives).
		const { loop, world } = makeLoop();
		world.setBlock(O.x, O.y, O.z, big);
		world.setBlock(O.x + 5, O.y, O.z, stone);
		loop.ignite(hit(O.x, O.y, O.z));
		world.setBlock(O.x, O.y, O.z, tnt);
		loop.simulate(4.1);
		expect(world.getBlock(O.x + 5, O.y, O.z)).toBe(AIR);
	});

	it('a plain TNT chaining a Big TNT: the Big one explodes with radius 5', () => {
		// Catches the chained entry inheriting the igniter's radius (3), a global radius, or
		// "is TNT" still being id === tnt (Big would be destroyed, never primed).
		const { loop, world } = makeLoop();
		world.setBlock(O.x, O.y, O.z, tnt);
		world.setBlock(O.x + 2, O.y, O.z, big);
		world.setBlock(O.x + 7, O.y, O.z, stone);   // 7 from plain (out of r3), 5 from Big (in r5)
		world.setBlock(O.x - 4, O.y, O.z, stone);   // 4 from plain, 6 from Big: out of both
		loop.ignite(hit(O.x, O.y, O.z));
		loop.simulate(2.6);
		expect(world.getBlock(O.x + 2, O.y, O.z)).toBe(big);   // primed, not destroyed
		loop.simulate(TNT_CHAIN_FUSE + 0.05);                  // chain fuse is 0.1 s for every tier
		expect(world.getBlock(O.x + 7, O.y, O.z)).toBe(AIR);
		expect(world.getBlock(O.x - 4, O.y, O.z)).toBe(stone);
	});

	it('a Big TNT chaining a plain TNT: the plain one explodes with radius 3, not 5', () => {
		// Catches the chained entry inheriting the igniter's radius (5).
		const { loop, world } = makeLoop();
		world.setBlock(O.x, O.y, O.z, big);
		world.setBlock(O.x + 4, O.y, O.z, tnt);
		world.setBlock(O.x + 7, O.y, O.z, stone);   // 3 from plain: destroyed by the chained blast
		world.setBlock(O.x + 8, O.y, O.z, stone);   // 4 from plain, 8 from Big: survives
		loop.ignite(hit(O.x, O.y, O.z));
		loop.simulate(4.1);
		loop.simulate(TNT_CHAIN_FUSE + 0.05);
		expect(world.getBlock(O.x + 4, O.y, O.z)).toBe(AIR);
		expect(world.getBlock(O.x + 7, O.y, O.z)).toBe(AIR);
		expect(world.getBlock(O.x + 8, O.y, O.z)).toBe(stone);
	});
});

describe('TNT blasts and counts (spec §2)', () => {
	it('a lone TNT in air adds 0 TNT', () => {
		// Catches counting detonate()'s own cell: its origin is in `destroyed`.
		for (const id of [tnt, big, mega] as BlockId[]) {
			const h = counted();
			h.world.setBlock(O.x, O.y, O.z, id);
			h.loop.ignite(hit(O.x, O.y, O.z));
			h.loop.simulate(6.1);
			expect(h.world.getBlock(O.x, O.y, O.z)).toBe(AIR);  // it really went off
			expect(countOf(h.inv(), 'tnt')).toBe(0);
			expect(countOf(h.inv(), 'big_tnt')).toBe(0);
			expect(countOf(h.inv(), 'mega_tnt')).toBe(0);
		}
	});

	it('a chain of two adds 0 TNT; the stone it blew up is counted', () => {
		// Catches counting either detonating cell or the chain-primed cell. The stone makes the
		// test non-vacuous: with no onBlocksRemoved wiring at all it reads 0, not 1.
		const h = counted();
		h.world.setBlock(O.x, O.y, O.z, tnt);
		h.world.setBlock(O.x + 1, O.y, O.z, tnt);
		h.world.setBlock(O.x, O.y + 1, O.z, stone);
		h.loop.ignite(hit(O.x, O.y, O.z));
		h.loop.simulate(2.6);
		h.loop.simulate(TNT_CHAIN_FUSE + 0.05);
		expect(h.world.getBlock(O.x + 1, O.y, O.z)).toBe(AIR);
		expect(countOf(h.inv(), 'tnt')).toBe(0);
		expect(countOf(h.inv(), 'stone')).toBe(1);
	});

	it('a plain TNT chaining a Big TNT adds 0 Big TNT', () => {
		// Catches "is TNT" = id === tnt in detonate(): Big would be destroyed and counted +1.
		const h = counted();
		h.world.setBlock(O.x, O.y, O.z, tnt);
		h.world.setBlock(O.x + 2, O.y, O.z, big);
		h.world.setBlock(O.x, O.y + 1, O.z, stone);
		h.loop.ignite(hit(O.x, O.y, O.z));
		h.loop.simulate(2.6);
		h.loop.simulate(TNT_CHAIN_FUSE + 0.05);
		expect(h.world.getBlock(O.x + 2, O.y, O.z)).toBe(AIR);
		expect(countOf(h.inv(), 'big_tnt')).toBe(0);
		expect(countOf(h.inv(), 'tnt')).toBe(0);
		expect(countOf(h.inv(), 'stone')).toBe(1);
	});
});
