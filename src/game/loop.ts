import type { World } from '../engine/world/world';
import type { FpCamera } from '../engine/render/camera';
import type { Renderer } from '../engine/render/renderer';
import type { Player, Keys } from './player';
import { meshChunk, type UvFn } from '../engine/world/mesher';
import { raycastVoxel } from '../engine/input/raycast';
import { AIR, BLOCKS, isSolid, type BlockId } from '../data/blocks.data';
import type { ParticleSystem } from '../engine/render/particles';

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

	onBlockBroken: ((ev: BlockBrokenEvent) => void) | null = null;
	onMiningProgress: ((progress: number) => void) | null = null;

	constructor(
		private world: World,
		private renderer: Renderer,
		private cam: FpCamera,
		private player: Player,
		private keys: Keys,
		private uvFor: UvFn,
		private particles: ParticleSystem | null = null,
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
		this.particles?.tick(dt);
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
			this.world.setBlock(target.x, target.y, target.z, AIR);
			this.markChunkDirtyAround(target.x, target.z);
			this.particles?.spawnBreak(target.x, target.y, target.z, blockId);
			this.onBlockBroken?.({ x: target.x, y: target.y, z: target.z, blockId });
		}
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
