import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DualAdapter } from './dual';
import { LocalStorageAdapter } from './localStorage';
import { CloudAdapter, CloudError } from './cloud';
import type { WorldSave } from './adapter';
import { BLOCKS_PER_CHUNK } from '../engine/world/coords';
import { legacyId } from './uuid';

const ID = '11111111-1111-4111-8111-111111111111';

class MemStorage {
	private store = new Map<string, string>();
	getItem(k: string) {
		return this.store.get(k) ?? null;
	}
	setItem(k: string, v: string) {
		this.store.set(k, v);
	}
	removeItem(k: string) {
		this.store.delete(k);
	}
	key(i: number) {
		return [...this.store.keys()][i] ?? null;
	}
	get length() {
		return this.store.size;
	}
}

function save(over: Partial<WorldSave> = {}): WorldSave {
	const blocks = new Uint8Array(BLOCKS_PER_CHUNK);
	blocks[0] = 3;
	return {
		version: 2,
		id: ID,
		seed: 1,
		name: 'Castle',
		createdAt: 1000,
		updatedAt: 2000,
		player: { x: 0, y: 60, z: 0, yaw: 0, pitch: 0, hotbar: [1], selected: 0 },
		chunks: [{ cx: 0, cz: 0, blocks }],
		...over,
	};
}

/** A CloudAdapter with every network method stubbed. */
function fakeCloud(over: Partial<CloudAdapter> = {}): CloudAdapter {
	const base = {
		loadWorld: async () => null,
		saveWorld: async () => ({ local: 'ok', cloud: 'ok' }) as const,
		listWorlds: async () => [],
		deleteWorld: async () => {},
		markUnsynced: () => {},
		generationFor: () => undefined,
		encode: (s: WorldSave) => new LocalStorageAdapter(new MemStorage() as unknown as Storage).encode(s),
	};
	return { ...base, ...over } as unknown as CloudAdapter;
}

describe('DualAdapter independent legs', () => {
	let storage: MemStorage;
	let local: LocalStorageAdapter;

	beforeEach(() => {
		storage = new MemStorage();
		local = new LocalStorageAdapter(storage as unknown as Storage);
	});

	it('still writes locally when the cloud leg fails', async () => {
		const cloud = fakeCloud({
			saveWorld: async () => {
				throw new CloudError('NETWORK');
			},
		});
		const dual = new DualAdapter(local, cloud);

		const r = await dual.saveWorld(save());
		expect(r).toEqual({ local: 'ok', cloud: 'failed' });
		expect(await local.loadWorld(ID)).not.toBeNull();
		expect(dual.takeNeedsUpload()).toContain(ID);
	});

	it('still writes to the cloud when localStorage is full', async () => {
		// The leg with unlimited room must not be gated behind the one that is full.
		let cloudSaves = 0;
		const cloud = fakeCloud({
			saveWorld: async () => {
				cloudSaves++;
				return { local: 'ok', cloud: 'ok' } as const;
			},
		});
		vi.spyOn(local, 'saveLocalSync').mockImplementation(() => {
			throw new Error('QUOTA_EXCEEDED');
		});
		const dual = new DualAdapter(local, cloud);

		const r = await dual.saveWorld(save());
		expect(r).toEqual({ local: 'quota', cloud: 'ok' });
		expect(cloudSaves).toBe(1);
	});

	it('skips the cloud leg for a legacy world', async () => {
		let cloudSaves = 0;
		const cloud = fakeCloud({
			saveWorld: async () => {
				cloudSaves++;
				return { local: 'ok', cloud: 'ok' } as const;
			},
		});
		const dual = new DualAdapter(local, cloud);

		// A legacy id would fail the server's uuid check on every autosave.
		const r = await dual.saveWorld(save({ id: legacyId(42) })).catch((e) => e as Error);
		expect(cloudSaves).toBe(0);
		expect((r as SaveResultLike).cloud ?? 'skipped').toBe('skipped');
	});

	it('encodes chunks once for both legs', async () => {
		const seen: unknown[] = [];
		const cloud = fakeCloud({
			saveWorld: async (_s: WorldSave, pre?: unknown) => {
				seen.push(pre);
				return { local: 'ok', cloud: 'ok' } as const;
			},
		});
		const dual = new DualAdapter(local, cloud);
		const spy = vi.spyOn(local, 'encode');

		await dual.saveWorld(save());

		expect(spy).toHaveBeenCalledTimes(1);
		expect(seen[0]).toBeDefined();
	});
});

type SaveResultLike = { cloud?: string };

