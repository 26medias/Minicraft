/**
 * BotWorld (spec §6, §12a): the bot's live world model, the same `World` + `ChunkOverlay` pair the game
 * uses, fed by the same code paths (snapshot, `MpSync`'s echo rule, `applyRemoteOps`).
 * - Chunks are generated on first read (≈ 29 ms and ≈ 0.35 MB each; synchronous).
 * - The bot runs no liquid scheduler and no TNT: the kids' clients simulate liquids.
 * - Every public coordinate API floors x, y, z.
 */
import { World } from '../../../src/engine/world/world';
import { ChunkOverlay } from '../../../src/engine/world/overlay';
import { applyRemoteOps } from '../../../src/engine/world/apply-remote';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z, type WorldHeight } from '../../../src/engine/world/coords';
import { AIR, BLOCKS, BLOCK_BY_NAME, isLiquid as isLiquidId, isSolid as isSolidId } from '../../../src/data/blocks.data';
import { MpSync, type StorageLike } from '../../../src/net/mp-sync';
import { decodeSnapshot } from '../../../src/net/snapshot';
import { colorToInt, intToColor, type EditOut, type Op, type Welcome } from '../../../src/net/protocol';
import { raycastVoxel as gameRaycast, type VoxelHit } from '../../../src/engine/input/raycast';
import { spawnV3 } from '../../../src/engine/world/v3/spawn';
import type { Spawn } from '../../../src/net/protocol';

/**
 * A pose. `y` is the FEET (the eye is `y + EYE_HEIGHT`). `yaw` in radians, forward = (−sin yaw, 0, −cos yaw),
 * so facing a target takes `yaw = atan2(−dx, −dz)`. `pitch` in radians, positive looks up, within ±π/2.
 */
export type Pose = { x: number; y: number; z: number; yaw: number; pitch: number };

/** A cell or point in world coordinates. */
export type Vec3 = { x: number; y: number; z: number };

/**
 * `oldId` is null when the chunk wasn't generated yet (the change is kept for when it is). `by` is the
 * author's player id: the bot's own `you` for its own writes.
 */
export type BlockChangeListener = (x: number, y: number, z: number, oldId: number | null, newId: number, by: number) => void;

const LAMP_ID = BLOCK_BY_NAME['lamp'].id;
/** `region` and `findNearest` bound: 32 per side (at most 25 chunks, ≈ 0.25 s of generation). */
const MAX_SIDE = 32;

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

/** A catalog block's name, or null for an unknown id. Retired ids are named `retired_<id>`. */
export function blockName(id: number): string | null {
	return BLOCKS[id]?.name ?? null;
}

/** A catalog block's id, or null for an unknown (or retired) name. */
export function blockId(name: string): number | null {
	return BLOCK_BY_NAME[name]?.id ?? null;
}

/** Every catalog block name, except retired ids. */
export function blockNames(): string[] {
	return BLOCKS.filter((b) => !b.retired).map((b) => b.name);
}

export class BotWorld {
	private world!: World;
	private overlay!: ChunkOverlay;
	private sync!: MpSync;
	private you = 0;
	/** Lamp colours (x,y,z → #RRGGBB) of cells the bot knows about; read when an edit is sent. */
	private colors = new Map<string, string>();
	private listeners = new Set<BlockChangeListener>();
	/** The author of the edit being applied (the echo filter's apply callback only carries ops). */
	private applyingBy = 0;
	private readonly storage = new MemStorage();

	private constructor(private readonly send: (msg: object) => void) {}

	/**
	 * Builds the world from a `welcome` and the snapshot frame that follows it. `send` sends one client
	 * message (the bot client's socket). Called by `BotClient`; bots get the world from `connect()`.
	 */
	static create(welcome: Welcome, snapshot: ArrayBuffer, send: (msg: object) => void, you: number): BotWorld {
		const w = new BotWorld(send);
		w.reset(welcome, snapshot, you);
		return w;
	}

