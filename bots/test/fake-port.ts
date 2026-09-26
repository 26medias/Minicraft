/**
 * A fake port for unit tests (spec §6, §12a): an in-memory `WorldView` over the real generator
 * (`generateChunkBlocks(12345, 3, cx, cz)`) plus an edit overlay, and a scripted `Body`.
 *
 * - Solidity uses the SDK's own `isSolidId`/`isLiquidId`, so the catalog's rules can't drift.
 * - `groundY` is the SDK README's rule; `raycast` is the same DDA as the game's, max as given.
 * - Parity with the real SDK is proven in the e2e (Task 7), where a real connected world exists.
 */
import { blockId, blockName, isLiquidId, isSolidId } from 'minicraft-bot';
import type { BotPlayer, FxMsg, JournalEntry, PoseInput, VoxelHit, WalkResult } from 'minicraft-bot';
import { generatedLookup } from '../src/port.js';
import type { Body, Tuple3, WorldView } from '../src/port.js';
import type { EditEvent, Pose, Vec3 } from '../src/types.js';

export const FAKE_SEED = 12345;
export const FAKE_GEN = 3;
/** The world is 512 × 512 (0 … 511) and 256 high. */
const WORLD_SIZE = 512;
const WORLD_HEIGHT = 256;

export const AIR = 0;

/** A block id by name; throws on an unknown name so a typo can't silently become air. */
export function id(name: string): number {
	const v = blockId(name);
	if (v === null) throw new Error(`unknown block ${name}`);
	return v;
}

export class FakeWorld implements WorldView {
	mustMine = false;
	private readonly generated = generatedLookup(FAKE_SEED, FAKE_GEN);
	private readonly overlay = new Map<string, number>();

	private inWorld(x: number, y: number, z: number): boolean {
		return x >= 0 && x < WORLD_SIZE && z >= 0 && z < WORLD_SIZE && y >= 0 && y < WORLD_HEIGHT;
	}

	getBlock(x: number, y: number, z: number): number {
		const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
		if (!this.inWorld(fx, fy, fz)) return AIR;
		return this.overlay.get(`${fx},${fy},${fz}`) ?? this.generated(fx, fy, fz);
	}

	/** Test-only: writes a cell into the overlay. */
	set(x: number, y: number, z: number, blockIdOrName: number | string): void {
		const v = typeof blockIdOrName === 'string' ? id(blockIdOrName) : blockIdOrName;
		this.overlay.set(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`, v);
	}

	/** Test-only: fills an inclusive box. */
	fill(min: Vec3, max: Vec3, blockIdOrName: number | string): void {
		for (let x = min.x; x <= max.x; x++) for (let y = min.y; y <= max.y; y++) for (let z = min.z; z <= max.z; z++) this.set(x, y, z, blockIdOrName);
	}

	blockName(v: number): string | null {
		return blockName(v);
	}

	isSolid(v: number): boolean {
		return isSolidId(v);
	}

	isLiquid(v: number): boolean {
		return isLiquidId(v);
	}

	/** The SDK README's rule: the feet y of the first standable cell at or below `nearY + 2` (solid
	 *  below, two non-solid cells), scanning at most 64 down, else `null`. */
	groundY(x: number, z: number, nearY: number): number | null {
		const fx = Math.floor(x), fz = Math.floor(z);
		const top = Math.min(WORLD_HEIGHT - 3, Math.floor(nearY) + 2);
		for (let y = top; y >= Math.max(1, top - 64); y--) {
			if (isSolidId(this.getBlock(fx, y - 1, fz)) && !isSolidId(this.getBlock(fx, y, fz)) && !isSolidId(this.getBlock(fx, y + 1, fz))) return y;
		}
		return null;
	}

	/** A voxel DDA: the first solid cell along `dir` within `max`, as the game's raycast. */
	raycast(origin: Tuple3, dir: Tuple3, max: number): VoxelHit | null {
		const [ox, oy, oz] = origin;
		const len = Math.hypot(dir[0], dir[1], dir[2]);
		if (len === 0) return null;
		const r = [dir[0] / len, dir[1] / len, dir[2] / len];
		const cell = [Math.floor(ox), Math.floor(oy), Math.floor(oz)];
		const o = [ox, oy, oz];
		const step = r.map((v) => (v > 0 ? 1 : v < 0 ? -1 : 0));
		const tDelta = r.map((v, i) => (step[i] !== 0 ? Math.abs(1 / v) : Infinity));
		const tMax = r.map((v, i) => (step[i] !== 0 ? ((step[i] > 0 ? cell[i] + 1 : cell[i]) - o[i]) / v : Infinity));
		const faces: [VoxelHit['face'], VoxelHit['face']][] = [['nx', 'px'], ['ny', 'py'], ['nz', 'pz']];
		let face: VoxelHit['face'] = 'py';
		let t = 0;
		while (t <= max) {
			if (isSolidId(this.getBlock(cell[0], cell[1], cell[2]))) return { x: cell[0], y: cell[1], z: cell[2], face, distance: t };
			const axis = tMax[0] < tMax[1] && tMax[0] < tMax[2] ? 0 : tMax[1] < tMax[2] ? 1 : 2;
			t = tMax[axis];
			cell[axis] += step[axis];
			tMax[axis] += tDelta[axis];
			face = step[axis] > 0 ? faces[axis][0] : faces[axis][1];
		}
		return null;
	}

	generatedBlock(x: number, y: number, z: number): number {
		const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
		return this.inWorld(fx, fy, fz) ? this.generated(fx, fy, fz) : AIR;
	}

	/** True when the cell was written by `set` (the fake's stand-in for the server overlay / local writes). */
	isEdited(x: number, y: number, z: number): boolean {
		return this.overlay.has(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`);
	}

