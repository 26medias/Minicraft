import type { BlockId } from '../../data/blocks.data';
import { LEGACY_HEIGHT, blocksPerChunk, indexOf, type WorldHeight } from './coords';

export class Chunk {
	readonly cx: number;
	readonly cz: number;
	readonly height: WorldHeight;
	readonly blocks: Uint16Array;
	readonly lights: Uint16Array;
	readonly sunlit: Uint8Array;
	readonly liquidFrontier: Set<number> = new Set();
	/** Packed flow metadata, sparse — only flow voxels have entries. Source = absence of entry. */
	readonly fluidMeta: Map<number, number> = new Map();
	dirty = true;
	modified = false;
	shadowsDirty = true;
	/** FNV-1a of `sunlit` after the last `computeChunkShadows`; neighbours re-mesh only when it changed (spec §3.E). */
	sunlitHash = 0;
	/**
	 * Revision: bumped by `set`, by `updateLightsForBlockChange` for every touched chunk and by shadow
	 * invalidation in the loop. A worker reply is applied only if the chunk's rev still equals the
	 * rev it was posted with (spec §3.D).
	 */
	rev = 0;

	constructor(
		cx: number,
		cz: number,
		height: WorldHeight = LEGACY_HEIGHT,
		blocks: Uint16Array | null = null,
		lights: Uint16Array | null = null,
		sunlit: Uint8Array | null = null,
	) {
		this.cx = cx;
		this.cz = cz;
		this.height = height;
		const n = blocksPerChunk(height);
		this.blocks = blocks ?? new Uint16Array(n);
		this.lights = lights ?? new Uint16Array(n);
		this.sunlit = sunlit ?? new Uint8Array(n);
	}

	/** Wraps received buffers (the chunk worker); allocates only the arrays passed as null/undefined. */
	static over(
		cx: number,
		cz: number,
		height: WorldHeight,
		blocks: Uint16Array,
		lights?: Uint16Array | null,
		sunlit?: Uint8Array | null,
	): Chunk {
		return new Chunk(cx, cz, height, blocks, lights ?? null, sunlit ?? null);
	}

	get(x: number, y: number, z: number): BlockId {
		return this.blocks[indexOf(x, y, z)];
	}

	set(x: number, y: number, z: number, id: BlockId): void {
		const i = indexOf(x, y, z);
		if (this.blocks[i] === id) return;
		this.blocks[i] = id;
		this.dirty = true;
		this.modified = true;
		this.rev++;
	}

	/** True if (x,y,z) has a flow entry. False for source voxels and non-liquid cells. */
	isFlow(x: number, y: number, z: number): boolean {
		return this.fluidMeta.has(indexOf(x, y, z));
	}

	/** Returns the flow distance for a flow voxel, or 0 for a source / no-entry cell. */
	getFlowDistance(x: number, y: number, z: number): number {
		const v = this.fluidMeta.get(indexOf(x, y, z));
		return v === undefined ? 0 : v & 0x0f;
	}

	/** Mark (x,y,z) as flow with the given distance (0–15). */
	setFluidMeta(x: number, y: number, z: number, distance: number): void {
		const i = indexOf(x, y, z);
		const packed = 0x80 | (distance & 0x0f);
		const existing = this.fluidMeta.get(i);
		if (existing === packed) return;
		this.fluidMeta.set(i, packed);
		this.modified = true;
	}

	/** Remove the flow entry at (x,y,z). After this, the cell is "source" by default. */
	clearFluidMeta(x: number, y: number, z: number): void {
		const i = indexOf(x, y, z);
		if (!this.fluidMeta.has(i)) return;
		this.fluidMeta.delete(i);
		this.modified = true;
	}

	getSky(x: number, y: number, z: number): number {
		return (this.lights[indexOf(x, y, z)] >> 12) & 0xf;
	}

	setSky(x: number, y: number, z: number, v: number): void {
		const i = indexOf(x, y, z);
		const masked = Math.min(15, Math.max(0, v)) & 0xf;
		this.lights[i] = (this.lights[i] & 0x0fff) | (masked << 12);
	}

	getBlockR(x: number, y: number, z: number): number {
		return (this.lights[indexOf(x, y, z)] >> 8) & 0xf;
	}

	getBlockG(x: number, y: number, z: number): number {
		return (this.lights[indexOf(x, y, z)] >> 4) & 0xf;
	}

	getBlockB(x: number, y: number, z: number): number {
		return this.lights[indexOf(x, y, z)] & 0xf;
	}

	setBlockRGB(x: number, y: number, z: number, r: number, g: number, b: number): void {
		const i = indexOf(x, y, z);
		const rm = Math.min(15, Math.max(0, r)) & 0xf;
		const gm = Math.min(15, Math.max(0, g)) & 0xf;
		const bm = Math.min(15, Math.max(0, b)) & 0xf;
		this.lights[i] = (this.lights[i] & 0xf000) | (rm << 8) | (gm << 4) | bm;
	}
}
