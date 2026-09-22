import type { BlockId, Face } from '../../data/blocks.data';
import { BLOCKS, isLiquid, isSolid, isTranslucent, isTransparent } from '../../data/blocks.data';
import type { Chunk } from './chunk';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z, indexOf } from './coords';

export type ChunkMesh = {
	positions: Float32Array;
	normals: Float32Array;
	uvs: Float32Array;
	colors: Float32Array;
	indices: Uint32Array;
};

export type ChunkMeshResult = {
	opaque: ChunkMesh;
	liquid: ChunkMesh | null;
	translucent: ChunkMesh | null;
};

export type UvFn = (id: BlockId, face: Face) => [number, number, number, number];

export type Neighbors = { px?: Chunk; nx?: Chunk; pz?: Chunk; nz?: Chunk };

const SKY_COLOR: [number, number, number] = [0.9, 0.95, 1.0];
const MIN_AMBIENT = 0.03;
const SHADOW_FLOOR = 0.5;

// Per-face constant data: normal, direction offset, 4 corner offsets (positions within a unit cube),
// and 4 per-corner UV selectors ([uIndex, vIndex] where 0 picks u0/v0, 1 picks u1/v1).
// Winding: CCW when viewed from outside the cube, so front-faces point outward.
const FACES: Record<
	Face,
	{
		normal: [number, number, number];
		corners: [number, number, number][];
		uvs: [0 | 1, 0 | 1][];
		dx: number;
		dy: number;
		dz: number;
	}
> = {
	px: {
		normal: [1, 0, 0],
		dx: 1,
		dy: 0,
		dz: 0,
		corners: [
			[1, 0, 1],
			[1, 0, 0],
			[1, 1, 0],
			[1, 1, 1],
		],
		// Side face: world y=0 -> v0 (tile bottom), world y=1 -> v1 (tile top).
		uvs: [
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1],
		],
	},
	nx: {
		normal: [-1, 0, 0],
		dx: -1,
		dy: 0,
		dz: 0,
		corners: [
			[0, 0, 0],
			[0, 0, 1],
			[0, 1, 1],
			[0, 1, 0],
		],
		uvs: [
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1],
		],
	},
	py: {
		normal: [0, 1, 0],
		dx: 0,
		dy: 1,
		dz: 0,
		corners: [
			[0, 1, 1],
			[1, 1, 1],
			[1, 1, 0],
			[0, 1, 0],
		],
		// Top face: preserves the historical orientation (relevant for directional tiles like oak_log_top).
		uvs: [
			[0, 1],
			[1, 1],
			[1, 0],
			[0, 0],
		],
	},
	ny: {
		normal: [0, -1, 0],
		dx: 0,
		dy: -1,
		dz: 0,
		corners: [
			[0, 0, 0],
			[1, 0, 0],
			[1, 0, 1],
			[0, 0, 1],
		],
		uvs: [
			[0, 1],
			[1, 1],
			[1, 0],
			[0, 0],
		],
	},
	pz: {
		normal: [0, 0, 1],
		dx: 0,
		dy: 0,
		dz: 1,
		corners: [
			[0, 0, 1],
			[1, 0, 1],
			[1, 1, 1],
			[0, 1, 1],
		],
		uvs: [
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1],
		],
	},
	nz: {
		normal: [0, 0, -1],
		dx: 0,
		dy: 0,
		dz: -1,
		corners: [
			[1, 0, 0],
			[0, 0, 0],
			[0, 1, 0],
			[1, 1, 0],
		],
		uvs: [
			[0, 0],
			[1, 0],
			[1, 1],
			[0, 1],
		],
	},
};

