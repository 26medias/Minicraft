import type { World } from '../engine/world/world';
import type { FpCamera } from '../engine/render/camera';
import type { Renderer } from '../engine/render/renderer';
import type { Player, Keys } from './player';
import { meshChunk, type UvFn } from '../engine/world/mesher';
import { computeChunkShadows } from '../engine/world/shadows';
import { raycastVoxel, type VoxelHit } from '../engine/input/raycast';
import { AIR, BLOCKS, BLOCK_BY_NAME, isSolid, isLiquid, type BlockId } from '../data/blocks.data';
import type { ParticleSystem } from '../engine/render/particles';
import type { PrimedOverlay } from '../engine/render/primed-overlay';
import type { LightRegistry } from '../engine/render/light-registry';
import type { FaceHighlight } from '../engine/render/face-highlight';
import { canReplace, igniteTnt, type PrimedEntry } from './actions';
import { detonate, tntKey, TNT_CHAIN_FUSE, TNT_PRIME_FUSE } from './tnt';
import { updateLightsForBlockChange } from '../engine/world/lighting';
import { LiquidScheduler } from './liquid-scheduler';

const LAMP_ID = BLOCK_BY_NAME['lamp'].id;

const VIEW_RADIUS = 4; // chunks loaded around the player
const REACH = 6;

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

export class GameLoop {
	private dirtyChunks = new Set<string>();
	private mountedChunks = new Set<string>();
	private mining: MiningState | null = null;
	private aim: VoxelHit | null = null;
	private leftMouseDown = false;
	private primedTnt = new Map<string, PrimedEntry>();
	private scheduler: LiquidScheduler;

	onBlockBroken: ((ev: BlockBrokenEvent) => void) | null = null;
	onWorldMutated: (() => void) | null = null;
	onMiningProgress: ((progress: number) => void) | null = null;
	onFlyStateChange: ((tier: number | null) => void) | null = null;

