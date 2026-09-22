// Pure UV table: no THREE, DOM or import.meta — shared by loadAtlas and the chunk worker (spec §3.D).
import { BLOCKS, faceTexture, type Face } from '../../data/blocks.data';
import type { UvFn } from '../world/mesher';

export type TileRect = { u: number; v: number; w: number; h: number };
export type AtlasJson = { size: number; tileSize: number; tiles: Record<string, TileRect> };

const FACES: Face[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
const FACE_INDEX: Record<Face, number> = { px: 0, nx: 1, py: 2, ny: 3, pz: 4, nz: 5 };

/** `[u0, v0, u1, v1]` at `(id * 6 + faceIndex) * 4`; NaN where a face has no texture. */
export function buildUvTable(atlas: AtlasJson): Float32Array {
	const table = new Float32Array(BLOCKS.length * 6 * 4).fill(NaN);
	for (const b of BLOCKS) {
		for (let fi = 0; fi < 6; fi++) {
			const name = faceTexture(b.id, FACES[fi]);
			if (!name) continue;
			const rect = atlas.tiles[name];
			if (!rect) throw new Error(`Atlas missing tile ${name} for ${b.name}/${FACES[fi]}`);
			const o = (b.id * 6 + fi) * 4;
			table[o] = rect.u / atlas.size;
			table[o + 1] = 1 - (rect.v + rect.h) / atlas.size; // flip V (three.js UV origin is bottom-left)
			table[o + 2] = (rect.u + rect.w) / atlas.size;
			table[o + 3] = 1 - rect.v / atlas.size;
		}
	}
	return table;
}

/** A fresh 4-tuple per call; throws for an untextured face like the old `uvFor`. */
export function uvFromTable(table: Float32Array): UvFn {
	return (id, face) => {
		const o = (id * 6 + FACE_INDEX[face]) * 4;
		const u0 = table[o];
		if (Number.isNaN(u0)) throw new Error(`No UV for block id ${id} face ${face}`);
		return [u0, table[o + 1], table[o + 2], table[o + 3]];
	};
}
