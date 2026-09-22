// NOTE: no value import from './world' — shadows.ts must stay free of world.ts (import.meta,
// generation, lighting) so it can be bundled into the chunk worker (Task 5).
import type { World } from './world';
import type { Chunk } from './chunk';
import { BLOCKS } from '../../data/blocks.data';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z, indexOf } from './coords';

// Sun from upper NW; shadows fall to the SE. Normalized on the fly.
const SUN_DIR_RAW: [number, number, number] = [-0.5, 1.0, -0.3];
const MAX_SHADOW_DIST = 32;

/** Test-only counter of rays actually walked (reset by tests). */
export const SHADOW_STATS = { rays: 0 };

const OPAQUE = new Uint8Array(BLOCKS.length);
for (const b of BLOCKS) OPAQUE[b.id] = b.lightFilter >= 15 && b.liquid === 'none' ? 1 : 0;

/** Highest y holding an opaque, non-liquid block, or -1. Scanned from blocks on every call: a cached value goes stale the moment a block is placed at y=250. */
export function maxOpaqueY(chunk: Chunk): number {
	for (let y = chunk.height - 1; y >= 0; y--) {
		const base = y * CHUNK_SIZE_X * CHUNK_SIZE_Z;
		for (let i = 0; i < CHUNK_SIZE_X * CHUNK_SIZE_Z; i++) {
			if (OPAQUE[chunk.blocks[base + i]]) return y;
		}
	}
	return -1;
}

/**
 * Relative voxel path of the sun ray from any voxel centre (spec §3.C.2): every ray starts at a
 * voxel centre with the same direction, so the Amanatides-Woo walk is one constant table
 * (51 steps, spanning −14 x, −9 z, +28 y).
 */
const PATH: Int8Array[] = (() => {
	const len = Math.hypot(...SUN_DIR_RAW);
	const dx = SUN_DIR_RAW[0] / len, dy = SUN_DIR_RAW[1] / len, dz = SUN_DIR_RAW[2] / len;
	let ix = 0, iy = 0, iz = 0;
	const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
	const tdx = Math.abs(1 / dx), tdy = Math.abs(1 / dy), tdz = Math.abs(1 / dz);
	let tmx = (sx > 0 ? 1 - 0.5 : 0.5) * tdx, tmy = 0.5 * tdy, tmz = (sz > 0 ? 1 - 0.5 : 0.5) * tdz;
	const out: Int8Array[] = [];
	let t = 0;
	while (t < MAX_SHADOW_DIST) {
		if (tmx < tmy && tmx < tmz) { ix += sx; t = tmx; tmx += tdx; }
		else if (tmy < tmz) { iy += 1; t = tmy; tmy += tdy; }
		else { iz += sz; t = tmz; tmz += tdz; }
		out.push(Int8Array.of(ix, iy, iz));
	}
	return out;
})();

/** FNV-1a over the bytes of `sunlit`; lets neighbours re-mesh only when a chunk's shadows changed (§3.E). */
export function hashSunlit(sunlit: Uint8Array): number {
	let h = 2166136261 >>> 0;
	for (let i = 0; i < sunlit.length; i++) { h ^= sunlit[i]; h = Math.imul(h, 16777619) >>> 0; }
	return h;
}

/** §3.C.1 precondition: the 8 neighbours inside the world exist (generated + lit) before a chunk is shadowed. */
export function ensureShadowNeighbourhood(world: World, chunk: Chunk): void {
	for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
		if (dx === 0 && dz === 0) continue;
		if (world.chunkInWorld(chunk.cx + dx, chunk.cz + dz)) world.ensureChunk(chunk.cx + dx, chunk.cz + dz);
	}
}

/** Writes the highest opaque y of every column of `c` into the 48×48 heightmap at offset (gx0, gz0). */
function colMaxInto(c: Chunk, out: Int16Array, gx0: number, gz0: number): void {
	const b = c.blocks;
	for (let z = 0; z < CHUNK_SIZE_Z; z++) for (let x = 0; x < CHUNK_SIZE_X; x++) {
		let m = -1;
		for (let y = c.height - 1; y >= 0; y--) if (OPAQUE[b[indexOf(x, y, z)]]) { m = y; break; }
		out[(gz0 + z) * 48 + gx0 + x] = m;
	}
}

// Scratch buffers reused across calls (single-threaded per worker).
const COL = new Int16Array(48 * 48);
const START_MAX = new Int16Array(256);

/**
 * Requires the 3×3 neighbourhood to be present (world edge excepted — a ray leaving the world is
 * sunlit, deterministically). Under that precondition `sunlit` is a pure function of the 3×3's blocks.
 */
export function computeChunkShadows(world: World, chunk: Chunk): void {
	const H = chunk.height;
	const grid: (Chunk | undefined)[] = new Array(9);
	for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) grid[(dx + 1) * 3 + dz + 1] = world.getChunk(chunk.cx + dx, chunk.cz + dz);
	// 48×48 highest-opaque heightmap over the 3×3 (absent chunks stay -1).
	COL.fill(-1);
	let skyFrom = 0;
	for (let i = 0; i < 9; i++) { const c = grid[i]; if (!c) continue; colMaxInto(c, COL, Math.floor(i / 3) * 16, (i % 3) * 16); }
	for (let i = 0; i < COL.length; i++) if (COL[i] + 1 > skyFrom) skyFrom = COL[i] + 1;
	// Per-start-column early-out: startMax[x,z] = max_k(colMax[path_k(x,z)] − dy_k); a ray from
	// (x, y, z) with y > startMax can never reach an opaque voxel.
	for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
		let m = -1;
		for (let k = 0; k < PATH.length; k++) {
			const p = PATH[k]; const gx = 16 + x + p[0], gz = 16 + z + p[2];
			if (gx < 0 || gx >= 48 || gz < 0 || gz >= 48) break;
			const v = COL[gz * 48 + gx] - p[1]; if (v > m) m = v;
		}
		START_MAX[z * 16 + x] = m;
	}
	const sunlit = chunk.sunlit, blocks = chunk.blocks, lights = chunk.lights;
	for (let y = 0; y < H; y++) for (let z = 0; z < CHUNK_SIZE_Z; z++) for (let x = 0; x < CHUNK_SIZE_X; x++) {
		const idx = indexOf(x, y, z);
		// Opaque blocks: sunlit irrelevant (their faces aren't sampled from inside); set 0.
		if (OPAQUE[blocks[idx]]) { sunlit[idx] = 0; continue; }
		// No sky access at all: can't be in direct sun.
		if (((lights[idx] >> 12) & 0xf) === 0) { sunlit[idx] = 0; continue; }
		if (y >= skyFrom || y > START_MAX[z * 16 + x]) { sunlit[idx] = 1; continue; }
		SHADOW_STATS.rays++;
		let hit = 0;
		for (let k = 0; k < PATH.length; k++) {
			const p = PATH[k]; const wy = y + p[1]; if (wy >= H) break;
			const gx = x + p[0], gz = z + p[2];
			const c = grid[((gx >> 4) + 1) * 3 + (gz >> 4) + 1];
			if (!c) break; // world edge only (precondition) → sunlit
			if (OPAQUE[c.blocks[indexOf(gx & 15, wy, gz & 15)]]) { hit = 1; break; }
		}
		sunlit[idx] = hit ? 0 : 1;
	}
	chunk.shadowsDirty = false;
	chunk.sunlitHash = hashSunlit(sunlit);
}
