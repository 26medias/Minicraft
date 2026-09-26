// Source of every PNG in src/assets/blocks/ (texture replacement spec §4.1). One row per file.
// Swap a tile by editing its row, then `npm run import-textures`. Candidates: `npm run import-textures -- --sheet <name>`.
// A swap that changes whether a leaves/grass tile is a grey mask also needs TEXTURE_TINTED (texture-sources.ts) and
// scripts/build-atlas-tints.ts; the tint, ore and provenance tests say which.
import type { TextureSource } from './texture-sources';

export const TEXTURE_SOURCES: Record<string, TextureSource> = {
	acacia_leaves: { pack: 'ppce', file: 'assets/minecraft/textures/block/acacia_leaves.png' },
	acacia_log: { pack: 'ppce', file: 'assets/minecraft/textures/block/acacia_log.png' },
	acacia_log_top: { pack: 'ppce', file: 'assets/minecraft/textures/block/acacia_log_top.png' },
	acacia_planks: { pack: 'ppce', file: 'assets/minecraft/textures/block/acacia_planks.png' },
	amethyst_block: { pack: 'refi', file: 'textures/mcl_amethyst/mcl_amethyst_amethyst_block.png' },
	ancient_debris_side: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/ancient_debris_side.png',
	},
	ancient_debris_top: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/ancient_debris_top.png',
	},
	andesite: { pack: 'ppce', file: 'assets/minecraft/textures/block/andesite.png' },
	azalea_leaves: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_lush_caves/mcl_lush_caves_azalea_leaves.png',
	},
	bamboo_block: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_bamboo/mcl_bamboo_bamboo_block.png',
	},
	bamboo_block_top: { pack: 'refi', file: 'textures/mcl_bamboo/mcl_bamboo_bamboo_bottom.png' },
	bamboo_mosaic: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_bamboo/mcl_bamboo_bamboo_plank_mosaic.png',
	},
	bamboo_planks: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_bamboo/mcl_bamboo_bamboo_plank.png',
	},
	barrel_bottom: { pack: 'ppce', file: 'assets/minecraft/textures/block/barrel_bottom.png' },
	barrel_side: { pack: 'ppce', file: 'assets/minecraft/textures/block/barrel_side.png' },
	barrel_top: { pack: 'ppce', file: 'assets/minecraft/textures/block/barrel_top.png' },
	basalt_side: { pack: 'ppce', file: 'assets/minecraft/textures/block/basalt_side.png' },
	basalt_top: { pack: 'ppce', file: 'assets/minecraft/textures/block/basalt_top.png' },
	bedrock: { pack: 'ppce', file: 'assets/minecraft/textures/block/bedrock.png' },
	bee_nest_bottom: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_beehives/mcl_beehives_bee_nest_bottom.png',
	},
	bee_nest_front: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_beehives/mcl_beehives_bee_nest_front.png',
	},
	bee_nest_side: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_beehives/mcl_beehives_bee_nest_side.png',
	},
	bee_nest_top: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_beehives/mcl_beehives_bee_nest_top.png',
	},
	beehive_end: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_beehives/mcl_beehives_beehive_end.png',
	},
	beehive_front: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_beehives/mcl_beehives_beehive_front.png',
	},
	beehive_side: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_beehives/mcl_beehives_beehive_side.png',
	},
	birch_leaves: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_core/mcl_core_leaves_birch.png',
	},
	birch_log: { pack: 'ppce', file: 'assets/minecraft/textures/block/birch_log.png' },
	birch_log_top: { pack: 'ppce', file: 'assets/minecraft/textures/block/birch_log_top.png' },
	birch_planks: { pack: 'ppce', file: 'assets/minecraft/textures/block/birch_planks.png' },
	black_concrete: { flat: [0, 0, 0], alpha: 255 }, // pure black, no texture (user decision 2026-09-26)
	black_concrete_powder: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/black_concrete_powder.png',
	},
	black_glazed_terracotta: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/black_glazed_terracotta.png',
	},
	black_stained_glass: { flat: [0x1d, 0x1d, 0x21], alpha: 140 },
	black_terracotta: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/black_terracotta.png',
	},
	black_wool: { pack: 'ppce', file: 'assets/minecraft/textures/block/black_wool.png' },
	blackstone: { pack: 'ppce', file: 'assets/minecraft/textures/block/blackstone.png' },
	blackstone_top: { pack: 'ppce', file: 'assets/minecraft/textures/block/blackstone_top.png' },
	blast_furnace_front: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/blast_furnace_front.png',
	},
	blast_furnace_side: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/blast_furnace_side.png',
	},
	blast_furnace_top: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/blast_furnace_top.png',
	},
	blue_concrete: { pack: 'ppce', file: 'assets/minecraft/textures/block/blue_concrete.png' },
	blue_concrete_powder: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/blue_concrete_powder.png',
	},
	blue_glazed_terracotta: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/blue_glazed_terracotta.png',
	},
	blue_ice: { pack: 'ppce', file: 'assets/minecraft/textures/block/blue_ice.png' },
	blue_stained_glass: { flat: [0x3c, 0x44, 0xaa], alpha: 140 },
	blue_terracotta: { pack: 'ppce', file: 'assets/minecraft/textures/block/blue_terracotta.png' },
	blue_wool: { pack: 'ppce', file: 'assets/minecraft/textures/block/blue_wool.png' },
	bone_block_side: { pack: 'ppce', file: 'assets/minecraft/textures/block/bone_block_side.png' },
	bone_block_top: { pack: 'ppce', file: 'assets/minecraft/textures/block/bone_block_top.png' },
	bookshelf: { pack: 'ppce', file: 'assets/minecraft/textures/block/bookshelf.png' },
	brain_coral_block: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/brain_coral_block.png',
	},
	bricks: { pack: 'ppce', file: 'assets/minecraft/textures/block/bricks.png' },
	brown_concrete: { pack: 'ppce', file: 'assets/minecraft/textures/block/brown_concrete.png' },
	brown_concrete_powder: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/brown_concrete_powder.png',
	},
	brown_glazed_terracotta: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/brown_glazed_terracotta.png',
	},
	brown_stained_glass: { flat: [0x83, 0x54, 0x32], alpha: 140 },
	brown_terracotta: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/brown_terracotta.png',
	},
	brown_wool: { pack: 'ppce', file: 'assets/minecraft/textures/block/brown_wool.png' },
	bubble_coral_block: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/bubble_coral_block.png',
	},
	budding_amethyst: {
		pack: 'refi',
		file: 'textures/mcl_amethyst/mcl_amethyst_budding_amethyst.png',
	},
	calcite: { pack: 'refi', file: 'textures/mcl_amethyst/mcl_amethyst_calcite_block.png' },
	cartography_table_side1: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/cartography_table_side1.png',
	},
	cartography_table_side2: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/cartography_table_side2.png',
	},
	cartography_table_side3: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/cartography_table_side3.png',
	},
	cartography_table_top: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/cartography_table_top.png',
	},
	carved_pumpkin: { pack: 'ppce', file: 'assets/minecraft/textures/block/carved_pumpkin.png' },
	cherry_leaves: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_cherry_blossom/mcl_cherry_blossom_leaves.png',
	},
	cherry_log: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_cherry_blossom/mcl_cherry_blossom_log.png',
	},
	cherry_log_top: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_cherry_blossom/mcl_cherry_blossom_log_top.png',
	},
	cherry_planks: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_cherry_blossom/mcl_cherry_blossom_planks.png',
	},
	chiseled_copper: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_copper/mcl_copper_block_chiseled.png',
	},
	chiseled_deepslate: { pack: 'refi', file: 'textures/mcl_deepslate/mcl_deepslate_chiseled.png' },
	chiseled_nether_bricks: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/chiseled_nether_bricks.png',
	},
	chiseled_polished_blackstone: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/chiseled_polished_blackstone.png',
	},
	chiseled_quartz_block: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/chiseled_quartz_block.png',
	},
	chiseled_quartz_block_top: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/chiseled_quartz_block_top.png',
	},
	chiseled_red_sandstone: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/chiseled_red_sandstone.png',
	},
	chiseled_resin_bricks: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_pale_oak/mcl_pale_oak_chiseled_resin_bricks.png',
	},
	chiseled_sandstone: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/chiseled_sandstone.png',
	},
	chiseled_stone_bricks: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/chiseled_stone_bricks.png',
	},
	chiseled_tuff: { pack: 'refi', file: 'textures/mcl_deepslate/mcl_deepslate_tuff_chiseled.png' },
	chiseled_tuff_bricks: {
		pack: 'refi',
		file: 'textures/mcl_deepslate/mcl_deepslate_tuff_chiseled_bricks.png',
	},
	chiseled_tuff_bricks_top: {
		pack: 'refi',
		file: 'textures/mcl_deepslate/mcl_deepslate_tuff_chiseled_bricks_top.png',
	},
	chiseled_tuff_top: {
		pack: 'refi',
		file: 'textures/mcl_deepslate/mcl_deepslate_tuff_chiseled_top.png',
	},
	clay: { pack: 'bauniclonia', file: 'mineclonia/ITEMS/mcl_core/default_clay.png' },
	coal_block: { pack: 'ppce', file: 'assets/minecraft/textures/block/coal_block.png' },
	coal_ore: { pack: 'ppce', file: 'assets/minecraft/textures/block/coal_ore.png' },
	coarse_dirt: { pack: 'ppce', file: 'assets/minecraft/textures/block/coarse_dirt.png' },
	cobbled_deepslate: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_deepslate/mcl_deepslate_cobbled.png',
	},
	cobblestone: { pack: 'ppce', file: 'assets/minecraft/textures/block/cobblestone.png' },
	copper_block: { pack: 'bauniclonia', file: 'mineclonia/ITEMS/mcl_copper/mcl_copper_block.png' },
	copper_bulb: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_copper/mcl_copper_block_bulb_off.png',
	},
	copper_grate: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_copper/mcl_copper_block_grate.png',
	},
	copper_ore: {
		over: 'stone',
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_copper/mcl_copper_ore.png',
	},
	cracked_deepslate_bricks: {
		pack: 'refi',
		file: 'textures/mcl_deepslate/mcl_deepslate_bricks_cracked.png',
	},
	cracked_deepslate_tiles: {
		pack: 'refi',
		file: 'textures/mcl_deepslate/mcl_deepslate_tiles_cracked.png',
	},
	cracked_nether_bricks: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/cracked_nether_bricks.png',
	},
	cracked_polished_blackstone_bricks: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/cracked_polished_blackstone_bricks.png',
	},
	cracked_stone_bricks: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/cracked_stone_bricks.png',
	},
	crafter_bottom: { pack: 'refi', file: 'textures/mcl_crafter/mcl_crafter_bottom.png' },
	crafter_east: { pack: 'refi', file: 'textures/mcl_crafter/mcl_crafter_side.png' },
	crafter_north: { pack: 'refi', file: 'textures/mcl_crafter/mcl_crafter_front_off.png' },
	crafter_south: { pack: 'refi', file: 'textures/mcl_crafter/mcl_crafter_back.png' },
	crafter_top: { pack: 'refi', file: 'textures/mcl_crafter/mcl_crafter_top_off.png' },
	crafter_west: { pack: 'refi', file: 'textures/mcl_crafter/mcl_crafter_side.png' },
	crafting_table_front: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/crafting_table_front.png',
	},
	crafting_table_side: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/crafting_table_side.png',
	},
	crafting_table_top: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/crafting_table_top.png',
	},
	creaking_heart_awake: {
		derive: 'tint',
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_pale_oak/mcl_pale_oak_log.png',
		tint: [0x6e, 0x5a, 0x50],
		targetLum: 120,
	},
	creaking_heart_top_awake: {
		derive: 'tint',
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_pale_oak/mcl_pale_oak_log_top.png',
		tint: [0x6e, 0x5a, 0x50],
		targetLum: 120,
	},
	crimson_nylium: { pack: 'ppce', file: 'assets/minecraft/textures/block/crimson_nylium.png' },
	crimson_nylium_side: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/crimson_nylium_side.png',
	},
	crimson_planks: { pack: 'ppce', file: 'assets/minecraft/textures/block/crimson_planks.png' },
	crimson_stem: { pack: 'ppce', file: 'assets/minecraft/textures/block/crimson_stem.png' },
	crimson_stem_top: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/crimson_stem_top.png',
	},
	crying_obsidian: { pack: 'ppce', file: 'assets/minecraft/textures/block/crying_obsidian.png' },
	cut_copper: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_copper/mcl_copper_block_cut.png',
	},
	cut_red_sandstone: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/cut_red_sandstone.png',
	},
	cut_sandstone: { pack: 'ppce', file: 'assets/minecraft/textures/block/cut_sandstone.png' },
	cyan_concrete: { pack: 'ppce', file: 'assets/minecraft/textures/block/cyan_concrete.png' },
	cyan_concrete_powder: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/cyan_concrete_powder.png',
	},
	cyan_glazed_terracotta: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/cyan_glazed_terracotta.png',
	},
	cyan_stained_glass: { flat: [0x16, 0x9c, 0x9c], alpha: 140 },
	cyan_terracotta: { pack: 'ppce', file: 'assets/minecraft/textures/block/cyan_terracotta.png' },
	cyan_wool: { pack: 'ppce', file: 'assets/minecraft/textures/block/cyan_wool.png' },
	dark_oak_leaves: { pack: 'ppce', file: 'assets/minecraft/textures/block/dark_oak_leaves.png' },
	dark_oak_log: { pack: 'ppce', file: 'assets/minecraft/textures/block/dark_oak_log.png' },
	dark_oak_log_top: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/dark_oak_log_top.png',
	},
	dark_oak_planks: { pack: 'ppce', file: 'assets/minecraft/textures/block/dark_oak_planks.png' },
	dark_prismarine: { pack: 'ppce', file: 'assets/minecraft/textures/block/dark_prismarine.png' },
	dead_brain_coral_block: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/dead_brain_coral_block.png',
	},
	dead_bubble_coral_block: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/dead_bubble_coral_block.png',
	},
	dead_fire_coral_block: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/dead_fire_coral_block.png',
	},
	dead_horn_coral_block: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/dead_horn_coral_block.png',
	},
	dead_tube_coral_block: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/dead_tube_coral_block.png',
	},
	deepslate: { pack: 'bauniclonia', file: 'mineclonia/ITEMS/mcl_deepslate/mcl_deepslate.png' },
	deepslate_bricks: { pack: 'refi', file: 'textures/mcl_deepslate/mcl_deepslate_bricks.png' },
	deepslate_coal_ore: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_deepslate/mcl_deepslate_coal_ore.png',
	},
	deepslate_copper_ore: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_deepslate/mcl_deepslate_copper_ore.png',
	},
	deepslate_diamond_ore: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_deepslate/mcl_deepslate_diamond_ore.png',
	},
	deepslate_emerald_ore: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_deepslate/mcl_deepslate_emerald_ore.png',
	},
	deepslate_gold_ore: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_deepslate/mcl_deepslate_gold_ore.png',
	},
	deepslate_iron_ore: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_deepslate/mcl_deepslate_iron_ore.png',
	},
	deepslate_lapis_ore: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_deepslate/mcl_deepslate_lapis_ore.png',
	},
	deepslate_redstone_ore: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_deepslate/mcl_deepslate_redstone_ore.png',
	},
	deepslate_tiles: { pack: 'refi', file: 'textures/mcl_deepslate/mcl_deepslate_tiles.png' },
	deepslate_top: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_deepslate/mcl_deepslate_top.png',
	},
	destroy_stage_0: { pack: 'ppce', file: 'assets/minecraft/textures/block/destroy_stage_0.png' },
	destroy_stage_1: { pack: 'ppce', file: 'assets/minecraft/textures/block/destroy_stage_1.png' },
	destroy_stage_2: { pack: 'ppce', file: 'assets/minecraft/textures/block/destroy_stage_2.png' },
	destroy_stage_3: { pack: 'ppce', file: 'assets/minecraft/textures/block/destroy_stage_3.png' },
	destroy_stage_4: { pack: 'ppce', file: 'assets/minecraft/textures/block/destroy_stage_4.png' },
	destroy_stage_5: { pack: 'ppce', file: 'assets/minecraft/textures/block/destroy_stage_5.png' },
	destroy_stage_6: { pack: 'ppce', file: 'assets/minecraft/textures/block/destroy_stage_6.png' },
	destroy_stage_7: { pack: 'ppce', file: 'assets/minecraft/textures/block/destroy_stage_7.png' },
	destroy_stage_8: { pack: 'ppce', file: 'assets/minecraft/textures/block/destroy_stage_8.png' },
	destroy_stage_9: { pack: 'ppce', file: 'assets/minecraft/textures/block/destroy_stage_9.png' },
	diamond_block: { pack: 'ppce', file: 'assets/minecraft/textures/block/diamond_block.png' },
	diamond_ore: { pack: 'ppce', file: 'assets/minecraft/textures/block/diamond_ore.png' },
	diorite: { pack: 'ppce', file: 'assets/minecraft/textures/block/diorite.png' },
	dirt: { pack: 'ppce', file: 'assets/minecraft/textures/block/dirt.png' },
	dispenser_front: { pack: 'ppce', file: 'assets/minecraft/textures/block/dispenser_front.png' },
	dried_kelp_bottom: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/dried_kelp_bottom.png',
	},
	dried_kelp_side: { pack: 'ppce', file: 'assets/minecraft/textures/block/dried_kelp_side.png' },
	dried_kelp_top: { pack: 'ppce', file: 'assets/minecraft/textures/block/dried_kelp_top.png' },
	dripstone_block: { pack: 'refi', file: 'textures/mcl_dripstone/dripstone_block.png' },
	dropper_front: { pack: 'ppce', file: 'assets/minecraft/textures/block/dropper_front.png' },
	emerald_block: { pack: 'ppce', file: 'assets/minecraft/textures/block/emerald_block.png' },
	emerald_ore: { pack: 'ppce', file: 'assets/minecraft/textures/block/emerald_ore.png' },
	end_stone: { pack: 'ppce', file: 'assets/minecraft/textures/block/end_stone.png' },
	end_stone_bricks: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/end_stone_bricks.png',
	},
	exposed_chiseled_copper: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_copper/mcl_copper_exposed_chiseled.png',
	},
	exposed_copper: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_copper/mcl_copper_exposed.png',
	},
	exposed_copper_bulb: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_copper/mcl_copper_exposed_bulb_off.png',
	},
	exposed_copper_grate: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_copper/mcl_copper_exposed_grate.png',
	},
	exposed_cut_copper: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_copper/mcl_copper_exposed_cut.png',
	},
	fire_coral_block: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/fire_coral_block.png',
	},
	fletching_table_front: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/fletching_table_front.png',
	},
	fletching_table_side: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/fletching_table_side.png',
	},
	fletching_table_top: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/fletching_table_top.png',
	},
	flowering_azalea_leaves: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_lush_caves/mcl_lush_caves_azalea_leaves_flowering.png',
	},
	furnace_front: { pack: 'ppce', file: 'assets/minecraft/textures/block/furnace_front.png' },
	furnace_side: { pack: 'ppce', file: 'assets/minecraft/textures/block/furnace_side.png' },
	furnace_top: { pack: 'ppce', file: 'assets/minecraft/textures/block/furnace_top.png' },
	gilded_blackstone: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/gilded_blackstone.png',
	},
	glass: { flat: [0xdc, 0xef, 0xf5], alpha: 70 },
	glowstone: { pack: 'ppce', file: 'assets/minecraft/textures/block/glowstone.png' },
	gold_block: { pack: 'ppce', file: 'assets/minecraft/textures/block/gold_block.png' },
	gold_ore: { pack: 'ppce', file: 'assets/minecraft/textures/block/gold_ore.png' },
	granite: { pack: 'ppce', file: 'assets/minecraft/textures/block/granite.png' },
	grass_block_side: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/grass_block_side.png',
	},
	grass_block_top: { pack: 'ppce', file: 'assets/minecraft/textures/block/grass_block_top.png' },
	gravel: { pack: 'ppce', file: 'assets/minecraft/textures/block/gravel.png' },
	gray_concrete: { pack: 'ppce', file: 'assets/minecraft/textures/block/gray_concrete.png' },
	gray_concrete_powder: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/gray_concrete_powder.png',
	},
	gray_glazed_terracotta: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/gray_glazed_terracotta.png',
	},
	gray_stained_glass: { flat: [0x47, 0x4f, 0x52], alpha: 140 },
	gray_terracotta: { pack: 'ppce', file: 'assets/minecraft/textures/block/gray_terracotta.png' },
	gray_wool: { pack: 'ppce', file: 'assets/minecraft/textures/block/gray_wool.png' },
	green_concrete: { pack: 'ppce', file: 'assets/minecraft/textures/block/green_concrete.png' },
	green_concrete_powder: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/green_concrete_powder.png',
	},
	green_glazed_terracotta: {
		pack: 'refi',
		file: 'textures/mcl_colorblocks/mcl_colorblocks_glazed_terracotta_green.png',
	},
	green_stained_glass: { flat: [0x5e, 0x7c, 0x16], alpha: 140 },
	green_terracotta: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/green_terracotta.png',
	},
	green_wool: { pack: 'ppce', file: 'assets/minecraft/textures/block/green_wool.png' },
	hay_block_side: { pack: 'ppce', file: 'assets/minecraft/textures/block/hay_block_side.png' },
	hay_block_top: { pack: 'ppce', file: 'assets/minecraft/textures/block/hay_block_top.png' },
	honeycomb_block: { pack: 'ppce', file: 'assets/minecraft/textures/block/honeycomb_block.png' },
	horn_coral_block: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/horn_coral_block.png',
	},
	ice: { pack: 'ppce', file: 'assets/minecraft/textures/block/ice.png' },
	iron_bars: { pack: 'ppce', file: 'assets/minecraft/textures/block/iron_bars.png' },
	iron_block: {
		pack: 'refi',
		file: 'textures/default_mcl_core/minerals_ores/default_steel_block.png',
	},
	iron_ore: { pack: 'ppce', file: 'assets/minecraft/textures/block/iron_ore.png' },
	jack_o_lantern: { pack: 'ppce', file: 'assets/minecraft/textures/block/jack_o_lantern.png' },
	jukebox_side: { pack: 'ppce', file: 'assets/minecraft/textures/block/jukebox_side.png' },
	jukebox_top: { pack: 'ppce', file: 'assets/minecraft/textures/block/jukebox_top.png' },
	jungle_leaves: { pack: 'ppce', file: 'assets/minecraft/textures/block/jungle_leaves.png' },
	jungle_log: { pack: 'ppce', file: 'assets/minecraft/textures/block/jungle_log.png' },
	jungle_log_top: { pack: 'ppce', file: 'assets/minecraft/textures/block/jungle_log_top.png' },
	jungle_planks: { pack: 'ppce', file: 'assets/minecraft/textures/block/jungle_planks.png' },
	lapis_block: { pack: 'ppce', file: 'assets/minecraft/textures/block/lapis_block.png' },
	lapis_ore: { pack: 'ppce', file: 'assets/minecraft/textures/block/lapis_ore.png' },
	lava_still: { pack: 'ppce', file: 'assets/minecraft/textures/block/lava_still.png' },
	light_blue_concrete: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/light_blue_concrete.png',
	},
	light_blue_concrete_powder: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/light_blue_concrete_powder.png',
	},
	light_blue_glazed_terracotta: {
		pack: 'refi',
		file: 'textures/mcl_colorblocks/mcl_colorblocks_glazed_terracotta_light_blue.png',
	},
	light_blue_stained_glass: { flat: [0x3a, 0xb3, 0xda], alpha: 140 },
	light_blue_terracotta: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/light_blue_terracotta.png',
	},
	light_blue_wool: { pack: 'ppce', file: 'assets/minecraft/textures/block/light_blue_wool.png' },
	light_gray_concrete: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/light_gray_concrete.png',
	},
	light_gray_concrete_powder: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/light_gray_concrete_powder.png',
	},
	light_gray_glazed_terracotta: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/light_gray_glazed_terracotta.png',
	},
	light_gray_stained_glass: { flat: [0x9d, 0x9d, 0x97], alpha: 140 },
	light_gray_terracotta: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/light_gray_terracotta.png',
	},
	light_gray_wool: { pack: 'ppce', file: 'assets/minecraft/textures/block/light_gray_wool.png' },
	lime_concrete: { pack: 'ppce', file: 'assets/minecraft/textures/block/lime_concrete.png' },
	lime_concrete_powder: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/lime_concrete_powder.png',
	},
	lime_glazed_terracotta: {
		pack: 'refi',
		file: 'textures/mcl_colorblocks/mcl_colorblocks_glazed_terracotta_lime.png',
	},
	lime_stained_glass: { flat: [0x80, 0xc7, 0x1f], alpha: 140 },
	lime_terracotta: { pack: 'ppce', file: 'assets/minecraft/textures/block/lime_terracotta.png' },
	lime_wool: { pack: 'ppce', file: 'assets/minecraft/textures/block/lime_wool.png' },
	lodestone_side: { pack: 'refi', file: 'textures/HUD/lodestone_side4.png' },
	lodestone_top: { pack: 'ppce', file: 'assets/minecraft/textures/block/lodestone_top.png' },
	loom_bottom: { pack: 'refi', file: 'textures/mcl_workstations/mcl_loom_bottom.png' },
	loom_front: { pack: 'refi', file: 'textures/mcl_workstations/mcl_loom_front.png' },
	loom_side: { pack: 'refi', file: 'textures/mcl_workstations/mcl_loom_left.png' },
	loom_top: { pack: 'refi', file: 'textures/mcl_workstations/mcl_loom_top.png' },
	magenta_concrete: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/magenta_concrete.png',
	},
	magenta_concrete_powder: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/magenta_concrete_powder.png',
	},
	magenta_glazed_terracotta: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/magenta_glazed_terracotta.png',
	},
	magenta_stained_glass: { flat: [0xc7, 0x4e, 0xbd], alpha: 140 },
	magenta_terracotta: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/magenta_terracotta.png',
	},
	magenta_wool: { pack: 'ppce', file: 'assets/minecraft/textures/block/magenta_wool.png' },
	magma: { pack: 'ppce', file: 'assets/minecraft/textures/block/magma.png' },
	mangrove_leaves: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_mangrove/mcl_mangrove_leaves.png',
	},
	mangrove_log: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_mangrove/mcl_mangrove_log.png',
	},
	mangrove_log_top: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_mangrove/mcl_mangrove_log_top.png',
	},
	mangrove_planks: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_mangrove/mcl_mangrove_fence.png',
	},
	melon_side: { pack: 'ppce', file: 'assets/minecraft/textures/block/melon_side.png' },
	melon_top: { pack: 'ppce', file: 'assets/minecraft/textures/block/melon_top.png' },
	moss_block: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_lush_caves/mcl_lush_caves_moss.png',
	},
	mossy_cobblestone: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/mossy_cobblestone.png',
	},
	mossy_stone_bricks: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/mossy_stone_bricks.png',
	},
	mud: { pack: 'bauniclonia', file: 'mineclonia/ITEMS/mcl_mud/mcl_mud.png' },
	mud_bricks: { pack: 'bauniclonia', file: 'mineclonia/ITEMS/mcl_mud/mcl_mud_bricks.png' },
	muddy_mangrove_roots_side: {
		over: 'mud',
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_mangrove/mcl_mangrove_roots_side.png',
	},
	muddy_mangrove_roots_top: {
		over: 'mud',
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_mangrove/mcl_mangrove_roots_top.png',
	},
	mycelium_side: { pack: 'ppce', file: 'assets/minecraft/textures/block/mycelium_side.png' },
	mycelium_top: { pack: 'ppce', file: 'assets/minecraft/textures/block/mycelium_top.png' },
	nether_bricks: { pack: 'ppce', file: 'assets/minecraft/textures/block/nether_bricks.png' },
	nether_gold_ore: { pack: 'ppce', file: 'assets/minecraft/textures/block/nether_gold_ore.png' },
	nether_quartz_ore: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/nether_quartz_ore.png',
	},
	nether_wart_block: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/nether_wart_block.png',
	},
	netherite_block: { pack: 'ppce', file: 'assets/minecraft/textures/block/netherite_block.png' },
	netherrack: { pack: 'ppce', file: 'assets/minecraft/textures/block/netherrack.png' },
	note_block: { pack: 'ppce', file: 'assets/minecraft/textures/block/note_block.png' },
	oak_leaves: { pack: 'ppce', file: 'assets/minecraft/textures/block/oak_leaves.png' },
	oak_log: { pack: 'ppce', file: 'assets/minecraft/textures/block/oak_log.png' },
	oak_log_top: { pack: 'ppce', file: 'assets/minecraft/textures/block/oak_log_top.png' },
	oak_planks: { pack: 'ppce', file: 'assets/minecraft/textures/block/oak_planks.png' },
	observer_back: { pack: 'ppce', file: 'assets/minecraft/textures/block/observer_back.png' },
	observer_front: { pack: 'ppce', file: 'assets/minecraft/textures/block/observer_front.png' },
	observer_side: { pack: 'ppce', file: 'assets/minecraft/textures/block/observer_side.png' },
	observer_top: { pack: 'ppce', file: 'assets/minecraft/textures/block/observer_top.png' },
	obsidian: { pack: 'ppce', file: 'assets/minecraft/textures/block/obsidian.png' },
	ochre_froglight_side: {
		derive: 'tint',
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/shroomlight.png',
		tint: [0xf2, 0xc1, 0x4e],
		targetLum: 210,
	},
	ochre_froglight_top: { same: 'ochre_froglight_side' },
	orange_concrete: { pack: 'ppce', file: 'assets/minecraft/textures/block/orange_concrete.png' },
	orange_concrete_powder: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/orange_concrete_powder.png',
	},
	orange_glazed_terracotta: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/orange_glazed_terracotta.png',
	},
	orange_stained_glass: { flat: [0xf9, 0x80, 0x1d], alpha: 140 },
	orange_terracotta: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/orange_terracotta.png',
	},
	orange_wool: { pack: 'ppce', file: 'assets/minecraft/textures/block/orange_wool.png' },
	oxidized_chiseled_copper: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_copper/mcl_copper_oxidized_chiseled.png',
	},
	oxidized_copper: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_copper/mcl_copper_oxidized.png',
	},
	oxidized_copper_bulb: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_copper/mcl_copper_oxidized_bulb_off.png',
	},
	oxidized_copper_grate: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_copper/mcl_copper_oxidized_grate.png',
	},
	oxidized_cut_copper: { pack: 'refi', file: 'textures/mcl_copper/mcl_copper_oxidized_cut.png' },
	packed_ice: { pack: 'ppce', file: 'assets/minecraft/textures/block/packed_ice.png' },
	packed_mud: { pack: 'bauniclonia', file: 'mineclonia/ITEMS/mcl_mud/mcl_mud_packed_mud.png' },
	pale_moss_block: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_pale_oak/mcl_pale_oak_moss.png',
	},
	pale_oak_leaves: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_pale_oak/mcl_pale_oak_leaves.png',
	},
	pale_oak_log: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_pale_oak/mcl_pale_oak_log.png',
	},
	pale_oak_log_top: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_pale_oak/mcl_pale_oak_log_top.png',
	},
	pale_oak_planks: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_pale_oak/mcl_pale_oak_planks.png',
	},
	pearlescent_froglight_side: {
		derive: 'tint',
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/shroomlight.png',
		tint: [0xe4, 0xa6, 0xe8],
		targetLum: 210,
	},
	pearlescent_froglight_top: { same: 'pearlescent_froglight_side' },
	pink_concrete: { pack: 'ppce', file: 'assets/minecraft/textures/block/pink_concrete.png' },
	pink_concrete_powder: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/pink_concrete_powder.png',
	},
	pink_glazed_terracotta: {
		pack: 'refi',
		file: 'textures/mcl_colorblocks/mcl_colorblocks_glazed_terracotta_pink.png',
	},
	pink_stained_glass: { flat: [0xf3, 0x8b, 0xaa], alpha: 140 },
	pink_terracotta: { pack: 'ppce', file: 'assets/minecraft/textures/block/pink_terracotta.png' },
	pink_wool: { pack: 'ppce', file: 'assets/minecraft/textures/block/pink_wool.png' },
	podzol_side: { pack: 'ppce', file: 'assets/minecraft/textures/block/podzol_side.png' },
	podzol_top: { pack: 'ppce', file: 'assets/minecraft/textures/block/podzol_top.png' },
	polished_andesite: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/polished_andesite.png',
	},
	polished_basalt_side: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/polished_basalt_side.png',
	},
	polished_basalt_top: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/polished_basalt_top.png',
	},
	polished_blackstone: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/polished_blackstone.png',
	},
	polished_blackstone_bricks: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/polished_blackstone_bricks.png',
	},
	polished_deepslate: { pack: 'refi', file: 'textures/mcl_deepslate/mcl_deepslate_polished.png' },
	polished_diorite: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/polished_diorite.png',
	},
	polished_granite: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/polished_granite.png',
	},
	polished_tuff: { pack: 'refi', file: 'textures/mcl_deepslate/mcl_deepslate_tuff_polished.png' },
	prismarine: { pack: 'ppce', file: 'assets/minecraft/textures/block/prismarine.png' },
	prismarine_bricks: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/prismarine_bricks.png',
	},
	pumpkin_side: { pack: 'ppce', file: 'assets/minecraft/textures/block/pumpkin_side.png' },
	pumpkin_top: { pack: 'ppce', file: 'assets/minecraft/textures/block/pumpkin_top.png' },
	purple_concrete: { pack: 'ppce', file: 'assets/minecraft/textures/block/purple_concrete.png' },
	purple_concrete_powder: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/purple_concrete_powder.png',
	},
	purple_glazed_terracotta: {
		pack: 'refi',
		file: 'textures/mcl_colorblocks/mcl_colorblocks_glazed_terracotta_purple.png',
	},
	purple_stained_glass: { flat: [0x89, 0x32, 0xb8], alpha: 140 },
	purple_terracotta: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/purple_terracotta.png',
	},
	purple_wool: { pack: 'ppce', file: 'assets/minecraft/textures/block/purple_wool.png' },
	purpur_block: { pack: 'ppce', file: 'assets/minecraft/textures/block/purpur_block.png' },
	purpur_pillar: { pack: 'ppce', file: 'assets/minecraft/textures/block/purpur_pillar.png' },
	purpur_pillar_top: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/purpur_pillar_top.png',
	},
	quartz_block_bottom: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/quartz_block_bottom.png',
	},
	quartz_block_side: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/quartz_block_side.png',
	},
	quartz_block_top: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/quartz_block_top.png',
	},
	quartz_bricks: { pack: 'ppce', file: 'assets/minecraft/textures/block/quartz_bricks.png' },
	quartz_pillar: { pack: 'ppce', file: 'assets/minecraft/textures/block/quartz_pillar.png' },
	quartz_pillar_top: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/quartz_pillar_top.png',
	},
	raw_copper_block: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_copper/mcl_copper_block_raw.png',
	},
	raw_gold_block: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_raw_ores/mcl_raw_ores_raw_gold_block.png',
	},
	raw_iron_block: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_raw_ores/mcl_raw_ores_raw_iron_block.png',
	},
	red_concrete: { pack: 'ppce', file: 'assets/minecraft/textures/block/red_concrete.png' },
	red_concrete_powder: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/red_concrete_powder.png',
	},
	red_glazed_terracotta: {
		pack: 'refi',
		file: 'textures/mcl_colorblocks/mcl_colorblocks_glazed_terracotta_red.png',
	},
	red_nether_bricks: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/red_nether_bricks.png',
	},
	red_sand: { pack: 'ppce', file: 'assets/minecraft/textures/block/red_sand.png' },
	red_sandstone: { pack: 'ppce', file: 'assets/minecraft/textures/block/red_sandstone.png' },
	red_sandstone_bottom: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/red_sandstone_bottom.png',
	},
	red_sandstone_top: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/red_sandstone_top.png',
	},
	red_stained_glass: { flat: [0xb0, 0x2e, 0x26], alpha: 140 },
	red_terracotta: { pack: 'ppce', file: 'assets/minecraft/textures/block/red_terracotta.png' },
	red_wool: { pack: 'ppce', file: 'assets/minecraft/textures/block/red_wool.png' },
	redstone_block: { pack: 'ppce', file: 'assets/minecraft/textures/block/redstone_block.png' },
	redstone_lamp_on: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/redstone_lamp_on.png',
	},
	redstone_ore: { pack: 'ppce', file: 'assets/minecraft/textures/block/redstone_ore.png' },
	resin_block: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_pale_oak/mcl_pale_oak_resin_block.png',
	},
	resin_bricks: {
		pack: 'refi',
		file: 'textures/mcl_pale_oak/mcl_pale_oak_resin_brick_block.png',
	},
	rooted_dirt: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_lush_caves/mcl_lush_caves_rooted_dirt.png',
	},
	sand: { pack: 'ppce', file: 'assets/minecraft/textures/block/sand.png' },
	sandstone: { pack: 'ppce', file: 'assets/minecraft/textures/block/sandstone.png' },
	sandstone_bottom: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/sandstone_bottom.png',
	},
	sandstone_top: { pack: 'ppce', file: 'assets/minecraft/textures/block/sandstone_top.png' },
	sculk: { pack: 'refi', file: 'textures/mcl_sculk/mcl_sculk_sculk.png' },
	sculk_catalyst_bottom: {
		pack: 'mineclonia',
		file: 'mods/ITEMS/mcl_sculk/textures/mcl_sculk_catalyst_bottom.png',
	},
	sculk_catalyst_side: { pack: 'refi', file: 'textures/mcl_sculk/mcl_sculk_catalyst_side.png' },
	sculk_catalyst_top: { pack: 'refi', file: 'textures/mcl_sculk/mcl_sculk_catalyst_top.png' },
	sea_lantern: { pack: 'ppce', file: 'assets/minecraft/textures/block/sea_lantern.png' },
	shroomlight: { pack: 'ppce', file: 'assets/minecraft/textures/block/shroomlight.png' },
	slime_block: { pack: 'ppce', file: 'assets/minecraft/textures/block/slime_block.png' },
	smithing_table_bottom: {
		pack: 'refi',
		file: 'textures/mcl_workstations/mcl_smithing_table_bottom.png',
	},
	smithing_table_front: {
		pack: 'refi',
		file: 'textures/mcl_workstations/mcl_smithing_table_front.png',
	},
	smithing_table_side: {
		pack: 'refi',
		file: 'textures/mcl_workstations/mcl_smithing_table_side.png',
	},
	smithing_table_top: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/smithing_table_top.png',
	},
	smoker_bottom: { pack: 'ppce', file: 'assets/minecraft/textures/block/smoker_bottom.png' },
	smoker_front: { pack: 'ppce', file: 'assets/minecraft/textures/block/smoker_front.png' },
	smoker_side: { pack: 'ppce', file: 'assets/minecraft/textures/block/smoker_side.png' },
	smoker_top: { pack: 'ppce', file: 'assets/minecraft/textures/block/smoker_top.png' },
	smooth_basalt: {
		pack: 'refi',
		file: 'textures/mcl_blackstone/mcl_blackstone_basalt_smooth.png',
	},
	smooth_stone: { pack: 'ppce', file: 'assets/minecraft/textures/block/smooth_stone.png' },
	snow: { pack: 'ppce', file: 'assets/minecraft/textures/block/snow.png' },
	soul_sand: { pack: 'ppce', file: 'assets/minecraft/textures/block/soul_sand.png' },
	soul_soil: { pack: 'ppce', file: 'assets/minecraft/textures/block/soul_soil.png' },
	sponge: { pack: 'ppce', file: 'assets/minecraft/textures/block/sponge.png' },
	spruce_leaves: { pack: 'ppce', file: 'assets/minecraft/textures/block/spruce_leaves.png' },
	spruce_log: { pack: 'ppce', file: 'assets/minecraft/textures/block/spruce_log.png' },
	spruce_log_top: { pack: 'ppce', file: 'assets/minecraft/textures/block/spruce_log_top.png' },
	spruce_planks: { pack: 'ppce', file: 'assets/minecraft/textures/block/spruce_planks.png' },
	stone: { pack: 'ppce', file: 'assets/minecraft/textures/block/stone.png' },
	stone_bricks: { pack: 'ppce', file: 'assets/minecraft/textures/block/stone_bricks.png' },
	stripped_acacia_log: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/stripped_acacia_log.png',
	},
	stripped_acacia_log_top: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/stripped_acacia_log_top.png',
	},
	stripped_bamboo_block: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_bamboo/mcl_bamboo_bamboo_block_stripped.png',
	},
	stripped_bamboo_block_top: {
		pack: 'refi',
		file: 'textures/mcl_bamboo/mcl_bamboo_bamboo_bottom_stripped.png',
	},
	stripped_birch_log: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/stripped_birch_log.png',
	},
	stripped_birch_log_top: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/stripped_birch_log_top.png',
	},
	stripped_cherry_log: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_cherry_blossom/mcl_cherry_blossom_log_stripped.png',
	},
	stripped_cherry_log_top: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_cherry_blossom/mcl_cherry_blossom_log_top_stripped.png',
	},
	stripped_crimson_stem: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/stripped_crimson_stem.png',
	},
	stripped_crimson_stem_top: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/stripped_crimson_stem_top.png',
	},
	stripped_dark_oak_log: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/stripped_dark_oak_log.png',
	},
	stripped_dark_oak_log_top: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/stripped_dark_oak_log_top.png',
	},
	stripped_jungle_log: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/stripped_jungle_log.png',
	},
	stripped_jungle_log_top: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/stripped_jungle_log_top.png',
	},
	stripped_mangrove_log: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_mangrove/mcl_stripped_mangrove_log_side.png',
	},
	stripped_mangrove_log_top: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_mangrove/mcl_stripped_mangrove_log_top.png',
	},
	stripped_oak_log: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/stripped_oak_log.png',
	},
	stripped_oak_log_top: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/stripped_oak_log_top.png',
	},
	stripped_pale_oak_log: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_pale_oak/mcl_stripped_pale_oak_log_side.png',
	},
	stripped_pale_oak_log_top: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_pale_oak/mcl_stripped_pale_oak_log_top.png',
	},
	stripped_spruce_log: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/stripped_spruce_log.png',
	},
	stripped_spruce_log_top: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/stripped_spruce_log_top.png',
	},
	stripped_warped_stem: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/stripped_warped_stem.png',
	},
	stripped_warped_stem_top: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/stripped_warped_stem_top.png',
	},
	suspicious_gravel_0: {
		over: 'gravel',
		pack: 'mineclonia',
		file: 'mods/ITEMS/mcl_sus_nodes/textures/mcl_sus_nodes_suspicious_overlay.png',
		overlayAlpha: 3,
	},
	suspicious_sand_0: {
		over: 'sand',
		pack: 'mineclonia',
		file: 'mods/ITEMS/mcl_sus_nodes/textures/mcl_sus_nodes_suspicious_overlay.png',
		overlayAlpha: 3,
	},
	target_side: { pack: 'ppce', file: 'assets/minecraft/textures/block/target_side.png' },
	target_top: { pack: 'ppce', file: 'assets/minecraft/textures/block/target_top.png' },
	terracotta: { pack: 'ppce', file: 'assets/minecraft/textures/block/terracotta.png' },
	tinted_glass: { flat: [0x2e, 0x26, 0x36], alpha: 200 },
	tnt_bottom: {
		derive: 'tint',
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/tnt_top1.png',
		tint: [0xe0, 0x40, 0x2c],
		targetLum: 150,
	},
	tnt_side: {
		derive: 'tint',
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/tnt_side2.png',
		tint: [0xe0, 0x40, 0x2c],
		targetLum: 150,
	},
	tnt_top: {
		derive: 'tint',
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/tnt_top2.png',
		tint: [0xe0, 0x40, 0x2c],
		targetLum: 150,
	},
	tube_coral_block: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/tube_coral_block.png',
	},
	tuff: { pack: 'refi', file: 'textures/mcl_deepslate/mcl_deepslate_tuff.png' },
	tuff_bricks: { pack: 'refi', file: 'textures/mcl_deepslate/mcl_deepslate_tuff_bricks.png' },
	verdant_froglight_side: {
		derive: 'tint',
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/shroomlight.png',
		tint: [0x7f, 0xd3, 0x6b],
		targetLum: 210,
	},
	verdant_froglight_top: { same: 'verdant_froglight_side' },
	warped_nylium: { pack: 'ppce', file: 'assets/minecraft/textures/block/warped_nylium.png' },
	warped_nylium_side: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/warped_nylium_side.png',
	},
	warped_planks: { pack: 'ppce', file: 'assets/minecraft/textures/block/warped_planks.png' },
	warped_stem: { pack: 'ppce', file: 'assets/minecraft/textures/block/warped_stem.png' },
	warped_stem_top: { pack: 'ppce', file: 'assets/minecraft/textures/block/warped_stem_top.png' },
	warped_wart_block: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/warped_wart_block.png',
	},
	water_still: { pack: 'ppce', file: 'assets/minecraft/textures/block/water_still.png' },
	weathered_chiseled_copper: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_copper/mcl_copper_weathered_chiseled.png',
	},
	weathered_copper: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_copper/mcl_copper_weathered.png',
	},
	weathered_copper_bulb: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_copper/mcl_copper_weathered_bulb_off.png',
	},
	weathered_copper_grate: {
		pack: 'bauniclonia',
		file: 'mineclonia/ITEMS/mcl_copper/mcl_copper_weathered_grate.png',
	},
	weathered_cut_copper: {
		pack: 'refi',
		file: 'textures/mcl_copper/mcl_copper_weathered_cut.png',
	},
	wet_sponge: { pack: 'ppce', file: 'assets/minecraft/textures/block/wet_sponge.png' },
	white_concrete: { pack: 'ppce', file: 'assets/minecraft/textures/block/white_concrete.png' },
	white_concrete_powder: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/white_concrete_powder.png',
	},
	white_glazed_terracotta: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/white_glazed_terracotta.png',
	},
	white_stained_glass: { flat: [0xf9, 0xff, 0xfe], alpha: 140 },
	white_terracotta: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/white_terracotta.png',
	},
	white_wool: { pack: 'ppce', file: 'assets/minecraft/textures/block/white_wool.png' },
	yellow_concrete: { pack: 'ppce', file: 'assets/minecraft/textures/block/yellow_concrete.png' },
	yellow_concrete_powder: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/yellow_concrete_powder.png',
	},
	yellow_glazed_terracotta: {
		pack: 'refi',
		file: 'textures/mcl_colorblocks/mcl_colorblocks_glazed_terracotta_yellow.png',
	},
	yellow_stained_glass: { flat: [0xfe, 0xd8, 0x3d], alpha: 140 },
	yellow_terracotta: {
		pack: 'ppce',
		file: 'assets/minecraft/textures/block/yellow_terracotta.png',
	},
	yellow_wool: { pack: 'ppce', file: 'assets/minecraft/textures/block/yellow_wool.png' },
};
