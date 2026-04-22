import type { World } from './world';
import type { Chunk } from './chunk';
import { BLOCKS } from '../../data/blocks.data';
import { CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z, indexOf } from './coords';

type Coord = { x: number; y: number; z: number };

export type LampColorLookup = (x: number, y: number, z: number) => string | null;

const LAVA_LIGHT_COLOR = '#FF8A3D';

function parseHex(hex: string): [number, number, number] {
	if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return [1, 1, 1];
	const r = parseInt(hex.slice(1, 3), 16) / 255;
	const g = parseInt(hex.slice(3, 5), 16) / 255;
	const b = parseInt(hex.slice(5, 7), 16) / 255;
	return [r, g, b];
}

// Resolve lamp and lava ids lazily so `BLOCKS` is fully populated by the time this runs.
let _lampId = -1, _lavaId = -1;
function lampId(): number {
	if (_lampId < 0) _lampId = BLOCKS.findIndex((b) => b.name === 'lamp');
	return _lampId;
}
function lavaId(): number {
	if (_lavaId < 0) _lavaId = BLOCKS.findIndex((b) => b.name === 'lava');
	return _lavaId;
}

function filterOf(id: number): number {
	return BLOCKS[id]?.lightFilter ?? 0;
}

/**
 * Compute the full lightmap for a chunk from scratch. Clears the existing lights
 * array, runs the skylight flood-fill and block-light RGB flood-fill, and returns
 * the set of chunks touched (includes the target chunk plus any neighbors reached
 * by BFS propagation).
 */
export function fillChunkLights(world: World, chunk: Chunk, getLampColor?: LampColorLookup): Set<Chunk> {
	chunk.lights.fill(0);
	const touched = new Set<Chunk>();
	touched.add(chunk);
	seedSkylight(world, chunk, touched);
	seedBlockLight(world, chunk, touched, getLampColor);
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

type RGBQueueEntry = { x: number; y: number; z: number; channel: 0 | 1 | 2 };

function seedBlockLight(world: World, chunk: Chunk, touched: Set<Chunk>, getLampColor?: LampColorLookup): void {
	const queue: RGBQueueEntry[] = [];
	const baseX = chunk.cx * CHUNK_SIZE_X;
	const baseZ = chunk.cz * CHUNK_SIZE_Z;

	for (let y = 0; y < CHUNK_SIZE_Y; y++) {
		for (let z = 0; z < CHUNK_SIZE_Z; z++) {
			for (let x = 0; x < CHUNK_SIZE_X; x++) {
				const id = chunk.blocks[indexOf(x, y, z)];
				const def = BLOCKS[id];
				if (!def || def.lightLevel <= 0) continue;
				let color: [number, number, number];
				if (id === lampId()) {
					const hex = getLampColor?.(baseX + x, y, baseZ + z) ?? '#FFFFFF';
					color = parseHex(hex ?? '#FFFFFF');
				} else if (id === lavaId()) {
					color = parseHex(LAVA_LIGHT_COLOR);
				} else {
					color = [1, 1, 1];
				}
				const rSeed = Math.round(color[0] * def.lightLevel);
				const gSeed = Math.round(color[1] * def.lightLevel);
				const bSeed = Math.round(color[2] * def.lightLevel);
				const curR = chunk.getBlockR(x, y, z);
				const curG = chunk.getBlockG(x, y, z);
				const curB = chunk.getBlockB(x, y, z);
				if (rSeed > curR || gSeed > curG || bSeed > curB) {
					chunk.setBlockRGB(x, y, z, Math.max(rSeed, curR), Math.max(gSeed, curG), Math.max(bSeed, curB));
				}
				if (rSeed > 0) queue.push({ x: baseX + x, y, z: baseZ + z, channel: 0 });
				if (gSeed > 0) queue.push({ x: baseX + x, y, z: baseZ + z, channel: 1 });
				if (bSeed > 0) queue.push({ x: baseX + x, y, z: baseZ + z, channel: 2 });
			}
		}
	}

	propagateBlockLight(world, queue, touched);
}

function getChannel(chunk: Chunk, lx: number, y: number, lz: number, ch: 0 | 1 | 2): number {
	switch (ch) {
		case 0: return chunk.getBlockR(lx, y, lz);
		case 1: return chunk.getBlockG(lx, y, lz);
		case 2: return chunk.getBlockB(lx, y, lz);
	}
}

function setChannel(chunk: Chunk, lx: number, y: number, lz: number, ch: 0 | 1 | 2, v: number): void {
	const r = chunk.getBlockR(lx, y, lz);
	const g = chunk.getBlockG(lx, y, lz);
	const b = chunk.getBlockB(lx, y, lz);
	if (ch === 0) chunk.setBlockRGB(lx, y, lz, v, g, b);
	else if (ch === 1) chunk.setBlockRGB(lx, y, lz, r, v, b);
	else chunk.setBlockRGB(lx, y, lz, r, g, v);
}

function propagateBlockLight(world: World, queue: RGBQueueEntry[], touched: Set<Chunk>): void {
	const dirs: [number, number, number][] = [
		[1, 0, 0], [-1, 0, 0],
		[0, 1, 0], [0, -1, 0],
		[0, 0, 1], [0, 0, -1],
	];
	while (queue.length) {
		const { x, y, z, channel } = queue.shift()!;
		const chunk = chunkAtWorld(world, x, z);
		if (!chunk) continue;
		const lx = x - chunk.cx * CHUNK_SIZE_X;
		const lz = z - chunk.cz * CHUNK_SIZE_Z;
		const here = getChannel(chunk, lx, y, lz, channel);
		if (here <= 0) continue;

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
			const propagated = here - Math.max(1, nFilter);
			if (propagated <= 0) continue;
			if (getChannel(nchunk, nlx, ny, nlz, channel) >= propagated) continue;
			setChannel(nchunk, nlx, ny, nlz, channel, propagated);
			touched.add(nchunk);
			queue.push({ x: nx, y: ny, z: nz, channel });
		}
	}
}
