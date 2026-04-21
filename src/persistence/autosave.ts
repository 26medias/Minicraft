import type { PersistenceAdapter, PlayerSave, WorldSave } from './adapter';
import type { World } from '../engine/world/world';

const DEBOUNCE_MS = 5000;

export class AutoSave {
	private dirty = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private quotaHit = false;
	private name: string;
	private createdAt: number;

	constructor(
		private adapter: PersistenceAdapter,
		private world: World,
		private getPlayer: () => PlayerSave,
		meta: { name: string; createdAt: number },
		public onQuotaExceeded: () => void = () => {},
	) {
		this.name = meta.name;
		this.createdAt = meta.createdAt;

		window.addEventListener('blur', () => void this.flush());
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'hidden') void this.flush();
		});
	}

	markDirty() {
		if (this.quotaHit) return;
		this.dirty = true;
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.flush();
		}, DEBOUNCE_MS);
	}

	async flush(): Promise<void> {
		if (!this.dirty || this.quotaHit) return;
		this.dirty = false;
		const save: WorldSave = {
			version: 1,
			seed: this.world.seed,
			name: this.name,
			createdAt: this.createdAt,
			updatedAt: Date.now(),
			player: this.getPlayer(),
			chunks: this.world
				.modifiedChunks()
				.map((c) => ({ cx: c.cx, cz: c.cz, blocks: c.blocks })),
		};
		try {
			await this.adapter.saveWorld(save);
		} catch (err) {
			if ((err as Error).message === 'QUOTA_EXCEEDED') {
				this.quotaHit = true;
				this.onQuotaExceeded();
				return;
			}
			throw err;
		}
	}
}
