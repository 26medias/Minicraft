import { fields } from './fields';
import { column, type Col, BIOME, SEA, ENT_T, snowLine, isBeach, flatCell, tunnelFree, tunnelDensity, cheeseDensity } from './columns';
import { treesOf, type TreeInst } from './trees';

export type SpawnInfo = { x: number; z: number; h: number; buildable: number; ringsSearched: number; work: number; pass: number };
const PASSES: [number, boolean, number][] = [[130, true, 0.4], [SEA + 2, true, 0.4], [SEA + 2, false, 0.4], [SEA + 2, false, 0]];

/** §9: work-bounded (rings ≤ 128 × 4 passes), never time-bounded. Computed once per new world by main.ts. */
export function spawnV3(seed: number): SpawnInfo {
	let work = 0;
	const cache = new Map<number, Col>(); const colC = (x: number, z: number) => { const k = x * 1024 + z; let c = cache.get(k); if (!c) { c = column(seed, x, z); cache.set(k, c); work++; } return c; };
	const treeCache = new Map<number, TreeInst[]>(); const trees = (cx: number, cz: number) => { const k = cx * 64 + cz; let t = treeCache.get(k); if (!t) { t = cx < 0 || cz < 0 || cx > 31 || cz > 31 ? [] : treesOf(seed, cx, cz); treeCache.set(k, t); } return t; };
	const canopyNear = (x: number, z: number) => { for (let dcz = -1; dcz <= 1; dcz++) for (let dcx = -1; dcx <= 1; dcx++) for (const t of trees((x >> 4) + dcx, (z >> 4) + dcz)) if (Math.abs(t.x - x) <= 7 && Math.abs(t.z - z) <= 7) return true; return false; };
	const f = fields(seed);
	const waterNearC = (x: number, z: number) => { let m = 999; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const q = colC(x + dx, z + dz); const x0 = (x + dx) & ~3, z0 = (z + dz) & ~3; const ac = Math.max(colC(x0, z0).amp, colC(x0 + 4, z0).amp, colC(x0, z0 + 4).amp, colC(x0 + 4, z0 + 4).amp); m = Math.min(m, q.hRaw - ac); } return m < SEA + 2; };
	const chanCache = new Map<number, boolean>(); const channel = (x: number, z: number) => { const k = x * 1024 + z; let v = chanCache.get(k); if (v === undefined) { const c = colC(x, z); v = c.ravW > 0 && Math.abs(f.RAV(x / 230, z / 230)) < c.ravW + 0.005 && !waterNearC(x, z); chanCache.set(k, v); } return v; };
	const mouthCache = new Map<number, boolean>(); const mouthCorner = (cx: number, cz: number) => { const k = cx * 1024 + cz; let v = mouthCache.get(k); if (v === undefined) { const q = colC(cx, cz); v = false; if (q.h > SEA && q.ent > ENT_T && !waterNearC(cx, cz)) for (const y of [q.h - 8, q.h - 4, q.h]) if (tunnelDensity(f, cx, y & ~3, cz, q.h, true) > 0 || cheeseDensity(f, cx, y & ~3, cz) > 0) { v = true; break; } mouthCache.set(k, v); } return v; };
	const mouthNear = (x: number, z: number) => { for (let cz = (z - 40) & ~3; cz <= z + 40; cz += 4) for (let cx = (x - 40) & ~3; cx <= x + 40; cx += 4) { if (cx < 0 || cz < 0 || cx > 511 || cz > 511) continue; if (mouthCorner(cx, cz)) return true; } return false; };
	const buildable = (x: number, z: number, h: number) => { let n = 0; for (let dz = -24; dz <= 24; dz++) for (let dx = -24; dx <= 24; dx++) { const c = colC(x + dx, z + dz); if (c.h >= SEA + 1 && c.river === 0 && Math.abs(c.h - h) <= 3) n++; } return n / (49 * 49); };
	const ok = (x: number, z: number, minH: number, gentle: boolean, minBuild: number): number | null => {
		const c = colC(x, z);
		if (c.h < minH || c.river > 0 || c.ravW > 0 || c.land === BIOME.snowy || c.h >= snowLine(c) || isBeach(c)) return null;
		for (const [ex, ez] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [-1, -1], [1, -1], [-1, 1]]) if (Math.abs(colC(x + ex, z + ez).h - c.h) > 2) return null;
		if (!flatCell(seed, x, z) || canopyNear(x, z) || !tunnelFree(seed, x, z, c.h)) return null;
		const b = buildable(x, z, c.h); if (b < minBuild) return null;
		for (let dz = -64; dz <= 64; dz++) for (let dx = -64; dx <= 64; dx++) { const xx = x + dx, zz = z + dz; if (xx < 0 || zz < 0 || xx > 511 || zz > 511) continue; if (colC(xx, zz).ravW > 0 && channel(xx, zz)) return null; }
		if (!gentle) return b;
		for (let dz = -64; dz <= 64; dz++) for (let dx = -64; dx <= 64; dx++) { const q = colC(x + dx, z + dz); if (q.amp > 6) return null; if (Math.max(Math.abs(dx), Math.abs(dz)) <= 32 && (Math.abs(q.h - colC(x + dx + 1, z + dz).h) > 10 || Math.abs(q.h - colC(x + dx, z + dz + 1).h) > 10)) return null; } // gentle, tested BEFORE mouth
		if (!mouthNear(x, z)) return null;
		return b;
	};
	for (let p = 0; p < PASSES.length; p++) { const [minH, gentle, minBuild] = PASSES[p];
		for (let r = 0; r <= 128; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
			if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
			const x = 256 + dx, z = 256 + dz; const b = ok(x, z, minH, gentle, minBuild);
			if (b !== null) return { x, z, h: colC(x, z).h, buildable: b, ringsSearched: r, work, pass: p + 1 };
		}
	}
	return { x: 256, z: 256, h: colC(256, 256).h, buildable: 0, ringsSearched: 129, work, pass: 5 }; // documented fallback; never reached on measured seeds
}
