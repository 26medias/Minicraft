// Throwaway worldgen v3 prototype, gate-1 repaired. NOT engine code.
import { createNoise2D, createNoise3D } from '/home/julien/Projects/Minicraft/node_modules/simplex-noise/dist/esm/simplex-noise.js';
import alea from '/home/julien/Projects/Minicraft/node_modules/alea/alea.js';

export const SEA = 120;
const MUT = process.env.MUT ?? ''; // mutants for §11 evidence only
const H = 256, CX = 16, CZ = 16, PAD = 4, PAD_HI = process.env.MUT === 'pad4' ? 4 : 5, PW = CX + PAD + PAD_HI; // pad −4/+5 (PW 25): every column at local −1..16 has its 4 lattice-cell corners (x&~3 .. +4) inside the grid
const LAT = 4;
export const DEEPSLATE_Y = 48, DEEP_BLEND = 4, LAVA_Y = 10, SURF_MARGIN = 6, ENT_T = 0.1, RAVINE_FLOOR = 4;

export const B = {
	air: 0, grass: 1, dirt: 2, stone: 3, cobble: 4, sand: 5, water: 17, lava: 18, bedrock: 20, deepslate: 21,
	granite: 22, diorite: 23, andesite: 24, tuff: 25, calcite: 26, gravel: 27, clay: 28, sandstone: 29, red_sand: 30,
	red_sandstone: 31, terracotta: 32, o_terra: 33, y_terra: 34, w_terra: 35, r_terra: 36, br_terra: 37, lg_terra: 38,
	snow: 39, ice: 40, podzol: 41, coarse: 42, moss: 43, dripstone: 44, mossy_cobble: 45, smooth_basalt: 46, amethyst: 47, budding: 48,
	coal: 50, iron: 51, copper: 52, gold: 53, lapis: 54, redstone: 55, diamond: 56, emerald: 57,
	d_coal: 60, d_iron: 61, d_copper: 62, d_gold: 63, d_lapis: 64, d_redstone: 65, d_diamond: 66, d_emerald: 67,
	oak_log: 70, oak_leaves: 71, birch_log: 72, birch_leaves: 73, spruce_log: 74, spruce_leaves: 75, acacia_log: 76, acacia_leaves: 77, cherry_log: 78, cherry_leaves: 79,
};
export const NAME: Record<number, string> = {};
for (const [k, v] of Object.entries(B)) NAME[v] = k;

// ---------- PRNG ----------
export function mix32(h: number): number { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; }
export function streamSeed(seed: number, cx: number, cz: number, feature: number): number {
	let h = mix32((seed | 0) ^ 0x3a5f0d1b);
	h = mix32(h ^ Math.imul(cx | 0, 0x9e3779b1));
	h = mix32(h ^ Math.imul(cz | 0, 0x85ebca77));
	h = mix32(h ^ Math.imul(feature | 0, 0xc2b2ae3d));
	return h;
}
/** Sub-stream for instance `i` of a feature stream: independent of who replays it. */
export const subSeed = (base: number, i: number) => mix32(base ^ Math.imul(i + 1, 0x9e3779b1));
export function mulberry32(a: number) {
	return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const F = { TREE: 1, ORE: 2, BLOB: 3, POCKET: 4, GEODE: 5, POOL: 6 };
/** White noise on WORLD coords (identical on both sides of a chunk plane). */
export const hashv = (x: number, y: number, z: number) => mix32(mix32(Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) ^ Math.imul(z, 83492791));

// ---------- noise fields (cached per seed; engine: module-level Map in generation.v3.ts) ----------
type N2 = (x: number, y: number) => number; type N3 = (x: number, y: number, z: number) => number;
export const FIELDS_2D = ['C', 'E', 'PV', 'T', 'HU', 'R', 'D', 'ENT', 'RAV', 'RG', 'RAVD', 'PATCH'] as const;
export const FIELDS_3D = ['SHAPE', 'CHEESE', 'S1', 'S2', 'N1', 'N2', 'DECO'] as const;
type Fields = Record<(typeof FIELDS_2D)[number], N2> & Record<(typeof FIELDS_3D)[number], N3>;
const fieldCache = new Map<number, Fields>();
export function fields(seed: number): Fields {
	let f = fieldCache.get(seed);
	if (f) return f;
	const o: any = {};
	for (const n of FIELDS_2D) o[n] = createNoise2D(alea(`minicraft:v3:${seed}:${n}`));
	for (const n of FIELDS_3D) o[n] = createNoise3D(alea(`minicraft:v3:${seed}:${n}`));
	fieldCache.set(seed, o);
	return o;
}
function fbm2(n: N2, x: number, z: number, oct: number): number { let a = 1, s = 0, norm = 0; for (let i = 0; i < oct; i++) { s += a * n(x, z); norm += a; x *= 2; z *= 2; a *= 0.5; } return s / norm; }
function fbm3(n: N3, x: number, y: number, z: number, oct: number): number { let a = 1, s = 0, norm = 0; for (let i = 0; i < oct; i++) { s += a * n(x, y, z); norm += a; x *= 2; y *= 2; z *= 2; a *= 0.5; } return s / norm; }
const clamp = (v: number, a: number, b: number) => v < a ? a : v > b ? b : v;
const smooth = (t: number) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
function spline(x: number, pts: [number, number][]): number {
	if (x <= pts[0][0]) return pts[0][1];
	for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const t = (x - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]); return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * smooth(t); }
	return pts[pts.length - 1][1];
}

// ---------- biomes ----------
export const BIOME = { ocean: 0, plains: 1, forest: 2, cherry: 3, taiga: 4, snowy: 5, desert: 6, savanna: 7, badlands: 8 };
export const BIOME_NAME = ['ocean', 'plains', 'forest', 'cherry', 'taiga', 'snowy', 'desert', 'savanna', 'badlands'];
function pickLand(T: number, Hu: number): number {
	if (T < -0.45) return BIOME.snowy;
	if (T < -0.15) return Hu < -0.25 ? BIOME.plains : BIOME.taiga;
	if (T < 0.3) { if (Hu < -0.25) return BIOME.plains; if (Hu < 0.35) return BIOME.forest; return BIOME.cherry; }
	if (Hu < -0.35) return BIOME.badlands;
	if (Hu < 0.1) return BIOME.desert;
	return BIOME.savanna;
}

