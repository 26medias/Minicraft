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
		expect(BLOCKS.length).toBe(1009);
		for (let i = 0; i < BLOCKS.length; i++) expect(BLOCKS[i].id).toBe(i);
		expect(BLOCKS[1000].name).toBe('big_tnt');
		expect(BLOCKS[1001].name).toBe('mega_tnt');
		expect(BLOCKS.slice(1004, 1009).map((b) => b.name)).toEqual(['fireworks', 'tunnel_tnt', 'block_bomb', 'flatten_tnt', 'lake_tnt']);
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
		expect(withTnt).toEqual(['big_tnt', 'block_bomb', 'fireworks', 'flatten_tnt', 'lake_tnt', 'mega_tnt', 'tnt', 'tunnel_tnt']);
	});

	it('the blast toys: ids 1004–1008, basics, hardness 0.5, the spec §3 tnt values and shapes, derived <name>_top/_bottom/_side textures', () => {
		// Catches a renumbered toy (saves store ids), a toy without a shape (it would go off as a sphere),
		// a toy with today's radius-3 default, and a texture name build-atlas cannot find.
		const rows: Array<[string, number, { radius: number; fuse: number; shape: string }]> = [
			['fireworks', 1004, { radius: 0, fuse: 1, shape: 'firework' }],
			['tunnel_tnt', 1005, { radius: 0, fuse: 3, shape: 'tunnel' }],
			['block_bomb', 1006, { radius: 5, fuse: 3, shape: 'dome' }],
			['flatten_tnt', 1007, { radius: 6, fuse: 3, shape: 'flatten' }],
			['lake_tnt', 1008, { radius: 4, fuse: 3, shape: 'lake' }],
		];
		for (const [name, id, tnt] of rows) {
			const b = BLOCK_BY_NAME[name];
			expect(b.id, name).toBe(id);
			expect(b.group, name).toBe('basics');
			expect(b.hardness, name).toBe(0.5);
			expect(b.solid, name).toBe(true);
			expect(b.tnt, name).toEqual(tnt);
			expect(b.textures, name).toEqual({ kind: 'top-bottom-side', top: `${name}_top`, bottom: `${name}_bottom`, side: `${name}_side` });
		}
		// Today's tiers stay spheres: no shape field at all, so tntSpec and every saved radius are unchanged.
		for (const n of ['tnt', 'big_tnt', 'mega_tnt']) expect(BLOCK_BY_NAME[n].tnt!.shape, n).toBeUndefined();
	});
});

describe('pad blocks (toys spec §2, §3.1, §3.2)', () => {
	it('slime_pad is 1002 and launch_pad is 1003, with a pad field and no tnt', () => {
		// Catches the pads numbered after the blast toys (1009/1010), a missing `pad` field (Player
		// would never bounce or launch), and a pad given a `tnt` field (ignitable and chain-primed).
		expect(BLOCKS[1002]).toMatchObject({ name: 'slime_pad', pad: 'slime', solid: true, group: 'basics', hardness: 0.5 });
		expect(BLOCKS[1003]).toMatchObject({ name: 'launch_pad', pad: 'launch', solid: true, group: 'basics', hardness: 0.5 });
		expect(BLOCKS[1002].tnt).toBeUndefined();
		expect(BLOCKS[1003].tnt).toBeUndefined();
		expect(BLOCKS[1002].textures).toEqual({ kind: 'uniform', all: 'slime_block' });
		expect(BLOCKS[1003].textures).toEqual({ kind: 'uniform', all: 'launch_pad' });
	});

	it('exactly the two pads carry a pad field', () => {
		// Catches a stray pad field on another row (every landing on it would bounce or launch him).
		expect(BLOCKS.filter((b) => b.pad).map((b) => [b.name, b.pad])).toEqual([['slime_pad', 'slime'], ['launch_pad', 'launch']]);
	});
});
