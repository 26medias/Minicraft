import { describe, it, expect } from 'vitest';
import { Chunk } from '../chunk';
import { generateChunkV3 } from './generate';
import { spawnV3 } from './spawn';
import { column, SEA, BIOME, inRavineChannel } from './columns';
import { V3, LOG_IDS, LEAF_IDS, isLiquidId } from './blocks';

const CI = [1, 2, 3, 5, 8, 13, 21, 34];
function around(seed: number, sx: number, sz: number, R: number) {
	const m = new Map<number, Uint16Array>();
	for (let cz = (sz >> 4) - R; cz <= (sz >> 4) + R; cz++) for (let cx = (sx >> 4) - R; cx <= (sx >> 4) + R; cx++) { if (cx < 0 || cz < 0 || cx > 31 || cz > 31) continue; const c = new Chunk(cx, cz, 256); generateChunkV3(c, seed); m.set(cz * 32 + cx, c.blocks); }
	return (x: number, y: number, z: number) => { const b = m.get((z >> 4) * 32 + (x >> 4)); if (!b || y < 0 || y > 255) return -1; return b[y * 256 + (z & 15) * 16 + (x & 15)]; };
}

describe('spawnV3 (§9, §11.11)', () => {
	it('is deterministic, work-bounded, never uses pass 4 or the fallback on the CI seeds', () => {
		for (const seed of CI) { const a = spawnV3(seed), b = spawnV3(seed); expect(a).toEqual(b); expect(a.pass).toBeLessThanOrEqual(3); expect(a.ringsSearched).toBeLessThanOrEqual(128); expect(a.work).toBeLessThanOrEqual(148225); }
	});
	it('strict spawn safety on the CI seeds: top block is exactly h, solid, not liquid/snow/ice; air at h+1, h+2; h ≥ 122; no log/leaf within Chebyshev 3 and 12 up; buildable ≥ 40 %; no ravine channel within 64; pass 1 ⇒ h ≥ 130', () => {
		for (const seed of CI) {
			const s = spawnV3(seed); const c = column(seed, s.x, s.z); const get = around(seed, s.x, s.z, 5);
			let y = 255; while (y > 0 && get(s.x, y, s.z) === 0) y--; const t = get(s.x, y, s.z);
			expect(y, `seed ${seed}`).toBe(c.h); expect(t).not.toBe(0); expect(isLiquidId(t)).toBe(false); expect(t).not.toBe(V3.snow_block); expect(t).not.toBe(V3.ice);
			expect(get(s.x, y + 1, s.z)).toBe(0); expect(get(s.x, y + 2, s.z)).toBe(0); expect(y).toBeGreaterThanOrEqual(SEA + 2); if (s.pass === 1) expect(y).toBeGreaterThanOrEqual(130);
			for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) for (let yy = y - 2; yy <= y + 12; yy++) { const v = get(s.x + dx, yy, s.z + dz); expect(LOG_IDS.has(v) || LEAF_IDS.has(v), `tree near spawn seed ${seed}`).toBe(false); }
			expect(s.buildable).toBeGreaterThanOrEqual(0.4); expect(c.biome).not.toBe(BIOME.snowy); expect(c.river).toBe(0);
			for (let dz = -64; dz <= 64; dz++) for (let dx = -64; dx <= 64; dx++) { const x = s.x + dx, z = s.z + dz; if (x < 0 || z < 0 || x > 511 || z > 511) continue; if (column(seed, x, z).ravW > 0) expect(inRavineChannel(seed, x, z), `ravine channel within 64, seed ${seed}`).toBe(false); } // every column, as the spawn code checks
		}
	}, 180_000);
});
