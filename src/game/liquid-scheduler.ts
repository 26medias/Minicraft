import type { World } from '../engine/world/world';
import type { Chunk } from '../engine/world/chunk';
import { AIR, isLiquid } from '../data/blocks.data';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z } from '../engine/world/coords';

const TICK_INTERVAL = 0.5;

type PendingWrite = { x: number; y: number; z: number; id: number };

export class LiquidScheduler {
	private accumulator = 0;

	constructor(
		private world: World,
		private onChunkDirty: (cx: number, cz: number) => void,
	) {}

	tick(dt: number): void {
		this.accumulator += dt;
		if (this.accumulator < TICK_INTERVAL) return;
		this.accumulator = 0; // no catch-up; discard overflow
		this.applyFlowStep();
	}

	private applyFlowStep(): void {
		const chunks = this.loadedChunks();
		const snapshot: { x: number; y: number; z: number }[] = [];
		for (const c of chunks) {
			const baseX = c.cx * CHUNK_SIZE_X;
			const baseZ = c.cz * CHUNK_SIZE_Z;
			for (const idx of c.liquidFrontier) {
				const y = Math.floor(idx / (CHUNK_SIZE_X * CHUNK_SIZE_Z));
				const rem = idx - y * CHUNK_SIZE_X * CHUNK_SIZE_Z;
				const lz = Math.floor(rem / CHUNK_SIZE_X);
				const lx = rem - lz * CHUNK_SIZE_X;
				snapshot.push({ x: baseX + lx, y, z: baseZ + lz });
			}
		}

		const pending: PendingWrite[] = [];
		for (const { x, y, z } of snapshot) {
			const here = this.world.getBlock(x, y, z);
			if (!isLiquid(here)) continue;
			// Fall rule only for this task.
			if (y > 0) {
				const below = this.world.getBlock(x, y - 1, z);
				if (below === AIR) {
					// Only fall if there is no liquid directly above feeding this cell.
					const above = this.world.getBlock(x, y + 1, z);
					if (!isLiquid(above)) {
						pending.push({ x, y, z, id: AIR });
						pending.push({ x, y: y - 1, z, id: here });
						continue;
					}
				}
			}
		}

		this.commit(pending);
	}

	private commit(pending: PendingWrite[]): void {
		// Dedup: liquid beats air on the same coord.
		const map = new Map<string, number>();
		for (const w of pending) {
			const k = `${w.x},${w.y},${w.z}`;
			const existing = map.get(k);
			if (existing === undefined) map.set(k, w.id);
			else if (existing === AIR && w.id !== AIR) map.set(k, w.id);
		}
		const touchedChunks = new Set<string>();
		for (const [k, id] of map) {
			const [xs, ys, zs] = k.split(',');
			const x = Number(xs),
				y = Number(ys),
				z = Number(zs);
			if (this.world.getBlock(x, y, z) === id) continue;
			this.world.setBlock(x, y, z, id);
			const cx = Math.floor(x / CHUNK_SIZE_X);
			const cz = Math.floor(z / CHUNK_SIZE_Z);
			touchedChunks.add(`${cx},${cz}`);
		}
		for (const ck of touchedChunks) {
			const [cxs, czs] = ck.split(',');
			this.onChunkDirty(Number(cxs), Number(czs));
		}
	}

	private loadedChunks(): Chunk[] {
		const result: Chunk[] = [];
		for (const c of this.world.allChunks()) result.push(c);
		return result;
	}
}
