import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { BLOCKS, BLOCK_BY_NAME, DEFAULT_HOTBAR, GENERATED_ID_START, GROUP_ORDER } from './blocks.data';
import { CATALOG_BLOCKS } from './blocks.catalog.data';
import { textureNames } from './catalog-rules';
import idMap from './blocks.catalog.ids.json';

const ids = idMap.ids as Record<string, number>;

describe('generated catalog', () => {
	it('has been generated (hundreds of rows)', () => {
		expect(CATALOG_BLOCKS.length).toBeGreaterThan(300);
	});
	it('is dense and id-aligned', () => {
		for (let i = 0; i < BLOCKS.length; i++) expect(BLOCKS[i].id).toBe(i);
	});
	it('keeps base ids 0-19 exactly', () => {
		expect(BLOCKS.slice(0, 20).map((b) => b.name)).toEqual([
			'air', 'grass_block', 'dirt', 'stone', 'cobblestone', 'sand', 'oak_planks', 'oak_log', 'glass',
			'white_wool', 'red_wool', 'blue_wool', 'green_wool', 'yellow_wool', 'black_wool', 'tnt', 'lamp',
			'water', 'lava', 'obsidian',
		]);
	});
	it('matches the frozen id map', () => {
		for (const [name, id] of Object.entries(ids as Record<string, number>)) {
			const row = BLOCKS[id];
			expect(row.retired ? true : row.name === name).toBe(true);
			expect(id).toBeGreaterThanOrEqual(GENERATED_ID_START);
		}
		expect(CATALOG_BLOCKS.length).toBe(Object.keys(ids).length);
	});
	it('has unique names and every texture file', () => {
		const names = new Set<string>();
		for (const b of CATALOG_BLOCKS) {
			if (b.retired) continue;
			expect(names.has(b.name)).toBe(false);
			names.add(b.name);
			for (const t of textureNames(b.textures!)) expect(existsSync(`src/assets/blocks/${t}.png`)).toBe(true);
			expect(GROUP_ORDER).toContain(b.group);
		}
	});
	it('contains the blocks the kid will look for, with the right shape', () => {
		expect(BLOCK_BY_NAME['jack_o_lantern'].textures!.kind).toBe('six');
		expect(BLOCK_BY_NAME['jack_o_lantern'].lightLevel).toBe(15);
		expect(BLOCK_BY_NAME['cyan_glazed_terracotta'].group).toBe('glazed');
		expect(BLOCK_BY_NAME['blue_stained_glass'].translucent).toBe(true);
		expect(BLOCK_BY_NAME['oak_leaves']).toMatchObject({ transparent: true, translucent: false, lightFilter: 0 });
		expect(BLOCK_BY_NAME['stone_bricks']).toBeDefined();
		expect(BLOCK_BY_NAME['infested_stone_bricks']).toBeUndefined();
		expect(BLOCK_BY_NAME['waxed_copper_block']).toBeUndefined();
		expect(BLOCK_BY_NAME['glowstone']).toBeUndefined(); // same look as lamp
		expect(BLOCK_BY_NAME['redstone_lamp'].textures).toEqual({ kind: 'uniform', all: 'redstone_lamp_on' });
		expect(BLOCK_BY_NAME['dropper']).toBeDefined();
	});
	it('pins a few ids so a regeneration cannot renumber silently', () => {
		// Filled in from the first generated ids.json; see Step 5.
		const pinned: Record<string, number> = { acacia_leaves: 20, acacia_log: 21, lime_concrete: 197 };
		expect(Object.keys(pinned).length).toBeGreaterThanOrEqual(3);
		expect(ids).toMatchObject(pinned);
	});
	it('DEFAULT_HOTBAR names all exist', () => {
		for (const id of DEFAULT_HOTBAR) expect(BLOCKS[id].retired).toBeUndefined();
	});
});
