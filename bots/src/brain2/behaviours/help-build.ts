import type { Vec3 } from '../types.js';
import type { Behaviour, BehaviourCtx } from './behaviour.js';

export interface HelpBuildParams { kid: string; next: Vec3; d: Vec3; block: string }
export interface HelpBuildPlan {
	kid: string; d: Vec3; block: string;
	/** The line's reference cell (the first `next`); a cell's index on the line is its step count from here. */
	origin: Vec3;
	/** The index of the kid's newest cell on the line. */
	head: number;
	/** The cells the bot will place: the two after the kid's newest cell. */
	ahead: Vec3[];
	/** When the kid last placed on this line (bot clock). */
	lastKidT: number;
	/** Set when the kid moved the line forward; recompute() returns it once. */
	moved: boolean;
}

/** Done when the kid places nothing on the line for this long (spec §6). */
const IDLE_MS = 15_000;
/** Close enough to place (eye-to-cell-centre, feet + 1). */
const REACH = 4.5;
/** Walk targets land this much inside the reach circle, so the eye-to-cell-centre distance clears REACH reliably. */
const REACH_MARGIN = 0.15;
const AHEAD = 2;

const at = (o: Vec3, d: Vec3, i: number): Vec3 => ({ x: o.x + d.x * i, y: o.y + d.y * i, z: o.z + d.z * i });
/** The cell's index on the line, or null when it isn't on it. `d` is a unit face step. */
function indexOn(pl: HelpBuildPlan, c: Vec3): number | null {
	const i = (c.x - pl.origin.x) * pl.d.x + (c.y - pl.origin.y) * pl.d.y + (c.z - pl.origin.z) * pl.d.z;
	const p = at(pl.origin, pl.d, i);
	return p.x === c.x && p.y === c.y && p.z === c.z ? i : null;
}
function aheadOf(pl: HelpBuildPlan, head: number): Vec3[] {
	return Array.from({ length: AHEAD }, (_, k) => at(pl.origin, pl.d, head + 1 + k));
}
const same = (a: Vec3, b: Vec3): boolean => a.x === b.x && a.y === b.y && a.z === b.z;

/** Follows the kid's newest placement on the line: moves the line forward when he extended it. */
function track(pl: HelpBuildPlan, ctx: BehaviourCtx): boolean {
	const k = ctx.kids.find((x) => x.name === pl.kid);
	if (!k) return false;
	const mine = k.placements.filter((p) => p.block === pl.block && indexOn(pl, p.cell) !== null);
	if (mine.length === 0) return true;
	const newest = mine.reduce((a, b) => (b.ageMs < a.ageMs ? b : a));
	pl.lastKidT = Math.max(pl.lastKidT, ctx.now - newest.ageMs);
	const i = indexOn(pl, newest.cell)!;
	if (i > pl.head) {
		pl.head = i;
		pl.ahead = aheadOf(pl, i);
		pl.moved = true;
	}
	return true;
}

/**
 * Help-build {P} (spec §6): place the next cells of the kid's line, with his block: free outside
 * must-mine worlds (R12), from inventory in them (a shortage writes `need`). Never for a kid with an
 * active stop signal (spec §7.1). plannedEdits = the cells ahead + 1, recomputed when he extends the line.
 */
export const HELP_BUILD: Behaviour<HelpBuildParams, HelpBuildPlan> = {
	kind: 'help-build',
	typicalMs: [15_000, 90_000],
	plan(p, ctx) {
		if (ctx.stopActive(p.kid)) return { failed: 'stop signal' };
		const pl: HelpBuildPlan = { kid: p.kid, d: { ...p.d }, block: p.block, origin: { ...p.next }, head: -1, ahead: [], lastKidT: -Infinity, moved: false };
		pl.ahead = aheadOf(pl, -1);
		track(pl, ctx);
		// The 15 s count from his last placement on the line (the one that made it), else from now.
		if (pl.lastKidT === -Infinity) pl.lastKidT = ctx.now;
		return pl;
	},
	next(pl, ctx) {
		if (!track(pl, ctx)) return { failed: 'kid gone' };
		if (ctx.stopActive(pl.kid)) return { failed: 'stop signal' };
		if (ctx.now - pl.lastKidT >= IDLE_MS) return 'done';
		if (ctx.mustMine && (ctx.state.inventory[pl.block] ?? 0) <= 0) return { failed: `need ${pl.block}` };
		const cell = pl.ahead.find((c) => ctx.world.getBlock(c.x, c.y, c.z) === 0);
		if (!cell) return { kind: 'wait', ms: 500 };
		const cx = cell.x + 0.5, cz = cell.z + 0.5;
		const dy = cell.y + 0.5 - (ctx.pose.y + 1);
		if (Math.hypot(cx - ctx.pose.x, dy, cz - ctx.pose.z) > REACH) {
			// Height alone puts the cell out of reach: no horizontal point helps (rev fix: the old code walked to a
			// fixed 3-block offset regardless of dy, "arrived" instantly, and looped forever without exiting).
			if (Math.abs(dy) >= REACH) return { failed: 'stuck: out of reach' };
			const offset = Math.max(0, Math.sqrt(REACH * REACH - dy * dy) - REACH_MARGIN);
			let dx = ctx.pose.x - cx, dz = ctx.pose.z - cz;
			let h = Math.hypot(dx, dz);
			if (h < 1e-6) { dx = 1; dz = 0; h = 1; } // standing on the cell's own x/z: pick a direction away from it
			return { kind: 'walk', to: { x: cx + (dx / h) * offset, z: cz + (dz / h) * offset }, speed: ctx.style.walkSpeed };
		}
		return { kind: 'place', cell, block: pl.block, free: !ctx.mustMine };
	},
	plannedEdits: (pl) => pl.ahead.length + 1,
	owns: (pl, a) => a.kind === 'place' && a.block === pl.block && pl.ahead.some((c) => same(c, a.cell)),
	recompute(pl) {
		const m = pl.moved;
		pl.moved = false;
		return m;
	},
	onResult(pl, a, ok, ctx) {
		// Must-mine: the place that used the last block writes `need`; next() then ends {failed: 'need <block>'}.
		if (ok && a.kind === 'place' && !a.free && ctx.mustMine && (ctx.state.inventory[pl.block] ?? 0) <= 0) {
			return ctx.event({ kind: 'need', player: pl.kid, block: pl.block, detail: pl.block });
		}
		return [];
	},
};
