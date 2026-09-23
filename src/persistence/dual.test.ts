import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DualAdapter } from './dual';
import { LocalStorageAdapter } from './localStorage';
import { CloudAdapter, CloudError } from './cloud';
import type { WorldSave } from './adapter';
const BLOCKS_PER_CHUNK = 16 * 64 * 16;
import { legacyId } from './uuid';
import { SaveCorrupt, SaveMismatch } from './errors';

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
	const blocks = new Uint16Array(BLOCKS_PER_CHUNK);
	blocks[0] = 3;
	return {
		version: 2,
		height: 64,
		genVersion: 1,
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

	it('does not fork when the local copy has no generation but identical content', async () => {
		// A missing stamp means "ancestry unknown", NOT "diverged". Treating it as
		// divergence forked a copy on every single load.
		await local.saveWorld(save({ lastSyncedGeneration: null }));
		const cloud = fakeCloud({ loadWorld: async () => save({ lastSyncedGeneration: '9' }) });
		const dual = new DualAdapter(local, cloud);

		await dual.loadWorld(ID);

		const forks = (await local.listWorlds()).filter((w) => w.name.includes('copy from'));
		expect(forks).toHaveLength(0);
	});

	it('does not fork the same world repeatedly across loads', async () => {
		// The exponential case: each fork was itself unstamped, so opening it forked
		// again, producing "(copy from this device) (copy from this device)".
		const distinctive = new Uint16Array(BLOCKS_PER_CHUNK);
		distinctive.fill(11);
		await local.saveWorld(
			save({ lastSyncedGeneration: '5', chunks: [{ cx: 0, cz: 0, blocks: distinctive }] }),
		);
		let gen = 9;
		const cloud = fakeCloud({
			loadWorld: async () => save({ lastSyncedGeneration: String(gen) }),
			saveWorld: async () => {
				gen++;
				return { local: 'ok', cloud: 'ok' } as const;
			},
			generationFor: () => String(gen),
		});
		const dual = new DualAdapter(local, cloud);

		await dual.loadWorld(ID);
		const afterFirst = (await local.listWorlds()).filter((w) => w.name.includes('copy from'));
		expect(afterFirst).toHaveLength(1);

		// Re-open the fork itself several times: it must never spawn another.
		for (let i = 0; i < 3; i++) await dual.loadWorld(afterFirst[0].id);

		const forks = (await local.listWorlds()).filter((w) => w.name.includes('copy from'));
		expect(forks).toHaveLength(1);
		expect(forks.some((w) => w.name.includes('copy from this device) (copy'))).toBe(false);
	});

	it('keeps both copies exactly once when they genuinely diverge', async () => {
		// The content must actually differ — a generation mismatch alone is not
		// divergence, it is unknown ancestry.
		const localBlocks = new Uint16Array(BLOCKS_PER_CHUNK);
		localBlocks.fill(11);
		await local.saveWorld(
			save({
				lastSyncedGeneration: '5',
				name: 'Castle',
				chunks: [{ cx: 0, cz: 0, blocks: localBlocks }],
			}),
		);
		const cloudBlocks = new Uint16Array(BLOCKS_PER_CHUNK);
		cloudBlocks.fill(4);
		const cloud = fakeCloud({
			loadWorld: async () =>
				save({
					lastSyncedGeneration: '9',
					name: 'Castle',
					chunks: [{ cx: 0, cz: 0, blocks: cloudBlocks }],
				}),
		});
		const dual = new DualAdapter(local, cloud);

		await dual.loadWorld(ID);

		const forks = (await local.listWorlds()).filter((w) => w.name.includes('copy from'));
		expect(forks).toHaveLength(1);
		expect(forks[0].id).not.toBe(ID);
	});

	it('preserves the diverged local chunks in the fork', async () => {
		const distinctive = new Uint16Array(BLOCKS_PER_CHUNK);
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
					version: 2 as const,
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

describe('DualAdapter fail-closed load', () => {
	function localWith(s: WorldSave | null, corrupt = false) {
		const storage = new MemStorage();
		const local = new LocalStorageAdapter(storage as unknown as Storage);
		if (s) void local.saveWorld(s);
		if (corrupt) storage.setItem(`minicraft:v2:world:${ID}:chunk:0:0`, JSON.stringify({ blocks: '!!!' }));
		return local;
	}

	it('uses the cloud copy when the local copy is corrupt', async () => {
		const cloud = fakeCloud({ loadWorld: async () => save({ name: 'FromCloud' }) });
		const d = new DualAdapter(localWith(save(), true), cloud);
		const got = await d.loadWorld(ID);
		expect(got!.name).toBe('FromCloud');
	});

	it('uses the local copy when the cloud copy is corrupt, and flags it for upload', async () => {
		const cloud = fakeCloud({
			loadWorld: async () => {
				throw new SaveCorrupt('bad');
			},
		});
		const d = new DualAdapter(localWith(save({ name: 'Local' })), cloud);
		const got = await d.loadWorld(ID);
		expect(got!.name).toBe('Local');
		expect(d.takeNeedsUpload()).toContain(ID);
	});

	it('throws when both copies are unusable', async () => {
		const cloud = fakeCloud({
			loadWorld: async () => {
				throw new SaveCorrupt('bad');
			},
		});
		const d = new DualAdapter(localWith(save(), true), cloud);
		await expect(d.loadWorld(ID)).rejects.toThrow(SaveCorrupt);
	});

	it('throws SaveMismatch when the copies disagree on height', async () => {
		const tall = save({
			version: 3,
			height: 256,
			genVersion: 2,
			chunks: [{ cx: 0, cz: 0, blocks: new Uint16Array(65536) }],
		});
		const cloud = fakeCloud({ loadWorld: async () => tall });
		const d = new DualAdapter(localWith(save()), cloud);
		await expect(d.loadWorld(ID)).rejects.toThrow(SaveMismatch);
	});
});
describe('DualAdapter — same chunks, different player or mode (crafting spec §10)', () => {
	let storage: MemStorage;
	let local: LocalStorageAdapter;
	beforeEach(() => {
		storage = new MemStorage();
		local = new LocalStorageAdapter(storage as unknown as Storage);
	});
	afterEach(() => vi.unstubAllGlobals());

	const CRAFTED = { owned: [0, 1], equipped: 1 };
	const withTools = (tools: { owned: number[]; equipped: number }, over: Partial<WorldSave> = {}) =>
		save({ ...over, player: { ...save().player, tools } });
	const forks = async () => (await local.listWorlds()).filter((w) => w.name.includes('copy from'));
	const localStamp = () => JSON.parse(storage.getItem(`minicraft:v2:world:${ID}:meta`)!).lastSyncedGeneration;

	it('keeps a newer local copy with crafted tools: no fork, localWon set', async () => {
		// Catches: today's chunks-only compare, which adopts the older cloud copy and
		// loses the pickaxe; and a fork on every player difference.
		await local.saveWorld(withTools(CRAFTED, { updatedAt: 3000 }));
		const cloud = fakeCloud({ loadWorld: async () => save({ updatedAt: 2000, lastSyncedGeneration: '9' }) });
		const got = await new DualAdapter(local, cloud).loadWorld(ID);
		expect(got!.player.tools).toEqual(CRAFTED);
		expect(got!.localWon).toBe(true);
		expect(await forks()).toHaveLength(0);
	});

	it('leaves the local stamp unchanged on disk when the local copy wins', async () => {
		// Catches: adopt() in the local-wins branch, stamping the local copy with a
		// generation whose content it does not match.
		await local.saveWorld(withTools(CRAFTED, { updatedAt: 3000 }));
		expect(localStamp()).toBeNull();
		const cloud = fakeCloud({ loadWorld: async () => save({ updatedAt: 2000, lastSyncedGeneration: '9' }) });
		await new DualAdapter(local, cloud).loadWorld(ID);
		expect(localStamp()).toBeNull();
	});

	it('loads the local copy again on a reload before any upload', async () => {
		// Catches: re-stamping. A local copy carrying the cloud's stamp reads as an
		// ancestor on the next load and loses to the cloud: the crafted pickaxe vanishes
		// if he only looks around and closes the tab before the upload.
		await local.saveWorld(withTools(CRAFTED, { updatedAt: 3000 }));
		const cloud = fakeCloud({ loadWorld: async () => save({ updatedAt: 2000, lastSyncedGeneration: '9' }) });
		await new DualAdapter(local, cloud).loadWorld(ID);
		const again = await new DualAdapter(local, cloud).loadWorld(ID);
		expect(again!.player.tools).toEqual(CRAFTED);
		expect(again!.localWon).toBe(true);
	});

	it("sends the next save's PUT with If-Match on the loaded cloud generation", async () => {
		// Catches: markUnsynced() in the local-wins branch (as the offline path does): the
		// PUT would go out with If-None-Match: * and 409 on every retry.
		const encoded = local.encode(save());
		const wire = { ...save(), updatedAt: 2000, chunks: encoded };
		const res = (status: number, body: unknown = {}, gen?: string) => ({
			ok: status >= 200 && status < 300,
			status,
			headers: { get: (k: string) => (k === 'X-Generation' ? (gen ?? null) : null) },
			json: async () => body,
		});
		const replies = [res(404), res(200, wire, '9'), res(200, { generation: '10' })];
		const calls: { url: string; init?: RequestInit }[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url, init });
				return replies[calls.length - 1];
			}),
		);
		await local.saveWorld(withTools(CRAFTED, { updatedAt: 3000 }));
		const dual = new DualAdapter(local, new CloudAdapter('https://api.test'));

		const got = await dual.loadWorld(ID);
		expect(got!.localWon).toBe(true);
		const r = await dual.saveWorld(withTools(CRAFTED, { updatedAt: 4000 }));

		expect(r.cloud).toBe('ok');
		const put = calls[2];
		expect(put.init!.method).toBe('PUT');
		expect((put.init!.headers as Record<string, string>)['If-Match']).toBe('9');
		expect(localStamp()).toBe('10'); // stamped only after the PUT succeeded
	});

	it('lets the cloud copy win a tie on updatedAt', async () => {
		// Catches: `>=` in place of `>`.
		await local.saveWorld(withTools(CRAFTED, { updatedAt: 2000 }));
		const cloud = fakeCloud({ loadWorld: async () => save({ updatedAt: 2000, lastSyncedGeneration: '9' }) });
		const got = await new DualAdapter(local, cloud).loadWorld(ID);
		expect(got!.player.tools).toBeUndefined();
		expect(got!.localWon).not.toBe(true);
		expect(localStamp()).toBe('9');
	});

	it('does not fork after P is pressed offline and the world is reloaded online', async () => {
		// Catches: comparing player/mode as divergence (a fork per offline P press) and
		// today's cloud-always-wins (the switch back is lost). Every offline save clears
		// the local stamp, so the reload cannot take the ancestor path.
		let online = true;
		const cloudCopy = withTools(CRAFTED, { updatedAt: 2000, lastSyncedGeneration: '9' });
		const cloud = fakeCloud({
			loadWorld: async () => {
				if (!online) throw new CloudError('NETWORK');
				return cloudCopy;
			},
			saveWorld: async () => {
				throw new CloudError('NETWORK');
			},
		});
		await local.saveWorld(withTools(CRAFTED, { updatedAt: 2000, lastSyncedGeneration: '9' }));

		online = false;
		const dual = new DualAdapter(local, cloud);
		expect(await dual.loadWorld(ID)).not.toBeNull();
		// P: back to the hand. The autosave snapshot never carries lastSyncedGeneration.
		await dual.saveWorld(withTools({ owned: [0, 1], equipped: 0 }, { updatedAt: 3000 }));

		online = true;
		const again = await new DualAdapter(local, cloud).loadWorld(ID);
		expect(await forks()).toHaveLength(0);
		expect(again!.player.tools).toEqual({ owned: [0, 1], equipped: 0 });
		expect(again!.localWon).toBe(true);
	});

	it('treats a cloud copy without the fields as equal to a local copy holding the defaults', async () => {
		// Catches: comparing raw fields (undefined vs {}), which would call every
		// pre-crafting cloud copy "different" and re-upload it on each load.
		await local.saveWorld(
			save({
				updatedAt: 3000,
				mustMine: false,
				player: { ...save().player, inventory: {}, tools: { owned: [0], equipped: 0 } },
			}),
		);
		const cloud = fakeCloud({ loadWorld: async () => save({ updatedAt: 2000, lastSyncedGeneration: '9' }) });
		const got = await new DualAdapter(local, cloud).loadWorld(ID);
		expect(got!.localWon).not.toBe(true);
		expect(localStamp()).toBe('9'); // the cloud copy was adopted, as before crafting
	});

	it('still forks different chunks, without localWon', async () => {
		// Catches: setting localWon outside the same-chunks branch.
		const blocks = new Uint16Array(BLOCKS_PER_CHUNK);
		blocks.fill(11);
		await local.saveWorld(withTools(CRAFTED, { updatedAt: 3000, chunks: [{ cx: 0, cz: 0, blocks }] }));
		const cloud = fakeCloud({ loadWorld: async () => save({ updatedAt: 2000, lastSyncedGeneration: '9' }) });
		const got = await new DualAdapter(local, cloud).loadWorld(ID);
		expect(await forks()).toHaveLength(1);
		expect(got!.localWon).not.toBe(true);
	});

	it('never sets localWon on an offline or corrupt-cloud load', async () => {
		// Catches: a flag set whenever the local copy is returned. Those paths already
		// markUnsynced + needsUpload; a second upload trigger is not what they need.
		await local.saveWorld(withTools(CRAFTED, { updatedAt: 3000 }));
		for (const err of [new CloudError('NETWORK'), new SaveCorrupt('bad')]) {
			const cloud = fakeCloud({
				loadWorld: async () => {
					throw err;
				},
			});
			const got = await new DualAdapter(local, cloud).loadWorld(ID);
			expect(got!.localWon).not.toBe(true);
		}
	});
});

