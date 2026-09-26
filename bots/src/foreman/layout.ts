/**
 * The foreman's neighbourhood layout (experiment E7), pure: a grid of `cols` × 2 lots (7×7, room for 16 high), 4
 * columns apart; in every gap a 2-wide road between two 1-wide verges: a main street between the two rows (gravel)
 * and a cross street between each pair of columns (cobblestone), lamps (a post and a light) at every crossing and at
 * both ends of the main street. The search tries plan centres by distance from the anchor for 10, then 8, then 6,
 * then 4 lots (the largest that fits, never fewer than 4), widening its radius in steps (LIMITS.LEASH_STEPS:
 * 32/64/96, as the site search) when nothing fits closer in; every lot passes brain2's site rules (spawn, leash,
 * other builds, kid positions, flat and natural, headroom,
 * ≥ 12 from kid cells, as the village), the whole area stays ≥ 16 from spawn and from every kid standing, ≥ 12 from
 * any kid cell, and every road and lamp column is natural ground within 3 of the lots' height.
 */
import type { Ownership } from '../brain2/ownership.js';
import { boxMeetsKids, groundTop, siteOrReject } from '../brain2/behaviours/site-search.js';
import { LIMITS } from '../brain2/data/limits.data.js';
import type { WorldView } from '../port.js';
import type { Vec3 } from '../types.js';
import type { PlanCell, PlanLot } from './plan-file.js';

export const LOT = 7;
export const LOT_H = 16;
/** Columns between two lots: verge, road, road, verge. */
export const GAP = 4;
export const PITCH = LOT + GAP;
export const ROWS = 2;
export const MAX_DY = 3;
export const AREA_CLEAR = 16;
export const BLOCKS = { main: 'gravel', cross: 'cobblestone', post: 'oak_log', light: 'lamp' } as const;

export interface Col { x: number; z: number }
export const areaW = (cols: number) => cols * PITCH - GAP;
export const areaD = (rows: number) => rows * PITCH - GAP;

/** The lot origins (x/z), row by row, west to east. */
export function gridLots(corner: Col, cols: number, rows = ROWS): Col[] {
	const out: Col[] = [];
	for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push({ x: corner.x + c * PITCH, z: corner.z + r * PITCH });
	return out;
}

/**
 * The road columns in placement order (the main street as a snake along x, then each cross street as a snake along
 * z), without duplicates; kind picks the block.
 */
export function roadCols(corner: Col, cols: number, rows = ROWS): Array<Col & { kind: 'main' | 'cross' }> {
	const out: Array<Col & { kind: 'main' | 'cross' }> = [];
	const seen = new Set<string>();
	const add = (x: number, z: number, kind: 'main' | 'cross') => {
		const k = `${x},${z}`;
		if (seen.has(k)) return;
		seen.add(k);
		out.push({ x, z, kind });
	};
	const W = areaW(cols), D = areaD(rows);
	for (let r = 0; r < rows - 1; r++) {
		const z0 = corner.z + r * PITCH + LOT + 1;
		for (let i = 0; i < W; i++) {
			add(corner.x + i, z0 + (i % 2), 'main');
			add(corner.x + i, z0 + 1 - (i % 2), 'main');
		}
	}
	for (let c = 0; c < cols - 1; c++) {
		const x0 = corner.x + c * PITCH + LOT + 1;
		for (let j = 0; j < D; j++) {
			add(x0 + (j % 2), corner.z + j, 'cross');
			add(x0 + 1 - (j % 2), corner.z + j, 'cross');
		}
	}
	return out;
}

/** The lamp columns: the north-west verge corner of every crossing, and one past each end of the main street. */
export function lampCols(corner: Col, cols: number, rows = ROWS): Col[] {
	const out: Col[] = [];
	for (let r = 0; r < rows - 1; r++) {
		const zv = corner.z + r * PITCH + LOT;
		for (let c = 0; c < cols - 1; c++) out.push({ x: corner.x + c * PITCH + LOT, z: zv });
		out.push({ x: corner.x - 1, z: zv + 1 }, { x: corner.x + areaW(cols), z: zv + 1 });
	}
	return out;
}

export interface NeighbourhoodQ { anchor: Vec3; avoid: Array<{ min: Vec3; max: Vec3 }>; radii?: readonly number[]; step?: number }
export interface NeighbourhoodCtx { world: WorldView; own: Ownership; spawn: Vec3; kids?: readonly Vec3[] }
export interface NeighbourhoodSite { corner: Col; cols: number; lots: PlanLot[]; roads: PlanCell[]; lamps: PlanCell[] }

const rectDist = (p: { x: number; z: number }, x0: number, x1: number, z0: number, z1: number) =>
	Math.hypot(Math.max(x0 - p.x, 0, p.x - x1), Math.max(z0 - p.z, 0, p.z - z1));

