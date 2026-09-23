/**
 * Crafting: constants and the save-side shapes of counts and tools (spec §2, §10).
 * Later phases add the counted-block list, pickaxe table and mining floors here.
 */

/** Count of a block whose name is absent from the inventory ("never touched"). */
export const STARTING_COUNT = 0;

/** Highest pickaxe tier the client knows (0 = hand ... 7). The API accepts up to 15. */
export const MAX_PICKAXE_TIER = 7;

/** Per-world counts keyed by block NAME. Every touched key is kept, zeros included. */
export type Inventory = Record<string, number>;

/** Owned pickaxe tiers (0 always owned) and the one in hand. */
export type PlayerTools = { owned: number[]; equipped: number };

/** Shared constant: never hand it out, copy it. */
export const DEFAULT_TOOLS: PlayerTools = { owned: [0], equipped: 0 };
/**
 * Spec §3: every block worldgen v3 actually writes, minus water, lava and bedrock. `cobblestone`,
 * `mossy_cobblestone` and `red_sandstone` are in v3 NAMES but never generated, so they stay free.
 * Pinned by the fixed-seed sample test in crafting.data.test.ts; every entry must be in v3 NAMES.
 */
export const WORLDGEN_BLOCKS: readonly string[] = Object.freeze([
	'grass_block', 'dirt', 'stone', 'sand', 'deepslate',
	'granite', 'diorite', 'andesite', 'tuff', 'calcite', 'gravel', 'clay', 'sandstone', 'red_sand',
	'terracotta', 'orange_terracotta', 'yellow_terracotta', 'white_terracotta', 'red_terracotta', 'brown_terracotta', 'light_gray_terracotta',
	'snow_block', 'ice', 'podzol', 'coarse_dirt', 'moss_block', 'dripstone_block', 'smooth_basalt', 'amethyst_block', 'budding_amethyst',
	'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'lapis_ore', 'redstone_ore', 'diamond_ore', 'emerald_ore',
	'deepslate_coal_ore', 'deepslate_iron_ore', 'deepslate_copper_ore', 'deepslate_gold_ore', 'deepslate_lapis_ore', 'deepslate_redstone_ore', 'deepslate_diamond_ore', 'deepslate_emerald_ore',
	'oak_log', 'oak_leaves', 'birch_log', 'birch_leaves', 'spruce_log', 'spruce_leaves', 'acacia_log', 'acacia_leaves', 'cherry_log', 'cherry_leaves',
]);

/** Spec §3: blocks that only crafting makes. They need a count to place in every world. */
export const CRAFTED_ONLY: readonly string[] = Object.freeze(['big_tnt', 'mega_tnt']);

export type PickaxeTier = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
/** `bonus` is a fraction (0.15 = +15 %). `area`: w × h on the hit face, `d` cells deep away from the player. */
export type PickaxeDef = { tier: PickaxeTier; name: string; label: string; bonus: number; area: { w: number; h: number; d: number } };

/** Spec §4 table. Indexed by tier; the tier is also the saved value in `player.tools`. */
export const PICKAXES: readonly PickaxeDef[] = Object.freeze([
	{ tier: 0, name: 'hand', label: 'Hand', bonus: 0, area: { w: 1, h: 1, d: 1 } },
	{ tier: 1, name: 'wood', label: 'Wood Pickaxe', bonus: 0.15, area: { w: 1, h: 1, d: 1 } },
	{ tier: 2, name: 'stone', label: 'Stone Pickaxe', bonus: 0.5, area: { w: 1, h: 1, d: 1 } },
	{ tier: 3, name: 'copper', label: 'Copper Pickaxe', bonus: 0.75, area: { w: 1, h: 1, d: 2 } },
	{ tier: 4, name: 'iron', label: 'Iron Pickaxe', bonus: 1, area: { w: 3, h: 3, d: 1 } },
	{ tier: 5, name: 'gold', label: 'Gold Pickaxe', bonus: 2, area: { w: 3, h: 3, d: 2 } },
	{ tier: 6, name: 'diamond', label: 'Diamond Pickaxe', bonus: 5, area: { w: 3, h: 3, d: 3 } },
	{ tier: 7, name: 'emerald', label: 'Emerald Pickaxe', bonus: 10, area: { w: 5, h: 5, d: 5 } },
]);

/** Spec §5 floors for a multi-block tier, in seconds: an armed break, and a held break inside the previous area. */
export const AREA_FLOOR_ARMED = 0.4;
export const AREA_FLOOR_HELD = 0.25;
