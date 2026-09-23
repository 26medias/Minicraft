import { AIR, BLOCK_BY_NAME, type BlockId } from '../data/blocks.data';
import type { Inventory, PlayerTools } from '../data/crafting.data';
import type { Recipe } from '../data/recipes.data';
import { canCraft, craft } from './crafting';

/** Where a crafted block goes (spec §9): the slot already holding it, else the first empty slot, else the selected slot. */
export function craftedBlockSlot(hotbar: BlockId[], selected: number, id: BlockId): number {
	const holding = hotbar.indexOf(id);
	if (holding >= 0) return holding;
	const empty = hotbar.indexOf(AIR);
	return empty >= 0 ? empty : selected;
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
		const slot = craftedBlockSlot(player.hotbar, player.selected, id);
		player.hotbar = player.hotbar.map((b, i) => (i === slot ? id : b));
		result = { ok: true, kind: 'block', slot };
	}
	markDirty();
	return result;
}
