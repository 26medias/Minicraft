/**
 * Shared, plain-data shapes for the companion's decision pipeline (spec §5, §6, §12a, §12b). Every
 * field here is JSON-serialisable — no functions, no `Date`s, no class instances — because a
 * `Snapshot` is written verbatim into the JSONL decision log (spec §6 step 5) and replayed later.
 *
 * `Snapshot` is built by `perceive.ts` (Task 3) and consumed by `candidates.ts` (Task 3) and the
 * scripted brain (`brain/scripted.ts`, this task). This file only defines the shapes; nothing here
 * reads the world.
 */

/** A player pose: position plus facing. Mirrors the SDK's `Pose` (x, y, z, yaw, pitch). */
export interface Pose {
	x: number;
	y: number;
	z: number;
	yaw: number;
	pitch: number;
}

/** A bare position. Mirrors the SDK's `Vec3`. */
export interface Vec3 {
	x: number;
	y: number;
	z: number;
}

/**
 * The companion's five possible actions (spec §12a amendment: `help_mine` and `face` are dropped;
 * `follow` covers walking, flying and landing — those are follow *modes*, a Task 4 loop concern,
 * not separate candidates; a last-resort hop is part of the `follow` standing intent too).
 */
export type Candidate = 'follow' | 'watch' | 'help_build' | 'wander' | 'idle';

/**
 * A horizontal speed (blocks/s) at or above which a kid counts as "moving" for the purposes of the
 * scripted brain's follow rule (spec §6) and text rendering ("Noah is ... walking"). It matches the
 * complementary condition in the lead clamp (§12b): follow's lead stops shrinking once the kid's
 * speed over the last 0.3 s drops *below* this value, so a kid at or above it is still "moving".
 */
export const MOVING_SPEED_THRESHOLD = 0.5;

/**
 * A horizontal speed (blocks/s) below which a kid counts as idle, for target rotation (spec §12b):
 * "his horizontal speed has been < 0.3 b/s ... for idleSwitchMs".
 */
export const IDLE_SPEED_THRESHOLD = 0.3;

/**
 * One of a kid's own placements (spec §6): a single-op, solid, non-liquid block set by that kid.
 * `ageMs` is this placement's age at snapshot time (`nowMs − placedAtMs`), kept instead of an
 * absolute timestamp so a `Snapshot` stays meaningful on its own inside the decision log — no need
 * to cross-reference `nowMs` from a different line to know "how long ago".
 */
export interface Placement {
	cell: Vec3;
	/** The block's name, exactly as `Body.place(x, y, z, name)` (Task 3) takes it. */
	block: string;
	ageMs: number;
}

/**
 * Everything the companion knows about one non-bot kid at snapshot time — the target or another kid
 * (spec §6, §12a, §12b). `id` is the player id at this moment; it can change across a reconnect,
 * which is exactly why the target is kept sticky by `name` instead (perceive.ts, Task 3).
 */
export interface KidInfo {
	name: string;
	id: number;
	pose: Pose;
	/** Blocks/s, from pose samples over the last 1 s (spec §6 "Kid motion"). */
	velocity: Vec3;
	/** Horizontal speed (blocks/s) over the last 0.3 s — the lead clamp's window (§12b). */
	speedLast0_3s: number;
	/** Horizontal speed (blocks/s) over the last 1 s (§6). */
	speedLast1s: number;
	/** §12a: not in liquid, feet more than 1.5 above `groundY` on every column of his box, for
	 *  longer than 0.5 s. */
	flying: boolean;
	/** The block at his feet, or at feet + 1, is a liquid (§12a's flying exclusion; also relevant to
	 *  hop/land safety, Task 4). */
	inLiquid: boolean;
	/** A raycast hit from the kid's eye, max 6 blocks (§6). `null` when nothing is hit within range. */
	lookTarget: Vec3 | null;
	/** This kid's own last placements, most recent last (§6 keeps 5; §12a's `help_build` rule only
	 *  ever needs the last 3). */
	placements: Placement[];
	/** `nowMs` at the moment this kid's horizontal speed dropped below `IDLE_SPEED_THRESHOLD` *and*
	 *  he stopped placing/breaking; `null` while he's moving or building (§12b target rotation). */
	idleSinceMs: number | null;
}

/**
 * The companion's view of the world at one tick (spec §6 step 5, §12a, §12b): everything the
 * scripted brain, the candidate/guard logic (Task 3) and the loop (Task 4) need, and nothing that
 * isn't plain data — it is logged verbatim.
 */
export interface Snapshot {
	nowMs: number;
	/** `config.companion.followDist` at snapshot time, carried here so the pure decision functions
	 *  (scripted.ts, candidates.ts) don't need a separate config parameter threaded through them. */
	followDist: number;
	bot: {
		pose: Pose;
		/** The bot's most recent actions, oldest first, capped at 3 (spec §6 "the bot's last 3
		 *  actions"). */
		lastActions: Candidate[];
	};
	/** The sticky target kid, kept by name across reconnects (§6); `null` with no kid online. */
	target: KidInfo | null;
	/** Every other non-bot kid with a pose (§12b target rotation needs to see them to switch). */
	others: KidInfo[];
	/** Whether a stop signal (spec §6 "Stop signal") is currently active for the target kid. There's
	 *  no radius (§12a): it's per kid, by name, wherever he goes. */
	stopActiveForTarget: boolean;
}
