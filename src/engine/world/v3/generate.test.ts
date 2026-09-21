import { describe, it, expect } from 'vitest';
import { Chunk } from '../chunk';
import { generateChunkV3, W, type Capture } from './generate';
import { V3, isLiquidId, LOG_IDS, LEAF_IDS } from './blocks';
import { column, BIOME, SEA, isBeach, snowLine, isEntrance, waterNear, flatCell, inRavineChannel } from './columns';
import { fields } from './fields';

/** Generate an (x0..x1) × (z0..z1) block of chunks; `get` returns -1 outside it. (No `const H` here: an unused local fails `tsc --noEmit` under `noUnusedLocals` — gate 2.) */
function region(seed: number, cx0: number, cx1: number, cz0: number, cz1: number) {
	const m = new Map<number, Uint16Array>(); const kinds = new Map<number, Uint8Array>();
	for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) { const c = new Chunk(cx, cz, 256); const cap: Capture = {}; generateChunkV3(c, seed, cap); m.set(cz * 32 + cx, c.blocks); kinds.set(cz * 32 + cx, cap.kind!); }
	const get = (x: number, y: number, z: number) => { const b = m.get((z >> 4) * 32 + (x >> 4)); if (!b || y < 0 || y > 255 || x < 0 || z < 0) return -1; return b[y * 256 + (z & 15) * 16 + (x & 15)]; };
	const kind = (x: number, y: number, z: number) => kinds.get((z >> 4) * 32 + (x >> 4))![y * 256 + (z & 15) * 16 + (x & 15)];
	// First non-air, non-liquid, non-ice, non-tree voxel (the prototype checker's "first non-air non-tree"): stage 6 logs and leaves sit above h.
	const terr = (x: number, z: number) => { let y = 255; while (y > 0 && (get(x, y, z) === 0 || isLiquidId(get(x, y, z)) || get(x, y, z) === V3.ice || LOG_IDS.has(get(x, y, z)) || LEAF_IDS.has(get(x, y, z)))) y--; return y; };
	return { get, kind, terr, x0: cx0 * 16, x1: cx1 * 16 + 15, z0: cz0 * 16, z1: cz1 * 16 + 15 };
}

