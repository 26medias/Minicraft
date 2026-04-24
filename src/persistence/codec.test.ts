import { describe, it, expect } from 'vitest';
import { encodeChunk, decodeChunk, encodeFluidMeta, decodeFluidMeta } from './codec';
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
