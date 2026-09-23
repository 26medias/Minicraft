import type { World } from '../engine/world/world';
import type { Chunk } from '../engine/world/chunk';
import type { FpCamera } from '../engine/render/camera';
import type { Renderer } from '../engine/render/renderer';
import type { Player, Keys } from './player';
import { meshChunk, type ChunkMeshResult, type UvFn } from '../engine/world/mesher';
import { computeChunkShadows, ensureShadowNeighbourhood, hashSunlit } from '../engine/world/shadows';
import type { ChunkJobs } from '../engine/world/chunk-jobs';
import { raycastVoxel, type VoxelHit } from '../engine/input/raycast';
import { AIR, BLOCKS, BLOCK_BY_NAME, WATER, isSolid, type BlockId, type Face } from '../data/blocks.data';
import type { ParticleSystem } from '../engine/render/particles';
import type { PrimedOverlay } from '../engine/render/primed-overlay';
import type { LightRegistry } from '../engine/render/light-registry';
import type { FaceHighlight } from '../engine/render/face-highlight';
import { canReplace, igniteTnt, placeBlock, type PrimedEntry } from './actions';
import { tntKey, TNT_CHAIN_FUSE } from './tnt';
import { cellInBox, detonate, playerBox, yawDir } from './blast-shapes';
import { updateLightsForBlockChange } from '../engine/world/lighting';
import { LiquidScheduler } from './liquid-scheduler';
import { chunkIndex, chunkIndexOrNeg, WORLD_CHUNKS_Z } from '../engine/world/coords';
import { planFrame, chebyshev, budgetFor, MESH_RADIUS, UNMOUNT_RADIUS, DATA_RADIUS } from './chunk-scheduler';
import { areaBounds, areaCells, inHeldZone, isMultiBlock, miningDuration, type AreaBounds } from './tools';
import type { PickaxeTier } from '../data/crafting.data';

const LAMP_ID = BLOCK_BY_NAME['lamp'].id;
const FACE_OFFSET: Readonly<Record<Face, [number, number, number]>> = {
	px: [1, 0, 0], nx: [-1, 0, 0], py: [0, 1, 0], ny: [0, -1, 0], pz: [0, 0, 1], nz: [0, 0, -1],
};
/** Crafting spec §7: break particles for at most this many cells of one removeBlocks batch. */
const REMOVE_PARTICLE_CAP = 16;

/** Walk/physics ring; the mesh ring is MESH_RADIUS (src/engine/world/radii.ts). */
export const VIEW_RADIUS = 4;
const REACH = 6;

/** Spec §3.C.1: a chunk that just came into existence makes every already-shadowed 3×3 neighbour stale. The loop's arrival hook (not World.ensureChunk: gate 2). */
export function markChunkArrived(world: World, c: Chunk): void {
	for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
		const n = world.getChunk(c.cx + dx, c.cz + dz);
		if (n && n !== c) n.shadowsDirty = true;
	}
}

/** [+x, −x, +z, −z] via getChunk (never ensureChunk). */
function axisNeighbours(world: World, c: Chunk): (Chunk | undefined)[] {
	return [world.getChunk(c.cx + 1, c.cz), world.getChunk(c.cx - 1, c.cz), world.getChunk(c.cx, c.cz + 1), world.getChunk(c.cx, c.cz - 1)];
}

type MiningState = {
	target: { x: number; y: number; z: number };
	elapsed: number;
	duration: number;
	blockId: BlockId;
};

export type BlockBrokenEvent = {
	x: number;
	y: number;
	z: number;
	blockId: BlockId;
};

/** removeBlocks' rule for one cell: in bounds, solid, and breakable (hardness > 0 — bedrock never is). */
export function isRemovable(world: World, x: number, y: number, z: number): boolean {
	if (!world.inBounds(x, y, z)) return false;
	const id = world.getBlock(x, y, z);
	return isSolid(id) && (BLOCKS[id]?.hardness ?? 0) > 0;
}

/** The cells of `cells` that removeBlocks would actually remove: what the area highlight glows. */
export function removableCells(world: World, cells: ReadonlyArray<{ x: number; y: number; z: number }>): Array<{ x: number; y: number; z: number }> {
	return cells.filter((c) => isRemovable(world, c.x, c.y, c.z));
}

/** Time a new chunk needs (generate + light, measured ≈ 7.5 ms median on v3): don't start one with less left. */
const CHUNK_GEN_RESERVE_MS = 10;

export class GameLoop {
	/** All keyed by the flat chunk index (coords.chunkIndex); only ever filled through chunkIndexOrNeg. */
	private streamSet = new Set<number>();
	private editLane = new Set<number>();
	/**
	 * Crafting spec §7: chunks a batched removal touched besides its anchor. Drained after the edit lane (posted to the
	 * worker, or one synchronous mesh per frame without one); in-flight entries are skipped. A chunk leaves it only when
	 * its mesh is applied, so a dropped reply leaves it here to be posted again.
	 */
	private bulkLane = new Set<number>();
	/** Chunks dirtied only by shadow invalidation: re-meshed only when their sunlitHash changed (spec §3.E). */
	private shadowOnly = new Set<number>();
	/** Deadline of the current frame's stream budget (performance.now() ms), set before planFrame. */
	private frameDeadline = 0;
	/** Chunk objects whose liquid was already seeded (re-entry creates a new object, so it is seeded again). */
	private liquidSeeded = new WeakSet<Chunk>();
	private mountedChunks = new Set<number>();
	/** Posted to the worker, reply not yet in. Skipped by loadNearbyChunks and the stream order (spec §3.D). */
	private inFlightIndex = new Set<number>();
	/** The index mountStream could not post this frame (worker full): it must stay in the stream set. */
	private refusedIndex = -1;
	private lastPlayerChunk = -1;
	private lastPlayerPos: [number, number] | null = null;
	private horizontalSpeed = 0;
	private initialLoad = true;
	private moving = false;
	private editStartedAt = 0;
	private mining: MiningState | null = null;
	private aim: VoxelHit | null = null;
	private leftMouseDown = false;
	/**
	 * Spec §5 floor state. Armed (0.4 s) by a press, a release and a pickaxe switch; cleared by an
	 * area break, after which a target in that break's held zone gets the 0.25 s floor.
	 */
	private floorArmed = true;
	private lastArea: (AreaBounds & { face: Face }) | null = null;
	private primedTnt = new Map<string, PrimedEntry>();
	private scheduler: LiquidScheduler;

