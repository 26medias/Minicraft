/**
 * Candidates (spec §6, amended by §12a and §12b): the actions offered to the brain this tick. Only
 * feasible ones are offered.
 *
 * | Action       | Offered when |
 * |--------------|--------------|
 * | `follow`     | a target kid is > `followDist + 1` away horizontally, or > 1.5 above/below (§12b stairs), or moving |
 * | `watch`      | a target kid exists |
 * | `help_build` | edits are allowed and the §12a line rule holds (see `helpBuildPlan`) |
 * | `wander`     | no kid present, and a standable spot 4–8 away within `wanderTether` of the anchor exists |
 * | `idle`       | always |
 *
 * `planCandidates` also returns what the loop (Task 4) needs to act: the `help_build` cell and block,
 * and the wander spot. Offering `help_build` records its line in `guard.offeredLines`: it is offered
 * **at most once per line** (§12a).
 */
import { EYE_HEIGHT } from 'minicraft-bot';
import type { WorldView } from '../port.js';
import type { Candidate, KidInfo, Placement, Snapshot, Vec3 } from '../types.js';
import { MOVING_SPEED_THRESHOLD } from '../types.js';
import { columnKey, inBodyBox, kidBuffer } from './guard.js';

/** The per-session edit state and wander parameters the loop owns and passes in. */
export interface EditGuard {
	/** `--no-edits`. */
	noEdits: boolean;
	/** Edits left in the session's budget (`editBudget` minus edits made). */
	budgetLeft: number;
	editEveryMs: number;
	/** When the bot last edited (its clock), or `null` before its first edit. */
	lastEditMs: number | null;
	/** Lines `help_build` was already offered for; candidates adds to it when it offers one. */
	offeredLines: Set<string>;
	wanderTether: number;
	/** The last kid position, or the spawn: the wander tether's centre. */
	anchor: Vec3;
	/** The session's seeded random source (spec §6: wander is seeded per session). */
	rng: () => number;
}

export interface HelpBuildPlan {
	/** N = C0 + (C0 − B): the cell to place. */
	cell: Vec3;
	/** C0's block. */
	block: string;
	/** The line's key (kid, axis direction, fixed coordinates, block). */
	line: string;
}

export interface CandidatePlan {
	candidates: Candidate[];
	helpBuild: HelpBuildPlan | null;
	wander: Vec3 | null;
}

/** §12b: `follow` is also offered when the kid is more than this far above or below the bot. */
export const VERTICAL_FOLLOW = 1.5;
/** §12a: each placement gap, and the last placement's age, in ms. */
export const LINE_GAP_MS = 4000;
/** §12a: the look target held (and no placement) for at least this long. */
export const AIM_HOLD_MS = 1000;
/** §12a: N within this of the bot's eye. */
export const REACH = 6;
const AIR = 0;
const WANDER_MIN = 4;
const WANDER_MAX = 8;
const WANDER_TRIES = 24;

