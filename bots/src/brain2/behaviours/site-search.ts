/**
 * The build-site search (spec §6.1): a ±1 site with levelling (dig the median + 1 bumps, fill the
 * median − 1 holes), clear of kid cells, the body buffers of the kids standing there now, spawn and other builds,
 * within the leash (widened per ruling R24: LIMITS.LEASH_STEPS). Surfaces look through leaves and logs (a canopy is not
 * the ground). The search is spread over ticks: one chunk per `step()`.
 */
import { KID_BUFFER_RADIUS, boxColumns } from '../../body/guard.js';
import type { WorldView } from '../../port.js';
import type { Ownership } from '../ownership.js';
import type { Vec3 } from '../types.js';
import { LIMITS } from '../data/limits.data.js';

/** origin = template (0,0,0) in the world (y = median + 1); groundY = the median surface. */
export interface Site { origin: Vec3; groundY: number; digs: Vec3[]; fills: Vec3[] }
export interface SiteQuery { w: number; d: number; h: number; anchor: Vec3; avoid: Array<{ min: Vec3; max: Vec3 }> }
/** kids: where the kids stand now (their feet); a site's grown footprint must clear their body buffers. */
export interface SiteCtx { world: WorldView; own: Ownership; spawn: Vec3; kids?: readonly Vec3[] }

const WORLD_TOP = 255;
const CHUNK = 16;

/** The y of the topmost solid block in column (x, z), scanning down from the world top; −1 if none (FakeWorld/BotWorld have surfaceY, WorldView doesn't). */
export function topSolid(world: WorldView, x: number, z: number): number {
	for (let y = WORLD_TOP; y >= 0; y--) if (world.isSolid(world.getBlock(x, y, z))) return y;
	return -1;
}

/** The body's half-width (the SDK's BODY_HALF): a pose on a column edge overlaps the next column too. */
const BODY_HALF = 0.3;

/**
 * The highest topmost solid block under the body's box at (x, z), −1 if none. A fallback flight lands on it: a target
 * on a column edge (Build's stand points, Explore's waypoints) overlaps the neighbour, and the flight is refused when
 * that neighbour stands higher than the column the target is in (brain2-productive: "flyTo blocked (wall)").
 */
export function bodyTop(world: WorldView, x: number, z: number): number {
	const e = 1e-6;
	let top = -1;
	for (let bx = Math.floor(x - BODY_HALF + e); bx <= Math.floor(x + BODY_HALF - e); bx++)
		for (let bz = Math.floor(z - BODY_HALF + e); bz <= Math.floor(z + BODY_HALF - e); bz++) top = Math.max(top, topSolid(world, bx, bz));
	return top;
}

/**
 * The highest topmost solid block under the body along the straight line from `a` to `b` (every half block), −1 if
 * none: a flight that starts at that height + 1 crosses the route without climbing.
 */
export function routeTop(world: WorldView, a: { x: number; z: number }, b: { x: number; z: number }): number {
	const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) * 2));
	let top = -1;
	for (let i = 0; i <= n; i++) top = Math.max(top, bodyTop(world, a.x + ((b.x - a.x) * i) / n, a.z + ((b.z - a.z) * i) / n));
	return top;
}

/** Blocks that are solid but not the ground, by name suffix: trees. Build and Mine surfaces look through them. */
export const NOT_GROUND_SUFFIXES: readonly string[] = ['_leaves', '_log'];

function isGround(world: WorldView, v: number): boolean {
	if (!world.isSolid(v)) return false;
	const name = world.blockName(v);
	return !name || !NOT_GROUND_SUFFIXES.some((s) => name.endsWith(s));
}

/** The y of the topmost solid ground block in column (x, z), looking through leaves and logs; −1 if none. Build and Mine surfaces. */
export function groundTop(world: WorldView, x: number, z: number): number {
	for (let y = WORLD_TOP; y >= 0; y--) if (isGround(world, world.getBlock(x, y, z))) return y;
	return -1;
}

/** Whether the inclusive column box [x0, x1] × [z0, z1] meets any kid's body buffer (his box's columns, widened by KID_BUFFER_RADIUS), as judgeSafety's 'kid body buffer'. */
export function boxMeetsKids(x0: number, x1: number, z0: number, z1: number, kids: readonly Vec3[]): boolean {
	return kids.some((k) => {
		const [bx0, bx1, bz0, bz1] = boxColumns(k);
		return x0 <= bx1 + KID_BUFFER_RADIUS && x1 >= bx0 - KID_BUFFER_RADIUS && z0 <= bz1 + KID_BUFFER_RADIUS && z1 >= bz0 - KID_BUFFER_RADIUS;
	});
}

