import type { BlockId } from '../../data/blocks.data';
import type { Op } from '../../net/protocol';
import { worldToChunk, indexOf } from './coords';
import type { World } from './world';
import type { ChunkOverlay } from './overlay';

export type ApplyRemoteResult = { applied: boolean; oldId: BlockId | null };

/**
 * The per-cell core of GameLoop.drainRemote (spec §6), shared with the bot SDK: skip out of bounds;
 * an unloaded chunk (never ensureChunk) reports `oldId: null`; an op whose id and fluid already match
 * the chunk is not applied (`oldId` is the current, unchanged id); otherwise `World.writeRemote` does
 * the write and `applied` is exactly its return value.
 */
export function applyRemoteOp(world: World, op: Op): ApplyRemoteResult {
	const [x, y, z, id, fluid] = op;
	if (!world.inBounds(x, y, z)) return { applied: false, oldId: null };
	const { cx, cz, lx, lz } = worldToChunk(x, z);
	const c = world.getChunk(cx, cz);
	if (!c) return { applied: false, oldId: null };
	const i = indexOf(lx, y, lz);
	const oldId = c.blocks[i] as BlockId;
	const oldFluid = c.fluidMeta.get(i) ?? 0;
	if (oldId === id && oldFluid === fluid) return { applied: false, oldId };
	return { applied: world.writeRemote(x, y, z, id, fluid), oldId };
}

/**
 * The bot SDK's remote-edit path (spec §6 / Task 4): for each op, update the overlay first (every op,
 * loaded chunk or not, out of bounds or not — idempotent, same as GameLoop.enqueueRemote), then
 * applyRemoteOp, synchronously. `onApplied`, if given, is called once per op with its result; callers
 * decide what to do with a `false` or a null `oldId`.
 */
export function applyRemoteOps(
	world: World,
	overlay: ChunkOverlay,
	ops: readonly Op[],
	onApplied?: (op: Op, result: ApplyRemoteResult) => void,
): void {
	for (const op of ops) {
		const [x, y, z, id, fluid, color] = op;
		overlay.set(x, y, z, id, fluid, color);
		const r = applyRemoteOp(world, op);
		onApplied?.(op, r);
	}
}
