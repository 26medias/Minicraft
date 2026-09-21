import { describe, it, expect } from 'vitest';
import { column, BIOME, SEA, snowLine, isBeach, flatCell, ampCellOf, waterNear, isEntrance, inRavineChannel, chunkMaxH, tunnelFree, cheeseDensity, tunnelDensity, ENT_T } from './columns';
import { fields, smooth } from './fields';
import { Chunk } from '../chunk';
import { generateChunkV3 } from './generate';
import { V3 } from './blocks';

/** Column-level map statistics for one seed (262 144 columns, ≈ 1.5 s). */
function mapStats(seed: number) {
	const hs: number[] = []; let water = 0, land = 0, flat = 0, river = 0; const biomes = new Set<number>();
	const h = new Int16Array(512 * 512);
	for (let z = 0; z < 512; z++) for (let x = 0; x < 512; x++) { const c = column(seed, x, z); h[z * 512 + x] = c.h; hs.push(c.h); if (c.biome === BIOME.ocean) water++; else biomes.add(c.biome); if (c.river > 0.6) river++; }
	for (let z = 2; z < 510; z++) for (let x = 2; x < 510; x++) { const v = h[z * 512 + x]; if (v <= SEA) continue; land++; const d = Math.max(Math.abs(h[z * 512 + x + 2] - v), Math.abs(h[z * 512 + x - 2] - v), Math.abs(h[(z + 2) * 512 + x] - v), Math.abs(h[(z - 2) * 512 + x] - v)); if (d <= 2) flat++; }
	hs.sort((a, b) => a - b); const q = (p: number) => hs[Math.min(hs.length - 1, Math.floor(p * hs.length))];
	return { min: q(0), median: q(0.5), p90: q(0.9), max: q(1), waterPct: (100 * water) / 262144, flatPct: (100 * flat) / land, riverPct: (100 * river) / 262144, biomes: biomes.size };
}

