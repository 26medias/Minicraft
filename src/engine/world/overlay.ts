import type { BlockId } from '../../data/blocks.data';
import { isLiquid } from '../../data/blocks.data';
import type { Chunk } from './chunk';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z, chunkIndex, indexOf, worldToChunk } from './coords';

/** One overlay cell: block id, raw fluidMeta (0 = none/source, 0x80|d = flow), packed colour (0 = none). */
export type OverlayCell = [id: BlockId, fluid: number, color: number];

/**
 * Multiplayer chunk overlay (spec §6 "Unloaded chunks"): every server-sequenced cell, loaded chunk or
 * not. Seeded from the snapshot, updated at receive time by every op, and applied to a chunk right
 * after generation and before lighting. Solo never creates one.
 */
export class ChunkOverlay {
	private readonly chunks = new Map<number, Map<number, OverlayCell>>();
	private count = 0;

	/** Idempotent: the latest write for a cell wins. */
	set(x: number, y: number, z: number, id: BlockId, fluid: number, color: number): void {
		const { cx, cz, lx, lz } = worldToChunk(x, z);
		const ci = chunkIndex(cx, cz);
		let cells = this.chunks.get(ci);
		if (!cells) {
			cells = new Map();
			this.chunks.set(ci, cells);
		}
		const i = indexOf(lx, y, lz);
		if (!cells.has(i)) this.count++;
		cells.set(i, [id, fluid, color]);
	}

	get(x: number, y: number, z: number): OverlayCell | undefined {
		const { cx, cz, lx, lz } = worldToChunk(x, z);
		return this.chunks.get(chunkIndex(cx, cz))?.get(indexOf(lx, y, lz));
	}

	/** Snapshot rows, flat: [x, y, z, id, fluid, color, …]. */
	loadSnapshot(cells: Int32Array): void {
		for (let k = 0; k + 5 < cells.length; k += 6) {
			this.set(cells[k], cells[k + 1], cells[k + 2], cells[k + 3], cells[k + 4], cells[k + 5]);
		}
	}

	/**
	 * Writes this chunk's cells straight into `blocks` and `fluidMeta` (not via `Chunk.set`, which
	 * would mark it modified: an overlay-rebuilt chunk is regenerable, spec §6). Called before
	 * `fillChunkLights` (G1: after lighting, a dug shaft stayed at sky 0).
	 */
	applyTo(c: Chunk): void {
		const cells = this.chunks.get(chunkIndex(c.cx, c.cz));
		if (!cells) return;
		for (const [i, [id, fluid]] of cells) {
			c.blocks[i] = id;
			if (fluid === 0) c.fluidMeta.delete(i);
			else c.fluidMeta.set(i, fluid);
			c.hasLiquid ||= isLiquid(id);
		}
	}

	/** Coloured cells of chunk (cx, cz) in world coordinates (the loop restores lamp colours from these). */
	colorsIn(cx: number, cz: number): Array<{ x: number; y: number; z: number; color: number }> {
		const out: Array<{ x: number; y: number; z: number; color: number }> = [];
		const cells = this.chunks.get(chunkIndex(cx, cz));
		if (!cells) return out;
		const layer = CHUNK_SIZE_X * CHUNK_SIZE_Z;
		for (const [i, [, , color]] of cells) {
			if (color === 0) continue;
			const y = Math.floor(i / layer);
			const r = i - y * layer;
			const lz = Math.floor(r / CHUNK_SIZE_X);
			const lx = r - lz * CHUNK_SIZE_X;
			out.push({ x: cx * CHUNK_SIZE_X + lx, y, z: cz * CHUNK_SIZE_Z + lz, color });
		}
		return out;
	}

	/** Number of cells held. */
	get size(): number {
		return this.count;
	}
}
