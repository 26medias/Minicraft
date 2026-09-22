import type { BlockId } from '../../data/blocks.data';
import { AIR, isLiquid } from '../../data/blocks.data';
import { Chunk } from './chunk';
import { WORLD_CHUNKS_X, WORLD_CHUNKS_Z, LEGACY_HEIGHT, inBounds, worldToChunk, indexOf, chunkIndexOrNeg, type WorldHeight } from './coords';
import { generateChunk, worldProfile, NEWEST_GEN_VERSION } from './generation';
import { fillChunkLights } from './lighting';

export type WorldOptions = { height?: WorldHeight; genVersion?: number; saveVersion?: 2 | 3 };

export class World {
	readonly seed: number;
	readonly height: WorldHeight;
	readonly genVersion: number;
	readonly saveVersion: 2 | 3;
	/** Flat, indexed by exactly cx * WORLD_CHUNKS_Z + cz (spec §3.A). */
	private chunks: (Chunk | undefined)[] = new Array(WORLD_CHUNKS_X * WORLD_CHUNKS_Z);
	private count = 0;

	constructor(seed: number, opts: WorldOptions = {}) {
		this.seed = seed;
		this.height = opts.height ?? LEGACY_HEIGHT;
		// Derived, not validated: a loaded record's own height is authoritative (spec §4).
		this.genVersion = opts.genVersion ?? (this.height === 256 ? 2 : 1);
		this.saveVersion = opts.saveVersion ?? 2;
	}

	/** A brand-new world: newest generator, its height, saved as v3. This is the ONE place height and genVersion are checked against each other (spec §4: a stored record's height is authoritative, so the constructor never validates). */
	static create(seed: number): World {
		const { height } = worldProfile(NEWEST_GEN_VERSION);
		return new World(seed, { height, genVersion: NEWEST_GEN_VERSION, saveVersion: 3 });
	}

	inBounds(x: number, y: number, z: number): boolean {
		return inBounds(x, y, z, this.height);
	}

	/** Bounds-checked: hot paths call this with out-of-range coordinates (DDA steps, neighbour scans). */
	getChunk(cx: number, cz: number): Chunk | undefined {
		if (cx < 0 || cx >= WORLD_CHUNKS_X || cz < 0 || cz >= WORLD_CHUNKS_Z) return undefined;
		return this.chunks[cx * WORLD_CHUNKS_Z + cz];
	}

	getChunkByIndex(i: number): Chunk | undefined {
		return i < 0 || i >= this.chunks.length ? undefined : this.chunks[i];
	}

	ensureChunk(cx: number, cz: number): Chunk {
		// Unchecked index on purpose: every caller passes chunkInWorld. The guard below is
		// live under vitest (import.meta.env.DEV === true) — an assertion, not dead code.
		if (import.meta.env?.DEV && (cx < 0 || cx >= WORLD_CHUNKS_X || cz < 0 || cz >= WORLD_CHUNKS_Z)) {
			throw new RangeError(`ensureChunk(${cx},${cz}) is outside the world`);
		}
		const i = cx * WORLD_CHUNKS_Z + cz;
		let c = this.chunks[i];
		if (!c) {
			c = new Chunk(cx, cz, this.height);
			generateChunk(c, this.seed, this.genVersion);
			this.chunks[i] = c;
			this.count++;
			fillChunkLights(this, c);
		}
		return c;
	}

	/** Eviction (spec §3.E). Returns false when nothing was there. */
	dropChunk(cx: number, cz: number): boolean {
		const i = chunkIndexOrNeg(cx, cz);
		if (i < 0 || !this.chunks[i]) return false;
		this.chunks[i] = undefined;
		this.count--;
		return true;
	}

	get chunkCount(): number {
		return this.count;
	}

	chunkInWorld(cx: number, cz: number): boolean {
		return cx >= 0 && cx < WORLD_CHUNKS_X && cz >= 0 && cz < WORLD_CHUNKS_Z;
	}

	getBlock(x: number, y: number, z: number): BlockId {
		if (!this.inBounds(x, y, z)) return AIR;
		const { cx, cz, lx, lz } = worldToChunk(x, z);
		const c = this.ensureChunk(cx, cz);
		return c.get(lx, y, lz);
	}

	setBlock(x: number, y: number, z: number, id: BlockId): void {
		if (!this.inBounds(x, y, z)) return;
		const { cx, cz, lx, lz } = worldToChunk(x, z);
		const c = this.ensureChunk(cx, cz);
		c.set(lx, y, lz, id);
		// Regular writes (player placement, world-gen, scheduler-AIR) carry no flow state:
		// any stale entry must go so the cell is treated as a source / non-liquid next tick.
		c.clearFluidMeta(lx, y, lz);
		// World-level writes represent game actions — mark modified even when the block
		// happens to match generation, so the save system persists the intent. Chunk.set
		// separately keeps `dirty` clean on true no-ops, so meshing cost isn't paid.
		c.modified = true;

		this.markLiquidFrontier(x, y, z);
		this.markLiquidFrontier(x + 1, y, z);
		this.markLiquidFrontier(x - 1, y, z);
		this.markLiquidFrontier(x, y + 1, z);
		this.markLiquidFrontier(x, y - 1, z);
		this.markLiquidFrontier(x, y, z + 1);
		this.markLiquidFrontier(x, y, z - 1);
	}

	/** Scheduler-only: write a liquid voxel as flow with the given distance from source. */
	setBlockFlow(x: number, y: number, z: number, id: BlockId, distance: number): void {
		if (!this.inBounds(x, y, z)) return;
		const { cx, cz, lx, lz } = worldToChunk(x, z);
		const c = this.ensureChunk(cx, cz);
		c.set(lx, y, lz, id);
		c.setFluidMeta(lx, y, lz, distance);
		c.modified = true;

		this.markLiquidFrontier(x, y, z);
		this.markLiquidFrontier(x + 1, y, z);
		this.markLiquidFrontier(x - 1, y, z);
		this.markLiquidFrontier(x, y + 1, z);
		this.markLiquidFrontier(x, y - 1, z);
		this.markLiquidFrontier(x, y, z + 1);
		this.markLiquidFrontier(x, y, z - 1);
	}

	markLiquidFrontier(x: number, y: number, z: number): void {
		if (!this.inBounds(x, y, z)) return;
		const { cx, cz, lx, lz } = worldToChunk(x, z);
		const c = this.getChunk(cx, cz);
		if (!c) return;
		const id = c.get(lx, y, lz);
		if (isLiquid(id)) {
			c.liquidFrontier.add(indexOf(lx, y, lz));
		}
	}

	*allChunks(): Iterable<Chunk> {
		for (const c of this.chunks) if (c) yield c;
	}

	modifiedChunks(): Chunk[] {
		const out: Chunk[] = [];
		for (const c of this.chunks) if (c && c.modified) out.push(c);
		return out;
	}

	neighbors(c: Chunk): { px?: Chunk; nx?: Chunk; pz?: Chunk; nz?: Chunk } {
		return {
			px: this.chunkInWorld(c.cx + 1, c.cz) ? this.ensureChunk(c.cx + 1, c.cz) : undefined,
			nx: this.chunkInWorld(c.cx - 1, c.cz) ? this.ensureChunk(c.cx - 1, c.cz) : undefined,
			pz: this.chunkInWorld(c.cx, c.cz + 1) ? this.ensureChunk(c.cx, c.cz + 1) : undefined,
			nz: this.chunkInWorld(c.cx, c.cz - 1) ? this.ensureChunk(c.cx, c.cz - 1) : undefined,
		};
	}
}
