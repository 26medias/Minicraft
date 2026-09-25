/**
 * Perception (spec §6, §12a, §12b): turns the port's live view into a plain-data `Snapshot`, and a
 * `Snapshot` into the deterministic text state the brain reads.
 *
 * - **Kids** are non-bot players with a pose. Everything about a kid is tracked by NAME, so a kid who
 *   reconnects (new id, same name) keeps his target status, motion history and placements.
 * - **The target** is the nearest kid, sticky, until he leaves, or (§12b) he has been idle for
 *   `idleSwitchMs` while another kid is online: then the nearest other kid who isn't idle, whatever
 *   the distance (ruling R1: there is no distance drop, the bot flies to a far kid); when every other
 *   kid is idle too, round-robin (the least recently targeted, nearest first). A new target is kept
 *   at least `minTargetMs`.
 * - **Idle** (§12b): horizontal speed over the last 1 s < 0.3 b/s and no edit by him. Joining (or
 *   rejoining) counts as activity.
 * - **Motion** comes from pose samples taken on the bot's clock at each `perceive` call.
 * - **Flying** (§12a): not in liquid (feet or feet + 1), and feet more than 1.5 above `groundY` on
 *   every column his box overlaps, for longer than 0.5 s.
 * - **Placements** (§6): only single-op edits that set a solid, non-liquid block, by that kid. The
 *   last 5 are kept.
 */
import { EYE_HEIGHT } from 'minicraft-bot';
import type { FxMsg } from 'minicraft-bot';
import type { Body, PlayerView, WorldView } from '../port.js';
import type { Candidate, EditEvent, KidInfo, Placement, Snapshot, Vec3 } from '../types.js';
import { IDLE_SPEED_THRESHOLD, MOVING_SPEED_THRESHOLD } from '../types.js';
import { boxColumns } from './guard.js';
import type { StopSignal } from './stop-signal.js';

export interface PerceptionTuning {
	followDist: number;
	idleSwitchMs: number;
	minTargetMs: number;
}

/** The look-target raycast's reach (spec §6). */
export const LOOK_REACH = 6;
/** Feet more than this above `groundY` on every box column counts toward flying (§12a). */
export const FLY_HEIGHT = 1.5;
/** …for longer than this. */
export const FLY_HOLD_MS = 500;
/** §6: the kid's last 5 placements are kept. */
export const PLACEMENTS_KEPT = 5;
/** A `fx mine` with no `dur` is taken to last at most this long. */
const MINE_DEFAULT_MS = 10_000;
/** Pose samples older than this are dropped (the longest window is 1 s). */
const SAMPLE_KEEP_MS = 2000;

interface Sample {
	t: number;
	x: number;
	y: number;
	z: number;
}

interface KidTrack {
	samples: Sample[];
	/** The last time he moved (≥ 0.3 b/s over 1 s) or edited; first seen counts as active. */
	lastActiveMs: number;
	airborneSinceMs: number | null;
	lookKey: string;
	lookSinceMs: number;
	placements: { cell: Vec3; block: string; t: number }[];
	/** The cell he is mining and until when (from `fx mine`), or `null`. */
	mining: { cell: Vec3; until: number } | null;
	/** Whether he was online at the previous `perceive` (a rejoin resets his activity and samples). */
	present: boolean;
}

interface TimedFx {
	fx: FxMsg;
	byName: string | null;
	t: number;
}

interface TimedEdit {
	edit: EditEvent;
	t: number;
}

export interface PerceptionState {
	readonly tuning: PerceptionTuning;
	readonly clock: () => number;
	readonly stop: StopSignal | null;
	/** Edits heard since the last `perceive`, stamped with `clock()` when they arrived. */
	inbox: TimedEdit[];
	/** `fx mine` / `mine-stop` heard since the last `perceive`, with the author's name at arrival. */
	fxInbox: TimedFx[];
	kids: Map<string, KidTrack>;
	targetName: string | null;
	targetSinceMs: number;
	lastTargetedMs: Map<string, number>;
	switchedFrom: { name: string; idleMs: number } | null;
	lastActions: Candidate[];
	unsubscribe: () => void;
}

export interface PerceptionOptions {
	tuning: PerceptionTuning;
	clock: () => number;
	stop?: StopSignal;
}

