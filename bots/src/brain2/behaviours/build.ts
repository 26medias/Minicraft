/**
 * Build {template} (spec §6, §6.1): a template on a ±1 site found by the chunked site search, levelled first
 * (dig the median + 1 bumps, fill the median − 1 holes), then placed bottom-up. With renew, the oldest standing
 * build is taken apart first (its `bot` cells only, blocks back to inventory) and the new one goes elsewhere.
 */
import { CRAFTED_ONLY, WORLDGEN_BLOCKS, blockId } from 'minicraft-bot';
import type { WorldView } from '../../port.js';
import type { Action, Build, Vec3 } from '../types.js';
import { LIMITS } from '../data/limits.data.js';
import { key } from '../ownership.js';
import type { Patch } from '../store.js';
import { SiteSearch, type Site } from './site-search.js';
import { templateOf, type Role, type Template } from './templates.data.js';
import type { Behaviour, BehaviourCtx, Next } from './behaviour.js';

export interface BuildParams { template: string; variant: 'small' | 'medium'; materials: Partial<Record<Role, string>>; renew?: boolean; /** tests only: skip the search */ site?: Site }
/** A horizontal footprint, [x0, x1) × [z0, z1), with the feet y of someone standing on the ground beside it. */
interface Footprint { x0: number; x1: number; z0: number; z1: number; feet: number }
export interface BuildPlan {
	params: BuildParams; template: Template; buildId: string;
	dismantle: Vec3[];                       // cells of the build being renewed that are still `bot`
	search: SiteSearch | null; site: Site | null; replans: number;
	cells: Array<{ cell: Vec3; block: string }>;   // the full template, in placement order (door gaps excluded)
	/** The build being renewed (its id and footprint), or null. */
	renew: { id: string; box: Footprint } | null;
	/** Resolved material per role (plan time). */
	mats: Record<Role, string>;
	/** Dismantle cells the bot broke. */
	broken: Set<string>;
	/** Site edits the bot completed, as `break:x,y,z` / `place:x,y,z` (a dug bump is also a template cell). */
	done: Set<string>;
	/** Set when a site is chosen: the next next() returns `wait 0`, whose onResult records the build. */
	record: boolean;
	/** Set when the budget changed (site chosen, replan); recompute() returns it once. */
	changed: boolean;
	/** The cell the last move was for, and how many moves in a row were for it. */
	moves: { cell: string; n: number } | null;
}

/** Close enough to edit (eye-to-cell-centre, eye = feet + 1), as Help-build. */
const REACH = 4.5;
/** Stand points aim this far inside the reach, so an imprecise arrival still reaches. */
const REACH_MARGIN = 0.3;
/** Moves issued for one cell without it coming into reach before the bot gives up (no endless re-walking). */
const MAX_MOVES_PER_CELL = 4;
/** The ring the bot stands on, this far outside the footprint (closer only when the cell needs it). */
const RING = 2;
/** Never closer to the footprint than this (the bot's half-width plus a little): it never stands inside. */
const MIN_RING = 0.35;
/** Levelling fills take the most-held of these. */
const FILL_BLOCKS = ['dirt', 'stone', 'sand', 'grass_block'];
const ROLES: Role[] = ['wall', 'roof', 'floor', 'accent'];

const same = (a: Vec3, b: Vec3): boolean => a.x === b.x && a.y === b.y && a.z === b.z;
const kv = (c: Vec3): string => key(c.x, c.y, c.z);

/** ≥ 50% of b.cells (the FULL template, recorded at plan time) hold their block. */
export function standing(b: Build, world: WorldView): boolean {
	const n = b.cells.filter((c) => world.getBlock(c.cell.x, c.cell.y, c.cell.z) === blockId(c.block)).length;
	return b.cells.length > 0 && n >= b.cells.length / 2;
}

/** A material the bot may place: a worldgen block, not a liquid, not an ore, not CRAFTED_ONLY (spec §5.4). */
function okMaterial(name: unknown, world: WorldView): name is string {
	if (typeof name !== 'string' || !WORLDGEN_BLOCKS.includes(name) || CRAFTED_ONLY.includes(name) || name.endsWith('_ore')) return false;
	const v = blockId(name);
	return v !== null && !world.isLiquid(v);
}

function boxOf(cells: Array<{ cell: Vec3 }>): { min: Vec3; max: Vec3 } {
	const xs = cells.map((c) => c.cell.x), ys = cells.map((c) => c.cell.y), zs = cells.map((c) => c.cell.z);
	return { min: { x: Math.min(...xs), y: Math.min(...ys), z: Math.min(...zs) }, max: { x: Math.max(...xs), y: Math.max(...ys), z: Math.max(...zs) } };
}