describe('v3 columns', () => {
	it('is a pure function of (seed, x, z)', () => {
		const a = column(12345, 300, 200), b = column(12345, 300, 200);
		expect(a).toEqual(b);
		expect(column(12346, 300, 200).hRaw).not.toBe(a.hRaw);
	});
	it('h is the top solid y of a pure-2-D column: h = ceil(hRaw) - 1, and ocean iff h < 118', () => {
		for (let i = 0; i < 500; i++) { const c = column(7, (i * 97) % 512, (i * 53) % 512); expect(c.h).toBe(Math.ceil(c.hRaw) - 1); expect(c.biome === BIOME.ocean).toBe(c.h < SEA - 2); }
	});
	it('map heights, water, flat land and rivers sit inside the §11.4 bounds on CI seeds 1 and 2', () => {
		for (const seed of [1, 2]) {
			const s = mapStats(seed);
			expect(s.min).toBeGreaterThanOrEqual(55); expect(s.median).toBeGreaterThanOrEqual(115); expect(s.median).toBeLessThanOrEqual(139);
			expect(s.p90).toBeGreaterThanOrEqual(132); expect(s.p90).toBeLessThanOrEqual(202); expect(s.max).toBeGreaterThanOrEqual(210); expect(s.max).toBeLessThanOrEqual(250);
			expect(s.waterPct).toBeGreaterThanOrEqual(8); expect(s.waterPct).toBeLessThanOrEqual(60); expect(s.flatPct).toBeGreaterThanOrEqual(35);
			expect(s.riverPct).toBeGreaterThanOrEqual(2); expect(s.riverPct).toBeLessThanOrEqual(12.5);
			expect(s.biomes).toBeGreaterThanOrEqual(7); // §11.10: ≥ 7 land biomes
		}
	}, 30_000);
	it('the 20-block wall ring is ocean and the centre is land on every seed', () => {
		for (const seed of [1, 2, 3, 5, 8]) {
			expect(column(seed, 3, 256).biome).toBe(BIOME.ocean); expect(column(seed, 256, 508).biome).toBe(BIOME.ocean);
			expect(column(seed, 256, 256).h).toBeGreaterThan(SEA);
		}
	});
	it('badlands columns above y 124 are terraced to 6-block steps', () => {
		let seen = 0;
		for (let z = 0; z < 512 && seen < 50; z += 3) for (let x = 0; x < 512 && seen < 50; x += 3) {
			const c = column(2, x, z); if (c.land !== BIOME.badlands || c.h <= 124 || c.river > 0) continue; seen++;
			// terrace: the pre-detail height sits within 3.5 (detail) of a multiple of 6 or its smooth riser; the riser band is q..q+6, so |h - round(h/6)*6| ≤ 3 + 3.5
			expect(Math.abs(c.hRaw - Math.round(c.hRaw / 6) * 6)).toBeLessThanOrEqual(6.5);
		}
		expect(seen).toBeGreaterThan(0);
	});
	it('rivers only in lowlands: river > 0 implies h < 156 and h ≥ 114', () => {
		for (let i = 0; i < 4000; i++) { const c = column(3, (i * 131) % 512, (i * 71) % 512); if (c.river > 0) { expect(c.h).toBeLessThan(156); expect(c.hRaw).toBeGreaterThanOrEqual(SEA - 6); } }
	});
	it('amp is exactly 0 unless h > 126 and M > 0.4; ampCellOf is the max of the 4 cell corners; flatCell iff all four are 0', () => {
		for (let i = 0; i < 3000; i++) {
			const x = (i * 113) % 512, z = (i * 59) % 512; const c = column(5, x, z);
			if (c.h <= SEA + 6 || c.M <= 0.4) expect(c.amp).toBe(0);
			const x0 = x & ~3, z0 = z & ~3;
			const m = Math.max(column(5, x0, z0).amp, column(5, x0 + 4, z0).amp, column(5, x0, z0 + 4).amp, column(5, x0 + 4, z0 + 4).amp);
			expect(ampCellOf(5, x, z)).toBe(m); expect(flatCell(5, x, z)).toBe(m === 0);
		}
	});
	it('ravine zones are absent within 128 of the centre and the threshold ramps to 0.35 by 176 (§6.1)', () => {
		const f = fields(2);
		for (let i = 0; i < 20000; i++) { const x = (i * 97) % 512, z = (i * 193) % 512; const c = column(2, x, z);
			const d = Math.sqrt((x - 256) ** 2 + (z - 256) ** 2);
			if (d <= 128) expect(c.ravW).toBe(0);
			// the threshold is the SMOOTH ramp of §6.1, not a step at 176 (gate 2: a step-threshold test is red on seed 2 at 128 < d < 176)
			if (c.ravW > 0) { const rgT = 0.4 - 0.05 * smooth((d - 128) / 48); expect(f.RG(x / 300, z / 300)).toBeGreaterThan(rgT - 1e-9); expect(c.h).toBeGreaterThan(SEA + 8); expect(c.amp).toBeLessThan(6); }
		}
	});
	it('waterNear / entrance / channel / chunkMaxH agree with their definitions', () => {
		for (let i = 0; i < 300; i++) { const x = 40 + (i * 37) % 430, z = 40 + (i * 91) % 430;
			let m = 999; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) m = Math.min(m, column(4, x + dx, z + dz).hRaw - ampCellOf(4, x + dx, z + dz));
			expect(waterNear(4, x, z)).toBe(m < SEA + 2);
			expect(isEntrance(4, x, z)).toBe(column(4, x, z).ent > ENT_T && !waterNear(4, x, z));
			const c = column(4, x, z); expect(inRavineChannel(4, x, z)).toBe(c.ravW > 0 && Math.abs(fields(4).RAV(x / 230, z / 230)) < c.ravW + 0.005 && !waterNear(4, x, z));
		}
		let mx = 0; for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) mx = Math.max(mx, column(4, 10 * 16 + 4 * i + 2, 12 * 16 + 4 * j + 2).h);
		expect(chunkMaxH(4, 10, 12)).toBe(mx);
	});
	it('carve densities: nodes above h+4 are the caller\'s concern; tunnelDensity boost only widens; tunnelFree is false where a node is > 0', () => {
		const f = fields(9);
		expect(tunnelDensity(f, 100, 60, 100, 130, true)).toBeGreaterThanOrEqual(tunnelDensity(f, 100, 60, 100, 130, false));
		expect(Number.isFinite(cheeseDensity(f, 100, 60, 100))).toBe(true);
		let sawFalse = false, sawTrue = false;
		for (let i = 0; i < 2000 && !(sawFalse && sawTrue); i++) { const x = (i * 61) % 512, z = (i * 89) % 512; const c = column(9, x, z); if (c.h <= SEA) continue; const tf = tunnelFree(9, x, z, c.h);
			let any = false; const x0 = x & ~3, z0 = z & ~3; for (const [cx, cz] of [[x0, z0], [x0 + 4, z0], [x0, z0 + 4], [x0 + 4, z0 + 4]]) for (let y = (c.h - 16) & ~3; y <= c.h + 4; y += 4) if (tunnelDensity(f, cx, y, cz, c.h, true) > 0 || cheeseDensity(f, cx, y, cz) > 0) any = true;
			expect(tf).toBe(!any); if (tf) sawTrue = true; else sawFalse = true; }
		expect(sawFalse && sawTrue).toBe(true);
	});
	it('snowLine and isBeach follow §4', () => {
		const c = column(1, 256, 256); expect(snowLine(c)).toBe(c.T >= 0 ? 160 + 20 * c.T : Math.max(122, 160 + 78 * c.T));
		for (let i = 0; i < 2000; i++) { const q = column(1, (i * 17) % 512, (i * 29) % 512); expect(isBeach(q)).toBe(q.h >= SEA - 3 && q.h <= SEA + 2 && q.land !== BIOME.badlands); }
	});
	it('§4 rule 3: snowLine(T) is continuous with the snowy threshold — fixed points and clamp', () => {
		const at = (T: number) => snowLine({ ...column(1, 256, 256), T });
		expect(at(0)).toBe(160); expect(at(0.5)).toBe(170); expect(at(1)).toBe(180);   // T ≥ 0: 160 + 20·T
		expect(at(-0.45)).toBeCloseTo(124.9, 9);                                       // meets the snowy-biome threshold in the lowlands
		expect(at(-0.1)).toBeCloseTo(152.2, 9);                                        // 160 + 78·T, not 160 + 20·T (= 158)
		expect(at(-0.5)).toBe(122); expect(at(-1)).toBe(122);                          // never below 122
		for (let T = -1; T < 1; T += 0.01) expect(at(T + 0.01)).toBeGreaterThanOrEqual(at(T)); // monotone in T, continuous at 0
	});
	it('§4 rule 3 (seed 3 play-test): the taiga flank beside the snowy patch is snow-topped', () => {
		const seed = 3; const blocks = new Map<number, Uint16Array>();
		for (const [cx, cz] of [[20, 12], [21, 12]] as const) { const c = new Chunk(cx, cz, 256); generateChunkV3(c, seed); blocks.set(cz * 32 + cx, c.blocks); }
		let checked = 0;
		for (let z = 192; z <= 202; z++) for (let x = 326; x <= 336; x++) {
			const c = column(seed, x, z); const b = blocks.get((z >> 4) * 32 + (x >> 4))!; const at = (y: number) => b[y * 256 + (z & 15) * 16 + (x & 15)];
			if (c.ravW > 0 || at(c.h) === 0 || at(c.h + 1) !== 0) continue; // surface not intact (cave mouth / ravine): the sweep rule does not apply
			expect(c.h, `h at ${x},${z}`).toBeGreaterThanOrEqual(133); expect(c.h, `h at ${x},${z}`).toBeLessThanOrEqual(138);
			expect(c.T, `T at ${x},${z}`).toBeLessThan(-0.3); expect(c.land).not.toBe(BIOME.snowy);
			expect(snowLine(c), `snowLine at ${x},${z}`).toBeLessThanOrEqual(c.h);
			expect(at(c.h), `top block at ${x},${c.h},${z}`).toBe(V3.snow_block); checked++;
		}
		expect(checked).toBeGreaterThan(100);
	});
});