/** Every rule for the grid at `corner`: the site, or the first reason it failed. */
export function evaluateNeighbourhood(corner: Col, cols: number, q: NeighbourhoodQ, ctx: NeighbourhoodCtx, top: (x: number, z: number) => number): NeighbourhoodSite | string {
	const radii = q.radii ?? LIMITS.LEASH_STEPS;
	const leash = radii[radii.length - 1] + 40;
	const lots: PlanLot[] = [];
	return evaluateGrid(corner, cols, q, ctx, top, (o, i) => {
		const r = siteOrReject(o.x, o.z, { w: LOT, d: LOT, h: LOT_H, anchor: q.anchor, avoid: q.avoid }, ctx, top, leash);
		if (typeof r === 'string') return r;
		if (lots.length && Math.abs(r.origin.y - lots[0].origin.y) > MAX_DY) return 'height';
		const lot: PlanLot = { id: `lot-${i + 1}`, origin: r.origin, w: LOT, d: LOT, h: LOT_H, status: 'open' };
		lots.push(lot);
		return lot;
	});
}

/** The grid's shared rules (spawn, kids, roads, lamps, kid cells) around lots judged by `lotAt`. */
function evaluateGrid(corner: Col, cols: number, q: NeighbourhoodQ, ctx: NeighbourhoodCtx, top: (x: number, z: number) => number, lotAt: (o: Col, i: number) => PlanLot | string): NeighbourhoodSite | string {
	const W = areaW(cols), D = areaD(ROWS);
	const x0 = corner.x - 1, x1 = corner.x + W, z0 = corner.z, z1 = corner.z + D - 1;
	if (rectDist(ctx.spawn, x0, x1, z0, z1) < AREA_CLEAR) return 'spawn';
	if ((ctx.kids ?? []).some((k) => rectDist(k, x0, x1, z0, z1) < AREA_CLEAR)) return 'kid-position';
	const lots: PlanLot[] = [];
	for (const [i, o] of gridLots(corner, cols).entries()) {
		const r = lotAt(o, i);
		if (typeof r === 'string') return r;
		lots.push(r);
	}
	const y = lots[0].origin.y;
	const inAvoid = (c: Col) => q.avoid.some((b) => c.x >= b.min.x - 1 && c.x <= b.max.x + 1 && c.z >= b.min.z - 1 && c.z <= b.max.z + 1);
	const cellOn = (c: Col): Vec3 | string => {
		if (inAvoid(c)) return 'builds';
		const g = top(c.x, c.z);
		if (g < 0 || Math.abs(g + 1 - y) > MAX_DY) return 'road-height';
		if (ctx.world.isLiquid(ctx.world.getBlock(c.x, g + 1, c.z))) return 'liquid';
		if (ctx.own.classify(c.x, g, c.z) !== 'natural') return 'not-natural';
		return { x: c.x, y: g + 1, z: c.z };
	};
	const roads: PlanCell[] = [];
	for (const c of roadCols(corner, cols)) {
		const v = cellOn(c);
		if (typeof v === 'string') return `road ${v}`;
		roads.push({ cell: v, block: BLOCKS[c.kind] });
	}
	const lamps: PlanCell[] = [];
	for (const c of lampCols(corner, cols)) {
		const v = cellOn(c);
		if (typeof v === 'string') return `lamp ${v}`;
		lamps.push({ cell: v, block: BLOCKS.post }, { cell: { ...v, y: v.y + 1 }, block: BLOCKS.light });
	}
	if (ctx.own.kidCellWithin((x0 + x1) / 2, (z0 + z1) / 2, LIMITS.SITE_KID_DIST + Math.hypot(x1 - x0, z1 - z0) / 2)) return 'kid-cells';
	return { corner, cols, lots, roads, lamps };
}

/**
 * A neighbourhood on a flattened region (the landscaper's `flattened` board post): the largest grid (5, 4, 3, then 2
 * columns) whose whole area (lamps included) lies inside `region`, corners tried nearest the region's centre first.
 * Every lot column is natural ground with its top exactly at `floor`, no liquid on it, air for LOT_H above, clear of
 * `q.avoid` and of kids standing; roads, lamps, spawn and kid cells as the search's own rules. The site, or the last
 * reason it failed ('too small' when no grid fits the region at all).
 */
