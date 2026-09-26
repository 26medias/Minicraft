/**
 * The shared navigator: every bot's "get to X" goes through here, so all of them move the same way. Movement is code,
 * never a model decision.
 *
 * - `walkOrFly` is brain2's runner movement ("Enderman 3", live-proven), extracted as is: a straight walk; blocked at a
 *   wall or a cliff → a flight to the same column, aimed on top of every column under the body (bodyTop + 1), lifting
 *   straight up first when the route is higher than flyTo's 16-block climb. `mayFly: false` keeps a walk a walk
 *   (brain2: a dig's step columns).
 * - `flyHigh` is the escape for what walkOrFly can't do (a start in a tunnel or under an overhang, a target under a
 *   roof): sideways to the nearest open-sky column within 6, straight up in ≤ 15-block hops, across at the route's
 *   highest surface + 3, then down onto the target's column (or a standable open-sky column beside it).
 * - `navigate` = walkOrFly, then flyHigh when that is blocked; each leg reissued on 'cancelled' while `alive()`.
 * - `StuckWatchdog` is the safety net on top (see its comment).
 */
import type { WalkResult } from 'minicraft-bot';
import { isBlocked } from '../body/act.js';
import { bodyTop, routeTop, topSolid } from '../brain2/behaviours/site-search.js';
import type { Body, WorldView } from '../port.js';
import type { Vec3 } from '../types.js';

/** The highest feet y a flight aims at (the world is 256 high, the body 1.8). */
export const WORLD_TOP_FEET = 254;
/** flyTo climbs at most this far above where it starts (the SDK's FLY_CLIMB_MAX). */
export const FLY_CLIMB = 16;
/** One vertical hop of flyHigh (under FLY_CLIMB). */
export const HOP_UP = 15;
/** flyHigh cruises this far above the route's highest surface. */
export const CRUISE_ABOVE = 3;
/** flyHigh looks this far sideways for an open-sky column. */
export const SKY_SEARCH = 6;
/** A cancelled leg is reissued at most this many times. */
export const MAX_REISSUE = 3;

type Col = { x: number; z: number };
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface WalkOrFlyOpts {
	/** walkTo's speed (brain2's style.walkSpeed); omitted → the SDK default. */
	speed?: number;
	/** false: a blocked walk stays a failure (brain2: a dig's step columns). Default true. */
	mayFly?: boolean;
	/** The goal is still current; a stale one never starts the fallback flight. Default always. */
	alive?: () => boolean;
	/** The fallback flight starts: `via` for the act log, the flight's target and its lift (if any). */
	onFly?: (via: string, to: Vec3, lift: number | null) => void;
}

/**
 * brain2's walk (runner, commits 5cac3a0 / 632111a / ca82565): walkTo; at a wall or a cliff, a flight to the same
 * column. The flight lands on top of every column under the body (bodyTop + 1): groundY from near the bot can land in
 * a cave or under an overhang, which flyTo refuses. flyTo climbs at most 16 above where it starts, so over a taller
 * route it first lifts straight up to clear it (a blocked lift still tries the direct flight). Resolves the last
 * leg's result; rejects with the flight's error (or the walk's, when no flight was allowed).
 */
export async function walkOrFly(body: Body, world: WorldView, to: Col, o: WalkOrFlyOpts = {}): Promise<WalkResult> {
	try {
		return await body.walkTo({ x: to.x, z: to.z }, o.speed !== undefined ? { speed: o.speed } : undefined);
	} catch (walkErr) {
		if (!isBlocked(walkErr) || o.mayFly === false || (o.alive && !o.alive())) throw walkErr;
		const top = bodyTop(world, to.x, to.z);
		const target = { x: to.x, y: top >= 0 ? top + 1 : body.pose().y, z: to.z };
		const from = body.pose();
		const top1 = routeTop(world, from, target) + 1;
		const lift = top1 > from.y + FLY_CLIMB - 1 ? Math.min(top1, WORLD_TOP_FEET) : null;
		o.onFly?.(`fly (${errMsg(walkErr)})`, target, lift);
		if (lift !== null) {
			let r: WalkResult;
			try {
				r = await body.flyTo({ x: from.x, y: lift, z: from.z });
			} catch (liftErr) {
				if (!isBlocked(liftErr)) throw liftErr;
				r = 'arrived'; // blocked overhead: the direct flight may still get there
			}
			if (r === 'cancelled' || (o.alive && !o.alive())) return 'cancelled';
		}
		return await body.flyTo(target);
	}
}

