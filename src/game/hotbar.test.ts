import { describe, it, expect } from 'vitest';
import { resolveHotbar } from './hotbar';
import { AIR, BLOCKS, DEFAULT_HOTBAR, HOTBAR_SIZE } from '../data/blocks.data';

describe('resolveHotbar', () => {
	it('gives the default hotbar when nothing is saved', () => {
		const r = resolveHotbar(undefined, 0, BLOCKS);
		expect(r).toEqual({ hotbar: DEFAULT_HOTBAR, selected: 0 });
		expect(r.hotbar).toHaveLength(HOTBAR_SIZE);
		expect(r.hotbar).not.toBe(DEFAULT_HOTBAR); // a copy, never the shared constant
	});
	it('replaces a legacy pool with the default and keeps the selected BLOCK, not the index', () => {
		// Deliberately not [1..19]: on that pool the block lookup is an identity map
		// and a plain index clamp would pass. Here index 0 holds white wool (id 9),
		// which sits at index 8 of the default bar.
		const pool = [9, 8, 7, 6, 5, 4, 3, 2, 1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
		expect(resolveHotbar(pool, 0, BLOCKS)).toEqual({ hotbar: DEFAULT_HOTBAR, selected: 8 });
		expect(resolveHotbar(pool, 18, BLOCKS).selected).toBe(0); // obsidian: not in the default bar
	});
	it('keeps a 9-entry hotbar, blanking ids that are not live blocks', () => {
		const saved = [1, 2, 3, 99999, AIR, 6, 7, 8, 9];
		const r = resolveHotbar(saved, 4, BLOCKS);
		expect(r.hotbar).toEqual([1, 2, 3, AIR, AIR, 6, 7, 8, 9]);
		expect(r.selected).toBe(4);
		expect(r.hotbar).toHaveLength(HOTBAR_SIZE);
	});
	it('clamps an out-of-range selection to 0', () => {
		expect(resolveHotbar(DEFAULT_HOTBAR, 9, BLOCKS).selected).toBe(0);
		expect(resolveHotbar(DEFAULT_HOTBAR, -1, BLOCKS).selected).toBe(0);
		expect(resolveHotbar(DEFAULT_HOTBAR, 1.5, BLOCKS).selected).toBe(0);
	});
});