// ---------- stage 1: column ----------
export type Col = { h: number; hRaw: number; biome: number; land: number; amp: number; ent: number; river: number; T: number; Hu: number; ravW: number; ravDepth: number; M: number };
export function column(seed: number, wx: number, wz: number): Col {
	const f = fields(seed);
	const dC = Math.sqrt((wx - 256) * (wx - 256) + (wz - 256) * (wz - 256)); // Math.sqrt is IEEE-exact; Math.hypot is not
	const dEdge = Math.min(wx, wz, 511 - wx, 511 - wz);
	let C = fbm2(f.C, wx / 420, wz / 420, 3) + 0.08;
	C += 0.45 * smooth(1 - dC / 110);            // spawn continent
	C -= 0.8 * smooth(1 - dEdge / 20);           // ocean ring at the wall
	C = clamp(C, -1, 1);
	const E = fbm2(f.E, wx / 330, wz / 330, 3);
	const PV = 1 - Math.abs(fbm2(f.PV, wx / 140, wz / 140, 4)) * 2;
	const base = spline(C, [[-1, 98], [-0.55, 104], [-0.3, 113], [-0.15, 121], [0.1, 127], [0.45, 136], [1, 146]]);
	const M = smooth((0.3 - E) / 0.7) * smooth((C + 0.05) / 0.35) * (1 - 0.6 * smooth(1 - dC / 128)); // mountain-ness, softened within 128 of the centre
	let h = base + M * (PV > 0 ? PV * 92 : PV * 18);
	const T0 = fbm2(f.T, wx / 320, wz / 320, 2);
	const Hu = fbm2(f.HU, wx / 300, wz / 300, 2);
	const T = T0 - clamp((h - 130) / 90, 0, 1) * 0.7;      // lapse on the pre-river, pre-detail height
	const land = pickLand(T, Hu);
	if (land === BIOME.badlands && h > SEA + 4) { const q = Math.floor(h / 6) * 6; h = q + 6 * smooth((h - q) / 3 - 0.5); }
	const r = fbm2(f.R, wx / 210, wz / 210, 2);
	const rw = 0.045 * clamp(1 - (h - SEA - 6) / 30, 0, 1);
	let river = 0;
	const rs = clamp(1 - (h - SEA - 6) / 30, 0, 1); // river strength: 1 in lowlands, 0 at h ≥ 156 — the bank fade is scaled by it too
	if (rs > 0 && Math.abs(r) < rw + 0.05 && h > SEA - 6) { river = rs * (1 - smooth((Math.abs(r) - rw) / 0.05)); h += (SEA - 3 - h) * river; }
	h += fbm2(f.D, wx / 26, wz / 26, 3) * 3.5 * (1 - river);
	const hRaw = h;
	h = Math.ceil(hRaw) - 1;
	const biome = h < SEA - 2 ? BIOME.ocean : land;
	const amp = h > SEA + 6 ? 22 * smooth((M - 0.4) / 0.35) * smooth((h - SEA - 6) / 20) : 0;
	const ent = f.ENT(wx / 90, wz / 90);
	const rg = f.RG(wx / 300, wz / 300);
	const rgT = 0.4 - 0.05 * smooth((dC - 128) / 48); // ravine gate threshold: 0.4 within 128 of the centre, 0.35 from 176 outward (round 3: every world gets a real ravine)
	const ravW = rg > rgT && h > SEA + 8 && amp < 6 ? 0.035 * smooth((rg - rgT) / 0.2) * smooth((dC - 128) / 48) : 0; // no ravine zone within 128 of the centre
	const ravDepth = 40 + 25 * smooth(f.RAVD(wx / 300, wz / 300));
	return { h, hRaw, biome, land, amp, ent, river, T, Hu, ravW, ravDepth, M };
}
/** Column is inside a ravine channel (its air reaches the surface). */
export function inRavineChannel(seed: number, wx: number, wz: number): boolean { const c = column(seed, wx, wz); return c.ravW > 0 && Math.abs(fields(seed).RAV(wx / 230, wz / 230)) < c.ravW + 0.005 && !waterNear(seed, wx, wz); }
export const snowLine = (c: Col) => 160 + 20 * c.T;
export const isBeach = (c: Col) => c.h >= SEA - 3 && c.h <= SEA + 2 && c.land !== BIOME.badlands;
/** Entrance zone = caves may breach the surface. `waterNear` is the 3x3 min of (hRaw − amp) < SEA+2; computed by the chunk, replicated here for tests/spawn. */
export function ampCellOf(seed: number, wx: number, wz: number): number { const x0 = wx & ~3, z0 = wz & ~3; return Math.max(column(seed, x0, z0).amp, column(seed, x0 + 4, z0).amp, column(seed, x0, z0 + 4).amp, column(seed, x0 + 4, z0 + 4).amp); }
export function waterNear(seed: number, wx: number, wz: number): boolean { let m = 999; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const q = column(seed, wx + dx, wz + dz); m = Math.min(m, q.hRaw - ampCellOf(seed, wx + dx, wz + dz)); } return m < SEA + 2; }
export const isEntrance = (seed: number, wx: number, wz: number) => column(seed, wx, wz).ent > ENT_T && !waterNear(seed, wx, wz);
/** Mountain gate for an ORIGIN chunk: max h over the 16 columns (4i+2, 4j+2). Pure function of (seed,cx,cz). */
/** Cheese carve (blocks) at a lattice node. */
export function cheeseDensity(f: Fields, wx: number, y: number, wz: number): number { const deep = clamp((112 - y) / 92, 0, 1); return (fbm3(f.CHEESE, wx / 96, y / 48, wz / 96, 2) - (0.58 - 0.28 * deep)) * 24; }
/** Tunnel carve (blocks) at a lattice node; `boost` widens tunnels within 30 blocks of the surface in entrance zones. */
export function tunnelDensity(f: Fields, wx: number, y: number, wz: number, h: number, boost: boolean): number {
	const deep = clamp((112 - y) / 92, 0, 1);
	const s1 = f.S1(wx / 54, y / 32, wz / 54), s2 = f.S2(wx / 54, y / 32, wz / 54);
	const rs = 0.085 + 0.045 * deep + (boost ? 0.09 * clamp(1 - (h - y) / 30, 0, 1) : 0);
	let t = (rs * rs - (s1 * s1 + s2 * s2)) * 450;
	if (y < 92) { const n1 = f.N1(wx / 26, y / 20, wz / 26), n2 = f.N2(wx / 26, y / 20, wz / 26); t = Math.max(t, (0.0036 - (n1 * n1 + n2 * n2)) * 1100); }
	return t;
}
/** No tunnel or cheese node > 0 at the 4 xz corners of the cell containing (x,z), for y nodes from h−16 to h+4 (entrance boost assumed). */
export function tunnelFree(seed: number, x: number, z: number, h: number): boolean {
	const f = fields(seed); const x0 = x & ~3, z0 = z & ~3;
	for (const [cx, cz] of [[x0, z0], [x0 + 4, z0], [x0, z0 + 4], [x0 + 4, z0 + 4]]) for (let y = (h - 16) & ~3; y <= h + 4; y += 4) if (tunnelDensity(f, cx, y, cz, h, true) > 0 || cheeseDensity(f, cx, y, cz) > 0) return false;
	return true;
}
export const MOUNTAIN_GATE = 165;
export function chunkMaxH(seed: number, cx: number, cz: number): number { let m = 0; for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) m = Math.max(m, column(seed, cx * 16 + 4 * i + 2, cz * 16 + 4 * j + 2).h); return m; }