/** True when nothing solid stands in column (x, z) at or above feet y (the sky is open above a body there). */
export function openSky(world: WorldView, x: number, z: number, y: number): boolean {
	return topSolid(world, Math.floor(x), Math.floor(z)) < Math.floor(y);
}

/** Feet cell (x, y, z) and the one above are not solid: a body fits there. */
export function bodyFits(world: WorldView, x: number, y: number, z: number): boolean {
	return !world.isSolid(world.getBlock(x, y, z)) && !world.isSolid(world.getBlock(x, y + 1, z));
}

/**
 * The nearest column within `r` (the bot's own first) where the body fits at feet `fy` and the sky is open above it,
 * as the column centre; null when none.
 */
export function nearestOpenSky(world: WorldView, x: number, fy: number, z: number, r = SKY_SEARCH): Col | null {
	const bx = Math.floor(x), bz = Math.floor(z);
	let best: Col | null = null, bestD = Infinity;
	for (let dx = -r; dx <= r; dx++) {
		for (let dz = -r; dz <= r; dz++) {
			const d = Math.hypot(dx, dz);
			if (d > r || d >= bestD) continue;
			const cx = bx + dx, cz = bz + dz;
			if (bodyFits(world, cx, fy, cz) && openSky(world, cx, cz, fy)) {
				best = { x: cx + 0.5, z: cz + 0.5 };
				bestD = d;
			}
		}
	}
	return best;
}

/**
 * Where to come down for target `to`: its own column (on top of every column under the body), unless the target has
 * a height and that top is more than 2 above it (under an overhang or a roof): then the nearest column within 4 whose
 * top is within ±2 of the target's height and open to the sky.
 */
export function landingFor(world: WorldView, to: { x: number; y?: number; z: number }): Vec3 {
	const top = bodyTop(world, to.x, to.z);
	const own = { x: to.x, y: top >= 0 ? top + 1 : (to.y ?? 64), z: to.z };
	if (to.y === undefined || own.y <= to.y + 2) return own;
	const bx = Math.floor(to.x), bz = Math.floor(to.z);
	let best: Vec3 | null = null, bestD = Infinity;
	for (let dx = -4; dx <= 4; dx++) {
		for (let dz = -4; dz <= 4; dz++) {
			const d = Math.hypot(dx, dz);
			if ((dx === 0 && dz === 0) || d >= bestD) continue;
			const cx = bx + dx + 0.5, cz = bz + dz + 0.5;
			const t = bodyTop(world, cx, cz);
			if (t < 0 || Math.abs(t + 1 - to.y) > 2 || !bodyFits(world, Math.floor(cx), t + 1, Math.floor(cz))) continue;
			best = { x: cx, y: t + 1, z: cz };
			bestD = d;
		}
	}
	return best ?? own;
}

export interface LegOpts {
	alive?: () => boolean;
	maxReissue?: number;
}

/** One flight, reissued on 'cancelled' (a hop, an expression) while `alive()`. Rejects on a block. */
export async function flyLeg(body: Body, to: Vec3, o: LegOpts = {}): Promise<WalkResult> {
	let r: WalkResult = 'cancelled';
	for (let i = 0; i <= (o.maxReissue ?? MAX_REISSUE); i++) {
		if (o.alive && !o.alive()) return 'cancelled';
		r = await body.flyTo(to);
		if (r === 'arrived') return r;
	}
	return r;
}