	onBlockBroken: ((ev: BlockBrokenEvent) => void) | null = null;
	/**
	 * Crafting spec §2/§7: the blocks one batch removed. Fired by a TNT detonation (without the detonating TNT's own cell;
	 * chain-primed TNT is never removed by a blast) and by area mining. Single-block mining keeps onBlockBroken.
	 */
	onBlocksRemoved: ((removed: BlockBrokenEvent[]) => void) | null = null;
	onWorldMutated: (() => void) | null = null;
	onMiningProgress: ((progress: number) => void) | null = null;
	onFlyStateChange: ((tier: number | null) => void) | null = null;

	/**
	 * Set by the play-time limit. While true, tick() only syncs the camera and
	 * keeps loading/meshing chunks: no physics, mining, particles, or simulation.
	 * Chunks keep loading so a world opened straight into a break is not empty sky.
	 */
	paused = false;

	/** Read by the F3 overlay (Task 7) and the bench (Task 8). Stub in this task; Tasks 4/5/6 fill the fields. */
	/**
	 * `lastEditMs`: click-to-mounted latency, including the wait for the next tick (informational).
	 * `lastEditWorkMs`: main-thread time spent re-meshing the edit lane in that tick (the bench's edit gate).
	 */
	/** `lightMs`: cumulative main-thread light work (removeBlocks + applyLightUpdate), read per frame by the bench. */
	stats = { streamQueue: 0, editQueue: 0, bulkQueue: 0, lastEditMs: -1, lastEditWorkMs: -1, mounted: 0, data: 0, workerInFlight: 0, lightMs: 0 };

	/**
	 * F3 overlay hook (spec §3.F). Called at the end of every tick, paused or not, with the clamped
	 * `dt`, this tick's main-thread duration and the RAW `performance.now()` delta since the last
	 * tick (`renderer.frame` clamps `dt` at 100 ms, so a 400 ms hitch would otherwise read as 100).
	 */
	onFrame: ((dt: number, tickMs: number, frameMs: number) => void) | null = null;
	private lastFrameAt = -1;

	constructor(
		private world: World,
		private renderer: Renderer,
		private cam: FpCamera,
		private player: Player,
		private keys: Keys,
		private uvFor: UvFn,
		private particles: ParticleSystem | null = null,
		private overlay: PrimedOverlay | null = null,
		private lights: LightRegistry | null = null,
		private highlight: FaceHighlight | null = null,
		private jobs: ChunkJobs | null = null,
	) {
		this.scheduler = new LiquidScheduler(
			this.world,
			(cx, cz) => this.markChunkDirty(cx, cz),
			// Liquid light changes are never under the crosshair: spread their re-mesh over frames (final review:
			// a lake refilling a Mega crater re-meshed 4 chunks per liquid tick on the main thread).
			(x, y, z) => this.applyLightUpdate(x, y, z, 'bulk'),
			// DEV assertion (spec §3.E): no scheduler read may reach beyond the data ring of the CURRENT player chunk.
			(x, z) => {
				const pcx = Math.floor(this.player.position[0] / 16), pcz = Math.floor(this.player.position[2] / 16);
				return Math.max(Math.abs(Math.floor(x / 16) - pcx), Math.abs(Math.floor(z / 16) - pcz)) <= DATA_RADIUS;
			},
		);
		if (this.jobs) {
			this.jobs.onReply = (job, sunlit, mesh) => this.onJobReply(job.chunk, sunlit, mesh);
			this.jobs.onDropped = (job) => this.onJobDropped(job.cx, job.cz);
		}
	}

	/** Spec §3.D "wanted": within MESH_RADIUS of the CURRENT player chunk (the enqueue ring, not the evictor's). */
	private wanted(i: number): boolean {
		return chebyshev(i, Math.floor(this.player.position[0] / 16), Math.floor(this.player.position[2] / 16)) <= MESH_RADIUS;
	}

	/** Fresh reply (all 9 slots checked by ChunkJobs): store sunlit, mount, and re-dirty mounted axis neighbours shadowOnly if the sunlit changed. */
	private onJobReply(c: Chunk, sunlit: Uint8Array, mesh: ChunkMeshResult): void {
		const idx = chunkIndex(c.cx, c.cz);
		this.inFlightIndex.delete(idx);
		// A fresh reply means nothing in its 3×3 changed since the post, so a bulk chunk is done (or unwanted).
		this.bulkLane.delete(idx);
		if (!this.wanted(idx)) return; // player left: do not mount what the evictor would drop next frame
		const before = c.sunlitHash;
		c.sunlit.set(sunlit);
		c.sunlitHash = hashSunlit(sunlit);
		c.shadowsDirty = false;
		this.renderer.mountChunkMesh(c, mesh);
		this.mountedChunks.add(idx);
		// Seams (spec §3.D): mounted axis neighbours sample this chunk's final sunlit at their border
		// corners → re-dirty them shadowOnly; the sunlitHash compare keeps most from re-meshing.
		// Crafting spec §7, no drop cascade: only when this chunk's sunlit CHANGED. With 9-slot freshness a rev bump
		// drops every in-flight job whose 3×3 holds the neighbour, so an unconditional bump made a blast's bulk replies
		// invalidate each other in turn; with the hash unchanged the in-flight jobs copied valid data.
		if (c.sunlitHash === before) return;
		for (const n of axisNeighbours(this.world, c)) {
			if (n && this.mountedChunks.has(chunkIndex(n.cx, n.cz))) {
				n.shadowsDirty = true;
				n.rev++;
				this.markChunkDirty(n.cx, n.cz, { shadowOnly: true });
			}
		}
	}