// ---------- feature instance lists (pure per origin chunk) ----------
export type Ore = { id: number; y0: number; peak: number; y1: number; attempts: number; s0: number; s1: number; mountain?: boolean; badlands?: boolean; chance?: number };
export const ORES: Ore[] = [
	{ id: B.coal, y0: MUT === 'coalshift' ? 68 : 60, peak: MUT === 'coalshift' ? 136 : 128, y1: MUT === 'coalshift' ? 208 : 200, attempts: 24, s0: 6, s1: 14 },
	{ id: B.iron, y0: 16, peak: 60, y1: 112, attempts: 12, s0: 4, s1: 9 },
	{ id: B.iron, y0: 140, peak: 185, y1: 230, attempts: 24, s0: 4, s1: 9, mountain: true },
	{ id: B.copper, y0: 50, peak: 92, y1: 130, attempts: 10, s0: 5, s1: 10 },
	{ id: B.gold, y0: 6, peak: 30, y1: 70, attempts: 5, s0: 4, s1: 8 },
	{ id: B.gold, y0: 40, peak: 80, y1: 120, attempts: 20, s0: 3, s1: 6, badlands: true },
	{ id: B.lapis, y0: 12, peak: 40, y1: 76, attempts: 4, s0: 3, s1: 7 },
	{ id: B.redstone, y0: 4, peak: 12, y1: 40, attempts: 8, s0: 4, s1: 8 },
	{ id: B.diamond, y0: 4, peak: 8, y1: 36, attempts: 4, s0: 2, s1: 5 },
	{ id: B.diamond, y0: 4, peak: 10, y1: 30, attempts: 1, s0: 5, s1: 8, chance: 0.125 },
	{ id: B.emerald, y0: 100, peak: 180, y1: 220, attempts: 20, s0: 1, s1: 3, mountain: true },
];
export const BLOBS = [
	{ id: B.granite, attempts: 5, y0: 10, y1: 120, r0: 2.5, r1: 5, ry: 0.7 },
	{ id: B.diorite, attempts: 5, y0: 10, y1: 120, r0: 2.5, r1: 5, ry: 0.7 },
	{ id: B.andesite, attempts: 5, y0: 10, y1: 120, r0: 2.5, r1: 5, ry: 0.7 },
	{ id: B.tuff, attempts: 8, y0: 4, y1: 48, r0: 3, r1: 6, ry: 0.7 },
	{ id: B.calcite, attempts: 2, y0: 60, y1: 130, r0: 2, r1: 4, ry: 0.7 },
];
export const POCKETS = [
	{ id: B.gravel, attempts: 9, y0: 6, y1: 115, r0: 2, r1: 4, ry: 0.6 },
	{ id: B.dirt, attempts: 10, y0: 60, y1: 118, r0: 2, r1: 3.5, ry: 0.6 },
	{ id: B.clay, attempts: 1, y0: 30, y1: 110, r0: 2, r1: 3, ry: 0.6 },
];
export type OreInst = { x: number; y: number; z: number; size: number; ore: Ore; sub: number };
export type BlobInst = { x: number; y: number; z: number; r: number; id: number; ry: number };
export type GeodeInst = { x: number; y: number; z: number; r: number };
export type PoolInst = { x: number; y: number; z: number; r: number; liquid: number };
function tri(rng: () => number, a: number, peak: number, b: number): number { const u = rng(); const fc = (peak - a) / (b - a); return u < fc ? a + Math.sqrt(u * (b - a) * (peak - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - peak)); }
const memo = new Map<string, any>();
function memoised<T>(k: string, f: () => T): T { let v = memo.get(k); if (v === undefined) { if (memo.size > 65536) memo.clear(); v = f(); memo.set(k, v); } return v; } // engine: key per seed, evict with chunk unload
export function clearMemo() { memo.clear(); }
export function oresOf(seed: number, cx: number, cz: number): OreInst[] { return memoised(`o${seed}:${cx}:${cz}`, () => oresOfRaw(seed, cx, cz)); }
function oresOfRaw(seed: number, cx: number, cz: number): OreInst[] {
	const base = streamSeed(seed, cx, cz, F.ORE); const rng = mulberry32(base); const out: OreInst[] = [];
	let mountain: boolean | undefined, badlandsChunk: boolean | undefined; let i = 0;
	for (const o of ORES) for (let a = 0; a < o.attempts; a++) {
		const x = cx * 16 + (rng() * 16 | 0), z = cz * 16 + (rng() * 16 | 0);
		const y = Math.round(tri(rng, o.y0, o.peak, o.y1));
		const size = o.s0 + (rng() * (o.s1 - o.s0 + 1) | 0);
		const chanceDraw = o.chance !== undefined ? rng() : 0;
		const idx = i++;
		if (o.mountain) { if (mountain === undefined) mountain = chunkMaxH(seed, cx, cz) >= MOUNTAIN_GATE; if (!mountain) continue; }
		if (o.badlands) { if (badlandsChunk === undefined) badlandsChunk = column(seed, cx * 16 + 8, cz * 16 + 8).land === BIOME.badlands; if (!badlandsChunk) continue; const c = column(seed, x, z); if (c.land !== BIOME.badlands || c.h <= SEA) continue; }
		if (o.chance !== undefined && chanceDraw > o.chance) continue;
		out.push({ x, y, z, size, ore: o, sub: subSeed(base, idx) });
	}
	return out;
}
export function blobsOf(seed: number, cx: number, cz: number): BlobInst[] { return memoised(`b${seed}:${cx}:${cz}`, () => blobsOfRaw(seed, cx, cz)); }
function blobsOfRaw(seed: number, cx: number, cz: number): BlobInst[] {
	const rng = mulberry32(streamSeed(seed, cx, cz, F.BLOB)); const out: BlobInst[] = [];
	for (const bl of BLOBS) for (let a = 0; a < bl.attempts; a++) { const x = cx * 16 + (rng() * 16 | 0), z = cz * 16 + (rng() * 16 | 0), y = bl.y0 + (rng() * (bl.y1 - bl.y0) | 0); out.push({ x, y, z, r: bl.r0 + rng() * (bl.r1 - bl.r0), id: bl.id, ry: bl.ry }); }
	return out;
}
export function pocketsOf(seed: number, cx: number, cz: number): BlobInst[] { return memoised(`p${seed}:${cx}:${cz}`, () => pocketsOfRaw(seed, cx, cz)); }
function pocketsOfRaw(seed: number, cx: number, cz: number): BlobInst[] {
	const rng = mulberry32(streamSeed(seed, cx, cz, F.POCKET)); const out: BlobInst[] = [];
	for (const bl of POCKETS) for (let a = 0; a < bl.attempts; a++) { const x = cx * 16 + (rng() * 16 | 0), z = cz * 16 + (rng() * 16 | 0), y = bl.y0 + (rng() * (bl.y1 - bl.y0) | 0); out.push({ x, y, z, r: bl.r0 + rng() * (bl.r1 - bl.r0), id: bl.id, ry: bl.ry }); }
	return out;
}
export function geodesOf(seed: number, cx: number, cz: number): GeodeInst[] {
	const rng = mulberry32(streamSeed(seed, cx, cz, F.GEODE));
	if (rng() >= 1 / 24) return [];
	return [{ x: cx * 16 + (rng() * 16 | 0), z: cz * 16 + (rng() * 16 | 0), y: 24 + (rng() * 36 | 0), r: 4 + rng() * 2.5 }];
}
export function poolsOf(seed: number, cx: number, cz: number): PoolInst[] {
	const rng = mulberry32(streamSeed(seed, cx, cz, F.POOL)); const out: PoolInst[] = [];
	for (let a = 0; a < 4; a++) { const lava = a < 2; const x = cx * 16 + 4 + (rng() * 8 | 0), z = cz * 16 + 4 + (rng() * 8 | 0); const y = lava ? 12 + (rng() * 28 | 0) : 40 + (rng() * 60 | 0); out.push({ x, y, z, r: 2 + rng() * 1.5, liquid: lava ? B.lava : B.water }); }
	return out;
}