export function layoutOnRegion(region: { x0: number; z0: number; x1: number; z1: number }, floor: number, q: Pick<NeighbourhoodQ, 'avoid'>, ctx: NeighbourhoodCtx, top: (x: number, z: number) => number = (x, z) => groundTop(ctx.world, x, z)): NeighbourhoodSite | string {
	const nq: NeighbourhoodQ = { anchor: { x: (region.x0 + region.x1) / 2, y: floor, z: (region.z0 + region.z1) / 2 }, avoid: q.avoid };
	let last = 'too small';
	const lotAt = (o: Col, i: number): PlanLot | string => {
		for (const b of q.avoid) if (o.x - 1 <= b.max.x && o.x + LOT >= b.min.x && o.z - 1 <= b.max.z && o.z + LOT >= b.min.z) return 'builds';
		if (boxMeetsKids(o.x - 1, o.x + LOT, o.z - 1, o.z + LOT, ctx.kids ?? [])) return 'kid-position';
		for (let x = o.x; x < o.x + LOT; x++) {
			for (let z = o.z; z < o.z + LOT; z++) {
				if (top(x, z) !== floor) return 'not-flat';
				if (ctx.own.classify(x, floor, z) !== 'natural') return 'not-natural';
				if (ctx.world.isLiquid(ctx.world.getBlock(x, floor + 1, z))) return 'liquid';
				for (let y = floor + 1; y <= floor + LOT_H; y++) if (ctx.world.getBlock(x, y, z) !== 0) return 'headroom';
			}
		}
		return { id: `lot-${i + 1}`, origin: { x: o.x, y: floor + 1, z: o.z }, w: LOT, d: LOT, h: LOT_H, status: 'open' };
	};
	for (const cols of NeighbourhoodSearch.COLS) {
		const W = areaW(cols), D = areaD(ROWS);
		const corners: Col[] = [];
		// Lamps stand one column west of the corner and one east of the area: both inside the region.
		for (let x = region.x0 + 1; x + W <= region.x1; x++) for (let z = region.z0; z + D - 1 <= region.z1; z++) corners.push({ x, z });
		const cx = (region.x0 + region.x1) / 2, cz = (region.z0 + region.z1) / 2;
		corners.sort((a, b) => Math.hypot(a.x + W / 2 - cx, a.z + D / 2 - cz) - Math.hypot(b.x + W / 2 - cx, b.z + D / 2 - cz));
		for (const c of corners) {
			const r = evaluateGrid(c, cols, nq, ctx, top, lotAt);
			if (typeof r !== 'string') return r;
			last = r;
		}
	}
	return last;
}

/**
 * The neighbourhood search, spread over calls: plan centres by distance from the anchor (every `step` blocks), 5
 * columns first (10 lots), then 4, then 3, then 2 (4 lots: the floor). Radius widens in steps (`q.radii`, default
 * LIMITS.LEASH_STEPS: 32/64/96, as the site search): every column count is tried in full within the closest radius
 * before the search widens, so a wide, sparse fit never beats a tight one nearby. `step()` judges up to `batch`
 * centres; returns the site, null while searching, 'none' when nothing fits within the widest radius.
 */
export class NeighbourhoodSearch {
	private readonly centres: Array<Col & { dist: number }> = [];
	private readonly tops = new Map<string, number>();
	private readonly radii: readonly number[];
	private readonly ciByNi: number[];
	private ni = 0;
	private ri = 0;
	readonly counts: Record<string, number> = {};
	static readonly COLS = [5, 4, 3, 2];

	constructor(private readonly q: NeighbourhoodQ, private readonly ctx: NeighbourhoodCtx) {
		this.radii = q.radii ?? LIMITS.LEASH_STEPS;
		const R = this.radii[this.radii.length - 1], st = q.step ?? 2;
		const ax = Math.round(q.anchor.x), az = Math.round(q.anchor.z);
		for (let dx = -R; dx <= R; dx += st) {
			for (let dz = -R; dz <= R; dz += st) {
				const dist = Math.hypot(dx, dz);
				if (dist <= R) this.centres.push({ x: ax + dx, z: az + dz, dist });
			}
		}
		this.centres.sort((a, b) => a.dist - b.dist);
		this.ciByNi = NeighbourhoodSearch.COLS.map(() => 0);
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

	step(batch = 40): NeighbourhoodSite | null | 'none' {
		for (let i = 0; i < batch; i++) {
			if (this.ri >= this.radii.length) return 'none';
			if (this.ni >= NeighbourhoodSearch.COLS.length) {
				this.ri++;
				this.ni = 0;
				if (this.ri >= this.radii.length) return 'none';
				continue;
			}
			const ci = this.ciByNi[this.ni];
			const c = this.centres[ci];
			if (!c || c.dist > this.radii[this.ri]) {
				this.ni++;
				continue;
			}
			this.ciByNi[this.ni] = ci + 1;
			const cols = NeighbourhoodSearch.COLS[this.ni];
			const corner = { x: c.x - Math.floor(areaW(cols) / 2), z: c.z - Math.floor(areaD(ROWS) / 2) };
			const r = evaluateNeighbourhood(corner, cols, this.q, this.ctx, this.top);
			if (typeof r !== 'string') return r;
			this.counts[r] = (this.counts[r] ?? 0) + 1;
		}
		return null;
	}
}
