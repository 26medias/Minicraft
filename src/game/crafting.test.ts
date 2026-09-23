import { describe, it, expect } from 'vitest';
import { RECIPES, type Recipe } from '../data/recipes.data';
import type { PlayerTools } from '../data/crafting.data';
import { canCraft, craft } from './crafting';
import { isCounted } from './inventory';

const R = (id: string): Recipe => RECIPES.find((r) => r.id === id)!;
/** A fresh literal, never DEFAULT_TOOLS itself (Phase B: that constant is shared, never handed out). */
const hand: PlayerTools = { owned: [0], equipped: 0 };

describe('recipe validation (spec §4)', () => {
	it('every ingredient name is a counted block, and tnt is counted (catches a recipe naming a free block, which could be placed and mined back)', () => {
		for (const r of RECIPES) for (const ing of r.needs) for (const n of ing.anyOf) expect(isCounted(n), `${r.id}: ${n}`).toBe(true);
		expect(isCounted('tnt')).toBe(true);
	});
});

describe('canCraft / craft (spec §4)', () => {
	it('accepts either ore variant, summed (catches a check that reads only the first anyOf name)', () => {
		expect(canCraft(R('copper_pickaxe'), { deepslate_copper_ore: 16, stone: 32 }, hand)).toBe(true);
		expect(canCraft(R('copper_pickaxe'), { copper_ore: 9, deepslate_copper_ore: 7, stone: 32 }, hand)).toBe(true);
		expect(canCraft(R('wood_pickaxe'), { oak_log: 3, birch_log: 3, cherry_log: 2 }, hand)).toBe(true);
	});

	it('refuses when short by one on any ingredient (catches > instead of >=, or a check of the first ingredient only)', () => {
		expect(canCraft(R('copper_pickaxe'), { copper_ore: 8, deepslate_copper_ore: 7, stone: 32 }, hand)).toBe(false);
		expect(canCraft(R('copper_pickaxe'), { copper_ore: 16, stone: 31 }, hand)).toBe(false);
		expect(canCraft(R('copper_pickaxe'), { copper_ore: 16, stone: 32 }, hand)).toBe(true);
		const inv = { copper_ore: 16, stone: 31 };
		expect(craft(R('copper_pickaxe'), inv, hand)).toEqual({ inv, tools: hand });
	});

	it('takes plain before deepslate (catches deepslate consumed first)', () => {
		const out = craft(R('copper_pickaxe'), { copper_ore: 10, deepslate_copper_ore: 10, stone: 40 }, hand);
		expect(out.inv).toEqual({ copper_ore: 0, deepslate_copper_ore: 4, stone: 8 });
	});

	it('refuses an owned pickaxe (catches crafting a second copy that burns the ingredients)', () => {
		expect(canCraft(R('wood_pickaxe'), { oak_log: 99 }, { owned: [0, 1], equipped: 0 })).toBe(false);
	});

	it('adds the output: a pickaxe is owned and equipped; a block count goes up by the recipe count (catches TNT added as 1)', () => {
		expect(craft(R('wood_pickaxe'), { oak_log: 8 }, { owned: [0, 4], equipped: 4 })).toEqual({ inv: { oak_log: 0 }, tools: { owned: [0, 1, 4], equipped: 1 } });
		expect(craft(R('tnt'), { sand: 5, coal_ore: 4, tnt: 1 }, hand).inv).toEqual({ sand: 0, coal_ore: 0, tnt: 3 });
		expect(craft(R('big_tnt'), { tnt: 3, redstone_ore: 1, deepslate_redstone_ore: 3 }, hand).inv).toEqual({ tnt: 1, redstone_ore: 0, deepslate_redstone_ore: 0, big_tnt: 1 });
	});

	it('never leaves a count negative, and writes no key for an untouched anyOf name (catches subtracting the full count from each variant)', () => {
		const out = craft(R('wood_pickaxe'), { oak_log: 5, spruce_log: 9 }, hand);
		expect(out.inv).toEqual({ oak_log: 0, spruce_log: 6 });
		for (const v of Object.values(out.inv)) expect(v).toBeGreaterThanOrEqual(0);
	});

	it('does not touch its inputs (catches an in-place mutation that would bypass the save path)', () => {
		const inv = { oak_log: 8 };
		const tools = { owned: [0], equipped: 0 };
		craft(R('wood_pickaxe'), inv, tools);
		expect(inv).toEqual({ oak_log: 8 });
		expect(tools).toEqual({ owned: [0], equipped: 0 });
	});
});
