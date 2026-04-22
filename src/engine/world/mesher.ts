import type { BlockId, Face } from '../../data/blocks.data';
import { BLOCKS, isLiquid, isSolid, isTransparent } from '../../data/blocks.data';
import type { Chunk } from './chunk';
import { CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z, indexOf } from './coords';

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
};

export type UvFn = (id: BlockId, face: Face) => [number, number, number, number];

export type Neighbors = { px?: Chunk; nx?: Chunk; pz?: Chunk; nz?: Chunk };

const SKY_COLOR: [number, number, number] = [0.9, 0.95, 1.0];
const MIN_AMBIENT = 0.08;

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

function neighborBlock(
	chunk: Chunk,
	neighbors: Neighbors,
	x: number,
	y: number,
	z: number,
): BlockId {
	if (y < 0 || y >= CHUNK_SIZE_Y) return 0;
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

type LightSample = { sky: number; r: number; g: number; b: number };

function readLight(
	chunk: Chunk,
	neighbors: Neighbors,
	x: number,
	y: number,
	z: number,
): LightSample {
	if (y < 0 || y >= CHUNK_SIZE_Y) return { sky: 0, r: 0, g: 0, b: 0 };
	const inX = x >= 0 && x < CHUNK_SIZE_X;
	const inZ = z >= 0 && z < CHUNK_SIZE_Z;
	if (inX && inZ) {
		return {
			sky: chunk.getSky(x, y, z),
			r: chunk.getBlockR(x, y, z),
			g: chunk.getBlockG(x, y, z),
			b: chunk.getBlockB(x, y, z),
		};
	}
	let target: Chunk | undefined;
	let lx = x,
		lz = z;
	if (x >= CHUNK_SIZE_X && inZ) {
		target = neighbors.px;
		lx = 0;
	} else if (x < 0 && inZ) {
		target = neighbors.nx;
		lx = CHUNK_SIZE_X - 1;
	} else if (z >= CHUNK_SIZE_Z && inX) {
		target = neighbors.pz;
		lz = 0;
	} else if (z < 0 && inX) {
		target = neighbors.nz;
		lz = CHUNK_SIZE_Z - 1;
	}
	// else: true diagonal (both axes OOB) — target stays undefined, falls through to 0.
	if (!target) return { sky: 0, r: 0, g: 0, b: 0 };
	return {
		sky: target.getSky(lx, y, lz),
		r: target.getBlockR(lx, y, lz),
		g: target.getBlockG(lx, y, lz),
		b: target.getBlockB(lx, y, lz),
	};
}

function readBlockId(chunk: Chunk, neighbors: Neighbors, x: number, y: number, z: number): number {
	if (y < 0 || y >= CHUNK_SIZE_Y) return 0;
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

function aoFactorForCorner(
	chunk: Chunk,
	neighbors: Neighbors,
	cornerX: number,
	cornerY: number,
	cornerZ: number,
	nx: number,
	ny: number,
	nz: number,
): number {
	const axisNormal = Math.abs(nx) > 0 ? 0 : Math.abs(ny) > 0 ? 1 : 2;
	type V = { x: number; y: number; z: number; kind: 'edge' | 'diag' | 'face' };
	const vox: V[] = [];
	for (let dx = -1; dx <= 0; dx++) {
		for (let dy = -1; dy <= 0; dy++) {
			for (let dz = -1; dz <= 0; dz++) {
				// Same filter as sampleCornerLight: keep voxels on the OUTWARD side of the face.
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
				let kind: V['kind'];
				if (shiftedNonNormal === 0) kind = 'face';
				else if (shiftedNonNormal === 1) kind = 'edge';
				else kind = 'diag';
				vox.push({ x: cornerX + dx, y: cornerY + dy, z: cornerZ + dz, kind });
			}
		}
	}
	const isOpaque = (v: V) => {
		const id = readBlockId(chunk, neighbors, v.x, v.y, v.z);
		const def = BLOCKS[id];
		return !!def && def.lightFilter >= 15 && def.liquid === 'none';
	};
	let edgeCount = 0;
	let diagOpaque = false;
	for (const v of vox) {
		if (v.kind === 'edge' && isOpaque(v)) edgeCount++;
		if (v.kind === 'diag' && isOpaque(v)) diagOpaque = true;
	}
	if (edgeCount >= 2) return diagOpaque ? 0.6 : 0.75;
	return 1.0;
}

/**
 * Sample 4 voxels that meet at a corner of a face. cornerX/Y/Z is the corner's
 * integer position; (nx, ny, nz) is the face's outward normal. Returns the
 * averaged (sky, r, g, b) of the 4 voxels on the outward side of the face.
 */
function sampleCornerLight(
	chunk: Chunk,
	neighbors: Neighbors,
	cornerX: number,
	cornerY: number,
	cornerZ: number,
	nx: number,
	ny: number,
	nz: number,
): LightSample {
	let sumSky = 0,
		sumR = 0,
		sumG = 0,
		sumB = 0,
		count = 0;
	for (let dx = -1; dx <= 0; dx++) {
		for (let dy = -1; dy <= 0; dy++) {
			for (let dz = -1; dz <= 0; dz++) {
				// Filter to the 4 voxels on the outward side of the face.
				if (nx === 1 && dx !== 0) continue;
				if (nx === -1 && dx !== -1) continue;
				if (ny === 1 && dy !== 0) continue;
				if (ny === -1 && dy !== -1) continue;
				if (nz === 1 && dz !== 0) continue;
				if (nz === -1 && dz !== -1) continue;
				const vx = cornerX + dx;
				const vy = cornerY + dy;
				const vz = cornerZ + dz;
				const s = readLight(chunk, neighbors, vx, vy, vz);
				sumSky += s.sky;
				sumR += s.r;
				sumG += s.g;
				sumB += s.b;
				count++;
			}
		}
	}
	if (count === 0) return { sky: 0, r: 0, g: 0, b: 0 };
	return { sky: sumSky / count, r: sumR / count, g: sumG / count, b: sumB / count };
}

function lightSampleToRGB(s: LightSample): [number, number, number] {
	const skyScale = s.sky / 15;
	const blockR = s.r / 15;
	const blockG = s.g / 15;
	const blockB = s.b / 15;
	let r = SKY_COLOR[0] * skyScale + blockR + MIN_AMBIENT;
	let g = SKY_COLOR[1] * skyScale + blockG + MIN_AMBIENT;
	let b = SKY_COLOR[2] * skyScale + blockB + MIN_AMBIENT;
	if (r > 1) r = 1;
	if (g > 1) g = 1;
	if (b > 1) b = 1;
	return [r, g, b];
}

export function meshChunk(chunk: Chunk, neighbors: Neighbors, uvFor: UvFn): ChunkMeshResult {
	return {
		opaque: buildOpaqueMesh(chunk, neighbors, uvFor),
		liquid: buildLiquidMesh(chunk, neighbors, uvFor),
	};
}

function buildOpaqueMesh(chunk: Chunk, neighbors: Neighbors, uvFor: UvFn): ChunkMesh {
	const positions: number[] = [];
	const normals: number[] = [];
	const uvs: number[] = [];
	const colors: number[] = [];
	const indices: number[] = [];
	let vcount = 0;

	for (let y = 0; y < CHUNK_SIZE_Y; y++) {
		for (let z = 0; z < CHUNK_SIZE_Z; z++) {
			for (let x = 0; x < CHUNK_SIZE_X; x++) {
				const id = chunk.get(x, y, z);
				if (!isSolid(id)) continue;

				for (const face of FACE_ORDER) {
					const f = FACES[face];
					const nb = neighborBlock(chunk, neighbors, x + f.dx, y + f.dy, z + f.dz);
					if (!shouldEmitFace(id, nb)) continue;

					const [u0, v0, u1, v1] = uvFor(id, face);

					for (let i = 0; i < 4; i++) {
						const [ox, oy, oz] = f.corners[i];
						const [ui, vi] = f.uvs[i];
						positions.push(x + ox, y + oy, z + oz);
						normals.push(f.normal[0], f.normal[1], f.normal[2]);
						uvs.push(ui === 0 ? u0 : u1, vi === 0 ? v0 : v1);
						const sample = sampleCornerLight(
							chunk,
							neighbors,
							x + ox,
							y + oy,
							z + oz,
							f.normal[0],
							f.normal[1],
							f.normal[2],
						);
						const [cr, cg, cb] = lightSampleToRGB(sample);
						const ao = aoFactorForCorner(
							chunk,
							neighbors,
							x + ox,
							y + oy,
							z + oz,
							f.normal[0],
							f.normal[1],
							f.normal[2],
						);
						colors.push(cr * ao, cg * ao, cb * ao);
					}
					indices.push(vcount, vcount + 1, vcount + 2, vcount, vcount + 2, vcount + 3);
					vcount += 4;
				}
			}
		}
	}

	return {
		positions: new Float32Array(positions),
		normals: new Float32Array(normals),
		uvs: new Float32Array(uvs),
		colors: new Float32Array(colors),
		indices: new Uint32Array(indices),
	};
}

function buildLiquidMesh(chunk: Chunk, neighbors: Neighbors, uvFor: UvFn): ChunkMesh | null {
	const positions: number[] = [];
	const normals: number[] = [];
	const uvs: number[] = [];
	const colors: number[] = [];
	const indices: number[] = [];
	let vcount = 0;

	for (let y = 0; y < CHUNK_SIZE_Y; y++) {
		for (let z = 0; z < CHUNK_SIZE_Z; z++) {
			for (let x = 0; x < CHUNK_SIZE_X; x++) {
				const here = chunk.get(x, y, z);
				if (!isLiquid(here)) continue;
				for (const face of FACE_ORDER) {
					const f = FACES[face];
					const there = readBlockId(chunk, neighbors, x + f.dx, y + f.dy, z + f.dz);
					let emit = false;
					if (there === 0) emit = true;
					else if (isLiquid(there) && there !== here && here < there) emit = true;
					if (!emit) continue;

					const [u0, v0, u1, v1] = uvFor(here, face);
					for (let i = 0; i < 4; i++) {
						const [ox, oy, oz] = f.corners[i];
						const [ui, vi] = f.uvs[i];
						positions.push(x + ox, y + oy, z + oz);
						normals.push(f.normal[0], f.normal[1], f.normal[2]);
						uvs.push(ui === 0 ? u0 : u1, vi === 0 ? v0 : v1);
						const sample = sampleCornerLight(
							chunk,
							neighbors,
							x + ox,
							y + oy,
							z + oz,
							f.normal[0],
							f.normal[1],
							f.normal[2],
						);
						const [cr, cg, cb] = lightSampleToRGB(sample);
						colors.push(cr, cg, cb);
					}
					indices.push(vcount, vcount + 1, vcount + 2, vcount, vcount + 2, vcount + 3);
					vcount += 4;
				}
			}
		}
	}

	if (indices.length === 0) return null;
	return {
		positions: new Float32Array(positions),
		normals: new Float32Array(normals),
		uvs: new Float32Array(uvs),
		colors: new Float32Array(colors),
		indices: new Uint32Array(indices),
	};
}
