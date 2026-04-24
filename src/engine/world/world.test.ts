import { describe, it, expect } from 'vitest';
import { World } from './world';
import { BLOCK_BY_NAME, AIR } from '../../data/blocks.data';
import { CHUNK_SIZE_X, WORLD_SIZE_X, indexOf, worldToChunk } from './coords';

describe('World', () => {
	it('generates a chunk on demand', () => {
		const w = new World(42);
		const c = w.ensureChunk(0, 0);
		expect(c.cx).toBe(0);
		expect(c.cz).toBe(0);
	});

	it('returns cached chunk on repeat access', () => {
		const w = new World(42);
		const a = w.ensureChunk(1, 2);
		const b = w.ensureChunk(1, 2);
		expect(a).toBe(b);
	});

	it('reads a block at world coords', () => {
		const w = new World(42);
		const air = w.getBlock(0, 63, 0);
		expect(air).toBe(AIR);
	});

	it('writes a block at world coords and marks chunk modified', () => {
		const w = new World(42);
		const stone = BLOCK_BY_NAME['stone'].id;
		w.setBlock(18, 50, 34, stone);
		expect(w.getBlock(18, 50, 34)).toBe(stone);
		const chunk = w.ensureChunk(1, 2);
		expect(chunk.modified).toBe(true);
	});

	it('treats out-of-bounds as air and rejects writes', () => {
		const w = new World(42);
		expect(w.getBlock(-1, 0, 0)).toBe(AIR);
		expect(w.getBlock(WORLD_SIZE_X, 0, 0)).toBe(AIR);
		const stone = BLOCK_BY_NAME['stone'].id;
		w.setBlock(WORLD_SIZE_X, 0, 0, stone); // no throw
		expect(w.getBlock(WORLD_SIZE_X, 0, 0)).toBe(AIR);
	});

	it('lists only modified chunks', () => {
		const w = new World(1);
		w.ensureChunk(0, 0); // generated but not modified
		const stone = BLOCK_BY_NAME['stone'].id;
		w.setBlock(CHUNK_SIZE_X + 1, 20, 0, stone); // chunk (1, 0)
		const modified = w.modifiedChunks();
		expect(modified.length).toBe(1);
		expect(modified[0].cx).toBe(1);
		expect(modified[0].cz).toBe(0);
	});

	it('exposes the 4 horizontal neighbors for meshing', () => {
		const w = new World(1);
		const center = w.ensureChunk(5, 5);
		const n = w.neighbors(center);
		expect(n.px?.cx).toBe(6);
		expect(n.nx?.cx).toBe(4);
		expect(n.pz?.cz).toBe(6);
		expect(n.nz?.cz).toBe(4);
	});
});

describe('World.markLiquidFrontier', () => {
	it('setting a liquid block adds it to that chunk\'s frontier', () => {
		const w = new World(1);
		const water = BLOCK_BY_NAME['water'].id;
		w.setBlock(100, 30, 100, water);
		const cx = Math.floor(100 / 16);
		const cz = Math.floor(100 / 16);
		const lx = 100 - cx * 16;
		const lz = 100 - cz * 16;
		const c = w.getChunk(cx, cz)!;
		expect(c.liquidFrontier.has(indexOf(lx, 30, lz))).toBe(true);
	});

	it('setting a non-liquid next to an existing liquid adds the liquid to the frontier', () => {
		const w = new World(1);
		const water = BLOCK_BY_NAME['water'].id;
		const stone = BLOCK_BY_NAME['stone'].id;
		w.setBlock(100, 30, 100, water);
		const c = w.getChunk(Math.floor(100 / 16), Math.floor(100 / 16))!;
		c.liquidFrontier.clear();
		w.setBlock(101, 30, 100, stone);
		expect(c.liquidFrontier.size).toBeGreaterThan(0);
	});

	it('setting a block at chunk boundary adds liquid to the neighbor chunk\'s frontier', () => {
		const w = new World(1);
		const water = BLOCK_BY_NAME['water'].id;
		const stone = BLOCK_BY_NAME['stone'].id;
		w.setBlock(15, 30, 5, water);
		const c0 = w.getChunk(0, 0)!;
		c0.liquidFrontier.clear();
		w.setBlock(16, 30, 5, stone);
		expect(c0.liquidFrontier.size).toBeGreaterThan(0);
	});
});

const water = BLOCK_BY_NAME['water'].id;

function freshWorld(): World {
	const w = new World(1);
	const c = w.ensureChunk(16, 16);
	c.blocks.fill(AIR);
	c.fluidMeta.clear();
	c.liquidFrontier.clear();
	return w;
}

describe('World.setBlock — fluidMeta interaction', () => {
	it('regular setBlock(water) clears any existing fluidMeta entry → cell is a source', () => {
		const w = freshWorld();
		const { cx, cz, lx, lz } = worldToChunk(260, 260);
		const c = w.getChunk(cx, cz)!;
		// Pretend a previous scheduler write left a flow entry here
		c.setFluidMeta(lx, 30, lz, 3);
		expect(c.isFlow(lx, 30, lz)).toBe(true);

		w.setBlock(260, 30, 260, water);

		expect(w.getBlock(260, 30, 260)).toBe(water);
		expect(c.isFlow(lx, 30, lz)).toBe(false);
	});

	it('regular setBlock(AIR) clears any existing fluidMeta entry', () => {
		const w = freshWorld();
		const { cx, cz, lx, lz } = worldToChunk(260, 260);
		const c = w.getChunk(cx, cz)!;
		c.set(lx, 30, lz, water);
		c.setFluidMeta(lx, 30, lz, 2);

		w.setBlock(260, 30, 260, AIR);

		expect(c.isFlow(lx, 30, lz)).toBe(false);
	});
});

describe('World.setBlockFlow', () => {
	it('writes the block id and a flow entry with the given distance', () => {
		const w = freshWorld();
		const { cx, cz, lx, lz } = worldToChunk(260, 260);
		const c = w.getChunk(cx, cz)!;

		w.setBlockFlow(260, 30, 260, water, 2);

		expect(w.getBlock(260, 30, 260)).toBe(water);
		expect(c.isFlow(lx, 30, lz)).toBe(true);
		expect(c.getFlowDistance(lx, 30, lz)).toBe(2);
	});

	it('overwrites a prior source with a flow entry', () => {
		const w = freshWorld();
		const { cx, cz, lx, lz } = worldToChunk(260, 260);
		const c = w.getChunk(cx, cz)!;
		w.setBlock(260, 30, 260, water); // source
		expect(c.isFlow(lx, 30, lz)).toBe(false);

		w.setBlockFlow(260, 30, 260, water, 1);

		expect(c.isFlow(lx, 30, lz)).toBe(true);
		expect(c.getFlowDistance(lx, 30, lz)).toBe(1);
	});
});
