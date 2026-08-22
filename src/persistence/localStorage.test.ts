import { describe, it, expect, beforeEach } from 'vitest';
import { LocalStorageAdapter } from './localStorage';
import type { WorldSave } from './adapter';
import { BLOCKS_PER_CHUNK } from '../engine/world/coords';
import { encodeChunk } from './codec';
import { legacyId } from './uuid';

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

function idFor(seed: number): string {
	return `00000000-0000-4000-8000-${String(seed).padStart(12, '0')}`;
}

function sampleSave(seed: number): WorldSave {
	const blocks = new Uint8Array(BLOCKS_PER_CHUNK);
	blocks[0] = 3;
	blocks[1] = 3;
	blocks[2] = 5;
	return {
		version: 2,
		id: idFor(seed),
		seed,
		name: `World ${seed}`,
		createdAt: 1000,
		updatedAt: 2000,
		player: { x: 10, y: 60, z: 10, yaw: 0, pitch: 0, hotbar: [1, 2, 3], selected: 0 },
		chunks: [{ cx: 0, cz: 0, blocks }],
	};
}

describe('LocalStorageAdapter', () => {
	let storage: MemStorage;
	let adapter: LocalStorageAdapter;
	beforeEach(() => {
		storage = new MemStorage();
		adapter = new LocalStorageAdapter(storage as unknown as Storage);
	});

	it('saves and loads a world', async () => {
		await adapter.saveWorld(sampleSave(42));
		const loaded = await adapter.loadWorld(idFor(42));
		expect(loaded).not.toBeNull();
		expect(loaded!.seed).toBe(42);
		expect(loaded!.name).toBe('World 42');
		expect(loaded!.chunks).toHaveLength(1);
		expect(loaded!.chunks[0].blocks[0]).toBe(3);
	});

	it('returns null for missing world', async () => {
		const loaded = await adapter.loadWorld(idFor(999));
		expect(loaded).toBeNull();
	});

	it('lists saved worlds newest-first', async () => {
		await adapter.saveWorld({ ...sampleSave(1), updatedAt: 1000 });
		await adapter.saveWorld({ ...sampleSave(2), updatedAt: 2000 });
		const list = await adapter.listWorlds();
		expect(list.map((w) => w.seed)).toEqual([2, 1]);
	});

	it('deletes a world and its chunks', async () => {
		await adapter.saveWorld(sampleSave(7));
		await adapter.deleteWorld(idFor(7));
		expect(await adapter.loadWorld(idFor(7))).toBeNull();
		expect((await adapter.listWorlds()).find((w) => w.seed === 7)).toBeUndefined();
	});

	it('round-trips lights', async () => {
		const base = sampleSave(11);
		const save = {
			...base,
			lights: [
				{ x: 1, y: 2, z: 3, color: '#FFF5E0' },
				{ x: 4, y: 5, z: 6, color: '#88CCFF' },
			],
		};
		await adapter.saveWorld(save);
		const loaded = await adapter.loadWorld(idFor(11));
		expect(loaded!.lights).toEqual(save.lights);
	});

	it('loads pre-Task-6 saves (no lights field)', async () => {
		await adapter.saveWorld(sampleSave(12));
		const loaded = await adapter.loadWorld(idFor(12));
		expect(loaded!.lights).toBeUndefined();
	});
});

