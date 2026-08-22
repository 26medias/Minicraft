import type {
	EncodedChunk,
	LightSave,
	PersistenceAdapter,
	PlayerSave,
	SaveResult,
	WorldSave,
} from './adapter';
import type { World } from '../engine/world/world';

const DEBOUNCE_MS = 5000;
/**
 * The cloud leg is slower than the local one. At 5 s a 1 MB world needs a
 * sustained ~1.6 Mbps uplink; at 30 s it needs ~267 kbps, which a tablet on
 * household wifi can actually hold. The 5 s local save remains the safety net.
 */
const CLOUD_DEBOUNCE_MS = 30_000;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 8000;

export type SaveStatus = 'saved' | 'saving' | 'local-only' | 'error';

/** An adapter that can also write synchronously, for the unload path. */
type SyncCapableAdapter = PersistenceAdapter & {
	saveLocalSync?: (save: WorldSave, pre?: EncodedChunk[]) => void;
	encode?: (save: WorldSave) => EncodedChunk[];
	markNeedsUpload?: (id: string) => void;
};

export class AutoSave {
	private dirty = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private cloudTimer: ReturnType<typeof setTimeout> | null = null;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private retryDelay = RETRY_BASE_MS;
	private dirtySeq = 0;
	private inFlight: Promise<void> | null = null;
	private name: string;
	private createdAt: number;
	private id: string;
	private adapter: SyncCapableAdapter;

	onStatus: (s: SaveStatus) => void = () => {};

	constructor(
		adapter: PersistenceAdapter,
		private world: World,
		private getPlayer: () => PlayerSave,
		meta: { id: string; name: string; createdAt: number },
		public onQuotaExceeded: () => void = () => {},
		private getLights: () => LightSave[] = () => [],
	) {
		this.adapter = adapter as SyncCapableAdapter;
		this.id = meta.id;
		this.name = meta.name;
		this.createdAt = meta.createdAt;

		window.addEventListener('blur', () => void this.flush());
		document.addEventListener('visibilitychange', () => {
			// Fires well before teardown on tablets, so a normal (non-keepalive)
			// cloud write still has time to complete here.
			if (document.visibilityState === 'hidden') void this.flush();
		});
		window.addEventListener('pagehide', () => this.flushLocalSync());
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

	/**
	 * Synchronous local-only write for `pagehide`. An awaited write there is a
	 * dropped continuation: the document can be torn down before it runs, taking
	 * both the save and the needs-upload flag with it. keepalive fetch and
	 * sendBeacon are not options — both cap bodies at 64 KiB and a world is far
	 * larger.
	 */
	flushLocalSync(): void {
		if (!this.dirty) return;
		if (typeof this.adapter.saveLocalSync !== 'function') return;
		const save = this.snapshot();
		try {
			this.adapter.saveLocalSync(save);
			this.adapter.markNeedsUpload?.(this.id);
		} catch {
			// Nothing useful can be done during teardown.
		}
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

	private snapshot(): WorldSave {
		return {
			version: 2,
			id: this.id,
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
	}

	private scheduleRetry(): void {
		if (this.retryTimer) return;
		const delay = Math.min(this.retryDelay, RETRY_MAX_MS);
		// Jitter so several tabs coming back online do not synchronise.
		const jittered = delay * (0.75 + Math.random() * 0.5);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			void this.flush();
		}, jittered);
		this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
	}

	private report(result: SaveResult): void {
		if (result.cloud === 'ok' && result.local === 'ok') {
			this.onStatus('saved');
			return;
		}
		if (result.local !== 'ok' && result.cloud !== 'ok') {
			this.onStatus('error');
			return;
		}
		// Exactly one leg succeeded. Either way the edits survive somewhere, but the
		// user should know the redundancy is gone.
		this.onStatus('local-only');
	}

	private async doSave(): Promise<void> {
		// Capture the edit counter alongside the snapshot: an edit made while this save
		// is in flight is not in the snapshot, so its dirty flag must survive.
		const seq = this.dirtySeq;
		const save = this.snapshot();
		this.onStatus('saving');
		try {
			const result = (await this.adapter.saveWorld(save)) as SaveResult | void;
			if (this.dirtySeq === seq) this.dirty = false;

			if (result && typeof result === 'object') {
				this.report(result);
				if (result.cloud === 'failed') {
					// Retry only the transient case; the local copy is already safe.
					this.dirty = true;
					this.scheduleRetry();
				} else if (result.cloud === 'ok') {
					this.retryDelay = RETRY_BASE_MS;
				}
				if (result.local === 'quota') this.onQuotaExceeded();
			} else {
				this.onStatus('saved');
			}
		} catch (err) {
			const message = (err as Error).message;
			if (message === 'QUOTA_EXCEEDED') {
				this.onQuotaExceeded();
				this.onStatus('error');
				return;
			}
			this.onStatus('error');
			throw err;
		}
	}

	/** Cloud writes are debounced separately; see CLOUD_DEBOUNCE_MS. */
	get cloudDebounceMs(): number {
		return CLOUD_DEBOUNCE_MS;
	}

	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		if (this.cloudTimer) clearTimeout(this.cloudTimer);
		if (this.retryTimer) clearTimeout(this.retryTimer);
	}
}