	/** Every `set` cell of chunk (cx, cz), in world coordinates. */
	editedCellsInChunk(cx: number, cz: number): Array<[number, number, number]> {
		const out: Array<[number, number, number]> = [];
		for (const k of this.overlay.keys()) {
			const [x, y, z] = k.split(',').map(Number);
			if (Math.floor(x / 16) === cx && Math.floor(z / 16) === cz) out.push([x, y, z]);
		}
		return out;
	}

	/** Test helper: the topmost solid block's y in a column, or −1. */
	surfaceY(x: number, z: number): number {
		for (let y = WORLD_HEIGHT - 1; y >= 0; y--) if (isSolidId(this.getBlock(x, y, z))) return y;
		return -1;
	}
}

/** A player for the fake body's scripted list (a kid with a pose, unless overridden). */
export function player(p: Partial<BotPlayer> & { id: number; name: string }): BotPlayer {
	return { skin: 'steve', bot: false, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hasPos: true, ...p };
}

/** One recorded body call, for loop tests. */
export type BodyCall = { fn: string; args: unknown[] };

const BEDROCK_ID = id('bedrock');

export class FakeBody implements Body {
	you = 99;
	current: Pose = { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 };
	list: BotPlayer[] = [];
	entries: JournalEntry[] = [];
	calls: BodyCall[] = [];
	/** Set to connect this body's writes and motion to a world, as the real SDK's `client.world` does. */
	world?: FakeWorld;
	/** What `walkTo`/`flyTo` return; replace for a never-resolving or rejecting walk. */
	walkImpl: (t: { x: number; z: number }) => Promise<WalkResult> = async () => 'arrived';
	flyImpl: (t: { x: number; y: number; z: number }) => Promise<WalkResult> = async () => 'arrived';
	placeImpl: (x: number, y: number, z: number, name: string) => Promise<boolean> = async () => true;
	/** Default, when `world` is set: false for air/bedrock, else `world.set(x, y, z, 0)` and true (the SDK's `break` rule). */
	breakImpl: (x: number, y: number, z: number) => Promise<boolean> = async (x, y, z) => {
		if (!this.world) return true;
		const cur = this.world.getBlock(x, y, z);
		if (cur === AIR || cur === BEDROCK_ID) return false;
		this.world.set(x, y, z, AIR);
		return true;
	};
	/** Default, when `world` is set: false for air/liquid/bedrock, else `world.set(x, y, z, 0)` and true (the SDK's `mine` rule). */
	mineImpl: (x: number, y: number, z: number) => Promise<boolean> = async (x, y, z) => {
		if (!this.world) return true;
		const cur = this.world.getBlock(x, y, z);
		if (cur === AIR || cur === BEDROCK_ID || this.world.isLiquid(cur)) return false;
		this.world.set(x, y, z, AIR);
		return true;
	};
	private readonly editCbs = new Set<(e: EditEvent) => void>();
	private readonly fxCbs = new Set<(fx: FxMsg) => void>();
	/** Identifies whichever walk or flight is currently pending (they share one slot, as the SDK). */
	private pendingMotion: { resolve: (r: WalkResult) => void } | null = null;

	pose(): Pose {
		return { ...this.current };
	}

	players(): BotPlayer[] {
		return this.list.map((p) => ({ ...p }));
	}

	/** Resolves a still-pending walk or flight 'cancelled' (a new walkTo/flyTo, a move, as the SDK). */
	private cancelMotion(): void {
		const p = this.pendingMotion;
		this.pendingMotion = null;
		if (p) p.resolve('cancelled');
	}

