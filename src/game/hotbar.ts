import { AIR, DEFAULT_HOTBAR, HOTBAR_SIZE, type BlockDef, type BlockId } from '../data/blocks.data';

/**
 * Turns whatever a save holds into a 9-slot hotbar. Saves written before the
 * inventory hold the whole block pool (19 entries); those get the default bar.
 */
export function resolveHotbar(
	saved: BlockId[] | undefined,
	savedSelected: number,
	blocks: BlockDef[],
): { hotbar: BlockId[]; selected: number } {
	const live = (id: BlockId) => id !== AIR && !!blocks[id] && !blocks[id].retired;
	if (!saved || saved.length !== HOTBAR_SIZE) {
		const hotbar = [...DEFAULT_HOTBAR];
		const prev = saved?.[savedSelected];
		const idx = prev === undefined ? -1 : hotbar.indexOf(prev);
		return { hotbar, selected: idx >= 0 ? idx : 0 };
	}
	const hotbar = saved.map((id) => (live(id) ? id : AIR));
	const selected =
		Number.isInteger(savedSelected) && savedSelected >= 0 && savedSelected < HOTBAR_SIZE
			? savedSelected
			: 0;
	return { hotbar, selected };
}
