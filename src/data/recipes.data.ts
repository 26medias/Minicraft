import type { PickaxeTier } from './crafting.data';

/** Block names; the count is summed across `anyOf` and taken in listed order (plain before deepslate). */
export type Ingredient = { anyOf: string[]; count: number };
/** The Craft tab's icon tabs (toys spec §5), in display order. */
export type CraftTab = 'pickaxes' | 'boom' | 'toys';
export type Recipe = {
	id: string;
	output: { kind: 'pickaxe'; tier: PickaxeTier } | { kind: 'block'; name: string; count: number };
	needs: Ingredient[];
	/** Which icon tab shows its card. Required: a row with no tab would be on no tab, so never craftable. */
	tab: CraftTab;
};

/** "any worldgen *_log" (spec §4). */
const LOGS = ['oak_log', 'birch_log', 'spruce_log', 'acacia_log', 'cherry_log'];
/** "X ore" = plain first, then deepslate. */
const ore = (x: string, count: number): Ingredient => ({ anyOf: [`${x}_ore`, `deepslate_${x}_ore`], count });
const one = (name: string, count: number): Ingredient => ({ anyOf: [name], count });

/** Spec §4. Adding a recipe is adding a row; every ingredient name must be a counted block (crafting.test.ts). */
export const RECIPES: readonly Recipe[] = Object.freeze([
	{ id: 'wood_pickaxe', output: { kind: 'pickaxe', tier: 1 }, needs: [{ anyOf: LOGS, count: 8 }], tab: 'pickaxes' },
	{ id: 'stone_pickaxe', output: { kind: 'pickaxe', tier: 2 }, needs: [one('stone', 24), { anyOf: LOGS, count: 4 }], tab: 'pickaxes' },
	{ id: 'copper_pickaxe', output: { kind: 'pickaxe', tier: 3 }, needs: [ore('copper', 16), one('stone', 32)], tab: 'pickaxes' },
	{ id: 'iron_pickaxe', output: { kind: 'pickaxe', tier: 4 }, needs: [ore('iron', 16), one('stone', 48)], tab: 'pickaxes' },
	{ id: 'gold_pickaxe', output: { kind: 'pickaxe', tier: 5 }, needs: [ore('gold', 16), ore('redstone', 8)], tab: 'pickaxes' },
	{ id: 'diamond_pickaxe', output: { kind: 'pickaxe', tier: 6 }, needs: [ore('diamond', 8), ore('lapis', 6)], tab: 'pickaxes' },
	{ id: 'emerald_pickaxe', output: { kind: 'pickaxe', tier: 7 }, needs: [ore('emerald', 3), ore('diamond', 4), one('deepslate', 32)], tab: 'pickaxes' },
	{ id: 'tnt', output: { kind: 'block', name: 'tnt', count: 2 }, needs: [one('sand', 5), ore('coal', 4)], tab: 'boom' },
	{ id: 'big_tnt', output: { kind: 'block', name: 'big_tnt', count: 1 }, needs: [one('tnt', 2), ore('redstone', 4)], tab: 'boom' },
	{ id: 'mega_tnt', output: { kind: 'block', name: 'mega_tnt', count: 1 }, needs: [one('big_tnt', 2), ore('lapis', 4)], tab: 'boom' },
	// Toys spec §3.3–3.7, in the Boom tab's card order.
	{ id: 'tunnel_tnt', output: { kind: 'block', name: 'tunnel_tnt', count: 1 }, needs: [one('tnt', 2), ore('iron', 8)], tab: 'boom' },
	{ id: 'flatten_tnt', output: { kind: 'block', name: 'flatten_tnt', count: 1 }, needs: [one('big_tnt', 2), one('stone', 16)], tab: 'boom' },
	{ id: 'lake_tnt', output: { kind: 'block', name: 'lake_tnt', count: 1 }, needs: [one('tnt', 2), one('ice', 4)], tab: 'boom' },
	{ id: 'block_bomb', output: { kind: 'block', name: 'block_bomb', count: 1 }, needs: [one('tnt', 2), one('sand', 8)], tab: 'boom' },
	{ id: 'fireworks', output: { kind: 'block', name: 'fireworks', count: 3 }, needs: [one('sand', 1), ore('coal', 2)], tab: 'boom' },
	// Toys spec §3.1–3.2: the pads.
	{ id: 'slime_pad', output: { kind: 'block', name: 'slime_pad', count: 2 }, needs: [one('moss_block', 4), one('clay', 2)], tab: 'toys' },
	{ id: 'launch_pad', output: { kind: 'block', name: 'launch_pad', count: 1 }, needs: [one('slime_pad', 1), ore('redstone', 4)], tab: 'toys' },
]);
