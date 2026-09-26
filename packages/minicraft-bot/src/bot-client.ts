/**
 * BotClient (spec §6, §12a): one bot in one Minicraft multiplayer world. It connects with the game's own
 * `MpClient`, keeps a `BotWorld`, and acts like a player: move, walk, look, place, break, mine.
 * - Refusals (a bad block, bedrock, a kid's cell, not connected any more) RESOLVE `false`; they never
 *   reject, so a fire-and-forget call can't crash the bot with an unhandled rejection. Only programming
 *   errors throw: `NotConnectedError` (before `connect()` resolved or after `close()`), a malformed colour.
 * - The safety net: every edit waits `editGapMs` (150 ms) after the previous one, and is journaled so
 *   `revert()` can undo the bot's own edits without touching a kid's later change.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { MpClient, type MpHandlers, type MpState } from '../../../src/net/mp-client';
import { MpApi } from '../../../src/net/mp-api';
import { GIVE_UP_MS, Reconnector } from '../../../src/game/mp-reconnect';
import { isRemovableId, miningDuration } from '../../../src/game/tools';
import { EYE_HEIGHT, FLY_SPEED, WALK_SPEED } from '../../../src/game/player-constants';
import { NEWEST_GEN_VERSION } from '../../../src/engine/world/generation';
import { AIR, BLOCKS, BLOCK_BY_NAME, isLiquid, isSolid } from '../../../src/data/blocks.data';
import {
	CLIENT_VERSION,
	CLOSE,
	POS_EVERY_MS,
	PROTO,
	colorToInt,
	type EditOut,
	type ErrorMsg,
	type FxMsg,
	type Hello,
	type LeavingMsg,
	type PlayerInfo,
	type ServerMsg,
	type Spawn,
	type Welcome,
	type WorldListing,
} from '../../../src/net/protocol';
import type { StorageLike } from '../../../src/net/mp-sync';
import { createWorld, blockId, type BotWorld, type Pose, type WorldCore } from './bot-world';
import { BlockedError, NotConnectedError, OutdatedClientError, ReplacedError, ServerRefusedError } from './errors';

/** A WebSocket constructor with the standard API (Node ≥ 22's global `WebSocket`, the default). */
export type WebSocketCtor = new (url: string) => unknown;

export type BotClientOptions = {
	/** The server's HTTP(S) base, e.g. `http://127.0.0.1:18080`; the WebSocket URL is derived from it. */
	url: string;
	/** The server's static token (the same one the site uses). */
	token: string;
	/** The browser id. Default: the one saved in `statePath`, else `bot-<fnv1a32(name)>`, stable across restarts. */
	bid?: string;
	/**
	 * A JSON file `{bid, world, journal}`: the edit journal survives restarts, so `revert()` still works. A
	 * journal is kept for one world: connecting to another world starts a new one (with a warning).
	 */
	statePath?: string;
	/**
	 * The minimum time between two edits, in ms (default 150). Floored at MIN_EDIT_GAP_MS (20): the
	 * kids' send queues cap at 1 MiB, and a flood of edits gets them kicked with 4002. `0` clamps to
	 * the floor rather than turning the gap off.
	 */
	editGapMs?: number;
	/** Tests only: a WebSocket constructor (default: `globalThis.WebSocket`). */
	WebSocket?: WebSocketCtor;
};

export type ConnectOptions = {
	/** The world's uuid (from `listWorlds()`). */
	world: string;
	/** The bot's display name (the same name rule as players; shown as "🤖 name"). */
	name: string;
	/** A skin name, e.g. `enderman`. */
	skin: string;
};

/** Another player in the world. `hasPos` false: they joined but sent no pose yet (x … pitch are meaningless). */
export type BotPlayer = {
	id: number;
	name: string;
	skin: string;
	bot: boolean;
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch: number;
	hasPos: boolean;
};

/** `spawn`: the server's spawn mode, with x … pitch where the bot was actually placed (its first pose). */
export type ConnectResult = { you: number; spawn: Spawn; players: BotPlayer[]; world: BotWorld };

/** How a `walkTo` or `flyTo` ended without being blocked. */
export type WalkResult = 'arrived' | 'cancelled';

/** One of the bot's own edits: the cell, what was there, what the bot put, and when (`Date.now()`). */
/** `oldColor`: the lamp colour that was there (#RRGGBB), when there was one; `revert` restores it. */
export type JournalEntry = { x: number; y: number; z: number; oldId: number; newId: number; t: number; oldColor?: string };

/** A pose update for `move`: yaw and pitch default to the current ones. */
export type PoseInput = { x: number; y: number; z: number; yaw?: number; pitch?: number };

export type BotEvents = {
	/** Someone joined (they have no pose until their first tick). */
	join: (player: BotPlayer) => void;
	/** Someone left. */
	left: (id: number) => void;
	/** A player's pose changed (once per player per server tick). */
	pose: (player: BotPlayer) => void;
	/** A server-ordered edit (anyone's, the bot's own echoes included). `world.onBlockChange` is usually handier. */
	edit: (msg: EditOut) => void;
	/** A cosmetic effect (mining, TNT, fireworks). */
	fx: (msg: FxMsg) => void;
	/** A player's play-time countdown (`secondsLeft` 0: they went home). */
	leaving: (msg: LeavingMsg) => void;
	/** The bot is disconnected for good (a fatal close, the reconnect gave up, or `close()`: 1000). */
	close: (code: number) => void;
	/** The connection came back; `world` was rebuilt in place and the pose re-sent. */
	reconnect: () => void;
};

