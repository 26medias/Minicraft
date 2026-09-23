import { BLOCK_BY_NAME } from '../../../data/blocks.data';

/** Every block name worldgen v3 may write, in id-resolution order. Exported for the crafting counted-set test (spec §3). */
export const NAMES = [
	'air', 'grass_block', 'dirt', 'stone', 'cobblestone', 'sand', 'water', 'lava', 'bedrock', 'deepslate',
	'granite', 'diorite', 'andesite', 'tuff', 'calcite', 'gravel', 'clay', 'sandstone', 'red_sand', 'red_sandstone',
	'terracotta', 'orange_terracotta', 'yellow_terracotta', 'white_terracotta', 'red_terracotta', 'brown_terracotta', 'light_gray_terracotta',
	'snow_block', 'ice', 'podzol', 'coarse_dirt', 'moss_block', 'dripstone_block', 'mossy_cobblestone', 'smooth_basalt', 'amethyst_block', 'budding_amethyst',
	'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'lapis_ore', 'redstone_ore', 'diamond_ore', 'emerald_ore',
	'deepslate_coal_ore', 'deepslate_iron_ore', 'deepslate_copper_ore', 'deepslate_gold_ore', 'deepslate_lapis_ore', 'deepslate_redstone_ore', 'deepslate_diamond_ore', 'deepslate_emerald_ore',
	'oak_log', 'oak_leaves', 'birch_log', 'birch_leaves', 'spruce_log', 'spruce_leaves', 'acacia_log', 'acacia_leaves', 'cherry_log', 'cherry_leaves',
] as const;
export type V3BlockName = (typeof NAMES)[number];

function resolve(): Record<V3BlockName, number> {
	const out = {} as Record<V3BlockName, number>;
	for (const n of NAMES) {
		if (n === 'air') { out[n] = 0; continue; }
		const def = BLOCK_BY_NAME[n];
		if (!def) throw new Error(`worldgen v3: block '${n}' is not in the catalog`);
		out[n] = def.id;
	}
	return out;
}
/** Every block id worldgen v3 writes, resolved once from the frozen catalog. */
export const V3: Readonly<Record<V3BlockName, number>> = Object.freeze(resolve());
/** §4 terracotta band, indexed by `y & 15`. */
export const TERRA: readonly number[] = Object.freeze([
	V3.terracotta, V3.orange_terracotta, V3.terracotta, V3.yellow_terracotta, V3.terracotta, V3.white_terracotta, V3.red_terracotta, V3.terracotta,
	V3.brown_terracotta, V3.orange_terracotta, V3.terracotta, V3.light_gray_terracotta, V3.terracotta, V3.red_terracotta, V3.orange_terracotta, V3.terracotta,
]);
export const ORE_DEEPSLATE: ReadonlyMap<number, number> = new Map([
	[V3.coal_ore, V3.deepslate_coal_ore], [V3.iron_ore, V3.deepslate_iron_ore], [V3.copper_ore, V3.deepslate_copper_ore], [V3.gold_ore, V3.deepslate_gold_ore],
	[V3.lapis_ore, V3.deepslate_lapis_ore], [V3.redstone_ore, V3.deepslate_redstone_ore], [V3.diamond_ore, V3.deepslate_diamond_ore], [V3.emerald_ore, V3.deepslate_emerald_ore],
]);
export const LOG_IDS: ReadonlySet<number> = new Set([V3.oak_log, V3.birch_log, V3.spruce_log, V3.acacia_log, V3.cherry_log]);
export const LEAF_IDS: ReadonlySet<number> = new Set([V3.oak_leaves, V3.birch_leaves, V3.spruce_leaves, V3.acacia_leaves, V3.cherry_leaves]);
export const ORE_IDS: ReadonlySet<number> = new Set([...ORE_DEEPSLATE.keys(), ...ORE_DEEPSLATE.values()]);
export const isLiquidId = (v: number) => v === V3.water || v === V3.lava;
export const isStoneId = (v: number) => v === V3.stone || v === V3.deepslate;