describe('DualAdapter — a local copy from an old bundle (crafting spec §10, client-side guard)', () => {
	let storage: MemStorage;
	let local: LocalStorageAdapter;
	beforeEach(() => {
		storage = new MemStorage();
		local = new LocalStorageAdapter(storage as unknown as Storage);
	});

	const COUNTS = { stone: 5, dirt: 0 };
	const TOOLS = { owned: [0, 2], equipped: 2 };
	const cloudWithFields = () =>
		save({
			updatedAt: 2000,
			lastSyncedGeneration: '9',
			mustMine: true,
			player: { ...save().player, inventory: COUNTS, tools: TOOLS },
		});

	/** What a pre-crafting bundle leaves on disk: no inventory, no tools, no mustMine. */
	async function oldBundleLocal(over: Partial<WorldSave> = {}) {
		await local.saveWorld(save({ updatedAt: 3000, player: { ...save().player, x: 5 }, ...over }));
		const key = `minicraft:v2:world:${ID}:meta`;
		const meta = JSON.parse(storage.getItem(key)!);
		delete meta.mustMine;
		delete meta.player.inventory;
		delete meta.player.tools;
		storage.setItem(key, JSON.stringify(meta));
	}

	it("fills the fields a newer old-bundle local copy lacks from the cloud copy", async () => {
		// Catches: taking the old-bundle copy whole. It is newer and differs (it walked),
		// so it wins, and its missing fields default to {} / hand / unlimited; localWon
		// then uploads those, and the server guard respects them because they are sent.
		// The counts, pickaxes and mode made on the new bundle would be gone.
		await oldBundleLocal();
		const cloud = fakeCloud({ loadWorld: async () => cloudWithFields() });
		const got = await new DualAdapter(local, cloud).loadWorld(ID);
		expect(got!.localWon).toBe(true);
		expect(got!.player.x).toBe(5); // the local copy still won
		expect(got!.player.inventory).toEqual(COUNTS);
		expect(got!.player.tools).toEqual(TOOLS);
		expect(got!.mustMine).toBe(true);
	});

	it('does not count the missing fields as a difference', async () => {
		// Catches: filling after the compare. An old-bundle copy that differs ONLY by the
		// missing fields would win and trigger an upload of what the cloud already has;
		// filled first, it equals the cloud and the cloud copy is adopted as before.
		await oldBundleLocal({ player: save().player });
		const cloud = fakeCloud({ loadWorld: async () => cloudWithFields() });
		const got = await new DualAdapter(local, cloud).loadWorld(ID);
		expect(got!.localWon).not.toBe(true);
		expect(got!.player.inventory).toEqual(COUNTS);
		expect(JSON.parse(storage.getItem(`minicraft:v2:world:${ID}:meta`)!).lastSyncedGeneration).toBe('9');
	});

	it('keeps fields the local copy does carry, even {} and false', async () => {
		// Catches: filling by emptiness or truthiness. A new-bundle copy that used every
		// block up to nothing, or is unlimited, must not get the cloud's values back.
		await local.saveWorld(
			save({
				updatedAt: 3000,
				mustMine: false,
				player: { ...save().player, x: 5, inventory: {}, tools: { owned: [0], equipped: 0 } },
			}),
		);
		const cloud = fakeCloud({ loadWorld: async () => cloudWithFields() });
		const got = await new DualAdapter(local, cloud).loadWorld(ID);
		expect(got!.localWon).toBe(true);
		expect(got!.player.inventory).toEqual({});
		expect(got!.player.tools).toEqual({ owned: [0], equipped: 0 });
		expect(got!.mustMine).toBe(false);
	});
});
