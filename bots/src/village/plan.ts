/**
 * The village planner's pure parts: which lots (3–5 builds: houses, one tower, a statue in the plaza), where they go
 * for a layout (row / circle / square around the plaza, 4–6 blocks apart), the site search for the whole village (every
 * lot passes brain2's site rules: spawn, leash, other builds, kid positions, flat and natural, headroom, ≥ 12 from kid
 * cells), the door-to-plaza paths (a BFS over columns, around every footprint) and the lamp spots at path ends.
 */
import type { Ownership } from '../brain2/ownership.js';
import { groundTop, siteOrReject, type Site } from '../brain2/behaviours/site-search.js';
import { templateOf } from '../brain2/behaviours/templates.data.js';
import type { WorldView } from '../port.js';
import type { Vec3 } from '../types.js';
import type { Layout, VillageTheme } from './themes.data.js';

export type LotRole = 'house' | 'tower' | 'statue';
export interface LotSpec { role: LotRole; template: string; variant: 'small' | 'medium'; w: number; d: number; h: number }
export interface Col { x: number; z: number }
export interface Box { x0: number; x1: number; z0: number; z1: number }

/** The free columns between two lots' footprints (the larger of the x and z gaps); < 0 when they overlap. */
export const GAP = 5;
export const MIN_GAP = 4;
export const MAX_GAP = 6;

export const boxOf = (o: Col, s: { w: number; d: number }): Box => ({ x0: o.x, x1: o.x + s.w - 1, z0: o.z, z1: o.z + s.d - 1 });
export function gapBetween(a: Box, b: Box): number {
	const dx = Math.max(b.x0 - a.x1 - 1, a.x0 - b.x1 - 1);
	const dz = Math.max(b.z0 - a.z1 - 1, a.z0 - b.z1 - 1);
	return Math.max(dx, dz);
}

/** `n` builds (3–5): the statue first, then (n − 2) houses and one tower. */
export function lotSpecs(n: number, theme: VillageTheme): LotSpec[] {
	const spec = (role: LotRole, template: string): LotSpec => {
		const t = templateOf(template, 'small');
		return { role, template, variant: 'small', w: t.w, d: t.d, h: t.h };
	};
	const out = [spec('statue', theme.statue.template)];
	for (let i = 0; i < n - 2; i++) out.push(spec('house', 'house'));
	out.push(spec('tower', 'tower'));
	return out;
}

/**
 * The lot origins (x/z) for `specs` around the plaza centre `c`: the statue (specs[0]) centred on it, the others by
 * layout. Doors are on the +z side of every template.
 */
export function layoutLots(layout: Layout, specs: readonly LotSpec[], c: Col): Col[] {
	const st = specs[0];
	const statue = { x: c.x - Math.floor(st.w / 2), z: c.z - Math.floor(st.d / 2) };
	const sb = boxOf(statue, st);
	const rest = specs.slice(1);
	const out: Col[] = [statue];
	if (layout === 'row') {
		// Side by side north of the plaza, doors facing it.
		const total = rest.reduce((s, x) => s + x.w, 0) + GAP * (rest.length - 1);
		let x = c.x - Math.floor(total / 2);
		for (const s of rest) {
			out.push({ x, z: sb.z0 - GAP - s.d });
			x += s.w + GAP;
		}
		return out;
	}
	if (layout === 'square') {
		// North, south, west, east of the statue, GAP from it.
		const sides = ['n', 's', 'w', 'e'];
		rest.forEach((s, i) => {
			const side = sides[i % 4];
			if (side === 'n') out.push({ x: c.x - Math.floor(s.w / 2), z: sb.z0 - GAP - s.d });
			else if (side === 's') out.push({ x: c.x - Math.floor(s.w / 2), z: sb.z1 + GAP + 1 });
			else if (side === 'w') out.push({ x: sb.x0 - GAP - s.w, z: c.z - Math.floor(s.d / 2) });
			else out.push({ x: sb.x1 + GAP + 1, z: c.z - Math.floor(s.d / 2) });
		});
		return out;
	}
	// Circle: evenly on a ring; the smallest radius with every gap ≥ MIN_GAP, over a few ring rotations (preferring
	// one where every lot's nearest neighbour is ≤ MAX_GAP away, then the half-step offset from north).
	const k = rest.length;
	let best: { lots: Col[]; score: number } | null = null;
	for (let rot = 0; rot < 12; rot++) {
		const off = Math.PI / k + (rot * 2 * Math.PI) / k / 12;
		for (let r = 3; r < 60; r++) {
			const lots = rest.map((s, i) => {
				const a = -Math.PI / 2 + off + (i * 2 * Math.PI) / k;
				return { x: Math.round(c.x + r * Math.cos(a) - s.w / 2), z: Math.round(c.z + r * Math.sin(a) - s.d / 2) };
			});
			const all = [statue, ...lots];
			const boxes = all.map((o, i) => boxOf(o, specs[i]));
			const nearest = boxes.map((b, i) => Math.min(...boxes.map((q, j) => (i === j ? Infinity : gapBetween(b, q)))));
			if (Math.min(...nearest) < MIN_GAP) continue;
			const score = (Math.max(...nearest) <= MAX_GAP ? 0 : 1000) + r * 10 + rot;
			if (!best || score < best.score) best = { lots: all, score };
			break;
		}
	}
	if (!best) throw new Error('circle layout: no radius fits');
	return best.lots;
}

