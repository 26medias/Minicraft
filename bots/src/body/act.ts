/**
 * Acting (spec §6, §12a, §12b): the follow standing intent, its modes (walk, fly, land, and the
 * last-resort hop), and where `watch` looks.
 *
 * **Follow is a standing intent, never awaited.** Every tick while `follow` is chosen, the target
 * `kid + lead − followDist·unit(kid − bot)` (horizontal; `lead = v·0.5` clamped to `followDist − 0.5`)
 * is recomputed, and the walk or flight is re-issued when the target moved more than 0.5, when the
 * mode changed, or when the last one ended without arriving. The movement promise only updates this
 * state when it settles.
 *
 * **Modes (§12b, engine re-gate):**
 * - **fly** when the kid is flying, or his feet are > 1.5 above the bot's feet or above the bot's
 *   reachable ground (`groundY` at the bot's column), or the last walk was blocked. The fly target is
 *   at the kid's height, clamped ≥ the ground there, and raised out of any liquid (a swimming kid is
 *   followed low above the surface).
 * - **land** when the bot is in the air and the kid has not been flying for > 1 s: fly down to the dry
 *   `groundY` of the target (hover instead when it is liquid, or more than 1.5 below the kid's feet),
 *   then walk. `watch` lands too (`landTick`), so the bot never stays hovering beside a grounded kid.
 * - **walk** otherwise, unless the straight walk would go into liquid (then fly low).
 * - **hop** (a `move` of ≤ 7.5 in 3D, at most 1/s): only after 2 blocked flights (reset by the hop or
 *   by any arrival), when the kid is
 *   > `followDist + 1` away horizontally, and he is flying at > 1 b/s or 3 walks were blocked. The cell
 *   is dry, outside every kid's buffer, and closer to the kid horizontally. With no cell, the bot watches.
 *
 * **Stop:** following holds still when the kid is within `followDist + 1` (3D) and his speed over the
 * last 0.3 s is < 0.5 b/s, so the bot never flies into a kid who stops.
 */
import { BlockedError, EYE_HEIGHT } from 'minicraft-bot';
import type { Body, WorldView } from '../port.js';
import type { KidInfo, Pose, Vec3 } from '../types.js';
import { MOVING_SPEED_THRESHOLD } from '../types.js';
import { VERTICAL_FOLLOW } from './candidates.js';
import { columnKey, kidBuffer } from './guard.js';

/** Re-issue a walk or flight when its target moved more than this. */
export const RETARGET_DIST = 0.5;
/** The lead is the kid's velocity times this (s). */
export const LEAD_S = 0.5;
/** A guard on top of the lead clamp: the follow target is never nearer the kid than this
 *  (horizontally), so a stale lead can't bring the bot within 1 block of a kid who just stopped. */
export const MIN_TARGET_GAP = 1.5;
/** The bot is "in the air" when its feet are more than this above its reachable ground. */
export const AIRBORNE_EPS = 0.25;
/** Land once the kid has not been flying for longer than this. */
export const LAND_AFTER_MS = 1000;
/** A hop's final pose is at most this far from the bot, in 3D (the kids' screens snap above 8). */
export const HOP_MAX = 7.5;
/** At most one hop per this many ms. */
export const HOP_EVERY_MS = 1000;
/** Hops need this many blocked flights in a row (§12b). */
export const HOP_BLOCKED_FLIGHTS = 2;
/** …and a flying kid faster than this (b/s, horizontal), or this many blocked walks (§12a). */
export const HOP_KID_SPEED = 1;
export const HOP_BLOCKED_WALKS = 3;
/** A hop cell must be at least this much closer to the kid, horizontally, than the bot is. */
const HOP_GAIN = 0.1;
/** How far ahead (blocks) a walk's line is checked for liquid. */
const WET_CHECK_MAX = 16;

export type FollowMode = 'walk' | 'fly' | 'land';
export type MoveKind = 'walk' | 'fly';
export type MoveResult = 'arrived' | 'cancelled' | 'blocked' | 'error';

export interface MoveState {
	/** Bumped for every movement started or stopped; a settling promise with an older id is ignored. */
	gen: number;
	kind: MoveKind | null;
	target: Vec3 | null;
	inFlight: boolean;
	lastResult: MoveResult | null;
}

export interface FollowState {
	mode: FollowMode;
	move: MoveState;
	/** Walks and flights blocked since the last arrival (any arrival resets both). */
	blockedWalks: number;
	blockedFlights: number;
	/** The last walk was blocked and no flight has settled since: fly. */
	walkBlocked: boolean;
	lastHopMs: number;
	/** Since when the target kid has not been flying (`null` while he flies), and who he is. */
	kidGroundedSinceMs: number | null;
	kidName: string | null;
	hops: number;
}