	/**
	 * Replaces the world in place (a reconnect): a fresh world model with the snapshot loaded before it is
	 * used, a fresh edit sender (edit ids restart per connection), then one reference swap. Pending writes
	 * are dropped. Listeners stay subscribed. Throws (changing nothing) on a malformed snapshot.
	 */
	reset(welcome: Welcome, snapshot: ArrayBuffer, you: number): void {
		const cells = decodeSnapshot(snapshot).cells;
		const info = welcome.world;
		const world = new World(info.seed, { height: info.height as WorldHeight, genVersion: info.gen, saveVersion: 3 });
		const overlay = new ChunkOverlay();
		overlay.loadSnapshot(cells);
		world.overlay = overlay;
		world.modifiedPins = false;
		const colors = new Map<string, string>();
		for (let k = 0; k + 5 < cells.length; k += 6) {
			const hex = intToColor(cells[k + 5]);
			if (hex && cells[k + 3] === LAMP_ID) colors.set(`${cells[k]},${cells[k + 1]},${cells[k + 2]}`, hex);
		}
		const lights = { getColor: (x: number, y: number, z: number) => this.colors.get(`${x},${y},${z}`) ?? null };
		const sync = new MpSync(world, lights, this.send, () => ({}), this.storage, (ops) => this.applyRemote(ops));
		world.onLocalWrite = sync.record;
		this.world = world;
		this.overlay = overlay;
		this.sync = sync;
		this.colors = colors;
		this.you = you;
	}

	get seed(): number {
		return this.world.seed;
	}

	/** The world generator version. */
	get gen(): number {
		return this.world.genVersion;
	}

	/** The world height in blocks (y runs 0 … height − 1). */
	get height(): number {
		return this.world.height;
	}

	/** True when the (floored) cell is inside the world. */
	inBounds(x: number, y: number, z: number): boolean {
		return this.world.inBounds(Math.floor(x), Math.floor(y), Math.floor(z));
	}

	/** The block id at a cell; the chunk is generated on first read. Out of the world: AIR (0). */
	getBlock(x: number, y: number, z: number): number {
		return this.world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
	}

	blockName(id: number): string | null {
		return blockName(id);
	}

	blockId(name: string): number | null {
		return blockId(name);
	}

	/** Solid: a full cube you can stand on (leaves and glass included). */
	isSolid(id: number): boolean {
		return isSolidId(id);
	}

	isLiquid(id: number): boolean {
		return isLiquidId(id);
	}

	/**
	 * The feet y of the first standable cell at or below `nearY + 2` in column (x, z): solid below, and two
	 * non-solid cells (air or liquid) for the body. Scans at most 64 down; null when there is none. It does
	 * not land on a leaf canopy or a roof above `nearY + 2`; in water it finds the bed.
	 */
	groundY(x: number, z: number, nearY: number): number | null {
		const fx = Math.floor(x), fz = Math.floor(z);
		const top = Math.min(this.height - 3, Math.floor(nearY) + 2);
		for (let y = top; y >= Math.max(1, top - 64); y--) {
			if (isSolidId(this.getBlock(fx, y - 1, fz)) && !isSolidId(this.getBlock(fx, y, fz)) && !isSolidId(this.getBlock(fx, y + 1, fz))) return y;
		}
		return null;
	}

	/** The y of the topmost non-air, non-liquid block in column (x, z), or −1. */
	surfaceY(x: number, z: number): number {
		const fx = Math.floor(x), fz = Math.floor(z);
		for (let y = this.height - 1; y >= 0; y--) {
			const id = this.getBlock(fx, y, fz);
			if (id !== AIR && !isLiquidId(id)) return y;
		}
		return -1;
	}

