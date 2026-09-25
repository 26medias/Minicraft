/**
 * Mining cracks: Minecraft's destroy_stage_0..9 drawn over the block being mined, for the local
 * player and (in multiplayer) for every friend. Pure logic here; the mesh is CrackOverlay.
 */
import type { Face } from '../data/blocks.data';
import type { PickaxeTier } from '../data/crafting.data';
import { areaCells, isFace, isMultiBlock, removableCellsBy, type Cell } from './tools';

export const CRACK_STAGES = 10;
/** A remote mine with no stop and no block change is dropped this long after it should have finished. */
export const MINE_TIMEOUT_GRACE_MS = 1000;

/** Crack stage 0..9 for `elapsedMs` into a mine that takes `durMs`. */
export function crackStage(elapsedMs: number, durMs: number): number {
	if (durMs <= 0) return CRACK_STAGES - 1;
	const s = Math.floor((elapsedMs / durMs) * CRACK_STAGES);
	return Math.min(CRACK_STAGES - 1, Math.max(0, s));
}

/**
 * `tool`/`face` come straight off the wire (`fx mine`'s optional fields) and are validated again
 * here, never trusted from a peer: an old sender omits them, and a value the server didn't already
 * strip could still be garbage.
 */
type Mine = { x: number; y: number; z: number; dur: number; blockId: number; startedAt: number; tool?: number; face?: Face };

export type ActiveMine = { by: number; x: number; y: number; z: number; stage: number; blockId: number; cells: Cell[] };

/**
 * Who is mining what, from `fx mine` / `fx mine-stop`. One mine per player. A mine ends on stop, on a
 * new start, when the block it targets changes (the break landed, or anyone replaced it), or at
 * duration + grace (the miner froze or dropped without a stop).
 */
export class RemoteMining {
	private mines = new Map<number, Mine>();

	start(by: number, x: number, y: number, z: number, dur: number, blockId: number, now: number, tool?: number, face?: Face): void {
		this.mines.set(by, { x, y, z, dur: Math.max(0, dur), blockId, startedAt: now, tool, face });
	}

	stop(by: number): void {
		this.mines.delete(by);
	}

	/** A player left: forget their mine. */
	forget(by: number): void {
		this.mines.delete(by);
	}

	/** The live mines with their stage; drops the finished ones as a side effect. */
	active(now: number, getBlock: (x: number, y: number, z: number) => number): ActiveMine[] {
		const out: ActiveMine[] = [];
		for (const [by, m] of this.mines) {
			if (now - m.startedAt >= m.dur + MINE_TIMEOUT_GRACE_MS || getBlock(m.x, m.y, m.z) !== m.blockId) {
				this.mines.delete(by);
				continue;
			}
			const target: Cell = { x: m.x, y: m.y, z: m.z };
			// A known multi-block tier and a valid face: the same removable-area rule the local highlight and
			// mining use, read through the receiver's own world (getBlock: -1 for an unloaded chunk, skipped
			// by removableCellsBy same as air). Anything else (no tool, an unknown tier, a bad face) is just
			// the target — today's single crack, so an old sender or a stripped field never breaks.
			const cells = m.tool !== undefined && isMultiBlock(m.tool as PickaxeTier) && isFace(m.face)
				? removableCellsBy(getBlock, areaCells(target, m.face, m.tool as PickaxeTier))
				: [target];
			out.push({ by, x: m.x, y: m.y, z: m.z, stage: crackStage(now - m.startedAt, m.dur), blockId: m.blockId, cells });
		}
		return out;
	}
}
