import * as THREE from 'three';
import { BLOCKS, type BlockId, type Face, faceTexture } from '../../data/blocks.data';
import { buildUvTable, uvFromTable, type AtlasJson, type TileRect } from './uv-table';

export type { AtlasJson, TileRect };

export type LoadedAtlas = {
	texture: THREE.Texture;
	pngUrl: string;
	size: number;
	tileSize: number;
	uvFor: (id: BlockId, face: Face) => [number, number, number, number];
	/** The pure UV table `uvFor` reads from; posted once to the chunk worker (spec §3.D). */
	uvTable: Float32Array;
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

	// Pixel rect cache keyed [blockId * 6 + faceIndex] for the DOM; UVs come from the pure table.
	const faces: Face[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
	const rectCache: Array<TileRect | null> = new Array(BLOCKS.length * 6).fill(null);
	for (const b of BLOCKS) {
		for (let fi = 0; fi < 6; fi++) {
			const name = faceTexture(b.id, faces[fi]);
			if (!name) continue;
			rectCache[b.id * 6 + fi] = atlas.tiles[name] ?? null;
		}
	}
	const uvTable = buildUvTable(atlas);
	const faceIndex: Record<Face, number> = { px: 0, nx: 1, py: 2, ny: 3, pz: 4, nz: 5 };

	return {
		texture,
		pngUrl,
		size: atlas.size,
		tileSize: atlas.tileSize,
		uvFor: uvFromTable(uvTable),
		uvTable,
		tileRect: (id, face) => rectCache[id * 6 + faceIndex[face]],
	};
}

function loadTexture(url: string): Promise<THREE.Texture> {
	return new Promise((resolve, reject) => {
		new THREE.TextureLoader().load(url, resolve, undefined, reject);
	});
}