type State = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';
type Settle = { resolve: (r: WalkResult) => void; reject: (e: BlockedError) => void };
type Walk = Settle & { kind: 'walk'; tx: number; tz: number; falling: boolean; speed: number };
/**
 * `ticks` / `maxTicks`: a backstop that rejects `wall` if a flight never settles. No geometry found (unit
 * tests, a 400-flight fuzz) reaches it; it only guarantees a flight can't run forever.
 * `climbed`: the last move was a climb, and no clear horizontal step has happened since.
 */
type Flight = Settle & { kind: 'fly'; tx: number; ty: number; tz: number; startY: number; ticks: number; maxTicks: number; climbed: boolean };
/** walkTo and flyTo share one movement slot: starting either cancels the other. */
type Motion = Walk | Flight;
type Mining = { x: number; y: number; z: number; timer: ReturnType<typeof setTimeout>; resolve: (ok: boolean) => void };
type SavedState = { bid?: string; world?: string; journal?: JournalEntry[] };

const DEFAULT_EDIT_GAP_MS = 150;
/** The edit gap floor (README): below this, the kids' send queues (capped at 1 MiB) can flood and get them kicked with 4002. */
const MIN_EDIT_GAP_MS = 20;
/** Blocks per pose step (0.5). */
const STEP = (WALK_SPEED * POS_EVERY_MS) / 1000;
/** walkTo is done within this horizontal distance. */
const ARRIVE = 0.3;
/** The largest drop per pose step while walking. */
const MAX_DROP = 2;
/** A step-up's jump: the first pose rises this share of the step, the next one lands (spec §12b). */
const JUMP_ARC = 0.6;
/** Blocks per pose step while flying (1.0). */
const FLY_STEP = (FLY_SPEED * POS_EVERY_MS) / 1000;
/** flyTo climbs at most this far above the flight's start y. */
const FLY_CLIMB_MAX = 16;
/** The player's body box: x ± 0.3, z ± 0.3, feet to feet + 1.8 (the game's player SIZE). */
const BODY_HALF = 0.3;
const BODY_HEIGHT = 1.8;
/** The oldest journal entries are dropped beyond this. */
const JOURNAL_MAX = 10_000;
const BEDROCK_ID = BLOCK_BY_NAME['bedrock'].id;
const LAMP_ID = BLOCK_BY_NAME['lamp'].id;

class MemStorage implements StorageLike {
	private m = new Map<string, string>();
	getItem(k: string): string | null {
		return this.m.get(k) ?? null;
	}
	setItem(k: string, v: string): void {
		this.m.set(k, v);
	}
	removeItem(k: string): void {
		this.m.delete(k);
	}
}

