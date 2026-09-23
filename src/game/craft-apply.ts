import { AIR, BLOCKS, BLOCK_BY_NAME, type BlockId } from '../data/blocks.data';
import type { Inventory, PlayerTools } from '../data/crafting.data';
import type { Recipe } from '../data/recipes.data';
import { canCraft, craft } from './crafting';
import { countOf, needsCount } from './inventory';

/**
 * Where a crafted block goes (spec §9): the slot already holding it, else the first empty slot, else the
 * first other slot whose block needs a count and is at 0 (a greyed slot), else the selected slot. In a
 * must-mine world the bar starts full of greyed blocks, so without the third step every craft would
 * replace the block in his hand (gate-2 playtest; parent's decision).
 */
export function craftedBlockSlot(hotbar: BlockId[], selected: number, id: BlockId, inv: Inventory, mustMine: boolean): number {
	const holding = hotbar.indexOf(id);
	if (holding >= 0) return holding;
	const empty = hotbar.indexOf(AIR);
	if (empty >= 0) return empty;
	const greyed = hotbar.findIndex((b, i) => i !== selected && needsCount(b, mustMine) && countOf(inv, BLOCKS[b].name) === 0);
	return greyed >= 0 ? greyed : selected;
}

export type CraftOutcome =
	| { ok: false }
	| { ok: true; kind: 'pickaxe'; tier: number }
	| { ok: true; kind: 'block'; slot: number };

/**
 * The Craft button (spec §9), headless. Re-checks canCraft, then takes the ingredients and adds
 * the output. A pickaxe is owned and equipped (spec §5). A block goes to the hotbar by the §9 rule
 * through craftedBlockSlot, never through the must-mine auto-hotbar (spec §3: crafting does not
 * trigger it). Mutates `player`; calls `markDirty` once on success, never on a refusal.
 */
export function applyCraft(
	player: { inventory: Inventory; tools: PlayerTools; hotbar: BlockId[]; selected: number },
	recipe: Recipe,
	mustMine: boolean,
	markDirty: () => void,
): CraftOutcome {
	if (!canCraft(recipe, player.inventory, player.tools)) return { ok: false };
	const out = craft(recipe, player.inventory, player.tools);
	player.inventory = out.inv;
	let result: CraftOutcome;
	if (recipe.output.kind === 'pickaxe') {
		player.tools = { owned: out.tools.owned, equipped: recipe.output.tier };
		result = { ok: true, kind: 'pickaxe', tier: recipe.output.tier };
	} else {
		player.tools = out.tools;
		const id = BLOCK_BY_NAME[recipe.output.name].id;
		const slot = craftedBlockSlot(player.hotbar, player.selected, id, player.inventory, mustMine);
		player.hotbar = player.hotbar.map((b, i) => (i === slot ? id : b));
		result = { ok: true, kind: 'block', slot };
	}
	markDirty();
	return result;
}
