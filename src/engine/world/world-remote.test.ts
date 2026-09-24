import { describe, it, expect, vi } from 'vitest';
import { World } from './world';
import { AIR, WATER, BLOCK_BY_NAME, isLiquid } from '../../data/blocks.data';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z, indexOf } from './coords';

const SEED = 3;
const STONE = BLOCK_BY_NAME['stone'].id;

/** A non-liquid cell with a WATER neighbour, both inside one chunk's interior (found on a probe world). */
function findCellNextToWater(): { x: number; y: number; z: number; wx: number; wy: number; wz: number; cx: number; cz: number } {
	const probe = World.create(SEED);
	for (let cx = 4; cx < 28; cx++) for (let cz = 4; cz < 28; cz++) {
		const c = probe.ensureChunk(cx, cz);
		if (!c.hasLiquid) { probe.dropChunk(cx, cz); continue; }
		for (let y = 1; y < probe.height - 1; y++) for (let lx = 1; lx < CHUNK_SIZE_X - 1; lx++) for (let lz = 1; lz < CHUNK_SIZE_Z - 1; lz++) {
			if (c.get(lx, y, lz) !== WATER) continue;
			for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
				const nlx = lx + dx, nlz = lz + dz, ny = y + dy;
				if (nlx < 1 || nlx > CHUNK_SIZE_X - 2 || nlz < 1 || nlz > CHUNK_SIZE_Z - 2) continue;
				const id = c.get(nlx, ny, nlz);
				if (id === AIR || isLiquid(id)) continue;
				const bx = cx * CHUNK_SIZE_X, bz = cz * CHUNK_SIZE_Z;
				return { x: bx + nlx, y: ny, z: bz + nlz, wx: bx + lx, wy: y, wz: bz + lz, cx, cz };
			}
		}
		probe.dropChunk(cx, cz);
	}
	throw new Error('no water edge found');
}

function frontiers(w: World): Map<string, number[]> {
	const out = new Map<string, number[]>();
	for (const c of w.allChunks()) out.set(`${c.cx},${c.cz}`, [...c.liquidFrontier].sort((a, b) => a - b));
	return out;
}

describe('World.writeRemote', () => {
	// T6 — never generates an unloaded chunk (spec §6, G1: 27–51 ms and the chunk gets pinned).
	it('T6: returns false on an unloaded chunk and does not load it', () => {
		const w = World.create(SEED);
		w.ensureChunk(0, 0);
		const before = w.chunkCount;
		expect(w.writeRemote(16 * 7 + 1, 40, 16 * 7 + 1, STONE, 0)).toBe(false);
		expect(w.chunkCount).toBe(before);
		expect(w.getChunk(7, 7)).toBeUndefined();
	});

	it('returns false out of bounds and on a no-op; true on a change', () => {
		const w = World.create(SEED);
		const c = w.ensureChunk(2, 2);
		expect(w.writeRemote(-1, 40, 0, STONE, 0)).toBe(false);
		const x = 16 * 2 + 3, z = 16 * 2 + 3;
		const cur = c.get(3, 40, 3);
		expect(w.writeRemote(x, 40, z, cur, c.fluidMeta.get(indexOf(3, 40, 3)) ?? 0)).toBe(false);
		const other = cur === STONE ? AIR : STONE;
		expect(w.writeRemote(x, 40, z, other, 0)).toBe(true);
		expect(c.get(3, 40, 3)).toBe(other);
		expect(c.modified).toBe(true);
	});

	// T2 — the liquid frontier wake (spec §6, G1: without it water froze when its simulating client left).
	it('T2: writeRemote AIR next to water wakes the water, exactly like setBlock', () => {
		const p = findCellNextToWater();
		const w = World.create(SEED);
		w.ensureChunk(p.cx, p.cz);
		for (const c of w.allChunks()) c.liquidFrontier.clear();
		expect(w.writeRemote(p.x, p.y, p.z, AIR, 0)).toBe(true);
		const c = w.getChunk(p.cx, p.cz)!;
		const wi = indexOf(p.wx - p.cx * CHUNK_SIZE_X, p.wy, p.wz - p.cz * CHUNK_SIZE_Z);
		expect(c.liquidFrontier.has(wi)).toBe(true);

		// Control: a fresh world, setBlock on the same cell → identical frontier sets.
		const ctl = World.create(SEED);
		ctl.ensureChunk(p.cx, p.cz);
		for (const k of ctl.allChunks()) k.liquidFrontier.clear();
		ctl.setBlock(p.x, p.y, p.z, AIR);
		expect(frontiers(w)).toEqual(frontiers(ctl));
	});

	it('meta-only: same id with a new fluid bumps rev and sets dirty', () => {
		const w = World.create(SEED);
		const c = w.ensureChunk(3, 3);
		const x = 16 * 3 + 5, y = 50, z = 16 * 3 + 5;
		expect(w.writeRemote(x, y, z, WATER, 0x82)).toBe(true);
		c.dirty = false;
		const rev = c.rev;
		expect(w.writeRemote(x, y, z, WATER, 0x85)).toBe(true);
		expect(c.rev).toBeGreaterThan(rev);
		expect(c.dirty).toBe(true);
		expect(c.fluidMeta.get(indexOf(5, y, 5))).toBe(0x85);
		expect(c.hasLiquid).toBe(true);
		// Back to a source: the entry is removed.
		expect(w.writeRemote(x, y, z, WATER, 0)).toBe(true);
		expect(c.fluidMeta.has(indexOf(5, y, 5))).toBe(false);
	});
});

describe('World.onLocalWrite', () => {
	it('is null by default (solo)', () => {
		expect(World.create(SEED).onLocalWrite).toBeNull();
		expect(World.create(SEED).overlay).toBeNull();
		expect(World.create(SEED).modifiedPins).toBe(true);
	});

	it('setBlock calls the hook once with (x, y, z)', () => {
		const w = World.create(SEED);
		const hook = vi.fn();
		w.onLocalWrite = hook;
		w.setBlock(40, 50, 41, STONE);
		expect(hook).toHaveBeenCalledTimes(1);
		expect(hook).toHaveBeenCalledWith(40, 50, 41);
	});

	it('setBlockFlow calls the hook once with (x, y, z)', () => {
		const w = World.create(SEED);
		const hook = vi.fn();
		w.onLocalWrite = hook;
		w.setBlockFlow(40, 50, 41, WATER, 3);
		expect(hook).toHaveBeenCalledTimes(1);
		expect(hook).toHaveBeenCalledWith(40, 50, 41);
	});

	it('writeRemote never calls the hook', () => {
		const w = World.create(SEED);
		w.ensureChunk(2, 2);
		const hook = vi.fn();
		w.onLocalWrite = hook;
		const other = w.getBlock(40, 50, 41) === STONE ? AIR : STONE;
		expect(w.writeRemote(40, 50, 41, other, 0)).toBe(true);
		expect(w.writeRemote(40, 50, 41, WATER, 0x81)).toBe(true);
		expect(hook).not.toHaveBeenCalled();
	});

	it('an out-of-bounds setBlock does not call the hook', () => {
		const w = World.create(SEED);
		const hook = vi.fn();
		w.onLocalWrite = hook;
		w.setBlock(-1, 50, 0, STONE);
		expect(hook).not.toHaveBeenCalled();
	});
});