	walkTo(t: { x: number; z: number }, opts?: { speed?: number }): Promise<WalkResult> {
		this.calls.push({ fn: 'walkTo', args: [t, opts] });
		this.cancelMotion();
		return new Promise<WalkResult>((resolve, reject) => {
			const token = { resolve };
			this.pendingMotion = token;
			this.walkImpl(t).then(
				(r) => {
					if (this.pendingMotion !== token) return; // superseded or already cancelled
					this.pendingMotion = null;
					if (r === 'arrived' && this.world) {
						this.current = { ...this.current, x: t.x, z: t.z, y: this.world.groundY(Math.floor(t.x), Math.floor(t.z), this.current.y) ?? this.current.y };
					}
					resolve(r);
				},
				(err: unknown) => {
					if (this.pendingMotion !== token) return; // superseded or already cancelled: swallow, don't reject a settled promise
					this.pendingMotion = null;
					reject(err);
				},
			);
		});
	}

	flyTo(t: { x: number; y: number; z: number }): Promise<WalkResult> {
		this.calls.push({ fn: 'flyTo', args: [t] });
		this.cancelMotion();
		return new Promise<WalkResult>((resolve, reject) => {
			const token = { resolve };
			this.pendingMotion = token;
			this.flyImpl(t).then(
				(r) => {
					if (this.pendingMotion !== token) return; // superseded or already cancelled
					this.pendingMotion = null;
					// Not otherwise: an existing companion test relies on the fake not moving.
					if (r === 'arrived' && this.world) this.current = { ...this.current, x: t.x, y: t.y, z: t.z };
					resolve(r);
				},
				(err: unknown) => {
					if (this.pendingMotion !== token) return; // superseded or already cancelled: swallow, don't reject a settled promise
					this.pendingMotion = null;
					reject(err);
				},
			);
		});
	}

	move(p: PoseInput): void {
		this.calls.push({ fn: 'move', args: [p] });
		this.cancelMotion();
		this.current = { ...this.current, ...p };
	}

	lookAt(x: number, y: number, z: number): void {
		this.calls.push({ fn: 'lookAt', args: [x, y, z] });
	}

	place(x: number, y: number, z: number, name: string): Promise<boolean> {
		this.calls.push({ fn: 'place', args: [x, y, z, name] });
		return this.placeImpl(x, y, z, name).then((ok) => {
			if (ok && this.world) this.world.set(x, y, z, name);
			return ok;
		});
	}

	break(x: number, y: number, z: number): Promise<boolean> {
		this.calls.push({ fn: 'break', args: [x, y, z] });
		return this.breakImpl(x, y, z);
	}

	mine(x: number, y: number, z: number): Promise<boolean> {
		this.calls.push({ fn: 'mine', args: [x, y, z] });
		return this.mineImpl(x, y, z);
	}

	stopMining(): void {
		this.calls.push({ fn: 'stopMining', args: [] });
	}

	fx(msg: Omit<FxMsg, 't' | 'by'>): void {
		this.calls.push({ fn: 'fx', args: [msg] });
	}

	async revert(sinceMs?: number): Promise<number> {
		this.calls.push({ fn: 'revert', args: [sinceMs] });
		return 0;
	}

	journal(): JournalEntry[] {
		return this.entries.map((e) => ({ ...e }));
	}

	onEdit(cb: (e: EditEvent) => void): () => void {
		this.editCbs.add(cb);
		return () => {
			this.editCbs.delete(cb);
		};
	}

	onFx(cb: (fx: FxMsg) => void): () => void {
		this.fxCbs.add(cb);
		return () => {
			this.fxCbs.delete(cb);
		};
	}

	/** Test-only: delivers an edit to every `onEdit` subscriber. */
	emitEdit(e: EditEvent): void {
		for (const cb of [...this.editCbs]) cb(e);
	}

	/** Test-only: delivers an fx to every `onFx` subscriber. */
	emitFx(fx: FxMsg): void {
		for (const cb of [...this.fxCbs]) cb(fx);
	}

	/** Test-only: a kid's single-op edit of one cell, applied to `world` (old id read from it). */
	kidEdit(world: FakeWorld, by: BotPlayer, cell: Vec3, newId: number, opCount = 1): void {
		const oldId = world.getBlock(cell.x, cell.y, cell.z);
		world.set(cell.x, cell.y, cell.z, newId);
		this.emitEdit({ by: by.id, byName: by.name, byBot: by.bot, opCount, cells: [{ ...cell, oldId: oldId === newId ? null : oldId, newId }] });
	}
}
