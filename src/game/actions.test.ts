import { describe, it, expect } from 'vitest';
import { World } from '../engine/world/world';
import { BLOCK_BY_NAME } from '../data/blocks.data';
import { igniteTnt, type PrimedEntry } from './actions';
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
