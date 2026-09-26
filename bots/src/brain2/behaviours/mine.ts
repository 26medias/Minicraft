/**
 * Mine {block} (spec §6.2, R14): a tunnel-free spiral staircase down to the nearest target, dug in episodes of at
 * most 120 s that end `paused` and resume at the last step. Each step: the floor check (fill or `stuck (gap)`, never
 * re-routing), the hazard check, the 3 cells top-down, then a walk onto the step. At the bottom it mines the target
 * and its vein (only cells `safeToMine`), up to N. Uncovered ores that aren't the target write `found`.
 */
import { blockId } from 'minicraft-bot';
import type { Dig, Vec3, WorldEvent } from '../types.js';
import { LIMITS } from '../data/limits.data.js';
import { SALIENCE } from '../data/salience.data.js';
import { key, type Ownership } from '../ownership.js';
import type { Patch } from '../store.js';
import { anchorOf } from './build.js';
import { boxMeetsKids, groundTop } from './site-search.js';
import { safeToMine, spiralStep, spiralsFor, type Spiral, type Step } from './spiral.js';
import type { Behaviour, BehaviourCtx, Next } from './behaviour.js';

export interface MineParams { block: string; digId?: string }
export interface MinePlan {
	params: MineParams; dig: Dig | null; spiral: Spiral | null;
	scan: { chunks: Array<[number, number]>; best: Vec3 | null } | null;    // target scan, one chunk per next()
	phase: 'scan' | 'descend' | 'target' | 'vein'; stepIdx: number; mined: number; planned: number;
	/** When the 120 s episode started: the first next() after the resume walk-down (null until then). */
	episodeStart: number | null;
	/** The scan's anchor (nearest kid, else latest build, else spawn). */
	anchor: Vec3;
	/** Target candidates found so far, with their horizontal distance to the anchor; `scanned` = chunks done. */
	cands: Array<{ cell: Vec3; d: number }>;
	scanned: number;
	/** Resume walk-down: the next dug step to walk onto, while < `resumeTo` (the dig's stepsDone at plan time). */
	walkDown: number;
	resumeTo: number;
	/** Paused digs found stale at plan time (their cells aren't all `bot` or air): planPatch drops them. */
	dropIds: string[];
	/** Set when a new dig is chosen: the next next() returns `wait 0`, whose onResult records the dig. */
	record: boolean;
	/** Set when the budget changed (a spiral chosen); recompute() returns it once. */
	changed: boolean;
	/** Target cells mined this episode: the vein grows from them. */
	seeds: Vec3[];
}

const CHUNK = 16;
const WORLD_TOP = 255;
/** S = ⌈120 s / (3 × 0.6 s)⌉: the most steps one episode can dig at the fastest pace (spec §6). */
const EPISODE_STEPS = Math.ceil(LIMITS.MINE_EPISODE_MS / (3 * LIMITS.EDIT_GAP_MIN_MS));
/** The pillar area (3×3, radius 1.5 around the pillar) must be ≥ 12 from kid cells (spec §6). */
const KID_DIST = LIMITS.SITE_KID_DIST + 1.5;
const REACH = 4.5;
/** Failures that drop the dig for good: the route is unsafe or a kid's (the others pause it, fixable). */
const DROP_REASONS: readonly string[] = ['hazard', 'stuck (kid-liquid)', 'stuck (kid-block)'];
/** Floor fills take the most-held of these natural blocks. */
const FILL_BLOCKS = ['dirt', 'stone', 'deepslate', 'sand', 'grass_block', 'granite', 'diorite', 'andesite', 'tuff'];
const FACES: ReadonlyArray<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

const same = (a: Vec3, b: Vec3): boolean => a.x === b.x && a.y === b.y && a.z === b.z;
const kv = (c: Vec3): string => key(c.x, c.y, c.z);
const faces = (c: Vec3): Vec3[] => FACES.map(([dx, dy, dz]) => ({ x: c.x + dx, y: c.y + dy, z: c.z + dz }));
const centre = (c: Vec3): { x: number; z: number } => ({ x: c.x + 0.5, z: c.z + 0.5 });

/** Ores already reported this session (spec §6.2: `found` once per cell per session), per session's Ownership. */
const reported = new WeakMap<Ownership, Set<string>>();

/** Whether the pillar's 3×3 meets the body buffer of a kid standing there now (ruling R10). */
function pillarNearKids(sp: Spiral, ctx: BehaviourCtx): boolean {
	return boxMeetsKids(sp.px - 1, sp.px + 1, sp.pz - 1, sp.pz + 1, ctx.kids.map((k) => k.pose));
}