	/**
	 * Invariant (spec §3.D): a chunk stays dirty until a reply is applied — a dropped reply re-dirties it. A bulk chunk is
	 * still in the bulk lane (crafting spec §7: dropped bulk chunks go back to the bulk lane, not the stream set).
	 */
	private onJobDropped(cx: number, cz: number): void {
		const idx = chunkIndex(cx, cz);
		this.inFlightIndex.delete(idx);
		if (this.bulkLane.has(idx)) return;
		if (this.wanted(idx)) this.streamSet.add(idx);
	}

	/**
	 * `edit`: the chunk goes to the budget-exempt edit lane, re-meshed on the next tick before any
	 * streaming. `shadowOnly`: dirtied only by shadow invalidation; the stream lane re-meshes it only
	 * when its sunlitHash changed.
	 */
	markChunkDirty(cx: number, cz: number, opts?: { edit?: boolean; shadowOnly?: boolean }) {
		const i = chunkIndexOrNeg(cx, cz);
		if (i < 0) return;
		if (opts?.edit) {
			this.editLane.add(i);
			if (!this.editStartedAt) this.editStartedAt = performance.now();
		} else {
			this.streamSet.add(i);
			if (opts?.shadowOnly) this.shadowOnly.add(i);
		}
	}

	/** `lane` 'bulk': the touched chunks re-mesh through the bulk lane instead of synchronously (liquid updates). */
	/** Queue a chunk in the bulk lane (spread re-mesh), unless it is already in the edit lane this frame. */
	private markChunkBulk(cx: number, cz: number): void {
		const i = chunkIndexOrNeg(cx, cz);
		if (i < 0 || this.editLane.has(i)) return;
		// It must re-mesh whatever its sunlit does: a shadowOnly flag would let the sunlitHash skip drop it.
		this.shadowOnly.delete(i);
		this.bulkLane.add(i);
		this.streamSet.delete(i);
	}

	applyLightUpdate(x: number, y: number, z: number, lane: 'edit' | 'bulk' = 'edit'): void {
		const getLampColor = (lx: number, ly: number, lz: number): string | null =>
			this.lights?.getColor(lx, ly, lz) ?? null;
		const t0 = performance.now();
		const touched = updateLightsForBlockChange(this.world, x, y, z, getLampColor);
		this.stats.lightMs += performance.now() - t0;
		for (const c of touched) {
			if (lane === 'edit') this.markChunkDirty(c.cx, c.cz, { edit: true });
			else this.markChunkBulk(c.cx, c.cz);
			c.shadowsDirty = true;
			c.rev++;
		}
		// Also flag chunks in the shadow direction (SE of the edit) since a placed/removed
		// block can shadow further SE.
		const edited = this.world.getChunk(Math.floor(x / 16), Math.floor(z / 16));
		if (edited) {
			edited.shadowsDirty = true;
			edited.rev++;
			const seNeighbors = [
				this.world.getChunk(edited.cx + 1, edited.cz),
				this.world.getChunk(edited.cx, edited.cz + 1),
				this.world.getChunk(edited.cx + 1, edited.cz + 1),
			];
			for (const n of seNeighbors) {
				if (n) {
					n.shadowsDirty = true;
					n.rev++;
					this.markChunkDirty(n.cx, n.cz, { shadowOnly: true });
				}
			}
		}
	}

	/**
	 * Mark the chunk containing a world block + any neighbor chunks if the block sits on a chunk
	 * edge. All go to the edit lane: both sides of a shared face must re-mesh for it to appear.
	 */
	markChunkDirtyAround(wx: number, wz: number) {
		const cx = Math.floor(wx / 16);
		const cz = Math.floor(wz / 16);
		const edit = { edit: true };
		this.markChunkDirty(cx, cz, edit);
		const lx = wx - cx * 16,
			lz = wz - cz * 16;
		if (lx === 0) this.markChunkDirty(cx - 1, cz, edit);
		if (lx === 15) this.markChunkDirty(cx + 1, cz, edit);
		if (lz === 0) this.markChunkDirty(cx, cz - 1, edit);
		if (lz === 15) this.markChunkDirty(cx, cz + 1, edit);
	}

	setLeftMouseDown(down: boolean) {
		// A press is ignored while paused; a release is always honoured so a
		// freeze can clear in-progress mining.
		if (down && this.paused) return;
		this.leftMouseDown = down;
		this.floorArmed = true;
		if (!down) this.mining = null;
	}

	/**
	 * Spec §5: called after `player.tools.equipped` changes (P, or a click in the I screen). Re-arms
	 * the 0.4 s floor and drops the mine in progress, so the next tick restarts it at the new tier's
	 * time from zero.
	 */
	onPickaxeChanged(): void {
		this.floorArmed = true;
		this.mining = null;
	}

	/** The equipped pickaxe tier (Phase B resolves `player.tools` on load). */
	private equippedTier(): PickaxeTier {
		return this.player.tools.equipped as PickaxeTier;
	}

	/** 0..1 if mining in progress, 0 otherwise. Consumed by the HUD to draw the progress ring. */
	miningProgress(): number {
		return this.mining ? Math.min(1, this.mining.elapsed / this.mining.duration) : 0;
	}

	/**
	 * Called from main.ts on 'ignite' keydown with the camera's yaw. Returns true if a TNT was newly primed.
	 * A Tunnel TNT takes its direction from the yaw, snapped to ±x or ±z (toys spec §3.4).
	 */
	ignite(hit: VoxelHit, yaw: number): boolean {
		const ok = igniteTnt(this.world, hit, this.primedTnt, yawDir(yaw));
		if (ok) this.overlay?.add(hit.x, hit.y, hit.z);
		return ok;
	}

