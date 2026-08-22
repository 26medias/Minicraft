import type {
	EncodedChunk,
	PersistenceAdapter,
	SaveResult,
	WorldSave,
	WorldSummary,
} from './adapter';
import type { LocalStorageAdapter } from './localStorage';
import type { CloudAdapter } from './cloud';
import { isLegacyId, newWorldId } from './uuid';

/**
 * Composes the local and cloud adapters. Two rules govern everything here:
 *
 *  1. The legs are independent. Either may fail without preventing the other.
 *  2. No code path discards a copy that has edits the other lacks. When two
 *     copies diverge, both survive and the user sees both.
 */
export class DualAdapter implements PersistenceAdapter {
	/** Worlds whose local copy is ahead of the cloud and needs uploading. */
	private needsUpload = new Set<string>();

	constructor(
		private local: LocalStorageAdapter,
		private cloud: CloudAdapter | null,
	) {}

	get hasCloud(): boolean {
		return this.cloud !== null;
	}

	markNeedsUpload(id: string): void {
		this.needsUpload.add(id);
	}

	takeNeedsUpload(): string[] {
		return [...this.needsUpload];
	}

	encode(save: WorldSave): EncodedChunk[] {
		return this.local.encode(save);
	}

	saveLocalSync(save: WorldSave, pre?: EncodedChunk[]): void {
		this.local.saveLocalSync(save, pre);
	}

	async saveWorld(save: WorldSave, pre?: EncodedChunk[]): Promise<SaveResult> {
		// Encode once and share: each adapter would otherwise encode the whole world
		// again, which measures ~137ms per pass for a full world on desktop.
		const encoded = pre ?? this.encode(save);

		let localOutcome: SaveResult['local'] = 'ok';
		try {
			this.local.saveLocalSync(save, encoded);
		} catch (err) {
			localOutcome = (err as Error).message === 'QUOTA_EXCEEDED' ? 'quota' : 'error';
		}

		// A legacy world has no uuid yet, so the server would reject its id. It is
		// local-only until the explicit upload mints one.
		if (!this.cloud || isLegacyId(save.id)) {
			return { local: localOutcome, cloud: 'skipped' };
		}

		try {
			await this.cloud.saveWorld(save, encoded);
			this.needsUpload.delete(save.id);
			return { local: localOutcome, cloud: 'ok' };
		} catch {
			this.needsUpload.add(save.id);
			return { local: localOutcome, cloud: 'failed' };
		}
	}

	async loadWorld(id: string): Promise<WorldSave | null> {
		const localCopy = await this.local.loadWorld(id);

		if (!this.cloud || isLegacyId(id)) return localCopy;

		let cloudCopy: WorldSave | null = null;
		try {
			cloudCopy = await this.cloud.loadWorld(id);
		} catch {
			// Offline. The local copy is authoritative for this session, and its first
			// save must not adopt a generation it never saw.
			if (localCopy) {
				this.cloud.markUnsynced(id);
				this.needsUpload.add(id);
			}
			return localCopy;
		}

		if (!cloudCopy) {
			// A 404 with a local copy present is not an absence of data. Returning null
			// would make the world invisible and the kid would build a new one.
			if (localCopy) {
				this.cloud.markUnsynced(id);
				this.needsUpload.add(id);
			}
			return localCopy;
		}

		if (!localCopy) return cloudCopy;

		const ancestor =
			localCopy.lastSyncedGeneration != null &&
			cloudCopy.lastSyncedGeneration != null &&
			localCopy.lastSyncedGeneration === cloudCopy.lastSyncedGeneration;

		if (ancestor) return cloudCopy;

		// Diverged. Preserve the local copy as its own visible world before loading
		// the cloud one, so neither side is lost and the kid can open both.
		await this.forkLocalCopy(localCopy);
		return cloudCopy;
	}

	private async forkLocalCopy(localCopy: WorldSave): Promise<void> {
		const forkId = newWorldId();
		const fork: WorldSave = {
			...localCopy,
			id: forkId,
			name: `${localCopy.name} (copy from this device)`,
			lastSyncedGeneration: null,
		};
		const encoded = this.encode(fork);
		try {
			this.local.saveLocalSync(fork, encoded);
		} catch {
			// A full local store must not stop the cloud copy of the fork.
		}
		try {
			await this.cloud?.saveWorld(fork, encoded);
		} catch {
			this.needsUpload.add(forkId);
		}
	}

	async listWorlds(): Promise<WorldSummary[]> {
		const localList = await this.local.listWorlds();
		if (!this.cloud) return localList;

		let cloudList: WorldSummary[] = [];
		try {
			cloudList = await this.cloud.listWorlds();
		} catch {
			return localList.map((w) => ({ ...w, origin: 'local' as const }));
		}

		const byId = new Map<string, WorldSummary>();
		for (const w of localList) byId.set(w.id, w);
		// A world present in both is one world, listed as cloud.
		for (const w of cloudList) byId.set(w.id, { ...w, origin: 'cloud' });

		return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async deleteWorld(id: string): Promise<void> {
		// Cloud first: if that fails, both copies stay. A cloud delete is recoverable
		// from a noncurrent version, an unmatched local delete is not.
		if (this.cloud && !isLegacyId(id)) {
			await this.cloud.deleteWorld(id);
		}
		await this.local.deleteWorld(id);
		this.needsUpload.delete(id);
	}
}
