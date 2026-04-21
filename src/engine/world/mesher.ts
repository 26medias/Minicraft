import type { BlockId, Face } from '../../data/blocks.data';
import { isSolid, isTransparent } from '../../data/blocks.data';
import type { Chunk } from './chunk';
import { CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z } from './coords';

export type ChunkMesh = {
	positions: Float32Array;
	normals: Float32Array;
	uvs: Float32Array;
	indices: Uint32Array;
};

export type UvFn = (id: BlockId, face: Face) => [number, number, number, number];

type Neighbors = { px?: Chunk; nx?: Chunk; pz?: Chunk; nz?: Chunk };

// Per-face constant data: normal, direction offset, and 4 corner offsets (positions within a unit cube).
// Winding: CCW when viewed from outside the cube, so front-faces point outward.
const FACES: Record<
	Face,
	{
		normal: [number, number, number];
		corners: [number, number, number][];
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

export function meshChunk(chunk: Chunk, neighbors: Neighbors, uvFor: UvFn): ChunkMesh {
	const positions: number[] = [];
	const normals: number[] = [];
	const uvs: number[] = [];
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
					const faceUvs: [number, number][] = [
						[u0, v1],
						[u1, v1],
						[u1, v0],
						[u0, v0],
					];

					for (let i = 0; i < 4; i++) {
						const [ox, oy, oz] = f.corners[i];
						positions.push(x + ox, y + oy, z + oz);
						normals.push(f.normal[0], f.normal[1], f.normal[2]);
						uvs.push(faceUvs[i][0], faceUvs[i][1]);
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
		indices: new Uint32Array(indices),
	};
}