export function createFollowState(): FollowState {
	return {
		mode: 'walk',
		move: { gen: 0, kind: null, target: null, inFlight: false, lastResult: null },
		blockedWalks: 0,
		blockedFlights: 0,
		walkBlocked: false,
		lastHopMs: -Infinity,
		kidGroundedSinceMs: null,
		kidName: null,
		hops: 0,
	};
}

function hdist(a: { x: number; z: number }, b: { x: number; z: number }): number {
	return Math.hypot(a.x - b.x, a.z - b.z);
}

function dist3(a: Vec3, b: Vec3): number {
	return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Feet or feet + 1 in liquid at a cell. */
function wetAt(world: WorldView, x: number, y: number, z: number): boolean {
	return world.isLiquid(world.getBlock(x, y, z)) || world.isLiquid(world.getBlock(x, y + 1, z));
}

/**
 * The horizontal follow target: `kid + lead − followDist·unit(kid − bot)`, with the lead clamped to
 * `followDist − 0.5` and the result kept at least `MIN_TARGET_GAP` from the kid.
 */
export function followTarget(kid: KidInfo, bot: Vec3, followDist: number): { x: number; z: number } {
	const dx = kid.pose.x - bot.x, dz = kid.pose.z - bot.z;
	const h = Math.hypot(dx, dz);
	// Straight below or above the kid there is no direction: take −x (deterministic).
	const ux = h > 1e-6 ? dx / h : 1, uz = h > 1e-6 ? dz / h : 0;
	let lx = kid.velocity.x * LEAD_S, lz = kid.velocity.z * LEAD_S;
	const maxLead = Math.max(0, followDist - 0.5);
	const l = Math.hypot(lx, lz);
	if (l > maxLead) {
		lx *= maxLead / l;
		lz *= maxLead / l;
	}
	let tx = kid.pose.x + lx - followDist * ux, tz = kid.pose.z + lz - followDist * uz;
	const gx = tx - kid.pose.x, gz = tz - kid.pose.z;
	const gap = Math.hypot(gx, gz);
	if (gap < MIN_TARGET_GAP) {
		if (gap > 1e-6) {
			tx = kid.pose.x + (gx / gap) * MIN_TARGET_GAP;
			tz = kid.pose.z + (gz / gap) * MIN_TARGET_GAP;
		} else {
			tx = kid.pose.x - ux * MIN_TARGET_GAP;
			tz = kid.pose.z - uz * MIN_TARGET_GAP;
		}
	}
	return { x: tx, z: tz };
}

/** The flight height at (x, z): the kid's height, clamped ≥ the ground there, raised out of liquid. */
export function flyHeight(world: WorldView, x: number, z: number, kidY: number): number {
	let y = kidY;
	const g = world.groundY(Math.floor(x), Math.floor(z), y);
	if (g !== null && g > y) y = g;
	for (let i = 0; i < 64 && wetAt(world, x, Math.floor(y), z); i++) y = Math.floor(y) + 1;
	return y;
}

/** True when the straight walk from the bot to (x, z) crosses a column whose ground is liquid. */
function wetWalk(world: WorldView, bot: Vec3, t: { x: number; z: number }): boolean {
	const d = Math.min(hdist(bot, t), WET_CHECK_MAX);
	const len = hdist(bot, t);
	const steps = Math.max(1, Math.ceil(d / 0.5));
	for (let i = 1; i <= steps; i++) {
		const f = len > 1e-6 ? (i * (d / steps)) / len : 1;
		const x = bot.x + (t.x - bot.x) * f, z = bot.z + (t.z - bot.z) * f;
		const g = world.groundY(Math.floor(x), Math.floor(z), bot.y);
		if (g !== null && wetAt(world, x, g, z)) return true;
	}
	return false;
}

/**
 * The hop cell (§12a, §12b): a column near the bot whose `groundY` g has g and g + 1 dry, outside
 * every kid's buffer, whose final pose (centred on the cell) is ≤ `HOP_MAX` from the bot in 3D, and
 * closer to the kid horizontally than the bot is. The nearest to the kid wins; ties by x, then z.
 */
export function hopCell(world: WorldView, bot: Vec3, kid: Vec3, kids: readonly Vec3[]): Vec3 | null {
	const buffer = kidBuffer(kids);
	const current = hdist(bot, kid);
	const bx = Math.floor(bot.x), bz = Math.floor(bot.z);
	const r = Math.ceil(HOP_MAX);
	let best: Vec3 | null = null;
	let bestScore = Infinity;
	for (let dx = -r; dx <= r; dx++) {
		for (let dz = -r; dz <= r; dz++) {
			const x = bx + dx, z = bz + dz;
			if (buffer.has(columnKey(x, z))) continue;
			const g = world.groundY(x, z, bot.y + 5);
			if (g === null || wetAt(world, x, g, z)) continue;
			const c = { x: x + 0.5, y: g, z: z + 0.5 };
			if (dist3(c, bot) > HOP_MAX) continue;
			const h = hdist(c, kid);
			if (h > current - HOP_GAIN) continue;
			const score = h + dist3(c, kid) * 1e-3;
			if (score < bestScore) {
				bestScore = score;
				best = c;
			}
		}
	}
	return best;
}

/** Stops any walk or flight (the SDK has no cancel: `move(pose())`). */
export function stopMoving(f: FollowState, body: Body): void {
	body.move(body.pose());
	f.move = { gen: f.move.gen + 1, kind: null, target: null, inFlight: false, lastResult: 'cancelled' };
}

function isBlocked(err: unknown): boolean {
	return err instanceof BlockedError || (err instanceof Error && err.name === 'BlockedError');
}

/** Starts a walk or flight without awaiting it; its settlement updates `f` if it is still current. */
function startMove(f: FollowState, body: Body, kind: MoveKind, target: Vec3): void {
	const gen = f.move.gen + 1;
	f.move = { gen, kind, target, inFlight: true, lastResult: null };
	const p = kind === 'walk' ? body.walkTo({ x: target.x, z: target.z }) : body.flyTo({ x: target.x, y: target.y, z: target.z });
	p.then(
		(r) => {
			if (f.move.gen !== gen) return;
			f.move.inFlight = false;
			f.move.lastResult = r;
			if (r === 'arrived') {
				f.blockedWalks = 0;
				f.blockedFlights = 0;
				f.walkBlocked = false;
			}
		},
		(err: unknown) => {
			if (f.move.gen !== gen) return;
			f.move.inFlight = false;
			if (!isBlocked(err)) {
				f.move.lastResult = 'error';
				return;
			}
			f.move.lastResult = 'blocked';
			if (kind === 'walk') {
				f.blockedWalks++;
				f.walkBlocked = true;
			} else {
				f.blockedFlights++;
				f.walkBlocked = false;
			}
		},
	);
}

function fmt(v: Vec3): string {
	return `${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)}`;
}

export interface FollowInput {
	kid: KidInfo;
	/** Every kid's pose (target included): the hop cell stays out of all their buffers. */
	kids: readonly Vec3[];
	followDist: number;
	now: number;
}

/** One tick of the follow standing intent. Never awaits a movement. Returns a short result for the log. */
export function followTick(f: FollowState, body: Body, world: WorldView, input: FollowInput): string {
	const { kid, kids, followDist, now } = input;
	const bot: Pose = body.pose();
	const kidGroundedLong = groundedLong(f, now);
	const reach = world.groundY(Math.floor(bot.x), Math.floor(bot.z), bot.y);
	const botAirborne = reach === null || bot.y - reach > AIRBORNE_EPS;

	// Stop: close and the kid is still over the last 0.3 s (never fly into a kid who stops).
	const settled = dist3(kid.pose, bot) <= followDist + 1 && kid.speedLast0_3s < MOVING_SPEED_THRESHOLD;
	if (settled && !(botAirborne && kidGroundedLong)) {
		if (f.move.inFlight) stopMoving(f, body);
		return 'settled';
	}

	// The last resort: a hop.
	const horizontal = hdist(kid.pose, bot);
	const hopEligible =
		f.blockedFlights >= HOP_BLOCKED_FLIGHTS && horizontal > followDist + 1 && ((kid.flying && kid.speedLast1s > HOP_KID_SPEED) || f.blockedWalks >= HOP_BLOCKED_WALKS);
	if (hopEligible && now - f.lastHopMs >= HOP_EVERY_MS) {
		f.lastHopMs = now;
		const cell = hopCell(world, bot, kid.pose, kids);
		if (!cell) {
			body.lookAt(kid.pose.x, kid.pose.y + EYE_HEIGHT, kid.pose.z);
			return 'no-hop-cell';
		}
		const yaw = Math.atan2(-(kid.pose.x - cell.x), -(kid.pose.z - cell.z));
		body.move({ x: cell.x, y: cell.y, z: cell.z, yaw, pitch: 0 });
		f.move = { gen: f.move.gen + 1, kind: null, target: null, inFlight: false, lastResult: 'cancelled' };
		// A hop answers 2 blocked flights: after it, the bot tries to fly again, and hops again only if
		// 2 more flights are blocked.
		f.blockedFlights = 0;
		f.blockedWalks = 0;
		f.hops++;
		return `hop ${fmt(cell)}`;
	}

	// The mode.
	const t = followTarget(kid, bot, followDist);
	const kidHigh = kid.flying || kid.pose.y - bot.y > VERTICAL_FOLLOW || (reach !== null && kid.pose.y - reach > VERTICAL_FOLLOW);
	let mode: FollowMode;
	if (kidHigh || f.walkBlocked) mode = 'fly';
	else if (botAirborne) mode = kidGroundedLong ? 'land' : 'fly';
	else mode = wetWalk(world, bot, t) ? 'fly' : 'walk';

	let kind: MoveKind;
	let target: Vec3;
	if (mode === 'walk') {
		kind = 'walk';
		target = { x: t.x, y: bot.y, z: t.z };
	} else if (mode === 'land') {
		kind = 'fly';
		const g = world.groundY(Math.floor(t.x), Math.floor(t.z), bot.y);
		const y = landable(world, t.x, t.z, g, kid) ? g! : flyHeight(world, t.x, t.z, kid.pose.y);
		target = { x: t.x, y, z: t.z };
	} else {
		kind = 'fly';
		target = { x: t.x, y: flyHeight(world, t.x, t.z, kid.pose.y), z: t.z };
	}
	f.mode = mode;

	const prev = f.move;
	const moved = prev.target === null ? Infinity : kind === 'walk' ? hdist(prev.target, target) : dist3(prev.target, target);
	const reissue = prev.kind !== kind || moved > RETARGET_DIST || (!prev.inFlight && prev.lastResult !== 'arrived');
	if (!reissue) return `${mode} (holding)`;
	startMove(f, body, kind, target);
	return `${mode} ${fmt(target)}`;
}

/** Tracks since when the target kid has not been flying. Call once per tick with the target. */
export function observeKid(f: FollowState, kid: KidInfo | null, now: number): void {
	const sameKid = kid !== null && kid.name === f.kidName;
	f.kidName = kid?.name ?? null;
	f.kidGroundedSinceMs = kid === null || kid.flying ? null : sameKid ? (f.kidGroundedSinceMs ?? now) : now;
}

function groundedLong(f: FollowState, now: number): boolean {
	return f.kidGroundedSinceMs !== null && now - f.kidGroundedSinceMs > LAND_AFTER_MS;
}

/**
 * The bot lands on `g` at (x, z) only when it is dry and near the kid's level (not more than 1.5
 * below his feet): landing at the foot of a cliff he stands on would only make it fly up again.
 */
function landable(world: WorldView, x: number, z: number, g: number | null, kid: KidInfo): boolean {
	return g !== null && !wetAt(world, x, g, z) && g >= kid.pose.y - VERTICAL_FOLLOW;
}

/**
 * Landing while not following (§12b "land"): the bot is in the air, the kid has not been flying for
 * > 1 s, and the ground straight below is landable → fly down onto it. `null` when there is nothing
 * to do. Never re-issued while the same landing is under way or done.
 */
export function landTick(f: FollowState, body: Body, world: WorldView, kid: KidInfo, now: number): string | null {
	const bot = body.pose();
	const reach = world.groundY(Math.floor(bot.x), Math.floor(bot.z), bot.y);
	const airborne = reach === null || bot.y - reach > AIRBORNE_EPS;
	if (!airborne || !groundedLong(f, now) || !landable(world, bot.x, bot.z, reach, kid)) return null;
	const target = { x: bot.x, y: reach!, z: bot.z };
	const prev = f.move;
	if (prev.kind === 'fly' && prev.target && dist3(prev.target, target) <= RETARGET_DIST && (prev.inFlight || prev.lastResult === 'arrived')) return 'land (holding)';
	f.mode = 'land';
	startMove(f, body, 'fly', target);
	return `land ${fmt(target)}`;
}

/** Where `watch` looks: the kid's look target when he is still, else his eye. */
export function watchPoint(kid: KidInfo): Vec3 {
	if (kid.speedLast0_3s < MOVING_SPEED_THRESHOLD && kid.lookTarget) {
		return { x: kid.lookTarget.x + 0.5, y: kid.lookTarget.y + 0.5, z: kid.lookTarget.z + 0.5 };
	}
	return { x: kid.pose.x, y: kid.pose.y + EYE_HEIGHT, z: kid.pose.z };
}