/**
 * Whether the step's edits would touch a kid cell or its buffer, as judgeSafety's 'kid cell buffer': a cell to
 * clear (not air, not liquid) that is a kid's or near one, or an air floor to fill that is a kid's or beside one.
 */
function kidBlocked(st: Step, ctx: BehaviourCtx): boolean {
	const { world: w, own } = ctx;
	for (const c of st.clear) {
		const v = w.getBlock(c.x, c.y, c.z);
		if (v === 0 || w.isLiquid(v)) continue;
		if (own.classify(c.x, c.y, c.z) === 'kid' || own.kidNeighbour(c.x, c.y, c.z, 1) || own.kidNeighbour(c.x, c.y, c.z, 2, true)) return true;
	}
	const f = st.floor;
	return w.getBlock(f.x, f.y, f.z) === 0 && (own.classify(f.x, f.y, f.z) === 'kid' || own.kidNeighbour(f.x, f.y, f.z, 1));
}

function touchesLiquid(c: Vec3, ctx: BehaviourCtx): boolean {
	return faces(c).some((n) => ctx.world.isLiquid(ctx.world.getBlock(n.x, n.y, n.z)));
}

/** plannedEdits (spec §6): the non-air cells to clear in the next S steps (to the last step), the air floors among them, plus N. */
function budget(sp: Spiral, from: number, ctx: BehaviourCtx): number {
	let n = LIMITS.MINE_N;
	for (let i = from; i <= Math.min(sp.lastStep, from + EPISODE_STEPS - 1); i++) {
		const st = spiralStep(sp, i);
		n += st.clear.filter((c) => ctx.world.getBlock(c.x, c.y, c.z) !== 0).length;
		if (ctx.world.getBlock(st.floor.x, st.floor.y, st.floor.z) === 0) n++;
	}
	return n;
}

/** Scope: the chunks overlapping the square of side 2 × LEASH around the anchor, in ring order from its chunk. */
function chunksAround(a: Vec3): Array<[number, number]> {
	const r = LIMITS.LEASH, c = (v: number) => Math.floor(v / CHUNK);
	const ax = c(a.x), az = c(a.z);
	const out: Array<[number, number]> = [];
	for (let x = c(a.x - r); x <= c(a.x + r); x++) for (let z = c(a.z - r); z <= c(a.z + r); z++) out.push([x, z]);
	const ring = (p: [number, number]) => Math.max(Math.abs(p[0] - ax), Math.abs(p[1] - az));
	return out.sort((p, q) => ring(p) - ring(q) || Math.hypot(p[0] - ax, p[1] - az) - Math.hypot(q[0] - ax, q[1] - az));
}

/** The first spiral, over the candidates in order, whose pillar area qualifies (spec §6.2); null when none does. */
function chooseSpiral(pl: MinePlan, ctx: BehaviourCtx): { target: Vec3; sp: Spiral } | null {
	const tops = new Map<string, number>();
	const top = (x: number, z: number): number => {
		const k = `${x},${z}`;
		let v = tops.get(k);
		if (v === undefined) tops.set(k, (v = groundTop(ctx.world, x, z)));
		return v;
	};
	const a = pl.anchor;
	const areaOk = (sp: Spiral): boolean => {
		if (Math.hypot(sp.px - a.x, sp.pz - a.z) > LIMITS.LEASH) return false;
		for (let dx = -1; dx <= 1; dx++) {
			for (let dz = -1; dz <= 1; dz++) {
				const x = sp.px + dx, z = sp.pz + dz, s = top(x, z);
				if (s < 0 || ctx.own.classify(x, s, z) !== 'natural' || ctx.world.isLiquid(ctx.world.getBlock(x, s + 1, z))) return false;
				// Headroom: no trunk (or other solid) in the 2 cells above the surface, where the bot stands and walks.
				if (ctx.world.isSolid(ctx.world.getBlock(x, s + 1, z)) || ctx.world.isSolid(ctx.world.getBlock(x, s + 2, z))) return false;
			}
		}
		return !ctx.own.kidCellWithin(sp.px, sp.pz, KID_DIST) && !pillarNearKids(sp, ctx);
	};
	for (const c of pl.cands) {
		const sp = spiralsFor(c.cell, (x, z) => top(x, z) + 1).find(areaOk);
		if (sp) return { target: c.cell, sp };
	}
	return null;
}

