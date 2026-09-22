import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { buildUvTable, uvFromTable, type AtlasJson } from './uv-table';
import { BLOCKS, faceTexture, type Face } from '../../data/blocks.data';

if (!existsSync('public/atlas.json')) throw new Error('public/atlas.json missing: run npm run build-atlas (it is gitignored)');
const atlas = JSON.parse(readFileSync('public/atlas.json', 'utf8')) as AtlasJson;
const FACES: Face[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

describe('uv table (spec §6.3)', () => {
	it('equals the reference formula for every textured block face (mutant: swap two faces)', () => {
		const t = buildUvTable(atlas);
		const uv = uvFromTable(t);
		for (const b of BLOCKS) {
			for (const face of FACES) {
				const name = faceTexture(b.id, face);
				if (!name) continue;
				const r = atlas.tiles[name];
				expect(uv(b.id, face)).toEqual([r.u / atlas.size, 1 - (r.v + r.h) / atlas.size, (r.u + r.w) / atlas.size, 1 - r.v / atlas.size]);
			}
		}
		expect(t.length).toBe(BLOCKS.length * 6 * 4);
	});
});
