/**
 * The foreman's neighbourhood layout (experiment E7), pure: a grid of `cols` × 2 lots (7×7, room for 16 high), 4
 * columns apart; in every gap a 2-wide road between two 1-wide verges: a main street between the two rows (gravel)
 * and a cross street between each pair of columns (cobblestone), lamps (a post and a light) at every crossing and at
 * both ends of the main street. The search tries plan centres by distance from the anchor for 10, then 8, then 6
 * lots; every lot passes brain2's site rules (spawn, leash, other builds, kid positions, flat and natural, headroom,
 * ≥ 12 from kid cells, as the village), the whole area stays ≥ 16 from spawn and from every kid standing, ≥ 12 from
 * any kid cell, and every road and lamp column is natural ground within 3 of the lots' height.
 */
import type { Ownership } from '../brain2/ownership.js';
import { groundTop, siteOrReject } from '../brain2/behaviours/site-search.js';
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

export interface NeighbourhoodQ { anchor: Vec3; avoid: Array<{ min: Vec3; max: Vec3 }>; maxRadius?: number; step?: number }
export interface NeighbourhoodCtx { world: WorldView; own: Ownership; spawn: Vec3; kids?: readonly Vec3[] }
export interface NeighbourhoodSite { corner: Col; cols: number; lots: PlanLot[]; roads: PlanCell[]; lamps: PlanCell[] }

const rectDist = (p: { x: number; z: number }, x0: number, x1: number, z0: number, z1: number) =>
	Math.hypot(Math.max(x0 - p.x, 0, p.x - x1), Math.max(z0 - p.z, 0, p.z - z1));

/** Every rule for the grid at `corner`: the site, or the first reason it failed. */
export function evaluateNeighbourhood(corner: Col, cols: number, q: NeighbourhoodQ, ctx: NeighbourhoodCtx, top: (x: number, z: number) => number): NeighbourhoodSite | string {
	const W = areaW(cols), D = areaD(ROWS);
	const x0 = corner.x - 1, x1 = corner.x + W, z0 = corner.z, z1 = corner.z + D - 1;
	if (rectDist(ctx.spawn, x0, x1, z0, z1) < AREA_CLEAR) return 'spawn';
	if ((ctx.kids ?? []).some((k) => rectDist(k, x0, x1, z0, z1) < AREA_CLEAR)) return 'kid-position';
	const lots: PlanLot[] = [];
	const leash = (q.maxRadius ?? 64) + 40;
	for (const [i, o] of gridLots(corner, cols).entries()) {
		const r = siteOrReject(o.x, o.z, { w: LOT, d: LOT, h: LOT_H, anchor: q.anchor, avoid: q.avoid }, ctx, top, leash);
		if (typeof r === 'string') return r;
		if (lots.length && Math.abs(r.origin.y - lots[0].origin.y) > MAX_DY) return 'height';
		lots.push({ id: `lot-${i + 1}`, origin: r.origin, w: LOT, d: LOT, h: LOT_H, status: 'open' });
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
 * The neighbourhood search, spread over calls: plan centres by distance from the anchor (every `step` blocks within
 * `maxRadius`), 5 columns first (10 lots), then 4, then 3. `step()` judges up to `batch` centres; returns the site,
 * null while searching, 'none' when nothing fits.
 */
export class NeighbourhoodSearch {
	private readonly centres: Col[] = [];
	private readonly tops = new Map<string, number>();
	private ni = 0;
	private ci = 0;
	readonly counts: Record<string, number> = {};
	static readonly COLS = [5, 4, 3];

	constructor(private readonly q: NeighbourhoodQ, private readonly ctx: NeighbourhoodCtx) {
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

	step(batch = 40): NeighbourhoodSite | null | 'none' {
		for (let i = 0; i < batch; i++) {
			if (this.ni >= NeighbourhoodSearch.COLS.length) return 'none';
			const cols = NeighbourhoodSearch.COLS[this.ni];
			const c = this.centres[this.ci];
			const corner = { x: c.x - Math.floor(areaW(cols) / 2), z: c.z - Math.floor(areaD(ROWS) / 2) };
			const r = evaluateNeighbourhood(corner, cols, this.q, this.ctx, this.top);
			if (typeof r !== 'string') return r;
			this.counts[r] = (this.counts[r] ?? 0) + 1;
			if (++this.ci >= this.centres.length) {
				this.ci = 0;
				this.ni++;
			}
		}
		return null;
	}
}
