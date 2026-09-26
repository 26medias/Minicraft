/**
 * The builder's palettes: themed block sets per template role. Real catalog names only (checked against the SDK's
 * blockNames() by the builder test and at startup); never a liquid, a CRAFTED_ONLY block, TNT, or anything that falls.
 * `for` limits a palette to some templates; none = any.
 */
import type { Role } from '../brain2/behaviours/templates.data.js';

export interface Palette { name: string; for?: readonly string[]; blocks: Record<Role, string> }

export const PALETTES: readonly Palette[] = [
	{ name: 'cosy oak', for: ['house', 'tower', 'wall'], blocks: { wall: 'oak_planks', roof: 'dark_oak_planks', floor: 'spruce_planks', accent: 'glass' } },
	{ name: 'stone castle', for: ['house', 'tower', 'wall'], blocks: { wall: 'stone_bricks', roof: 'cobblestone', floor: 'polished_andesite', accent: 'sea_lantern' } },
	{ name: 'birch cottage', for: ['house', 'tower'], blocks: { wall: 'birch_planks', roof: 'red_terracotta', floor: 'oak_planks', accent: 'light_blue_stained_glass' } },
	{ name: 'sandy', for: ['house', 'tower', 'wall'], blocks: { wall: 'sandstone', roof: 'cut_sandstone', floor: 'smooth_sandstone', accent: 'orange_terracotta' } },
	{ name: 'brick', for: ['house', 'tower', 'wall'], blocks: { wall: 'bricks', roof: 'dark_oak_planks', floor: 'oak_planks', accent: 'glass' } },
	{ name: 'cherry', for: ['house', 'tower'], blocks: { wall: 'cherry_planks', roof: 'pink_wool', floor: 'birch_planks', accent: 'white_stained_glass' } },
	{ name: 'quartz', for: ['house', 'tower', 'wall'], blocks: { wall: 'quartz_block', roof: 'light_blue_concrete', floor: 'smooth_quartz', accent: 'sea_lantern' } },
	{ name: 'creeper green', for: ['creeper'], blocks: { wall: 'lime_concrete', roof: 'lime_concrete', floor: 'lime_concrete', accent: 'black_concrete' } },
	{ name: 'mossy creeper', for: ['creeper'], blocks: { wall: 'green_wool', roof: 'green_wool', floor: 'green_wool', accent: 'black_wool' } },
	{ name: 'red heart', for: ['heart'], blocks: { wall: 'red_wool', roof: 'red_wool', floor: 'red_wool', accent: 'pink_wool' } },
	{ name: 'pink heart', for: ['heart'], blocks: { wall: 'pink_concrete', roof: 'pink_concrete', floor: 'pink_concrete', accent: 'magenta_concrete' } },
	{ name: 'blue person', for: ['person'], blocks: { wall: 'blue_wool', roof: 'blue_wool', floor: 'blue_wool', accent: 'yellow_wool' } },
	{ name: 'gold person', for: ['person'], blocks: { wall: 'gold_block', roof: 'gold_block', floor: 'gold_block', accent: 'diamond_block' } },
	{ name: 'rainbow', for: ['wall', 'heart', 'person', 'creeper'], blocks: { wall: 'yellow_concrete', roof: 'orange_concrete', floor: 'red_concrete', accent: 'light_blue_concrete' } },
];

/** The palettes allowed for a template. */
export function palettesFor(template: string): Palette[] {
	return PALETTES.filter((p) => !p.for || p.for.includes(template));
}
