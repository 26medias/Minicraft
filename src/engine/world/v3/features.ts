import type { Fields } from './fields';
import { V3, ORE_DEEPSLATE, isStoneId, isLiquidId } from './blocks';
import { streamSeed, subSeed, mulberry32, hashv, F } from './prng';
import { column, type Col, chunkMaxH, BIOME, SEA, MOUNTAIN_GATE } from './columns';
import { clamp } from './fields';
import { put, W, type Ctx, type Setter, PAD, PW } from './generate';

// Spec §7. Bands, attempts, sizes and gates are the spec's table; the plan's test transcribes them by hand, never from here.
export type Ore = { id: number; y0: number; peak: number; y1: number; attempts: number; s0: number; s1: number; mountain?: boolean; badlands?: boolean; chance?: number };
export const ORES: readonly Ore[] = [
	{ id: V3.coal_ore, y0: 60, peak: 128, y1: 200, attempts: 24, s0: 6, s1: 14 },
	{ id: V3.iron_ore, y0: 16, peak: 60, y1: 112, attempts: 12, s0: 4, s1: 9 },
	{ id: V3.iron_ore, y0: 140, peak: 185, y1: 230, attempts: 24, s0: 4, s1: 9, mountain: true },
	{ id: V3.copper_ore, y0: 50, peak: 92, y1: 130, attempts: 10, s0: 5, s1: 10 },
	{ id: V3.gold_ore, y0: 6, peak: 30, y1: 70, attempts: 5, s0: 4, s1: 8 },
	{ id: V3.gold_ore, y0: 40, peak: 80, y1: 120, attempts: 20, s0: 3, s1: 6, badlands: true },
	{ id: V3.lapis_ore, y0: 12, peak: 40, y1: 76, attempts: 4, s0: 3, s1: 7 },
	{ id: V3.redstone_ore, y0: 4, peak: 12, y1: 40, attempts: 8, s0: 4, s1: 8 },
	{ id: V3.diamond_ore, y0: 4, peak: 8, y1: 36, attempts: 4, s0: 2, s1: 5 },
	{ id: V3.diamond_ore, y0: 4, peak: 10, y1: 30, attempts: 1, s0: 5, s1: 8, chance: 0.125 },
	{ id: V3.emerald_ore, y0: 100, peak: 180, y1: 220, attempts: 20, s0: 1, s1: 3, mountain: true },
];
export type Blob = { id: number; attempts: number; y0: number; y1: number; r0: number; r1: number; ry: number };
export const BLOBS: readonly Blob[] = [
	{ id: V3.granite, attempts: 5, y0: 10, y1: 120, r0: 2.5, r1: 5, ry: 0.7 },
	{ id: V3.diorite, attempts: 5, y0: 10, y1: 120, r0: 2.5, r1: 5, ry: 0.7 },
	{ id: V3.andesite, attempts: 5, y0: 10, y1: 120, r0: 2.5, r1: 5, ry: 0.7 },
	{ id: V3.tuff, attempts: 8, y0: 4, y1: 48, r0: 3, r1: 6, ry: 0.7 },
	{ id: V3.calcite, attempts: 2, y0: 60, y1: 130, r0: 2, r1: 4, ry: 0.7 },
];
export const POCKETS: readonly Blob[] = [
	{ id: V3.gravel, attempts: 9, y0: 6, y1: 115, r0: 2, r1: 4, ry: 0.6 },
	{ id: V3.dirt, attempts: 10, y0: 60, y1: 118, r0: 2, r1: 3.5, ry: 0.6 },
	{ id: V3.clay, attempts: 1, y0: 30, y1: 110, r0: 2, r1: 3, ry: 0.6 },
];
export type OreInst = { x: number; y: number; z: number; size: number; ore: Ore; sub: number };
export type BlobInst = { x: number; y: number; z: number; r: number; id: number; ry: number };
export type GeodeInst = { x: number; y: number; z: number; r: number };
export type PoolInst = { x: number; y: number; z: number; r: number; liquid: number };

/** Triangular draw on [a, b] peaking at `peak` (one rng call). */
function tri(rng: () => number, a: number, peak: number, b: number): number {
	const u = rng(); const fc = (peak - a) / (b - a);
	return u < fc ? a + Math.sqrt(u * (b - a) * (peak - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - peak));
}
/** Instance-list memo keyed `${feature}${seed}:${cx}:${cz}`; never cleared mid-map (spec §2). `evictLists` is the unload hook. */
const memo = new Map<string, unknown>();
function memoised<T>(k: string, f: () => T): T { let v = memo.get(k) as T | undefined; if (v === undefined) { v = f(); memo.set(k, v); } return v; }
/** Engine hook for chunk unload (no caller yet): drops the memoised ore/blob/pocket lists of one origin chunk. */
export function evictLists(seed: number, cx: number, cz: number): void { for (const p of ['o', 'b', 'p']) memo.delete(`${p}${seed}:${cx}:${cz}`); }