	/**
	 * Everything that must happen when the block at (x,y,z) stops existing:
	 * a primed TNT loses its fuse, a lamp loses its light, and break particles
	 * spawn. Shared by mining completion and shift-to-replace. Call before the
	 * world write.
	 */
	private clearBlockEffects(x: number, y: number, z: number, oldId: BlockId, particles = true): void {
		const k = tntKey(x, y, z);
		if (this.primedTnt.delete(k)) this.overlay?.remove(x, y, z);
		if (oldId === LAMP_ID) this.lights?.remove(x, y, z);
		if (particles) this.particles?.spawnBreak(x, y, z, oldId);
	}

	/**
	 * Crafting spec §7: remove a batch of blocks — a TNT blast, an area break. Out-of-bounds, air, liquid and hardness-0
	 * cells (bedrock) are skipped here. Per cell, in order: clearBlockEffects (a primed fuse, a lamp's light; particles for
	 * at most REMOVE_PARTICLE_CAP cells, spread over the batch), world.setBlock(AIR) — never chunk.set: setBlock wakes liquids and sets
	 * `modified` — and updateLightsForBlockChange called DIRECTLY. applyLightUpdate would send every chunk the light
	 * touched to the synchronous edit lane. Light stays per block: exact and cheap, where a bounding-box relight misses
	 * sunlight columns below the box.
	 *
	 * Routing, with the rev/shadowsDirty bumps applyLightUpdate makes: only the anchor's chunk (the aimed block, the TNT
	 * origin) goes to the edit lane. Every other chunk the batch touched — each cell's chunk and its edge neighbours, every
	 * chunk the light touched — goes to the bulk lane. The south-east shadow neighbours stay shadow-only (stream lane with
	 * the sunlitHash skip), as for a single edit. Single-block mine, place and replace never come here. The caller applies
	 * counts from `removed`.
	 */
	removeBlocks(cells: Array<{ x: number; y: number; z: number }>, anchor: { x: number; y: number; z: number }): { removed: BlockBrokenEvent[] } {
		const removed: BlockBrokenEvent[] = [];
		const stride = Math.max(1, Math.ceil(cells.length / REMOVE_PARTICLE_CAP));
		let k = 0;
		const batch = this.newBatch();
		for (const { x, y, z } of cells) {
			if (!isRemovable(this.world, x, y, z)) continue;
			const id = this.world.getBlock(x, y, z);
			// Spread the capped particles over the whole batch: detonate() lists cells bottom-up, so the first 16 are buried.
			this.clearBlockEffects(x, y, z, id, k++ % stride === 0);
			this.world.setBlock(x, y, z, AIR);
			removed.push({ x, y, z, blockId: id });
			this.batchCell(batch, x, y, z);
		}
		if (removed.length > 0) this.routeBatch(batch, anchor);
		return { removed };
	}

	/**
	 * Toys spec §3.5 / §3.7: write `blockId` into a batch of cells (dome glass, lake water), the mirror of removeBlocks.
	 * Skips out-of-bounds cells, every cell that is not AIR (solid blocks, liquids) and every cell the player's box
	 * overlaps. Per cell: world.setBlock (wakes liquids, sets `modified`) and the per-block light update; then the anchor
	 * chunk goes to the edit lane and every other touched chunk to the bulk lane, exactly as removeBlocks routes.
	 * Placed blocks are free: nothing is counted and no event fires. Not for lamps (no light registry colour is set).
	 */
	placeBlocks(cells: ReadonlyArray<{ x: number; y: number; z: number }>, blockId: BlockId, anchor: { x: number; y: number; z: number }): { placed: Array<{ x: number; y: number; z: number }> } {
		const placed: Array<{ x: number; y: number; z: number }> = [];
		const box = playerBox(this.player.position);
		const batch = this.newBatch();
		for (const { x, y, z } of cells) {
			if (!this.world.inBounds(x, y, z) || this.world.getBlock(x, y, z) !== AIR || cellInBox(x, y, z, box)) continue;
			this.world.setBlock(x, y, z, blockId);
			placed.push({ x, y, z });
			this.batchCell(batch, x, y, z);
		}
		if (placed.length > 0) this.routeBatch(batch, anchor);
		return { placed };
	}

	/** One batch's bookkeeping: chunks whose blocks or light changed (or that border a changed cell), and SE shadow neighbours. */
	private newBatch(): { dirty: Set<number>; shadow: Map<number, Chunk> } {
		return { dirty: new Set<number>(), shadow: new Map<number, Chunk>() };
	}

	/** After the world write of one batch cell: the per-block light update and the chunk bookkeeping (removeBlocks' loop body). */
	private batchCell(batch: { dirty: Set<number>; shadow: Map<number, Chunk> }, x: number, y: number, z: number): void {
		const { dirty, shadow } = batch;
		const getLampColor = (lx: number, ly: number, lz: number): string | null => this.lights?.getColor(lx, ly, lz) ?? null;
		const t0 = performance.now();
		const touched = updateLightsForBlockChange(this.world, x, y, z, getLampColor);
		this.stats.lightMs += performance.now() - t0;
		for (const c of touched) {
			c.shadowsDirty = true;
			c.rev++;
			dirty.add(chunkIndex(c.cx, c.cz));
		}
		const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
		const lx = x - cx * 16, lz = z - cz * 16;
		dirty.add(chunkIndex(cx, cz));
		for (const [ex, ez, on] of [[cx - 1, cz, lx === 0], [cx + 1, cz, lx === 15], [cx, cz - 1, lz === 0], [cx, cz + 1, lz === 15]] as const) {
			const i = on ? chunkIndexOrNeg(ex, ez) : -1;
			if (i >= 0) dirty.add(i);
		}
		const edited = this.world.getChunk(cx, cz)!;
		edited.shadowsDirty = true;
		edited.rev++;
		for (const n of [this.world.getChunk(cx + 1, cz), this.world.getChunk(cx, cz + 1), this.world.getChunk(cx + 1, cz + 1)]) {
			if (!n) continue;
			n.shadowsDirty = true;
			n.rev++;
			shadow.set(chunkIndex(n.cx, n.cz), n);
		}
	}

