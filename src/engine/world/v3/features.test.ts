import { describe, it, expect } from 'vitest';
import { Chunk } from '../chunk';
import { generateChunkV3, W } from './generate';
import { oresOf, blobsOf, pocketsOf, geodesOf, poolsOf, T7_ORE_BAD } from './features';
import { V3, ORE_DEEPSLATE, ORE_IDS, isLiquidId, isStoneId } from './blocks';

// §7 band table transcribed BY HAND — never import ORES here (spec §11.7: an imported table stays green on the coal-shift mutant).
const BANDS_HAND: Record<string, [number, number][]> = { coal: [[60, 200]], iron: [[16, 112], [140, 230]], copper: [[50, 130]], gold: [[6, 70], [40, 120]], lapis: [[12, 76]], redstone: [[4, 40]], diamond: [[4, 36], [4, 30]], emerald: [[100, 220]] };
const FAMILY = new Map<number, string>();
for (const n of Object.keys(BANDS_HAND)) { FAMILY.set(V3[`${n}_ore` as keyof typeof V3], n); FAMILY.set(V3[`deepslate_${n}_ore` as keyof typeof V3], n); }

function fullMap(seed: number) {
	const m = new Map<number, Uint16Array>(); let replaysBad = 0, instMax = 0;
	// 37 = 4 lists × 9 origins + 1 (pools, own chunk). Trees add 9 in Task 5; the `=== 46` assertion is Task 7's (gate 2: it cannot pass at the end of this task).
	for (let cz = 0; cz < 32; cz++) for (let cx = 0; cx < 32; cx++) {
		const c = new Chunk(cx, cz, 256); generateChunkV3(c, seed); m.set(cz * 32 + cx, c.blocks);
		// ≥ 37: Task 4's 36 + pools; Task 5 adds 9 → 46, asserted exactly in Task 7 (gate 2 closure: never assert equality on a counter a later task adds to)
		if (cx > 0 && cz > 0 && cx < 31 && cz < 31 && W.replays < 37) replaysBad++;
		instMax = Math.max(instMax, W.instances);
	}
	const get = (x: number, y: number, z: number) => { if (x < 0 || z < 0 || x > 511 || z > 511 || y < 0 || y > 255) return -1; return m.get((z >> 4) * 32 + (x >> 4))![y * 256 + (z & 15) * 16 + (x & 15)]; };
	return { get, replaysBad, instMax };
}

