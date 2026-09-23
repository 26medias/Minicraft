import { describe, it, expect } from 'vitest';
import { BLOCKS, BLOCK_BY_NAME, GENERATED_ID_START } from './blocks.data';
import { EXTRA_BLOCKS, EXTRA_ID_START } from './blocks.extra.data';
import idMap from './blocks.catalog.ids.json';

const catalogIds = idMap.ids as Record<string, number>;

describe('extra blocks (spec §6)', () => {
	it('EXTRA_ID_START is 1000 and every extra id is at or above it', () => {
		// Catches an extra block numbered inside the catalog range (e.g. 375, the next
		// id gen-catalog would hand out): today it would load, and collide on the next regeneration.
		expect(EXTRA_ID_START).toBe(1000);
		for (const b of EXTRA_BLOCKS) expect(b.id).toBeGreaterThanOrEqual(EXTRA_ID_START);
	});

	it('catalog ids and extra ids do not collide, and extras are not in the frozen id map', () => {
		// Catches adding big_tnt/mega_tnt to blocks.catalog.ids.json (gen-catalog would then
		// own them and could retire or renumber them) and any overlap of the two ranges.
		const catalog = new Set(Object.values(catalogIds));
		for (const b of EXTRA_BLOCKS) {
			expect(catalog.has(b.id)).toBe(false);
			expect(catalogIds[b.name]).toBeUndefined();
		}
		for (const id of catalog) {
			expect(id).toBeGreaterThanOrEqual(GENERATED_ID_START);
			expect(id).toBeLessThan(EXTRA_ID_START);
		}
	});

	it('BLOCKS stays dense and id-aligned up to the extras; the gap is tombstones', () => {
		// Catches dense() being fed without EXTRA_BLOCKS (BLOCK_BY_NAME.big_tnt undefined)
		// and a gap filled with anything that could render or be picked.
		expect(BLOCKS.length).toBe(1002);
		for (let i = 0; i < BLOCKS.length; i++) expect(BLOCKS[i].id).toBe(i);
		expect(BLOCKS[1000].name).toBe('big_tnt');
		expect(BLOCKS[1001].name).toBe('mega_tnt');
		const maxCatalog = Math.max(...Object.values(catalogIds));
		for (let i = maxCatalog + 1; i < EXTRA_ID_START; i++) {
			expect(BLOCKS[i].retired).toBe(true);
			expect(BLOCKS[i].textures).toBeNull();
		}
	});

	it('TNT tiers carry radius and fuse; nothing else does', () => {
		// Catches a missing tnt field on plain TNT (every "is TNT" check reads def.tnt) and a
		// stray tnt field on a non-TNT block (it would be ignitable and chain-primed).
		expect(BLOCK_BY_NAME['tnt'].tnt).toEqual({ radius: 3, fuse: 2.5 });
		expect(BLOCK_BY_NAME['big_tnt'].tnt).toEqual({ radius: 5, fuse: 4 });
		expect(BLOCK_BY_NAME['mega_tnt'].tnt).toEqual({ radius: 8, fuse: 6 });
		const withTnt = BLOCKS.filter((b) => b.tnt).map((b) => b.name).sort();
		expect(withTnt).toEqual(['big_tnt', 'mega_tnt', 'tnt']);
	});
});