	/** A batch's lanes: the anchor's chunk to the edit lane, every other dirty chunk to the bulk lane, SE shadow neighbours shadow-only. */
	private routeBatch(batch: { dirty: Set<number>; shadow: Map<number, Chunk> }, anchor: { x: number; y: number; z: number }): void {
		const { dirty, shadow } = batch;
		const a = chunkIndexOrNeg(Math.floor(anchor.x / 16), Math.floor(anchor.z / 16));
		for (const i of dirty) {
			// It must re-mesh whatever its sunlit does: a shadowOnly flag would let the sunlitHash skip drop it.
			this.shadowOnly.delete(i);
			if (i === a) {
				this.editLane.add(i);
				if (!this.editStartedAt) this.editStartedAt = performance.now();
			} else {
				this.bulkLane.add(i);
				this.streamSet.delete(i);
			}
		}
		for (const [i, n] of shadow) if (!dirty.has(i)) this.markChunkDirty(n.cx, n.cz, { shadowOnly: true });
	}

	/**
	 * Shift + right click: overwrite the aimed block with `newId`. Returns false
	 * (and touches nothing) when canReplace refuses. Fires onWorldMutated, not
	 * onBlockBroken: nothing was mined.
	 */
	replaceBlock(hit: VoxelHit, newId: BlockId, lampColor: string): boolean {
		if (!canReplace(this.world, hit, newId)) return false;
		const { x, y, z } = hit;
		const oldId = this.world.getBlock(x, y, z);
		const m = this.mining;
		if (m && m.target.x === x && m.target.y === y && m.target.z === z) this.mining = null;
		this.clearBlockEffects(x, y, z, oldId);
		this.world.setBlock(x, y, z, newId);
		// lights.add must precede applyLightUpdate, which reads the colour back.
		if (newId === LAMP_ID) this.lights?.add(x, y, z, lampColor);
		this.markChunkDirtyAround(x, z);
		this.applyLightUpdate(x, y, z);
		this.onWorldMutated?.();
		return true;
	}

	/**
	 * Right click: build against the aimed face. Moved from main.ts unchanged (place.ts calls it):
	 * refused when the target cell is solid or inside the player; the lamp registers its colour
	 * before the relight reads it; the re-mesh is around the HIT column, as main.ts always did.
	 * Fires onWorldMutated (main.ts: autosave.markDirty, as the old handler did).
	 */
	placeBlock(hit: VoxelHit, id: BlockId, lampColor: string): boolean {
		if (!placeBlock(this.world, hit, id, { position: this.player.position, size: [0.6, 1.8, 0.6] })) return false;
		const [dx, dy, dz] = FACE_OFFSET[hit.face];
		const x = hit.x + dx, y = hit.y + dy, z = hit.z + dz;
		if (id === LAMP_ID) this.lights?.add(x, y, z, lampColor);
		this.markChunkDirtyAround(hit.x, hit.z);
		this.applyLightUpdate(x, y, z);
		this.onWorldMutated?.();
		return true;
	}

	start() {
		this.renderer.onTick((dt) => this.tick(dt));
	}

	private tick(dt: number) {
		const start = performance.now();
		const frameMs = this.lastFrameAt < 0 ? 0 : start - this.lastFrameAt;
		this.lastFrameAt = start;
		this.tickBody(dt);
		this.onFrame?.(dt, performance.now() - start, frameMs);
	}

	private tickBody(dt: number) {
		if (this.paused) {
			this.cam.sync(this.renderer.camera);
			this.updateSpeed(dt);
			this.loadNearbyChunks();
			this.flushDirtyChunks();
			this.evict();
			this.highlight?.hide();
			return;
		}
		// Use getLookDir() (full 3D, includes pitch) so that cursor-directed fly/swim
		// movement contributes a Y component. On-ground walking still only reads x/z
		// from this vector, so there's no horizontal-speed regression.
		const fwd = this.cam.getLookDir();
		const right = this.cam.getRight();
		this.player.update(dt, this.world, this.keys, fwd, right);
		const eye = this.player.eyePosition();
		this.cam.position.set(eye[0], eye[1], eye[2]);
		this.cam.sync(this.renderer.camera);

		// One raycast per tick, shared by the highlight and mining. Must run after
		// the camera sync so it sees this frame's eye position. `fwd` is this
		// tick's look direction (yaw/pitch do not change inside a tick).
		this.aim = raycastVoxel(this.world, eye, [fwd.x, fwd.y, fwd.z], REACH);
		if (this.aim) {
			this.highlight?.show(this.aim.x, this.aim.y, this.aim.z, this.aim.face);
			const tier = this.equippedTier();
			const multi = isMultiBlock(tier);
			// Glow exactly the cells the break will remove (same rule as removeBlocks), never the air in the area.
			this.highlight?.setCells(multi ? removableCells(this.world, areaCells(this.aim, this.aim.face, tier)) : [], multi);
		} else this.highlight?.hide();

		this.updateMining(dt);
		this.onMiningProgress?.(this.miningProgress());
		this.onFlyStateChange?.(this.player.flying ? this.player.flySpeedTier : null);
		this.particles?.tick(dt);
		this.simulate(dt);
		this.evict();
		this.overlay?.tick(dt);
		this.updateSpeed(dt);
		this.loadNearbyChunks();
		this.flushDirtyChunks();
	}