describe('DualAdapter load arbitration', () => {
	let storage: MemStorage;
	let local: LocalStorageAdapter;

	beforeEach(() => {
		storage = new MemStorage();
		local = new LocalStorageAdapter(storage as unknown as Storage);
	});

	it('falls back to the local copy when the cloud is unreachable', async () => {
		await local.saveWorld(save());
		const cloud = fakeCloud({
			loadWorld: async () => {
				throw new CloudError('NETWORK');
			},
		});
		const dual = new DualAdapter(local, cloud);

		const loaded = await dual.loadWorld(ID);
		expect(loaded).not.toBeNull();
		expect(dual.takeNeedsUpload()).toContain(ID);
	});

	it('falls back to the local copy on a cloud 404', async () => {
		// Not an absence of data: returning null would make the world invisible.
		await local.saveWorld(save());
		const cloud = fakeCloud({ loadWorld: async () => null });
		const dual = new DualAdapter(local, cloud);

		expect(await dual.loadWorld(ID)).not.toBeNull();
	});

	it('does not fork a copy when the local copy is an ancestor of the cloud copy', async () => {
		await local.saveWorld(save({ lastSyncedGeneration: '5' }));
		const cloud = fakeCloud({
			loadWorld: async () => save({ lastSyncedGeneration: '5', name: 'Castle' }),
		});
		const dual = new DualAdapter(local, cloud);

		await dual.loadWorld(ID);

		const list = await local.listWorlds();
		expect(list.filter((w) => w.name.includes('copy from'))).toHaveLength(0);
	});

	it('does not fork after a normal save-then-load cycle', async () => {
		// The realistic flow: save (both legs ok), then load. If the local copy does
		// not record the generation the cloud assigned, every load looks like a
		// divergence and the menu fills with "(copy from this device)" duplicates.
		let gen = 5;
		const cloud = fakeCloud({
			saveWorld: async () => {
				gen++;
				return { local: 'ok', cloud: 'ok' } as const;
			},
			generationFor: () => String(gen),
			loadWorld: async () => save({ lastSyncedGeneration: String(gen) }),
		});
		const dual = new DualAdapter(local, cloud);

		await dual.saveWorld(save());
		await dual.loadWorld(ID);

		const forks = (await local.listWorlds()).filter((w) => w.name.includes('copy from'));
		expect(forks).toHaveLength(0);
	});

	it('keeps both copies exactly once when they genuinely diverge', async () => {
		await local.saveWorld(save({ lastSyncedGeneration: '5', name: 'Castle' }));
		const cloud = fakeCloud({
			loadWorld: async () => save({ lastSyncedGeneration: '9', name: 'Castle' }),
		});
		const dual = new DualAdapter(local, cloud);

		await dual.loadWorld(ID);

		const forks = (await local.listWorlds()).filter((w) => w.name.includes('copy from'));
		expect(forks).toHaveLength(1);
		expect(forks[0].id).not.toBe(ID);
	});

	it('preserves the diverged local chunks in the fork', async () => {
		const distinctive = new Uint8Array(BLOCKS_PER_CHUNK);
		distinctive.fill(11);
		await local.saveWorld(
			save({ lastSyncedGeneration: '5', chunks: [{ cx: 0, cz: 0, blocks: distinctive }] }),
		);
		const cloud = fakeCloud({ loadWorld: async () => save({ lastSyncedGeneration: '9' }) });
		const dual = new DualAdapter(local, cloud);

		await dual.loadWorld(ID);

		const fork = (await local.listWorlds()).find((w) => w.name.includes('copy from'))!;
		const forked = await local.loadWorld(fork.id);
		expect(forked!.chunks[0].blocks[0]).toBe(11);
	});
});

describe('DualAdapter list and delete', () => {
	let storage: MemStorage;
	let local: LocalStorageAdapter;

	beforeEach(() => {
		storage = new MemStorage();
		local = new LocalStorageAdapter(storage as unknown as Storage);
	});

	it('lists a world present in both sources exactly once', async () => {
		await local.saveWorld(save());
		const cloud = fakeCloud({
			listWorlds: async () => [
				{
					id: ID,
					seed: 1,
					name: 'Castle',
					createdAt: 1000,
					updatedAt: 3000,
					origin: 'cloud' as const,
				},
			],
		});
		const dual = new DualAdapter(local, cloud);

		const list = await dual.listWorlds();
		expect(list.filter((w) => w.id === ID)).toHaveLength(1);
		expect(list.find((w) => w.id === ID)!.origin).toBe('cloud');
	});

	it('falls back to the local list when the cloud list fails', async () => {
		await local.saveWorld(save());
		const cloud = fakeCloud({
			listWorlds: async () => {
				throw new CloudError('NETWORK');
			},
		});
		const dual = new DualAdapter(local, cloud);

		const list = await dual.listWorlds();
		expect(list).toHaveLength(1);
		expect(list[0].origin).toBe('local');
	});

	it('reports that the cloud list failed rather than silently returning fewer worlds', async () => {
		// An empty menu with no warning reads as "my worlds are gone" to a seven-year-
		// old, which is the most alarming possible outcome for a purely transient
		// network error.
		const cloud = fakeCloud({
			listWorlds: async () => {
				throw new CloudError('NETWORK');
			},
		});
		const dual = new DualAdapter(local, cloud);

		expect(dual.cloudListFailed).toBe(false);
		await dual.listWorlds();
		expect(dual.cloudListFailed).toBe(true);
	});

	it('clears the failed flag once the cloud list succeeds again', async () => {
		let fail = true;
		const cloud = fakeCloud({
			listWorlds: async () => {
				if (fail) throw new CloudError('NETWORK');
				return [];
			},
		});
		const dual = new DualAdapter(local, cloud);

		await dual.listWorlds();
		expect(dual.cloudListFailed).toBe(true);
		fail = false;
		await dual.listWorlds();
		expect(dual.cloudListFailed).toBe(false);
	});

	it('does not delete locally when the cloud delete fails', async () => {
		await local.saveWorld(save());
		const cloud = fakeCloud({
			deleteWorld: async () => {
				throw new CloudError('NETWORK');
			},
		});
		const dual = new DualAdapter(local, cloud);

		await expect(dual.deleteWorld(ID)).rejects.toThrow();
		expect(await local.loadWorld(ID)).not.toBeNull();
	});
});
