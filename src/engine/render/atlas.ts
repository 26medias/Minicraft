import * as THREE from 'three';
import { BLOCKS, type BlockId, type Face, faceTexture } from '../../data/blocks.data';

export type TileRect = { u: number; v: number; w: number; h: number };
type AtlasJson = { size: number; tileSize: number; tiles: Record<string, TileRect> };

export type LoadedAtlas = {
	texture: THREE.Texture;
	pngUrl: string;
	size: number;
	tileSize: number;
	uvFor: (id: BlockId, face: Face) => [number, number, number, number];
	/** Pixel rect of the block's face in the atlas PNG, for DOM CSS positioning. */
	tileRect: (id: BlockId, face: Face) => TileRect | null;
};

export async function loadAtlas(
	pngUrl = `${import.meta.env.BASE_URL}atlas.png`,
	jsonUrl = `${import.meta.env.BASE_URL}atlas.json`,
): Promise<LoadedAtlas> {
	const [texture, atlas] = await Promise.all([
		loadTexture(pngUrl),
		fetch(jsonUrl).then((r) => r.json() as Promise<AtlasJson>),
	]);

	texture.magFilter = THREE.NearestFilter;
	texture.minFilter = THREE.NearestMipMapLinearFilter;
	texture.generateMipmaps = true;
	texture.wrapS = THREE.ClampToEdgeWrapping;
	texture.wrapT = THREE.ClampToEdgeWrapping;
	texture.colorSpace = THREE.SRGBColorSpace;

	// Per-block UV + pixel rect caches keyed [blockId * 6 + faceIndex] for hot-path lookup.
	const faces: Face[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
	const uvCache: Array<[number, number, number, number] | null> = new Array(
		BLOCKS.length * 6,
	).fill(null);
	const rectCache: Array<TileRect | null> = new Array(BLOCKS.length * 6).fill(null);
	for (const b of BLOCKS) {
		for (let fi = 0; fi < 6; fi++) {
			const face = faces[fi];
			const name = faceTexture(b.id, face);
			if (!name) continue;
			const rect = atlas.tiles[name];
			if (!rect) throw new Error(`Atlas missing tile ${name} for ${b.name}/${face}`);
			rectCache[b.id * 6 + fi] = rect;
			const u0 = rect.u / atlas.size;
			const v0 = 1 - (rect.v + rect.h) / atlas.size; // flip V (three.js UV origin is bottom-left)
			const u1 = (rect.u + rect.w) / atlas.size;
			const v1 = 1 - rect.v / atlas.size;
			uvCache[b.id * 6 + fi] = [u0, v0, u1, v1];
		}
	}

	const faceIndex: Record<Face, number> = { px: 0, nx: 1, py: 2, ny: 3, pz: 4, nz: 5 };

	return {
		texture,
		pngUrl,
		size: atlas.size,
		tileSize: atlas.tileSize,
		uvFor: (id, face) => {
			const rect = uvCache[id * 6 + faceIndex[face]];
			if (!rect) throw new Error(`No UV for block id ${id} face ${face}`);
			return rect;
		},
		tileRect: (id, face) => rectCache[id * 6 + faceIndex[face]],
	};
}

function loadTexture(url: string): Promise<THREE.Texture> {
	return new Promise((resolve, reject) => {
		new THREE.TextureLoader().load(url, resolve, undefined, reject);
	});
}
