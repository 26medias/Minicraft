import type { World } from '../engine/world/world';
import type { FpCamera } from '../engine/render/camera';
import type { Renderer } from '../engine/render/renderer';
import type { Player, Keys } from './player';
import { meshChunk, type UvFn } from '../engine/world/mesher';
import { raycastVoxel, type VoxelHit } from '../engine/input/raycast';
import { AIR, BLOCKS, BLOCK_BY_NAME, isSolid, type BlockId } from '../data/blocks.data';
import type { ParticleSystem } from '../engine/render/particles';
import type { PrimedOverlay } from '../engine/render/primed-overlay';
import type { LightRegistry } from '../engine/render/light-registry';
import { igniteTnt, type PrimedEntry } from './actions';
import { detonate, tntKey, TNT_CHAIN_FUSE, TNT_PRIME_FUSE } from './tnt';

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
	private leftMouseDown = false;
	private primedTnt = new Map<string, PrimedEntry>();

	onBlockBroken: ((ev: BlockBrokenEvent) => void) | null = null;
	onMiningProgress: ((progress: number) => void) | null = null;
	onFlyStateChange: ((tier: number | null) => void) | null = null;

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
	) {}

	markChunkDirty(cx: number, cz: number) {
		this.dirtyChunks.add(`${cx},${cz}`);
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

	start() {
		this.renderer.onTick((dt) => this.tick(dt));
	}

	private tick(dt: number) {
		const fwd = this.cam.getForward();
		const right = this.cam.getRight();
		this.player.update(dt, this.world, this.keys, fwd, right);
		const eye = this.player.eyePosition();
		this.cam.position.set(eye[0], eye[1], eye[2]);
		this.cam.sync(this.renderer.camera);

		this.updateMining(dt);
		this.onMiningProgress?.(this.miningProgress());
		this.onFlyStateChange?.(this.player.flying ? this.player.flySpeedTier : null);
		this.particles?.tick(dt);
		this.updatePrimedTnt(dt);
		this.overlay?.tick(dt);
		this.loadNearbyChunks();
		this.flushDirtyChunks();
	}

	private updateMining(dt: number) {
		if (!this.leftMouseDown) {
			this.mining = null;
			return;
		}

		const eye = this.player.eyePosition();
		const dir = this.cam.getLookDir();
		const hit = raycastVoxel(this.world, eye, [dir.x, dir.y, dir.z], REACH);
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
			// If the block was a primed TNT, cancel its fuse.
			const k = tntKey(target.x, target.y, target.z);
			if (this.primedTnt.delete(k)) this.overlay?.remove(target.x, target.y, target.z);
			if (blockId === LAMP_ID) this.lights?.remove(target.x, target.y, target.z);
			this.world.setBlock(target.x, target.y, target.z, AIR);
			this.markChunkDirtyAround(target.x, target.z);
			this.particles?.spawnBreak(target.x, target.y, target.z, blockId);
			this.onBlockBroken?.({ x: target.x, y: target.y, z: target.z, blockId });
		}
	}

	private updatePrimedTnt(dt: number): void {
		if (this.primedTnt.size === 0) return;
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
	}

	private detonateAt(ox: number, oy: number, oz: number): void {
		const result = detonate(this.world, ox, oy, oz, (x, y, z) =>
			this.primedTnt.has(tntKey(x, y, z)),
		);
		for (const { x, y, z } of result.destroyed) {
			if (this.world.getBlock(x, y, z) === LAMP_ID) this.lights?.remove(x, y, z);
			this.world.setBlock(x, y, z, AIR);
			this.markChunkDirtyAround(x, z);
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
			const mesh = meshChunk(c, this.world.neighbors(c), this.uvFor);
			this.renderer.mountChunkMesh(c, mesh);
			this.mountedChunks.add(k);
			this.dirtyChunks.delete(k);
		}
	}
}

export type { Keys };
