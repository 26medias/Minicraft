import { createNoise2D, createNoise3D } from 'simplex-noise';
import alea from 'alea';

export type N2 = (x: number, y: number) => number;
export type N3 = (x: number, y: number, z: number) => number;
export const FIELDS_2D = ['C', 'E', 'PV', 'T', 'HU', 'R', 'D', 'ENT', 'RAV', 'RG', 'RAVD', 'PATCH'] as const;
export const FIELDS_3D = ['SHAPE', 'CHEESE', 'S1', 'S2', 'N1', 'N2', 'DECO'] as const;
export type Fields = Record<(typeof FIELDS_2D)[number], N2> & Record<(typeof FIELDS_3D)[number], N3>;

/** One Fields per seed for the life of the process (spec §2): 19 noise objects, a few KB. Never cleared mid-map. */
const cache = new Map<number, Fields>();
export function fields(seed: number): Fields {
	let f = cache.get(seed);
	if (f) return f;
	const o: Partial<Record<string, N2 | N3>> = {};
	for (const n of FIELDS_2D) o[n] = createNoise2D(alea(`minicraft:v3:${seed}:${n}`));
	for (const n of FIELDS_3D) o[n] = createNoise3D(alea(`minicraft:v3:${seed}:${n}`));
	f = o as Fields;
	cache.set(seed, f);
	return f;
}
export function fbm2(n: N2, x: number, z: number, oct: number): number {
	let a = 1, s = 0, norm = 0;
	for (let i = 0; i < oct; i++) { s += a * n(x, z); norm += a; x *= 2; z *= 2; a *= 0.5; }
	return s / norm;
}
export function fbm3(n: N3, x: number, y: number, z: number, oct: number): number {
	let a = 1, s = 0, norm = 0;
	for (let i = 0; i < oct; i++) { s += a * n(x, y, z); norm += a; x *= 2; y *= 2; z *= 2; a *= 0.5; }
	return s / norm;
}
export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const smooth = (t: number) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
export function spline(x: number, pts: [number, number][]): number {
	if (x <= pts[0][0]) return pts[0][1];
	for (let i = 1; i < pts.length; i++) {
		if (x <= pts[i][0]) { const t = (x - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]); return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * smooth(t); }
	}
	return pts[pts.length - 1][1];
}