describe('generateChunkV3 — stages 2–4', () => {
	it('is deterministic and independent of generation order; resets W per chunk', () => {
		const a = new Chunk(10, 10, 256); generateChunkV3(a, 1); const n1 = W.nodes;
		generateChunkV3(new Chunk(11, 10, 256), 1); generateChunkV3(new Chunk(10, 11, 256), 1);
		const b = new Chunk(10, 10, 256); generateChunkV3(b, 1);
		expect(b.blocks).toEqual(a.blocks); expect(W.nodes).toBe(n1); expect(a.modified).toBe(false); expect(a.dirty).toBe(true);
	});
	it('§11.3: bedrock at y 0 only; nothing at y ≥ 253', () => {
		for (const [cx, cz] of [[0, 0], [16, 16], [31, 31], [5, 27]]) { const c = new Chunk(cx, cz, 256); generateChunkV3(c, 12345);
			for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) { expect(c.get(lx, 0, lz)).toBe(V3.bedrock); for (let y = 1; y < 256; y++) { const v = c.get(lx, y, lz); expect(v).not.toBe(V3.bedrock); if (y >= 253) expect(v).toBe(0); } } }
	});
	it('§11.13 work-bound: lattice nodes per chunk ≤ 1600 and counted at evaluation', () => {
		let mx = 0; for (let cz = 14; cz <= 17; cz++) for (let cx = 14; cx <= 17; cx++) { generateChunkV3(new Chunk(cx, cz, 256), 1); mx = Math.max(mx, W.nodes); expect(W.nodes).toBeGreaterThan(0); }
		expect(mx).toBeLessThanOrEqual(1600);
	});
	it('§11.2 shared lattice nodes: neighbours agree on S, Dch, Dtn, the entrance flag and caveCeil (incl. the chunk-31 planes)', () => {
		const rng = (() => { let s = 7919; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) / 16777216; }; })();
		const pairs: [number, number][] = [[30, 30], [30, 5], [5, 30]]; for (let n = 0; n < 5; n++) pairs.push([(rng() * 30) | 0, (rng() * 30) | 0]);
		let checked = 0;
		for (const seed of [1, 2]) for (const [cx, cz] of pairs) {
			const cap = (x: number, z: number) => { const c: Capture = {}; generateChunkV3(new Chunk(x, z, 256), seed, c); return c; };
			const A = cap(cx, cz), E = cap(cx + 1, cz), S = cap(cx, cz + 1); const NY = Math.min(A.NY!, E.NY!, S.NY!); const NX = 5;
			for (let iy = 0; iy < NY; iy++) for (let j = 0; j < NX; j++) for (const key of ['S', 'Dch', 'Dtn'] as const) {
				const a = A[key]![(iy * NX + j) * NX + 4], e = E[key]![(iy * NX + j) * NX + 0]; checked++; expect(Object.is(a, e) || a === e, `${key} +x ${cx},${cz} iy${iy} j${j}`).toBe(true);
				const a2 = A[key]![(iy * NX + 4) * NX + j], s2 = S[key]![(iy * NX + 0) * NX + j]; checked++; expect(Object.is(a2, s2) || a2 === s2, `${key} +z ${cx},${cz} iy${iy} j${j}`).toBe(true);
			}
			for (let j = 0; j < NX; j++) { expect(A.entFlag![j * NX + 4]).toBe(E.entFlag![j * NX + 0]); expect(A.entFlag![4 * NX + j]).toBe(S.entFlag![0 * NX + j]); }
			for (let j = 0; j < 16; j++) { const PW = A.PW!, PAD = A.PAD!; expect(A.caveCeil![(j + PAD) * PW + 16 + PAD]).toBe(E.caveCeil![(j + PAD) * PW + 0 + PAD]); expect(A.caveCeil![(16 + PAD) * PW + j + PAD]).toBe(S.caveCeil![(0 + PAD) * PW + j + PAD]); }
		}
		expect(checked).toBeGreaterThan(2000);
	}, 30_000);
	it('§11.5: no water/lava with air on a side or below across chunk planes; no water above 120; ice only at 120 in snowy land; §11.6: no cave-air at y ≤ 10', () => {
		for (const seed of [1, 2]) { const r = region(seed, 12, 19, 12, 19); // 8×8 chunks around the centre
			let bad = 0, lowAir = 0;
			for (let z = r.z0 + 1; z < r.z1; z++) for (let x = r.x0 + 1; x < r.x1; x++) for (let y = 1; y < 200; y++) {
				const v = r.get(x, y, z); if (v === 0) { if (y <= 10 && y < r.terr(x, z)) lowAir++; continue; }
				if (v === V3.water || v === V3.lava || v === V3.ice) {
					if (v !== V3.lava && y > SEA) bad++;
					if (v === V3.ice && (y !== SEA || column(seed, x, z).land !== BIOME.snowy)) bad++;
					if (v !== V3.ice && ([r.get(x + 1, y, z), r.get(x - 1, y, z), r.get(x, y, z + 1), r.get(x, y, z - 1)].includes(0) || r.get(x, y - 1, z) === 0)) bad++;
				}
			}
			expect(bad).toBe(0); expect(lowAir).toBe(0);
		}
	}, 60_000);
	it('§11.6 ceiling, both clauses: every cave-air voxel in a non-entrance non-ravine column has ≥ 6 solid above it in every non-entrance non-ravine column of its 3×3', () => {
		for (const seed of [1, 2]) { const r = region(seed, 13, 18, 13, 18); let viol = 0, n = 0;
			const ent = new Map<number, boolean>(), rav = new Map<number, boolean>(); const isEnt = (x: number, z: number) => { const k = x * 1024 + z; let v = ent.get(k); if (v === undefined) { v = isEntrance(seed, x, z); ent.set(k, v); } return v; }; const isRav = (x: number, z: number) => { const k = x * 1024 + z; let v = rav.get(k); if (v === undefined) { v = column(seed, x, z).ravW > 0; rav.set(k, v); } return v; };
			for (let z = r.z0 + 1; z < r.z1; z++) for (let x = r.x0 + 1; x < r.x1; x++) { if (isEnt(x, z) || isRav(x, z)) continue; const top = r.terr(x, z);
				for (let y = 1; y < top; y++) { if (r.kind(x, y, z) !== 2 && r.get(x, y, z) !== 0) continue; n++;
					for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, zz = z + dz; if (isEnt(xx, zz) || isRav(xx, zz)) continue; if (r.terr(xx, zz) - y < 6) viol++; } } }
			expect(n).toBeGreaterThan(1000); expect(viol).toBe(0);
		}
	}, 60_000);
	it('§4/§11.10 exact surface clauses on unbreached land columns; §4 deepslate blend; terracotta band index', () => {
		const seed = 2; const r = region(seed, 8, 23, 8, 23); let checked = 0, terra = 0;
		for (let z = r.z0; z <= r.z1; z += 2) for (let x = r.x0; x <= r.x1; x += 2) { const c = column(seed, x, z); const top = r.terr(x, z); const t = r.get(x, top, z);
			if (c.h > SEA && top === c.h && c.ravW === 0 && !isEntrance(seed, x, z)) { checked++;
				if (isBeach(c)) { expect([V3.sand, V3.gravel]).toContain(t); continue; }
				if (c.river > 0.6) continue;
				if (c.h >= snowLine(c) || c.land === BIOME.snowy) { expect(t).toBe(V3.snow_block); continue; }
				if (c.amp > 8) continue;
				if (c.land === BIOME.desert) expect(t).toBe(V3.sand);
				if (c.land === BIOME.plains || c.land === BIOME.forest || c.land === BIOME.cherry) expect(t).toBe(V3.grass_block);
			}
			if (c.h < SEA && top === c.h && c.biome === BIOME.ocean) expect([V3.sand, V3.gravel, V3.clay]).toContain(t);
			for (let y = 1; y < 256; y++) { const v = r.get(x, y, z); if (v === V3.deepslate) expect(y).toBeLessThan(52); if (v === V3.stone) expect(y).toBeGreaterThanOrEqual(44);
				if ([V3.terracotta, V3.orange_terracotta, V3.yellow_terracotta, V3.white_terracotta, V3.red_terracotta, V3.brown_terracotta, V3.light_gray_terracotta].includes(v)) { terra++; expect(c.land).toBe(BIOME.badlands); expect(y).toBeGreaterThanOrEqual(100);
					const band = [V3.terracotta, V3.orange_terracotta, V3.terracotta, V3.yellow_terracotta, V3.terracotta, V3.white_terracotta, V3.red_terracotta, V3.terracotta, V3.brown_terracotta, V3.orange_terracotta, V3.terracotta, V3.light_gray_terracotta, V3.terracotta, V3.red_terracotta, V3.orange_terracotta, V3.terracotta]; expect(v).toBe(band[y & 15]); } }
		}
		expect(checked).toBeGreaterThan(500);
	}, 60_000);
	it('§6.1/§11.15: every ravine-core column has a solid floor ≥ bottom − 1 and rim-to-floor ≤ 70', () => {
		const seed = 2; const f = fields(seed); let cores = 0;
		for (let cz = 0; cz < 32; cz += 1) for (let cx = 0; cx < 32; cx += 1) { // find ravine cores cheaply from columns, generate only those chunks
			let any = false; for (let lz = 0; lz < 16 && !any; lz += 4) for (let lx = 0; lx < 16 && !any; lx += 4) { const c = column(seed, cx * 16 + lx, cz * 16 + lz); if (c.ravW > 0) any = true; }
			if (!any) continue; const r = region(seed, cx, cx, cz, cz);
			for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) { const c = column(seed, x, z); if (c.ravW <= 0 || waterNear(seed, x, z)) continue; if (Math.abs(f.RAV(x / 230, z / 230)) >= c.ravW * 0.4) continue; cores++;
				const floor = r.terr(x, z); const bottom = Math.round(c.h - c.ravDepth); expect(floor).toBeGreaterThanOrEqual(bottom - 1); expect(c.h - floor).toBeLessThanOrEqual(70); }
			if (cores > 400) break;
		}
		expect(cores).toBeGreaterThan(0);
	}, 60_000);
	it('in a flat cell the top solid block is exactly h (§3.3)', () => {
		const r = region(3, 15, 16, 15, 16); let n = 0;
		for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) { if (!flatCell(3, x, z) || isEntrance(3, x, z) || inRavineChannel(3, x, z)) continue; const c = column(3, x, z); if (c.h <= SEA) continue; n++; expect(r.terr(x, z)).toBe(c.h); }
		expect(n).toBeGreaterThan(50);
	});
	it('§6 rule 5 / §11.15 open-sky pit cap: off ravine-carving columns no sky-open cave-air lies at y ≤ h − 24; roofed and shallow cave-air survive (seed 2, chunk (1,1), shaft at (16,16))', () => {
		const seed = 2; const cap: Capture = {}; generateChunkV3(new Chunk(1, 1, 256), seed, cap); const kind = cap.kind!;
		let deepOpen = 0, shallowOpen = 0, roofedDeep = 0, worst = 0;
		for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
			const x = 16 + lx, z = 16 + lz; const c = column(seed, x, z); if (c.ravW > 0 && !waterNear(seed, x, z)) continue;
			let y = 255; for (; y >= 1; y--) { const k = kind[y * 256 + lz * 16 + lx]; if (k === 1 || k === 3) break; if (k === 2) { if (y <= c.h - 24) { deepOpen++; worst = Math.max(worst, c.h - y); } else shallowOpen++; } }
			for (; y >= 1; y--) if (kind[y * 256 + lz * 16 + lx] === 2 && y <= c.h - 24) roofedDeep++;
		}
		expect(deepOpen, `sky-open cave-air below h − 24 (deepest ${worst})`).toBe(0);
		expect(shallowOpen).toBeGreaterThan(0); // the mouth is still there
		expect(roofedDeep).toBeGreaterThan(0); // roofed cave-air below h − 24 is untouched
	});
});
