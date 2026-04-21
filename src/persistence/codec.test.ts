import { describe, it, expect } from 'vitest';
import { encodeChunk, decodeChunk } from './codec';
import { BLOCKS_PER_CHUNK } from '../engine/world/coords';

describe('codec', () => {
	it('round-trips an empty chunk', () => {
		const blocks = new Uint8Array(BLOCKS_PER_CHUNK);
		const encoded = encodeChunk(blocks);
		const decoded = decodeChunk(encoded);
		expect(decoded).toEqual(blocks);
	});

	it('round-trips a striped chunk', () => {
		const blocks = new Uint8Array(BLOCKS_PER_CHUNK);
		for (let i = 0; i < BLOCKS_PER_CHUNK; i++) blocks[i] = i % 15;
		const encoded = encodeChunk(blocks);
		const decoded = decodeChunk(encoded);
		expect(decoded).toEqual(blocks);
	});

	it('is small on runs of one block', () => {
		const blocks = new Uint8Array(BLOCKS_PER_CHUNK);
		blocks.fill(3);
		const encoded = encodeChunk(blocks);
		expect(encoded.length).toBeLessThan(200);
	});
});
