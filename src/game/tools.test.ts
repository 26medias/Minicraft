import { describe, it, expect } from 'vitest';
import type { Face } from '../data/blocks.data';
import type { PickaxeTier } from '../data/crafting.data';
import { areaCells, areaBounds, isMultiBlock, inHeldZone, miningDuration, nextOwnedTier, type Cell } from './tools';

const T: Cell = { x: 10, y: 20, z: 30 };
const key = (c: Cell) => `${c.x},${c.y},${c.z}`;
const sorted = (cells: Cell[]) => cells.map(key).sort();
/** Literal ranges → the exact sorted cell list. */
function box(xs: number[], ys: number[], zs: number[]): string[] {
	const out: string[] = [];
	for (const x of xs) for (const y of ys) for (const z of zs) out.push(`${x},${y},${z}`);
	return out.sort();
}
const TIERS: PickaxeTier[] = [0, 1, 2, 3, 4, 5, 6, 7];
const FACES: Face[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

describe('areaCells — exact lists (spec §5; catches depth running toward the player, or an off-centre face plane)', () => {
	it('+x face: depth runs toward −x from the target', () => {
		for (const t of [0, 1, 2] as const) expect(areaCells(T, 'px', t)).toEqual([T]);
		expect(areaCells(T, 'px', 3)).toEqual([{ x: 10, y: 20, z: 30 }, { x: 9, y: 20, z: 30 }]);
		expect(sorted(areaCells(T, 'px', 4))).toEqual(box([10], [19, 20, 21], [29, 30, 31]));
		expect(sorted(areaCells(T, 'px', 5))).toEqual(box([10, 9], [19, 20, 21], [29, 30, 31]));
		expect(sorted(areaCells(T, 'px', 6))).toEqual(box([10, 9, 8], [19, 20, 21], [29, 30, 31]));
		expect(sorted(areaCells(T, 'px', 7))).toEqual(box([10, 9, 8, 7, 6], [18, 19, 20, 21, 22], [28, 29, 30, 31, 32]));
	});

	it('−y face (aimed from below): depth runs toward +y from the target', () => {
		for (const t of [0, 1, 2] as const) expect(areaCells(T, 'ny', t)).toEqual([T]);
		expect(areaCells(T, 'ny', 3)).toEqual([{ x: 10, y: 20, z: 30 }, { x: 10, y: 21, z: 30 }]);
		expect(sorted(areaCells(T, 'ny', 4))).toEqual(box([9, 10, 11], [20], [29, 30, 31]));
		expect(sorted(areaCells(T, 'ny', 5))).toEqual(box([9, 10, 11], [20, 21], [29, 30, 31]));
		expect(sorted(areaCells(T, 'ny', 6))).toEqual(box([9, 10, 11], [20, 21, 22], [29, 30, 31]));
		expect(sorted(areaCells(T, 'ny', 7))).toEqual(box([8, 9, 10, 11, 12], [20, 21, 22, 23, 24], [28, 29, 30, 31, 32]));
	});

	it('sizes are 1,1,1,2,9,18,27,125 on every face, with no duplicate cell', () => {
		for (const f of FACES) {
			expect(TIERS.map((t) => areaCells(T, f, t).length)).toEqual([1, 1, 1, 2, 9, 18, 27, 125]);
			for (const t of TIERS) expect(new Set(areaCells(T, f, t).map(key)).size).toBe(areaCells(T, f, t).length);
		}
	});
});

describe('areaBounds', () => {
	it('is the min/max of areaCells for every tier and face (catches a highlight box that disagrees with what gets mined)', () => {
		for (const f of FACES) for (const t of TIERS) {
			const cells = areaCells(T, f, t);
			const min = [Math.min(...cells.map((c) => c.x)), Math.min(...cells.map((c) => c.y)), Math.min(...cells.map((c) => c.z))];
			const max = [Math.max(...cells.map((c) => c.x)), Math.max(...cells.map((c) => c.y)), Math.max(...cells.map((c) => c.z))];
			expect(areaBounds(T, f, t), `${f} tier ${t}`).toEqual({ min, max });
		}
	});
});

describe('isMultiBlock', () => {
	it('is true from Copper up, by tier only (catches a definition keyed to solid cells)', () => {
		expect(TIERS.map(isMultiBlock)).toEqual([false, false, false, true, true, true, true, true]);
	});
});

describe('inHeldZone', () => {
	const prev = { ...areaBounds(T, 'px', 4), face: 'px' as Face }; // x 10, y 19–21, z 29–31
	it('holds the broken area and the next layer away from the player, nothing else (catches a zone that is the bare box, which no tunnel swing can re-enter)', () => {
		expect(inHeldZone(prev, { x: 9, y: 20, z: 30 })).toBe(true);
		expect(inHeldZone(prev, { x: 9, y: 21, z: 31 })).toBe(true);
		expect(inHeldZone(prev, { x: 10, y: 19, z: 29 })).toBe(true);
		expect(inHeldZone(prev, { x: 8, y: 20, z: 30 })).toBe(false);
		expect(inHeldZone(prev, { x: 11, y: 20, z: 30 })).toBe(false);
		expect(inHeldZone(prev, { x: 9, y: 22, z: 30 })).toBe(false);
		expect(inHeldZone(prev, { x: 9, y: 20, z: 32 })).toBe(false);
	});
});

describe('miningDuration (spec §5)', () => {
	it('is hardness / (1 + bonus) with no floor for single-cell tiers (catches a floor applied to every break)', () => {
		expect(miningDuration(1.2, 0, 'armed')).toBeCloseTo(1.2, 9);
		expect(miningDuration(1.2, 1, 'armed')).toBeCloseTo(1.2 / 1.15, 9);
		expect(miningDuration(0.2, 2, 'armed')).toBeCloseTo(0.2 / 1.5, 9);
	});
	it('multi-block tiers: at least 0.4 s armed, 0.25 s held, plain time when above the floor (catches one floor for both)', () => {
		expect(miningDuration(0.2, 4, 'armed')).toBe(0.4);
		expect(miningDuration(0.2, 4, 'held')).toBe(0.25);
		expect(miningDuration(1.2, 4, 'armed')).toBeCloseTo(0.6, 9);
		expect(miningDuration(1.2, 7, 'held')).toBe(0.25);
		expect(miningDuration(1.2, 7, 'none')).toBeCloseTo(1.2 / 11, 9);
	});
});

describe('nextOwnedTier', () => {
	it('cycles owned tiers ascending and wraps (catches cycling through unowned tiers)', () => {
		expect(nextOwnedTier({ owned: [0, 4, 1], equipped: 1 })).toBe(4);
		expect(nextOwnedTier({ owned: [0, 4, 1], equipped: 4 })).toBe(0);
		expect(nextOwnedTier({ owned: [0], equipped: 0 })).toBe(0);
		expect(nextOwnedTier({ owned: [0, 1, 5], equipped: 3 })).toBe(5);
	});
});
it('nextOwnedTier with only the Hand owned stays at 0 (catches cycling to an unowned tier 1)', () => {
	expect(nextOwnedTier({ owned: [0], equipped: 0 })).toBe(0);
});
