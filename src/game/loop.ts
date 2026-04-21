import type { World } from '../engine/world/world';
import type { FpCamera } from '../engine/render/camera';
import type { Renderer } from '../engine/render/renderer';
import type { Player, Keys } from './player';
import { meshChunk, type UvFn } from '../engine/world/mesher';

const VIEW_RADIUS = 4; // chunks loaded around the player

export class GameLoop {
	private dirtyChunks = new Set<string>();
	private mountedChunks = new Set<string>();

	constructor(
		private world: World,
		private renderer: Renderer,
		private cam: FpCamera,
		private player: Player,
		private keys: Keys,
		private uvFor: UvFn,
	) {}

	markChunkDirty(cx: number, cz: number) {
		this.dirtyChunks.add(`${cx},${cz}`);
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

		this.loadNearbyChunks();
		this.flushDirtyChunks();
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