// ---------- chunk generation ----------
export const T = { cols: 0, lattice: 0, fill: 0, surface: 0, features: 0, deco: 0, trees: 0, n: 0 };
/** Work counters, incremented AT THE POINT OF EVALUATION (§11.13). Reset per chunk. */
export const W = { nodes: 0, replays: 0, instances: 0 };
export function generateChunkV3(blocks: Uint16Array, seed: number, cx: number, cz: number): { ms: number } {
	const t0 = performance.now(); let tA = t0; T.n++; W.nodes = 0; W.replays = 0; W.instances = 0;
	const f = fields(seed);
	const bx = cx * CX, bz = cz * CZ;
	// stage 1
	const cols: Col[] = new Array(PW * PW); let maxH = 0;
	for (let pz = 0; pz < PW; pz++) for (let px = 0; px < PW; px++) { const c = column(seed, bx + px - PAD, bz + pz - PAD); cols[pz * PW + px] = c; if (c.h > maxH) maxH = c.h; }
	const col = (lx: number, lz: number) => cols[(lz + PAD) * PW + (lx + PAD)];
	// ampCell: the shape term at a column is bounded by the max amp of its 4 lattice-cell corners (columns at multiples of 4)
	const ampCell = new Float32Array(PW * PW);
	for (let pz = 0; pz < PW; pz++) for (let px = 0; px < PW; px++) { const wx = bx + px - PAD, wz = bz + pz - PAD; const x0 = (wx & ~3) - bx + PAD, z0 = (wz & ~3) - bz + PAD; if (x0 < 0 || z0 < 0 || x0 + 4 >= PW || z0 + 4 >= PW) { ampCell[pz * PW + px] = NaN; continue; } ampCell[pz * PW + px] = Math.max(cols[z0 * PW + x0].amp, cols[z0 * PW + x0 + 4].amp, cols[(z0 + 4) * PW + x0].amp, cols[(z0 + 4) * PW + x0 + 4].amp); } // NaN only for columns beyond local 17, never read
	const wn = new Uint8Array(PW * PW), caveCeil = new Float32Array(PW * PW);
	for (let pz = 1; pz < PW - 1; pz++) for (let px = 1; px < PW - 1; px++) { let m = 999; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const k = (pz + dz) * PW + px + dx; m = Math.min(m, cols[k].hRaw - ampCell[k]); } wn[pz * PW + px] = m < SEA + 2 ? 1 : 0; caveCeil[pz * PW + px] = m - SURF_MARGIN; }
	const yTop = Math.min(H - 4, Math.ceil((maxH + 28) / LAT) * LAT);
	T.cols += performance.now() - tA; tA = performance.now();
	// stage 2: lattice — S (shape), Dch (cheese), Dtn (tunnels = spaghetti|noodle)
	const NX = CX / LAT + 1, NY = yTop / LAT + 1, NXX = NX * NX;
	const S = new Float32Array(NX * NY * NX), Dch = new Float32Array(NX * NY * NX), Dtn = new Float32Array(NX * NY * NX);
	for (let iz = 0; iz < NX; iz++) for (let ix = 0; ix < NX; ix++) {
		const c = col(ix * LAT, iz * LAT); const wx = bx + ix * LAT, wz = bz + iz * LAT;
		for (let iy = 0; iy < NY; iy++) {
			W.nodes++; const y = iy * LAT; const k = (iy * NX + iz) * NX + ix; const d = c.hRaw - y;
			S[k] = (c.amp > 0 && Math.abs(d) < 40) ? c.amp * fbm3(f.SHAPE, wx / 44, y / 30, wz / 44, 3) * smooth(1 - Math.abs(d) / 40) : 0;
			if (y > c.h + 4 || y < 2) { Dch[k] = -99; Dtn[k] = -99; continue; }
			const deep = clamp((112 - y) / 92, 0, 1);
			Dch[k] = cheeseDensity(f, wx, y, wz);
			Dtn[k] = tunnelDensity(f, wx, y, wz, c.h, c.ent > ENT_T && wn[(iz * LAT + PAD) * PW + ix * LAT + PAD] === 0);
		}
	}
	(globalThis as any).LAST_LATTICE = { S, Dch, Dtn, NX, NY, entFlag: Array.from({ length: NX * NX }, (_, k) => { const ix = k % NX, iz = k / NX | 0; const c = col(ix * LAT, iz * LAT); return c.ent > ENT_T && wn[(iz * LAT + PAD) * PW + ix * LAT + PAD] === 0; }) };
	const cellCh = new Uint8Array(NX * NY * NX), cellTn = new Uint8Array(NX * NY * NX);
	for (let iy = 0; iy < NY - 1; iy++) for (let iz = 0; iz < NX - 1; iz++) for (let ix = 0; ix < NX - 1; ix++) {
		const k = (iy * NX + iz) * NX + ix; const ks = [k, k + 1, k + NX, k + NX + 1, k + NXX, k + NXX + 1, k + NXX + NX, k + NXX + NX + 1];
		cellCh[k] = ks.some((q) => Dch[q] > 0) ? 1 : 0; cellTn[k] = ks.some((q) => Dtn[q] > 0) ? 1 : 0;
	}
	T.lattice += performance.now() - tA; tA = performance.now();
	// stage 3: fill
	const kind = new Uint8Array(CX * H * CZ); // 0 terrain-air 1 solid 2 cave-air 3 water
	const tri8 = (A: Float32Array, k0: number, k1: number, fx: number, fy: number, fz: number) => {
		const a00 = A[k0] + (A[k0 + 1] - A[k0]) * fx, a01 = A[k0 + NX] + (A[k0 + NX + 1] - A[k0 + NX]) * fx;
		const a10 = A[k1] + (A[k1 + 1] - A[k1]) * fx, a11 = A[k1 + NX] + (A[k1 + NX + 1] - A[k1 + NX]) * fx;
		const a0 = a00 + (a01 - a00) * fz, a1 = a10 + (a11 - a10) * fz; return a0 + (a1 - a0) * fy;
	};
	for (let lz = 0; lz < CZ; lz++) for (let lx = 0; lx < CX; lx++) {
		const c = col(lx, lz); const wx = bx + lx, wz = bz + lz; const pi = (lz + PAD) * PW + lx + PAD;
		const ent = c.ent > ENT_T && wn[pi] === 0; const ceil = caveCeil[pi];
		const rav = c.ravW > 0 && wn[pi] === 0 ? Math.abs(f.RAV(wx / 230, wz / 230)) : 9;
		const ravBottom = Math.round(c.h - c.ravDepth); const inRavine = rav < c.ravW * 0.4;
		const ix = lx >> 2, iz = lz >> 2, fx = (lx & 3) / LAT, fz = (lz & 3) / LAT; const base = lz * 16 + lx;
		const flat = col(ix * LAT, iz * LAT).amp === 0 && col(ix * LAT + 4, iz * LAT).amp === 0 && col(ix * LAT, iz * LAT + 4).amp === 0 && col(ix * LAT + 4, iz * LAT + 4).amp === 0;
		for (let y = 0; y < yTop; y++) {
			const iy = y >> 2, fy = (y & 3) / LAT; const k0 = (iy * NX + iz) * NX + ix, k1 = k0 + NXX;
			const dt = flat ? c.hRaw - y : c.hRaw - y + tri8(S, k0, k1, fx, fy, fz);
			let kd: number;
			if (dt <= 0) kd = y <= SEA ? 3 : 0;
			else {
				kd = 1;
				const deepEnough = dt > SURF_MARGIN && (MUT === 'noceil' || y < ceil);
				if (y >= 2 && !(inRavine && y >= ravBottom - RAVINE_FLOOR && y < ravBottom)) { // ravine floor is solid
					if (deepEnough && (!ent || y < ceil - 18) && cellCh[k0] === 1 && tri8(Dch, k0, k1, fx, fy, fz) > 0) kd = 2; // deep cheese: ≥ 24 below the surface in entrance zones
					else if (ent && y >= c.hRaw - 14 && dt > -2 && cellCh[k0] === 1 && tri8(Dch, k0, k1, fx, fy, fz) > 0) kd = 2; // shallow cheese pit in entrance zones: floor ≥ h − 14 (solid band h−24..h−14 stays)
					else if ((deepEnough || (ent && dt > -2)) && cellTn[k0] === 1 && tri8(Dtn, k0, k1, fx, fy, fz) > 0) kd = 2; // tunnels may breach in entrance zones
				}
				if (kd === 1 && rav < 9 && y >= ravBottom && y < c.h + 60) {
					const w = c.ravW * (0.4 + 0.6 * clamp((y - ravBottom) / (c.h - ravBottom), 0, 1));
					if (rav < w) kd = 2;
				}
			}
			kind[y * 256 + base] = kd;
		}
	}
	(globalThis as any).LAST_KIND = kind; (globalThis as any).LAST_CEIL = caveCeil; (globalThis as any).LAST_PW = PW; (globalThis as any).LAST_PAD = PAD;
	T.fill += performance.now() - tA; tA = performance.now();
	// stage 4: surface (precedence: underwater > beach/bank > snow line > stony peak > biome)
	for (let lz = 0; lz < CZ; lz++) for (let lx = 0; lx < CX; lx++) {
		const c = col(lx, lz); const wx = bx + lx, wz = bz + lz;
		const patch = f.PATCH(wx / 9, wz / 9); const beach = isBeach(c); const sl = c.land === BIOME.snowy ? -999 : snowLine(c); const rocky = c.amp > 8;
		let depth = 99, prevAir = true;
		for (let y = yTop - 1; y >= 0; y--) {
			const i = y * 256 + lz * 16 + lx; const kd = kind[i];
			if (y === 0) { blocks[i] = B.bedrock; continue; }
			if (kd === 0) { blocks[i] = B.air; prevAir = true; depth = 99; continue; }
			if (kd === 3) { blocks[i] = (y === SEA && c.land === BIOME.snowy) ? B.ice : B.water; prevAir = true; depth = 99; continue; }
			if (kd === 2) { blocks[i] = y <= LAVA_Y ? B.lava : B.air; prevAir = y > c.hRaw - 9; depth = 99; continue; }
			depth = prevAir ? 0 : depth + 1; prevAir = false;
			let id = B.stone;
			if (y < DEEPSLATE_Y - DEEP_BLEND) id = B.deepslate;
			else if (y < DEEPSLATE_Y + DEEP_BLEND && (hashv(wx, y, wz) & 255) / 256 < (DEEPSLATE_Y + DEEP_BLEND - y) / (2 * DEEP_BLEND)) id = B.deepslate;
			if (depth <= 8 && y > c.hRaw - 9 - depth) {
				const underWater = kind[i + 256] === 3;
				if (underWater) id = depth === 0 ? (c.h > SEA - 10 ? (patch > 0.35 ? B.gravel : B.sand) : (patch > 0.2 ? B.clay : B.gravel)) : (depth < 3 ? B.sand : id);
				else if (beach || c.river > 0.6) id = depth < 4 ? (c.land === BIOME.snowy || c.land === BIOME.taiga ? B.gravel : B.sand) : id;
				else if (y >= sl) id = depth === 0 ? B.snow : (depth < 3 ? B.dirt : id);
				else if (rocky) id = id;
				else switch (c.land) {
					case BIOME.desert: id = depth < 3 ? B.sand : depth < 8 ? B.sandstone : id; break;
					case BIOME.badlands: id = depth === 0 && y <= SEA + 8 ? B.red_sand : (y >= 100 ? TERRA[y & 15] : id); break;
					case BIOME.taiga: id = depth === 0 ? (patch > 0.45 ? B.podzol : B.grass) : depth < 4 ? B.dirt : id; break;
					case BIOME.savanna: id = depth === 0 ? (patch > 0.55 ? B.coarse : B.grass) : depth < 4 ? B.dirt : id; break;
					default: id = depth === 0 ? B.grass : depth < 4 ? B.dirt : id;
				}
			}
			blocks[i] = id;
		}
	}
	T.surface += performance.now() - tA; tA = performance.now();
	// stage 5: underground features — replay every origin chunk in the 3x3, write only our voxels
	const ctx = { blocks, bx, bz };
	const inStone = (id: number) => id === B.stone || id === B.deepslate;
	for (let ncz = cz - 1; ncz <= cz + 1; ncz++) for (let ncx = cx - 1; ncx <= cx + 1; ncx++) {
		if (ncx < 0 || ncz < 0 || ncx > 31 || ncz > 31) continue;
		if (MUT === 'noz' && ncz !== cz) continue;
		W.replays++; for (const o of oresOf(seed, ncx, ncz)) {
			if (o.x + o.size + 1 < bx || o.x - o.size - 1 > bx + 15 || o.z + o.size + 1 < bz || o.z - o.size - 1 > bz + 15) continue;
			W.instances++; vein(ctx, o, (at) => inStone(at) ? (at === B.deepslate ? o.ore.id + 10 : o.ore.id) : -1);
		}
		W.replays++; for (const bl of blobsOf(seed, ncx, ncz)) { if (bl.x + bl.r >= bx && bl.x - bl.r <= bx + 15 && bl.z + bl.r >= bz && bl.z - bl.r <= bz + 15) W.instances++; ellipsoid(ctx, bl, (at) => inStone(at) ? bl.id : -1); }
		W.replays++; for (const bl of pocketsOf(seed, ncx, ncz)) { if (bl.x + bl.r >= bx && bl.x - bl.r <= bx + 15 && bl.z + bl.r >= bz && bl.z - bl.r <= bz + 15) W.instances++; ellipsoid(ctx, bl, (at) => inStone(at) ? bl.id : -1); }
		W.replays++; for (const g of geodesOf(seed, ncx, ncz)) { W.instances++; geode(ctx, g); }
	}
	W.replays++; for (const p of poolsOf(seed, cx, cz)) { W.instances++; const pc = col(p.x - bx, p.z - bz); if (MUT !== 'poolrav' && pc.ravW > 0 && wn[(p.z - bz + PAD) * PW + p.x - bx + PAD] === 0 && Math.abs(f.RAV(p.x / 230, p.z / 230)) < 0.4 * pc.ravW) continue; pool(ctx, p); } // never in a ravine core (its floor is forced solid)
	T.features += performance.now() - tA; tA = performance.now();
	// cave decoration
	for (let lz = 0; lz < CZ; lz++) for (let lx = 0; lx < CX; lx++) {
		const wx = bx + lx, wz = bz + lz;
		const ceilD = caveCeil[(lz + PAD) * PW + lx + PAD];
		for (let y = 2; y < yTop && (MUT === 'nodecoceil' || y < ceilD); y++) { // decoration only ≥ 6 below every nearby surface
			const i = y * 256 + lz * 16 + lx;
			if (kind[i] !== 2 || blocks[i] !== B.air) continue;
			const below = blocks[i - 256], above = blocks[i + 256];
			if (inStone(below) && kind[i - 256] === 1) {
				const dn = f.DECO(wx / 40, y / 40, wz / 40);
				if (dn > 0.45 && y > 56 && y < 112) { blocks[i - 256] = B.moss; if (hashv(wx, y, wz) % 5 === 0 && y + 1 < yTop) blocks[i] = B.moss; }
				else if (dn < -0.45 && hashv(wx, y, wz) % 7 === 0) { const hgt = 1 + hashv(wx, y + 1, wz) % 3; for (let k = 0; k < hgt && blocks[i + k * 256] === B.air; k++) blocks[i + k * 256] = B.dripstone; }
			}
			if (inStone(above) && kind[i + 256] === 1) {
				const dn = f.DECO(wx / 40, y / 40, wz / 40);
				if (dn < -0.45 && hashv(wx, y, wz) % 9 === 0) { const hgt = 1 + hashv(wx, y - 1, wz) % 3; for (let k = 0; k < hgt && blocks[i - k * 256] === B.air; k++) blocks[i - k * 256] = B.dripstone; }
				else if (dn > 0.45 && y > 56 && y < 112 && hashv(wx, y, wz) % 3 === 0) blocks[i + 256] = B.moss;
			}
		}
	}
	T.deco += performance.now() - tA; tA = performance.now();
	// stage 6: trees
	for (let ncz = cz - 1; ncz <= cz + 1; ncz++) for (let ncx = cx - 1; ncx <= cx + 1; ncx++) {
		if (ncx < 0 || ncz < 0 || ncx > 31 || ncz > 31) continue;
		W.replays++; for (const t of treesOf(seed, ncx, ncz)) { if (t.x + 4 >= bx && t.x - 4 <= bx + 15 && t.z + 4 >= bz && t.z - 4 <= bz + 15) W.instances++; t.sp.draw(ctx, t); }
	}
	T.trees += performance.now() - tA;
	return { ms: performance.now() - t0 };
}