	/**
	 * Spec §3.E, after `simulate` (so no scheduler read of this tick lands on a dropped chunk): unmount
	 * meshes beyond UNMOUNT_RADIUS and clear every numeric set of the index (an entry left in
	 * mountedChunks would block the re-mesh on re-entry); drop UNMODIFIED data beyond DATA_RADIUS —
	 * modified chunks stay for the session (autosave.snapshot() is exactly world.modifiedChunks()).
	 */
	private evict() {
		const pcx = Math.floor(this.player.position[0] / 16), pcz = Math.floor(this.player.position[2] / 16);
		for (const i of this.mountedChunks) {
			if (chebyshev(i, pcx, pcz) > UNMOUNT_RADIUS) {
				const cx = Math.floor(i / WORLD_CHUNKS_Z), cz = i % WORLD_CHUNKS_Z;
				this.renderer.unmountChunk(cx, cz);
				this.mountedChunks.delete(i);
				this.streamSet.delete(i);
				this.shadowOnly.delete(i);
			}
		}
		// Queued work the player has left behind: an entry outside MESH_RADIUS is unwanted (same test as a worker
		// reply's wanted()). Mounting it would regenerate its whole 3×3, up to 17 chunks away, for nothing.
		for (const i of this.streamSet) if (chebyshev(i, pcx, pcz) > MESH_RADIUS) this.streamSet.delete(i);
		for (const i of this.shadowOnly) if (chebyshev(i, pcx, pcz) > MESH_RADIUS) this.shadowOnly.delete(i);
		for (const i of this.bulkLane) if (chebyshev(i, pcx, pcz) > MESH_RADIUS) this.bulkLane.delete(i);
		for (const c of this.world.allChunks()) {
			if (!c.modified && Math.max(Math.abs(c.cx - pcx), Math.abs(c.cz - pcz)) > DATA_RADIUS) {
				const i = chunkIndex(c.cx, c.cz);
				if (this.inFlightIndex.has(i)) continue; // its reply is still owed; onJobReply's wanted() discards it
				this.world.dropChunk(c.cx, c.cz);
			}
		}
		this.stats.mounted = this.mountedChunks.size;
		this.stats.data = this.world.chunkCount;
	}

	/** Horizontal speed (blocks/s) from the player's position delta this tick; feeds the `moving` flag. */
	private updateSpeed(dt: number) {
		const p = this.player.position;
		if (this.lastPlayerPos && dt > 0) {
			this.horizontalSpeed = Math.hypot(p[0] - this.lastPlayerPos[0], p[2] - this.lastPlayerPos[1]) / dt;
		} else {
			this.horizontalSpeed = 0;
		}
		this.lastPlayerPos = [p[0], p[2]];
	}

	private updateMining(dt: number) {
		if (!this.leftMouseDown) {
			this.mining = null;
			return;
		}

		const hit = this.aim;
		if (!hit) {
			this.mining = null;
			return;
		}

		// Cursor moved to a different voxel → cancel and possibly start a new mine.
		if (
			this.mining &&
			(this.mining.target.x !== hit.x ||
				this.mining.target.y !== hit.y ||
				this.mining.target.z !== hit.z)
		) {
			this.mining = null;
		}

		if (!this.mining) {
			const blockId = this.world.getBlock(hit.x, hit.y, hit.z);
			const def = BLOCKS[blockId];
			if (!def || !isSolid(blockId) || def.hardness <= 0) return;
			// Spec §5: only the aimed block's hardness counts. The held floor needs the button held since
			// the last area break AND the aim inside that break's held zone; anything else is armed.
			const tier = this.equippedTier();
			const held = !this.floorArmed && this.lastArea !== null && inHeldZone(this.lastArea, hit);
			this.mining = {
				target: { x: hit.x, y: hit.y, z: hit.z },
				elapsed: 0,
				duration: miningDuration(def.hardness, tier, isMultiBlock(tier) ? (held ? 'held' : 'armed') : 'none'),
				blockId,
			};
			return;
		}

		this.mining.elapsed += dt;
		if (this.mining.elapsed >= this.mining.duration) {
			const { target, blockId } = this.mining;
			this.mining = null;
			const tier = this.equippedTier();
			if (isMultiBlock(tier)) {
				// Area break (spec §5, §7): the whole shape goes to removeBlocks, which skips air, liquids,
				// hardness-0 and out-of-bounds cells; the aimed block is the anchor (edit lane).
				const { removed } = this.removeBlocks(areaCells(target, hit.face, tier), target);
				this.lastArea = { ...areaBounds(target, hit.face, tier), face: hit.face };
				this.floorArmed = false;
				if (removed.length > 0) this.onBlocksRemoved?.(removed);
				return;
			}
			this.clearBlockEffects(target.x, target.y, target.z, blockId);
			this.world.setBlock(target.x, target.y, target.z, AIR);
			this.markChunkDirtyAround(target.x, target.z);
			this.applyLightUpdate(target.x, target.y, target.z);
			this.onBlockBroken?.({ x: target.x, y: target.y, z: target.z, blockId });
		}
	}

	/**
	 * The simulation-only slice of a tick, split out so autosave wiring can be tested
	 * without a WebGL renderer. Fires onWorldMutated when the sim changed a block:
	 * TNT and liquids mutate chunks without going through the place/break paths, so
	 * without this their edits are never marked dirty and are lost on tab close.
	 */
	simulate(dt: number): void {
		const liquidsChanged = this.scheduler.tick(dt);
		const tntChanged = this.updatePrimedTnt(dt);
		if (liquidsChanged || tntChanged) this.onWorldMutated?.();
	}

	private updatePrimedTnt(dt: number): boolean {
		if (this.primedTnt.size === 0) return false;
		const expired: PrimedEntry[] = [];
		for (const entry of this.primedTnt.values()) {
			entry.fuse -= dt;
			if (entry.fuse <= 0) expired.push(entry);
		}
		for (const entry of expired) {
			const k = tntKey(entry.x, entry.y, entry.z);
			this.primedTnt.delete(k);
			this.overlay?.remove(entry.x, entry.y, entry.z);
			this.detonateAt(entry);
		}
		return expired.length > 0;
	}

