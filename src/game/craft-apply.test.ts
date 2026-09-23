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
		expect(craftedBlockSlot(bar, 6, id('tnt'), {}, false)).toBe(3);
	});
	it('else the first empty slot, never the selected one while an empty slot exists', () => {
		// Catches overwriting the selected slot (his building block) when there is room.
		expect(craftedBlockSlot(bar, 6, id('big_tnt'), {}, false)).toBe(2);
	});
	it('else the selected slot', () => {
		// Catches "no room → do nothing" (the crafted TNT would be unreachable) and slot 0.
		const full = bar.map((b) => (b === AIR ? id('glass') : b));
		expect(craftedBlockSlot(full, 5, id('big_tnt'), { stone: 3, dirt: 3, tnt: 1, sand: 3, oak_log: 3 }, true)).toBe(5); // every counted slot has a count
	});

	it('else a greyed slot (needs a count, at 0) before the selected slot, never the selected one', () => {
		// Catches the spec-rev-5 rule (straight to the selected slot): in a must-mine world the bar starts
		// full of greyed blocks, so every craft would replace the block in his hand. Also catches taking a
		// slot whose block still has a count, and taking a free (uncounted) block's slot.
		const full = bar.map((b) => (b === AIR ? id('glass') : b)); // glass and cobblestone are free
		const inv = { stone: 4, dirt: 0, tnt: 1, sand: 0, oak_log: 2 }; // counted at 0: dirt (slot 1) and sand (slot 5)
		expect(craftedBlockSlot(full, 5, id('big_tnt'), inv, true)).toBe(1); // dirt at 0; sand (slot 5) is selected
		expect(craftedBlockSlot(full, 1, id('big_tnt'), inv, true)).toBe(5); // dirt selected → the next greyed, sand
		expect(craftedBlockSlot(full, 5, id('big_tnt'), inv, false)).toBe(5); // unlimited: nothing is greyed
	});
});

describe('applyCraft — the Craft button (spec §3, §9, §11)', () => {
	it('crafting does not go through the auto-hotbar: in an unlimited world crafted TNT still lands on the bar', () => {
		// Catches a handler that feeds the output through applyRemoved/autoHotbar (count 0 → 2 "rose"):
		// auto-hotbar is a no-op in unlimited worlds, so the TNT would never reach the bar.
		const bar = [id('cobblestone'), id('oak_planks'), id('glass'), id('stone'), id('white_wool'), id('red_wool'), id('blue_wool'), id('lamp'), id('green_wool')];
		const p = player({ hotbar: bar, selected: 5, inventory: { ...enough(tntRecipe), stone: 0 } });
		const out = applyCraft(p, tntRecipe, false, () => {});
		expect(out).toEqual({ ok: true, kind: 'block', slot: 5 });
		expect(p.hotbar[3]).toBe(id('stone'));
		expect(p.hotbar[5]).toBe(id('tnt'));
		expect(p.inventory.tnt).toBe(2);
	});

	it('crafting a pickaxe never touches the hotbar', () => {
		// Catches a handler that runs the block-slot rule for every recipe.
		const bar = [id('stone'), AIR, AIR, AIR, AIR, AIR, AIR, AIR, AIR];
		const p = player({ hotbar: [...bar], inventory: enough(woodRecipe) });
		expect(applyCraft(p, woodRecipe, true, () => {})).toEqual({ ok: true, kind: 'pickaxe', tier: 1 });
		expect(p.hotbar).toEqual(bar);
	});

	it('crafting then snapshot: the snapshot contains the tool, equipped, and the save was marked dirty', () => {
		// Catches a handler that computes craft() but never assigns tools/inventory back to the player
		// (the snapshot would miss the pickaxe) and one that forgets markDirty (nothing would upload).
		const p = player({ inventory: enough(woodRecipe) });
		const dirty = vi.fn();
		applyCraft(p, woodRecipe, true, dirty);
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
		expect(applyCraft(p, woodRecipe, true, dirty)).toEqual({ ok: false });
		expect(p.inventory).toEqual(inv);
		expect(p.tools).toEqual({ owned: [0], equipped: 0 });
		expect(dirty).not.toHaveBeenCalled();
	});
});