export function oresOf(seed: number, cx: number, cz: number): OreInst[] { return memoised(`o${seed}:${cx}:${cz}`, () => oresOfRaw(seed, cx, cz)); }
function oresOfRaw(seed: number, cx: number, cz: number): OreInst[] {
	const base = streamSeed(seed, cx, cz, F.ORE); const rng = mulberry32(base); const out: OreInst[] = [];
	let mountain: boolean | undefined, badlandsChunk: boolean | undefined; let i = 0;
	for (const o of ORES) for (let a = 0; a < o.attempts; a++) {
		// the chunk stream is consumed for EVERY attempt (position, y, size, chance draw), kept or not (spec §10)
		const x = cx * 16 + ((rng() * 16) | 0), z = cz * 16 + ((rng() * 16) | 0);
		const y = Math.round(tri(rng, o.y0, o.peak, o.y1));
		const size = o.s0 + ((rng() * (o.s1 - o.s0 + 1)) | 0);
		const chanceDraw = o.chance !== undefined ? rng() : 0;
		const idx = i++; // instance index = attempt index, kept or not (spec §10)
		if (o.mountain) { if (mountain === undefined) mountain = chunkMaxH(seed, cx, cz) >= MOUNTAIN_GATE; if (!mountain) continue; }
		if (o.badlands) { if (badlandsChunk === undefined) badlandsChunk = column(seed, cx * 16 + 8, cz * 16 + 8).land === BIOME.badlands; if (!badlandsChunk) continue; const c = column(seed, x, z); if (c.land !== BIOME.badlands || c.h <= SEA) continue; }
		if (o.chance !== undefined && chanceDraw > o.chance) continue;
		out.push({ x, y, z, size, ore: o, sub: subSeed(base, idx) });
	}
	return out;
}
function blobList(seed: number, cx: number, cz: number, feature: number, table: readonly Blob[]): BlobInst[] {
	const rng = mulberry32(streamSeed(seed, cx, cz, feature)); const out: BlobInst[] = [];
	for (const bl of table) for (let a = 0; a < bl.attempts; a++) {
		const x = cx * 16 + ((rng() * 16) | 0), z = cz * 16 + ((rng() * 16) | 0), y = bl.y0 + ((rng() * (bl.y1 - bl.y0)) | 0);
		out.push({ x, y, z, r: bl.r0 + rng() * (bl.r1 - bl.r0), id: bl.id, ry: bl.ry });
	}
	return out;
}
export function blobsOf(seed: number, cx: number, cz: number): BlobInst[] { return memoised(`b${seed}:${cx}:${cz}`, () => blobList(seed, cx, cz, F.BLOB, BLOBS)); }
export function pocketsOf(seed: number, cx: number, cz: number): BlobInst[] { return memoised(`p${seed}:${cx}:${cz}`, () => blobList(seed, cx, cz, F.POCKET, POCKETS)); }
/** Not memoised (one rng draw decides; cheap to recompute). 1 in 24 chunks, centre y 24–60, r ∈ [4, 6.5). */
export function geodesOf(seed: number, cx: number, cz: number): GeodeInst[] {
	const rng = mulberry32(streamSeed(seed, cx, cz, F.GEODE));
	if (rng() >= 1 / 24) return [];
	return [{ x: cx * 16 + ((rng() * 16) | 0), z: cz * 16 + ((rng() * 16) | 0), y: 24 + ((rng() * 36) | 0), r: 4 + rng() * 2.5 }];
}
/** Not memoised. Own-chunk only: centre in local 4..11 so a disc of r < 3.5 never leaves the chunk (§5). */
export function poolsOf(seed: number, cx: number, cz: number): PoolInst[] {
	const rng = mulberry32(streamSeed(seed, cx, cz, F.POOL)); const out: PoolInst[] = [];
	for (let a = 0; a < 4; a++) {
		const lava = a < 2; const x = cx * 16 + 4 + ((rng() * 8) | 0), z = cz * 16 + 4 + ((rng() * 8) | 0);
		const y = lava ? 12 + ((rng() * 28) | 0) : 40 + ((rng() * 60) | 0);
		out.push({ x, y, z, r: 2 + rng() * 1.5, liquid: lava ? V3.lava : V3.water });
	}
	return out;
}

