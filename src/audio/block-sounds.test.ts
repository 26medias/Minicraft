import { describe, it, expect } from 'vitest';
import { BLOCKS } from '../data/blocks.data';
import { blockSound, soundByName } from './block-sounds';

describe('block sounds', () => {
	it('names map to the material a player expects', () => {
		const want: Record<string, string> = {
			grass_block: 'dirt', dirt: 'dirt', coarse_dirt: 'dirt', white_wool: 'dirt', clay: 'dirt', mud: 'dirt', moss_block: 'dirt', slime_pad: 'dirt',
			mud_bricks: 'stone', stone: 'stone', cobblestone: 'stone', sandstone: 'stone', red_sandstone: 'stone', diamond_ore: 'stone', tnt: 'stone', obsidian: 'stone', black_concrete: 'stone', white_glazed_terracotta: 'stone',
			sand: 'sand', red_sand: 'sand', gravel: 'sand', snow_block: 'sand', red_concrete_powder: 'sand', soul_sand: 'sand',
			oak_log: 'wood', oak_planks: 'wood', stripped_birch_wood: 'wood', crimson_stem: 'wood', crafting_table: 'wood', bookshelf: 'wood', jack_o_lantern: 'wood', bamboo_mosaic: 'wood',
			oak_leaves: 'leaves', flowering_azalea_leaves: 'leaves',
			glass: 'glass', red_stained_glass: 'glass', tinted_glass: 'glass', ice: 'glass', packed_ice: 'glass', sea_lantern: 'glass', amethyst_block: 'glass',
		};
		for (const [name, sound] of Object.entries(want)) expect(soundByName(name), name).toBe(sound);
	});

	it('every live block resolves, and a row can override its name', () => {
		const live = BLOCKS.filter((b) => b && !b.retired);
		expect(live.length).toBeGreaterThan(300);
		for (const b of live) expect(['stone', 'dirt', 'wood', 'sand', 'leaves', 'glass']).toContain(blockSound(b));
		expect(blockSound({ ...live[3], id: -1, name: 'stone', sound: 'wood' })).toBe('wood');
	});
});
