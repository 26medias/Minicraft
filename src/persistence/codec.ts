import { deflate, inflate } from 'pako';
import { BLOCKS_PER_CHUNK } from '../engine/world/coords';

export function encodeChunk(blocks: Uint8Array): string {
	if (blocks.length !== BLOCKS_PER_CHUNK) throw new Error('Unexpected chunk length');
	const rle: number[] = [];
	let i = 0;
	while (i < blocks.length) {
		const val = blocks[i];
		let run = 1;
		while (i + run < blocks.length && blocks[i + run] === val && run < 0x0fffffff) run++;
		rle.push(val);
		writeVarInt(rle, run);
		i += run;
	}
	const deflated = deflate(new Uint8Array(rle));
	return btoa(String.fromCharCode(...deflated));
}

export function decodeChunk(encoded: string): Uint8Array {
	const bin = atob(encoded);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	const rle = inflate(bytes);
	const out = new Uint8Array(BLOCKS_PER_CHUNK);
	let oi = 0,
		ri = 0;
	while (ri < rle.length) {
		const val = rle[ri++];
		const { value: run, next } = readVarInt(rle, ri);
		ri = next;
		for (let k = 0; k < run; k++) out[oi++] = val;
	}
	if (oi !== BLOCKS_PER_CHUNK) throw new Error(`Decoded chunk has wrong length: ${oi}`);
	return out;
}

function writeVarInt(out: number[], v: number) {
	while (v >= 0x80) {
		out.push((v & 0x7f) | 0x80);
		v >>>= 7;
	}
	out.push(v & 0x7f);
}

function readVarInt(src: Uint8Array, i: number): { value: number; next: number } {
	let v = 0,
		shift = 0;
	while (true) {
		const b = src[i++];
		v |= (b & 0x7f) << shift;
		if ((b & 0x80) === 0) break;
		shift += 7;
	}
	return { value: v, next: i };
}
