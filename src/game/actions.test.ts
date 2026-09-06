import { describe, it, expect } from 'vitest';
import { World } from '../engine/world/world';
import { AIR, BLOCK_BY_NAME } from '../data/blocks.data';
import { igniteTnt, canReplace, type PrimedEntry } from './actions';
import { indexOf } from '../engine/world/coords';
import type { VoxelHit } from '../engine/input/raycast';

const tntId = BLOCK_BY_NAME['tnt'].id;
const stoneId = BLOCK_BY_NAME['stone'].id;

function hitAt(x: number, y: number, z: number): VoxelHit {
	return { x, y, z, face: 'py', distance: 0 };
}

describe('igniteTnt', () => {
	it('adds a TNT block to the registry and returns true', () => {
		const w = new World(1);
		w.setBlock(100, 60, 100, tntId);
		const reg = new Map<string, PrimedEntry>();
		const ok = igniteTnt(w, hitAt(100, 60, 100), reg, 2.5);
		expect(ok).toBe(true);
		expect(reg.size).toBe(1);
		const entry = reg.values().next().value!;
		expect(entry.x).toBe(100);
		expect(entry.fuse).toBe(2.5);
	});

	it('returns false on a non-TNT block and does not mutate the registry', () => {
		const w = new World(1);
		w.setBlock(100, 60, 100, stoneId);
		const reg = new Map<string, PrimedEntry>();
		const ok = igniteTnt(w, hitAt(100, 60, 100), reg, 2.5);
		expect(ok).toBe(false);
		expect(reg.size).toBe(0);
	});

	it('returns false on an already-primed TNT (does not reset fuse)', () => {
		const w = new World(1);
		w.setBlock(100, 60, 100, tntId);
		const reg = new Map<string, PrimedEntry>();
		igniteTnt(w, hitAt(100, 60, 100), reg, 2.5);
		const first = reg.values().next().value!;
		first.fuse = 1.0;
		const ok = igniteTnt(w, hitAt(100, 60, 100), reg, 2.5);
		expect(ok).toBe(false);
		expect(reg.size).toBe(1);
		expect(first.fuse).toBe(1.0);
	});
});

const dirtId = BLOCK_BY_NAME['dirt'].id;
const waterId = BLOCK_BY_NAME['water'].id;

describe('canReplace', () => {
	it('allows stone to be replaced by dirt', () => {
		const w = new World(1);
		w.setBlock(100, 60, 100, stoneId);
		expect(canReplace(w, hitAt(100, 60, 100), dirtId)).toBe(true);
	});

	it('refuses a same-block replace', () => {
		const w = new World(1);
		w.setBlock(100, 60, 100, stoneId);
		expect(canReplace(w, hitAt(100, 60, 100), stoneId)).toBe(false);
	});

	it('refuses air and liquid cells', () => {
		const w = new World(1);
		w.setBlock(100, 60, 100, AIR);
		w.setBlock(101, 60, 100, waterId);
		expect(canReplace(w, hitAt(100, 60, 100), stoneId)).toBe(false);
		expect(canReplace(w, hitAt(101, 60, 100), stoneId)).toBe(false);
	});

	it('refuses an unknown block id without throwing', () => {
		const w = new World(1);
		const c = w.ensureChunk(6, 6); // world (100, 60, 100) → chunk 6,6 local 4,60,4
		c.blocks[indexOf(4, 60, 4)] = 0xfffe;
		expect(() => canReplace(w, hitAt(100, 60, 100), stoneId)).not.toThrow();
		expect(canReplace(w, hitAt(100, 60, 100), stoneId)).toBe(false);
	});
});