export interface PlannedLot { spec: LotSpec; site: Site }
export interface VillageSite { centre: Col; n: number; lots: PlannedLot[] }
export interface VillageSearchQ { layout: Layout; theme: VillageTheme; anchor: Vec3; avoid: Array<{ min: Vec3; max: Vec3 }>; maxRadius?: number; step?: number }
export interface VillageSearchCtx { world: WorldView; own: Ownership; spawn: Vec3; kids?: readonly Vec3[] }

/** Lots may sit at most this far above or below the statue's. */
export const MAX_LOT_DY = 3;

/** Every lot for plaza centre `c` against the site rules; the site or the first reason one lot failed. */
export function evaluateVillage(c: Col, n: number, q: VillageSearchQ, ctx: VillageSearchCtx, top: (x: number, z: number) => number): VillageSite | string {
	const specs = lotSpecs(n, q.theme);
	const origins = layoutLots(q.layout, specs, c);
	const lots: PlannedLot[] = [];
	const leash = (q.maxRadius ?? 64) + 24;
	for (let i = 0; i < specs.length; i++) {
		const s = specs[i];
		const r = siteOrReject(origins[i].x, origins[i].z, { w: s.w, d: s.d, h: s.h, anchor: q.anchor, avoid: q.avoid }, ctx, top, leash);
		if (typeof r === 'string') return `${s.role}: ${r}`;
		if (lots.length && Math.abs(r.origin.y - lots[0].site.origin.y) > MAX_LOT_DY) return `${s.role}: height`;
		lots.push({ spec: s, site: r });
	}
	return { centre: c, n, lots };
}

/**
 * The village site search, spread over calls: plaza centres by distance from the anchor (every `step` blocks within
 * `maxRadius`), five builds first, then four, then three. `step()` judges up to `batch` centres; returns the site, null
 * while searching, 'none' when nothing fits.
 */
export class VillageSearch {
	private readonly centres: Col[] = [];
	private readonly tops = new Map<string, number>();
	private ni = 0;
	private ci = 0;
	readonly counts: Record<string, number> = {};
	static readonly SIZES = [5, 4, 3];

	constructor(private readonly q: VillageSearchQ, private readonly ctx: VillageSearchCtx) {
		const R = q.maxRadius ?? 64, st = q.step ?? 2;
		const ax = Math.round(q.anchor.x), az = Math.round(q.anchor.z);
		for (let dx = -R; dx <= R; dx += st) for (let dz = -R; dz <= R; dz += st) if (Math.hypot(dx, dz) <= R) this.centres.push({ x: ax + dx, z: az + dz });
		this.centres.sort((a, b) => Math.hypot(a.x - ax, a.z - az) - Math.hypot(b.x - ax, b.z - az));
	}

	private top = (x: number, z: number): number => {
		const k = `${x},${z}`;
		let v = this.tops.get(k);
		if (v === undefined) {
			v = groundTop(this.ctx.world, x, z);
			this.tops.set(k, v);
		}
		return v;
	};