/** The footprint grown by the 1-block margin, as an inclusive horizontal box. */
function grown(ox: number, oz: number, q: SiteQuery): { x0: number; x1: number; z0: number; z1: number } {
	return { x0: ox - 1, x1: ox + q.w, z0: oz - 1, z1: oz + q.d };
}

/** Why a candidate failed the site rules (the `search-failed` log line counts them per radius). */
export type SiteReject = 'spawn' | 'leash' | 'builds' | 'kid-position' | 'not-flat' | 'not-natural' | 'liquid' | 'headroom' | 'kid-cells';

/** The site rules for ONE origin: the Site (with its digs and fills) if it qualifies, else null. SiteSearch.step uses it per candidate; tests use it on hand-made patches. */
export function evaluateSite(originX: number, originZ: number, q: SiteQuery, ctx: SiteCtx, top?: (x: number, z: number) => number): Site | null {
	const r = siteOrReject(originX, originZ, q, ctx, top);
	return typeof r === 'string' ? null : r;
}

/** evaluateSite with the first rule that refused the site; `leash` = the radius from the anchor (ruling R24). */
export function siteOrReject(
	originX: number, originZ: number, q: SiteQuery, ctx: SiteCtx,
	top: (x: number, z: number) => number = (x, z) => groundTop(ctx.world, x, z), leash: number = LIMITS.LEASH,
): Site | SiteReject {
	const { world, own } = ctx;
	const cx = originX + q.w / 2, cz = originZ + q.d / 2;
	if (Math.hypot(cx - ctx.spawn.x, cz - ctx.spawn.z) < LIMITS.SITE_SPAWN_DIST) return 'spawn';
	if (Math.hypot(cx - q.anchor.x, cz - q.anchor.z) > leash) return 'leash';
	const g = grown(originX, originZ, q);
	for (const b of q.avoid) {
		if (g.x0 <= b.max.x && g.x1 >= b.min.x && g.z0 <= b.max.z && g.z1 >= b.min.z) return 'builds';
	}
	if (boxMeetsKids(g.x0, g.x1, g.z0, g.z1, ctx.kids ?? [])) return 'kid-position';
	const surf: number[] = [];
	for (let x = g.x0; x <= g.x1; x++) for (let z = g.z0; z <= g.z1; z++) surf.push(top(x, z));
	const sorted = [...surf].sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)];
	if (median < 0 || sorted[0] < median - 1 || sorted[sorted.length - 1] > median + 1) return 'not-flat';
	let i = 0;
	for (let x = g.x0; x <= g.x1; x++) {
		for (let z = g.z0; z <= g.z1; z++) {
			const s = surf[i++];
			if (own.classify(x, s, z) !== 'natural') return 'not-natural';
			if (world.isLiquid(world.getBlock(x, s + 1, z))) return 'liquid';
			// Nothing solid (a trunk, a stump) up to the template's layer 0; air above it, to the template's height.
			for (let y = s + 1; y <= median + 1; y++) if (world.isSolid(world.getBlock(x, y, z))) return 'headroom';
			for (let y = median + 2; y <= median + 1 + q.h; y++) if (world.getBlock(x, y, z) !== 0) return 'headroom';
		}
	}
	// Levelling, over the footprint only: the template's layer 0 sits at median + 1, on ground at median.
	const digs: Vec3[] = [], fills: Vec3[] = [];
	for (let x = originX; x < originX + q.w; x++) {
		for (let z = originZ; z < originZ + q.d; z++) {
			const s = surf[(x - g.x0) * (q.d + 2) + (z - g.z0)];
			if (s === median + 1) digs.push({ x, y: s, z });
			else if (s === median - 1) fills.push({ x, y: median, z });
		}
	}
	if (own.kidCellWithin(cx, cz, LIMITS.SITE_KID_DIST + Math.max(q.w, q.d) / 2)) return 'kid-cells';
	return { origin: { x: originX, y: median + 1, z: originZ }, groundY: median, digs, fills };
}

const chunkOf = (v: number): number => Math.floor(v / CHUNK);

/** The chunks overlapping the square of side 2r around `a`, in ring order from its chunk. */
export function chunksWithin(a: Vec3, r: number): Array<[number, number]> {
	const ax = chunkOf(a.x), az = chunkOf(a.z);
	const out: Array<[number, number]> = [];
	for (let x = chunkOf(a.x - r); x <= chunkOf(a.x + r); x++) for (let z = chunkOf(a.z - r); z <= chunkOf(a.z + r); z++) out.push([x, z]);
	const ring = (c: [number, number]) => Math.max(Math.abs(c[0] - ax), Math.abs(c[1] - az));
	return out.sort((p, q) => ring(p) - ring(q) || Math.hypot(p[0] - ax, p[1] - az) - Math.hypot(q[0] - ax, q[1] - az));
}

