import type { Chunk } from './chunk';
import type { WorldHeight } from './coords';
import { generateChunkV1, SEA_LEVEL_V1 } from './generation.v1';
import { generateChunkV2 } from './generation.v2';
import { generateChunkV3 } from './v3/generate';

/** Kept for callers of the old name; v1 sea level. */
export const SEA_LEVEL = SEA_LEVEL_V1;

export const NEWEST_GEN_VERSION = 3;

/** Consulted ONLY at world creation. A stored record's own `height` is authoritative afterwards. */
export function worldProfile(genVersion: number): { height: WorldHeight } {
	if (genVersion === 1) return { height: 64 };
	if (genVersion === 2) return { height: 256 };
	if (genVersion === 3) return { height: 256 };
	throw new RangeError(`Unknown generator version ${genVersion}`);
}

export function generateChunk(chunk: Chunk, seed: number, genVersion = 1): void {
	const { height } = worldProfile(genVersion);
	if (chunk.height !== height) throw new RangeError(`generator v${genVersion} needs a ${height}-high chunk, got ${chunk.height}`);
	if (genVersion === 1) generateChunkV1(chunk, seed);
	else if (genVersion === 2) generateChunkV2(chunk, seed);
	else generateChunkV3(chunk, seed);
}
