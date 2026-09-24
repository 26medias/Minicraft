/**
 * Snapshot codec (spec §5, normative). Mirrors `server/internal/proto/snapshot.go`.
 *
 *   header  u32le seq, u32le count          (8 bytes, uncompressed)
 *   body    raw DEFLATE of count rows, sorted by (x, z, y)
 *
 * Each row is unsigned LEB128 varints, delta-coded against the previous row; prev starts at
 * (0, 0, -1) so a first row at the origin still has dy = 1:
 *
 *   dx = x - prevX                → uvarint(dx)
 *   if dx > 0:                    → uvarint(z), uvarint(y)
 *   else: dz = z - prevZ          → uvarint(dz)
 *         if dz > 0:              → uvarint(y)
 *         else:                   → uvarint(y - prevY)   (≥ 1: rows are unique)
 *   then uvarint(id), uvarint(fluid), uvarint(color)
 */
import { deflateRaw, inflateRaw } from 'pako';

const HEADER = 8;
/** Every row is at least six one-byte varints. */
const MIN_ROW_BYTES = 6;
const INT32_MAX = 0x7fffffff;

export class SnapshotError extends Error {
	constructor(message: string) {
		super(`malformed snapshot: ${message}`);
		this.name = 'SnapshotError';
	}
}

/**
 * Decodes a snapshot frame. `cells` is flat, six numbers per cell:
 * `[x, y, z, id, fluid, color, …]`, in (x, z, y) order.
 */
export function decodeSnapshot(buf: ArrayBuffer): { seq: number; cells: Int32Array } {
	if (buf.byteLength < HEADER) throw new SnapshotError(`${buf.byteLength}-byte header`);
	const view = new DataView(buf);
	const seq = view.getUint32(0, true);
	const count = view.getUint32(4, true);

	let rows: Uint8Array;
	try {
		rows = inflateRaw(new Uint8Array(buf, HEADER));
	} catch (e) {
		throw new SnapshotError(`body is not raw DEFLATE (${(e as Error).message ?? e})`);
	}
	if (!(rows instanceof Uint8Array)) throw new SnapshotError('body is not raw DEFLATE');

	// Gate-2 (S): refuse a count the body cannot hold before allocating for it.
	if (count > rows.length / MIN_ROW_BYTES) {
		throw new SnapshotError(`count ${count} exceeds what ${rows.length} bytes can hold`);
	}

	const cells = new Int32Array(count * 6);
	let pos = 0;
	let row = 0;
	const next = (): number => {
		let v = 0;
		let mul = 1;
		for (let i = 0; ; i++) {
			if (pos >= rows.length) throw new SnapshotError(`row ${row}: truncated`);
			if (i >= 5) throw new SnapshotError(`row ${row}: varint overflow`);
			const b = rows[pos++];
			v += (b & 0x7f) * mul;
			if (b < 0x80) break;
			mul *= 128;
		}
		if (v > INT32_MAX) throw new SnapshotError(`row ${row}: value ${v} overflows int32`);
		return v;
	};

	let px = 0;
	let pz = 0;
	let py = -1;
	for (; row < count; row++) {
		let y: number;
		let z: number;
		const dx = next();
		const x = px + dx;
		if (dx > 0) {
			z = next();
			y = next();
		} else {
			const dz = next();
			z = pz + dz;
			if (dz > 0) {
				y = next();
			} else {
				const dy = next();
				if (dy === 0) throw new SnapshotError(`row ${row} repeats a cell`);
				y = py + dy;
			}
		}
		if (x > INT32_MAX || y > INT32_MAX || z > INT32_MAX) {
			throw new SnapshotError(`row ${row} coordinate overflow`);
		}
		const o = row * 6;
		cells[o] = x;
		cells[o + 1] = y;
		cells[o + 2] = z;
		cells[o + 3] = next();
		cells[o + 4] = next();
		cells[o + 5] = next();
		px = x;
		pz = z;
		py = y;
	}
	if (pos !== rows.length) throw new SnapshotError(`data after ${count} rows`);
	return { seq, cells };
}

function pushUvarint(out: number[], v: number): void {
	if (!Number.isInteger(v) || v < 0 || v > INT32_MAX) {
		throw new RangeError(`encodeSnapshot: value ${v} is not a non-negative int32`);
	}
	while (v >= 0x80) {
		out.push((v & 0x7f) | 0x80);
		v = Math.floor(v / 128);
	}
	out.push(v);
}

/**
 * Encodes cells (flat, six numbers per cell, unique by (x, y, z), any order) as of `seq`.
 * Tests only: the server is the one that sends snapshots. The input is not modified.
 */
export function encodeSnapshot(seq: number, cells: ArrayLike<number>): ArrayBuffer {
	if (cells.length % 6 !== 0) throw new RangeError('encodeSnapshot: cells length is not a multiple of 6');
	const n = cells.length / 6;
	const order = Array.from({ length: n }, (_, i) => i * 6);
	order.sort((a, b) => cells[a] - cells[b] || cells[a + 2] - cells[b + 2] || cells[a + 1] - cells[b + 1]);

	const rows: number[] = [];
	let px = 0;
	let pz = 0;
	let py = -1;
	for (const o of order) {
		const x = cells[o];
		const y = cells[o + 1];
		const z = cells[o + 2];
		const dx = x - px;
		pushUvarint(rows, dx);
		if (dx > 0) {
			pushUvarint(rows, z);
			pushUvarint(rows, y);
		} else {
			const dz = z - pz;
			pushUvarint(rows, dz);
			pushUvarint(rows, dz > 0 ? y : y - py);
		}
		pushUvarint(rows, cells[o + 3]);
		pushUvarint(rows, cells[o + 4]);
		pushUvarint(rows, cells[o + 5]);
		px = x;
		pz = z;
		py = y;
	}

	const body = deflateRaw(Uint8Array.from(rows), { level: 6 });
	const out = new Uint8Array(HEADER + body.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, seq >>> 0, true);
	view.setUint32(4, n, true);
	out.set(body, HEADER);
	return out.buffer;
}
