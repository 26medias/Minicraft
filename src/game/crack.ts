/**
 * Mining cracks: Minecraft's destroy_stage_0..9 drawn over the block being mined, for the local
 * player and (in multiplayer) for every friend. Pure logic here; the mesh is CrackOverlay.
 */

export const CRACK_STAGES = 10;
/** A remote mine with no stop and no block change is dropped this long after it should have finished. */
export const MINE_TIMEOUT_GRACE_MS = 1000;

/** Crack stage 0..9 for `elapsedMs` into a mine that takes `durMs`. */
export function crackStage(elapsedMs: number, durMs: number): number {
	if (durMs <= 0) return CRACK_STAGES - 1;
	const s = Math.floor((elapsedMs / durMs) * CRACK_STAGES);
	return Math.min(CRACK_STAGES - 1, Math.max(0, s));
}

type Mine = { x: number; y: number; z: number; dur: number; blockId: number; startedAt: number };

export type ActiveMine = { by: number; x: number; y: number; z: number; stage: number; blockId: number };

/**
 * Who is mining what, from `fx mine` / `fx mine-stop`. One mine per player. A mine ends on stop, on a
 * new start, when the block it targets changes (the break landed, or anyone replaced it), or at
 * duration + grace (the miner froze or dropped without a stop).
 */
export class RemoteMining {
	private mines = new Map<number, Mine>();

	start(by: number, x: number, y: number, z: number, dur: number, blockId: number, now: number): void {
		this.mines.set(by, { x, y, z, dur: Math.max(0, dur), blockId, startedAt: now });
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
			out.push({ by, x: m.x, y: m.y, z: m.z, stage: crackStage(now - m.startedAt, m.dur), blockId: m.blockId });
		}
		return out;
	}
}
