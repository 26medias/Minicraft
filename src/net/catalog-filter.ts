import { AIR, DEFAULT_HOTBAR, type BlockDef, type BlockId } from '../data/blocks.data';

/**
 * Spec §5 `catalogMax`: the server rejects ops with ids above its catalog, so for
 * this session those blocks are hidden. The rows keep their index (BLOCKS[id]
 * stays aligned) and are marked retired, which the Blocks tab and
 * resolveHotbar already skip.
 */
export function catalogBlocks(blocks: BlockDef[], catalogMax: number): BlockDef[] {
	if (blocks.length - 1 <= catalogMax) return blocks;
	return blocks.map((b, i) => (b && i > catalogMax ? { ...b, retired: true } : b));
}

/** A hotbar id above the maximum becomes that slot's default (or empty when the default is above it too). */
export function catalogHotbar(saved: BlockId[] | undefined, catalogMax: number): BlockId[] | undefined {
	if (!saved) return saved;
	return saved.map((id, i) => {
		if (id <= catalogMax) return id;
		const d = DEFAULT_HOTBAR[i];
		return d !== undefined && d <= catalogMax ? d : AIR;
	});
}