	/**
	 * The ids of a box, bounds inclusive (floored), at most 32 per side (throws beyond). Index:
	 * `(y − y0)·dx·dz + (z − z0)·dx + (x − x0)`. Generates what it needs.
	 */
	region(min: Vec3, max: Vec3): Uint16Array {
		const x0 = Math.floor(Math.min(min.x, max.x)), x1 = Math.floor(Math.max(min.x, max.x));
		const y0 = Math.floor(Math.min(min.y, max.y)), y1 = Math.floor(Math.max(min.y, max.y));
		const z0 = Math.floor(Math.min(min.z, max.z)), z1 = Math.floor(Math.max(min.z, max.z));
		const dx = x1 - x0 + 1, dy = y1 - y0 + 1, dz = z1 - z0 + 1;
		if (dx > MAX_SIDE || dy > MAX_SIDE || dz > MAX_SIDE) {
			throw new RangeError(`region: at most ${MAX_SIDE} blocks per side, got ${dx} × ${dy} × ${dz}`);
		}
		const out = new Uint16Array(dx * dy * dz);
		for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
			out[(y - y0) * dx * dz + (z - z0) * dx + (x - x0)] = this.world.getBlock(x, y, z);
		}
		return out;
	}

	/**
	 * The nearest cell holding block `name` within `radius` (clamped to 32) of `from`, by Euclidean
	 * distance, ties broken by (y, z, x) order; null when none (or an unknown name). Generates every chunk
	 * in range first (≤ 25 chunks, ≈ 0.25 s the first time), so the answer never depends on what was
	 * read before.
	 */
	findNearest(name: string, from: Vec3, radius: number): Vec3 | null {
		const id = blockId(name);
		if (id === null) return null;
		const r = Math.max(0, Math.min(MAX_SIDE, Math.floor(radius)));
		const fx = Math.floor(from.x), fy = Math.floor(from.y), fz = Math.floor(from.z);
		const cx0 = Math.floor((fx - r) / CHUNK_SIZE_X), cx1 = Math.floor((fx + r) / CHUNK_SIZE_X);
		const cz0 = Math.floor((fz - r) / CHUNK_SIZE_Z), cz1 = Math.floor((fz + r) / CHUNK_SIZE_Z);
		for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) {
			if (this.world.chunkInWorld(cx, cz)) this.world.ensureChunk(cx, cz);
		}
		let best: Vec3 | null = null;
		let bestD = Infinity;
		const yLo = Math.max(0, fy - r), yHi = Math.min(this.height - 1, fy + r);
		for (let y = yLo; y <= yHi; y++) for (let z = fz - r; z <= fz + r; z++) for (let x = fx - r; x <= fx + r; x++) {
			const d = (x - fx) ** 2 + (y - fy) ** 2 + (z - fz) ** 2;
			if (d > r * r || d >= bestD) continue;
			if (this.world.getBlock(x, y, z) !== id) continue;
			bestD = d;
			best = { x, y, z };
		}
		return best;
	}

	/** Subscribes to block changes (remote ops that changed the world, and the bot's own writes). Returns the unsubscribe. */
	onBlockChange(cb: BlockChangeListener): () => void {
		this.listeners.add(cb);
		return () => {
			this.listeners.delete(cb);
		};
	}

	/**
	 * The low-level write: sets the cell, sends one `edit` now, and fires onBlockChange with `by = you`.
	 * No refusals, no edit gap, no journal: bots should use `BotClient.place` / `break`. `color` (`#RRGGBB`)
	 * is used, and validated (throws), only for a lamp.
	 */
	localSet(x: number, y: number, z: number, id: number, color?: string): void {
		const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
		const key = `${fx},${fy},${fz}`;
		if (id === LAMP_ID && color !== undefined) {
			colorToInt(color);
			this.colors.set(key, color);
		} else {
			this.colors.delete(key);
		}
		if (!this.world.inBounds(fx, fy, fz)) return;
		const oldId = this.world.getBlock(fx, fy, fz);
		this.world.setBlock(fx, fy, fz, id);
		this.sync.flushFrame();
		this.emit(fx, fy, fz, oldId, id, this.you);
	}

	/** Routes a server `edit` through the echo rule (spec §6), then applies what it keeps. Called by `BotClient`. */
	onServerEdit(msg: EditOut): void {
		this.applyingBy = msg.by;
		this.sync.onEdit(msg, this.you);
	}

	/** Casts a ray through this world (the game's raycast): the first solid cell within `maxDistance`, or null. */
	raycast(origin: [number, number, number], dir: [number, number, number], maxDistance: number): VoxelHit | null {
		return gameRaycast(this.world, origin, dir, maxDistance);
	}

	private applyRemote(ops: Op[]): void {
		const by = this.applyingBy;
		applyRemoteOps(this.world, this.overlay, ops, (op, r) => {
			const [x, y, z, id, , color] = op;
			if (!this.world.inBounds(x, y, z)) return;
			const hex = intToColor(color);
			if (hex && id === LAMP_ID) this.colors.set(`${x},${y},${z}`, hex);
			else this.colors.delete(`${x},${y},${z}`);
			// Applied to a loaded chunk, or kept by the overlay for a chunk not generated yet (oldId null).
			if (r.applied || r.oldId === null) this.emit(x, y, z, r.oldId, id, by);
		});
	}

	private emit(x: number, y: number, z: number, oldId: number | null, newId: number, by: number): void {
		for (const cb of [...this.listeners]) {
			try {
				cb(x, y, z, oldId, newId, by);
			} catch (err) {
				console.error('minicraft-bot: onBlockChange listener threw', err);
			}
		}
	}
}

