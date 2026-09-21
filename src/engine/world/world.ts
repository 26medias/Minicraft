import type { BlockId } from '../../data/blocks.data';
import { AIR, isLiquid } from '../../data/blocks.data';
import { Chunk } from './chunk';
import { WORLD_CHUNKS_X, WORLD_CHUNKS_Z, LEGACY_HEIGHT, inBounds, worldToChunk, indexOf, type WorldHeight } from './coords';
import { generateChunk, worldProfile, NEWEST_GEN_VERSION } from './generation';
import { fillChunkLights } from './lighting';

const key = (cx: number, cz: number) => `${cx},${cz}`;

export type WorldOptions = { height?: WorldHeight; genVersion?: number; saveVersion?: 2 | 3 };

export class World {
	readonly seed: number;
	readonly height: WorldHeight;
	readonly genVersion: number;
	readonly saveVersion: 2 | 3;
	private chunks = new Map<string, Chunk>();

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

	getChunk(cx: number, cz: number): Chunk | undefined {
		return this.chunks.get(key(cx, cz));
	}

	ensureChunk(cx: number, cz: number): Chunk {
		const k = key(cx, cz);
		let c = this.chunks.get(k);
		if (!c) {
			c = new Chunk(cx, cz, this.height);
			generateChunk(c, this.seed, this.genVersion);
			this.chunks.set(k, c);
			fillChunkLights(this, c);
		}
		return c;
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
		for (const c of this.chunks.values()) yield c;
	}

	modifiedChunks(): Chunk[] {
		const out: Chunk[] = [];
		for (const c of this.chunks.values()) if (c.modified) out.push(c);
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