/** Straight up from where the bot is to feet `y`, in ≤ HOP_UP hops (flyTo's climb cap). */
export async function ascend(body: Body, y: number, o: LegOpts = {}): Promise<WalkResult> {
	const goal = Math.min(y, WORLD_TOP_FEET);
	for (let i = 0; i < 20; i++) {
		const p = body.pose();
		if (p.y >= goal - 1e-6) return 'arrived';
		const r = await flyLeg(body, { x: p.x, y: Math.min(goal, p.y + HOP_UP), z: p.z }, o);
		if (r !== 'arrived') return r;
	}
	return body.pose().y >= goal - 1e-6 ? 'arrived' : 'cancelled';
}

/**
 * "Fly high": sideways to an open-sky column within SKY_SEARCH (the bot's own when open), straight up to the route's
 * highest surface + CRUISE_ABOVE, across, then down onto `landingFor(to)`. Rejects on a blocked leg.
 */
export async function flyHigh(body: Body, world: WorldView, to: { x: number; y?: number; z: number }, o: LegOpts = {}): Promise<WalkResult> {
	const p = body.pose();
	const sky = nearestOpenSky(world, p.x, Math.floor(p.y), p.z);
	if (!sky) throw new Error('flyHigh: no open sky within 6');
	if (Math.floor(sky.x) !== Math.floor(p.x) || Math.floor(sky.z) !== Math.floor(p.z)) {
		const r = await flyLeg(body, { x: sky.x, y: p.y, z: sky.z }, o);
		if (r !== 'arrived') return r;
	}
	const land = landingFor(world, to);
	const cruise = Math.min(Math.max(routeTop(world, sky, land), bodyTop(world, sky.x, sky.z)) + 1 + CRUISE_ABOVE, WORLD_TOP_FEET);
	let r = await ascend(body, cruise, o);
	if (r !== 'arrived') return r;
	const y = body.pose().y;
	r = await flyLeg(body, { x: land.x, y, z: land.z }, o);
	if (r !== 'arrived') return r;
	return flyLeg(body, land, o);
}

export type NavResult = { ok: true; via: 'walk' | 'fly-high' } | { ok: false; reason: string };

export interface NavOpts extends LegOpts {
	speed?: number;
	/** Called once per fallback (`walk-fly`, `fly-high`) for the bot's log. */
	log?: (e: Record<string, unknown>) => void;
	/** The bot's watchdog: told the goal, consulted first, told on arrival. */
	watchdog?: StuckWatchdog;
}

/**
 * Gets the bot to target column `to` (with `y`: a cell height, for landing beside it when it is under a roof):
 * walkOrFly, reissued on 'cancelled'; blocked → flyHigh. Never throws.
 */
export async function navigate(body: Body, world: WorldView, to: { x: number; y?: number; z: number }, o: NavOpts = {}): Promise<NavResult> {
	const wd = o.watchdog;
	wd?.want(to);
	if (wd && (await wd.guard()) === 'abandon') return { ok: false, reason: 'stuck (abandoned by the watchdog)' };
	const alive = () => !o.alive || o.alive();
	// A target under a roof or an overhang: its landing column beside it (else the column itself).
	const dest = to.y !== undefined ? landingFor(world, to) : to;
	let err = '';
	for (let i = 0; i <= (o.maxReissue ?? MAX_REISSUE) && alive(); i++) {
		try {
			const r = await walkOrFly(body, world, dest, { speed: o.speed, alive, onFly: (via, t, lift) => o.log?.({ k: 'walk-fly', to: t, via, ...(lift !== null ? { lift } : {}) }) });
			if (r === 'arrived') {
				wd?.reached();
				return { ok: true, via: 'walk' };
			}
			continue; // cancelled: reissued
		} catch (e) {
			if (!isBlocked(e)) return { ok: false, reason: errMsg(e) };
			err = errMsg(e);
			break;
		}
	}
	if (!alive()) return { ok: false, reason: 'cancelled' };
	if (!err) return { ok: false, reason: 'cancelled too often' };
	o.log?.({ k: 'fly-high', to, after: err });
	try {
		const r = await flyHigh(body, world, to, o);
		if (r === 'arrived') {
			wd?.reached();
			return { ok: true, via: 'fly-high' };
		}
		return { ok: false, reason: 'cancelled' };
	} catch (e) {
		return { ok: false, reason: errMsg(e) };
	}
}

