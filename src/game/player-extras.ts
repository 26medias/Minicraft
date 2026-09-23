import { BLOCK_BY_NAME } from '../data/blocks.data';
import { DEFAULT_TOOLS, MAX_PICKAXE_TIER, type Inventory, type PlayerTools } from '../data/crafting.data';
import type { PlayerSave } from '../persistence/adapter';

export type PlayerExtras = { inventory: Inventory; tools: PlayerTools; mustMine: boolean };

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isTier(v: unknown): v is number {
	return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_PICKAXE_TIER;
}

/**
 * Turns whatever a save holds into usable counts, tools and mode (spec §10). The
 * companion of resolveHotbar: a save from before crafting, or one carrying junk,
 * loads with defaults instead of failing.
 *
 * - A count survives only under a live block name, as an integer >= 0. Zero is
 *   kept: a key touched down to 0 must not come back at a later start value.
 * - Tiers outside 0..MAX_PICKAXE_TIER are dropped; 0 is always owned.
 * - An equipped tier that is not owned becomes the highest owned one.
 * - mustMine is true only for a literal `true`.
 */
export function resolvePlayerExtras(
	player: PlayerSave | undefined,
	mustMine: boolean | undefined,
): PlayerExtras {
	const inventory: Inventory = {};
	const rawInv: unknown = player?.inventory;
	if (isPlainObject(rawInv)) {
		for (const [name, count] of Object.entries(rawInv)) {
			// hasOwn, not a plain lookup: BLOCK_BY_NAME['constructor'] is Object's constructor.
			if (!Object.hasOwn(BLOCK_BY_NAME, name)) continue;
			if (!Number.isInteger(count) || (count as number) < 0) continue;
			inventory[name] = count as number;
		}
	}

	const rawTools: unknown = player?.tools;
	const owned = new Set<number>(DEFAULT_TOOLS.owned);
	let equipped: unknown = DEFAULT_TOOLS.equipped;
	if (isPlainObject(rawTools)) {
		if (Array.isArray(rawTools.owned)) {
			for (const t of rawTools.owned) if (isTier(t)) owned.add(t);
		}
		equipped = rawTools.equipped;
	}
	const ownedList = [...owned].sort((a, b) => a - b);
	const tools: PlayerTools = {
		owned: ownedList,
		equipped: isTier(equipped) && owned.has(equipped) ? equipped : ownedList[ownedList.length - 1],
	};

	return { inventory, tools, mustMine: mustMine === true };
}