	/**
	 * Radius, shape and a Tunnel's dir come from the entry (fixed at priming: the shape through its blockId), never from
	 * what sits at the origin now. Toys spec §4: removal first (counted, minus the origin), then the free builds.
	 */
	private detonateAt(entry: PrimedEntry): void {
		const { x: ox, y: oy, z: oz } = entry;
		const origin = { x: ox, y: oy, z: oz };
		const shape = BLOCKS[entry.blockId]?.tnt?.shape ?? 'sphere';
		const result = detonate(this.world, ox, oy, oz, (x, y, z) => this.primedTnt.has(tntKey(x, y, z)), entry.radius,
			{ shape, dir: entry.dir, player: playerBox(this.player.position) });
		// Crafting spec §7: one batch anchored at the origin (edit lane); the rest of the blast goes to the bulk lane.
		const { removed } = this.removeBlocks(result.destroyed, origin);
		// The detonating TNT's own cell is not a mined block (spec §2: a lone TNT adds 0 TNT).
		const mined = removed.filter((r) => r.x !== ox || r.y !== oy || r.z !== oz);
		if (mined.length > 0) this.onBlocksRemoved?.(mined);
		// Toys spec §2: built blocks (dome glass, lake water) are free, never counted.
		if (result.build) this.placeBlocks(result.build.cells, result.build.blockId, origin);
		if (result.water) this.placeBlocks(result.water, WATER, origin);
		for (const { x, y, z, radius, blockId, dir } of result.primed) {
			// Chain fuse is 0.1 s for every tier; the chained TNT keeps ITS OWN radius (and a Tunnel its chained dir).
			const chained: PrimedEntry = { x, y, z, fuse: TNT_CHAIN_FUSE, radius, blockId };
			if (dir) chained.dir = dir;
			this.primedTnt.set(tntKey(x, y, z), chained);
			this.overlay?.add(x, y, z);
		}
		this.particles?.spawnBreak(ox, oy, oz, entry.blockId);
	}

	/** Enqueues the MESH_RADIUS ring into the stream set (spec §3.B) and updates the `moving` flag. */
	private loadNearbyChunks() {
		const pcx = Math.floor(this.player.position[0] / 16);
		const pcz = Math.floor(this.player.position[2] / 16);
		const pc = chunkIndexOrNeg(pcx, pcz);
		this.moving = pc !== this.lastPlayerChunk || this.horizontalSpeed > 0.5;
		this.lastPlayerChunk = pc;
		for (let dx = -MESH_RADIUS; dx <= MESH_RADIUS; dx++) {
			for (let dz = -MESH_RADIUS; dz <= MESH_RADIUS; dz++) {
				const i = chunkIndexOrNeg(pcx + dx, pcz + dz);
				if (i < 0 || this.mountedChunks.has(i) || this.inFlightIndex.has(i)) continue;
				this.streamSet.add(i);
			}
		}
	}

	private onChunkArrived(c: Chunk): void {
		markChunkArrived(this.world, c);
	}

	/** `ensureShadowNeighbourhood` plus the arrival re-dirty for every neighbour it created. */
	/**
	 * Generate the chunk at `i` and its 3×3 one chunk at a time until this frame's budget is spent (always
	 * at least one, so a cold start still progresses). Returns true when all nine exist and the mount may
	 * proceed; false leaves the index queued for the next frame. Measured: the first streaming mount of a
	 * new world generated all nine in one ~85 ms task.
	 */
	private generatePaced(i: number): boolean {
		const cx = Math.floor(i / WORLD_CHUNKS_Z), cz = i % WORLD_CHUNKS_Z;
		// Worker path: the 3×3. Sync fallback: mountSync also re-shadows the 4 axis neighbours, and each of
		// those needs ITS 3×3 — pace that cross too, or it lands in one frame (12 chunks, measured).
		const reach = this.jobs ? [[0, 0]] : [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
		let made = 0;
		for (const [ox, oz] of reach) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
			const x = cx + ox + dx, z = cz + oz + dz;
			if (!this.world.chunkInWorld(x, z) || this.world.getChunk(x, z)) continue;
			// Start a chunk only with a chunk's worth of time left (one took 27 ms from 1.8 ms before the deadline).
			if (made > 0 && performance.now() > this.frameDeadline - CHUNK_GEN_RESERVE_MS) return false;
			this.onChunkArrived(this.world.ensureChunk(x, z));
			made++;
		}
		return !(made > 0 && performance.now() > this.frameDeadline - CHUNK_GEN_RESERVE_MS);
	}

