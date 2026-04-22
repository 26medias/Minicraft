import type { World } from './world';
import type { Chunk } from './chunk';
import { BLOCKS } from '../../data/blocks.data';
import { CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z, indexOf } from './coords';

type Coord = { x: number; y: number; z: number };

function filterOf(id: number): number {
	return BLOCKS[id]?.lightFilter ?? 0;
}

/**
 * Compute the full lightmap for a chunk from scratch. Clears the existing lights
 * array, runs the skylight flood-fill, and returns the set of chunks touched
 * (includes the target chunk plus any neighbors reached by BFS propagation).
 *
 * Block-light RGB fill is layered on in a later task.
 */
export function fillChunkLights(world: World, chunk: Chunk): Set<Chunk> {
	chunk.lights.fill(0);
	const touched = new Set<Chunk>();
	touched.add(chunk);
	seedSkylight(world, chunk, touched);
	return touched;
}

function seedSkylight(world: World, chunk: Chunk, touched: Set<Chunk>): void {
	const queue: Coord[] = [];
	const baseX = chunk.cx * CHUNK_SIZE_X;
	const baseZ = chunk.cz * CHUNK_SIZE_Z;

	for (let lz = 0; lz < CHUNK_SIZE_Z; lz++) {
		for (let lx = 0; lx < CHUNK_SIZE_X; lx++) {
			for (let y = CHUNK_SIZE_Y - 1; y >= 0; y--) {
				const id = chunk.blocks[indexOf(lx, y, lz)];
				if (filterOf(id) >= 15) break;
				chunk.setSky(lx, y, lz, 15);
				queue.push({ x: baseX + lx, y, z: baseZ + lz });
			}
		}
	}

	propagateSkylight(world, queue, touched);
}

function propagateSkylight(world: World, queue: Coord[], touched: Set<Chunk>): void {
	while (queue.length) {
		const { x, y, z } = queue.shift()!;
		const chunk = chunkAtWorld(world, x, z);
		if (!chunk) continue;
		const lx = x - chunk.cx * CHUNK_SIZE_X;
		const lz = z - chunk.cz * CHUNK_SIZE_Z;
		const here = chunk.getSky(lx, y, lz);
		if (here <= 0) continue;

		const dirs: [number, number, number][] = [
			[1, 0, 0], [-1, 0, 0],
			[0, 1, 0], [0, -1, 0],
			[0, 0, 1], [0, 0, -1],
		];
		for (const [dx, dy, dz] of dirs) {
			const nx = x + dx, ny = y + dy, nz = z + dz;
			if (ny < 0 || ny >= CHUNK_SIZE_Y) continue;
			const nchunk = chunkAtWorld(world, nx, nz);
			if (!nchunk) continue;
			const nlx = nx - nchunk.cx * CHUNK_SIZE_X;
			const nlz = nz - nchunk.cz * CHUNK_SIZE_Z;
			const nid = nchunk.blocks[indexOf(nlx, ny, nlz)];
			const nFilter = filterOf(nid);
			if (nFilter >= 15) continue;
			// Special case: falling straight down through zero-filter preserves value.
			const attenuation = dy === -1 && nFilter === 0 && here === 15 ? 0 : Math.max(1, nFilter);
			const propagated = here - attenuation;
			if (propagated <= 0) continue;
			if (nchunk.getSky(nlx, ny, nlz) >= propagated) continue;
			nchunk.setSky(nlx, ny, nlz, propagated);
			touched.add(nchunk);
			queue.push({ x: nx, y: ny, z: nz });
		}
	}
}

function chunkAtWorld(world: World, x: number, z: number): Chunk | undefined {
	const cx = Math.floor(x / CHUNK_SIZE_X);
	const cz = Math.floor(z / CHUNK_SIZE_Z);
	if (!world.chunkInWorld(cx, cz)) return undefined;
	return world.getChunk(cx, cz);
}
