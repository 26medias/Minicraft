/**
 * The build-site search (spec §6.1): a ±1 site with levelling (dig the median + 1 bumps, fill the
 * median − 1 holes), clear of kid cells, the body buffers of the kids standing there now, spawn and other builds,
 * within the leash. Surfaces look through leaves and logs (a canopy is not the ground). The search is spread
 * over ticks: one chunk per `step()`.
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

/** The site rules for ONE origin: the Site (with its digs and fills) if it qualifies, else null. SiteSearch.step uses it per candidate; tests use it on hand-made patches. */
export function evaluateSite(originX: number, originZ: number, q: SiteQuery, ctx: SiteCtx, top: (x: number, z: number) => number = (x, z) => groundTop(ctx.world, x, z)): Site | null {
	const { world, own } = ctx;
	const cx = originX + q.w / 2, cz = originZ + q.d / 2;
	if (Math.hypot(cx - ctx.spawn.x, cz - ctx.spawn.z) < LIMITS.SITE_SPAWN_DIST) return null;
	if (Math.hypot(cx - q.anchor.x, cz - q.anchor.z) > LIMITS.LEASH) return null;
	const g = grown(originX, originZ, q);
	for (const b of q.avoid) {
		if (g.x0 <= b.max.x && g.x1 >= b.min.x && g.z0 <= b.max.z && g.z1 >= b.min.z) return null;
	}
	if (boxMeetsKids(g.x0, g.x1, g.z0, g.z1, ctx.kids ?? [])) return null;
	const surf: number[] = [];
	for (let x = g.x0; x <= g.x1; x++) for (let z = g.z0; z <= g.z1; z++) surf.push(top(x, z));
	const sorted = [...surf].sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)];
	if (median < 0 || sorted[0] < median - 1 || sorted[sorted.length - 1] > median + 1) return null;
	let i = 0;
	for (let x = g.x0; x <= g.x1; x++) {
		for (let z = g.z0; z <= g.z1; z++) {
			const s = surf[i++];
			if (own.classify(x, s, z) !== 'natural') return null;
			if (world.isLiquid(world.getBlock(x, s + 1, z))) return null;
			// Nothing solid (a trunk, a stump) up to the template's layer 0; air above it, to the template's height.
			for (let y = s + 1; y <= median + 1; y++) if (world.isSolid(world.getBlock(x, y, z))) return null;
			for (let y = median + 2; y <= median + 1 + q.h; y++) if (world.getBlock(x, y, z) !== 0) return null;
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
	if (own.kidCellWithin(cx, cz, LIMITS.SITE_KID_DIST + Math.max(q.w, q.d) / 2)) return null;
	return { origin: { x: originX, y: median + 1, z: originZ }, groundY: median, digs, fills };
}

const chunkOf = (v: number): number => Math.floor(v / CHUNK);

export class SiteSearch {
	private readonly chunks: Array<[number, number]>;
	private readonly scanned = new Set<string>();
	private readonly tops = new Map<string, number>();
	private readonly done = new Set<string>();
	private best: { site: Site; cost: number; dist: number } | null = null;
	private next = 0;

	constructor(private readonly q: SiteQuery, private readonly ctx: SiteCtx) {
		const r = LIMITS.LEASH;
		const ax = chunkOf(q.anchor.x), az = chunkOf(q.anchor.z);
		const out: Array<[number, number]> = [];
		for (let x = chunkOf(q.anchor.x - r); x <= chunkOf(q.anchor.x + r); x++) {
			for (let z = chunkOf(q.anchor.z - r); z <= chunkOf(q.anchor.z + r); z++) out.push([x, z]);
		}
		// Ring order from the anchor's chunk.
		const ring = (c: [number, number]) => Math.max(Math.abs(c[0] - ax), Math.abs(c[1] - az));
		this.chunks = out.sort((a, b) => ring(a) - ring(b) || Math.hypot(a[0] - ax, a[1] - az) - Math.hypot(b[0] - ax, b[1] - az));
	}

	/**
	 * Scans one chunk per call; returns the best site once every chunk in the leash is scanned, null while scanning, 'none' when nothing qualifies.
	 * A call reads the world only in its own chunk: it caches that chunk's surfaces, then evaluates every candidate
	 * origin whose grown area now lies wholly in scanned chunks (a site across a chunk border waits for its last chunk).
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
		return this.best ? this.best.site : 'none';
	}

	private consider(ox: number, oz: number): void {
		const k = `${ox},${oz}`;
		if (this.done.has(k)) return;
		const g = grown(ox, oz, this.q);
		for (let x = chunkOf(g.x0); x <= chunkOf(g.x1); x++) for (let z = chunkOf(g.z0); z <= chunkOf(g.z1); z++) if (!this.scanned.has(`${x},${z}`)) return;
		this.done.add(k);
		const site = evaluateSite(ox, oz, this.q, this.ctx, (x, z) => this.tops.get(`${x},${z}`)!);
		if (!site) return;
		const cost = site.digs.length + site.fills.length;
		const dist = Math.hypot(ox + this.q.w / 2 - this.q.anchor.x, oz + this.q.d / 2 - this.q.anchor.z);
		if (!this.best || cost < this.best.cost || (cost === this.best.cost && dist < this.best.dist)) this.best = { site, cost, dist };
	}
}
