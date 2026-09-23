import { AIR, BLOCK_BY_NAME, BLOCKS, type BlockDef, type BlockId } from '../data/blocks.data';
import { PICKAXES, type Inventory, type PlayerTools } from '../data/crafting.data';
import type { Recipe } from '../data/recipes.data';
import { pickaxeIconName } from '../data/atlas-derive';
import { countOf, isCraftedOnly, needsCount, needsCountName } from '../game/inventory';
import { canCraft, haveOf } from '../game/crafting';

export type InventoryTab = 'blocks' | 'craft';

/** What a picture shows: a block's north face, or a named atlas tile (pickaxe icons). */
export type Picture = { kind: 'block'; id: BlockId } | { kind: 'icon'; name: string };

export type IngredientView = {
	picture: Picture;
	label: string;
	/** Every accepted block's label, for the tooltip ("Iron Ore or Deepslate Iron Ore"). */
	title: string;
	have: number;
	need: number;
	/** 0..1, width of the fill bar. */
	fill: number;
	short: boolean;
};

export type CraftCardView = {
	recipeId: string;
	/** Stable selector for tests and the smoke run: 'pickaxe:4', 'block:big_tnt'. */
	outputKey: string;
	title: string;
	picture: Picture;
	/** "×2" when a recipe makes more than one; null otherwise. */
	countLabel: string | null;
	ingredients: IngredientView[];
	/** ready: button enabled; short: button disabled; owned: a check mark instead of the button, and no ingredient rows. */
	state: 'ready' | 'short' | 'owned';
};

export function badgeText(n: number): string {
	return n > 999 ? '999+' : String(n);
}

function outputPicture(recipe: Recipe): Picture {
	return recipe.output.kind === 'pickaxe'
		? { kind: 'icon', name: pickaxeIconName(recipe.output.tier) }
		: { kind: 'block', id: BLOCK_BY_NAME[recipe.output.name].id };
}

/** One card per recipe, in recipe order (7 pickaxes then 3 TNT). */
export function craftCards(recipes: readonly Recipe[], inv: Inventory, tools: PlayerTools): CraftCardView[] {
	return recipes.map((recipe) => {
		const ingredients = recipe.needs.map((n): IngredientView => {
			const have = haveOf(n, inv);
			const first = BLOCK_BY_NAME[n.anyOf[0]];
			return {
				picture: { kind: 'block', id: first.id },
				label: first.label,
				title: n.anyOf.map((name) => BLOCK_BY_NAME[name]?.label ?? name).join(' or '),
				have,
				need: n.count,
				fill: Math.min(1, have / n.count),
				short: have < n.count,
			};
		});
		const out = recipe.output;
		const owned = out.kind === 'pickaxe' && tools.owned.includes(out.tier);
		return {
			recipeId: recipe.id,
			outputKey: out.kind === 'pickaxe' ? `pickaxe:${out.tier}` : `block:${out.name}`,
			title: out.kind === 'pickaxe' ? PICKAXES[out.tier].label : BLOCK_BY_NAME[out.name].label,
			picture: outputPicture(recipe),
			countLabel: out.kind === 'block' && out.count > 1 ? `×${out.count}` : null,
			// An owned pickaxe shows only its check mark: red "0 / 8" bars under it read as "not done" (gate 2 playtest).
			ingredients: owned ? [] : ingredients,
			state: owned ? 'owned' : canCraft(recipe, inv, tools) ? 'ready' : 'short',
		};
	});
}

export type TileView = { visible: boolean; badge: string | null; dimmed: boolean };

/**
 * A Blocks-tab tile. Crafted-only blocks (Big/Mega TNT) are hidden at 0 in every world;
 * any block shows its count when > 0; in must-mine worlds a counted block at 0 is dimmed
 * but still assignable.
 */
export function blockTileView(def: BlockDef, inv: Inventory, mustMine: boolean): TileView {
	const n = countOf(inv, def.name);
	return {
		visible: !(isCraftedOnly(def.name) && n === 0),
		badge: n > 0 ? badgeText(n) : null,
		dimmed: n === 0 && needsCountName(def.name, mustMine),
	};
}

export type HotbarBadge = { text: string; grey: boolean };

/** A slot shows its count only when its block needs a count to place; greyed at 0. */
export function hotbarBadges(hotbar: BlockId[], inv: Inventory, mustMine: boolean): Array<HotbarBadge | null> {
	return hotbar.map((id) => {
		if (id === AIR || !BLOCKS[id] || !needsCount(id, mustMine)) return null;
		const n = countOf(inv, BLOCKS[id].name);
		return { text: badgeText(n), grey: n === 0 };
	});
}

export type PickaxeView = { tier: number; label: string; icon: string; equipped: boolean };

/** Owned pickaxes, ascending; the equipped one flagged. */
export function pickaxeRow(tools: PlayerTools): PickaxeView[] {
	return [...tools.owned].sort((a, b) => a - b).map((tier) => ({
		tier,
		label: PICKAXES[tier]?.label ?? `Tier ${tier}`,
		icon: pickaxeIconName(tier),
		equipped: tier === tools.equipped,
	}));
}

/** The HUD keycap for a key code: 'KeyP' → 'P', 'Digit3' → '3', unbound '' → '' (keycap hidden). */
export function keycapLabel(code: string): string {
	if (code === '') return '';
	const m = /^(?:Key|Digit|Numpad)(.+)$/.exec(code);
	return m ? m[1] : code;
}

const ORE_VARIANT = /^(deepslate|nether)_/;

/**
 * The blocks one Blocks-tab row shows, in display order. Every `*_ore` block is listed in the ORE row,
 * whatever its catalog group (deepslate and nether ores live in other groups because the group sets
 * their hardness), with each deepslate/nether variant right after its plain ore — a kid looking for
 * his diamonds finds all of them in one place. The raw metal blocks follow. BASICS keeps hand order;
 * other rows sort by label.
 */
export function inventoryRows(blocks: readonly BlockDef[], group: string): BlockDef[] {
	const live = blocks.filter((b) => b && b.id !== AIR && !b.retired);
	const isOre = (b: BlockDef) => b.name.endsWith('_ore');
	if (group === 'ore') {
		const key = (b: BlockDef) => b.name.replace(ORE_VARIANT, '');
		const rank = (b: BlockDef) => (b.name.startsWith('deepslate_') ? 1 : b.name.startsWith('nether_') ? 2 : 0);
		const ores = live.filter(isOre).sort((a, b) => key(a).localeCompare(key(b)) || rank(a) - rank(b));
		// The rest of the catalog's ore group (raw copper/gold/iron blocks) follows the ores, by label.
		const rest = live.filter((b) => b.group === 'ore' && !isOre(b)).sort((a, b) => a.label.localeCompare(b.label));
		return [...ores, ...rest];
	}
	const rows = live.filter((b) => b.group === group && !isOre(b));
	// BASICS keeps hand order (grass, dirt, stone…); generated groups sort by label so a
	// regeneration that appends ids does not land new blocks at the end.
	if (group !== 'basics') rows.sort((a, b) => a.label.localeCompare(b.label));
	return rows;
}
