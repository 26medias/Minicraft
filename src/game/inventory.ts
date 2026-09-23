import { AIR, BLOCKS, type BlockId } from '../data/blocks.data';
import { CRAFTED_ONLY, STARTING_COUNT, WORLDGEN_BLOCKS, type Inventory } from '../data/crafting.data';
import { RECIPES } from '../data/recipes.data';

/**
 * Per-block counts (spec §2, §3). Pure: every function returns a new Inventory and never mutates
 * its argument. `start` is the count of a key that was never touched (STARTING_COUNT); it is a
 * parameter so tests can inject a non-zero start.
 */

/** Spec §3 counted set: worldgen blocks, every recipe ingredient name, every recipe block output. */
const COUNTED: ReadonlySet<string> = new Set([
	...WORLDGEN_BLOCKS,
	...RECIPES.flatMap((r) => r.needs.flatMap((n) => n.anyOf)),
	...RECIPES.flatMap((r) => (r.output.kind === 'block' ? [r.output.name] : [])),
]);
const CRAFTED: ReadonlySet<string> = new Set(CRAFTED_ONLY);

const nameOf = (id: BlockId): string | undefined => BLOCKS[id]?.name;

export function countOf(inv: Inventory, name: string, start: number = STARTING_COUNT): number {
	return inv[name] ?? start;
}

export function isCounted(name: string): boolean {
	return COUNTED.has(name);
}

export function isCraftedOnly(name: string): boolean {
	return CRAFTED.has(name);
}

/** Name form of needsCount, for names that have no block id yet (big_tnt before Phase D) and for recipe checks. */
export function needsCountName(name: string, mustMine: boolean): boolean {
	return isCraftedOnly(name) || (mustMine && isCounted(name));
}

/** Spec §3: crafted-only anywhere, or a counted block in a must-mine world. */
export function needsCount(blockId: BlockId, mustMine: boolean): boolean {
	const name = nameOf(blockId);
	return name !== undefined && needsCountName(name, mustMine);
}

/** A plain place and a shift-replace are refused exactly when this is false (spec §2). */
export function canPlace(inv: Inventory, blockId: BlockId, mustMine: boolean, start: number = STARTING_COUNT): boolean {
	if (!needsCount(blockId, mustMine)) return true;
	return countOf(inv, nameOf(blockId)!, start) > 0;
}

/**
 * +1 per removed block (spec §2), whatever the block. `rose` lists each id (once, in first-seen
 * order) whose count went from 0 to more than 0 in this call: the auto-hotbar trigger.
 */
export function onRemoved(inv: Inventory, blockIds: BlockId[], start: number = STARTING_COUNT): { inv: Inventory; rose: BlockId[] } {
	const next: Inventory = { ...inv };
	const before = new Map<BlockId, number>();
	for (const id of blockIds) {
		const name = nameOf(id);
		if (name === undefined || id === AIR) continue;
		const c = countOf(next, name, start);
		if (!before.has(id)) before.set(id, c);
		next[name] = c + 1;
	}
	const rose: BlockId[] = [];
	for (const [id, c] of before) if (c === 0) rose.push(id);
	return { inv: next, rose };
}

/** −1, floor 0, only when placing needed a count. A free place returns the inventory unchanged (no key written). */
export function onPlaced(inv: Inventory, blockId: BlockId, mustMine: boolean, start: number = STARTING_COUNT): Inventory {
	if (!needsCount(blockId, mustMine)) return inv;
	const name = nameOf(blockId)!;
	return { ...inv, [name]: Math.max(0, countOf(inv, name, start) - 1) };
}

/** Shift-replace: the placed block as onPlaced, the replaced block +1 always. */
export function onReplaced(inv: Inventory, placedId: BlockId, oldId: BlockId, mustMine: boolean, start: number = STARTING_COUNT): Inventory {
	return onRemoved(onPlaced(inv, placedId, mustMine, start), [oldId], start).inv;
}
/**
 * Spec §3 auto-hotbar, must-mine worlds only. For each id in `rose` that is a counted block and is
 * not already on the bar, take the first slot other than `selected` that is (1) empty, else
 * (2) a counted block with no inventory key, else (3) a counted block at 0. Free blocks and slots
 * with a count are never replaced. Returns the new bar, or null when nothing moved.
 */
export function autoHotbar(
	hotbar: BlockId[],
	selected: number,
	inv: Inventory,
	rose: BlockId[],
	mustMine: boolean,
	start: number = STARTING_COUNT,
): BlockId[] | null {
	if (!mustMine) return null;
	const bar = [...hotbar];
	let changed = false;
	const countedId = (id: BlockId) => id !== AIR && nameOf(id) !== undefined && isCounted(nameOf(id)!);
	for (const id of rose) {
		if (!countedId(id) || bar.includes(id)) continue;
		const pick = (ok: (slotId: BlockId) => boolean) => bar.findIndex((s, i) => i !== selected && ok(s));
		let slot = pick((s) => s === AIR);
		if (slot < 0) slot = pick((s) => countedId(s) && inv[nameOf(s)!] === undefined);
		if (slot < 0) slot = pick((s) => countedId(s) && countOf(inv, nameOf(s)!, start) === 0);
		if (slot < 0) continue;
		bar[slot] = id;
		changed = true;
	}
	return changed ? bar : null;
}