/** The game's voxel raycast over a BotWorld: the first solid cell along `dir` within `maxDistance`, or null. */
export function raycastVoxel(world: BotWorld, origin: [number, number, number], dir: [number, number, number], maxDistance: number): VoxelHit | null {
	return world.raycast(origin, dir, maxDistance);
}

/** src/game/mp-spawn.ts's "near" fan: straight ahead of the target first, then ±30°, ±60°, 3–6 blocks away. */
const NEAR_ANGLES = [0, 30, -30, 60, -60].map((d) => (d * Math.PI) / 180);

/**
 * Where the bot stands after a welcome (spec §7.2: the server picks only the mode, the client the spot).
 * Mirrors the game's `resolveMpSpawn` (src/game/mp-spawn.ts), which the SDK can't bundle: its module
 * pulls in `three` through player.ts.
 * - `first`: the world's v3 spawn column, on its topmost block, facing yaw 0.
 * - `return`: the saved spot, grounded (the first standable cell at or below it), with the saved yaw/pitch.
 * - `near`: 3–6 blocks in front of the target player on dry ground, facing them; else the target's spot.
 */
export function resolveSpawn(world: BotWorld, spawn: Spawn): Pose {
	if (spawn.mode === 'first') {
		const s = world.gen === 3 ? spawnV3(world.seed) : { x: 256, z: 256 };
		const x = s.x + 0.5, z = s.z + 0.5;
		const top = world.surfaceY(x, z);
		return { x, y: top >= 0 ? top + 1 : world.height - 1, z, yaw: 0, pitch: 0 };
	}
	if (spawn.mode === 'return') {
		const g = world.groundY(spawn.x, spawn.z, spawn.y);
		const top = world.surfaceY(spawn.x, spawn.z);
		const y = g ?? (top >= 0 ? top + 1 : spawn.y);
		return { x: spawn.x, y, z: spawn.z, yaw: spawn.yaw, pitch: spawn.pitch };
	}
	const feetY = Math.floor(spawn.y);
	for (const a of NEAR_ANGLES) {
		const dirX = -Math.sin(spawn.yaw + a), dirZ = -Math.cos(spawn.yaw + a);
		for (let d = 3; d <= 6; d++) {
			const bx = Math.floor(spawn.x + dirX * d), bz = Math.floor(spawn.z + dirZ * d);
			const cx = bx + 0.5, cz = bz + 0.5;
			const dist = Math.hypot(cx - spawn.x, cz - spawn.z);
			if (dist < 3 || dist > 6 || !world.inBounds(bx, 0, bz)) continue;
			// The game's groundAt: a dry solid block within ±4 of the target's feet, two air cells above.
			const g = world.groundY(cx, cz, feetY + 3);
			if (g === null || g < feetY - 3 || world.getBlock(bx, g, bz) !== AIR || world.getBlock(bx, g + 1, bz) !== AIR || world.isLiquid(world.getBlock(bx, g - 1, bz))) continue;
			return { x: cx, y: g, z: cz, yaw: Math.atan2(-(spawn.x - cx), -(spawn.z - cz)), pitch: 0 };
		}
	}
	return { x: spawn.x, y: spawn.y, z: spawn.z, yaw: spawn.yaw, pitch: 0 };
}
