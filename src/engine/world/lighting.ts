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
let _lampId = -1,
	_lavaId = -1;
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
export function fillChunkLights(
	world: World,
	chunk: Chunk,
	getLampColor?: LampColorLookup,
): Set<Chunk> {
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
			[1, 0, 0],
			[-1, 0, 0],
			[0, 1, 0],
			[0, -1, 0],
			[0, 0, 1],
			[0, 0, -1],
		];
		for (const [dx, dy, dz] of dirs) {
			const nx = x + dx,
				ny = y + dy,
				nz = z + dz;
			if (ny < 0 || ny >= CHUNK_SIZE_Y) continue;
			const nchunk = chunkAtWorld(world, nx, nz);
			if (!nchunk) continue;
			const nlx = nx - nchunk.cx * CHUNK_SIZE_X;
			const nlz = nz - nchunk.cz * CHUNK_SIZE_Z;
			const nid = nchunk.blocks[indexOf(nlx, ny, nlz)];
			const nFilter = filterOf(nid);
			if (nFilter >= 15) continue;
			// Special case: falling straight down through zero-filter preserves value.
			const attenuation =
				dy === -1 && nFilter === 0 && here === 15 ? 0 : Math.max(1, nFilter);
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

function seedBlockLight(
	world: World,
	chunk: Chunk,
	touched: Set<Chunk>,
	getLampColor?: LampColorLookup,
): void {
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
					chunk.setBlockRGB(
						x,
						y,
						z,
						Math.max(rSeed, curR),
						Math.max(gSeed, curG),
						Math.max(bSeed, curB),
					);
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
		case 0:
			return chunk.getBlockR(lx, y, lz);
		case 1:
			return chunk.getBlockG(lx, y, lz);
		case 2:
			return chunk.getBlockB(lx, y, lz);
	}
}

function setChannel(
	chunk: Chunk,
	lx: number,
	y: number,
	lz: number,
	ch: 0 | 1 | 2,
	v: number,
): void {
	const r = chunk.getBlockR(lx, y, lz);
	const g = chunk.getBlockG(lx, y, lz);
	const b = chunk.getBlockB(lx, y, lz);
	if (ch === 0) chunk.setBlockRGB(lx, y, lz, v, g, b);
	else if (ch === 1) chunk.setBlockRGB(lx, y, lz, r, v, b);
	else chunk.setBlockRGB(lx, y, lz, r, g, v);
}

