import { encodeChunk, BLOCKS_PER_CHUNK } from './codec';
import type { WorldSaveWire } from './schema';

export const FIXTURE_ID = '11111111-1111-4111-8111-111111111111';

export function chunkBlocks(fill: number): string {
	const b = new Uint16Array(BLOCKS_PER_CHUNK);
	b.fill(fill);
	return encodeChunk(b);
}

export function manyChunks(n: number, fill = 3) {
	return Array.from({ length: n }, (_, i) => ({
		cx: i % 32,
		cz: Math.floor(i / 32),
		blocks: chunkBlocks(fill),
	}));
}

export function validWire(over: Partial<WorldSaveWire> = {}): WorldSaveWire {
	return {
		version: 2,
		id: FIXTURE_ID,
		seed: 1234,
		name: 'Castle',
		createdAt: 1000,
		updatedAt: 2000,
		player: { x: 1.5, y: 60, z: -2.25, yaw: 0.5, pitch: -0.1, hotbar: [1, 2, 3], selected: 0 },
		chunks: manyChunks(1),
		...over,
	};
}