/** Starts perception: subscribes to the body's edits (queued until the next `perceive`). */
export function createPerception(body: Body, opts: PerceptionOptions): PerceptionState {
	const state: PerceptionState = {
		tuning: opts.tuning,
		clock: opts.clock,
		stop: opts.stop ?? null,
		inbox: [],
		fxInbox: [],
		kids: new Map(),
		targetName: null,
		targetSinceMs: 0,
		lastTargetedMs: new Map(),
		switchedFrom: null,
		lastActions: [],
		unsubscribe: () => undefined,
	};
	const offEdit = body.onEdit((edit) => {
		state.inbox.push({ edit, t: state.clock() });
	});
	const offFx = body.onFx((fx) => {
		if (fx.kind !== 'mine' && fx.kind !== 'mine-stop') return;
		const author = body.players().find((p) => p.id === fx.by);
		const byName = author && !author.bot ? author.name : null;
		state.fxInbox.push({ fx, byName, t: state.clock() });
	});
	state.unsubscribe = () => {
		offEdit();
		offFx();
	};
	return state;
}

/** Records the action the bot took this tick (the snapshot keeps the last 3). */
export function recordAction(state: PerceptionState, action: Candidate): void {
	state.lastActions.push(action);
	if (state.lastActions.length > 3) state.lastActions.splice(0, state.lastActions.length - 3);
}

function newTrack(now: number): KidTrack {
	return { samples: [], lastActiveMs: now, airborneSinceMs: null, lookKey: '', lookSinceMs: now, placements: [], mining: null, present: false };
}

function track(state: PerceptionState, name: string, now: number): KidTrack {
	let t = state.kids.get(name);
	if (!t) {
		t = newTrack(now);
		state.kids.set(name, t);
	}
	return t;
}

/** Horizontal distance. */
function hdist(a: { x: number; z: number }, b: { x: number; z: number }): number {
	return Math.hypot(a.x - b.x, a.z - b.z);
}

/** The reference sample for a window: the latest at or before `now − windowMs`, else the oldest. */
function reference(samples: readonly Sample[], now: number, windowMs: number): Sample | null {
	let ref: Sample | null = null;
	for (const s of samples) if (s.t <= now - windowMs) ref = s;
	return ref ?? samples[0] ?? null;
}

function velocityOver(samples: readonly Sample[], now: number, windowMs: number): Vec3 {
	const ref = reference(samples, now, windowMs);
	const last = samples[samples.length - 1];
	if (!ref || !last || last.t - ref.t <= 0) return { x: 0, y: 0, z: 0 };
	const dt = (last.t - ref.t) / 1000;
	return { x: (last.x - ref.x) / dt, y: (last.y - ref.y) / dt, z: (last.z - ref.z) / dt };
}

function isEditActivity(edit: EditEvent, world: WorldView): boolean {
	// A placement or a break; pure liquid flow (sent by the kid whose game simulates it) is not him.
	return edit.cells.some((c) => !world.isLiquid(c.newId));
}

function drainFx(state: PerceptionState): void {
	const inbox = state.fxInbox;
	state.fxInbox = [];
	for (const { fx, byName, t } of inbox) {
		if (byName === null) continue;
		const tr = track(state, byName, t);
		if (fx.kind === 'mine') {
			tr.mining = { cell: { x: fx.x, y: fx.y, z: fx.z }, until: t + (fx.dur ?? MINE_DEFAULT_MS) };
		} else {
			tr.mining = null;
		}
	}
}

function drainEdits(state: PerceptionState, world: WorldView): void {
	const inbox = state.inbox;
	state.inbox = [];
	for (const { edit, t } of inbox) {
		if (edit.byBot || edit.byName === null) continue;
		const tr = track(state, edit.byName, t);
		if (isEditActivity(edit, world)) tr.lastActiveMs = Math.max(tr.lastActiveMs, t);
		// Breaking the cell he was mining ends the mine.
		if (tr.mining && edit.cells.some((c) => c.x === tr.mining!.cell.x && c.y === tr.mining!.cell.y && c.z === tr.mining!.cell.z)) tr.mining = null;
		if (edit.opCount !== 1 || edit.cells.length !== 1) continue;
		const cell = edit.cells[0];
		if (!world.isSolid(cell.newId) || world.isLiquid(cell.newId)) continue;
		const block = world.blockName(cell.newId);
		if (block === null) continue;
		tr.placements.push({ cell: { x: cell.x, y: cell.y, z: cell.z }, block, t });
		if (tr.placements.length > PLACEMENTS_KEPT) tr.placements.splice(0, tr.placements.length - PLACEMENTS_KEPT);
	}
}

