export const CHUNK_SIZE_X = 16;
export const CHUNK_SIZE_Z = 16;

/** The only two column heights that exist. 64 is every world saved before v3. */
export type WorldHeight = 64 | 256;
export const LEGACY_HEIGHT: WorldHeight = 64;

export function isWorldHeight(h: unknown): h is WorldHeight {
	return h === 64 || h === 256;
}

/** Fails closed: an undefined/NaN height must never size an array (that gives length 0). */
export function blocksPerChunk(height: number): number {
	if (!isWorldHeight(height)) throw new RangeError(`Unsupported world height: ${String(height)}`);
	return CHUNK_SIZE_X * height * CHUNK_SIZE_Z;
}

export const WORLD_CHUNKS_X = 32;
export const WORLD_CHUNKS_Z = 32;
export const WORLD_SIZE_X = CHUNK_SIZE_X * WORLD_CHUNKS_X;
export const WORLD_SIZE_Z = CHUNK_SIZE_Z * WORLD_CHUNKS_Z;

export function indexOf(x: number, y: number, z: number): number {
	return y * CHUNK_SIZE_X * CHUNK_SIZE_Z + z * CHUNK_SIZE_X + x;
}

export function worldToChunk(x: number, z: number): { cx: number; cz: number; lx: number; lz: number } {
	const cx = Math.floor(x / CHUNK_SIZE_X);
	const cz = Math.floor(z / CHUNK_SIZE_Z);
	const lx = ((x % CHUNK_SIZE_X) + CHUNK_SIZE_X) % CHUNK_SIZE_X;
	const lz = ((z % CHUNK_SIZE_Z) + CHUNK_SIZE_Z) % CHUNK_SIZE_Z;
	return { cx, cz, lx, lz };
}

export function inBounds(x: number, y: number, z: number, height: number): boolean {
	return x >= 0 && x < WORLD_SIZE_X && y >= 0 && y < height && z >= 0 && z < WORLD_SIZE_Z;
}

/** Flat chunk index; NO bounds check — callers that may be out of range use chunkIndexOrNeg. */
export function chunkIndex(cx: number, cz: number): number {
	return cx * WORLD_CHUNKS_Z + cz;
}

/** -1 when (cx, cz) is outside the world. An unguarded cx*32+cz aliases (1,-1) onto (0,31). */
export function chunkIndexOrNeg(cx: number, cz: number): number {
	if (cx < 0 || cx >= WORLD_CHUNKS_X || cz < 0 || cz >= WORLD_CHUNKS_Z) return -1;
	return cx * WORLD_CHUNKS_Z + cz;
}