/** Random walk of `size` steps from the instance's sub-stream (§7). Every voxel stays within 15 blocks of the origin (reach invariant). */
export function vein(c: Ctx, o: OreInst, f: Setter): void {
	const rng = mulberry32(o.sub); let x = o.x, y = o.y, z = o.z;
	for (let s = 0; s < o.size; s++) {
		put(c, x, y, z, f);
		if (rng() < 0.5) put(c, x + (rng() < 0.5 ? 1 : 0), y, z + (rng() < 0.5 ? 1 : 0), f);
		const d = (rng() * 6) | 0; if (d === 0) x++; else if (d === 1) x--; else if (d === 2) z++; else if (d === 3) z--; else if (d === 4) y++; else y--;
		y = clamp(y, o.ore.y0, o.ore.y1); // exact band
	}
}
/** Ellipsoid rx = rz = r, ry = r·b.ry; rim voxels (0.7 ≤ d ≤ 1) skipped when hash % 3 == 0 (§7). */
export function ellipsoid(c: Ctx, b: BlobInst, f: Setter): void {
	const rx = b.r, ry = b.r * b.ry, rz = b.r;
	if (b.x + rx < c.bx || b.x - rx > c.bx + 15 || b.z + rz < c.bz || b.z - rz > c.bz + 15) return;
	for (let dz = -Math.ceil(rz); dz <= rz; dz++) for (let dy = -Math.ceil(ry); dy <= ry; dy++) for (let dx = -Math.ceil(rx); dx <= rx; dx++) {
		const d = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) + (dz * dz) / (rz * rz);
		if (d <= 1 && (d < 0.7 || hashv(b.x + dx, b.y + dy, b.z + dz) % 3 !== 0)) put(c, b.x + dx, b.y + dy, b.z + dz, f);
	}
}
/** Geode shells (§7): smooth_basalt / calcite / amethyst layer / air, with per-voxel radial jitter. Overwrites anything. */
export function geode(c: Ctx, g: GeodeInst): void {
	const R = Math.ceil(g.r) + 1;
	if (g.x + R < c.bx || g.x - R > c.bx + 15 || g.z + R < c.bz || g.z - R > c.bz + 15) return;
	const dist = (x: number, y: number, z: number) => Math.sqrt((x - g.x) * (x - g.x) + (y - g.y) * (y - g.y) + (z - g.z) * (z - g.z)) + ((hashv(x, y, z) % 100) / 100) * 0.6;
	for (let dz = -R; dz <= R; dz++) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
		const x = g.x + dx, y = g.y + dy, z = g.z + dz; const d = dist(x, y, z); let v: number;
		if (d > g.r + 0.8) continue; else if (d > g.r) v = V3.smooth_basalt; else if (d > g.r - 1) v = V3.calcite;
		else if (d > g.r - 2) { // amethyst layer; budding only where a face neighbour is calcite or non-budding amethyst (§7)
			let ok = false;
			for (const [ex, ey, ez] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) { const dn = dist(x + ex, y + ey, z + ez); if (dn > g.r - 2 && dn <= g.r && !(dn > g.r - 2 && dn <= g.r - 1 && hashv(x + ex, y + ey, z + ez) % 6 === 0)) ok = true; }
			v = hashv(x, y, z) % 6 === 0 && ok ? V3.budding_amethyst : V3.amethyst_block;
		} else v = V3.air;
		put(c, x, y, z, () => v);
	}
}
/** Returns true if the pool was placed. Own-chunk only (centre in local 4..11, r < 3.5 never leaves the chunk). */
export function pool(c: Ctx, p: PoolInst): boolean {
	const at = (x: number, y: number, z: number) => c.blocks[y * 256 + (z - c.bz) * 16 + (x - c.bx)];
	let fy = -1;
	for (let yy = p.y; yy > p.y - 8 && yy > 1; yy--) { const b = at(p.x, yy - 1, p.z); if (at(p.x, yy, p.z) === V3.air && b !== V3.air && !isLiquidId(b)) { fy = yy - 1; break; } }
	if (fy < 1) return false;
	const cand: [number, number][] = [];
	for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) if (dx * dx + dz * dz <= p.r * p.r) { const v = at(p.x + dx, fy, p.z + dz); if (v !== V3.air && !isLiquidId(v) && at(p.x + dx, fy + 1, p.z + dz) === V3.air) cand.push([p.x + dx, p.z + dz]); }
	const solid = (x: number, y: number, z: number) => { const v = at(x, y, z); return v !== V3.air && !isLiquidId(v); };
	const ok = cand.filter(([x, z]) => solid(x + 1, fy, z) && solid(x - 1, fy, z) && solid(x, fy, z + 1) && solid(x, fy, z - 1) && solid(x, fy - 1, z));
	if (ok.length < 4) return false;
	for (const [x, z] of ok) { const i = fy * 256 + (z - c.bz) * 16 + (x - c.bx); c.blocks[i] = p.liquid; c.poolLog?.push(i); }
	return true;
}

/** §11.7 instrument: ore voxels WRITTEN over anything but `stone`/`deepslate` (must stay 0). Checked against the two ids directly, not via `isStoneId`, so a wrong `isStoneId` goes red. A vein step that lands on another vein's ore, a blob, a pocket or a surface layer is left alone and is not counted. Reset by tests. */
export const T7_ORE_BAD = { count: 0 };