/** One chunk of the target scan per call; when the last chunk is done, chooses the target and spiral. */
function scanStep(pl: MinePlan, ctx: BehaviourCtx): Next {
	const s = pl.scan!, w = ctx.world, bid = blockId(pl.params.block)!;
	if (pl.scanned < s.chunks.length) {
		const [cx, cz] = s.chunks[pl.scanned++];
		for (let x = cx * CHUNK; x < (cx + 1) * CHUNK; x++) {
			for (let z = cz * CHUNK; z < (cz + 1) * CHUNK; z++) {
				const d = Math.hypot(x - pl.anchor.x, z - pl.anchor.z);
				if (d > LIMITS.LEASH) continue;
				for (let y = WORLD_TOP; y >= 0; y--) {
					if (w.getBlock(x, y, z) !== bid) continue;
					if (ctx.own.classify(x, y, z) === 'natural') pl.cands.push({ cell: { x, y, z }, d });
					break;
				}
			}
		}
		// Nearest by horizontal distance, then shallowest.
		pl.cands.sort((p, q) => p.d - q.d || q.cell.y - p.cell.y);
		s.best = pl.cands[0]?.cell ?? null;
		if (pl.scanned < s.chunks.length) return { kind: 'wait', ms: 100 };
	}
	const pick = chooseSpiral(pl, ctx);
	if (!pick) return { failed: 'no-entrance' };
	const sp = pick.sp;
	pl.spiral = sp;
	pl.dig = {
		id: `dig-${ctx.now}-${ctx.state.digs.length}`, block: pl.params.block, entrance: { x: sp.px, y: sp.y0, z: sp.pz }, target: pick.target,
		stepsDone: 0, cells: [], status: 'active', spiral: sp,
	};
	pl.phase = 'descend';
	pl.stepIdx = 0;
	pl.planned = budget(sp, 0, ctx);
	pl.changed = true;
	pl.record = true;
	return { kind: 'wait', ms: 0 };
}

/** Writes the plan's dig (with `fields`) into state.digs. */
function digPatch(pl: MinePlan, ctx: BehaviourCtx, fields: Partial<Dig>): Patch {
	const d = pl.dig!;
	pl.dig = { ...d, ...fields };
	return [{ path: ['digs'], value: ctx.state.digs.map((x) => (x.id === d.id ? pl.dig : x)) }];
}

/** The next vein cell: a target-block face-neighbour of a mined target cell, safe to mine, dry, in reach. */
function veinCell(pl: MinePlan, ctx: BehaviourCtx): Vec3 | null {
	const bid = blockId(pl.params.block)!, p = ctx.pose, sp = pl.spiral!;
	for (const s of pl.seeds) {
		for (const n of faces(s)) {
			if (ctx.world.getBlock(n.x, n.y, n.z) !== bid || !safeToMine(sp, n) || ctx.own.classify(n.x, n.y, n.z) === 'kid') continue;
			if (touchesLiquid(n, ctx)) continue;
			if (Math.hypot(n.x + 0.5 - p.x, n.y + 0.5 - (p.y + 1), n.z + 0.5 - p.z) > REACH) continue;
			return n;
		}
	}
	return null;
}

/**
 * Mine {block} (spec §6.2): resume a paused dig for the block (if its pillar is within the leash of the current
 * anchor), else scan for the nearest target and a qualifying spiral. plannedEdits = the next S steps' non-air cells
 * + their air floors + N. The dig is never left `active`: endPatch writes done, dropped (hazard, kid-liquid, kid-block) or paused.
 */
