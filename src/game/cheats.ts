import { CHEATS, type Cheat } from '../data/cheats.data';
import type { Inventory, PlayerTools } from '../data/crafting.data';
import { countOf } from './inventory';

/**
 * Cheat codes (spec §4, §7). Pure. Matching folds Unicode (NFKD, combining marks dropped),
 * lower-cases, then keeps only a–z and 0–9: case, punctuation and every space are ignored.
 */
export function normalizeCode(s: string): string {
	return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** A row's normalised code and aliases. */
export function cheatKeys(c: Cheat): string[] {
	return [c.code, ...c.also].map(normalizeCode);
}

/** The cheat whose normalised code or alias equals the normalised text, or null. Blank → null. */
export function matchCheat(text: string, cheats: readonly Cheat[] = CHEATS): Cheat | null {
	const k = normalizeCode(text);
	if (k === '') return null;
	return cheats.find((c) => cheatKeys(c).includes(k)) ?? null;
}

/**
 * Spec §7. Adds every block grant to its count (no cap) and owns every pickaxe grant, equipping
 * it only when its tier is above the equipped tier. Replaces `player.inventory` and `player.tools`
 * with new objects (a save in flight holds the old ones), never touches the hotbar, and makes the
 * grant path's only markDirty call. `pickaxeChanged`: the equipped tier changed.
 */
export function applyCheat(
	player: { inventory: Inventory; tools: PlayerTools },
	cheat: Cheat,
	markDirty: () => void,
): { pickaxeChanged: boolean } {
	const inv: Inventory = { ...player.inventory };
	let owned = [...player.tools.owned];
	let equipped = player.tools.equipped;
	for (const g of cheat.grants) {
		if (g.kind === 'block') {
			inv[g.name] = countOf(inv, g.name) + g.count;
		} else {
			if (!owned.includes(g.tier)) owned = [...owned, g.tier].sort((a, b) => a - b);
			if (g.tier > equipped) equipped = g.tier;
		}
	}
	const pickaxeChanged = equipped !== player.tools.equipped;
	player.inventory = inv;
	player.tools = { owned, equipped };
	markDirty();
	return { pickaxeChanged };
}