	/**
	 * Set by the play-time limit. While true, tick() only syncs the camera and
	 * keeps loading/meshing chunks: no physics, mining, particles, or simulation.
	 * Chunks keep loading so a world opened straight into a break is not empty sky.
	 */
	paused = false;

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
	) {
		this.scheduler = new LiquidScheduler(
			this.world,
			(cx, cz) => this.markChunkDirty(cx, cz),
			(x, y, z) => this.applyLightUpdate(x, y, z),
		);
	}

	markChunkDirty(cx: number, cz: number) {
		this.dirtyChunks.add(`${cx},${cz}`);
	}

	applyLightUpdate(x: number, y: number, z: number): void {
		const getLampColor = (lx: number, ly: number, lz: number): string | null =>
			this.lights?.getColor(lx, ly, lz) ?? null;
		const touched = updateLightsForBlockChange(this.world, x, y, z, getLampColor);
		for (const c of touched) {
			this.markChunkDirty(c.cx, c.cz);
			c.shadowsDirty = true;
		}
		// Also flag chunks in the shadow direction (SE of the edit) since a placed/removed
		// block can shadow further SE.
		const edited = this.world.getChunk(Math.floor(x / 16), Math.floor(z / 16));
		if (edited) {
			edited.shadowsDirty = true;
			const seNeighbors = [
				this.world.getChunk(edited.cx + 1, edited.cz),
				this.world.getChunk(edited.cx, edited.cz + 1),
				this.world.getChunk(edited.cx + 1, edited.cz + 1),
			];
			for (const n of seNeighbors) {
				if (n) {
					n.shadowsDirty = true;
					this.markChunkDirty(n.cx, n.cz);
				}
			}
		}
	}

	/** Mark the chunk containing a world block + any neighbor chunks if the block sits on a chunk edge. */
	markChunkDirtyAround(wx: number, wz: number) {
		const cx = Math.floor(wx / 16);
		const cz = Math.floor(wz / 16);
		this.markChunkDirty(cx, cz);
		const lx = wx - cx * 16,
			lz = wz - cz * 16;
		if (lx === 0) this.markChunkDirty(cx - 1, cz);
		if (lx === 15) this.markChunkDirty(cx + 1, cz);
		if (lz === 0) this.markChunkDirty(cx, cz - 1);
		if (lz === 15) this.markChunkDirty(cx, cz + 1);
	}

	setLeftMouseDown(down: boolean) {
		// A press is ignored while paused; a release is always honoured so a
		// freeze can clear in-progress mining.
		if (down && this.paused) return;
		this.leftMouseDown = down;
		if (!down) this.mining = null;
	}

	/** 0..1 if mining in progress, 0 otherwise. Consumed by the HUD to draw the progress ring. */
	miningProgress(): number {
		return this.mining ? Math.min(1, this.mining.elapsed / this.mining.duration) : 0;
	}

	/** Called from main.ts on 'ignite' keydown. Returns true if a TNT was newly primed. */
	ignite(hit: VoxelHit): boolean {
		const ok = igniteTnt(this.world, hit, this.primedTnt, TNT_PRIME_FUSE);
		if (ok) this.overlay?.add(hit.x, hit.y, hit.z);
		return ok;
	}

	/**
	 * Everything that must happen when the block at (x,y,z) stops existing:
	 * a primed TNT loses its fuse, a lamp loses its light, and break particles
	 * spawn. Shared by mining completion and shift-to-replace. Call before the
	 * world write.
	 */
	private clearBlockEffects(x: number, y: number, z: number, oldId: BlockId): void {
		const k = tntKey(x, y, z);
		if (this.primedTnt.delete(k)) this.overlay?.remove(x, y, z);
		if (oldId === LAMP_ID) this.lights?.remove(x, y, z);
		this.particles?.spawnBreak(x, y, z, oldId);
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

	start() {
		this.renderer.onTick((dt) => this.tick(dt));
	}

	private tick(dt: number) {
		if (this.paused) {
			this.cam.sync(this.renderer.camera);
			this.loadNearbyChunks();
			this.flushDirtyChunks();
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
		if (this.aim) this.highlight?.show(this.aim.x, this.aim.y, this.aim.z, this.aim.face);
		else this.highlight?.hide();

		this.updateMining(dt);
		this.onMiningProgress?.(this.miningProgress());
		this.onFlyStateChange?.(this.player.flying ? this.player.flySpeedTier : null);
		this.particles?.tick(dt);
		this.simulate(dt);
		this.overlay?.tick(dt);
		this.loadNearbyChunks();
		this.flushDirtyChunks();
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
			this.mining = {
				target: { x: hit.x, y: hit.y, z: hit.z },
				elapsed: 0,
				duration: def.hardness,
				blockId,
			};
			return;
		}

		this.mining.elapsed += dt;
		if (this.mining.elapsed >= this.mining.duration) {
			const { target, blockId } = this.mining;
			this.mining = null;
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
			this.detonateAt(entry.x, entry.y, entry.z);
		}
		return expired.length > 0;
	}

	private detonateAt(ox: number, oy: number, oz: number): void {
		const result = detonate(this.world, ox, oy, oz, (x, y, z) =>
			this.primedTnt.has(tntKey(x, y, z)),
		);
		for (const { x, y, z } of result.destroyed) {
			if (this.world.getBlock(x, y, z) === LAMP_ID) this.lights?.remove(x, y, z);
			this.world.setBlock(x, y, z, AIR);
			this.markChunkDirtyAround(x, z);
			this.applyLightUpdate(x, y, z);
		}
		for (const { x, y, z } of result.primed) {
			this.primedTnt.set(tntKey(x, y, z), { x, y, z, fuse: TNT_CHAIN_FUSE });
			this.overlay?.add(x, y, z);
		}
		this.particles?.spawnBreak(ox, oy, oz, BLOCK_BY_NAME['tnt'].id);
	}

	private loadNearbyChunks() {
		const pcx = Math.floor(this.player.position[0] / 16);
		const pcz = Math.floor(this.player.position[2] / 16);
		for (let dx = -VIEW_RADIUS; dx <= VIEW_RADIUS; dx++) {
			for (let dz = -VIEW_RADIUS; dz <= VIEW_RADIUS; dz++) {
				const cx = pcx + dx,
					cz = pcz + dz;
				if (!this.world.chunkInWorld(cx, cz)) continue;
				const k = `${cx},${cz}`;
				if (this.mountedChunks.has(k)) continue;
				this.dirtyChunks.add(k);
			}
		}
	}

	private flushDirtyChunks() {
		if (this.dirtyChunks.size === 0) return;
		let budget = 2;
		for (const k of this.dirtyChunks) {
			if (budget-- <= 0) break;
			const [cxStr, czStr] = k.split(',');
			const cx = Number(cxStr),
				cz = Number(czStr);
			if (!this.world.chunkInWorld(cx, cz)) {
				this.dirtyChunks.delete(k);
				continue;
			}
			const c = this.world.ensureChunk(cx, cz);
			// Ensure gen-placed liquids are in the frontier for at least one tick's check.
			if (c.liquidFrontier.size === 0) {
				for (let y = 0; y < 64; y++) {
					for (let lz = 0; lz < 16; lz++) {
						for (let lx = 0; lx < 16; lx++) {
							const idx = y * 16 * 16 + lz * 16 + lx;
							if (isLiquid(c.blocks[idx])) c.liquidFrontier.add(idx);
						}
					}
				}
			}
			if (c.shadowsDirty) computeChunkShadows(this.world, c);
			// Neighbors may have received shadow changes from edits near chunk boundaries; recompute if dirty.
			for (const n of Object.values(this.world.neighbors(c))) {
				if (n && n.shadowsDirty) computeChunkShadows(this.world, n);
			}
			const result = meshChunk(c, this.world.neighbors(c), this.uvFor);
			this.renderer.mountChunkMesh(c, result);
			this.mountedChunks.add(k);
			this.dirtyChunks.delete(k);
		}
	}
}

export type { Keys };