// ── the stuck watchdog ──

/** How long the bot may have a movement goal without moving before the next escalation. */
export const STUCK_MS = 15_000;
/** "Moved": the pose got at least this far (3D) from where the window started. */
export const STUCK_MOVE = 0.5;
/** The air-cell search of level 2 reaches this far (per axis) from the bot. */
export const AIR_SEARCH = 8;

const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;

/**
 * A breadth-first path over air cells (the body fits: the cell and the one above not solid) from the bot's feet cell
 * to the nearest cell with the sky open above it, within AIR_SEARCH per axis. The path's cell centres (feet y), the
 * start excluded; [] when the bot is under open sky already; null when none is reachable.
 */
export function airPathToSky(world: WorldView, from: Vec3): Vec3[] | null {
	const sx = Math.floor(from.x), sy = Math.floor(from.y), sz = Math.floor(from.z);
	const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
	const prev = new Map<string, string | null>([[key(sx, sy, sz), null]]);
	let frontier: Array<[number, number, number]> = [[sx, sy, sz]];
	while (frontier.length) {
		const next: Array<[number, number, number]> = [];
		for (const [x, y, z] of frontier) {
			if (openSky(world, x, z, y)) {
				const path: Vec3[] = [];
				for (let k: string | null = key(x, y, z); k && k !== key(sx, sy, sz); k = prev.get(k) ?? null) {
					const [px, py, pz] = k.split(',').map(Number);
					path.unshift({ x: px + 0.5, y: py, z: pz + 0.5 });
				}
				return path;
			}
			for (const [dx, dy, dz] of N6) {
				const nx = x + dx, ny = y + dy, nz = z + dz;
				if (Math.abs(nx - sx) > AIR_SEARCH || Math.abs(ny - sy) > AIR_SEARCH || Math.abs(nz - sz) > AIR_SEARCH || ny < 1) continue;
				const k = key(nx, ny, nz);
				if (prev.has(k) || !bodyFits(world, nx, ny, nz)) continue;
				prev.set(k, key(x, y, z));
				next.push([nx, ny, nz]);
			}
		}
		frontier = next;
	}
	return null;
}

export type UnstickLevel = 1 | 2 | 3;

export interface WatchdogOpts {
	body: Body;
	world: WorldView;
	clock?: () => number;
	log?: (e: Record<string, unknown>) => void;
	stuckMs?: number;
}

/**
 * The stuck watchdog: while the bot has a movement goal (`want`, cleared by `reached`/`clear`) and its pose moves less
 * than 0.5 blocks in 15 s, each `guard()` call escalates one level:
 * 1. navigator "fly high" from here to the goal;
 * 2. (enclosed: a tunnel, a cave) along air cells to the nearest open-sky cell within 8, then straight up;
 * 3. the last resort: a teleport (`move`) straight up to the column's top + 2 — one visible jump.
 * After level 3 `guard()` answers 'abandon': the caller drops the current action and picks a new goal. Every level
 * logs an `unstick` line.
 */
export class StuckWatchdog {
	private goal: { x: number; y?: number; z: number } | null = null;
	private anchor: Vec3;
	private since: number;
	private level = 0;
	private busy = false;
	private clearedAt: number | null;
	private readonly clock: () => number;
	private readonly stuckMs: number;
	log: (e: Record<string, unknown>) => void;

	constructor(private readonly o: WatchdogOpts) {
		this.clock = o.clock ?? (() => Date.now());
		this.stuckMs = o.stuckMs ?? STUCK_MS;
		this.log = o.log ?? (() => undefined);
		this.anchor = o.body.pose();
		this.since = this.clock();
		this.clearedAt = this.since;
	}

