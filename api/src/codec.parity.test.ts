import { describe, it, expect } from 'vitest';
import {
	encodeChunk as clientEncode,
	encodeFluidMeta as clientEncodeFluid,
} from '../../src/persistence/codec';
import { decodeChunk, decodeFluidMeta, BLOCKS_PER_CHUNK } from './codec';

// The function deploys from api/ alone, so the codec is a copy rather than an
// import. These assert the copy has not drifted.
describe('codec parity', () => {
	it('server decodes what the client encodes', () => {
		const blocks = new Uint8Array(BLOCKS_PER_CHUNK);
		for (let i = 0; i < BLOCKS_PER_CHUNK; i++) blocks[i] = i % 19;
		expect(decodeChunk(clientEncode(blocks))).toEqual(blocks);
	});

	it('server decodes an empty chunk', () => {
		const blocks = new Uint8Array(BLOCKS_PER_CHUNK);
		expect(decodeChunk(clientEncode(blocks))).toEqual(blocks);
	});

	it('server decodes client fluidMeta', () => {
		const m = new Map<number, number>([
			[42, 0x82],
			[777, 0x84],
			[16383, 0x81],
		]);
		expect(decodeFluidMeta(clientEncodeFluid(m))).toEqual(m);
	});

	it('agrees that BLOCKS_PER_CHUNK is 16384', () => {
		expect(BLOCKS_PER_CHUNK).toBe(16384);
	});
});
