import type { World } from './world';
import type { Chunk } from './chunk';
import { BLOCKS } from '../../data/blocks.data';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z, indexOf } from './coords';

// Sun from upper NW; shadows fall to the SE. Normalized on the fly.
const SUN_DIR_RAW: [number, number, number] = [-0.5, 1.0, -0.3];
const MAX_SHADOW_DIST = 32;

/** Highest y holding an opaque, non-liquid block, or -1. Scanned from blocks on every call: a cached value goes stale the moment a block is placed at y=250. */
export function maxOpaqueY(chunk: Chunk): number {
	for (let y = chunk.height - 1; y >= 0; y--) {
		const base = y * CHUNK_SIZE_X * CHUNK_SIZE_Z;
		for (let i = 0; i < CHUNK_SIZE_X * CHUNK_SIZE_Z; i++) {
			const def = BLOCKS[chunk.blocks[base + i]];
			if (def && def.lightFilter >= 15 && def.liquid === 'none') return y;
		}
	}
	return -1;
}

function neighbourhoodMaxOpaqueY(world: World, chunk: Chunk): number {
	let m = -1;
	for (let dx = -1; dx <= 1; dx++)
		for (let dz = -1; dz <= 1; dz++) {
			const c = world.getChunk(chunk.cx + dx, chunk.cz + dz);
			if (c) m = Math.max(m, maxOpaqueY(c));
		}
	return m;
}

export function computeChunkShadows(world: World, chunk: Chunk): void {
	const len = Math.hypot(...SUN_DIR_RAW);
	const dx = SUN_DIR_RAW[0] / len;
	const dy = SUN_DIR_RAW[1] / len;
	const dz = SUN_DIR_RAW[2] / len;

	const baseX = chunk.cx * CHUNK_SIZE_X;
	const baseZ = chunk.cz * CHUNK_SIZE_Z;

	const skyFrom = neighbourhoodMaxOpaqueY(world, chunk) + 1;

	for (let y = 0; y < chunk.height; y++) {
		for (let z = 0; z < CHUNK_SIZE_Z; z++) {
			for (let x = 0; x < CHUNK_SIZE_X; x++) {
				const idx = indexOf(x, y, z);
				const id = chunk.blocks[idx];
				const def = BLOCKS[id];

				// Opaque blocks: sunlit irrelevant (their faces aren't sampled from inside); set 0.
				if (def && def.lightFilter >= 15 && def.liquid === 'none') {
					chunk.sunlit[idx] = 0;
					continue;
				}
				// No sky access at all: can't be in direct sun.
				if (chunk.getSky(x, y, z) === 0) {
					chunk.sunlit[idx] = 0;
					continue;
				}
				// The sun ray only goes up (dy > 0) and, within MAX_SHADOW_DIST, at most
				// one chunk sideways. Above every opaque block of the 3x3 neighbourhood
				// there is nothing to hit. Measured: 1.47M ray steps -> 10.6k at 256.
				if (y >= skyFrom) {
					chunk.sunlit[idx] = 1;
					continue;
				}
				chunk.sunlit[idx] = rayHitsSolidInLoadedChunks(
					world,
					baseX + x + 0.5,
					y + 0.5,
					baseZ + z + 0.5,
					dx,
					dy,
					dz,
					MAX_SHADOW_DIST,
				)
					? 0
					: 1;
			}
		}
	}
	chunk.shadowsDirty = false;
}

function rayHitsSolidInLoadedChunks(
	world: World,
	ox: number,
	oy: number,
	oz: number,
	dx: number,
	dy: number,
	dz: number,
	maxDist: number,
): boolean {
	// Amanatides-Woo DDA voxel traversal.
	let ix = Math.floor(ox);
	let iy = Math.floor(oy);
	let iz = Math.floor(oz);
	const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
	const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
	const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
	const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
	const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity;
	const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dz) : Infinity;
	let tMaxX = stepX === 0 ? Infinity : (stepX > 0 ? ix + 1 - ox : ox - ix) * Math.abs(1 / dx);
	let tMaxY = stepY === 0 ? Infinity : (stepY > 0 ? iy + 1 - oy : oy - iy) * Math.abs(1 / dy);
	let tMaxZ = stepZ === 0 ? Infinity : (stepZ > 0 ? iz + 1 - oz : oz - iz) * Math.abs(1 / dz);

	let t = 0;
	while (t < maxDist) {
		if (tMaxX < tMaxY && tMaxX < tMaxZ) {
			ix += stepX;
			t = tMaxX;
			tMaxX += tDeltaX;
		} else if (tMaxY < tMaxZ) {
			iy += stepY;
			t = tMaxY;
			tMaxY += tDeltaY;
		} else {
			iz += stepZ;
			t = tMaxZ;
			tMaxZ += tDeltaZ;
		}
		if (iy >= world.height) return false; // ray escaped upward to sky
		if (iy < 0) return false;
		const cx = Math.floor(ix / CHUNK_SIZE_X);
		const cz = Math.floor(iz / CHUNK_SIZE_Z);
		const chunk = world.getChunk(cx, cz);
		if (!chunk) return false; // ray left loaded region: treat as no hit (sunlit)
		const lx = ((ix % CHUNK_SIZE_X) + CHUNK_SIZE_X) % CHUNK_SIZE_X;
		const lz = ((iz % CHUNK_SIZE_Z) + CHUNK_SIZE_Z) % CHUNK_SIZE_Z;
		const id = chunk.blocks[indexOf(lx, iy, lz)];
		const def = BLOCKS[id];
		if (def && def.lightFilter >= 15 && def.liquid === 'none') return true;
	}
	return false;
}