/** The search anchor: the nearest kid, else the latest build, else world spawn (spec §6). */
export function anchorOf(ctx: BehaviourCtx): Vec3 {
	const p = ctx.pose;
	const kid = [...ctx.kids].sort((a, b) => Math.hypot(a.pose.x - p.x, a.pose.z - p.z) - Math.hypot(b.pose.x - p.x, b.pose.z - p.z))[0];
	if (kid) return { x: kid.pose.x, y: kid.pose.y, z: kid.pose.z };
	const last = ctx.state.builds.at(-1);
	return last ? { ...last.origin } : { ...ctx.spawn };
}

function newSearch(t: Template, ctx: BehaviourCtx, extra: Array<{ min: Vec3; max: Vec3 }> = []): SiteSearch {
	const avoid = ctx.state.builds.filter((b) => b.status !== 'dismantled' && b.cells.length > 0).map((b) => boxOf(b.cells));
	return new SiteSearch({ w: t.w, d: t.d, h: t.h, anchor: anchorOf(ctx), avoid: [...avoid, ...extra] }, { world: ctx.world, own: ctx.own, spawn: ctx.spawn, kids: ctx.kids.map((k) => k.pose) });
}

function setSite(pl: BuildPlan, site: Site): void {
	pl.site = site;
	pl.cells = pl.template.cells.map((c) => ({ cell: { x: site.origin.x + c.x, y: site.origin.y + c.y, z: site.origin.z + c.z }, block: pl.mats[c.role] }));
	pl.done = new Set();
	pl.record = true;
	pl.changed = true;
}

function siteFootprint(pl: BuildPlan): Footprint {
	const o = pl.site!.origin;
	return { x0: o.x, x1: o.x + pl.template.w, z0: o.z, z1: o.z + pl.template.d, feet: o.y };
}

/** Every site cell not yet completed by the bot (digs, fills, template cells). */
function remaining(pl: BuildPlan): Vec3[] {
	const s = pl.site!;
	return [
		...s.digs.filter((c) => !pl.done.has(`break:${kv(c)}`)),
		...[...s.fills, ...pl.cells.map((c) => c.cell)].filter((c) => !pl.done.has(`place:${kv(c)}`)),
	];
}

/**
 * Reach (spec §6 Build row): the edit when the cell is within reach and the bot isn't inside the footprint;
 * otherwise a walk to the nearest point of the ring RING blocks outside the footprint at ground level (closer
 * when the cell is deep inside it), or a fly to that point at the cell's y when the cell is > 3 above the ground.
 */
function reach(pl: BuildPlan, a: Action & { cell: Vec3 }, fp: Footprint, ctx: BehaviourCtx): Next {
	const c = a.cell, p = ctx.pose;
	const cx = c.x + 0.5, cy = c.y + 0.5, cz = c.z + 0.5;
	const inside = p.x > fp.x0 - MIN_RING && p.x < fp.x1 + MIN_RING && p.z > fp.z0 - MIN_RING && p.z < fp.z1 + MIN_RING;
	if (!inside && Math.hypot(cx - p.x, cy - (p.y + 1), cz - p.z) <= REACH) {
		pl.moves = null;
		return a;
	}
	const ck = kv(c);
	pl.moves = pl.moves?.cell === ck ? { cell: ck, n: pl.moves.n + 1 } : { cell: ck, n: 1 };
	if (pl.moves.n > MAX_MOVES_PER_CELL) return { failed: 'stuck: out of reach' };
	const fly = c.y > fp.feet + 3;
	const feet = fly ? c.y : fp.feet;
	const dy = cy - (feet + 1);
	const h = REACH - REACH_MARGIN;
	if (Math.abs(dy) >= h) return { failed: 'stuck: out of reach' };
	const hb = Math.sqrt(h * h - dy * dy);
	// The four sides: the cell's depth into the footprint from that side, and the stand point at ring distance r.
	const sides = [
		{ din: cx - fp.x0, at: (r: number) => ({ x: fp.x0 - r, z: cz }) },
		{ din: fp.x1 - cx, at: (r: number) => ({ x: fp.x1 + r, z: cz }) },
		{ din: cz - fp.z0, at: (r: number) => ({ x: cx, z: fp.z0 - r }) },
		{ din: fp.z1 - cz, at: (r: number) => ({ x: cx, z: fp.z1 + r }) },
	];
	const standable = (s: { x: number; z: number }): boolean => {
		const x = Math.floor(s.x), z = Math.floor(s.z);
		if (fly) return !ctx.world.isSolid(ctx.world.getBlock(x, feet, z)) && !ctx.world.isSolid(ctx.world.getBlock(x, feet + 1, z));
		const g = ctx.world.groundY(x, z, feet);
		return g !== null && Math.abs(g - feet) <= 1;
	};
	const cands = sides
		.map((s) => ({ r: Math.min(RING, hb - s.din), din: s.din, at: s.at }))
		.filter((s) => s.r >= MIN_RING)
		.map((s) => ({ to: s.at(s.r), cost: s.din + s.r }))
		.map((s) => ({ ...s, ok: standable(s.to), fromBot: Math.hypot(s.to.x - p.x, s.to.z - p.z) }));
	if (cands.length === 0) return { failed: 'stuck: out of reach' };
	const pool = cands.some((s) => s.ok) ? cands.filter((s) => s.ok) : cands;
	pool.sort((a2, b2) => a2.cost - b2.cost || a2.fromBot - b2.fromBot);
	const to = pool[0].to;
	return fly ? { kind: 'fly', to: { x: to.x, y: feet, z: to.z } } : { kind: 'walk', to, speed: ctx.style.walkSpeed };
}