/** Rejections by reason at one search radius, for the `search-failed` log line (ruling R24). */
export interface RadiusRejections { radius: number; counts: Record<string, number> }

type Best = { site: Site; cost: number; dist: number };

/**
 * Ruling R24: the search scans the chunks within LIMITS.LEASH_STEPS[0] of the anchor; when no site qualifies there
 * it widens to the next radius (only the new chunks are scanned), up to the last. Every candidate is judged once,
 * against the widest radius; each radius keeps its own best (cost, then distance) among the sites within it and its
 * own rejection counts (a site beyond the radius counts as `leash`).
 */
export class SiteSearch {
	private readonly radii: readonly number[] = LIMITS.LEASH_STEPS;
	private ri = 0;
	private chunks: Array<[number, number]>;
	private readonly scanned = new Set<string>();
	private readonly tops = new Map<string, number>();
	private readonly done = new Set<string>();
	private readonly bests: Array<Best | null>;
	private readonly counts: Array<Record<string, number>>;
	private next = 0;
	/** One entry per radius that found nothing, in order (read by Build's `search-failed` line). */
	readonly rejections: RadiusRejections[] = [];

	constructor(private readonly q: SiteQuery, private readonly ctx: SiteCtx) {
		this.chunks = chunksWithin(q.anchor, this.radii[0]);
		this.bests = this.radii.map(() => null);
		this.counts = this.radii.map(() => ({}));
	}

	get anchor(): Vec3 {
		return this.q.anchor;
	}

	/** The radius being searched (or the one the result was found at). */
	get radius(): number {
		return this.radii[this.ri];
	}

	/**
	 * Scans one chunk per call; returns the best site once every chunk in the radius is scanned, null while scanning
	 * (or widening), 'none' when nothing qualifies within the widest radius. A call reads the world only in its own
	 * chunk: it caches that chunk's surfaces, then evaluates every candidate origin whose grown area now lies wholly in
	 * scanned chunks (a site across a chunk border waits for its last chunk).
	 */
	step(): Site | null | 'none' {
		if (this.next < this.chunks.length) {
			const [cx, cz] = this.chunks[this.next++];
			this.scanned.add(`${cx},${cz}`);
			for (let x = cx * CHUNK; x < (cx + 1) * CHUNK; x++) {
				for (let z = cz * CHUNK; z < (cz + 1) * CHUNK; z++) this.tops.set(`${x},${z}`, groundTop(this.ctx.world, x, z));
			}
			// Candidates whose grown area touches this chunk: origins from (chunk − w − 1) to (chunk end + 1).
			for (let ox = cx * CHUNK - this.q.w; ox <= (cx + 1) * CHUNK; ox++) {
				for (let oz = cz * CHUNK - this.q.d; oz <= (cz + 1) * CHUNK; oz++) this.consider(ox, oz);
			}
			if (this.next < this.chunks.length) return null;
		}
		const best = this.bests[this.ri];
		if (best) return best.site;
		if (this.rejections.length <= this.ri) this.rejections.push({ radius: this.radius, counts: { ...this.counts[this.ri] } });
		if (this.ri + 1 >= this.radii.length) return 'none';
		this.ri++;
		this.chunks = chunksWithin(this.q.anchor, this.radius).filter(([x, z]) => !this.scanned.has(`${x},${z}`));
		this.next = 0;
		return null;
	}

	private consider(ox: number, oz: number): void {
		const k = `${ox},${oz}`;
		if (this.done.has(k)) return;
		const g = grown(ox, oz, this.q);
		for (let x = chunkOf(g.x0); x <= chunkOf(g.x1); x++) for (let z = chunkOf(g.z0); z <= chunkOf(g.z1); z++) if (!this.scanned.has(`${x},${z}`)) return;
		this.done.add(k);
		const r = siteOrReject(ox, oz, this.q, this.ctx, (x, z) => this.tops.get(`${x},${z}`)!, this.radii[this.radii.length - 1]);
		const dist = Math.hypot(ox + this.q.w / 2 - this.q.anchor.x, oz + this.q.d / 2 - this.q.anchor.z);
		for (let i = this.ri; i < this.radii.length; i++) {
			const why = r === 'spawn' ? r : dist > this.radii[i] ? 'leash' : r;
			if (typeof why === 'string') {
				this.counts[i][why] = (this.counts[i][why] ?? 0) + 1;
				continue;
			}
			const cost = why.digs.length + why.fills.length;
			const b = this.bests[i];
			if (!b || cost < b.cost || (cost === b.cost && dist < b.dist)) this.bests[i] = { site: why, cost, dist };
		}
	}
}
