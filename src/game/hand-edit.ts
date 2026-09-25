import { BLOCKS, AIR } from '../data/blocks.data';
import type { Op } from '../net/protocol';

/** Largest edit still treated as one hand action (a 3×3 area break); bigger ones are explosions. */
export const HAND_EDIT_MAX_OPS = 9;

const solid = (id: number) => id !== AIR && id >= 0 && (BLOCKS[id]?.liquid ?? 'none') === 'none';

/**
 * Whether a friend's `edit` is a hand action (spec §7): it places a non-liquid block, or turns a
 * non-liquid block into air. Liquid flow and drains write liquids or air over liquid/air, so they
 * never swing an arm. Call BEFORE the edit is applied: `blockAt` must still see the old blocks.
 * The liquid scheduler also writes a few solids itself (wet sponge, obsidian from lava meeting
 * water); those rare edits swing the simulating friend's arm once — accepted.
 */
export function isHandEdit(ops: readonly Op[], blockAt: (x: number, y: number, z: number) => number): boolean {
	if (ops.length === 0 || ops.length > HAND_EDIT_MAX_OPS) return false;
	return ops.some(([x, y, z, id]) => solid(id) || (id === AIR && solid(blockAt(x, y, z))));
}
