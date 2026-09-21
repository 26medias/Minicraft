import { createNoise2D } from 'simplex-noise';
import alea from 'alea';
import type { Chunk } from './chunk';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z } from './coords';
import { BLOCK_BY_NAME } from '../../data/blocks.data';

const GRASS = BLOCK_BY_NAME['grass_block'].id;
const DIRT = BLOCK_BY_NAME['dirt'].id;
const STONE = BLOCK_BY_NAME['stone'].id;
const SAND = BLOCK_BY_NAME['sand'].id;
const WATER = BLOCK_BY_NAME['water'].id;
const BEDROCK = BLOCK_BY_NAME['bedrock'].id;
const MIN_H = 114;
const MAX_H = 130;
const NOISE_SCALE = 1 / 64;
export const SEA_LEVEL_V2 = 120;
const DIRT_BAND = 3;

/** Placeholder tall generator: v1's terrain lifted to a 256 column, plus a bedrock floor. The worldgen project replaces it with v3. */
export function generateChunkV2(chunk: Chunk, seed: number): void {
	if (chunk.height !== 256) throw new RangeError('generator v2 needs a 256-high chunk');
	const rng = alea(`minicraft:${seed}`);
	const noise = createNoise2D(rng);
	const baseX = chunk.cx * CHUNK_SIZE_X;
	const baseZ = chunk.cz * CHUNK_SIZE_Z;
	const col = (lx: number, y: number, lz: number) => y * CHUNK_SIZE_X * CHUNK_SIZE_Z + lz * CHUNK_SIZE_X + lx;

	for (let lz = 0; lz < CHUNK_SIZE_Z; lz++) {
		for (let lx = 0; lx < CHUNK_SIZE_X; lx++) {
			const n = noise((baseX + lx) * NOISE_SCALE, (baseZ + lz) * NOISE_SCALE);
			const h = Math.floor(MIN_H + (n * 0.5 + 0.5) * (MAX_H - MIN_H));
			chunk.blocks[col(lx, 0, lz)] = BEDROCK;
			for (let y = 1; y <= h; y++) {
				let id: number;
				if (y === h) id = h < SEA_LEVEL_V2 ? SAND : GRASS;
				else if (y >= h - DIRT_BAND) id = DIRT;
				else id = STONE;
				chunk.blocks[col(lx, y, lz)] = id;
			}
			if (h < SEA_LEVEL_V2) for (let y = h + 1; y <= SEA_LEVEL_V2; y++) chunk.blocks[col(lx, y, lz)] = WATER;
		}
	}
	chunk.dirty = true;
	chunk.modified = false;
}