describe('v3 features', () => {
	it('instance lists are pure per origin chunk and carry per-attempt sub-streams', () => {
		const a = oresOf(1, 10, 10), b = oresOf(1, 10, 10); expect(a).toBe(b); // memoised
		expect(JSON.stringify(oresOf(1, 10, 10).map((o) => [o.x, o.y, o.z, o.size, o.sub]))).toBe(JSON.stringify(oresOf(1, 10, 10).map((o) => [o.x, o.y, o.z, o.size, o.sub])));
		expect(oresOf(1, 10, 10).length).toBeGreaterThan(50); expect(oresOf(1, 10, 10).length).toBeLessThanOrEqual(24 + 12 + 24 + 10 + 5 + 20 + 4 + 8 + 4 + 1 + 20);
		for (const o of oresOf(1, 10, 10)) { expect(o.x >> 4).toBe(10); expect(o.z >> 4).toBe(10); expect(o.y).toBeGreaterThanOrEqual(o.ore.y0); expect(o.y).toBeLessThanOrEqual(o.ore.y1); expect(o.size).toBeGreaterThanOrEqual(o.ore.s0); expect(o.size).toBeLessThanOrEqual(o.ore.s1); }
		const subs = new Set(oresOf(1, 10, 10).map((o) => o.sub)); expect(subs.size).toBe(oresOf(1, 10, 10).length);
		expect(blobsOf(1, 3, 3).length).toBe(5 + 5 + 5 + 8 + 2); expect(pocketsOf(1, 3, 3).length).toBe(9 + 10 + 1); expect(poolsOf(1, 3, 3).length).toBe(4);
		let g = 0; for (let cz = 0; cz < 32; cz++) for (let cx = 0; cx < 32; cx++) g += geodesOf(1, cx, cz).length; expect(g).toBeGreaterThanOrEqual(16); expect(g).toBeLessThanOrEqual(69); // §11.8
	});
	it('§11.7 / §11.8 / §11.2 / §11.13 on one full map (seed 1)', () => {
		const M = fullMap(1); expect(M.replaysBad).toBe(0); expect(M.instMax).toBeLessThanOrEqual(580);
		let outOfBand = 0, dsAbove = 0, plainBelow = 0, tuffHigh = 0, budOrphan = 0, nonAir = 0; const cnt = new Map<number, number>();
		const oreByX = new Array(16).fill(0), oreByZ = new Array(16).fill(0), solidByX = new Array(16).fill(0), solidByZ = new Array(16).fill(0);
		let cb = 0, cbn = 0, ci = 0, cin = 0, cbz = 0, cbzn = 0, ciz = 0, cizn = 0;
		for (let z = 0; z < 512; z++) for (let x = 0; x < 512; x++) for (let y = 1; y < 256; y++) {
			const v = M.get(x, y, z); if (v === 0) continue; nonAir++; cnt.set(v, (cnt.get(v) ?? 0) + 1);
			if (v === V3.tuff && y >= 66) tuffHigh++;
			if (v === V3.budding_amethyst && ![M.get(x + 1, y, z), M.get(x - 1, y, z), M.get(x, y, z + 1), M.get(x, y, z - 1), M.get(x, y + 1, z), M.get(x, y - 1, z)].some((w) => w === V3.amethyst_block || w === V3.calcite || w === V3.smooth_basalt)) budOrphan++;
			if (ORE_IDS.has(v)) {
				const fam = FAMILY.get(v)!; if (!BANDS_HAND[fam].some(([a, b]) => y >= a && y <= b)) outOfBand++;
				const isDeep = [...ORE_DEEPSLATE.values()].includes(v); if (isDeep && y >= 52) dsAbove++; if (!isDeep && y < 44) plainBelow++;
				oreByX[x & 15]++; oreByZ[z & 15]++;
				const e = M.get(x + 1, y, z); if ((x & 15) === 15) { cbn++; if (e === v) cb++; } else if ((x & 15) === 7) { cin++; if (e === v) ci++; }
				const s = M.get(x, y, z + 1); if ((z & 15) === 15) { cbzn++; if (s === v) cbz++; } else if ((z & 15) === 7) { cizn++; if (s === v) ciz++; }
			}
			if (!isLiquidId(v)) { solidByX[x & 15]++; solidByZ[z & 15]++; }
		}
		expect(outOfBand).toBe(0); expect(dsAbove).toBe(0); expect(plainBelow).toBe(0); expect(tuffHigh).toBe(0); expect(budOrphan).toBe(0);
		const pct = (id: number) => (100 * (cnt.get(id) ?? 0)) / nonAir;
		expect(pct(V3.granite)).toBeGreaterThanOrEqual(1.7); expect(pct(V3.granite)).toBeLessThanOrEqual(2.1); expect(pct(V3.tuff)).toBeGreaterThanOrEqual(4.1); expect(pct(V3.tuff)).toBeLessThanOrEqual(5.05);
		expect(pct(V3.calcite)).toBeGreaterThanOrEqual(0.34); expect(pct(V3.calcite)).toBeLessThanOrEqual(0.44); expect(pct(V3.gravel)).toBeGreaterThanOrEqual(1.3); expect(pct(V3.gravel)).toBeLessThanOrEqual(1.96);
		const amethyst = cnt.get(V3.amethyst_block) ?? 0; expect(amethyst).toBeGreaterThanOrEqual(1750); expect(amethyst).toBeLessThanOrEqual(9150);
		const perChunk = (n: string) => ((cnt.get(V3[`${n}_ore` as keyof typeof V3]) ?? 0) + (cnt.get(V3[`deepslate_${n}_ore` as keyof typeof V3]) ?? 0)) / 1024;
		expect(perChunk('coal')).toBeGreaterThanOrEqual(78); expect(perChunk('coal')).toBeLessThanOrEqual(158); expect(perChunk('iron')).toBeGreaterThanOrEqual(71); expect(perChunk('iron')).toBeLessThanOrEqual(104);
		expect(perChunk('copper')).toBeGreaterThanOrEqual(67); expect(perChunk('copper')).toBeLessThanOrEqual(77); expect(perChunk('gold')).toBeGreaterThanOrEqual(25); expect(perChunk('gold')).toBeLessThanOrEqual(34.5);
		expect(perChunk('lapis')).toBeGreaterThanOrEqual(18.6); expect(perChunk('lapis')).toBeLessThanOrEqual(20.5); expect(perChunk('redstone')).toBeGreaterThanOrEqual(40); expect(perChunk('redstone')).toBeLessThanOrEqual(46.5);
		expect(perChunk('diamond')).toBeGreaterThanOrEqual(13.1); expect(perChunk('diamond')).toBeLessThanOrEqual(15.2); expect(perChunk('emerald')).toBeLessThanOrEqual(12);
		// §11.2 seams, x and z: bin density within ±0.15 pts of the interior; border continuity within ±3 pts of interior
		const dx = oreByX.map((o, i) => (100 * o) / solidByX[i]); const inX = (dx[7] + dx[8]) / 2; for (const d of dx) expect(Math.abs(d - inX)).toBeLessThanOrEqual(0.15);
		const dz = oreByZ.map((o, i) => (100 * o) / solidByZ[i]); const inZ = (dz[7] + dz[8]) / 2; for (const d of dz) expect(Math.abs(d - inZ)).toBeLessThanOrEqual(0.15);
		expect(Math.abs((100 * cb) / cbn - (100 * ci) / cin)).toBeLessThanOrEqual(3); expect(Math.abs((100 * cbz) / cbzn - (100 * ciz) / cizn)).toBeLessThanOrEqual(3);
	}, 120_000);
	it('§11.14 pools: every placed pool voxel has 4 solid-or-liquid sides and a solid below; ore voxels replaced only stone/deepslate (checked via a no-feature comparison)', () => {
		// pools: assert over the voxels pool() actually WROTE (ctx.poolLog), never by scanning the column — the lava sea (y ≤ 10) sits inside a naive scan window (gate 2 closure).
		let written = 0;
		for (let cz = 14; cz <= 17; cz++) for (let cx = 14; cx <= 17; cx++) {
			const log: number[] = []; const c = new Chunk(cx, cz, 256); generateChunkV3(c, 2, { poolLog: log }); written += log.length; // poolLog rides on the Capture parameter (Task 3)
			for (const i of log) {
				const yy = (i / 256) | 0, lz = ((i % 256) / 16) | 0, lx = i % 16; expect(isLiquidId(c.get(lx, yy, lz))).toBe(true);
				const solidOrLiq = (x: number, y: number, z: number) => x >= 0 && x < 16 && z >= 0 && z < 16 ? c.get(x, y, z) !== 0 : true; // outside the chunk is unknowable here; the full-map check is Task 7's
				expect(solidOrLiq(lx + 1, yy, lz) && solidOrLiq(lx - 1, yy, lz) && solidOrLiq(lx, yy, lz + 1) && solidOrLiq(lx, yy, lz - 1)).toBe(true); expect(c.get(lx, yy - 1, lz) !== 0 && !isLiquidId(c.get(lx, yy - 1, lz))).toBe(true);
			}
		}
		// non-vacuity over the 4×4 block, not per chunk: seed 2 has 64 pool instances here but only 4 chunks place one (the prototype agrees exactly: 335 pools per map, same chunks).
		expect(written).toBeGreaterThan(0);
		// §11.7 "every ore voxel replaced stone or deepslate": the vein Setter bumps T7_ORE_BAD whenever it WRITES an ore over a pre-write id that is not literally stone/deepslate (exact, per voxel, at write time; a step left alone is not a violation).
		T7_ORE_BAD.count = 0; for (let cz = 8; cz < 12; cz++) for (let cx = 8; cx < 12; cx++) { const c = new Chunk(cx, cz, 256); generateChunkV3(c, 2); } expect(T7_ORE_BAD.count).toBe(0);
		// and the cheap sanity clauses: no ore at y 0 (bedrock) and none above 230.
		const c = new Chunk(16, 16, 256); generateChunkV3(c, 2); for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) { expect(ORE_IDS.has(c.get(lx, 0, lz))).toBe(false); for (let y = 231; y < 256; y++) expect(ORE_IDS.has(c.get(lx, y, lz))).toBe(false); }
		void isStoneId;
	});
});
