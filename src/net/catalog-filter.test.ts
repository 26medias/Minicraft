import { describe, it, expect } from 'vitest';
import { catalogBlocks, catalogHotbar } from './catalog-filter';
import { AIR, BLOCKS, DEFAULT_HOTBAR } from '../data/blocks.data';
import { resolveHotbar } from '../game/hotbar';
import { inventoryRows } from '../ui/craft-model';

// Spec §5 `catalogMax`: block ids above the server's maximum are removed from the hotbar and hidden
// from the inventory's Blocks tab for this session.

const MAX = 40;
const HIGH = BLOCKS.findIndex((b, i) => i > MAX && b && !b.retired);

describe('catalog filter', () => {
	it('a hotbar id above the maximum is replaced by the default for that slot', () => {
		expect(HIGH).toBeGreaterThan(MAX);
		const saved = [...DEFAULT_HOTBAR];
		saved[4] = HIGH;
		saved[7] = 12;
		const out = catalogHotbar(saved, MAX)!;
		expect(out[4]).toBe(DEFAULT_HOTBAR[4]);
		expect(out[7]).toBe(12);
		// Through the real resolver with the filtered catalog, the slot keeps the default.
		const r = resolveHotbar(out, 4, catalogBlocks(BLOCKS, MAX));
		expect(r.hotbar[4]).toBe(DEFAULT_HOTBAR[4]);
		expect(r.hotbar.every((id) => id <= MAX)).toBe(true);
	});

	it('a default above the maximum becomes an empty slot', () => {
		const out = catalogHotbar([...DEFAULT_HOTBAR], 3)!;
		expect(out.slice(0, 3)).toEqual(DEFAULT_HOTBAR.slice(0, 3));
		expect(out.slice(3).every((id) => id === AIR)).toBe(true);
	});

	it('undefined (no saved bar) stays undefined, so the resolver uses its own default', () => {
		expect(catalogHotbar(undefined, MAX)).toBeUndefined();
	});

	it('ids above the maximum are hidden from the Blocks tab, and ids stay aligned', () => {
		const blocks = catalogBlocks(BLOCKS, MAX);
		expect(blocks.length).toBe(BLOCKS.length);
		for (let i = 0; i < blocks.length; i++) {
			if (!BLOCKS[i]) continue;
			expect(blocks[i].id).toBe(BLOCKS[i].id);
			if (i > MAX) expect(blocks[i].retired).toBe(true);
			else expect(blocks[i]).toBe(BLOCKS[i]);
		}
		const groups = new Set(BLOCKS.filter(Boolean).map((b) => b.group));
		const shown = [...groups].flatMap((g) => inventoryRows(blocks, g));
		expect(shown.length).toBeGreaterThan(0);
		expect(shown.every((b) => b.id <= MAX)).toBe(true);
	});

	it('a maximum at or above the catalog changes nothing', () => {
		expect(catalogBlocks(BLOCKS, BLOCKS.length)).toBe(BLOCKS);
	});
});
