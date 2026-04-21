export const CHUNK_SIZE_X = 16;
export const CHUNK_SIZE_Y = 64;
export const CHUNK_SIZE_Z = 16;
export const BLOCKS_PER_CHUNK = CHUNK_SIZE_X * CHUNK_SIZE_Y * CHUNK_SIZE_Z;

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

export function inBounds(x: number, y: number, z: number): boolean {
	return (
		x >= 0 && x < WORLD_SIZE_X &&
		y >= 0 && y < CHUNK_SIZE_Y &&
		z >= 0 && z < WORLD_SIZE_Z
	);
}
