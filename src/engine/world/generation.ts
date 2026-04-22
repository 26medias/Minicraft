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
const MIN_H = 24;
const MAX_H = 34;
const NOISE_SCALE = 1 / 64;
export const SEA_LEVEL = 28;
const DIRT_BAND = 3;

export function generateChunk(chunk: Chunk, seed: number): void {
	const rng = alea(`minicraft:${seed}`);
	const noise = createNoise2D(rng);

	const baseX = chunk.cx * CHUNK_SIZE_X;
	const baseZ = chunk.cz * CHUNK_SIZE_Z;

	for (let lz = 0; lz < CHUNK_SIZE_Z; lz++) {
		for (let lx = 0; lx < CHUNK_SIZE_X; lx++) {
			const wx = baseX + lx;
			const wz = baseZ + lz;
			const n = noise(wx * NOISE_SCALE, wz * NOISE_SCALE);
			const h = Math.floor(MIN_H + (n * 0.5 + 0.5) * (MAX_H - MIN_H));

			for (let y = 0; y <= h; y++) {
				let id: number;
				if (y === h) id = h < SEA_LEVEL ? SAND : GRASS;
				else if (y >= h - DIRT_BAND) id = DIRT;
				else id = STONE;
				chunk.blocks[y * CHUNK_SIZE_X * CHUNK_SIZE_Z + lz * CHUNK_SIZE_X + lx] = id;
			}

			if (h < SEA_LEVEL) {
				for (let y = h + 1; y <= SEA_LEVEL; y++) {
					chunk.blocks[y * CHUNK_SIZE_X * CHUNK_SIZE_Z + lz * CHUNK_SIZE_X + lx] = WATER;
				}
			}
		}
	}

	chunk.dirty = true;
	chunk.modified = false;
}
