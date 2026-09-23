import { AIR, type BlockId } from '../data/blocks.data';
import { STARTING_COUNT } from '../data/crafting.data';
import type { World } from '../engine/world/world';
import type { VoxelHit } from '../engine/input/raycast';
import type { GameLoop } from './loop';
import type { Player } from './player';
import { autoHotbar, canPlace, onPlaced, onRemoved, onReplaced } from './inventory';

export type PlaceResult = { ok: boolean; reason?: 'no-count' | 'blocked' };

/**
 * Right click (spec §2), extracted from main.ts: the selected hotbar block → count refusal → world
 * write → count update. `shift` replaces the aimed block instead of building on its face, and is
 * refused exactly when a plain place would be. Mutates `player.inventory` only on success.
 * 'blocked': empty slot, occupied target, player in the way, or an unreplaceable block.
 */
export function tryPlace(args: { loop: GameLoop; world: World; player: Player; hit: VoxelHit; shift: boolean; mustMine: boolean; lampColor: string }): PlaceResult {
	const { loop, world, player, hit, shift, mustMine, lampColor } = args;
	const id = player.hotbar[player.selected];
	if (id === undefined || id === AIR) return { ok: false, reason: 'blocked' };
	if (!canPlace(player.inventory, id, mustMine)) return { ok: false, reason: 'no-count' };
	if (shift) {
		const oldId = world.getBlock(hit.x, hit.y, hit.z);
		if (!loop.replaceBlock(hit, id, lampColor)) return { ok: false, reason: 'blocked' };
		player.inventory = onReplaced(player.inventory, id, oldId, mustMine);
		return { ok: true };
	}
	if (!loop.placeBlock(hit, id, lampColor)) return { ok: false, reason: 'blocked' };
	player.inventory = onPlaced(player.inventory, id, mustMine);
	return { ok: true };
}

/**
 * Blocks the player's actions removed (single mine, area mine, TNT): +1 each, then the must-mine
 * auto-hotbar. Mutates `player.inventory` and, when a slot changes, `player.hotbar`. Returns true
 * when the hotbar changed (the caller refreshes the HUD). The caller marks the save dirty.
 */
export function applyRemoved(
	player: { inventory: Player['inventory']; hotbar: BlockId[]; selected: number },
	blockIds: BlockId[],
	mustMine: boolean,
	start: number = STARTING_COUNT,
): boolean {
	const { inv, rose } = onRemoved(player.inventory, blockIds, start);
	player.inventory = inv;
	const bar = autoHotbar(player.hotbar, player.selected, inv, rose, mustMine, start);
	if (!bar) return false;
	player.hotbar = bar;
	return true;
}
