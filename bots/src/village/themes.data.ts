/**
 * The village themes: one palette for the houses and the tower, a statue (template and palette) for the plaza, the
 * path block and the lamp (post + light). Real catalog names only (checked against blockNames() in the test and at
 * startup); never a liquid, TNT, or anything that falls.
 */
import type { Role } from '../brain2/behaviours/templates.data.js';

export interface VillageTheme {
	name: string; description: string;
	build: Record<Role, string>;
	statue: { template: 'creeper' | 'person' | 'heart'; blocks: Record<Role, string> };
	path: string; post: string; light: string;
}

export const THEMES: readonly VillageTheme[] = [
	{
		name: 'cozy wood', description: 'oak plank houses with dark roofs and glass windows, gravel paths, lamps on oak posts, a creeper statue',
		build: { wall: 'oak_planks', roof: 'dark_oak_planks', floor: 'spruce_planks', accent: 'glass' },
		statue: { template: 'creeper', blocks: { wall: 'lime_concrete', roof: 'lime_concrete', floor: 'lime_concrete', accent: 'black_concrete' } },
		path: 'gravel', post: 'oak_log', light: 'lamp',
	},
	{
		name: 'stone fort', description: 'stone brick houses with cobblestone roofs, cobblestone paths, glowing sea lanterns, a golden statue of a person',
		build: { wall: 'stone_bricks', roof: 'cobblestone', floor: 'polished_andesite', accent: 'sea_lantern' },
		statue: { template: 'person', blocks: { wall: 'gold_block', roof: 'gold_block', floor: 'gold_block', accent: 'diamond_block' } },
		path: 'cobblestone', post: 'spruce_log', light: 'sea_lantern',
	},
	{
		name: 'sandy desert', description: 'sandstone houses with orange windows, gravel paths, warm froglight lamps, a big red heart statue',
		build: { wall: 'sandstone', roof: 'cut_sandstone', floor: 'smooth_sandstone', accent: 'orange_terracotta' },
		statue: { template: 'heart', blocks: { wall: 'red_wool', roof: 'red_wool', floor: 'red_wool', accent: 'pink_wool' } },
		path: 'gravel', post: 'stripped_oak_log', light: 'ochre_froglight',
	},
	{
		name: 'snowy', description: 'spruce cabins with snowy roofs and icy blue windows, cobblestone paths, pearly lamps, a snow person statue',
		build: { wall: 'spruce_planks', roof: 'snow_block', floor: 'spruce_planks', accent: 'light_blue_stained_glass' },
		statue: { template: 'person', blocks: { wall: 'snow_block', roof: 'snow_block', floor: 'snow_block', accent: 'blue_ice' } },
		path: 'cobblestone', post: 'spruce_log', light: 'pearlescent_froglight',
	},
];

export const themeSlug = (t: VillageTheme): string => t.name.replace(/ /g, '-');

/** Every block name a theme uses. */
export const themeBlocks = (t: VillageTheme): string[] => [...Object.values(t.build), ...Object.values(t.statue.blocks), t.path, t.post, t.light];

export type Layout = 'row' | 'circle' | 'square';
export const LAYOUTS: Readonly<Record<Layout, string>> = {
	row: 'a row of houses side by side, all facing a little plaza with a statue',
	circle: 'houses in a ring around a round plaza with a statue in the middle',
	square: 'houses on the sides of a square plaza with a statue in the middle',
};
