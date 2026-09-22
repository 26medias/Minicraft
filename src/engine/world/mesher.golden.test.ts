import { describe, it, expect } from 'vitest';
import { World } from './world';
import { meshChunk, type ChunkMesh } from './mesher';
import { computeChunkShadowsBrute } from './shadows.brute';
import { spawnV3 } from './v3/spawn';
import { BLOCK_BY_NAME } from '../../data/blocks.data';
import { indexOf } from './coords';

const uvFor = (id: number, face: string) => { const fi = { px: 0, nx: 1, py: 2, ny: 3, pz: 4, nz: 5 }[face as 'px']; const t = (id * 6 + fi) % 4096; const u = (t % 64) / 64, v = Math.floor(t / 64) / 64; return [u, v, u + 1 / 64, v + 1 / 64] as [number, number, number, number]; };

function fnvBytes(a: ArrayBufferView): number { const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); let h = 2166136261 >>> 0; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619) >>> 0; } return h; }
function hashMesh(m: ChunkMesh | null): number[] { return m ? [fnvBytes(m.positions), fnvBytes(m.normals), fnvBytes(m.uvs), fnvBytes(m.colors), fnvBytes(m.indices)] : [0, 0, 0, 0, 0]; }

/** Pinned construction (spec §6.1): ensure the 5×5 around each fixture chunk, brute-shadow every chunk, then mesh. */
function fixture() {
	const w = World.create(3); const s = spawnV3(3);
	const pcx = Math.floor(s.x / 16), pcz = Math.floor(s.z / 16);
	const picks: [number, number][] = [[pcx, pcz], [pcx + 2, pcz - 1], [pcx - 1, pcz + 3]];
	for (const [cx, cz] of picks) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (w.chunkInWorld(cx + dx, cz + dz)) w.ensureChunk(cx + dx, cz + dz);
	// A fourth pick with a translucent block so the translucent pass is byte-gated too (gate 2: the three natural picks hash translucent to [0,0,0,0,0]).
	const g = w.getChunk(pcx, pcz)!; const glass = BLOCK_BY_NAME['white_stained_glass'].id;
	for (let x = 4; x < 8; x++) for (let z = 4; z < 8; z++) for (let y = 130; y < 133; y++) g.blocks[indexOf(x, y, z)] = glass;
	for (const c of w.allChunks()) computeChunkShadowsBrute(w, c);
	return { w, picks };
}

// Recorded ONCE at the perf base commit (step 0); never re-recorded. Empty until then.
const EXPECTED: Record<string, number[]> = {
	'21,12': [1825138057, 2252756709, 1685498389, 2789479881, 3335211883, 0, 0, 0, 0, 0, 2177329537, 2005287653, 3372884885, 810916311, 1551215527],
	'23,11': [2316495125, 1803881189, 2551034517, 37597082, 3734501287, 3863247837, 3405197413, 278830597, 3427787501, 527418631, 0, 0, 0, 0, 0],
	'20,15': [3986259953, 3648011237, 362083725, 2880651615, 1719258291, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};

describe('meshChunk byte golden (spec §6.1)', () => {
	it('three v3 chunks of seed 3 (one with stained glass) hash to the recorded bytes (mutant: any vertex, colour or index change → red)', { timeout: 30_000 }, () => {
		const { w, picks } = fixture();
		const got: Record<string, number[]> = {};
		for (const [cx, cz] of picks) {
			const c = w.getChunk(cx, cz)!; const r = meshChunk(c, w.neighbors(c), uvFor);
			got[`${cx},${cz}`] = [...hashMesh(r.opaque), ...hashMesh(r.liquid), ...hashMesh(r.translucent)];
		}
		if (Object.keys(EXPECTED).length === 0) { console.log('GOLDEN', JSON.stringify(got)); throw new Error('golden not recorded: paste the GOLDEN line into EXPECTED'); }
		expect(got).toEqual(EXPECTED);
	});
});
