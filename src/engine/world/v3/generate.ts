import type { Chunk } from '../chunk';
import { V3 } from './blocks';
/** STUB until Task 3: bedrock + stone to y 120 so the v3 dispatcher branch compiles and runs. */
export function generateChunkV3(chunk: Chunk, _seed: number): void {
	for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
		chunk.blocks[lz * 16 + lx] = V3.bedrock;
		for (let y = 1; y <= 120; y++) chunk.blocks[y * 256 + lz * 16 + lx] = V3.stone;
	}
	chunk.dirty = true; chunk.modified = false;
}