describe('LocalStorageAdapter — fluidMeta round-trip', () => {
	it('persists and restores per-chunk fluidMeta', async () => {
		const storage = new MemStorage();
		const adapter = new LocalStorageAdapter(storage as unknown as Storage);
		const blocks = new Uint8Array(BLOCKS_PER_CHUNK);
		const fluidMeta = new Map<number, number>([
			[42, 0x82],
			[777, 0x84],
		]);
		const save: WorldSave = {
			version: 2,
			id: idFor(999),
			seed: 999,
			name: 'test',
			createdAt: 1,
			updatedAt: 1,
			player: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hotbar: [], selected: 0 },
			chunks: [{ cx: 0, cz: 0, blocks, fluidMeta }],
		};
		await adapter.saveWorld(save);
		const loaded = await adapter.loadWorld(idFor(999));
		expect(loaded).not.toBeNull();
		const rc = loaded!.chunks.find((c) => c.cx === 0 && c.cz === 0)!;
		expect(rc.fluidMeta).toBeDefined();
		expect(rc.fluidMeta!.size).toBe(2);
		expect(rc.fluidMeta!.get(42)).toBe(0x82);
		expect(rc.fluidMeta!.get(777)).toBe(0x84);
	});

	it('loads chunks without fluidMeta (legacy save) as undefined', async () => {
		const storage = new MemStorage();
		const adapter = new LocalStorageAdapter(storage as unknown as Storage);
		const blocks = new Uint8Array(BLOCKS_PER_CHUNK);
		const save: WorldSave = {
			version: 2,
			id: idFor(999),
			seed: 999,
			name: 'test',
			createdAt: 1,
			updatedAt: 1,
			player: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hotbar: [], selected: 0 },
			chunks: [{ cx: 0, cz: 0, blocks }], // no fluidMeta
		};
		await adapter.saveWorld(save);
		const loaded = await adapter.loadWorld(idFor(999));
		const rc = loaded!.chunks.find((c) => c.cx === 0 && c.cz === 0)!;
		expect(rc.fluidMeta).toBeUndefined();
	});

	it('loads pre-Task-6 on-disk format (bare base64 blob, no JSON wrapper)', async () => {
		// Synthesize a save in the pre-Task-6 format — bare encoded blocks string as the
		// per-chunk storage value, no JSON wrapper — and confirm it still loads.
		const storage = new MemStorage();
		const adapter = new LocalStorageAdapter(storage as unknown as Storage);
		const blocks = new Uint8Array(BLOCKS_PER_CHUNK);
		blocks[0] = 7;
		blocks[100] = 3;
		storage.setItem(
			'minicraft:v1:world:123:meta',
			JSON.stringify({
				version: 1,
				seed: 123,
				name: 'legacy',
				createdAt: 1,
				updatedAt: 1,
				player: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hotbar: [], selected: 0 },
			}),
		);
		storage.setItem('minicraft:v1:world:123:chunk:0:0', encodeChunk(blocks));

		const loaded = await adapter.loadWorld(legacyId(123));
		expect(loaded).not.toBeNull();
		// Normalized on read: a stored v1 meta has no id and version 1.
		expect(loaded!.version).toBe(2);
		expect(loaded!.id).toBe(legacyId(123));
		expect(loaded!.seed).toBe(123);
		expect(loaded!.chunks).toHaveLength(1);
		expect(loaded!.chunks[0].blocks[0]).toBe(7);
		expect(loaded!.chunks[0].blocks[100]).toBe(3);
		expect(loaded!.chunks[0].fluidMeta).toBeUndefined();
	});
});

describe('LocalStorageAdapter torn saves', () => {
	function multiChunkSave(seed: number, fill: number): WorldSave {
		const chunks = [0, 1, 2, 3].map((i) => {
			const blocks = new Uint8Array(BLOCKS_PER_CHUNK);
			blocks.fill(fill);
			return { cx: i, cz: 0, blocks };
		});
		return {
			version: 2,
			id: idFor(seed),
			seed,
			name: `World ${seed}`,
			createdAt: 1000,
			updatedAt: 1000,
			player: { x: 0, y: 60, z: 0, yaw: 0, pitch: 0, hotbar: [1], selected: 0 },
			chunks,
		};
	}

	it('keeps the old updatedAt when a save is interrupted partway through', async () => {
		const storage = new MemStorage();
		const adapter = new LocalStorageAdapter(storage as unknown as Storage);

		await adapter.saveWorld(multiChunkSave(7, 9));

		// Fail on the 3rd chunk write, leaving a genuine mixture on disk.
		let chunkWrites = 0;
		const realSet = storage.setItem.bind(storage);
		storage.setItem = (k: string, v: string) => {
			if (k.includes(':chunk:') && ++chunkWrites === 3) {
				throw new DOMException('full', 'QuotaExceededError');
			}
			realSet(k, v);
		};

		const second = multiChunkSave(7, 3);
		second.updatedAt = 2000;
		await expect(adapter.saveWorld(second)).rejects.toThrow('QUOTA_EXCEEDED');

		storage.setItem = realSet;

		const loaded = await adapter.loadWorld(idFor(7));
		const fills = new Set((loaded?.chunks ?? []).map((c) => c.blocks[0]));

		// The torn state is real: some chunks are from the new save, some from the old.
		expect(fills.size).toBeGreaterThan(1);
		// ...but it must not advertise itself as the newer save.
		expect(loaded?.updatedAt).toBe(1000);
	});
});

