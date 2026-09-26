/**
 * The landscaper's inventory and crafting, by the game's own recipes (the SDK's RECIPES, the Craft tab's rows): an
 * ingredient's count is summed across its `anyOf` names and taken in listed order (plain before deepslate), exactly as
 * the Craft tab takes it. Pure: an inventory is a plain name → count record.
 */
import { RECIPES, type Recipe } from 'minicraft-bot';

export type Inventory = Record<string, number>;

export function recipeFor(block: string): Recipe | null {
	return RECIPES.find((r) => r.output.kind === 'block' && r.output.name === block) ?? null;
}

const have = (inv: Inventory, names: readonly string[]) => names.reduce((s, n) => s + (inv[n] ?? 0), 0);

/** Whether `inv` holds every ingredient of `r`. */
export function canCraft(r: Recipe, inv: Inventory): boolean {
	return r.needs.every((n) => have(inv, n.anyOf) >= n.count);
}

/** Crafts `r` once: deducts each ingredient (in listed order across anyOf) and adds the output. False (untouched) when short. */
export function craftOnce(r: Recipe, inv: Inventory): boolean {
	if (!canCraft(r, inv) || r.output.kind !== 'block') return false;
	for (const n of r.needs) {
		let left = n.count;
		for (const name of n.anyOf) {
			const take = Math.min(left, inv[name] ?? 0);
			if (take > 0) inv[name] = (inv[name] ?? 0) - take;
			if (inv[name] === 0) delete inv[name];
			left -= take;
			if (left === 0) break;
		}
	}
	inv[r.output.name] = (inv[r.output.name] ?? 0) + r.output.count;
	return true;
}

/**
 * Crafts until `inv` holds `count` of `block`, crafting its intermediate ingredients first (tnt → big_tnt →
 * flatten_tnt). Returns the recipe ids crafted, in order, or null — with `inv` untouched — when the raw ingredients
 * are short (see `rawShortfall`).
 */
export function craftUpTo(block: string, count: number, inv: Inventory): string[] | null {
	const work: Inventory = { ...inv };
	const done: string[] = [];
	const make = (name: string, want: number, depth: number): boolean => {
		if (depth > 8) return false;
		while ((work[name] ?? 0) < want) {
			const r = recipeFor(name);
			if (!r) return false;
			for (const n of r.needs) {
				// An intermediate (crafted) ingredient: make enough of the first name.
				if (have(work, n.anyOf) < n.count && recipeFor(n.anyOf[0]) && !make(n.anyOf[0], n.count - have(work, n.anyOf.slice(1)), depth + 1)) return false;
			}
			if (!craftOnce(r, work)) return false;
			done.push(r.id);
		}
		return true;
	};
	if (!make(block, count, 0)) return null;
	for (const k of Object.keys(inv)) delete inv[k];
	Object.assign(inv, work);
	return done;
}

/**
 * What raw (mined) ingredients are still missing to hold `count` of `block`, given `inv`: a list of {anyOf, count},
 * one per raw ingredient (merged by its first name). Empty when `craftUpTo` would succeed.
 */
export function rawShortfall(block: string, count: number, inv: Inventory): Array<{ anyOf: string[]; count: number }> {
	const work: Inventory = { ...inv };
	const short = new Map<string, { anyOf: string[]; count: number }>();
	const need = (name: string, want: number, depth: number): void => {
		const r = recipeFor(name);
		if (!r || depth > 8) return;
		while ((work[name] ?? 0) < want) {
			for (const n of r.needs) {
				const inner = recipeFor(n.anyOf[0]);
				if (inner) {
					need(n.anyOf[0], n.count, depth + 1);
					continue;
				}
				const got = have(work, n.anyOf);
				if (got < n.count) {
					const s = short.get(n.anyOf[0]) ?? { anyOf: [...n.anyOf], count: 0 };
					s.count += n.count - got;
					short.set(n.anyOf[0], s);
					// Pretend it was mined, so the rest of the tree is counted once.
					work[n.anyOf[0]] = (work[n.anyOf[0]] ?? 0) + (n.count - got);
				}
			}
			if (!craftOnce(r, work)) return;
		}
	};
	need(block, count, 0);
	return [...short.values()];
}