function propagateBlockLight(world: World, queue: RGBQueueEntry[], touched: Set<Chunk>): void {
	const dirs: [number, number, number][] = [
		[1, 0, 0],
		[-1, 0, 0],
		[0, 1, 0],
		[0, -1, 0],
		[0, 0, 1],
		[0, 0, -1],
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
			const nx = x + dx,
				ny = y + dy,
				nz = z + dz;
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

/**
 * Incremental light update after a single block has been written at (x, y, z).
 * Must be called AFTER world.setBlock has run (the chunk's blocks array already
 * reflects the new block, but lights still holds the old values).
 *
 * Performs per-channel removal BFS followed by re-propagation from unchanged
 * frontier voxels. Re-seeds the skylight column if the change opened/closed
 * a path to the sky. Seeds new emitter light if the new block has lightLevel > 0.
 *
 * Returns the set of chunks whose lights changed.
 */
export function updateLightsForBlockChange(
	world: World,
	x: number,
	y: number,
	z: number,
	getLampColor?: LampColorLookup,
): Set<Chunk> {
	const touched = new Set<Chunk>();
	const chunk = chunkAtWorld(world, x, z);
	if (!chunk) return touched;
	touched.add(chunk);

	const lx = x - chunk.cx * CHUNK_SIZE_X;
	const lz = z - chunk.cz * CHUNK_SIZE_Z;
	const oldSky = chunk.getSky(lx, y, lz);
	const oldR = chunk.getBlockR(lx, y, lz);
	const oldG = chunk.getBlockG(lx, y, lz);
	const oldB = chunk.getBlockB(lx, y, lz);

	chunk.setSky(lx, y, lz, 0);
	chunk.setBlockRGB(lx, y, lz, 0, 0, 0);

	removeAndReflood(world, x, y, z, oldSky, touched, 'sky');
	removeAndReflood(world, x, y, z, oldR, touched, 'r');
	removeAndReflood(world, x, y, z, oldG, touched, 'g');
	removeAndReflood(world, x, y, z, oldB, touched, 'b');

	// If the new block is passable (filter < 15), re-flood from lit neighbors
	// into the changed voxel — this handles the "break a wall, let light in" case.
	refloodFromNeighbors(world, x, y, z, touched);

	reSeedSkylightColumn(world, x, z, touched);

	// New emitter?
	const newId = chunk.blocks[indexOf(lx, y, lz)];
	const def = BLOCKS[newId];
	if (def && def.lightLevel > 0) {
		let color: [number, number, number] = [1, 1, 1];
		if (newId === lampId()) {
			color = parseHex(getLampColor?.(x, y, z) ?? '#FFFFFF');
		} else if (newId === lavaId()) {
			color = parseHex(LAVA_LIGHT_COLOR);
		}
		const r = Math.round(color[0] * def.lightLevel);
		const g = Math.round(color[1] * def.lightLevel);
		const b = Math.round(color[2] * def.lightLevel);
		const curR = chunk.getBlockR(lx, y, lz);
		const curG = chunk.getBlockG(lx, y, lz);
		const curB = chunk.getBlockB(lx, y, lz);
		chunk.setBlockRGB(lx, y, lz, Math.max(r, curR), Math.max(g, curG), Math.max(b, curB));
		const q: RGBQueueEntry[] = [];
		if (r > 0) q.push({ x, y, z, channel: 0 });
		if (g > 0) q.push({ x, y, z, channel: 1 });
		if (b > 0) q.push({ x, y, z, channel: 2 });
		propagateBlockLight(world, q, touched);
	}

	return touched;
}

type Field = 'sky' | 'r' | 'g' | 'b';

function getField(chunk: Chunk, lx: number, y: number, lz: number, f: Field): number {
	if (f === 'sky') return chunk.getSky(lx, y, lz);
	return getChannel(chunk, lx, y, lz, f === 'r' ? 0 : f === 'g' ? 1 : 2);
}

function setField(chunk: Chunk, lx: number, y: number, lz: number, f: Field, v: number): void {
	if (f === 'sky') {
		chunk.setSky(lx, y, lz, v);
		return;
	}
	setChannel(chunk, lx, y, lz, f === 'r' ? 0 : f === 'g' ? 1 : 2, v);
}

function removeAndReflood(
	world: World,
	ox: number,
	oy: number,
	oz: number,
	oldLight: number,
	touched: Set<Chunk>,
	field: Field,
): void {
	if (oldLight <= 0) return;
	const remQueue: { x: number; y: number; z: number; value: number }[] = [
		{ x: ox, y: oy, z: oz, value: oldLight },
	];
	const addQueue: { x: number; y: number; z: number }[] = [];
	const dirs: [number, number, number][] = [
		[1, 0, 0],
		[-1, 0, 0],
		[0, 1, 0],
		[0, -1, 0],
		[0, 0, 1],
		[0, 0, -1],
	];

	while (remQueue.length) {
		const { x, y, z, value } = remQueue.shift()!;
		for (const [dx, dy, dz] of dirs) {
			const nx = x + dx,
				ny = y + dy,
				nz = z + dz;
			if (ny < 0 || ny >= CHUNK_SIZE_Y) continue;
			const nchunk = chunkAtWorld(world, nx, nz);
			if (!nchunk) continue;
			const nlx = nx - nchunk.cx * CHUNK_SIZE_X;
			const nlz = nz - nchunk.cz * CHUNK_SIZE_Z;
			const nValue = getField(nchunk, nlx, ny, nlz, field);
			if (nValue > 0 && nValue < value) {
				setField(nchunk, nlx, ny, nlz, field, 0);
				touched.add(nchunk);
				remQueue.push({ x: nx, y: ny, z: nz, value: nValue });
			} else if (nValue >= value) {
				addQueue.push({ x: nx, y: ny, z: nz });
			}
		}
	}

	if (field === 'sky') {
		const q: Coord[] = addQueue.map((c) => ({ ...c }));
		propagateSkylight(world, q, touched);
	} else {
		const ch: 0 | 1 | 2 = field === 'r' ? 0 : field === 'g' ? 1 : 2;
		const q: RGBQueueEntry[] = addQueue.map((c) => ({ x: c.x, y: c.y, z: c.z, channel: ch }));
		propagateBlockLight(world, q, touched);
	}
}

/**
 * After a block change makes a voxel passable, re-flood all light channels
 * from each lit neighbor into the now-transparent voxel. This covers the
 * "break a wall and let existing light spill through" case where the changed
 * voxel itself had zero stored light before the change.
 */
function refloodFromNeighbors(
	world: World,
	x: number,
	y: number,
	z: number,
	touched: Set<Chunk>,
): void {
	const chunk = chunkAtWorld(world, x, z);
	if (!chunk) return;
	const lx = x - chunk.cx * CHUNK_SIZE_X;
	const lz = z - chunk.cz * CHUNK_SIZE_Z;
	const newId = chunk.blocks[indexOf(lx, y, lz)];
	if (filterOf(newId) >= 15) return; // new block is opaque — nothing can enter

	const dirs: [number, number, number][] = [
		[1, 0, 0],
		[-1, 0, 0],
		[0, 1, 0],
		[0, -1, 0],
		[0, 0, 1],
		[0, 0, -1],
	];
	const skyQ: Coord[] = [];
	const rgbQ: RGBQueueEntry[] = [];
	for (const [dx, dy, dz] of dirs) {
		const nx = x + dx,
			ny = y + dy,
			nz = z + dz;
		if (ny < 0 || ny >= CHUNK_SIZE_Y) continue;
		const nchunk = chunkAtWorld(world, nx, nz);
		if (!nchunk) continue;
		const nlx = nx - nchunk.cx * CHUNK_SIZE_X;
		const nlz = nz - nchunk.cz * CHUNK_SIZE_Z;
		if (nchunk.getSky(nlx, ny, nlz) > 0) skyQ.push({ x: nx, y: ny, z: nz });
		if (nchunk.getBlockR(nlx, ny, nlz) > 0) rgbQ.push({ x: nx, y: ny, z: nz, channel: 0 });
		if (nchunk.getBlockG(nlx, ny, nlz) > 0) rgbQ.push({ x: nx, y: ny, z: nz, channel: 1 });
		if (nchunk.getBlockB(nlx, ny, nlz) > 0) rgbQ.push({ x: nx, y: ny, z: nz, channel: 2 });
	}
	if (skyQ.length) propagateSkylight(world, skyQ, touched);
	if (rgbQ.length) propagateBlockLight(world, rgbQ, touched);
}

function reSeedSkylightColumn(world: World, wx: number, wz: number, touched: Set<Chunk>): void {
	const chunk = chunkAtWorld(world, wx, wz);
	if (!chunk) return;
	const lx = wx - chunk.cx * CHUNK_SIZE_X;
	const lz = wz - chunk.cz * CHUNK_SIZE_Z;
	const q: Coord[] = [];
	for (let y = CHUNK_SIZE_Y - 1; y >= 0; y--) {
		const id = chunk.blocks[indexOf(lx, y, lz)];
		if (filterOf(id) >= 15) break;
		if (chunk.getSky(lx, y, lz) < 15) {
			chunk.setSky(lx, y, lz, 15);
			q.push({ x: wx, y, z: wz });
		}
	}
	if (q.length) propagateSkylight(world, q, touched);
}
