import { fields, fbm2, fbm3, clamp, smooth, spline, type Fields } from './fields';

export const SEA = 120;
export const ENT_T = 0.1;
export const MOUNTAIN_GATE = 165;
export const DEEPSLATE_Y = 48, DEEP_BLEND = 4, LAVA_Y = 10, SURF_MARGIN = 6, RAVINE_FLOOR = 4;

export const BIOME = { ocean: 0, plains: 1, forest: 2, cherry: 3, taiga: 4, snowy: 5, desert: 6, savanna: 7, badlands: 8 } as const;
export const BIOME_NAME = ['ocean', 'plains', 'forest', 'cherry', 'taiga', 'snowy', 'desert', 'savanna', 'badlands'] as const;

export function pickLand(T: number, Hu: number): number {
	if (T < -0.45) return BIOME.snowy;
	if (T < -0.15) return Hu < -0.25 ? BIOME.plains : BIOME.taiga;
	if (T < 0.3) { if (Hu < -0.25) return BIOME.plains; if (Hu < 0.35) return BIOME.forest; return BIOME.cherry; }
	if (Hu < -0.35) return BIOME.badlands;
	if (Hu < 0.1) return BIOME.desert;
	return BIOME.savanna;
}

export type Col = { h: number; hRaw: number; biome: number; land: number; amp: number; ent: number; river: number; T: number; Hu: number; ravW: number; ravDepth: number; M: number };

const SPLINE: [number, number][] = [[-1, 98], [-0.55, 104], [-0.3, 113], [-0.15, 121], [0.1, 127], [0.45, 136], [1, 146]];

/** Stage 1: one column of the 2-D stack (spec §3.1–3.3, §4 pickLand, §5 rivers, §6.1 ravine gate). Pure. */
export function column(seed: number, wx: number, wz: number): Col {
	const f = fields(seed);
	const dC = Math.sqrt((wx - 256) * (wx - 256) + (wz - 256) * (wz - 256)); // Math.sqrt is IEEE-exact; Math.hypot is not
	const dEdge = Math.min(wx, wz, 511 - wx, 511 - wz);
	let C = fbm2(f.C, wx / 420, wz / 420, 3) + 0.08;
	C += 0.45 * smooth(1 - dC / 110); // spawn continent
	C -= 0.8 * smooth(1 - dEdge / 20); // ocean ring at the wall
	C = clamp(C, -1, 1);
	const E = fbm2(f.E, wx / 330, wz / 330, 3);
	const PV = 1 - Math.abs(fbm2(f.PV, wx / 140, wz / 140, 4)) * 2;
	const base = spline(C, SPLINE);
	const M = smooth((0.3 - E) / 0.7) * smooth((C + 0.05) / 0.35) * (1 - 0.6 * smooth(1 - dC / 128));
	let h = base + M * (PV > 0 ? PV * 92 : PV * 18);
	const T0 = fbm2(f.T, wx / 320, wz / 320, 2);
	const Hu = fbm2(f.HU, wx / 300, wz / 300, 2);
	const T = T0 - clamp((h - 130) / 90, 0, 1) * 0.7; // lapse on THIS h (pre-river, pre-detail)
	const land = pickLand(T, Hu);
	if (land === BIOME.badlands && h > SEA + 4) { const q = Math.floor(h / 6) * 6; h = q + 6 * smooth((h - q) / 3 - 0.5); }
	const r = fbm2(f.R, wx / 210, wz / 210, 2);
	const rs = clamp(1 - (h - SEA - 6) / 30, 0, 1); // river strength: 1 in lowlands, 0 at h ≥ 156
	const rw = 0.045 * rs;
	let river = 0;
	if (rs > 0 && Math.abs(r) < rw + 0.05 && h > SEA - 6) { river = rs * (1 - smooth((Math.abs(r) - rw) / 0.05)); h += (SEA - 3 - h) * river; }
	h += fbm2(f.D, wx / 26, wz / 26, 3) * 3.5 * (1 - river);
	const hRaw = h;
	h = Math.ceil(hRaw) - 1;
	const biome = h < SEA - 2 ? BIOME.ocean : land;
	const amp = h > SEA + 6 ? 22 * smooth((M - 0.4) / 0.35) * smooth((h - SEA - 6) / 20) : 0;
	const ent = f.ENT(wx / 90, wz / 90);
	const rg = f.RG(wx / 300, wz / 300);
	const rgT = 0.4 - 0.05 * smooth((dC - 128) / 48); // 0.4 within 128 of the centre, 0.35 from 176 outward
	const ravW = rg > rgT && h > SEA + 8 && amp < 6 ? 0.035 * smooth((rg - rgT) / 0.2) * smooth((dC - 128) / 48) : 0;
	const ravDepth = 40 + 25 * smooth(f.RAVD(wx / 300, wz / 300));
	return { h, hRaw, biome, land, amp, ent, river, T, Hu, ravW, ravDepth, M };
}

