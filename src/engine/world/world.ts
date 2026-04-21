import type { BlockId } from '../../data/blocks.data';
import { AIR } from '../../data/blocks.data';
import { Chunk } from './chunk';
import { WORLD_CHUNKS_X, WORLD_CHUNKS_Z, inBounds, worldToChunk } from './coords';
import { generateChunk } from './generation';

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
		c.modified = true;
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
