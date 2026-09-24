import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateRaw, deflateRaw } from 'pako';
import { decodeSnapshot, encodeSnapshot, SnapshotError } from './snapshot';
import { colorToInt, type Op } from './protocol';

const GO_TESTDATA = 'server/internal/proto/testdata';
const TS_TESTDATA = 'src/net/testdata';
// `MC_UPDATE_FIXTURES=1 npx vitest run src/net/` rewrites src/net/testdata/ts-ops.{bin,json}.
const UPDATE = process.env.MC_UPDATE_FIXTURES === '1';

type SnapshotJSON = { seq: number; cells: Op[] };

function toArrayBuffer(b: Uint8Array): ArrayBuffer {
	return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

function readBin(path: string): ArrayBuffer {
	return toArrayBuffer(readFileSync(path));
}

function rows(cells: Int32Array): Op[] {
	const out: Op[] = [];
	for (let i = 0; i < cells.length; i += 6) out.push(Array.from(cells.subarray(i, i + 6)) as Op);
	return out;
}

function header(seq: number, count: number): Uint8Array {
	const h = new Uint8Array(8);
	const v = new DataView(h.buffer);
	v.setUint32(0, seq, true);
	v.setUint32(4, count, true);
	return h;
}

function concat(a: Uint8Array, b: Uint8Array): ArrayBuffer {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out.buffer;
}

/** The inflated row bytes of a snapshot (the part both encoders must agree on exactly). */
function body(buf: ArrayBuffer): Uint8Array {
	return inflateRaw(new Uint8Array(buf, 8));
}

function sortKey(a: Op, b: Op): number {
	return a[0] - b[0] || a[2] - b[2] || a[1] - b[1];
}

describe('T1: decode the Go fixture snapshot-small', () => {
	const json = JSON.parse(readFileSync(`${GO_TESTDATA}/snapshot-small.json`, 'utf8')) as SnapshotJSON;
	const bin = readBin(`${GO_TESTDATA}/snapshot-small.bin`);

	it('decodeSnapshot(snapshot-small.bin) equals snapshot-small.json', () => {
		const { seq, cells } = decodeSnapshot(bin);
		expect(cells).toBeInstanceOf(Int32Array);
		expect(seq).toBe(json.seq);
		expect(cells.length).toBe(json.cells.length * 6);
		expect(rows(cells)).toEqual(json.cells);
	});

	it('the fixture exercises the edge values the format must carry', () => {
		const all = json.cells;
		expect(all.some((c) => c[0] === 0 && c[1] === 0 && c[2] === 0)).toBe(true); // origin: dy = 1
		expect(all.some((c) => c[4] === 0x80)).toBe(true);
		expect(all.some((c) => c[4] === 0x83)).toBe(true);
		expect(all.some((c) => c[5] === 0x1fff5e0)).toBe(true);
		expect(all.some((c) => c[1] === 255)).toBe(true);
		expect(all.some((c) => c[0] === 511)).toBe(true);
	});

	it('TS encodeSnapshot of the JSON decodes to the same cells', () => {
		const buf = encodeSnapshot(json.seq, json.cells.flat());
		const { seq, cells } = decodeSnapshot(buf);
		expect(seq).toBe(json.seq);
		expect(rows(cells)).toEqual(json.cells);
	});

	it('TS and Go produce byte-identical rows before DEFLATE', () => {
		const ts = body(encodeSnapshot(json.seq, json.cells.flat()));
		expect(Array.from(ts)).toEqual(Array.from(body(bin)));
		// The 8-byte header is uncompressed and identical too.
		expect(Array.from(new Uint8Array(encodeSnapshot(json.seq, json.cells.flat()), 0, 8))).toEqual(
			Array.from(new Uint8Array(bin, 0, 8)),
		);
	});

	it('the encoder sorts its input by (x, z, y) and does not modify it', () => {
		const shuffled = [...json.cells].reverse();
		const flat = Int32Array.from(shuffled.flat());
		const copy = Int32Array.from(flat);
		const { cells } = decodeSnapshot(encodeSnapshot(json.seq, flat));
		expect(rows(cells)).toEqual(json.cells);
		expect(flat).toEqual(copy);
	});
});

/**
 * ts-ops: a TS-encoded snapshot that the Go test TestDecodeTSFixture decodes and compares with
 * ts-ops.json. The cells reuse the ops Go wrote to ops-roundtrip.json, plus rows that hit every
 * branch of the row coding (dx > 0, dz > 0, dy ≥ 1, the origin, the far corner).
 */
function tsOpsCells(): Op[] {
	const go = JSON.parse(readFileSync(`${GO_TESTDATA}/ops-roundtrip.json`, 'utf8')) as { ops: Op[] };
	const extra: Op[] = [
		[0, 1, 0, 1, 0, 0],
		[0, 2, 0, 2, 0x80, 0],
		[0, 7, 9, 3, 0x8f, 0],
		[7, 5, 3, 0, 0, colorToInt('#000000')],
		[7, 6, 3, 1000, 0, colorToInt('#FFF5E0')],
		[7, 200, 300, 12, 0x81, 0],
		[400, 128, 0, 5, 0, 0],
		[511, 0, 511, 7, 0, 0],
	];
	return [...go.ops, ...extra].sort(sortKey);
}

describe('T1: the TS-encoded fixture ts-ops.bin (decoded by Go TestDecodeTSFixture)', () => {
	const cells = tsOpsCells();
	const seq = 0x7fff_fffe;
	const buf = encodeSnapshot(seq, cells.flat());

	if (UPDATE) {
		mkdirSync(TS_TESTDATA, { recursive: true });
		writeFileSync(`${TS_TESTDATA}/ts-ops.bin`, new Uint8Array(buf));
		writeFileSync(`${TS_TESTDATA}/ts-ops.json`, JSON.stringify({ seq, cells }, null, '\t') + '\n');
	}

	it('the committed ts-ops.bin is what the TS encoder writes today', () => {
		const committed = new Uint8Array(readBin(`${TS_TESTDATA}/ts-ops.bin`));
		expect(Array.from(committed)).toEqual(Array.from(new Uint8Array(buf)));
		const json = JSON.parse(readFileSync(`${TS_TESTDATA}/ts-ops.json`, 'utf8')) as SnapshotJSON;
		expect(json).toEqual({ seq, cells });
	});

	it('decodes back to the same cells', () => {
		const out = decodeSnapshot(readBin(`${TS_TESTDATA}/ts-ops.bin`));
		expect(out.seq).toBe(seq);
		expect(rows(out.cells)).toEqual(cells);
	});
});

describe('snapshot codec', () => {
	it('round-trips 1,000 random unique cells', () => {
		let s = 12345;
		const rnd = (n: number) => {
			s = (Math.imul(s, 1103515245) + 12345) >>> 0;
			// High bits: an LCG mod 2^32 has short-period low bits, so `s % n` cycles too soon.
			return Math.floor((s / 0x100000000) * n);
		};
		const seen = new Set<string>();
		const cells: Op[] = [];
		while (cells.length < 1000) {
			const c: Op = [rnd(512), rnd(256), rnd(512), rnd(1009), rnd(4) ? 0 : 0x80 | rnd(16), rnd(3) ? 0 : 0x1000000 | rnd(0x1000000)];
			const k = `${c[0]},${c[1]},${c[2]}`;
			if (seen.has(k)) continue;
			seen.add(k);
			cells.push(c);
		}
		const { seq, cells: out } = decodeSnapshot(encodeSnapshot(77, cells.flat()));
		expect(seq).toBe(77);
		expect(rows(out)).toEqual([...cells].sort(sortKey));
	});

	it('an empty snapshot is 8 header bytes plus an empty DEFLATE body', () => {
		const buf = encodeSnapshot(5, []);
		expect(new DataView(buf).getUint32(0, true)).toBe(5);
		expect(new DataView(buf).getUint32(4, true)).toBe(0);
		const { seq, cells } = decodeSnapshot(buf);
		expect(seq).toBe(5);
		expect(cells.length).toBe(0);
	});

	it('seq uses the full u32 range', () => {
		const { seq } = decodeSnapshot(encodeSnapshot(0xffffffff, [[1, 2, 3, 4, 0, 0]].flat()));
		expect(seq).toBe(0xffffffff);
	});
});

describe('decodeSnapshot rejects malformed input', () => {
	const good = encodeSnapshot(1, [[1, 2, 3, 4, 0, 0], [1, 3, 3, 5, 0, 0]].flat());
	const goodRows = body(good);

	it('a short header', () => {
		expect(() => decodeSnapshot(new ArrayBuffer(7))).toThrow(SnapshotError);
	});

	it('a body that is not raw DEFLATE', () => {
		expect(() => decodeSnapshot(concat(header(1, 1), new Uint8Array([0xff, 0xff, 0xff, 0xff])))).toThrow(
			SnapshotError,
		);
	});

	it('a truncated row', () => {
		const rowsBytes = goodRows.subarray(0, goodRows.length - 1);
		const buf = concat(header(1, 2), deflateRawBytes(rowsBytes));
		expect(() => decodeSnapshot(buf)).toThrow(SnapshotError);
	});

	it('data after count rows', () => {
		const buf = concat(header(1, 1), deflateRawBytes(goodRows));
		expect(() => decodeSnapshot(buf)).toThrow(/data after/);
	});

	it('a repeated cell (dy = 0)', () => {
		// Row 1: dx=1 z=3 y=2 id=4 fluid=0 color=0; row 2: dx=0 dz=0 dy=0 ...
		const r = new Uint8Array([1, 3, 2, 4, 0, 0, 0, 0, 0, 5, 0, 0]);
		expect(() => decodeSnapshot(concat(header(1, 2), deflateRawBytes(r)))).toThrow(/repeats/);
	});

	it('a value that overflows int32', () => {
		// dx = 2^31 as a varint: 0x80 0x80 0x80 0x80 0x08.
		const r = new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x08, 0, 0, 0, 0, 0]);
		expect(() => decodeSnapshot(concat(header(1, 1), deflateRawBytes(r)))).toThrow(/overflow/);
	});

	// Gate-2 (S): a count larger than remainingBytes / 6 is rejected before anything is allocated.
	// Each row is at least 6 one-byte varints, so a larger count cannot be honest.
	it('a count larger than the body can hold (u32 max) is refused before allocating', () => {
		expect(() => decodeSnapshot(concat(header(1, 0xffffffff), deflateRawBytes(goodRows)))).toThrow(
			/count/,
		);
	});

	it('a count of 1,000,000 over a 12-byte body is refused on the count, not on truncation', () => {
		expect(goodRows.length).toBe(12);
		let err: unknown;
		try {
			decodeSnapshot(concat(header(1, 1_000_000), deflateRawBytes(goodRows)));
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(SnapshotError);
		expect((err as Error).message).toMatch(/count 1000000 .*12 bytes/);
	});

	it('count × 6 exactly equal to the body is still accepted when the rows are honest', () => {
		// 2 rows of 6 one-byte varints each = 12 bytes: the bound is inclusive.
		const { cells } = decodeSnapshot(good);
		expect(rows(cells)).toEqual([
			[1, 2, 3, 4, 0, 0],
			[1, 3, 3, 5, 0, 0],
		]);
	});
});

function deflateRawBytes(b: Uint8Array): Uint8Array {
	return deflateRaw(b);
}