/** Stage 5: replay the 3 × 3 origins' lists, write only our voxels; pools own-chunk; then cave decoration (§6.2). Counters at the point of evaluation. */
export function stage5(ctx: Ctx, seed: number, cx: number, cz: number, col: (lx: number, lz: number) => Col, wn: Uint8Array, caveCeil: Float32Array, kind: Uint8Array, yTop: number, f: Fields): void {
	const { blocks, bx, bz } = ctx;
	for (let ncz = cz - 1; ncz <= cz + 1; ncz++) for (let ncx = cx - 1; ncx <= cx + 1; ncx++) {
		if (ncx < 0 || ncz < 0 || ncx > 31 || ncz > 31) continue;
		W.replays++; for (const o of oresOf(seed, ncx, ncz)) {
			if (o.x + o.size + 1 < bx || o.x - o.size - 1 > bx + 15 || o.z + o.size + 1 < bz || o.z - o.size - 1 > bz + 15) continue;
			// §11.7 exact clause: an ore may only replace stone/deepslate. The Setter sees the pre-write id; anything else is left alone. T7_ORE_BAD counts an ore actually written over a voxel that is not literally stone/deepslate, so the test goes red on a wrong `isStoneId` or an unconditional write.
			W.instances++; vein(ctx, o, (at) => { if (!isStoneId(at)) return -1; const v = at === V3.deepslate ? ORE_DEEPSLATE.get(o.ore.id)! : o.ore.id; if (at !== V3.stone && at !== V3.deepslate) T7_ORE_BAD.count++; return v; });
		}
		W.replays++; for (const bl of blobsOf(seed, ncx, ncz)) { if (bl.x + bl.r >= bx && bl.x - bl.r <= bx + 15 && bl.z + bl.r >= bz && bl.z - bl.r <= bz + 15) W.instances++; ellipsoid(ctx, bl, (at) => (isStoneId(at) ? bl.id : -1)); }
		W.replays++; for (const bl of pocketsOf(seed, ncx, ncz)) { if (bl.x + bl.r >= bx && bl.x - bl.r <= bx + 15 && bl.z + bl.r >= bz && bl.z - bl.r <= bz + 15) W.instances++; ellipsoid(ctx, bl, (at) => (isStoneId(at) ? bl.id : -1)); }
		W.replays++; for (const g of geodesOf(seed, ncx, ncz)) { W.instances++; geode(ctx, g); }
	}
	W.replays++;
	for (const p of poolsOf(seed, cx, cz)) {
		W.instances++; const pc = col(p.x - bx, p.z - bz);
		if (pc.ravW > 0 && wn[(p.z - bz + PAD) * PW + p.x - bx + PAD] === 0 && Math.abs(f.RAV(p.x / 230, p.z / 230)) < 0.4 * pc.ravW) continue; // never in a ravine core (its floor is forced solid)
		pool(ctx, p);
	}
	// cave decoration (§6.2): only cave-air voxels with y < caveCeil
	for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
		const wx = bx + lx, wz = bz + lz; const ceilD = caveCeil[(lz + PAD) * PW + lx + PAD];
		for (let y = 2; y < yTop && y < ceilD; y++) {
			const i = y * 256 + lz * 16 + lx; if (kind[i] !== 2 || blocks[i] !== V3.air) continue;
			const below = blocks[i - 256], above = blocks[i + 256];
			if (isStoneId(below) && kind[i - 256] === 1) {
				const dn = f.DECO(wx / 40, y / 40, wz / 40);
				if (dn > 0.45 && y > 56 && y < 112) { blocks[i - 256] = V3.moss_block; if (hashv(wx, y, wz) % 5 === 0 && y + 1 < yTop) blocks[i] = V3.moss_block; }
				else if (dn < -0.45 && hashv(wx, y, wz) % 7 === 0) { const hgt = 1 + (hashv(wx, y + 1, wz) % 3); for (let k = 0; k < hgt && blocks[i + k * 256] === V3.air; k++) blocks[i + k * 256] = V3.dripstone_block; }
			}
			if (isStoneId(above) && kind[i + 256] === 1) {
				const dn = f.DECO(wx / 40, y / 40, wz / 40);
				if (dn < -0.45 && hashv(wx, y, wz) % 9 === 0) { const hgt = 1 + (hashv(wx, y - 1, wz) % 3); for (let k = 0; k < hgt && blocks[i - k * 256] === V3.air; k++) blocks[i - k * 256] = V3.dripstone_block; }
				else if (dn > 0.45 && y > 56 && y < 112 && hashv(wx, y, wz) % 3 === 0) blocks[i + 256] = V3.moss_block;
			}
		}
	}
}