export const mine: Behaviour<MineParams, MinePlan> = {
	kind: 'mine',
	typicalMs: [30_000, LIMITS.MINE_EPISODE_MS],
	plan(p, ctx) {
		if (typeof p.block !== 'string' || blockId(p.block) === null) return { failed: 'bad block' };
		const anchor = anchorOf(ctx);
		const w = ctx.world;
		// A dig is dropped once its cells aren't all still `bot` (placed) or air (broken) (spec §6).
		const intact = (d: Dig) => d.cells.every((c) => {
			const [x, y, z] = c.split(',').map(Number);
			return w.getBlock(x, y, z) === 0 || ctx.own.classify(x, y, z) === 'bot';
		});
		const dropIds = ctx.state.digs.filter((d) => d.status === 'paused' && !intact(d)).map((d) => d.id);
		const paused = ctx.state.digs.filter((d) => d.status === 'paused' && !dropIds.includes(d.id));
		const resume = paused.find((d) => (p.digId ? d.id === p.digId : d.block === p.block)
			&& Math.hypot(d.spiral.px - anchor.x, d.spiral.pz - anchor.z) <= LIMITS.LEASH && !pillarNearKids(d.spiral, ctx));
		const pl: MinePlan = {
			params: p, dig: null, spiral: null, scan: null, phase: 'scan', stepIdx: 0, mined: 0, episodeStart: null, planned: 0,
			anchor, cands: [], scanned: 0, walkDown: 0, resumeTo: 0, dropIds, record: false, changed: false, seeds: [],
		};
		if (resume) {
			pl.dig = { ...resume, status: 'active' };
			pl.spiral = resume.spiral;
			pl.phase = 'descend';
			pl.stepIdx = resume.stepsDone;
			pl.resumeTo = resume.stepsDone;
			pl.planned = budget(resume.spiral, resume.stepsDone, ctx);
			return pl;
		}
		if (paused.length >= LIMITS.MAX_PAUSED_DIGS) return { failed: 'too many digs' };
		pl.scan = { chunks: chunksAround(anchor), best: null };
		return pl;
	},
	planPatch(pl, ctx) {
		const resumed = pl.dig?.id;
		if (pl.dropIds.length === 0 && !resumed) return [];
		return [{
			path: ['digs'],
			value: ctx.state.digs.map((d) => (pl.dropIds.includes(d.id) ? { ...d, status: 'dropped' as const } : d.id === resumed ? pl.dig : d)),
		}];
	},
	next(pl, ctx) {
		// The episode is timed from the first next() after the resume walk-down (a fresh dig: the first next()).
		if (pl.walkDown >= pl.resumeTo) pl.episodeStart ??= ctx.now;
		if (pl.episodeStart !== null && ctx.now - pl.episodeStart >= LIMITS.MINE_EPISODE_MS) return 'paused';
		if (pl.phase === 'scan') return scanStep(pl, ctx);
		if (pl.record) return { kind: 'wait', ms: 0 };
		const sp = pl.spiral!, w = ctx.world, walkSpeed = ctx.style.walkSpeed;
		// Resume: walk down every dug step in order (walkTo is 2D and lands on the highest standable cell).
		if (pl.walkDown < pl.resumeTo) return { kind: 'walk', to: centre(spiralStep(sp, pl.walkDown).feet), speed: walkSpeed };
		if (pl.phase === 'descend' && pl.stepIdx > sp.lastStep) pl.phase = 'target';
		if (pl.phase === 'descend') {
			const st = spiralStep(sp, pl.stepIdx);
			if (pl.stepIdx === 0) {
				const pc = centre({ x: sp.px, y: 0, z: sp.pz });
				if (Math.hypot(ctx.pose.x - pc.x, ctx.pose.z - pc.z) > 0.5) return { kind: 'walk', to: pc, speed: walkSpeed };   // stand on the pillar
			}
			// 0. A kid's block in (or buffering) this step's edits: the route is his now; the dig is dropped (no re-routing).
			if (kidBlocked(st, ctx)) return { failed: 'stuck (kid-block)' };
			// 1. The floor check: fill an air floor from inventory, else stuck (no re-routing).
			if (w.getBlock(st.floor.x, st.floor.y, st.floor.z) === 0) {
				const inv = ctx.state.inventory;
				const block = FILL_BLOCKS.reduce((best, b) => ((inv[b] ?? 0) > (inv[best] ?? 0) ? b : best), FILL_BLOCKS[0]);
				if ((inv[block] ?? 0) <= 0) return { failed: 'stuck (gap)' };
				return { kind: 'place', cell: st.floor, block };
			}
			// 2. Liquid: a kid's liquid in a route cell, else any liquid in or beside the cells to clear.
			for (const c of st.clear) {
				if (w.isLiquid(w.getBlock(c.x, c.y, c.z))) return ctx.own.classify(c.x, c.y, c.z) === 'kid' ? { failed: 'stuck (kid-liquid)' } : { failed: 'hazard' };
			}
			if (st.clear.some((c) => touchesLiquid(c, ctx))) return { failed: 'hazard' };
			// 3. The 3 cells, top-down, skipping air.
			const c = [...st.clear].reverse().find((x) => w.getBlock(x.x, x.y, x.z) !== 0);
			if (c) return { kind: 'mine', cell: c };
			// 4. Onto the step.
			return { kind: 'walk', to: centre(st.feet), speed: walkSpeed };
		}
		if (pl.mined >= LIMITS.MINE_N) return 'done';
		if (pl.phase === 'target') {
			const t = pl.dig!.target;
			if (w.getBlock(t.x, t.y, t.z) === blockId(pl.params.block)) {
				if (touchesLiquid(t, ctx)) return { failed: 'hazard' };
				return { kind: 'mine', cell: t };
			}
			pl.seeds.push(t);                                          // gone already: its neighbours may still be vein
			pl.phase = 'vein';
		}
		const v = veinCell(pl, ctx);
		return v ? { kind: 'mine', cell: v } : 'done';
	},
	plannedEdits: (pl) => pl.planned,
	owns(pl, a) {
		const sp = pl.spiral;
		if (!sp || !pl.dig) return false;
		if (a.kind === 'place') {
			for (let i = 0; i <= sp.lastStep; i++) if (same(spiralStep(sp, i).floor, a.cell)) return true;
			return false;
		}
		if (a.kind !== 'mine') return false;
		if (same(a.cell, pl.dig.target)) return true;
		for (let i = 0; i <= sp.lastStep; i++) if (spiralStep(sp, i).clear.some((c) => same(c, a.cell))) return true;
		return pl.phase === 'vein' && safeToMine(sp, a.cell) && besideSeed(pl, a.cell);
	},
	recompute(pl) {
		const c = pl.changed;
		pl.changed = false;
		return c;
	},
	onResult(pl, a, ok, ctx) {
		if (a.kind === 'wait' && pl.record && pl.dig) {
			pl.record = false;
			return [{ path: ['digs'], value: [...ctx.state.digs, pl.dig] }];
		}
		if (!ok || !pl.dig) return [];
		if (a.kind === 'walk') {
			if (pl.walkDown < pl.resumeTo) {
				pl.walkDown++;
				return [];
			}
			if (pl.phase === 'descend' && pl.stepIdx <= pl.spiral!.lastStep) {
				const f = centre(spiralStep(pl.spiral!, pl.stepIdx).feet);
				if (a.to.x === f.x && a.to.z === f.z) {
					pl.stepIdx++;
					return digPatch(pl, ctx, { stepsDone: pl.stepIdx });
				}
			}
			return [];
		}
		if (a.kind !== 'mine' && a.kind !== 'place') return [];
		const out: Patch = digPatch(pl, ctx, { cells: [...pl.dig.cells, kv(a.cell)] });
		if (a.kind === 'mine') {
			if (pl.phase === 'target' || pl.phase === 'vein') {
				pl.mined++;
				pl.seeds.push({ ...a.cell });
				pl.phase = 'vein';
			}
			out.push(...foundPatch(pl, a.cell, ctx));
		}
		return out;
	},
	endPatch(pl, outcome, why, ctx) {
		const d = pl.dig;
		if (!d || pl.record || !ctx.state.digs.some((x) => x.id === d.id)) return [];
		const status: Dig['status'] = outcome === 'done' ? 'done' : DROP_REASONS.includes(why) ? 'dropped' : 'paused';
		return digPatch(pl, ctx, { status });
	},
};

/** A vein cell is face-adjacent to a mined target cell. */
function besideSeed(pl: MinePlan, c: Vec3): boolean {
	return pl.seeds.some((s) => faces(s).some((n) => same(n, c)));
}

/** `found` for each ore face-neighbour of a mined cell that isn't the target block, once per cell per session. */
function foundPatch(pl: MinePlan, mined: Vec3, ctx: BehaviourCtx): Patch {
	let seen = reported.get(ctx.own);
	if (!seen) reported.set(ctx.own, (seen = new Set()));
	const fresh: WorldEvent[] = [];
	for (const n of faces(mined)) {
		const name = ctx.world.blockName(ctx.world.getBlock(n.x, n.y, n.z));
		if (!name || !name.endsWith('_ore') || name === pl.params.block || seen.has(kv(n))) continue;
		seen.add(kv(n));
		// ctx.event builds a whole events list per call: take each new event and append them together.
		const p = ctx.event({ kind: 'found', cell: n, block: name });
		fresh.push((p[0].value as WorldEvent[]).at(-1)!);
	}
	if (fresh.length === 0) return [];
	return [{ path: ['events'], value: [...ctx.state.events, ...fresh].slice(-SALIENCE.KEEP_MAX) }];
}

