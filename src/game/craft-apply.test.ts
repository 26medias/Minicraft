import { describe, it, expect, vi } from 'vitest';
import { AIR, BLOCK_BY_NAME, type BlockId } from '../data/blocks.data';
import type { Inventory, PlayerTools } from '../data/crafting.data';
import { RECIPES, type Recipe } from '../data/recipes.data';
import { applyCraft, craftedBlockSlot } from './craft-apply';
import { playerSave } from './player-extras';

const id = (name: string) => BLOCK_BY_NAME[name].id;
const recipeOf = (pred: (r: Recipe) => boolean) => RECIPES.find(pred)!;
const tntRecipe = recipeOf((r) => r.output.kind === 'block' && r.output.name === 'tnt');
const woodRecipe = recipeOf((r) => r.output.kind === 'pickaxe' && r.output.tier === 1);
/** Exactly enough of every ingredient, all on the first anyOf name. */
function enough(r: Recipe): Inventory {
	const inv: Inventory = {};
	for (const n of r.needs) inv[n.anyOf[0]] = (inv[n.anyOf[0]] ?? 0) + n.count;
	return inv;
}
type P = { inventory: Inventory; tools: PlayerTools; hotbar: BlockId[]; selected: number; position: [number, number, number] };
function player(over: Partial<P>): P {
	return { inventory: {}, tools: { owned: [0], equipped: 0 }, hotbar: Array(9).fill(AIR), selected: 0, position: [0, 0, 0], ...over };
}

describe('craftedBlockSlot (spec §9)', () => {
	const bar = [id('stone'), id('dirt'), AIR, id('tnt'), AIR, id('sand'), id('glass'), id('oak_log'), id('cobblestone')];
	it('goes to the slot already holding the block', () => {
		// Catches always using the first empty slot (he would get two TNT slots).
		expect(craftedBlockSlot(bar, 6, id('tnt'))).toBe(3);
	});
	it('else the first empty slot, never the selected one while an empty slot exists', () => {
		// Catches overwriting the selected slot (his building block) when there is room.
		expect(craftedBlockSlot(bar, 6, id('big_tnt'))).toBe(2);
	});
	it('else the selected slot', () => {
		// Catches "no room → do nothing" (the crafted TNT would be unreachable) and slot 0.
		const full = bar.map((b) => (b === AIR ? id('glass') : b));
		expect(craftedBlockSlot(full, 5, id('big_tnt'))).toBe(5);
	});
});

describe('applyCraft — the Craft button (spec §3, §9, §11)', () => {
	it('crafting does not trigger the must-mine auto-hotbar: TNT takes the §9 slot, not a counted-at-0 slot', () => {
		// Catches a handler that feeds the output through applyRemoved/autoHotbar (count 0 → 2 "rose"):
		// auto-hotbar would take slot 3 (a counted block at 0) and never the selected slot 5.
		const bar = [id('cobblestone'), id('oak_planks'), id('glass'), id('stone'), id('white_wool'), id('red_wool'), id('blue_wool'), id('lamp'), id('green_wool')];
		const p = player({ hotbar: bar, selected: 5, inventory: { ...enough(tntRecipe), stone: 0 } });
		const out = applyCraft(p, tntRecipe, () => {});
		expect(out).toEqual({ ok: true, kind: 'block', slot: 5 });
		expect(p.hotbar[3]).toBe(id('stone'));
		expect(p.hotbar[5]).toBe(id('tnt'));
		expect(p.inventory.tnt).toBe(2);
	});

	it('crafting a pickaxe never touches the hotbar', () => {
		// Catches a handler that runs the block-slot rule for every recipe.
		const bar = [id('stone'), AIR, AIR, AIR, AIR, AIR, AIR, AIR, AIR];
		const p = player({ hotbar: [...bar], inventory: enough(woodRecipe) });
		expect(applyCraft(p, woodRecipe, () => {})).toEqual({ ok: true, kind: 'pickaxe', tier: 1 });
		expect(p.hotbar).toEqual(bar);
	});

	it('crafting then snapshot: the snapshot contains the tool, equipped, and the save was marked dirty', () => {
		// Catches a handler that computes craft() but never assigns tools/inventory back to the player
		// (the snapshot would miss the pickaxe) and one that forgets markDirty (nothing would upload).
		const p = player({ inventory: enough(woodRecipe) });
		const dirty = vi.fn();
		applyCraft(p, woodRecipe, dirty);
		expect(dirty).toHaveBeenCalledTimes(1);
		const snap = playerSave(p, 0, 0);
		expect(snap.tools).toEqual({ owned: [0, 1], equipped: 1 });
		for (const n of woodRecipe.needs) expect(snap.inventory![n.anyOf[0]]).toBe(0);
	});

	it('a refused craft changes nothing and does not mark dirty', () => {
		// Catches a handler that trusts the (possibly stale) button state and spends ingredients anyway.
		const inv = enough(woodRecipe);
		inv[woodRecipe.needs[0].anyOf[0]] -= 1;
		const p = player({ inventory: { ...inv } });
		const dirty = vi.fn();
		expect(applyCraft(p, woodRecipe, dirty)).toEqual({ ok: false });
		expect(p.inventory).toEqual(inv);
		expect(p.tools).toEqual({ owned: [0], equipped: 0 });
		expect(dirty).not.toHaveBeenCalled();
	});
});