	/** The watchdog for this body, one per body, created on first use (every bot on a body shares it). */
	static for(body: Body, world: WorldView, opts: Omit<WatchdogOpts, 'body' | 'world'> = {}): StuckWatchdog {
		let w = registry.get(body);
		if (!w) {
			w = new StuckWatchdog({ body, world, ...opts });
			registry.set(body, w);
		}
		return w;
	}

	get active(): boolean {
		return this.goal !== null;
	}

	/**
	 * A movement goal is active. The stuck window keeps running across goals (a brain2 behaviour that fails its walk
	 * and gives way to another is still stuck); it restarts only when the bot moves, arrives, or had no goal for 15 s.
	 */
	want(goal: { x: number; y?: number; z: number }): void {
		if (!this.goal && this.clearedAt !== null && this.clock() - this.clearedAt >= this.stuckMs) {
			this.level = 0;
			this.rebase();
		}
		this.goal = { ...goal };
		this.clearedAt = null;
	}

	/** The goal was reached: no escalation pending. */
	reached(): void {
		this.goal = null;
		this.clearedAt = this.clock();
		this.level = 0;
		this.rebase();
	}

	/** No movement goal for now (the bot is busy with something else: a placement, a mine). */
	clear(): void {
		if (this.goal) this.clearedAt = this.clock();
		this.goal = null;
	}

	private rebase(): void {
		this.anchor = this.o.body.pose();
		this.since = this.clock();
	}

	/** The level due now (0 = none): only while a goal is active and the bot stayed within 0.5 for 15 s. */
	due(): number {
		const p = this.o.body.pose();
		if (Math.hypot(p.x - this.anchor.x, p.y - this.anchor.y, p.z - this.anchor.z) >= STUCK_MOVE) {
			this.rebase();
			return 0;
		}
		if (!this.goal) return 0;
		return this.clock() - this.since >= this.stuckMs ? Math.min(this.level + 1, 3) : 0;
	}

	/** Runs the escalation that is due, if any. 'abandon' after the last resort. */
	async guard(): Promise<'ok' | 'abandon'> {
		if (this.busy) return 'ok';
		const lv = this.due() as 0 | UnstickLevel;
		if (lv === 0) return 'ok';
		this.busy = true;
		const p = this.o.body.pose();
		const goal = this.goal!;
		let ok = false, err: string | undefined;
		try {
			ok = await unstick(this.o.body, this.o.world, lv, goal);
		} catch (e) {
			err = errMsg(e);
		} finally {
			this.busy = false;
		}
		this.log({ k: 'unstick', level: lv, how: HOW[lv], ok, at: { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 }, stuckMs: this.clock() - this.since, ...(err ? { err } : {}) });
		this.level = lv;
		this.rebase();
		if (lv === 3) {
			this.level = 0;
			this.clear();
			this.log({ k: 'unstick', level: 3, abandon: true });
			return 'abandon';
		}
		return 'ok';
	}
}

const HOW: Record<UnstickLevel, string> = { 1: 'fly-high', 2: 'air-path', 3: 'teleport-up' };
const registry = new WeakMap<Body, StuckWatchdog>();

/** One escalation level (see StuckWatchdog). True when its moves all arrived. */
export async function unstick(body: Body, world: WorldView, level: UnstickLevel, goal: { x: number; y?: number; z: number }): Promise<boolean> {
	if (level === 1) return (await flyHigh(body, world, goal)) === 'arrived';
	const p = body.pose();
	if (level === 2) {
		const path = airPathToSky(world, p);
		if (!path) return false;
		for (const c of path) if ((await flyLeg(body, c)) !== 'arrived') return false;
		const q = body.pose();
		return (await ascend(body, bodyTop(world, q.x, q.z) + 1 + CRUISE_ABOVE)) === 'arrived';
	}
	const top = topSolid(world, Math.floor(p.x), Math.floor(p.z));
	body.move({ x: p.x, y: Math.min(Math.max(top + 2, p.y), WORLD_TOP_FEET), z: p.z });
	return true;
}
