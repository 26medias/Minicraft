import type { LightSave, PersistenceAdapter, PlayerSave, WorldSave } from './adapter';
import type { World } from '../engine/world/world';

const DEBOUNCE_MS = 5000;

export class AutoSave {
	private dirty = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private dirtySeq = 0;
	private inFlight: Promise<void> | null = null;
	private name: string;
	private createdAt: number;

	constructor(
		private adapter: PersistenceAdapter,
		private world: World,
		private getPlayer: () => PlayerSave,
		meta: { name: string; createdAt: number },
		public onQuotaExceeded: () => void = () => {},
		private getLights: () => LightSave[] = () => [],
	) {
		this.name = meta.name;
		this.createdAt = meta.createdAt;

		window.addEventListener('blur', () => void this.flush());
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'hidden') void this.flush();
		});
	}

	markDirty() {
		this.dirty = true;
		this.dirtySeq++;
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.flush();
		}, DEBOUNCE_MS);
	}

	async flush(): Promise<void> {
		if (!this.dirty) return;
		// Serialize saves: two concurrent writes of the whole world can interleave and
		// leave storage holding a mix of both.
		if (this.inFlight) {
			await this.inFlight.catch(() => {});
			if (!this.dirty) return;
		}
		const run = this.doSave();
		this.inFlight = run;
		try {
			await run;
		} finally {
			if (this.inFlight === run) this.inFlight = null;
		}
	}

	private async doSave(): Promise<void> {
		// Capture the edit counter alongside the snapshot: an edit made while this save
		// is in flight is not in the snapshot, so its dirty flag must survive.
		const seq = this.dirtySeq;
		const save: WorldSave = {
			version: 1,
			seed: this.world.seed,
			name: this.name,
			createdAt: this.createdAt,
			updatedAt: Date.now(),
			player: this.getPlayer(),
			chunks: this.world.modifiedChunks().map((c) => ({
				cx: c.cx,
				cz: c.cz,
				blocks: c.blocks,
				fluidMeta: c.fluidMeta.size > 0 ? new Map(c.fluidMeta) : undefined,
			})),
			lights: this.getLights(),
		};
		try {
			await this.adapter.saveWorld(save);
			if (this.dirtySeq === seq) this.dirty = false;
		} catch (err) {
			if ((err as Error).message === 'QUOTA_EXCEEDED') {
				this.onQuotaExceeded();
				return;
			}
			throw err;
		}
	}
}
