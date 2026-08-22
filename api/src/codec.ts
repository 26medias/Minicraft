import { deflate, inflate } from 'pako';
// Copied constant: the function deploys from api/ alone, so this file cannot
// import from the game source. api/src/codec.parity.test.ts asserts it matches.
export const BLOCKS_PER_CHUNK = 16 * 64 * 16;

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

export function encodeFluidMeta(map: Map<number, number>): string {
	if (map.size === 0) return '';
	const out: number[] = [];
	writeVarInt(out, map.size);
	for (const [idx, packed] of map) {
		writeVarInt(out, idx);
		out.push(packed & 0xff);
	}
	const deflated = deflate(new Uint8Array(out));
	return btoa(String.fromCharCode(...deflated));
}

export function decodeFluidMeta(encoded: string): Map<number, number> {
	const map = new Map<number, number>();
	if (encoded === '') return map;
	const bin = atob(encoded);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	const buf = inflate(bytes);
	let i = 0;
	const { value: count, next: afterCount } = readVarInt(buf, i);
	i = afterCount;
	for (let k = 0; k < count; k++) {
		const { value: idx, next } = readVarInt(buf, i);
		i = next;
		const packed = buf[i++];
		map.set(idx, packed);
	}
	return map;
}