/** FNV-1a 32 of the UTF-8 bytes, as 8 hex digits. */
function fnv1a32hex(s: string): string {
	let h = 0x811c9dc5;
	for (const b of new TextEncoder().encode(s)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
	return h.toString(16).padStart(8, '0');
}

/** The game's pose key (main.ts): an unchanged key is not re-sent. */
function poseKey(p: Pose): string {
	return `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)},${p.yaw.toFixed(3)},${p.pitch.toFixed(3)}`;
}

/** A NaN or infinite pose would reach the kids' screens as garbage: a programming error, thrown. */
function finite(action: string, ...v: number[]): void {
	if (!v.every((n) => typeof n === 'number' && Number.isFinite(n))) throw new RangeError(`${action}: coordinates must be finite numbers, got ${v.join(', ')}`);
}

function clampPitch(p: number): number {
	return Math.max(-Math.PI / 2, Math.min(Math.PI / 2, p));
}

function toPlayer(p: PlayerInfo): BotPlayer {
	return { id: p.id, name: p.name, skin: p.skin, bot: p.bot ?? false, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, hasPos: p.hasPos };
}

/** Spec §6: the typed error for a refusal (a fatal close before or after the welcome). */
function refusalError(code: number | undefined, err: ErrorMsg | undefined): Error {
	if (code === CLOSE.proto && err?.message === 'outdated') return new OutdatedClientError(CLIENT_VERSION, err.min ?? 0);
	if (code === CLOSE.replaced) return new ReplacedError();
	return new ServerRefusedError(code ?? 1006, err?.message ?? `connection closed (${code ?? 'no code'})`);
}

function readState(path: string): SavedState {
	if (!existsSync(path)) return {};
	const raw = readFileSync(path, 'utf8');
	let s: unknown;
	try {
		s = JSON.parse(raw);
	} catch {
		throw new Error(`minicraft-bot: statePath ${path} is not valid JSON; fix or delete it`);
	}
	const o = (s ?? {}) as SavedState;
	const isEntry = (e: unknown): e is JournalEntry => {
		const r = e as JournalEntry;
		return (
			!!r &&
			[r.x, r.y, r.z, r.oldId, r.newId, r.t].every((v) => typeof v === 'number' && Number.isFinite(v)) &&
			(r.oldColor === undefined || (typeof r.oldColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(r.oldColor)))
		);
	};
	return {
		bid: typeof o.bid === 'string' ? o.bid : undefined,
		world: typeof o.world === 'string' ? o.world : undefined,
		journal: Array.isArray(o.journal) ? o.journal.filter(isEntry) : [],
	};
}

export class BotClient {
	private readonly api: MpApi;
	/** One per client, shared by every MpClient it opens (the two-4003 counter survives a reconnect). */
	private readonly storage = new MemStorage();
	private readonly gap: number;
	private state: State = 'idle';
	private mp: MpClient | null = null;
	private botWorld: BotWorld | null = null;
	/** The writable world behind `botWorld`; never handed out. */
	private core: WorldCore | null = null;
	/** When the connection was first lost (ms), until the bot is back in the world; bounds the reconnect. */
	private lostSince: number | null = null;
	private join: ConnectOptions | null = null;
	private bidValue: string | null;
	private me = 0;
	private catalogMax = 0;
	private cur: Pose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
	private others = new Map<number, BotPlayer>();
	private lastKey = '';
	private posTimer: ReturnType<typeof setInterval> | null = null;
	/** Pose ticks so far. */
	private tickNo = 0;
	/** Added to the SENT y for the current tick only: a step-up's jump is display-only, `cur` stays on the ground. */
	private lift = 0;
	/** The tick and position of the last jump pose: a walk step from there on the next tick lands instead of jumping again. */
	private arc: { tick: number; x: number; y: number; z: number } | null = null;
	private motion: Motion | null = null;
	private mining: Mining | null = null;
	/** Edits (and revert) run one after another through this chain. */
	private chain: Promise<unknown> = Promise.resolve();
	private lastEditAt = -Infinity;
	private entries: JournalEntry[];
	/** The world the loaded journal belongs to (a journal is only ever reverted in its own world). */
	private journalWorld: string | undefined;
	private reconnector: Reconnector | null = null;
	private pending: { resolve: (r: ConnectResult) => void; reject: (e: Error) => void } | null = null;
	private listeners = new Map<keyof BotEvents, Set<unknown>>();

	constructor(private readonly opts: BotClientOptions) {
		this.api = new MpApi(opts.url, opts.token);
		this.gap = Math.max(MIN_EDIT_GAP_MS, opts.editGapMs ?? DEFAULT_EDIT_GAP_MS);
		const saved = opts.statePath ? readState(opts.statePath) : {};
		this.bidValue = opts.bid ?? saved.bid ?? null;
		this.entries = saved.journal ?? [];
		this.journalWorld = saved.world;
	}

	/** `GET /worlds`: every world's uuid, name and who is online (bots are not listed as online). */
	listWorlds(): Promise<WorldListing[]> {
		return this.api.listWorlds();
	}

	/**
	 * Joins a world. Resolves after the snapshot is applied and the spawn pose is sent (a player with no
	 * pose is invisible to the kids). Rejects with `OutdatedClientError` (rebuild the SDK), `ReplacedError`
	 * (4001), or `ServerRefusedError{code}` (4004 proto, 4005–4009, a lost connection before the welcome).
	 */
	connect(o: ConnectOptions): Promise<ConnectResult> {
		if (this.state !== 'idle') return Promise.reject(new Error('connect: a BotClient connects once; make a new one'));
		this.join = { ...o };
		this.bidValue ??= 'bot-' + fnv1a32hex(o.name);
		if (this.journalWorld !== undefined && this.journalWorld !== o.world && this.entries.length > 0) {
			// Never revert one world's edits in another: that would change a kid's world.
			console.warn(`minicraft-bot: ${this.opts.statePath} holds a journal for world ${this.journalWorld}; starting a new one for ${o.world}`);
			this.entries = [];
		}
		this.journalWorld = o.world;
		this.persist();
		this.state = 'connecting';
		return new Promise<ConnectResult>((resolve, reject) => {
			this.pending = { resolve, reject };
			this.open(false);
		});
	}

	/** The browser id this bot joins with. */
	get bid(): string {
		return this.bidValue ?? '';
	}

	/** The bot's player id in this connection. */
	get you(): number {
		return this.me;
	}

	/** The live world model (the same object across reconnects). */
	get world(): BotWorld {
		if (!this.botWorld || this.state === 'idle' || this.state === 'closed') throw new NotConnectedError('world');
		return this.botWorld;
	}

	/** The bot's own current pose. */
	pose(): Pose {
		return { ...this.cur };
	}

	/** The other players (never the bot itself), with their latest poses. */
	players(): BotPlayer[] {
		return [...this.others.values()].map((p) => ({ ...p }));
	}

	/**
	 * Sets the bot's pose. Sent at most once per POS_EVERY_MS (the latest pose wins); an unchanged pose is
	 * not re-sent. A jump over 8 blocks snaps on the kids' screens. Cancels a walk or a flight (it resolves
	 * 'cancelled').
	 */
	move(pose: PoseInput): void {
		this.assertConnected('move');
		finite('move', pose.x, pose.y, pose.z, pose.yaw ?? 0, pose.pitch ?? 0);
		this.cancelMotion();
		this.cur = { x: pose.x, y: pose.y, z: pose.z, yaw: pose.yaw ?? this.cur.yaw, pitch: clampPitch(pose.pitch ?? this.cur.pitch) };
	}

	/**
	 * Walks in a straight line to (x, z) at WALK_SPEED, one pose per POS_EVERY_MS, feet on `groundY` at each
	 * step, facing the way it goes. Steps up at most 1 block, shown as a jump over 2 poses (+0.6 of the step
	 * in place, then it lands on it; so each step-up costs 1 extra tick). The jump is display-only: `pose()`
	 * stays on the ground. It drops at most 2 per step (a deeper drop continues on the next steps
	 * before moving on). Not pathfinding: it checks only the centre column (it can clip wall corners), and a
	 * wall or a cliff it can't climb rejects with `BlockedError`. Resolves 'arrived' within 0.3 blocks, or
	 * 'cancelled' when a new `walkTo` or `flyTo`, a `move`, a lost connection or `close()` ends it. `lookAt`
	 * and `mine` don't cancel it. `speed` (0, 1] scales the pace (brain2 style, spec §5.5).
	 */
	walkTo(target: { x: number; z: number }, opts: { speed?: number } = {}): Promise<WalkResult> {
		this.assertConnected('walkTo');
		finite('walkTo', target.x, target.z);
		const speed = opts.speed ?? 1;
		if (!(speed > 0 && speed <= 1)) throw new RangeError(`walkTo: speed must be in (0, 1], got ${speed}`);
		this.cancelMotion();
		if (this.state !== 'connected') return Promise.resolve('cancelled');
		return new Promise<WalkResult>((resolve, reject) => {
			this.motion = { kind: 'walk', tx: target.x, tz: target.z, falling: false, speed, resolve, reject };
		});
	}

	/**
	 * Flies in a straight 3D line to (x, y, z) (the feet) at FLY_SPEED, one pose per POS_EVERY_MS (never more
	 * than 1 block per pose, so it never snaps on the kids' screens), facing the target. The body box
	 * (x ± 0.3, z ± 0.3, feet to feet + 1.8) never enters a solid block: when the next step would, it moves
	 * horizontally if that is clear, else drops toward the target's height if the way across is open there,
	 * else climbs straight up (+1 per pose, each climb pose clear too) until it can go on, at most 16 blocks
	 * above the flight's start y and below the world top. After a climb it doesn't dive back down before it
	 * has moved across (no bobbing). Ends exactly on the target. Rejects `BlockedError{wall}` when it can't go
	 * on (a ceiling, an enclosure, a wall over 16 high) and whenever it is straight above or below the target
	 * and blocked (a target under a roof or an overhang, even one open at the side, or inside solid blocks),
	 * and `BlockedError{noGround}` for a target outside the world. Shares
	 * `walkTo`'s slot: a new `walkTo` or `flyTo`, a `move`, a lost connection or `close()` resolves it
	 * 'cancelled' (never a rejection). `lookAt` and `mine` don't cancel it.
	 */
	flyTo(target: { x: number; y: number; z: number }): Promise<WalkResult> {
		this.assertConnected('flyTo');
		finite('flyTo', target.x, target.y, target.z);
		this.cancelMotion();
		if (this.state !== 'connected') return Promise.resolve('cancelled');
		const w = this.core!;
		if (!w.inBounds(target.x, target.y, target.z) || target.y + BODY_HEIGHT > w.height) {
			return Promise.reject(new BlockedError({ ...this.cur }, 'noGround', 'flyTo'));
		}
		const c = this.cur;
		const d0 = Math.hypot(target.x - c.x, target.y - c.y, target.z - c.z);
		return new Promise<WalkResult>((resolve, reject) => {
			this.motion = {
				kind: 'fly',
				tx: target.x,
				ty: target.y,
				tz: target.z,
				startY: c.y,
				ticks: 0,
				maxTicks: Math.ceil((4 * (d0 + 2 * FLY_CLIMB_MAX)) / FLY_STEP) + 20,
				climbed: false,
				resolve,
				reject,
			};
		});
	}

	/** Turns to look at a point: yaw and pitch from the eye (feet + EYE_HEIGHT). Only rotates. */
	lookAt(x: number, y: number, z: number): void {
		this.assertConnected('lookAt');
		finite('lookAt', x, y, z);
		this.face(x, y, z);
	}

	/**
	 * Places block `name` at a cell (`color` `#RRGGBB` for a lamp). Waits the edit gap first. Resolves
	 * false (sending nothing) for: an unknown or retired name, air, bedrock, an id above the server's
	 * catalog, a cell out of the world, a cell inside a kid's body, or a lost connection.
	 */
	place(x: number, y: number, z: number, name: string, color?: string): Promise<boolean> {
		this.assertConnected('place');
		const id = blockId(name);
		if (id === LAMP_ID && color !== undefined) colorToInt(color);
		const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
		return this.edit(() => {
			if (id === null || !this.placeable(id, name) || !this.core!.inBounds(fx, fy, fz) || this.insideKid(fx, fy, fz)) return false;
			return this.write(fx, fy, fz, id, id === LAMP_ID ? color : undefined);
		});
	}

	/** Breaks the block at a cell (to air). Waits the edit gap. Resolves false for bedrock, air, out of the world. */
	break(x: number, y: number, z: number): Promise<boolean> {
		this.assertConnected('break');
		const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
		return this.edit(() => {
			const w = this.core!;
			if (!w.inBounds(fx, fy, fz)) return false;
			const id = w.getBlock(fx, fy, fz);
			if (id === AIR || id === BEDROCK_ID) return false;
			return this.write(fx, fy, fz, AIR);
		});
	}

	/**
	 * Mines a block the way a kid does with the hand: faces it, sends `fx mine` (the kids see cracks), waits
	 * `ms` (default: the hand's mining time for that block), then breaks it. Resolves false (no fx) for a
	 * block that can't be mined (air, liquid, bedrock), and false with `fx mine-stop` when cancelled by a
	 * new `mine`, a lost connection or `close()`, or when the cell no longer holds the block it started on
	 * just before the break (a kid changed it). Doesn't cancel a walk or a flight.
	 */
	mine(x: number, y: number, z: number, ms?: number): Promise<boolean> {
		this.assertConnected('mine');
		this.cancelMine();
		if (this.state !== 'connected') return Promise.resolve(false);
		const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
		const id = this.core!.getBlock(fx, fy, fz);
		if (!isRemovableId(id)) return Promise.resolve(false);
		this.face(fx + 0.5, fy + 0.5, fz + 0.5);
		const dur = ms !== undefined ? Math.max(0, Math.round(ms)) : Math.round(miningDuration(BLOCKS[id].hardness, 0, 'none') * 1000);
		this.send({ t: 'fx', kind: 'mine', x: fx, y: fy, z: fz, tier: id, dur });
		return new Promise<boolean>((resolve) => {
			const m: Mining = {
				x: fx,
				y: fy,
				z: fz,
				resolve,
				timer: setTimeout(() => {
					if (this.mining !== m) return;
					this.mining = null;
					if (this.state !== 'connected') return resolve(false);
					// Re-checked inside the edit function (spec §7): the break runs after the edit gap, and a kid may
					// have put another block in the cell by then. Never destroy it.
					resolve(
						this.edit(() => {
							if (this.core!.getBlock(fx, fy, fz) !== id) {
								this.send({ t: 'fx', kind: 'mine-stop', x: fx, y: fy, z: fz });
								return false;
							}
							return this.write(fx, fy, fz, AIR);
						}),
					);
				}, dur),
			};
			this.mining = m;
		});
	}

	/** Sends a raw cosmetic effect (e.g. `{kind: 'firework', x, y, z}`). */
	fx(msg: Omit<FxMsg, 't' | 'by'>): void {
		this.assertConnected('fx');
		this.send({ t: 'fx', ...msg });
	}

	/** The bot's edit journal, oldest first. */
	journal(): JournalEntry[] {
		return this.entries.map((e) => ({ ...e }));
	}

	/**
	 * Undoes the bot's own edits, newest first, made at or after `sinceMs` (a `Date.now()` timestamp;
	 * default: all). A cell is restored only while it still holds what the bot put there, so a kid's later
	 * change is never overwritten; a solid block is not restored into a kid's body (kept for a later revert).
	 * Every restored cell is written first, then the whole batch is sent in messages of at most
	 * MAX_OPS_PER_EDIT ops — never one `edit` per cell. Revert's own writes are not journaled and skip the
	 * edit gap. Resolves the number of cells restored.
	 */
	revert(sinceMs = -Infinity): Promise<number> {
		this.assertConnected('revert');
		const run = (): number => {
			if (this.state !== 'connected') return 0;
			const w = this.core!;
			const kept: JournalEntry[] = [];
			const deferred = new Set<string>();
			let n = 0;
			for (let i = this.entries.length - 1; i >= 0; i--) {
				const e = this.entries[i];
				const key = `${e.x},${e.y},${e.z}`;
				if (e.t < sinceMs || deferred.has(key)) {
					kept.push(e);
					continue;
				}
				if (w.getBlock(e.x, e.y, e.z) !== e.newId) continue;
				if (isSolid(e.oldId) && this.insideKid(e.x, e.y, e.z)) {
					deferred.add(key);
					kept.push(e);
					continue;
				}
				w.localSet(e.x, e.y, e.z, e.oldId, e.oldColor, false);
				n++;
			}
			if (n > 0) w.flushWrites();
			this.entries = kept.reverse();
			this.persist();
			return n;
		};
		const p = this.chain.then(run, run);
		this.chain = p.catch(() => 0);
		return p;
	}

	/** Subscribes to an event; returns the unsubscribe function. */
	on<K extends keyof BotEvents>(event: K, cb: BotEvents[K]): () => void {
		let set = this.listeners.get(event);
		if (!set) this.listeners.set(event, (set = new Set()));
		set.add(cb);
		return () => {
			set.delete(cb);
		};
	}

	/** Leaves the world: cancels a walk or flight and a mine (with `mine-stop`), closes the socket, emits `close(1000)`. */
	close(): void {
		if (this.state === 'closed') return;
		if (this.state === 'idle') {
			this.state = 'closed';
			return;
		}
		this.finish(1000);
	}

	// ── connection ──

	private open(resume: boolean): void {
		const j = this.join!;
		const hello: Hello = {
			t: 'hello',
			world: j.world,
			name: j.name,
			skin: j.skin,
			bid: this.bid,
			proto: PROTO,
			gen: NEWEST_GEN_VERSION,
			resume,
			ver: CLIENT_VERSION,
			bot: true,
		};
		let welcome: Welcome | null = null;
		// The handlers ignore a replaced client (its constructor reports 'connecting' before it is assigned).
		const ref: { client?: MpClient } = {};
		const isCurrent = (): boolean => ref.client !== undefined && this.mp === ref.client;
		const handlers: MpHandlers = {
			onWelcome: (w) => {
				if (isCurrent()) welcome = w;
			},
			onSnapshot: (buf) => {
				if (isCurrent() && welcome) this.onJoined(welcome, buf);
			},
			onMessage: (m) => {
				if (isCurrent()) this.onServerMessage(m);
			},
			onState: (st, code, err) => {
				if (isCurrent()) this.onSocketState(st, code, err);
			},
		};
		ref.client = this.withWebSocket(() => new MpClient(this.opts.url, this.opts.token, hello, handlers, undefined, this.storage));
		this.mp = ref.client;
	}

	/**
	 * MpClient opens `new WebSocket(…)` from the global scope. An injected constructor (tests) is installed
	 * as the global for that one synchronous call and restored right after.
	 */
	private withWebSocket<T>(make: () => T): T {
		const Ctor = this.opts.WebSocket;
		if (!Ctor) {
			if (typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'function') {
				throw new Error('minicraft-bot needs Node >= 22 (a global WebSocket)');
			}
			return make();
		}
		const before = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
		Object.defineProperty(globalThis, 'WebSocket', { value: Ctor, writable: true, configurable: true });
		try {
			return make();
		} finally {
			if (before) Object.defineProperty(globalThis, 'WebSocket', before);
			else delete (globalThis as { WebSocket?: unknown }).WebSocket;
		}
	}

	private onJoined(welcome: Welcome, buf: ArrayBuffer): void {
		const first = this.botWorld === null;
		try {
			if (first) {
				const made = createWorld(welcome, buf, (m) => this.send(m), welcome.you);
				this.botWorld = made.view;
				this.core = made.core;
			} else {
				this.core!.reset(welcome, buf, welcome.you);
			}
		} catch (err) {
			// A malformed snapshot: this connection is useless.
			const e = new ServerRefusedError(0, `malformed snapshot: ${(err as Error).message}`);
			if (this.pending) {
				const p = this.pending;
				this.pending = null;
				this.teardown(false);
				this.state = 'closed';
				p.reject(e);
			} else {
				this.finish(1006);
			}
			return;
		}
		this.me = welcome.you;
		this.catalogMax = welcome.catalogMax;
		this.others = new Map(welcome.players.filter((p) => p.id !== welcome.you).map((p) => [p.id, toPlayer(p)]));
		this.lostSince = null;
		if (first) this.cur = this.core!.spawnPose(welcome.spawn);
		this.state = 'connected';
		this.sendPose();
		this.startPosTimer();
		if (this.pending) {
			const p = this.pending;
			this.pending = null;
			p.resolve({ you: welcome.you, spawn: { ...welcome.spawn, ...this.cur }, players: this.players(), world: this.botWorld! });
		} else {
			this.emit('reconnect');
		}
	}

	private onServerMessage(m: ServerMsg): void {
		switch (m.t) {
			case 'edit':
				this.core?.onServerEdit(m);
				this.emit('edit', m);
				break;
			case 'tick':
				for (const [id, x, y, z, yaw, pitch] of m.poses) {
					const p = this.others.get(id);
					if (!p) continue;
					Object.assign(p, { x, y, z, yaw, pitch, hasPos: true });
					this.emit('pose', { ...p });
				}
				break;
			case 'join':
				if (m.id === this.me) break;
				this.others.set(m.id, { id: m.id, name: m.name, skin: m.skin, bot: m.bot ?? false, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hasPos: false });
				this.emit('join', { ...this.others.get(m.id)! });
				break;
			case 'left':
				this.others.delete(m.id);
				this.emit('left', m.id);
				break;
			case 'fx':
				this.emit('fx', m);
				break;
			case 'leaving':
				this.emit('leaving', m);
				break;
		}
	}

	private onSocketState(st: MpState, code: number | undefined, err: ErrorMsg | undefined): void {
		if (st === 'connecting' || st === 'open' || this.state === 'closed') return;
		if (this.pending) {
			// Before the first welcome + snapshot: connect() rejects; no reconnect.
			const p = this.pending;
			this.pending = null;
			this.teardown(false);
			this.state = 'closed';
			p.reject(st === 'fatal' ? refusalError(code, err) : new ServerRefusedError(code ?? 1006, `connection lost before the welcome (${code ?? 'no close code'})`));
			return;
		}
		if (st === 'fatal') {
			this.finish(code ?? 1006);
			return;
		}
		// Lost: reconnect (spec §6), a new Reconnector each time (it is one-shot). The give-up counts from the
		// first loss, not from each retry, so a server that answers GET /worlds but keeps dropping the socket
		// still ends in `close` after GIVE_UP_MS.
		const lostCode = code ?? 1006;
		this.lostSince ??= Date.now();
		if (Date.now() - this.lostSince > GIVE_UP_MS) {
			this.finish(lostCode);
			return;
		}
		this.state = 'reconnecting';
		this.mp = null;
		this.stopPosTimer();
		this.cancelMotion();
		this.cancelMine();
		this.reconnector = new Reconnector({
			probe: () => this.api.listWorlds(),
			onSuccess: () => {
				this.reconnector = null;
				if (this.state === 'reconnecting') this.open(true);
			},
			onGiveUp: () => {
				this.reconnector = null;
				if (this.state === 'reconnecting') this.finish(lostCode);
			},
		});
		this.reconnector.start();
	}

	/** Ends for good: stops everything, closes the socket, emits `close(code)`. */
	private finish(code: number): void {
		if (this.state === 'closed') return;
		this.teardown(true);
		this.state = 'closed';
		if (this.pending) {
			const p = this.pending;
			this.pending = null;
			p.reject(new ServerRefusedError(code, 'closed before the welcome'));
		}
		this.emit('close', code);
	}

	private teardown(stopMine: boolean): void {
		this.stopPosTimer();
		this.reconnector?.stop();
		this.reconnector = null;
		this.cancelMotion();
		if (stopMine) this.cancelMine();
		this.mp?.close(1000);
		this.mp = null;
	}

	private assertConnected(action: string): void {
		if (this.state === 'idle' || this.state === 'connecting' || this.state === 'closed') throw new NotConnectedError(action);
	}

	/** Sends one message; dropped when the socket isn't open. */
	private send(msg: object): boolean {
		return this.mp?.send(msg) ?? false;
	}

	// ── pose and walking ──

	private startPosTimer(): void {
		this.stopPosTimer();
		this.posTimer = setInterval(() => this.tick(), POS_EVERY_MS);
	}

	private stopPosTimer(): void {
		if (this.posTimer !== null) clearInterval(this.posTimer);
		this.posTimer = null;
	}

	private tick(): void {
		if (this.state !== 'connected') return;
		this.tickNo++;
		this.lift = 0;
		const m = this.motion;
		if (m?.kind === 'walk') this.stepWalk(m);
		else if (m?.kind === 'fly') this.stepFly(m);
		if (poseKey(this.shown()) !== this.lastKey) this.sendPose();
	}

	/** The pose the kids see: `cur`, plus this tick's jump lift. */
	private shown(): Pose {
		return { ...this.cur, y: this.cur.y + this.lift };
	}

	private sendPose(): void {
		const p = this.shown();
		if (this.send({ t: 'pos', x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch })) this.lastKey = poseKey(p);
	}

	private stepWalk(w: Walk): void {
		const world = this.core!;
		const cur = this.cur;
		if (w.falling) {
			const g = world.groundY(cur.x, cur.z, cur.y);
			if (g === null) return this.blocked(w, 'noGround');
			// Never up while falling (a block placed under the bot mid-drop must not lift it).
			cur.y = Math.min(cur.y, Math.max(g, cur.y - MAX_DROP));
			w.falling = cur.y > g;
			return;
		}
		const dx = w.tx - cur.x, dz = w.tz - cur.z;
		const d = Math.hypot(dx, dz);
		if (d <= ARRIVE) return this.arrive(w);
		const s = Math.min(d, STEP * w.speed);
		const nx = cur.x + (dx / d) * s, nz = cur.z + (dz / d) * s;
		const ny = world.groundY(nx, nz, cur.y);
		if (ny === null) return this.blocked(w, 'noGround');
		if (ny > cur.y + 1) return this.blocked(w, 'wall');
		if (ny > cur.y) {
			// A step up (spec §12b): one tick shows the jump (+0.6 of the step, in place), the next lands on it.
			// Display-only: `cur` stays on the ground, so pose(), a cancel or a new walkTo start from there, and
			// a walk re-issued every tick still lands on the tick after the jump.
			const a = this.arc;
			this.arc = null;
			const landing = a !== null && a.tick === this.tickNo - 1 && a.x === cur.x && a.y === cur.y && a.z === cur.z;
			if (!landing) {
				cur.yaw = Math.atan2(-dx, -dz);
				this.lift = JUMP_ARC * (ny - cur.y);
				this.arc = { tick: this.tickNo, x: cur.x, y: cur.y, z: cur.z };
				return;
			}
		}
		// A drop: the body must fit into the next column at its current height, or it would walk through a
		// wall standing over a cave (groundY scans down past solid blocks).
		const fy = Math.floor(cur.y);
		if (ny < fy && (world.isSolid(world.getBlock(nx, fy, nz)) || world.isSolid(world.getBlock(nx, fy + 1, nz)))) return this.blocked(w, 'wall');
		cur.yaw = Math.atan2(-dx, -dz);
		cur.x = nx;
		cur.z = nz;
		cur.y = Math.max(ny, cur.y - MAX_DROP);
		w.falling = cur.y > ny;
		if (!w.falling && Math.hypot(w.tx - nx, w.tz - nz) <= ARRIVE) this.arrive(w);
	}

	private stepFly(f: Flight): void {
		const cur = this.cur;
		if (++f.ticks > f.maxTicks) return this.blocked(f, 'wall');
		const dx = f.tx - cur.x, dy = f.ty - cur.y, dz = f.tz - cur.z;
		const d = Math.hypot(dx, dy, dz), h = Math.hypot(dx, dz);
		if (d <= 1e-9) return this.arrive(f);
		this.face(f.tx, f.ty + EYE_HEIGHT, f.tz);
		const hs = Math.min(h, FLY_STEP);
		const hx = h > 1e-9 ? cur.x + (dx / h) * hs : cur.x, hz = h > 1e-9 ? cur.z + (dz / h) * hs : cur.z;
		const hClear = h > 1e-9 && this.bodyClear(hx, cur.y, hz);
		// No bobbing: after a climb, it doesn't dive back down before it has moved across at the climbed height.
		const hold = f.climbed && dy < 0 && h > 1e-9;
		// 1. Straight toward the target.
		const s = Math.min(d, FLY_STEP);
		if (!hold && s === d && this.bodyClear(f.tx, f.ty, f.tz)) {
			Object.assign(cur, { x: f.tx, y: f.ty, z: f.tz });
			return this.arrive(f);
		}
		const nx = cur.x + (dx / d) * s, ny = cur.y + (dy / d) * s, nz = cur.z + (dz / d) * s;
		if (!hold && s < d && this.bodyClear(nx, ny, nz)) return void Object.assign(cur, { x: nx, y: ny, z: nz });
		// 2. Horizontally, at the same height.
		if (hClear) {
			f.climbed = false;
			return void Object.assign(cur, { x: hx, z: hz });
		}
		// 3. Straight down toward the target's height when the way across is open at that height (under an
		// overhang open at the side), unless it just climbed.
		if (dy < 0 && h > 1e-9 && !f.climbed) {
			const vy = cur.y - Math.min(-dy, FLY_STEP);
			if (this.bodyClear(cur.x, vy, cur.z) && this.bodyClear(hx, f.ty, hz)) return void (cur.y = vy);
		}
		// Straight above or below the target and blocked: climbing can't help. That is any blocked target
		// straight up or down: sealed under a roof, under an overhang open at the side, or inside solid blocks.
		if (h <= 1e-9) return this.blocked(f, 'wall');
		// 4. The body already clips a block (walkTo checks only the centre column): to the column's centre first.
		const cx = Math.floor(cur.x) + 0.5, cz = Math.floor(cur.z) + 0.5;
		if (!this.bodyClear(cur.x, cur.y, cur.z) && (cx !== cur.x || cz !== cur.z) && this.bodyClear(cx, cur.y, cz)) {
			return void Object.assign(cur, { x: cx, z: cz });
		}
		// 5. Straight up, within the climb cap and the world, and only into a clear body box.
		const uy = cur.y + FLY_STEP;
		if (uy > f.startY + FLY_CLIMB_MAX + 1e-9 || uy + BODY_HEIGHT > this.core!.height || !this.bodyClear(cur.x, uy, cur.z)) return this.blocked(f, 'wall');
		cur.y = uy;
		f.climbed = true;
	}

	/** True when the body box at feet (x, y, z) overlaps no solid block (touching a face is allowed). */
	private bodyClear(x: number, y: number, z: number): boolean {
		const w = this.core!;
		const e = 1e-6;
		for (let bx = Math.floor(x - BODY_HALF + e); bx <= Math.floor(x + BODY_HALF - e); bx++)
			for (let by = Math.floor(y + e); by <= Math.floor(y + BODY_HEIGHT - e); by++)
				for (let bz = Math.floor(z - BODY_HALF + e); bz <= Math.floor(z + BODY_HALF - e); bz++) if (isSolid(w.getBlock(bx, by, bz))) return false;
		return true;
	}

	private arrive(m: Motion): void {
		if (this.motion === m) this.motion = null;
		m.resolve('arrived');
	}

	private blocked(m: Motion, reason: 'wall' | 'noGround'): void {
		if (this.motion === m) this.motion = null;
		m.reject(new BlockedError({ ...this.cur }, reason, m.kind === 'fly' ? 'flyTo' : 'walkTo'));
	}

	private cancelMotion(): void {
		const m = this.motion;
		if (!m) return;
		this.motion = null;
		m.resolve('cancelled');
	}

	private face(x: number, y: number, z: number): void {
		const dx = x - this.cur.x, dy = y - (this.cur.y + EYE_HEIGHT), dz = z - this.cur.z;
		const h = Math.hypot(dx, dz);
		if (h > 1e-9) this.cur.yaw = Math.atan2(-dx, -dz);
		if (h > 1e-9 || dy !== 0) this.cur.pitch = clampPitch(Math.atan2(dy, h));
	}

	// ── edits ──

	private cancelMine(): void {
		const m = this.mining;
		if (!m) return;
		this.mining = null;
		clearTimeout(m.timer);
		this.send({ t: 'fx', kind: 'mine-stop', x: m.x, y: m.y, z: m.z });
		m.resolve(false);
	}

	/** Runs `fn` after the previous edit and the edit gap; false when disconnected by then. */
	private edit(fn: () => boolean): Promise<boolean> {
		const run = async (): Promise<boolean> => {
			if (this.state !== 'connected') return false;
			const wait = this.lastEditAt + this.gap - Date.now();
			if (wait > 0) await new Promise((r) => setTimeout(r, wait));
			if (this.state !== 'connected') return false;
			return fn();
		};
		const p = this.chain.then(run, run);
		this.chain = p.catch(() => false);
		return p;
	}

	private placeable(id: number, name: string): boolean {
		if (id < 1 || id > this.catalogMax || id === BEDROCK_ID) return false;
		if (name.startsWith('retired_') || BLOCKS[id]?.retired) return false;
		return isSolid(id) || isLiquid(id);
	}

	/** True when the cell overlaps a kid's body box (x ± 0.3, z ± 0.3, feet to feet + 1.8). Bots and pose-less players don't count. */
	private insideKid(x: number, y: number, z: number): boolean {
		for (const p of this.others.values()) {
			if (p.bot || !p.hasPos) continue;
			if (x < Math.floor(p.x - 0.3) || x > Math.floor(p.x + 0.3)) continue;
			if (z < Math.floor(p.z - 0.3) || z > Math.floor(p.z + 0.3)) continue;
			if (y < Math.floor(p.y) || y > Math.floor(p.y + 1.8)) continue;
			return true;
		}
		return false;
	}

	/** The bot's journaled write: applies locally, sends one edit, records it. */
	private write(x: number, y: number, z: number, id: number, color?: string): boolean {
		const w = this.core!;
		const oldId = w.getBlock(x, y, z);
		const oldColor = w.colorAt(x, y, z);
		w.localSet(x, y, z, id, color);
		this.lastEditAt = Date.now();
		this.entries.push({ x, y, z, oldId, newId: id, t: this.lastEditAt, ...(oldColor ? { oldColor } : {}) });
		if (this.entries.length > JOURNAL_MAX) this.entries.splice(0, this.entries.length - JOURNAL_MAX);
		this.persist();
		return true;
	}

	private persist(): void {
		const path = this.opts.statePath;
		if (!path) return;
		try {
			writeFileSync(path + '.tmp', JSON.stringify({ bid: this.bid, world: this.journalWorld, journal: this.entries }));
			renameSync(path + '.tmp', path);
		} catch (err) {
			console.error(`minicraft-bot: could not save ${path}`, err);
		}
	}

	private emit<K extends keyof BotEvents>(event: K, ...args: Parameters<BotEvents[K]>): void {
		const set = this.listeners.get(event);
		if (!set) return;
		for (const cb of [...set] as Array<(...a: Parameters<BotEvents[K]>) => void>) {
			try {
				cb(...args);
			} catch (err) {
				console.error(`minicraft-bot: a '${event}' listener threw`, err);
			}
		}
	}
}