function sub(a: Vec3, b: Vec3): Vec3 {
	return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function add(a: Vec3, b: Vec3): Vec3 {
	return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function eq(a: Vec3, b: Vec3): boolean {
	return a.x === b.x && a.y === b.y && a.z === b.z;
}

/** True for a single face step (one axis, ±1). */
function isUnitStep(d: Vec3): boolean {
	return Math.abs(d.x) + Math.abs(d.y) + Math.abs(d.z) === 1;
}

function faceNeighbours(c: Vec3): Vec3[] {
	return [
		{ x: c.x + 1, y: c.y, z: c.z },
		{ x: c.x - 1, y: c.y, z: c.z },
		{ x: c.x, y: c.y + 1, z: c.z },
		{ x: c.x, y: c.y - 1, z: c.z },
		{ x: c.x, y: c.y, z: c.z + 1 },
		{ x: c.x, y: c.y, z: c.z - 1 },
	];
}

/** The line through `cell` along `d`: the kid, the direction, the two fixed coordinates, the block. */
function lineKey(kid: string, cell: Vec3, d: Vec3, block: string): string {
	const fixed = d.x !== 0 ? `y${cell.y},z${cell.z}` : d.y !== 0 ? `x${cell.x},z${cell.z}` : `x${cell.x},y${cell.y}`;
	return `${kid}|${d.x},${d.y},${d.z}|${fixed}|${block}`;
}

function editsAllowed(s: Snapshot, world: WorldView, guard: EditGuard): boolean {
	if (guard.noEdits || world.mustMine || guard.budgetLeft <= 0) return false;
	if (s.stopActiveForTarget) return false;
	if (guard.lastEditMs !== null && s.nowMs - guard.lastEditMs < guard.editEveryMs) return false;
	return true;
}

/**
 * §12a `help_build`: the line rule, without the edit-permission checks. Returns the plan, or `null`.
 * Does not record the line; `planCandidates` does that when it offers it.
 */
export function helpBuildPlan(s: Snapshot, world: WorldView, guard: EditGuard): HelpBuildPlan | null {
	const kid = s.target;
	if (!kid || kid.placements.length < 3) return null;
	const [a, b, c0]: Placement[] = kid.placements.slice(-3);

	// Same block, collinear and consecutive: two equal face steps.
	if (a.block !== b.block || b.block !== c0.block) return null;
	const d = sub(b.cell, a.cell);
	if (!isUnitStep(d) || !eq(sub(c0.cell, b.cell), d)) return null;

	// Timing: each gap ≤ 4 s, the last one < 4 s old.
	if (a.ageMs - b.ageMs > LINE_GAP_MS || b.ageMs - c0.ageMs > LINE_GAP_MS) return null;
	if (c0.ageMs >= LINE_GAP_MS) return null;

	// Aiming: the look target on B or a face-neighbour of N, held ≥ 1 s with no placement.
	const n = add(c0.cell, d);
	const look = kid.lookTarget;
	if (!look) return null;
	if (!eq(look, b.cell) && !faceNeighbours(n).some((f) => eq(f, look))) return null;
	if (kid.lookHeldMs < AIM_HOLD_MS || c0.ageMs < AIM_HOLD_MS) return null;

	// At most once per line.
	const line = lineKey(kid.name, c0.cell, d, c0.block);
	if (guard.offeredLines.has(line)) return null;

	// N: AIR, outside every kid's buffer and body box, within reach of the bot's eye.
	if (world.getBlock(n.x, n.y, n.z) !== AIR) return null;
	const kids = allKids(s).map((k) => k.pose);
	if (kidBuffer(kids).has(columnKey(n.x, n.z))) return null;
	if (inBodyBox(n, kids)) return null;
	const bot = s.bot.pose;
	const reach = Math.hypot(n.x + 0.5 - bot.x, n.y + 0.5 - (bot.y + EYE_HEIGHT), n.z + 0.5 - bot.z);
	if (reach > REACH) return null;

	return { cell: n, block: c0.block, line };
}

function allKids(s: Snapshot): KidInfo[] {
	return s.target ? [s.target, ...s.others] : [...s.others];
}

/** A standable, dry cell centre near (x, z), or `null`. */
function standable(world: WorldView, x: number, z: number, nearY: number): Vec3 | null {
	const cx = Math.floor(x), cz = Math.floor(z);
	const g = world.groundY(cx, cz, nearY);
	if (g === null || Math.abs(g - nearY) > 4) return null;
	if (world.isLiquid(world.getBlock(cx, g, cz)) || world.isLiquid(world.getBlock(cx, g + 1, cz))) return null;
	return { x: cx + 0.5, y: g, z: cz + 0.5 };
}

/**
 * A walkable spot 4–8 blocks from the bot, within `wanderTether` of the anchor (spec §6), drawn from
 * the session's seeded `rng`. A bot outside the tether heads back: the spot is taken toward the anchor.
 */
export function wanderSpot(s: Snapshot, world: WorldView, guard: EditGuard): Vec3 | null {
	const bot = s.bot.pose;
	const anchor = guard.anchor;
	const tether = guard.wanderTether;
	for (let i = 0; i < WANDER_TRIES; i++) {
		const angle = guard.rng() * Math.PI * 2;
		const r = WANDER_MIN + guard.rng() * (WANDER_MAX - WANDER_MIN);
		const spot = standable(world, bot.x + Math.cos(angle) * r, bot.z + Math.sin(angle) * r, bot.y);
		if (spot && Math.hypot(spot.x - anchor.x, spot.z - anchor.z) <= tether) return spot;
	}
	const toAnchor = Math.hypot(anchor.x - bot.x, anchor.z - bot.z);
	if (toAnchor > tether) {
		const step = Math.min(WANDER_MAX, toAnchor);
		const spot = standable(world, bot.x + ((anchor.x - bot.x) / toAnchor) * step, bot.z + ((anchor.z - bot.z) / toAnchor) * step, bot.y);
		if (spot) return spot;
	}
	return null;
}

/** The candidates and what acting on them needs. Records an offered `help_build` line in `guard`. */
export function planCandidates(s: Snapshot, world: WorldView, guard: EditGuard): CandidatePlan {
	const out: Candidate[] = [];
	const kid = s.target;
	let helpBuild: HelpBuildPlan | null = null;
	let wander: Vec3 | null = null;

	if (kid) {
		const bot = s.bot.pose;
		const horizontal = Math.hypot(kid.pose.x - bot.x, kid.pose.z - bot.z);
		const vertical = Math.abs(kid.pose.y - bot.y);
		const moving = kid.speedLast0_3s >= MOVING_SPEED_THRESHOLD;
		if (horizontal > s.followDist + 1 || vertical > VERTICAL_FOLLOW || moving) out.push('follow');
		out.push('watch');
		if (editsAllowed(s, world, guard)) {
			helpBuild = helpBuildPlan(s, world, guard);
			if (helpBuild) {
				guard.offeredLines.add(helpBuild.line);
				out.push('help_build');
			}
		}
	}
	if (allKids(s).length === 0) {
		wander = wanderSpot(s, world, guard);
		if (wander) out.push('wander');
	}
	out.push('idle');
	return { candidates: out, helpBuild, wander };
}

/** The feasible candidates this tick (spec §6). See `planCandidates` for the side effect on `guard`. */
export function candidates(s: Snapshot, world: WorldView, guard: EditGuard): Candidate[] {
	return planCandidates(s, world, guard).candidates;
}
