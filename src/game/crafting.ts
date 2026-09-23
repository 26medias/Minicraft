import { STARTING_COUNT, type Inventory, type PlayerTools } from '../data/crafting.data';
import type { Ingredient, Recipe } from '../data/recipes.data';
import { countOf } from './inventory';

/** Summed count across an ingredient's `anyOf` (spec §4). */
export function haveOf(ing: Ingredient, inv: Inventory, start: number = STARTING_COUNT): number {
	return ing.anyOf.reduce((sum, name) => sum + countOf(inv, name, start), 0);
}

/** False when any ingredient is short, or the output pickaxe is already owned. */
export function canCraft(recipe: Recipe, inv: Inventory, tools: PlayerTools, start: number = STARTING_COUNT): boolean {
	if (recipe.output.kind === 'pickaxe' && tools.owned.includes(recipe.output.tier)) return false;
	return recipe.needs.every((ing) => haveOf(ing, inv, start) >= ing.count);
}

/**
 * Pure. Takes each ingredient from `anyOf` in listed order (plain before deepslate), never below 0,
 * then adds the output: a block count, or a pickaxe that is added to `owned` and equipped. A recipe
 * that canCraft refuses returns the inputs unchanged. Crafting reports no count rise: it never
 * feeds the auto-hotbar (spec §3).
 */
export function craft(recipe: Recipe, inv: Inventory, tools: PlayerTools, start: number = STARTING_COUNT): { inv: Inventory; tools: PlayerTools } {
	if (!canCraft(recipe, inv, tools, start)) return { inv, tools };
	const next: Inventory = { ...inv };
	for (const ing of recipe.needs) {
		let left = ing.count;
		for (const name of ing.anyOf) {
			if (left === 0) break;
			const have = countOf(next, name, start);
			const take = Math.min(have, left);
			if (take === 0) continue;
			next[name] = have - take;
			left -= take;
		}
	}
	if (recipe.output.kind === 'block') {
		next[recipe.output.name] = countOf(next, recipe.output.name, start) + recipe.output.count;
		return { inv: next, tools };
	}
	const tier = recipe.output.tier;
	return { inv: next, tools: { owned: [...tools.owned, tier].sort((a, b) => a - b), equipped: tier } };
}