/** Liquid at the feet or at feet + 1 (§12a). */
function inLiquid(p: Vec3, world: WorldView): boolean {
	return world.isLiquid(world.getBlock(p.x, p.y, p.z)) || world.isLiquid(world.getBlock(p.x, p.y + 1, p.z));
}

/** Feet more than 1.5 above `groundY` on EVERY column the kid's box overlaps (no ground = high). */
function highAboveGround(p: Vec3, world: WorldView): boolean {
	const [x0, x1, z0, z1] = boxColumns(p);
	for (let x = x0; x <= x1; x++) {
		for (let z = z0; z <= z1; z++) {
			const g = world.groundY(x, z, p.y);
			if (g !== null && p.y - g <= FLY_HEIGHT) return false;
		}
	}
	return true;
}

function lookOf(p: PlayerView, world: WorldView): { cell: Vec3; distance: number } | null {
	const cp = Math.cos(p.pitch);
	const dir: [number, number, number] = [-Math.sin(p.yaw) * cp, Math.sin(p.pitch), -Math.cos(p.yaw) * cp];
	const hit = world.raycast([p.x, p.y + EYE_HEIGHT, p.z], dir, LOOK_REACH);
	return hit ? { cell: { x: hit.x, y: hit.y, z: hit.z }, distance: hit.distance } : null;
}

function updateKid(state: PerceptionState, p: PlayerView, world: WorldView, now: number): KidInfo {
	const tr = track(state, p.name, now);
	if (!tr.present) {
		// Joined or rejoined: a fresh start for his activity clock and motion history.
		tr.present = true;
		tr.lastActiveMs = now;
		tr.samples = [];
		tr.airborneSinceMs = null;
	}
	tr.samples.push({ t: now, x: p.x, y: p.y, z: p.z });
	while (tr.samples.length > 1 && tr.samples[0].t < now - SAMPLE_KEEP_MS) tr.samples.shift();

	const velocity = velocityOver(tr.samples, now, 1000);
	const speedLast1s = Math.hypot(velocity.x, velocity.z);
	const v03 = velocityOver(tr.samples, now, 300);
	const speedLast0_3s = Math.hypot(v03.x, v03.z);
	if (speedLast1s >= IDLE_SPEED_THRESHOLD) tr.lastActiveMs = now;

	const liquid = inLiquid(p, world);
	const airborne = !liquid && highAboveGround(p, world);
	tr.airborneSinceMs = airborne ? (tr.airborneSinceMs ?? now) : null;
	const flying = tr.airborneSinceMs !== null && now - tr.airborneSinceMs > FLY_HOLD_MS;

	const look = lookOf(p, world);
	const lookKey = look ? `${look.cell.x},${look.cell.y},${look.cell.z}` : 'none';
	if (lookKey !== tr.lookKey) {
		tr.lookKey = lookKey;
		tr.lookSinceMs = now;
	}

	if (tr.mining && now >= tr.mining.until) tr.mining = null;
	const placements: Placement[] = tr.placements.map((pl) => ({ cell: { ...pl.cell }, block: pl.block, ageMs: now - pl.t }));
	return {
		name: p.name,
		id: p.id,
		pose: { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch },
		velocity,
		speedLast0_3s,
		speedLast1s,
		flying,
		inLiquid: liquid,
		lookTarget: look ? look.cell : null,
		lookBlock: look ? world.blockName(world.getBlock(look.cell.x, look.cell.y, look.cell.z)) : null,
		lookDistance: look ? look.distance : null,
		lookHeldMs: now - tr.lookSinceMs,
		miningCell: tr.mining ? { ...tr.mining.cell } : null,
		placements,
		idleSinceMs: tr.lastActiveMs === now ? null : tr.lastActiveMs,
	};
}

function idleFor(k: KidInfo, now: number): number {
	return k.idleSinceMs === null ? 0 : now - k.idleSinceMs;
}

