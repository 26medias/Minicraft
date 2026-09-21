// 100-seed spawn + kid-target checker. Usage: tsx kid.ts [firstSeed] [count]
import { generateChunkV3, spawnInfo, column, SEA, BIOME_NAME, B } from './proto.ts';
import * as P from './proto.ts';
const first = Number(process.argv[2] ?? 1000), count = Number(process.argv[3] ?? 100);
const H = 256; const LOGS = new Set([70, 72, 74, 76, 78]), LEAVES = new Set([71, 73, 75, 77, 79]);
const isLiq = (v: number) => v === 17 || v === 18;
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const agg: Record<string, number[]> = {}; const push = (k: string, v: number) => { (agg[k] ??= []).push(v); };
let fails = 0, censored = 0; const biomes = new Map<string, number>();
for (let seed = first; seed < first + count; seed++) {
	const si = spawnInfo(seed); const sx = si.x, sz = si.z; const c = column(seed, sx, sz);
	push('spawn.ms', si.ms); push('spawn.work', si.work); push('spawn.offset', Math.hypot(sx - 256, sz - 256)); push('spawn.h', c.h); push('spawn.buildable', 100 * si.buildable);
	biomes.set(BIOME_NAME[c.biome], (biomes.get(BIOME_NAME[c.biome]) ?? 0) + 1);
	const world = new Map<number, Uint16Array>(); const R = 7;
	for (let cz = (sz >> 4) - R; cz <= (sz >> 4) + R; cz++) for (let cx = (sx >> 4) - R; cx <= (sx >> 4) + R; cx++) { if (cx < 0 || cz < 0 || cx > 31 || cz > 31) continue; const b = new Uint16Array(16 * H * 16); generateChunkV3(b, seed, cx, cz); world.set(cz * 32 + cx, b); }
	const get = (x: number, y: number, z: number) => { const b = world.get((z >> 4) * 32 + (x >> 4)); if (!b || y < 0 || y > 255) return -1; return b[y * 256 + (z & 15) * 16 + (x & 15)]; };
	const topOf = (x: number, z: number) => { let y = 255; while (y > 0 && get(x, y, z) === 0) y--; return y; };
	const terrTop = (x: number, z: number) => { let y = 255; while (y > 0 && (get(x, y, z) === 0 || get(x, y, z) >= 70)) y--; return y; };
	// strict spawn safety
	const y = topOf(sx, sz); const t = get(sx, y, sz);
	let treeNear = false; for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) for (let yy = y - 2; yy <= y + 12; yy++) { const v = get(sx + dx, yy, sz + dz); if (LOGS.has(v) || LEAVES.has(v)) treeNear = true; }
	const ok = y === c.h && t !== 0 && !isLiq(t) && t !== B.snow && t !== B.ice && get(sx, y + 1, sz) === 0 && get(sx, y + 2, sz) === 0 && y >= SEA + 2 && !treeNear;
	if (!ok) { fails++; console.log(`FAIL seed ${seed} at ${sx},${sz}: top ${t} y ${y} h ${c.h} treeNear ${treeNear}`); }
	// buildable (voxel-level): dry, river-free, |top − spawn top| ≤ 3 within Chebyshev 24
	{ let n = 0; for (let dz = -24; dz <= 24; dz++) for (let dx = -24; dx <= 24; dx++) { const tt = topOf(sx + dx, sz + dz); const v = get(sx + dx, tt, sz + dz); if (!isLiq(v) && v !== 40 && Math.abs(tt - y) <= 3 && column(seed, sx + dx, sz + dz).river === 0) n++; } push('buildable24.pct', 100 * n / 2401); }
	// open-sky single-step drop within 32: max over adjacent column pairs of top difference
	{ let maxDrop = 0; for (let dz = -32; dz <= 32; dz++) for (let dx = -32; dx <= 32; dx++) { const a = terrTop(sx + dx, sz + dz); const b1 = terrTop(sx + dx + 1, sz + dz), b2 = terrTop(sx + dx, sz + dz + 1); maxDrop = Math.max(maxDrop, Math.abs(a - b1), Math.abs(a - b2)); } push('drop32.max', maxDrop); }
	{ let maxStep = 0; for (let dz = -64; dz <= 64; dz++) for (let dx = -64; dx <= 64; dx++) { const x = sx + dx, z = sz + dz; if (x < 1 || z < 1 || x > 510 || z > 510) continue; const a = terrTop(x, z); for (const [ex, ez] of [[1, 0], [0, 1]]) { const b = terrTop(x + ex, z + ez); const lo = Math.min(a, b); if (lo <= SEA) continue; maxStep = Math.max(maxStep, Math.abs(a - b)); } } push('step64.noCoast', maxStep); }
	{ let nr = 999; for (let dz = -64; dz <= 64; dz++) for (let dx = -64; dx <= 64; dx++) { const x = sx + dx, z = sz + dz; if (x < 0 || z < 0 || x > 511 || z > 511) continue; const d = Math.max(Math.abs(dx), Math.abs(dz)); if (d < nr && column(seed, x, z).ravW > 0 && P.inRavineChannel(seed, x, z)) nr = d; } push('nearestRavineChannel', nr); }
	{ let holes = 0, pock = 0, land = 0; const hole = new Map<number, boolean>();
		for (let dz = -64; dz <= 64; dz++) for (let dx = -64; dx <= 64; dx++) { const x = sx + dx, z = sz + dz; if (x < 1 || z < 1 || x > 510 || z > 510) continue; const cc = column(seed, x, z); if (cc.h <= SEA) continue; land++; const t = terrTop(x, z); if (t < cc.h - 3) pock++;
			let minN = 999; for (let ez = -1; ez <= 1; ez++) for (let ex = -1; ex <= 1; ex++) { if (!ex && !ez) continue; minN = Math.min(minN, terrTop(x + ex, z + ez)); } if (minN - t >= 4) hole.set(x * 1024 + z, true); }
		// group holes: a hole of 1-2 columns = hole column whose 8-neighbourhood contains at most 1 other hole column
		for (const k of hole.keys()) { const x = k / 1024 | 0, z = k % 1024; let n = 0; for (let ez = -1; ez <= 1; ez++) for (let ex = -1; ex <= 1; ex++) { if (!ex && !ez) continue; if (hole.has((x + ex) * 1024 + z + ez)) n++; } if (n <= 1) holes++; }
		push('smallHoles64', holes); push('pockmark64.pct', 100 * pock / Math.max(1, land)); }
	// first ore in a 3x3 shaft; longest boring stretch (no new block type) in the 3x3 shaft
	{ let firstOre = 999; let run = 0, longest = 0; // boring = every voxel of the 3x3 layer is plain stone or deepslate
		for (let yy = y; yy > 0; yy--) { let plain = true; for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const v = get(sx + dx, yy, sz + dz); if (v >= 50 && v <= 67 && firstOre === 999) firstOre = y - yy; if (v !== B.stone && v !== B.deepslate) plain = false; }
			if (yy === 51) plain = false; // the stone→deepslate transition (y 44–52) counts as a new block type
			if (!plain) { longest = Math.max(longest, run); run = 0; } else run++; if (yy === 1) longest = Math.max(longest, run); }
		if (firstOre === 999) censored++;
		push('firstOre.blocks', firstOre); push('boringStretch.max', longest); }
	// real cave mouth at column c: >= 6 'open' columns (terrain top < h-3, air above) in the 9x9 around c, c itself open, an entry step <= 5 from some 8-neighbour that is not open,
	// and roofed air reachable from c's floor through air (6-conn, within Chebyshev 8) that lies >= 8 below the surface of its column
	const openCol = (x: number, z: number) => { const cc = column(seed, x, z); if (cc.h <= SEA) return false; let ys = terrTop(x, z); if (isLiq(get(x, ys, z))) return false; return ys < cc.h - 3 && get(x, ys + 1, z) === 0; };
	const isMouth = (x: number, z: number) => { if (!openCol(x, z)) return false; let open = 0; for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) if (openCol(x + dx, z + dz)) open++; if (open < 6) return false;
		const floor = terrTop(x, z); let entry = false; for (let dz = -1; dz <= 1 && !entry; dz++) for (let dx = -1; dx <= 1 && !entry; dx++) { if (!dx && !dz) continue; if (!openCol(x + dx, z + dz) && terrTop(x + dx, z + dz) - floor <= 5) entry = true; } if (!entry) return false;
		const seen = new Set<number>(); const st: number[] = [x, floor + 1, z]; seen.add((floor + 1) * 65536 * 4 + (z & 1023) * 1024 + (x & 1023)); let n = 0;
		while (st.length && n < 20000) { const zz = st.pop()!, yy = st.pop()!, xx = st.pop()!; n++; const ch = column(seed, xx, zz); if (yy <= ch.h - 8) { let roofed = false; for (let y2 = yy + 1; y2 <= ch.h + 4 && !roofed; y2++) if (get(xx, y2, zz) > 0 && get(xx, y2, zz) < 70 && !isLiq(get(xx, y2, zz))) roofed = true; if (roofed) return true; }
			for (const [ex, ey, ez] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) { const nx = xx + ex, ny = yy + ey, nz = zz + ez; if (Math.abs(nx - x) > 8 || Math.abs(nz - z) > 8 || ny < 1 || ny > 250 || get(nx, ny, nz) !== 0) continue; const k = ny * 65536 * 4 + (nz & 1023) * 1024 + (nx & 1023); if (seen.has(k)) continue; seen.add(k); st.push(nx, ny, nz); } }
		return false; };
	// nearest tree base, nearest cave mouth (column whose terrain top < column().h − 4 with air above, h > 120), within ±48
	{ let nt = 999, nm = 999;
		for (let z = sz - 96; z <= sz + 96; z++) for (let x = sx - 96; x <= sx + 96; x++) { const d = Math.hypot(x - sx, z - sz); if (x < 0 || z < 0 || x > 511 || z > 511) continue;
			if (d < nt) { const tt = topOf(x, z); for (let yy = tt; yy >= tt - 12 && yy > 0; yy--) if (LOGS.has(get(x, yy, z))) { nt = d; break; } }
			if (d < nm && isMouth(x, z)) nm = d; }
		push('nearestTree', nt); push('nearestMouth', nm); }
	{ let nb = 999; for (let r = 1; r < 200 && nb === 999; r++) for (let a = 0; a < 16; a++) if (column(seed, Math.round(sx + r * Math.cos(a)), Math.round(sz + r * Math.sin(a))).biome !== c.biome) { nb = r; break; } push('nearestOtherBiome', nb); }
	// emerald within 32 of spawn
	{ let em = 0; for (let dz = -32; dz <= 32; dz++) for (let dx = -32; dx <= 32; dx++) for (let yy = 60; yy < 256; yy++) { const v = get(sx + dx, yy, sz + dz); if (v === 57 || v === 67) em++; } push('emeraldWithin32', em); }
	// biome run lengths along 4 × 64 walks
	{ const runs: number[] = []; for (const [ddx, ddz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { let prev = -1, run = 0; for (let s = 0; s < 64; s++) { const b = column(seed, sx + ddx * s, sz + ddz * s).biome; if (b !== prev) { if (prev >= 0) runs.push(run); prev = b; run = 0; } run++; } } push('biomeRunMin', runs.length ? q(runs, 0) : 64); push('biomeShortRuns', runs.filter((r) => r < 6).length); }
}
console.log(`spawn strict failures over ${count} seeds: ${fails}; first-ore censored (no ore before the lava sea) ${censored}`);
for (const [k, v] of Object.entries(agg).sort()) console.log(`${k.padEnd(20)} p10 ${q(v, 0.1).toFixed(1)}  p50 ${q(v, 0.5).toFixed(1)}  p90 ${q(v, 0.9).toFixed(1)}  max ${q(v, 1).toFixed(1)}`);
console.log('spawn biomes:', [...biomes.entries()].map(([k, v]) => `${k} ${v}`).join(', '));
