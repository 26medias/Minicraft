import { describe, it, expect } from 'vitest';
import { World } from './world';
import { ChunkOverlay } from './overlay';
import { AIR, WATER, BLOCK_BY_NAME, isLiquid } from '../../data/blocks.data';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z, indexOf } from './coords';

const SEED = 3;

/** Topmost non-air y of a column in an already-generated chunk. */
function topY(w: World, x: number, z: number): number {
	for (let y = w.height - 1; y >= 0; y--) if (w.getBlock(x, y, z) !== AIR) return y;
	return -1;
}

/** A dry column (non-liquid top, at least 12 solid-ish cells below) in chunk (cx, cz), found on a probe world. */
function findShaftColumn(cx: number, cz: number): { x: number; z: number; top: number } {
	const probe = World.create(SEED);
	for (let lx = 2; lx < CHUNK_SIZE_X - 2; lx++) for (let lz = 2; lz < CHUNK_SIZE_Z - 2; lz++) {
		const x = cx * CHUNK_SIZE_X + lx, z = cz * CHUNK_SIZE_Z + lz;
		const top = topY(probe, x, z);
		if (top < 12 || isLiquid(probe.getBlock(x, top, z))) continue;
		// The shaft's bottom cell must start out dark, or the test proves nothing.
		const bottom = top - 9;
		probe.ensureChunk(cx, cz);
		if (probe.getChunk(cx, cz)!.getSky(lx, bottom, lz) !== 0) continue;
		return { x, z, top };
	}
	throw new Error(`no shaft column in chunk ${cx},${cz}`);
}

function findDryChunk(): { cx: number; cz: number } {
	const probe = World.create(SEED);
	for (let cx = 4; cx < 28; cx++) for (let cz = 4; cz < 28; cz++) {
		const c = probe.ensureChunk(cx, cz);
		if (!c.hasLiquid) return { cx, cz };
		probe.dropChunk(cx, cz);
	}
	throw new Error('no dry chunk');
}

describe('ChunkOverlay', () => {
	it('set is idempotent, keyed per cell; size counts cells', () => {
		const o = new ChunkOverlay();
		o.set(17, 40, 33, 1, 0, 0);
		o.set(17, 40, 33, 1, 0, 0);
		expect(o.size).toBe(1);
		o.set(17, 40, 33, 2, 0, 0x1FFF5E0);
		expect(o.size).toBe(1);
		expect(o.get(17, 40, 33)).toEqual([2, 0, 0x1FFF5E0]);
		o.set(18, 40, 33, 3, 0, 0);
		expect(o.size).toBe(2);
	});

	it('loadSnapshot reads flat 6-per-cell rows', () => {
		const o = new ChunkOverlay();
		o.loadSnapshot(Int32Array.from([1, 2, 3, 4, 0x80, 0, 100, 5, 200, 7, 0, 0x1000000]));
		expect(o.size).toBe(2);
		expect(o.get(1, 2, 3)).toEqual([4, 0x80, 0]);
		expect(o.get(100, 5, 200)).toEqual([7, 0, 0x1000000]);
	});

	it('colorsIn lists coloured cells of one chunk only, in world coordinates', () => {
		const o = new ChunkOverlay();
		o.set(17, 40, 33, 5, 0, 0x1FFF5E0); // chunk (1, 2)
		o.set(18, 41, 34, 5, 0, 0); // no colour
		o.set(1, 40, 1, 5, 0, 0x1000000); // chunk (0, 0)
		expect(o.colorsIn(1, 2)).toEqual([{ x: 17, y: 40, z: 33, color: 0x1FFF5E0 }]);
		expect(o.colorsIn(0, 0)).toEqual([{ x: 1, y: 40, z: 1, color: 0x1000000 }]);
		expect(o.colorsIn(3, 3)).toEqual([]);
	});

	it('applyTo writes blocks and fluidMeta, and does not set modified', () => {
		const w = World.create(SEED);
		const o = new ChunkOverlay();
		const stone = BLOCK_BY_NAME['stone'].id;
		o.set(16 * 6 + 3, 30, 16 * 6 + 4, stone, 0, 0);
		o.set(16 * 6 + 5, 30, 16 * 6 + 4, WATER, 0x83, 0);
		w.overlay = o;
		const c = w.ensureChunk(6, 6);
		expect(c.get(3, 30, 4)).toBe(stone);
		expect(c.get(5, 30, 4)).toBe(WATER);
		expect(c.fluidMeta.get(indexOf(5, 30, 4))).toBe(0x83);
		expect(c.modified).toBe(false);
	});

	// T5 — overlay applied before lighting: a dug shaft is sky-lit (spec §6, G1).
	it('T5: an overlay shaft at an unloaded column is sky-lit at its bottom after ensureChunk', () => {
		const cx = 9, cz = 11;
		const { x, z, top } = findShaftColumn(cx, cz);
		const w = World.create(SEED);
		expect(w.getChunk(cx, cz)).toBeUndefined();
		const o = new ChunkOverlay();
		for (let y = top; y > top - 10; y--) o.set(x, y, z, AIR, 0, 0);
		w.overlay = o;
		const c = w.ensureChunk(cx, cz);
		const lx = x - cx * CHUNK_SIZE_X, lz = z - cz * CHUNK_SIZE_Z;
		expect(c.get(lx, top - 9, lz)).toBe(AIR);
		expect(c.getSky(lx, top - 9, lz)).toBe(15);
	});

	it('T5: overlay water in a dry chunk sets hasLiquid', () => {
		const { cx, cz } = findDryChunk();
		const w = World.create(SEED);
		const o = new ChunkOverlay();
		o.set(cx * CHUNK_SIZE_X + 8, 20, cz * CHUNK_SIZE_Z + 8, WATER, 0, 0);
		w.overlay = o;
		const c = w.ensureChunk(cx, cz);
		expect(c.hasLiquid).toBe(true);
		expect(c.modified).toBe(false);
	});
});