const TERRA = [B.terracotta, B.o_terra, B.terracotta, B.y_terra, B.terracotta, B.w_terra, B.r_terra, B.terracotta, B.br_terra, B.o_terra, B.terracotta, B.lg_terra, B.terracotta, B.r_terra, B.o_terra, B.terracotta];
type Ctx = { blocks: Uint16Array; bx: number; bz: number };
type Setter = (at: number) => number;
/** Write world voxel (x,y,z) if inside this chunk. */
const putRef: { fn: null | ((x: number, y: number, z: number, f: Setter) => void) } = { fn: null };
function put(c: Ctx, x: number, y: number, z: number, f: Setter) {
	if (putRef.fn) return putRef.fn(x, y, z, f);
	const lx = x - c.bx, lz = z - c.bz; if (lx < 0 || lx > 15 || lz < 0 || lz > 15 || y < 1 || y > 254) return;
	const i = y * 256 + lz * 16 + lx; const v = f(c.blocks[i]); if (v >= 0) c.blocks[i] = v;
}
export function vein(c: Ctx, o: OreInst, f: Setter) {
	const rng = mulberry32(o.sub); let x = o.x, y = o.y, z = o.z;
	for (let s = 0; s < o.size; s++) {
		put(c, x, y, z, f);
		if (rng() < 0.5) put(c, x + (rng() < 0.5 ? 1 : 0), y, z + (rng() < 0.5 ? 1 : 0), f);
		const d = rng() * 6 | 0; if (d === 0) x++; else if (d === 1) x--; else if (d === 2) z++; else if (d === 3) z--; else if (d === 4) y++; else y--;
		y = clamp(y, o.ore.y0, o.ore.y1); // exact band
	}
}
function ellipsoid(c: Ctx, b: BlobInst, f: Setter) {
	const rx = b.r, ry = b.r * b.ry, rz = b.r;
	if (b.x + rx < c.bx || b.x - rx > c.bx + 15 || b.z + rz < c.bz || b.z - rz > c.bz + 15) return;
	for (let dz = -Math.ceil(rz); dz <= rz; dz++) for (let dy = -Math.ceil(ry); dy <= ry; dy++) for (let dx = -Math.ceil(rx); dx <= rx; dx++) {
		const d = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) + (dz * dz) / (rz * rz);
		if (d <= 1 && (d < 0.7 || hashv(b.x + dx, b.y + dy, b.z + dz) % 3 !== 0)) put(c, b.x + dx, b.y + dy, b.z + dz, f);
	}
}
function geode(c: Ctx, g: GeodeInst) {
	const R = Math.ceil(g.r) + 1;
	if (g.x + R < c.bx || g.x - R > c.bx + 15 || g.z + R < c.bz || g.z - R > c.bz + 15) return;
	for (let dz = -R; dz <= R; dz++) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
		const x = g.x + dx, y = g.y + dy, z = g.z + dz;
		const dist = (x: number, y: number, z: number) => Math.sqrt((x - g.x) * (x - g.x) + (y - g.y) * (y - g.y) + (z - g.z) * (z - g.z)) + (hashv(x, y, z) % 100) / 100 * 0.6;
		const d = dist(x, y, z);
		let v: number;
		if (d > g.r + 0.8) continue; else if (d > g.r) v = B.smooth_basalt; else if (d > g.r - 1) v = B.calcite;
		else if (d > g.r - 2) { // amethyst layer; budding only where a face neighbour is calcite or amethyst (so the assertion is exact by construction)
			let ok = false; for (const [ex, ey, ez] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) { const dn = dist(x + ex, y + ey, z + ez); if (dn > g.r - 2 && dn <= g.r && !(dn > g.r - 2 && dn <= g.r - 1 && hashv(x + ex, y + ey, z + ez) % 6 === 0)) ok = true; }
			v = hashv(x, y, z) % 6 === 0 && ok ? B.budding : B.amethyst;
		} else v = B.air;
		put(c, x, y, z, () => v);
	}
}
export let POOLS_PLACED = 0;
function pool(c: Ctx, p: PoolInst) {
	const at = (x: number, y: number, z: number) => c.blocks[y * 256 + (z - c.bz) * 16 + (x - c.bx)];
	const isLiq = (v: number) => v === B.water || v === B.lava;
	let fy = -1;
	for (let yy = p.y; yy > p.y - 8 && yy > 1; yy--) { const b = at(p.x, yy - 1, p.z); if (at(p.x, yy, p.z) === B.air && b !== B.air && !isLiq(b)) { fy = yy - 1; break; } }
	if (fy < 1) return;
	const cand: [number, number][] = [];
	for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) if (dx * dx + dz * dz <= p.r * p.r) { const v = at(p.x + dx, fy, p.z + dz); if (v !== B.air && !isLiq(v) && at(p.x + dx, fy + 1, p.z + dz) === B.air) cand.push([p.x + dx, p.z + dz]); }
	const solid = (x: number, y: number, z: number) => { const v = at(x, y, z); return v !== B.air && !isLiq(v); };
	const ok = cand.filter(([x, z]) => solid(x + 1, fy, z) && solid(x - 1, fy, z) && solid(x, fy, z + 1) && solid(x, fy, z - 1) && solid(x, fy - 1, z));
	if (ok.length < 4) return;
	for (const [x, z] of ok) c.blocks[fy * 256 + (z - c.bz) * 16 + (x - c.bx)] = p.liquid;
	POOLS_PLACED++;
}