	private ensureNeighbourhood(c: Chunk): void {
		const before: (Chunk | undefined)[] = [];
		for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) before.push(this.world.getChunk(c.cx + dx, c.cz + dz));
		ensureShadowNeighbourhood(this.world, c);
		let i = 0;
		for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++, i++) {
			if (before[i]) continue;
			const n = this.world.getChunk(c.cx + dx, c.cz + dz);
			if (n) this.onChunkArrived(n);
		}
	}

	/**
	 * Recomputes a dirty chunk's shadows (ensuring its 3×3 first). Returns false when the chunk was
	 * dirtied only by shadow invalidation, is already mounted and its sunlit did not change: no
	 * re-mesh is needed, so it also leaves the stream lane (spec §3.E sunlitHash compare).
	 */
	private reshadow(c: Chunk): boolean {
		const i = chunkIndex(c.cx, c.cz);
		const before = c.sunlitHash;
		this.ensureNeighbourhood(c);
		computeChunkShadows(this.world, c);
		if (this.shadowOnly.has(i) && before === c.sunlitHash && this.mountedChunks.has(i)) {
			this.shadowOnly.delete(i);
			this.streamSet.delete(i);
			return false;
		}
		return true;
	}

	/** Shared prologue of both mount paths: ensure the chunk (arrival re-dirty), liquid scan, ensure the 3×3. */
	private prepareChunk(i: number): Chunk {
		// Indices only ever come from chunkIndexOrNeg, so (cx, cz) is in the world.
		const cx = Math.floor(i / WORLD_CHUNKS_Z),
			cz = i % WORLD_CHUNKS_Z;
		const existed = !!this.world.getChunk(cx, cz);
		const c = this.world.ensureChunk(cx, cz);
		if (!existed) this.onChunkArrived(c);
		// §3.C.1 precondition: the full 3×3 exists (generated + lit) before a chunk is shadowed;
		// any neighbour created here is an arrival and re-dirties ITS 3×3 (live for edits / re-entry).
		this.ensureNeighbourhood(c);
		// Seed liquid once per chunk object, after the 3×3 exists (border cells read their neighbours; reading
		// before would generate them without arrival bookkeeping). Only cells that can act are added (seedArrival).
		if (c.hasLiquid && !this.liquidSeeded.has(c)) {
			this.liquidSeeded.add(c);
			if (c.liquidFrontier.size === 0) this.scheduler.seedArrival(c);
		}
		return c;
	}

	/**
	 * Streaming mount through the worker (spec §3.D). Returns false when the worker is full: the
	 * chunk stays in the stream set and planFrame stops generating halos this frame.
	 */
	private mountStream(i: number): boolean {
		const c = this.prepareChunk(i);
		// A shadowOnly re-dirty of a mounted chunk: the sync compare decides whether a re-mesh is due
		// (≈ 0.7 ms); only a changed sunlit goes to the worker.
		if (this.shadowOnly.has(i) && c.shadowsDirty && !this.reshadow(c)) return true;
		// Shadow the axis neighbours first: the worker computes only the CENTRE's sunlit and samples
		// the neighbours' at border corners — all-zero neighbour sunlit gives every edge a dark seam.
		for (const n of axisNeighbours(this.world, c)) if (n && n.shadowsDirty) computeChunkShadows(this.world, n);
		if (this.jobs!.post(this.world, c)) {
			this.inFlightIndex.add(i);
			this.streamSet.delete(i);
			this.shadowOnly.delete(i);
			return true;
		}
		this.refusedIndex = i;
		return false;
	}

	/** Ensures, shadows and meshes one chunk on the main thread (edits; every chunk when there is no worker). */
	private mountSync(i: number): void {
		const c = this.prepareChunk(i);
		if (c.shadowsDirty && !this.reshadow(c)) return; // shadows unchanged: no re-mesh
		this.shadowOnly.delete(i);
		// Neighbors may have received shadow changes from edits near chunk boundaries; recompute if
		// dirty. A shadowOnly neighbour whose hash is unchanged leaves the stream lane here.
		for (const n of Object.values(this.world.neighbors(c))) {
			if (n && n.shadowsDirty) this.reshadow(n);
		}
		const result = meshChunk(c, this.world.neighbors(c), this.uvFor);
		this.renderer.mountChunkMesh(c, result);
		this.mountedChunks.add(i);
	}

	/**
	 * Crafting spec §7: a bulk chunk is posted to the worker — false when the worker is full: it waits for the next frame and
	 * never falls back to a synchronous mesh — or, without a worker, meshed here (planFrame caps that at one per frame).
	 * It re-meshes whatever its sunlit does, so it drops any shadowOnly flag first (the sunlitHash skip is for shadow-only
	 * work; a dark blast leaves the hash unchanged).
	 */
	private mountBulk(i: number): boolean {
		this.shadowOnly.delete(i);
		if (!this.jobs) {
			this.mountSync(i);
			this.bulkLane.delete(i);
			return true;
		}
		if (this.mountStream(i)) return true;
		this.refusedIndex = -1; // mountStream's marker is for the stream lane's bookkeeping
		return false;
	}

	/** Spec §3.B: edit lane first (budget-exempt, suppresses streaming), then the bulk lane (crafting spec §7), then nearest-first streaming under the adaptive budget. */
	private flushDirtyChunks() {
		if (this.editLane.size > 0 || this.bulkLane.size > 0 || this.streamSet.size > 0) {
			const pcx = Math.floor(this.player.position[0] / 16);
			const pcz = Math.floor(this.player.position[2] / 16);
			// A posted-but-unreplied chunk would be nearest again next frame and get posted twice.
			let stream = this.streamSet;
			if (this.inFlightIndex.size > 0) {
				stream = new Set<number>();
				for (const i of this.streamSet) if (!this.inFlightIndex.has(i)) stream.add(i);
			}
			// Bulk chunks stay in the lane while their job is in flight; skip them, as the stream set does.
			const bulk = new Set<number>();
			for (const i of this.bulkLane) if (!this.inFlightIndex.has(i)) bulk.add(i);
			this.refusedIndex = -1;
			this.frameDeadline = performance.now() + budgetFor(this.moving, this.initialLoad);
			let editWorkMs = 0;
			const r = planFrame(
				{
					editLane: this.editLane,
					bulk,
					bulkMax: this.jobs ? Infinity : 1,
					stream,
					playerCx: pcx,
					playerCz: pcz,
					moving: this.moving,
					initialLoad: this.initialLoad,
				},
				() => performance.now(),
				(i, lane) => {
					if (lane === 'bulk') return this.mountBulk(i);
					// Streaming only: generate the missing 3×3 a few chunks per frame (edits stay immediate).
					if (lane === 'stream' && !this.generatePaced(i)) {
						this.refusedIndex = i;
						return false;
					}
					if (this.jobs && lane === 'stream') return this.mountStream(i);
					if (lane === 'stream') return this.mountSync(i);
					const w0 = performance.now();
					const ok = this.mountSync(i);
					editWorkMs += performance.now() - w0;
					return ok;
				},
			);
			for (const i of r.edits) {
				this.editLane.delete(i);
				this.streamSet.delete(i);
				// Meshed just now; an in-flight bulk job for it stays owed (its reply is stale and re-queues it).
				if (!this.inFlightIndex.has(i)) this.bulkLane.delete(i);
			}
			for (const i of r.mounts) if (i !== this.refusedIndex) this.streamSet.delete(i);
			if (r.edits.length > 0) {
				this.stats.lastEditMs = performance.now() - this.editStartedAt;
				this.stats.lastEditWorkMs = editWorkMs;
				this.editStartedAt = 0;
			}
		}
		if (this.initialLoad && this.streamSet.size === 0 && this.inFlightIndex.size === 0) this.initialLoad = false;
		this.stats.streamQueue = this.streamSet.size;
		this.stats.workerInFlight = this.jobs ? this.jobs.inFlight() : 0;
		this.stats.editQueue = this.editLane.size;
		this.stats.bulkQueue = this.bulkLane.size;
		this.stats.mounted = this.mountedChunks.size;
	}
}

export type { Keys };