describe('LocalStorageAdapter legacy adoption', () => {
	const UUID = '22222222-2222-4222-8222-222222222222';

	function seedV1(storage: MemStorage, seed: number, fill: number) {
		const blocks = new Uint8Array(BLOCKS_PER_CHUNK);
		blocks.fill(fill);
		storage.setItem(
			`minicraft:v1:world:${seed}:meta`,
			JSON.stringify({
				version: 1,
				seed,
				name: 'Castle',
				createdAt: 1,
				updatedAt: 1,
				player: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hotbar: [], selected: 0 },
			}),
		);
		storage.setItem(`minicraft:v1:world:${seed}:chunk:0:0`, encodeChunk(blocks));
	}

	it('refuses to write a v2 record under a legacy id', async () => {
		const storage = new MemStorage();
		const adapter = new LocalStorageAdapter(storage as unknown as Storage);
		const save = { ...sampleSave(42), id: legacyId(42) };
		await expect(adapter.saveWorld(save)).rejects.toThrow('LEGACY_ID_NOT_WRITABLE');
	});

	it('does not roll a legacy world back after it has been adopted and played', async () => {
		const storage = new MemStorage();
		const adapter = new LocalStorageAdapter(storage as unknown as Storage);
		seedV1(storage, 42, 9);

		// Session 1: adopt, then save new work under the uuid.
		adapter.adoptLegacy(42, UUID);
		const played = { ...sampleSave(42), id: UUID, updatedAt: 5000 };
		played.chunks[0].blocks.fill(3);
		await adapter.saveWorld(played);

		// Session 2: the menu offers the adopted world; it must not resurrect v1.
		const reloaded = await adapter.loadWorld(legacyId(42));
		expect(reloaded!.chunks[0].blocks[0]).toBe(3);
		expect(reloaded!.id).toBe(UUID);
	});

	it('never lists two rows with the same id', async () => {
		const storage = new MemStorage();
		const adapter = new LocalStorageAdapter(storage as unknown as Storage);
		seedV1(storage, 42, 9);
		adapter.adoptLegacy(42, UUID);
		await adapter.saveWorld({ ...sampleSave(42), id: UUID });

		const list = await adapter.listWorlds();
		const ids = list.map((w) => w.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toContain(UUID);
		expect(ids).not.toContain(legacyId(42));
	});

	it('leaves v1 keys intact after adoption and a v2 save', async () => {
		const storage = new MemStorage();
		const adapter = new LocalStorageAdapter(storage as unknown as Storage);
		seedV1(storage, 42, 9);
		const before = storage.getItem('minicraft:v1:world:42:chunk:0:0');

		adapter.adoptLegacy(42, UUID);
		await adapter.saveWorld({ ...sampleSave(42), id: UUID });
		await adapter.deleteWorld(UUID);

		expect(storage.getItem('minicraft:v1:world:42:meta')).not.toBeNull();
		expect(storage.getItem('minicraft:v1:world:42:chunk:0:0')).toBe(before);
	});
});
