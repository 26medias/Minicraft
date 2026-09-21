import { describe, it, expect } from 'vitest';
import {
	encodeChunk as clientEncode,
	encodeFluidMeta as clientEncodeFluid,
} from '../../src/persistence/codec';
import { decodeChunk, decodeFluidMeta, LEGACY_BLOCKS_PER_CHUNK } from './codec';

// The function deploys from api/ alone, so the codec is a copy rather than an
// import. These assert the copy has not drifted, at both chunk lengths.
for (const N of [16384, 65536] as const) {
	describe(`codec parity at ${N}`, () => {
		it('server decodes what the client encodes', () => {
			const blocks = new Uint16Array(N);
			for (let i = 0; i < N; i++) blocks[i] = i % 19;
			expect(decodeChunk(clientEncode(blocks, N), N)).toEqual(blocks);
		});

		it('server decodes an empty chunk', () => {
			const blocks = new Uint16Array(N);
			expect(decodeChunk(clientEncode(blocks, N), N)).toEqual(blocks);
		});

		it('server decodes ids above 255 from the client', () => {
			const blocks = new Uint16Array(N);
			[200, 255, 256, 353, 65535].forEach((v, i) => { blocks[i] = v; });
			blocks[N - 1] = 353;
			expect(decodeChunk(clientEncode(blocks, N), N)).toEqual(blocks);
		});
	});
}

describe('codec parity', () => {
	it('server decodes a legacy byte-codec chunk identically', () => {
		const b = new Uint16Array(16384);
		for (let i = 0; i < 100; i++) b[i] = 5;
		b[200] = 19;
		expect(decodeChunk('eJxjTWFIEWZk2F4HAAf9Ahc=', 16384)).toEqual(b);
	});

	it('server decodes client fluidMeta', () => {
		const m = new Map<number, number>([
			[42, 0x82],
			[777, 0x84],
			[16383, 0x81],
		]);
		expect(decodeFluidMeta(clientEncodeFluid(m))).toEqual(m);
	});

	it('legacy length is 16384', () => expect(LEGACY_BLOCKS_PER_CHUNK).toBe(16384));
});