	step(batch = 40): VillageSite | null | 'none' {
		for (let i = 0; i < batch; i++) {
			if (this.ni >= VillageSearch.SIZES.length) return 'none';
			const n = VillageSearch.SIZES[this.ni];
			const r = evaluateVillage(this.centres[this.ci], n, this.q, this.ctx, this.top);
			if (typeof r !== 'string') return r;
			const why = r.split(': ')[1] ?? r;
			this.counts[why] = (this.counts[why] ?? 0) + 1;
			if (++this.ci >= this.centres.length) {
				this.ci = 0;
				this.ni++;
			}
		}
		return null;
	}
}

/** The door-front columns (just outside each door gap) of a lot built at `origin`. */
export function doorFronts(spec: LotSpec, origin: Vec3): Col[] {
	let gaps: Vec3[] = [];
	try {
		gaps = templateOf(spec.template, spec.variant).doorGaps;
	} catch {
		return [];
	}
	const out: Col[] = [];
	for (const g of gaps) {
		const dir = g.x === 0 ? [-1, 0] : g.x === spec.w - 1 ? [1, 0] : g.z === 0 ? [0, -1] : g.z === spec.d - 1 ? [0, 1] : null;
		if (!dir) continue;
		const c = { x: origin.x + g.x + dir[0], z: origin.z + g.z + dir[1] };
		if (!out.some((o) => o.x === c.x && o.z === c.z)) out.push(c);
	}
	return out;
}

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const ck = (c: Col) => `${c.x},${c.z}`;

/**
 * The shortest 4-connected column path from `from` to any goal column, never through a blocked column, within
 * `bounds`; null when none (or longer than maxLen).
 */
export function planPath(from: Col, goal: (c: Col) => boolean, blocked: (c: Col) => boolean, bounds: Box, maxLen = 80): Col[] | null {
	if (blocked(from)) return null;
	const prev = new Map<string, string | null>([[ck(from), null]]);
	let frontier: Col[] = [from];
	for (let d = 0; d <= maxLen && frontier.length; d++) {
		const next: Col[] = [];
		for (const c of frontier) {
			if (goal(c)) {
				const out: Col[] = [];
				let k: string | null = ck(c);
				while (k) {
					const [x, z] = k.split(',').map(Number);
					out.push({ x, z });
					k = prev.get(k) ?? null;
				}
				return out.reverse();
			}
			for (const [dx, dz] of N4) {
				const n = { x: c.x + dx, z: c.z + dz };
				if (n.x < bounds.x0 || n.x > bounds.x1 || n.z < bounds.z0 || n.z > bounds.z1) continue;
				if (prev.has(ck(n)) || blocked(n)) continue;
				prev.set(ck(n), ck(c));
				next.push(n);
			}
		}
		frontier = next;
	}
	return null;
}

/** The plaza ring: the columns at Chebyshev distance 1 from the statue's footprint. */
export function plazaGoal(statue: Box): (c: Col) => boolean {
	return (c) => {
		const dx = Math.max(statue.x0 - c.x, 0, c.x - statue.x1);
		const dz = Math.max(statue.z0 - c.z, 0, c.z - statue.z1);
		return Math.max(dx, dz) === 1;
	};
}

/** A lamp column beside each end of `path` (not on it, not blocked), preferring the side across the path's direction. */
export function lampSpots(path: readonly Col[], blocked: (c: Col) => boolean): Col[] {
	if (path.length === 0) return [];
	const on = new Set(path.map(ck));
	const out: Col[] = [];
	const ends: Array<[Col, Col | undefined]> = [[path[0], path[1]], [path[path.length - 1], path[path.length - 2]]];
	for (const [e, nb] of ends) {
		const along = nb ? [nb.x - e.x, nb.z - e.z] : [0, 1];
		const cands = [...N4].sort((a, b) => Math.abs(a[0] * along[0] + a[1] * along[1]) - Math.abs(b[0] * along[0] + b[1] * along[1]));
		for (const [dx, dz] of cands) {
			const c = { x: e.x + dx, z: e.z + dz };
			if (on.has(ck(c)) || blocked(c) || out.some((o) => o.x === c.x && o.z === c.z)) continue;
			out.push(c);
			break;
		}
		if (path.length === 1) break;
	}
	return out;
}