/**
 * Build {template} (spec §6). Order of next(): dismantle breaks (renew), the site search (`wait 100` per chunk),
 * a `wait 0` that records the build, digs top-down, fills, then the template cells bottom-up. A site cell turning
 * `kid` replans once; a second time fails `site taken`. plannedEdits = dismantle + digs + fills + template cells.
 */
export const build: Behaviour<BuildParams, BuildPlan> = {
	kind: 'build',
	typicalMs: [60_000, 300_000],
	plan(p, ctx) {
		let t: Template;
		try {
			t = templateOf(p.template, p.variant);
		} catch {
			return { failed: 'bad template' };
		}
		const given = Object.values(p.materials ?? {});
		if (!given.every((m) => okMaterial(m, ctx.world))) return { failed: 'bad material' };
		const mats = {} as Record<Role, string>;
		for (const role of ROLES) {
			const m = p.materials?.[role] ?? p.materials?.wall;
			if (t.cells.some((c) => c.role === role)) {
				if (!okMaterial(m, ctx.world)) return { failed: 'bad material' };
				mats[role] = m;
			}
		}
		const live = ctx.state.builds.filter((b) => b.status !== 'dismantled' && b.status !== 'reverted' && standing(b, ctx.world));
		let renew: BuildPlan['renew'] = null;
		let dismantle: Vec3[] = [];
		if (p.renew && live.length > 0) {
			const old = live[0];                                   // builds are appended in order: the first is the oldest
			const bx = boxOf(old.cells);
			renew = { id: old.id, box: { x0: bx.min.x, x1: bx.max.x + 1, z0: bx.min.z, z1: bx.max.z + 1, feet: old.origin.y } };
			dismantle = old.cells.map((c) => c.cell)
				.filter((c) => ctx.own.classify(c.x, c.y, c.z) === 'bot' && ctx.world.getBlock(c.x, c.y, c.z) !== 0)
				.sort((a, b) => b.y - a.y);
		} else if (!p.renew && live.length >= LIMITS.MAX_STANDING_BUILDS) {
			return { failed: 'too many builds' };                  // at the cap, only a renew may build (spec §6)
		}
		const pl: BuildPlan = {
			params: p, template: t, buildId: `build-${ctx.now}-${ctx.state.builds.length}`, dismantle, search: null, site: null, replans: 0, cells: [],
			renew, mats, broken: new Set(), done: new Set(), record: false, changed: false, moves: null,
		};
		if (p.site) setSite(pl, p.site);
		else pl.search = newSearch(t, ctx);
		pl.changed = false;                                        // plan()'s budget is read right after plan()
		return pl;
	},
	next(pl, ctx) {
		const w = ctx.world;
		// 1. Dismantle (renew): the old build's cells still `bot`, top-down.
		if (pl.renew) {
			const d = pl.dismantle.find((c) => !pl.broken.has(kv(c)) && w.getBlock(c.x, c.y, c.z) !== 0 && ctx.own.classify(c.x, c.y, c.z) === 'bot');
			if (d) return reach(pl, { kind: 'break', cell: d }, pl.renew.box, ctx);
		}
		// 2. The site search, one chunk per call.
		if (!pl.site) {
			const r = pl.search!.step();
			if (r === null) return { kind: 'wait', ms: 100 };
			if (r === 'none') return { failed: 'no-site' };
			setSite(pl, r);
		}
		if (pl.record) return { kind: 'wait', ms: 0 };
		// A site cell turning `kid`: replan once, then fail.
		if (remaining(pl).some((c) => ctx.own.classify(c.x, c.y, c.z) === 'kid')) {
			if (pl.replans >= 1) return { failed: 'site taken' };
			pl.replans++;
			const old = boxOf(pl.cells);
			pl.site = null;
			pl.cells = [];
			pl.done = new Set();
			pl.search = newSearch(pl.template, ctx, [old]);
			pl.changed = true;
			return { kind: 'wait', ms: 100 };
		}
		const site = pl.site!;
		const fp = siteFootprint(pl);
		// 3. Digs, top-down.
		const dig = [...site.digs].sort((a, b) => b.y - a.y).find((c) => !pl.done.has(`break:${kv(c)}`) && w.getBlock(c.x, c.y, c.z) !== 0);
		if (dig) return reach(pl, { kind: 'break', cell: dig }, fp, ctx);
		// 4. Fills, from the most-held natural block.
		const fill = site.fills.find((c) => !pl.done.has(`place:${kv(c)}`) && w.getBlock(c.x, c.y, c.z) === 0);
		if (fill) {
			const inv = ctx.state.inventory;
			const block = FILL_BLOCKS.reduce((best, b) => ((inv[b] ?? 0) > (inv[best] ?? 0) ? b : best), FILL_BLOCKS[0]);
			if ((inv[block] ?? 0) <= 0) return { failed: `need ${block}` };
			return reach(pl, { kind: 'place', cell: fill, block }, fp, ctx);
		}
		// 5. The template cells, bottom-up in layer order (door gaps are not in `cells`).
		const cell = pl.cells.find((c) => !pl.done.has(`place:${kv(c.cell)}`) && w.getBlock(c.cell.x, c.cell.y, c.cell.z) === 0);
		if (cell) {
			if ((ctx.state.inventory[cell.block] ?? 0) <= 0) return { failed: `need ${cell.block}` };
			return reach(pl, { kind: 'place', cell: cell.cell, block: cell.block }, fp, ctx);
		}
		return 'done';
	},
	plannedEdits: (pl) => pl.dismantle.length + (pl.site ? pl.site.digs.length + pl.site.fills.length : 0) + pl.cells.length,
	owns(pl, a) {
		if (a.kind === 'break') return pl.dismantle.some((c) => same(c, a.cell)) || (pl.site?.digs.some((c) => same(c, a.cell)) ?? false);
		if (a.kind === 'place') return (pl.site?.fills.some((c) => same(c, a.cell)) ?? false) || pl.cells.some((c) => same(c.cell, a.cell));
		return false;
	},
	recompute(pl) {
		const c = pl.changed;
		pl.changed = false;
		return c;
	},
	onResult(pl, a, ok, ctx) {
		if (a.kind === 'wait' && pl.record && pl.site) {
			pl.record = false;
			const rec: Build = { id: pl.buildId, template: pl.template.name, variant: pl.template.variant, origin: { ...pl.site.origin }, cells: pl.cells.map((c) => ({ cell: { ...c.cell }, block: c.block })), status: 'building' };
			const builds = ctx.state.builds;
			const value = builds.some((b) => b.id === pl.buildId) ? builds.map((b) => (b.id === pl.buildId ? rec : b)) : [...builds, rec];
			return [{ path: ['builds'], value }];
		}
		if (!ok || (a.kind !== 'break' && a.kind !== 'place')) return [];
		if (a.kind === 'break' && pl.dismantle.some((c) => same(c, a.cell))) pl.broken.add(kv(a.cell));
		else pl.done.add(`${a.kind}:${kv(a.cell)}`);
		return [];
	},
	endPatch(pl, outcome, _why, ctx) {
		let builds = ctx.state.builds;
		if (outcome === 'done') builds = builds.map((b) => (b.id === pl.buildId ? { ...b, status: 'done' as const } : b));
		else {
			// Not done (batch F concern 2): with none of its cells placed the record goes; with some it is 'abandoned'
			// (renew, avoid and standing() treat it as any other build while its cells remain).
			const rec = builds.find((b) => b.id === pl.buildId);
			if (rec) {
				const placed = rec.cells.some((c) => ctx.own.classify(c.cell.x, c.cell.y, c.cell.z) === 'bot' && ctx.world.getBlock(c.cell.x, c.cell.y, c.cell.z) === blockId(c.block));
				builds = placed ? builds.map((b) => (b.id === pl.buildId ? { ...b, status: 'abandoned' as const } : b)) : builds.filter((b) => b.id !== pl.buildId);
			}
		}
		// The renewed build is dismantled only when it had cells to take apart and every one was broken; else standing() decides.
		if (pl.renew && pl.dismantle.length > 0 && pl.dismantle.every((c) => pl.broken.has(kv(c)))) {
			const id = pl.renew.id;
			builds = builds.map((b) => (b.id === id ? { ...b, status: 'dismantled' as const } : b));
		}
		const out: Patch = builds === ctx.state.builds ? [] : [{ path: ['builds'], value: builds }];
		return out;
	},
};
