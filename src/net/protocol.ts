/**
 * Multiplayer wire protocol (spec §5). The message types mirror the Go structs in
 * `server/internal/proto/proto.go` field for field; `src/net/protocol.test.ts` checks them
 * against the Go golden files `server/internal/proto/testdata/msg-*.json`.
 */
import type { PlayerSave } from '../persistence/adapter';

/** Protocol version sent in `hello`. The server accepts [1, 1]. */
export const PROTO = 1;

/** Ops per `edit` message. */
export const MAX_OPS_PER_EDIT = 2000;

/** WebSocket close and `error` codes (spec §5). */
export const CLOSE = {
	/** A newer connection from this browser took over. No reconnect. */
	replaced: 4001,
	/** The server's send queue filled up. Reconnect. */
	slow: 4002,
	/** The server rejected a batch. Reconnect; two in a row → the `proto` screen. */
	resync: 4003,
	/** Proto version out of range. */
	proto: 4004,
	/** Generator version not supported. */
	genUnsupported: 4005,
	/** The world doesn't exist. */
	unknownWorld: 4006,
	/** Wrong token. */
	badToken: 4007,
	/** The name failed the name rule. */
	badName: 4008,
	/** The name is online from another browser. */
	nameTaken: 4009,
} as const;

export type CloseCode = (typeof CLOSE)[keyof typeof CLOSE];

/**
 * One cell write: x, y, z, id, fluid, color.
 * - `fluid` is the raw `Chunk.fluidMeta`: 0 = none or source, `0x80 | d` = flow at distance d.
 * - `color` is packed by {@link colorToInt}: 0 = no colour.
 */
export type Op = [x: number, y: number, z: number, id: number, fluid: number, color: number];

/** The per-player state the server stores opaquely: `{inventory, tools, hotbar, selected}`. */
export type ExtrasData = Partial<Pick<PlayerSave, 'inventory' | 'tools' | 'hotbar' | 'selected'>>;

export type FxKind = 'prime' | 'boom' | 'firework';
export type SpawnMode = 'first' | 'return' | 'near';

// ── client → server ──

export type Hello = {
	t: 'hello';
	world: string;
	name: string;
	skin: string;
	bid: string;
	proto: number;
	gen: number;
	resume: boolean;
};

export type Pos = { t: 'pos'; x: number; y: number; z: number; yaw: number; pitch: number };

/** Sent both ways (spec §3.1). */
export type Ping = { t: 'ping' };

/** A client batch (≤ 2,000 ops; `cid` increases per connection). */
export type EditMsg = { t: 'edit'; cid: number; ops: Op[] };

/**
 * Cosmetic. `by` is set by the server when it relays. `tier` is the block id of the explosive for
 * `prime` (the receiver reads its fuse) and `boom` (its break particles); the server relays it as
 * an opaque int. Absent or unknown falls back to plain TNT.
 */
export type FxMsg = { t: 'fx'; kind: FxKind; x: number; y: number; z: number; tier?: number; by?: number };

export type ExtrasMsg = { t: 'extras'; data: ExtrasData };

/** The sender's play-time countdown (spec §7.4). `by` is set by the server when it relays. */
export type LeavingMsg = { t: 'leaving'; secondsLeft: number; by?: number };

// ── server → client ──

export type WorldInfo = {
	uuid: string;
	name: string;
	seed: number;
	gen: number;
	height: number;
	mustMine: boolean;
};

/** `target` is the player id for `near`. */
export type Spawn = {
	mode: SpawnMode;
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch: number;
	target?: number;
};

export type PlayerInfo = {
	id: number;
	name: string;
	skin: string;
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch: number;
};

/** Followed by one binary snapshot frame as of `seq` (see `snapshot.ts`). */
export type Welcome = {
	t: 'welcome';
	you: number;
	world: WorldInfo;
	spawn: Spawn;
	extras: ExtrasData;
	players: PlayerInfo[];
	seq: number;
	catalogMax: number;
};

/** A server-ordered edit, sent to everyone, author included. */
export type EditOut = { t: 'edit'; seq: number; by: number; cid?: number; ops: Op[] };

/** One pose: [id, x, y, z, yaw, pitch]. */
export type Pose = [id: number, x: number, y: number, z: number, yaw: number, pitch: number];

/** Every 100 ms; excludes the recipient's own pose. */
export type Tick = { t: 'tick'; poses: Pose[] };

export type Join = { t: 'join'; id: number; name: string; skin: string };
export type Left = { t: 'left'; id: number };

/** Followed by a close with the same code. */
export type ErrorMsg = { t: 'error'; code: number; message: string };

export type ClientMsg = Hello | Pos | Ping | EditMsg | FxMsg | ExtrasMsg | LeavingMsg;
export type ServerMsg = Welcome | EditOut | Tick | Join | Left | FxMsg | LeavingMsg | Ping | ErrorMsg;

// ── HTTP ──

export type OnlinePlayer = { name: string; skin: string };

/** One row of `GET /worlds`. */
export type WorldListing = {
	uuid: string;
	name: string;
	mustMine: boolean;
	createdAt: number;
	online: OnlinePlayer[];
};

// ── packing ──

const COLOR_FLAG = 0x1000000;
const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** `#RRGGBB` → `0x1000000 | rgb`, so black is `0x1000000` and 0 stays "no colour". */
export function colorToInt(hex: string): number {
	if (!HEX6.test(hex)) throw new Error(`colorToInt: not a #RRGGBB colour: ${JSON.stringify(hex)}`);
	return COLOR_FLAG | parseInt(hex.slice(1), 16);
}

/** The inverse of {@link colorToInt}: `#RRGGBB` uppercase, or null for 0 (no colour). */
export function intToColor(n: number): string | null {
	if (n === 0) return null;
	return '#' + (n & 0xffffff).toString(16).toUpperCase().padStart(6, '0');
}
