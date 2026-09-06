import { describe, it, expect } from 'vitest';
import { deflate, inflate } from 'pako';
import { encodeChunk, decodeChunk, encodeFluidMeta, decodeFluidMeta } from './codec';
import { BLOCKS_PER_CHUNK } from '../engine/world/coords';

describe('codec', () => {
	it('round-trips an empty chunk', () => {
		const blocks = new Uint16Array(BLOCKS_PER_CHUNK);
		const encoded = encodeChunk(blocks);
		const decoded = decodeChunk(encoded);
		expect(decoded).toEqual(blocks);
	});

	it('round-trips a striped chunk', () => {
		const blocks = new Uint16Array(BLOCKS_PER_CHUNK);
		for (let i = 0; i < BLOCKS_PER_CHUNK; i++) blocks[i] = i % 15;
		const encoded = encodeChunk(blocks);
		const decoded = decodeChunk(encoded);
		expect(decoded).toEqual(blocks);
	});

	it('is small on runs of one block', () => {
		const blocks = new Uint16Array(BLOCKS_PER_CHUNK);
		blocks.fill(3);
		const encoded = encodeChunk(blocks);
		expect(encoded.length).toBeLessThan(200);
	});

	it('round-trips ids above 255', () => {
		const blocks = new Uint16Array(BLOCKS_PER_CHUNK);
		[200, 255, 256, 353, 65535].forEach((v, i) => { blocks[i] = v; });
		blocks[5000] = 300;
		expect(decodeChunk(encodeChunk(blocks))).toEqual(blocks);
	});

	// Captured from the pre-16-bit codec: 100 × id 5, then id 0, one id 19 at 200, then 0.
	const LEGACY_B64 = 'eJxjTWFIEWZk2F4HAAf9Ahc=';
	const LEGACY_RLE = [5, 100, 0, 100, 19, 1, 0, 183, 126];

	function legacyBlocks(): Uint16Array {
		const b = new Uint16Array(BLOCKS_PER_CHUNK);
		for (let i = 0; i < 100; i++) b[i] = 5;
		b[200] = 19;
		return b;
	}

	it('decodes a chunk written by the old byte-value codec', () => {
		expect(decodeChunk(LEGACY_B64)).toEqual(legacyBlocks());
	});

	it('writes the same RLE byte stream as the old codec for ids below 128', () => {
		const bin = atob(encodeChunk(legacyBlocks()));
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		expect(Array.from(inflate(bytes))).toEqual(LEGACY_RLE);
	});

	// Each guard gets its own message-specific matcher: a bare toThrow() would be
	// satisfied by the pre-existing "wrong length" check and could not tell a
	// removed guard from a present one (the over-long run burns 240 ms before
	// that check fires, which is the DoS the guard exists to prevent).
	const b64 = (rle: number[]) => btoa(String.fromCharCode(...deflate(new Uint8Array(rle))));

	it('rejects a value above 0xffff before storing it', () => {
		// value 70000 = varint [0xf0, 0xa2, 0x04], run 16384 = [0x80, 0x80, 0x01]
		expect(() => decodeChunk(b64([0xf0, 0xa2, 0x04, 0x80, 0x80, 0x01]))).toThrow(/out of range/);
	});

	it('rejects a run that overruns the chunk before filling it', () => {
		// value 1, run 0x0ffffff0
		expect(() => decodeChunk(b64([1, 0xf0, 0xff, 0xff, 0x7f]))).toThrow(/overruns/);
	});

	it('rejects a varint longer than four bytes', () => {
		expect(() => decodeChunk(b64([0xff, 0xff, 0xff, 0xff, 0x7f, 1]))).toThrow(/varint too long/);
	});
});

describe('encode/decodeFluidMeta', () => {
	it('round-trips an empty map', () => {
		const map = new Map<number, number>();
		const enc = encodeFluidMeta(map);
		const dec = decodeFluidMeta(enc);
		expect(dec.size).toBe(0);
	});

	it('round-trips a small map', () => {
		const map = new Map<number, number>([
			[0, 0x80],
			[123, 0x83],
			[9999, 0x8f],
		]);
		const enc = encodeFluidMeta(map);
		const dec = decodeFluidMeta(enc);
		expect(dec.size).toBe(3);
		expect(dec.get(0)).toBe(0x80);
		expect(dec.get(123)).toBe(0x83);
		expect(dec.get(9999)).toBe(0x8f);
	});
});