// ---------- trees ----------
export type TreeInst = { x: number; z: number; h: number; hh: number; r1: number; r2: number; sp: Species };
export type Species = { name: string; h0: number; h1: number; draw: (c: Ctx, t: TreeInst) => void };
const GROUND_OK = new Set([B.dirt, B.grass, B.podzol, B.coarse, B.snow]);
const leaf = (c: Ctx, x: number, y: number, z: number, id: number) => put(c, x, y, z, (at) => at === B.air ? id : -1);
const logp = (c: Ctx, x: number, y: number, z: number, id: number) => put(c, x, y, z, () => id);
const plug = (c: Ctx, t: TreeInst) => put(c, t.x, t.h, t.z, (at) => GROUND_OK.has(at) ? -1 : B.dirt);
function blobCanopy(c: Ctx, t: TreeInst, log: number, lv: number) {
	plug(c, t); const top = t.h + t.hh;
	for (let y = t.h + 1; y <= top; y++) logp(c, t.x, y, t.z, log);
	for (let dy = -3; dy <= 0; dy++) {
		const y = top + dy; const r = dy >= -1 ? 1 : 2;
		for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
			if (dx === 0 && dz === 0 && dy < 0) continue;
			const corner = Math.abs(dx) === r && Math.abs(dz) === r;
			if (corner && (r === 1 || hashv(t.x + dx, y, t.z + dz) % 2 === 0)) continue;
			leaf(c, t.x + dx, y, t.z + dz, lv);
		}
	}
	for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) leaf(c, t.x + dx, top + 1, t.z + dz, lv);
}
export const SPECIES: Record<string, Species> = {
	oak: { name: 'oak', h0: 4, h1: 6, draw: (c, t) => blobCanopy(c, t, B.oak_log, B.oak_leaves) },
	birch: { name: 'birch', h0: 5, h1: 7, draw: (c, t) => blobCanopy(c, t, B.birch_log, B.birch_leaves) },
	spruce: { name: 'spruce', h0: 6, h1: 10, draw: (c, t) => {
		plug(c, t); const top = t.h + t.hh;
		for (let y = t.h + 1; y <= top; y++) logp(c, t.x, y, t.z, B.spruce_log);
		leaf(c, t.x, top + 1, t.z, B.spruce_leaves);
		let r = 1;
		for (let y = top; y >= t.h + 3; y--) { for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) { if (dx === 0 && dz === 0) continue; if (r === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2) continue; leaf(c, t.x + dx, y, t.z + dz, B.spruce_leaves); } r = r === 1 ? 2 : 1; }
	} },
	acacia: { name: 'acacia', h0: 5, h1: 6, draw: (c, t) => {
		plug(c, t); const dir = t.r1 < 0.5 ? [1, 0] : [0, 1]; const sgn = t.r2 < 0.5 ? 1 : -1; let x = t.x, z = t.z; const top = t.h + t.hh;
		for (let y = t.h + 1; y <= top; y++) { if (y === top - 1 && MUT !== 'nobend') { x += dir[0] * sgn; z += dir[1] * sgn; } logp(c, x, y, z, B.acacia_log); }
		for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) { if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue; leaf(c, x + dx, top, z + dz, B.acacia_leaves); }
		for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) leaf(c, x + dx, top + 1, z + dz, B.acacia_leaves);
	} },
	cherry: { name: 'cherry', h0: 4, h1: 5, draw: (c, t) => {
		plug(c, t); const top = t.h + t.hh;
		for (let y = t.h + 1; y <= top; y++) logp(c, t.x, y, t.z, B.cherry_log);
		for (let dy = -1; dy <= 1; dy++) { const y = top + dy; const r = dy === 1 ? 2 : 3; for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) { if (dx * dx + dz * dz > r * r + 1) continue; if (dy === 1 && dx === 0 && dz === 0) continue; leaf(c, t.x + dx, y, t.z + dz, B.cherry_leaves); } }
		leaf(c, t.x, top + 2, t.z, B.cherry_leaves);
	} },
};
export const TREES: Record<number, { n0: number; n1: number; species: Species[] } | undefined> = {
	[BIOME.plains]: { n0: 0, n1: 2, species: [SPECIES.oak] },
	[BIOME.forest]: { n0: 8, n1: 12, species: [SPECIES.oak, SPECIES.oak, SPECIES.birch] },
	[BIOME.cherry]: { n0: 2, n1: 4, species: [SPECIES.cherry] },
	[BIOME.taiga]: { n0: 6, n1: 9, species: [SPECIES.spruce] },
	[BIOME.snowy]: { n0: 1, n1: 2, species: [SPECIES.spruce] },
	[BIOME.savanna]: { n0: 1, n1: 2, species: [SPECIES.acacia] },
};
export function flatCell(seed: number, x: number, z: number): boolean {
	const x0 = x & ~3, z0 = z & ~3;
	return column(seed, x0, z0).amp === 0 && column(seed, x0 + 4, z0).amp === 0 && column(seed, x0, z0 + 4).amp === 0 && column(seed, x0 + 4, z0 + 4).amp === 0;
}
/** Pure: trees whose trunk origin lies in chunk (cx, cz). */
export function treesOf(seed: number, cx: number, cz: number): TreeInst[] { return memoised(`t${seed}:${cx}:${cz}`, () => treesOfRaw(seed, cx, cz)); }
function treesOfRaw(seed: number, cx: number, cz: number): TreeInst[] {
	const rt = mulberry32(streamSeed(seed, cx, cz, F.TREE));
	const cc = column(seed, cx * 16 + 8, cz * 16 + 8); const spec = TREES[cc.biome]; const out: TreeInst[] = [];
	if (!spec) return out;
	const n = spec.n0 + (rt() * (spec.n1 - spec.n0 + 1) | 0);
	for (let a = 0; a < n; a++) {
		const lx = rt() * 16 | 0, lz = rt() * 16 | 0; const sp = spec.species[rt() * spec.species.length | 0]; const hh = sp.h0 + (rt() * (sp.h1 - sp.h0 + 1) | 0); const r1 = rt(), r2 = rt();
		const x = cx * 16 + lx, z = cz * 16 + lz;
		if (out.some((t) => Math.abs(t.x - x) < 3 && Math.abs(t.z - z) < 3)) continue;
		const c = column(seed, x, z);
		if (c.h < SEA + 1 || isBeach(c) || c.river > 0.2 || inRavineChannel(seed, x, z) || c.biome !== cc.biome || c.h >= snowLine(c) || !flatCell(seed, x, z)) continue;
		if (MUT !== 'treetunnel' && c.ent > ENT_T && !tunnelFree(seed, x, z, c.h)) continue; // no tree over a tunnel mouth
		out.push({ x, z, h: c.h, hh, r1, r2, sp });
	}
	return out;
}
/** Draw a tree into a scratch "world" (for the completeness test): returns [x,y,z,id] list. */
export function treeTemplate(t: TreeInst): [number, number, number, number][] {
	const out: [number, number, number, number][] = []; const seen = new Map<string, number>();
	const c: Ctx = { blocks: new Uint16Array(0), bx: 0, bz: 0 };
	// shim put: record instead of writing (leaves only where nothing recorded yet, logs overwrite)
	const rec = (x: number, y: number, z: number, f: Setter) => { const k = `${x},${y},${z}`; const cur = seen.get(k) ?? B.air; const v = f(cur); if (v >= 0) seen.set(k, v); };
	const saved = putRef.fn; putRef.fn = rec; try { t.sp.draw(c, t); } finally { putRef.fn = saved; }
	for (const [k, v] of seen) { const [x, y, z] = k.split(',').map(Number); out.push([x, y, z, v]); }
	return out;
}
// ---------- spawn ----------
export type SpawnInfo = { x: number; z: number; h: number; buildable: number; ringsSearched: number; ms: number; work: number; pass: number };
export function spawnColumn(seed: number): [number, number] { return [spawnInfo(seed).x, spawnInfo(seed).z]; }
export function spawnInfo(seed: number): SpawnInfo {
	const t0 = performance.now(); let work = 0;
	const cache = new Map<number, Col>(); const colC = (x: number, z: number) => { const k = x * 1024 + z; let c = cache.get(k); if (!c) { c = column(seed, x, z); cache.set(k, c); work++; } return c; };
	const treeCache = new Map<number, TreeInst[]>(); const trees = (cx: number, cz: number) => { const k = cx * 64 + cz; let t = treeCache.get(k); if (!t) { t = (cx < 0 || cz < 0 || cx > 31 || cz > 31) ? [] : treesOf(seed, cx, cz); treeCache.set(k, t); } return t; };
	const canopyNear = (x: number, z: number) => { for (let dcz = -1; dcz <= 1; dcz++) for (let dcx = -1; dcx <= 1; dcx++) for (const t of trees((x >> 4) + dcx, (z >> 4) + dcz)) if (Math.abs(t.x - x) <= 7 && Math.abs(t.z - z) <= 7) return true; return false; };
	const f = fields(seed);
	// memoised per-column ravine-channel predicate and per-corner mouth predicate
	const chanCache = new Map<number, boolean>(); const channel = (x: number, z: number) => { const k = x * 1024 + z; let v = chanCache.get(k); if (v === undefined) { const c = colC(x, z); v = c.ravW > 0 && Math.abs(f.RAV(x / 230, z / 230)) < c.ravW + 0.005 && !waterNearC(x, z); chanCache.set(k, v); } return v; };
	const waterNearC = (x: number, z: number) => { let m = 999; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const q = colC(x + dx, z + dz); const x0 = (x + dx) & ~3, z0 = (z + dz) & ~3; const ac = Math.max(colC(x0, z0).amp, colC(x0 + 4, z0).amp, colC(x0, z0 + 4).amp, colC(x0 + 4, z0 + 4).amp); m = Math.min(m, q.hRaw - ac); } return m < SEA + 2; };
	const mouthCache = new Map<number, boolean>(); const mouthCorner = (cx: number, cz: number) => { const k = cx * 1024 + cz; let v = mouthCache.get(k); if (v === undefined) { const q = colC(cx, cz); v = false; if (q.h > SEA && q.ent > ENT_T && !waterNearC(cx, cz)) for (const y of [q.h - 8, q.h - 4, q.h]) if (tunnelDensity(f, cx, y & ~3, cz, q.h, true) > 0 || cheeseDensity(f, cx, y & ~3, cz) > 0) { v = true; break; } mouthCache.set(k, v); } return v; };
	const mouthNear = (x: number, z: number) => { for (let cz = (z - 40) & ~3; cz <= z + 40; cz += 4) for (let cx = (x - 40) & ~3; cx <= x + 40; cx += 4) { if (cx < 0 || cz < 0 || cx > 511 || cz > 511) continue; if (mouthCorner(cx, cz)) return true; } return false; };
	const buildable = (x: number, z: number, h: number) => { let n = 0; for (let dz = -24; dz <= 24; dz++) for (let dx = -24; dx <= 24; dx++) { const c = colC(x + dx, z + dz); if (c.h >= SEA + 1 && c.river === 0 && Math.abs(c.h - h) <= 3) n++; } return n / (49 * 49); };
	const ok = (x: number, z: number, minH: number, gentle: boolean, minBuild: number): number | null => {
		const c = colC(x, z);
		if (c.h < minH || c.river > 0 || c.ravW > 0 || c.land === BIOME.snowy || c.h >= snowLine(c) || isBeach(c)) return null;
		for (const [ex, ez] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [-1, -1], [1, -1], [-1, 1]]) if (Math.abs(colC(x + ex, z + ez).h - c.h) > 2) return null;
		if (!flatCell(seed, x, z) || canopyNear(x, z) || !tunnelFree(seed, x, z, c.h)) return null;
		const b = buildable(x, z, c.h); if (b < minBuild) return null;
		for (let dz = -64; dz <= 64; dz++) for (let dx = -64; dx <= 64; dx++) { const xx = x + dx, zz = z + dz; if (xx < 0 || zz < 0 || xx > 511 || zz > 511) continue; if (colC(xx, zz).ravW > 0 && channel(xx, zz)) return null; } // never a ravine channel within 64
		if (!gentle) return b;
		for (let dz = -64; dz <= 64; dz++) for (let dx = -64; dx <= 64; dx++) { const q = colC(x + dx, z + dz); if (q.amp > 6) return null; if (Math.max(Math.abs(dx), Math.abs(dz)) <= 32 && (Math.abs(q.h - colC(x + dx + 1, z + dz).h) > 10 || Math.abs(q.h - colC(x + dx, z + dz + 1).h) > 10)) return null; } // gentle: no cliff shape within 64, steps ≤ 10 within 32; tested BEFORE mouth
		if (!mouthNear(x, z)) return null;
		return b;
	};
	for (const [minH, gentle, minBuild] of [[130, true, 0.4], [SEA + 2, true, 0.4], [SEA + 2, false, 0.4], [SEA + 2, false, 0]] as [number, boolean, number][]) for (let r = 0; r <= 128; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
		if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
		const x = 256 + dx, z = 256 + dz; const b = ok(x, z, minH, gentle, minBuild);
		if (b !== null) return { x, z, h: colC(x, z).h, buildable: b, ringsSearched: r, ms: performance.now() - t0, work, pass: [[130, true, 0.4], [SEA + 2, true, 0.4], [SEA + 2, false, 0.4], [SEA + 2, false, 0]].findIndex(([a, g, m]) => a === minH && g === gentle && m === minBuild) + 1 };
	}
	return { x: 256, z: 256, h: colC(256, 256).h, buildable: 0, ringsSearched: 129, ms: performance.now() - t0, work, pass: 5 };
}
