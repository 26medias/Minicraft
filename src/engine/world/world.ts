import type { BlockId } from '../../data/blocks.data';
import { AIR, isLiquid } from '../../data/blocks.data';
import { Chunk } from './chunk';
import { WORLD_CHUNKS_X, WORLD_CHUNKS_Z, inBounds, worldToChunk, indexOf } from './coords';
import { generateChunk } from './generation';
import { fillChunkLights } from './lighting';

const key = (cx: number, cz: number) => `${cx},${cz}`;

export class World {
	readonly seed: number;
	private chunks = new Map<string, Chunk>();

	constructor(seed: number) {
		this.seed = seed;
	}

	getChunk(cx: number, cz: number): Chunk | undefined {
		return this.chunks.get(key(cx, cz));
	}

	ensureChunk(cx: number, cz: number): Chunk {
		const k = key(cx, cz);
		let c = this.chunks.get(k);
		if (!c) {
			c = new Chunk(cx, cz);
			generateChunk(c, this.seed);
			this.chunks.set(k, c);
			fillChunkLights(this, c);
		}
		return c;
	}

	chunkInWorld(cx: number, cz: number): boolean {
		return cx >= 0 && cx < WORLD_CHUNKS_X && cz >= 0 && cz < WORLD_CHUNKS_Z;
	}

	getBlock(x: number, y: number, z: number): BlockId {
		if (!inBounds(x, y, z)) return AIR;
		const { cx, cz, lx, lz } = worldToChunk(x, z);
		const c = this.ensureChunk(cx, cz);
		return c.get(lx, y, lz);
	}

	setBlock(x: number, y: number, z: number, id: BlockId): void {
		if (!inBounds(x, y, z)) return;
		const { cx, cz, lx, lz } = worldToChunk(x, z);
		const c = this.ensureChunk(cx, cz);
		c.set(lx, y, lz, id);
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

	markLiquidFrontier(x: number, y: number, z: number): void {
		if (!inBounds(x, y, z)) return;
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