/** §4 rule 3 (2026-09-21 implementation feedback, seed-3 play-test): for T < 0 the altitude line descends to the lowlands as T approaches the
 *  snowy threshold −0.45 (`160 + 78·T`, clamped ≥ 122), so a hill beside a snowy patch is snow-topped instead of bare between h 135 and 151. */
export const snowLine = (c: Col) => c.T >= 0 ? 160 + 20 * c.T : Math.max(122, 160 + 78 * c.T);
export const isBeach = (c: Col) => c.h >= SEA - 3 && c.h <= SEA + 2 && c.land !== BIOME.badlands;
export function ampCellOf(seed: number, wx: number, wz: number): number {
	const x0 = wx & ~3, z0 = wz & ~3;
	return Math.max(column(seed, x0, z0).amp, column(seed, x0 + 4, z0).amp, column(seed, x0, z0 + 4).amp, column(seed, x0 + 4, z0 + 4).amp);
}
export function flatCell(seed: number, x: number, z: number): boolean { return ampCellOf(seed, x, z) === 0; }
/** 3 × 3 min of (hRaw − ampCell) < SEA + 2. The chunk generator computes the same thing from its padded columns. */
export function waterNear(seed: number, wx: number, wz: number): boolean {
	let m = 999;
	for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const q = column(seed, wx + dx, wz + dz); m = Math.min(m, q.hRaw - ampCellOf(seed, wx + dx, wz + dz)); }
	return m < SEA + 2;
}
export const isEntrance = (seed: number, wx: number, wz: number) => column(seed, wx, wz).ent > ENT_T && !waterNear(seed, wx, wz);
/** Column is inside a ravine channel (its air reaches the surface). */
export function inRavineChannel(seed: number, wx: number, wz: number): boolean {
	const c = column(seed, wx, wz);
	return c.ravW > 0 && Math.abs(fields(seed).RAV(wx / 230, wz / 230)) < c.ravW + 0.005 && !waterNear(seed, wx, wz);
}
/** Mountain gate for an ORIGIN chunk: max h over the 16 columns (4i+2, 4j+2). Pure function of (seed, cx, cz). */
export function chunkMaxH(seed: number, cx: number, cz: number): number {
	let m = 0;
	for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) m = Math.max(m, column(seed, cx * 16 + 4 * i + 2, cz * 16 + 4 * j + 2).h);
	return m;
}
/** Cheese carve (blocks) at a lattice node. */
export function cheeseDensity(f: Fields, wx: number, y: number, wz: number): number {
	const deep = clamp((112 - y) / 92, 0, 1);
	return (fbm3(f.CHEESE, wx / 96, y / 48, wz / 96, 2) - (0.58 - 0.28 * deep)) * 24;
}
/** Tunnel carve (blocks) at a lattice node; `boost` widens tunnels within 30 blocks of the surface in entrance zones. */
export function tunnelDensity(f: Fields, wx: number, y: number, wz: number, h: number, boost: boolean): number {
	const deep = clamp((112 - y) / 92, 0, 1);
	const s1 = f.S1(wx / 54, y / 32, wz / 54), s2 = f.S2(wx / 54, y / 32, wz / 54);
	const rs = 0.085 + 0.045 * deep + (boost ? 0.09 * clamp(1 - (h - y) / 30, 0, 1) : 0);
	let t = (rs * rs - (s1 * s1 + s2 * s2)) * 450;
	if (y < 92) { const n1 = f.N1(wx / 26, y / 20, wz / 26), n2 = f.N2(wx / 26, y / 20, wz / 26); t = Math.max(t, (0.0036 - (n1 * n1 + n2 * n2)) * 1100); }
	return t;
}
/** No tunnel or cheese node > 0 at the 4 xz corners of the cell containing (x,z), for y nodes (h−16)&~3 .. h+4 (entrance boost assumed). */
export function tunnelFree(seed: number, x: number, z: number, h: number): boolean {
	const f = fields(seed); const x0 = x & ~3, z0 = z & ~3;
	for (const [cx, cz] of [[x0, z0], [x0 + 4, z0], [x0, z0 + 4], [x0 + 4, z0 + 4]])
		for (let y = (h - 16) & ~3; y <= h + 4; y += 4) if (tunnelDensity(f, cx, y, cz, h, true) > 0 || cheeseDensity(f, cx, y, cz) > 0) return false;
	return true;
}