const FACE_ORDER: Face[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

// ---------------------------------------------------------------------------
// Module-level precomputed tables (built once at load; no per-corner objects).
// ---------------------------------------------------------------------------

/** Flat per-face constants, indexed by position in FACE_ORDER. */
const FACE_NORMAL = new Int8Array(6 * 3);
const FACE_DIR = new Int8Array(6 * 3);
const FACE_CORNER = new Int8Array(6 * 4 * 3);
const FACE_UVSEL = new Int8Array(6 * 4 * 2);

/**
 * AO / light / shadow sampling pattern per face: the 4 voxels on the OUTWARD side of a
 * corner, each as (dx, dy, dz, kind) with dx/dy/dz in {-1, 0} relative to the corner and
 * kind 0 = face, 1 = edge, 2 = diag (how many non-normal axes are shifted by -1).
 * The same 4 offsets feed sampleCornerLight and sampleCornerShadow (identical filter).
 */
const AO_PATTERN: Int8Array[] = [];

for (let fi = 0; fi < 6; fi++) {
	const f = FACES[FACE_ORDER[fi]];
	FACE_NORMAL[fi * 3] = f.normal[0];
	FACE_NORMAL[fi * 3 + 1] = f.normal[1];
	FACE_NORMAL[fi * 3 + 2] = f.normal[2];
	FACE_DIR[fi * 3] = f.dx;
	FACE_DIR[fi * 3 + 1] = f.dy;
	FACE_DIR[fi * 3 + 2] = f.dz;
	for (let i = 0; i < 4; i++) {
		FACE_CORNER[(fi * 4 + i) * 3] = f.corners[i][0];
		FACE_CORNER[(fi * 4 + i) * 3 + 1] = f.corners[i][1];
		FACE_CORNER[(fi * 4 + i) * 3 + 2] = f.corners[i][2];
		FACE_UVSEL[(fi * 4 + i) * 2] = f.uvs[i][0];
		FACE_UVSEL[(fi * 4 + i) * 2 + 1] = f.uvs[i][1];
	}
	const nx = f.normal[0],
		ny = f.normal[1],
		nz = f.normal[2];
	const axisNormal = Math.abs(nx) > 0 ? 0 : Math.abs(ny) > 0 ? 1 : 2;
	const pat = new Int8Array(4 * 4);
	let k = 0;
	for (let dx = -1; dx <= 0; dx++) {
		for (let dy = -1; dy <= 0; dy++) {
			for (let dz = -1; dz <= 0; dz++) {
				// Keep voxels on the OUTWARD side of the face.
				if (nx === 1 && dx !== 0) continue;
				if (nx === -1 && dx !== -1) continue;
				if (ny === 1 && dy !== 0) continue;
				if (ny === -1 && dy !== -1) continue;
				if (nz === 1 && dz !== 0) continue;
				if (nz === -1 && dz !== -1) continue;
				let shiftedNonNormal = 0;
				if (axisNormal !== 0 && dx === -1) shiftedNonNormal++;
				if (axisNormal !== 1 && dy === -1) shiftedNonNormal++;
				if (axisNormal !== 2 && dz === -1) shiftedNonNormal++;
				pat[k * 4] = dx;
				pat[k * 4 + 1] = dy;
				pat[k * 4 + 2] = dz;
				pat[k * 4 + 3] = shiftedNonNormal; // 0 face, 1 edge, 2 diag
				k++;
			}
		}
	}
	AO_PATTERN.push(pat);
}

/** 1 when the block fully blocks light and is not a liquid (the AO occluder test). */
const OPAQUE = new Uint8Array(BLOCKS.length);
for (let id = 0; id < BLOCKS.length; id++) {
	const def = BLOCKS[id];
	OPAQUE[id] = def && def.lightFilter >= 15 && def.liquid === 'none' ? 1 : 0;
}

/** Growable typed buffer; reset per mesh pass, copied out once at the end. */
class GrowBuf {
	f32: Float32Array;
	len = 0;
	constructor(initial: number) {
		this.f32 = new Float32Array(initial);
	}
	reset(): void {
		this.len = 0;
	}
	private grow(need: number): void {
		let cap = this.f32.length;
		while (cap < need) cap *= 2;
		const next = new Float32Array(cap);
		next.set(this.f32.subarray(0, this.len));
		this.f32 = next;
	}
	push2(a: number, b: number): void {
		if (this.len + 2 > this.f32.length) this.grow(this.len + 2);
		const buf = this.f32;
		buf[this.len] = a;
		buf[this.len + 1] = b;
		this.len += 2;
	}
	push3(a: number, b: number, c: number): void {
		if (this.len + 3 > this.f32.length) this.grow(this.len + 3);
		const buf = this.f32;
		buf[this.len] = a;
		buf[this.len + 1] = b;
		buf[this.len + 2] = c;
		this.len += 3;
	}
	toFloat32(): Float32Array {
		return new Float32Array(this.f32.subarray(0, this.len));
	}
}

class GrowBufU32 {
	u32: Uint32Array;
	len = 0;
	constructor(initial: number) {
		this.u32 = new Uint32Array(initial);
	}
	reset(): void {
		this.len = 0;
	}
	private grow(need: number): void {
		let cap = this.u32.length;
		while (cap < need) cap *= 2;
		const next = new Uint32Array(cap);
		next.set(this.u32.subarray(0, this.len));
		this.u32 = next;
	}
	pushQuad(v: number): void {
		if (this.len + 6 > this.u32.length) this.grow(this.len + 6);
		const buf = this.u32;
		buf[this.len] = v;
		buf[this.len + 1] = v + 1;
		buf[this.len + 2] = v + 2;
		buf[this.len + 3] = v;
		buf[this.len + 4] = v + 2;
		buf[this.len + 5] = v + 3;
		this.len += 6;
	}
	toUint32(): Uint32Array {
		return new Uint32Array(this.u32.subarray(0, this.len));
	}
}

type MeshBufs = {
	positions: GrowBuf;
	normals: GrowBuf;
	uvs: GrowBuf;
	colors: GrowBuf;
	indices: GrowBufU32;
	vcount: number;
};

function makeBufs(): MeshBufs {
	return {
		positions: new GrowBuf(4096 * 3),
		normals: new GrowBuf(4096 * 3),
		uvs: new GrowBuf(4096 * 2),
		colors: new GrowBuf(4096 * 3),
		indices: new GrowBufU32(4096 * 6 / 4),
		vcount: 0,
	};
}

function resetBufs(b: MeshBufs): void {
	b.positions.reset();
	b.normals.reset();
	b.uvs.reset();
	b.colors.reset();
	b.indices.reset();
	b.vcount = 0;
}

function bufsToMesh(b: MeshBufs): ChunkMesh {
	return {
		positions: b.positions.toFloat32(),
		normals: b.normals.toFloat32(),
		uvs: b.uvs.toFloat32(),
		colors: b.colors.toFloat32(),
		indices: b.indices.toUint32(),
	};
}

// Three independent scratch sets: opaque, translucent and liquid passes never share.
const OPAQUE_BUFS = makeBufs();
const TRANSLUCENT_BUFS = makeBufs();
const LIQUID_BUFS = makeBufs();

// ---------------------------------------------------------------------------
// Voxel reads (unchanged logic; no allocation).
// ---------------------------------------------------------------------------

function neighborBlock(
	chunk: Chunk,
	neighbors: Neighbors,
	x: number,
	y: number,
	z: number,
): BlockId {
	if (y < 0 || y >= chunk.height) return 0;
	if (x >= 0 && x < CHUNK_SIZE_X && z >= 0 && z < CHUNK_SIZE_Z) {
		return chunk.get(x, y, z);
	}
	if (x >= CHUNK_SIZE_X) return neighbors.px?.get(0, y, z) ?? 0;
	if (x < 0) return neighbors.nx?.get(CHUNK_SIZE_X - 1, y, z) ?? 0;
	if (z >= CHUNK_SIZE_Z) return neighbors.pz?.get(x, y, 0) ?? 0;
	if (z < 0) return neighbors.nz?.get(x, y, CHUNK_SIZE_Z - 1) ?? 0;
	return 0;
}

function shouldEmitFace(here: BlockId, there: BlockId): boolean {
	if (!isSolid(here)) return false;
	if (!isSolid(there)) return true;
	// solid vs solid: emit only if the neighbor is transparent AND different block (prevents glass-glass hairlines)
	if (isTransparent(there) && there !== here) return true;
	return false;
}

/**
 * Packed light word (sky<<12 | r<<8 | g<<4 | b) for a voxel, or 0 when the voxel is
 * out of range / in an absent or diagonal neighbour. Same resolution rules as before.
 */
function readLightWord(
	chunk: Chunk,
	neighbors: Neighbors,
	x: number,
	y: number,
	z: number,
): number {
	if (y < 0 || y >= chunk.height) return 0;
	const inX = x >= 0 && x < CHUNK_SIZE_X;
	const inZ = z >= 0 && z < CHUNK_SIZE_Z;
	if (inX && inZ) return chunk.lights[indexOf(x, y, z)];
	if (x >= CHUNK_SIZE_X && inZ) {
		const t = neighbors.px;
		return t ? t.lights[indexOf(0, y, z)] : 0;
	}
	if (x < 0 && inZ) {
		const t = neighbors.nx;
		return t ? t.lights[indexOf(CHUNK_SIZE_X - 1, y, z)] : 0;
	}
	if (z >= CHUNK_SIZE_Z && inX) {
		const t = neighbors.pz;
		return t ? t.lights[indexOf(x, y, 0)] : 0;
	}
	if (z < 0 && inX) {
		const t = neighbors.nz;
		return t ? t.lights[indexOf(x, y, CHUNK_SIZE_Z - 1)] : 0;
	}
	// True diagonal (both axes OOB): 0.
	return 0;
}

function readBlockId(chunk: Chunk, neighbors: Neighbors, x: number, y: number, z: number): number {
	if (y < 0 || y >= chunk.height) return 0;
	const inX = x >= 0 && x < CHUNK_SIZE_X;
	const inZ = z >= 0 && z < CHUNK_SIZE_Z;
	if (inX && inZ) return chunk.blocks[indexOf(x, y, z)];
	if (x >= CHUNK_SIZE_X && inZ) return neighbors.px?.blocks[indexOf(0, y, z)] ?? 0;
	if (x < 0 && inZ) return neighbors.nx?.blocks[indexOf(CHUNK_SIZE_X - 1, y, z)] ?? 0;
	if (z >= CHUNK_SIZE_Z && inX) return neighbors.pz?.blocks[indexOf(x, y, 0)] ?? 0;
	if (z < 0 && inX) return neighbors.nz?.blocks[indexOf(x, y, CHUNK_SIZE_Z - 1)] ?? 0;
	// Diagonal — treat as air (conservatively: no AO darkening from voxels we can't resolve).
	return 0;
}

function readSunlit(chunk: Chunk, neighbors: Neighbors, x: number, y: number, z: number): number {
	if (y < 0 || y >= chunk.height) return 1;
	const inX = x >= 0 && x < CHUNK_SIZE_X;
	const inZ = z >= 0 && z < CHUNK_SIZE_Z;
	if (inX && inZ) return chunk.sunlit[indexOf(x, y, z)];
	if (x >= CHUNK_SIZE_X && inZ) return neighbors.px?.sunlit[indexOf(0, y, z)] ?? 1;
	if (x < 0 && inZ) return neighbors.nx?.sunlit[indexOf(CHUNK_SIZE_X - 1, y, z)] ?? 1;
	if (z >= CHUNK_SIZE_Z && inX) return neighbors.pz?.sunlit[indexOf(x, y, 0)] ?? 1;
	if (z < 0 && inX) return neighbors.nz?.sunlit[indexOf(x, y, CHUNK_SIZE_Z - 1)] ?? 1;
	return 1;
}

// ---------------------------------------------------------------------------
// Per-corner sampling: one pass over the 4 outward voxels computes light, AO and
// shadow together; results land in module-level scratch numbers.
// ---------------------------------------------------------------------------

/** Output of cornerColor(): the final vertex colour (r, g, b). */
const C_OUT = new Float32Array(3);

/**
 * Compute the vertex colour for the corner (cx, cy, cz) of a face with pattern index fi:
 * averaged (sky, r, g, b) → RGB, times AO factor, times the shadow factor. Arithmetic
 * order matches the original sampleCornerLight / lightSampleToRGB / aoFactorForCorner /
 * sampleCornerShadow exactly so the output bytes are identical.
 */
function cornerColor(
	chunk: Chunk,
	neighbors: Neighbors,
	cx: number,
	cy: number,
	cz: number,
	fi: number,
): void {
	const pat = AO_PATTERN[fi];
	let sumSky = 0,
		sumR = 0,
		sumG = 0,
		sumB = 0;
	let sumSun = 0;
	let edgeCount = 0;
	let diagOpaque = false;
	for (let k = 0; k < 4; k++) {
		const vx = cx + pat[k * 4];
		const vy = cy + pat[k * 4 + 1];
		const vz = cz + pat[k * 4 + 2];
		const kind = pat[k * 4 + 3];
		const w = readLightWord(chunk, neighbors, vx, vy, vz);
		sumSky += (w >> 12) & 0xf;
		sumR += (w >> 8) & 0xf;
		sumG += (w >> 4) & 0xf;
		sumB += w & 0xf;
		sumSun += readSunlit(chunk, neighbors, vx, vy, vz);
		if (kind !== 0) {
			const id = readBlockId(chunk, neighbors, vx, vy, vz);
			if (OPAQUE[id] === 1) {
				if (kind === 1) edgeCount++;
				else diagOpaque = true;
			}
		}
	}
	// sampleCornerLight: average over the 4 voxels (count is always 4 for an axis normal).
	const sky = sumSky / 4;
	const lr = sumR / 4;
	const lg = sumG / 4;
	const lb = sumB / 4;
	// lightSampleToRGB
	const skyScale = sky / 15;
	const blockR = lr / 15;
	const blockG = lg / 15;
	const blockB = lb / 15;
	let r = SKY_COLOR[0] * skyScale + blockR + MIN_AMBIENT;
	let g = SKY_COLOR[1] * skyScale + blockG + MIN_AMBIENT;
	let b = SKY_COLOR[2] * skyScale + blockB + MIN_AMBIENT;
	if (r > 1) r = 1;
	if (g > 1) g = 1;
	if (b > 1) b = 1;
	// aoFactorForCorner
	let ao: number;
	if (edgeCount === 0) ao = 1.0;
	else if (edgeCount === 1) ao = 0.85;
	else ao = diagOpaque ? 0.5 : 0.7;
	// sampleCornerShadow
	const sunlitFrac = sumSun / 4;
	const shadowFactor = SHADOW_FLOOR + (1 - SHADOW_FLOOR) * sunlitFrac;
	const mult = ao * shadowFactor;
	C_OUT[0] = r * mult;
	C_OUT[1] = g * mult;
	C_OUT[2] = b * mult;
}

/** Emit one quad (4 vertices + 6 indices) for block (x, y, z), face fi, into bufs. */
function emitFace(
	bufs: MeshBufs,
	chunk: Chunk,
	neighbors: Neighbors,
	x: number,
	y: number,
	z: number,
	fi: number,
	u0: number,
	v0: number,
	u1: number,
	v1: number,
): void {
	const nx = FACE_NORMAL[fi * 3];
	const ny = FACE_NORMAL[fi * 3 + 1];
	const nz = FACE_NORMAL[fi * 3 + 2];
	for (let i = 0; i < 4; i++) {
		const ci = (fi * 4 + i) * 3;
		const px = x + FACE_CORNER[ci];
		const py = y + FACE_CORNER[ci + 1];
		const pz = z + FACE_CORNER[ci + 2];
		const ui = (fi * 4 + i) * 2;
		bufs.positions.push3(px, py, pz);
		bufs.normals.push3(nx, ny, nz);
		bufs.uvs.push2(FACE_UVSEL[ui] === 0 ? u0 : u1, FACE_UVSEL[ui + 1] === 0 ? v0 : v1);
		cornerColor(chunk, neighbors, px, py, pz, fi);
		bufs.colors.push3(C_OUT[0], C_OUT[1], C_OUT[2]);
	}
	bufs.indices.pushQuad(bufs.vcount);
	bufs.vcount += 4;
}

export function meshChunk(chunk: Chunk, neighbors: Neighbors, uvFor: UvFn): ChunkMeshResult {
	const translucent = buildSolidMesh(chunk, neighbors, uvFor, true, TRANSLUCENT_BUFS);
	return {
		opaque: buildSolidMesh(chunk, neighbors, uvFor, false, OPAQUE_BUFS),
		liquid: buildLiquidMesh(chunk, neighbors, uvFor, LIQUID_BUFS),
		translucent: translucent.indices.length > 0 ? translucent : null,
	};
}

function buildSolidMesh(
	chunk: Chunk,
	neighbors: Neighbors,
	uvFor: UvFn,
	translucentPass: boolean,
	bufs: MeshBufs,
): ChunkMesh {
	resetBufs(bufs);
	const blocks = chunk.blocks;
	const height = chunk.height;

	for (let y = 0; y < height; y++) {
		for (let z = 0; z < CHUNK_SIZE_Z; z++) {
			for (let x = 0; x < CHUNK_SIZE_X; x++) {
				const id = blocks[indexOf(x, y, z)];
				if (!isSolid(id) || isTranslucent(id) !== translucentPass) continue;

				for (let fi = 0; fi < 6; fi++) {
					const nb = neighborBlock(
						chunk,
						neighbors,
						x + FACE_DIR[fi * 3],
						y + FACE_DIR[fi * 3 + 1],
						z + FACE_DIR[fi * 3 + 2],
					);
					if (!shouldEmitFace(id, nb)) continue;

					const uv = uvFor(id, FACE_ORDER[fi]);
					emitFace(bufs, chunk, neighbors, x, y, z, fi, uv[0], uv[1], uv[2], uv[3]);
				}
			}
		}
	}

	return bufsToMesh(bufs);
}

function buildLiquidMesh(
	chunk: Chunk,
	neighbors: Neighbors,
	uvFor: UvFn,
	bufs: MeshBufs,
): ChunkMesh | null {
	resetBufs(bufs);
	const blocks = chunk.blocks;
	const height = chunk.height;

	for (let y = 0; y < height; y++) {
		for (let z = 0; z < CHUNK_SIZE_Z; z++) {
			for (let x = 0; x < CHUNK_SIZE_X; x++) {
				const here = blocks[indexOf(x, y, z)];
				if (!isLiquid(here)) continue;
				for (let fi = 0; fi < 6; fi++) {
					const there = neighborBlock(
						chunk,
						neighbors,
						x + FACE_DIR[fi * 3],
						y + FACE_DIR[fi * 3 + 1],
						z + FACE_DIR[fi * 3 + 2],
					);
					let emit = false;
					if (there === 0) emit = true;
					else if (isLiquid(there) && there !== here && here < there) emit = true;
					if (!emit) continue;

					const uv = uvFor(here, FACE_ORDER[fi]);
					emitFace(bufs, chunk, neighbors, x, y, z, fi, uv[0], uv[1], uv[2], uv[3]);
				}
			}
		}
	}

	if (bufs.indices.len === 0) return null;
	return bufsToMesh(bufs);
}