/** Plain code-unit order (deterministic, locale-free). */
export function compareNames(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Nearest first, ties by name (deterministic). */
function byDistance(bot: Vec3): (a: KidInfo, b: KidInfo) => number {
	return (a, b) => hdist(a.pose, bot) - hdist(b.pose, bot) || compareNames(a.name, b.name);
}

function selectTarget(state: PerceptionState, kids: KidInfo[], bot: Vec3, now: number): KidInfo | null {
	const { idleSwitchMs, minTargetMs } = state.tuning;
	const setTarget = (k: KidInfo, from: { name: string; idleMs: number } | null): KidInfo => {
		state.targetName = k.name;
		state.targetSinceMs = now;
		state.lastTargetedMs.set(k.name, now);
		state.switchedFrom = from;
		return k;
	};

	// Sticky by name until he leaves (ruling R1: no distance drop).
	const current = kids.find((k) => k.name === state.targetName) ?? null;
	if (!current) {
		const nearest = [...kids].sort(byDistance(bot))[0];
		if (!nearest) {
			state.targetName = null;
			state.switchedFrom = null;
			return null;
		}
		return setTarget(nearest, null);
	}

	state.lastTargetedMs.set(current.name, now);
	const idleMs = idleFor(current, now);
	if (idleMs < idleSwitchMs || now - state.targetSinceMs < minTargetMs) return current;

	const others = kids.filter((k) => k.name !== current.name);
	if (others.length === 0) return current;
	const active = others.filter((k) => idleFor(k, now) < idleSwitchMs).sort(byDistance(bot));
	if (active.length > 0) return setTarget(active[0], { name: current.name, idleMs });
	// Everyone is idle: round-robin — the least recently targeted, nearest first.
	const next = [...others].sort((a, b) => (state.lastTargetedMs.get(a.name) ?? -Infinity) - (state.lastTargetedMs.get(b.name) ?? -Infinity) || byDistance(bot)(a, b))[0];
	return setTarget(next, { name: current.name, idleMs });
}

/**
 * Takes one snapshot. `state` is updated in place (and returned, so callers can thread it). Pure with
 * respect to the port: it only reads `body` and `world`.
 */
export function perceive(state: PerceptionState, body: Body, world: WorldView, nowMs: number): { snapshot: Snapshot; state: PerceptionState } {
	drainEdits(state, world);
	drainFx(state);
	const botPose = body.pose();
	const online = body.players().filter((p) => !p.bot && p.hasPos);
	const onlineNames = new Set(online.map((p) => p.name));
	for (const [name, tr] of state.kids) if (!onlineNames.has(name)) tr.present = false;
	const kids = online.map((p) => updateKid(state, p, world, nowMs));
	const target = selectTarget(state, kids, botPose, nowMs);
	const others = kids.filter((k) => k !== target).sort(byDistance(botPose));
	const snapshot: Snapshot = {
		nowMs,
		followDist: state.tuning.followDist,
		bot: { pose: botPose, lastActions: [...state.lastActions] },
		target,
		others,
		stopActiveForTarget: target !== null && state.stop !== null && state.stop.activeFor(target.name, nowMs),
		switchedFrom: target ? state.switchedFrom : null,
	};
	return { snapshot, state };
}

// ---------------------------------------------------------------------------------------------
// The text state (spec §6): deterministic, from the snapshot only. Names, no pronouns; distances to
// 1 decimal; an 8-point bearing with north = −z (as src/ui/minimap-model.ts).
// ---------------------------------------------------------------------------------------------

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

/** Below this horizontal distance there is no meaningful bearing ("right here", "directly above"). */
export const HERE_DIST = 0.5;

/** The 8-point bearing of a horizontal offset, with north = −z and east = +x; `null` when the offset
 *  is under `HERE_DIST` (there is no direction to name). */
export function bearing(dx: number, dz: number): string | null {
	if (Math.hypot(dx, dz) < HERE_DIST) return null;
	const deg = (Math.atan2(dx, -dz) * 180) / Math.PI;
	const i = ((Math.round(deg / 45) % 8) + 8) % 8;
	return COMPASS[i];
}

const DIRECTION_NAMES: Record<string, string> = {
	'1,0,0': 'east',
	'-1,0,0': 'west',
	'0,0,-1': 'north',
	'0,0,1': 'south',
	'0,1,0': 'up',
	'0,-1,0': 'down',
};

/** The unit axis step from a to b as a direction name, or `null` when it isn't one face step. */
export function stepDirection(a: Vec3, b: Vec3): string | null {
	return DIRECTION_NAMES[`${b.x - a.x},${b.y - a.y},${b.z - a.z}`] ?? null;
}

const RECENT_MS = 20_000;

function motionWord(k: KidInfo): string {
	if (k.flying) return 'flying';
	if (k.inLiquid) return 'swimming';
	if (k.speedLast0_3s >= MOVING_SPEED_THRESHOLD) return 'walking';
	return 'standing still';
}

function placementsText(k: KidInfo): string | null {
	const recent = k.placements.filter((p) => p.ageMs <= RECENT_MS);
	if (recent.length === 0) return null;
	const same = recent.every((p) => p.block === recent[0].block);
	let text = same ? `${k.name} placed ${recent[0].block} ${recent.length === 1 ? 'once' : `${recent.length} times`}` : `${k.name} placed ${recent.length} blocks`;
	text += ' in the last 20 seconds';
	if (recent.length >= 2) {
		const dir = stepDirection(recent[0].cell, recent[1].cell);
		const line = dir !== null && recent.every((p, i) => i === 0 || stepDirection(recent[i - 1].cell, p.cell) === dir);
		if (line) text += `, in a line going ${dir}`;
	}
	return `${text}.`;
}

function lastActionText(action: Candidate | undefined, target: string | null): string {
	const who = target ?? 'the kid';
	switch (action) {
		case 'follow':
			return `You last followed ${who}.`;
		case 'watch':
			return `You last watched ${who}.`;
		case 'help_build':
			return `You last helped ${who} build.`;
		case 'wander':
			return 'You last wandered around.';
		case 'idle':
			return 'You last waited.';
		default:
			return 'You have not done anything yet.';
	}
}

/**
 * Where a kid is, from the bot: "6.2 blocks north-east", "…, 4.0 above you" when |dy| > 1.5; with no
 * horizontal bearing, "6.0 blocks directly above you" / "directly below you", or "right here".
 */
function whereText(p: Vec3, bot: Vec3): string {
	const dx = p.x - bot.x, dy = p.y - bot.y, dz = p.z - bot.z;
	const dist = Math.hypot(dx, dy, dz).toFixed(1);
	const dir = bearing(dx, dz);
	const vertical = Math.abs(dy) > 1.5;
	const updown = dy > 0 ? 'above' : 'below';
	if (dir === null) return vertical ? `${dist} blocks directly ${updown} you` : 'right here';
	return `${dist} blocks ${dir}${vertical ? `, ${Math.abs(dy).toFixed(1)} ${updown} you` : ''}`;
}

/** The deterministic text state for the brain, built from the snapshot only. */
export function renderText(s: Snapshot): string {
	const bot = s.bot.pose;
	const last = s.bot.lastActions[s.bot.lastActions.length - 1];
	const k = s.target;
	if (!k) return `No one is here. ${lastActionText(last, null)}`;
	const parts: string[] = [];
	parts.push(`${k.name} is ${whereText(k.pose, bot)}, ${motionWord(k)}.`);
	if (k.lookTarget && k.lookBlock !== null && k.lookDistance !== null) {
		parts.push(`${k.name} is looking at ${k.lookBlock} ${k.lookDistance.toFixed(1)} blocks ahead.`);
	} else {
		parts.push(`${k.name} is not looking at any block.`);
	}
	const placed = placementsText(k);
	if (placed) parts.push(placed);
	if (s.switchedFrom) parts.push(`You came to ${k.name} because ${s.switchedFrom.name} stood still for ${Math.floor(s.switchedFrom.idleMs / 1000)} seconds.`);
	if (s.others.length > 0) {
		const list = s.others.map((o) => `${o.name}, ${whereText(o.pose, bot)}`);
		parts.push(`Also here: ${list.join('; ')}.`);
	}
	if (s.stopActiveForTarget) parts.push(`${k.name} broke one of your blocks: do not build for ${k.name} now.`);
	parts.push(lastActionText(last, k.name));
	return parts.join(' ');
}
