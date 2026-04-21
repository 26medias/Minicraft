import { describe, it, expect, beforeEach } from 'vitest';
import { LocalStorageAdapter } from './localStorage';
import type { WorldSave } from './adapter';
import { BLOCKS_PER_CHUNK } from '../engine/world/coords';

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

function sampleSave(seed: number): WorldSave {
	const blocks = new Uint8Array(BLOCKS_PER_CHUNK);
	blocks[0] = 3;
	blocks[1] = 3;
	blocks[2] = 5;
	return {
		version: 1,
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
		const loaded = await adapter.loadWorld(42);
		expect(loaded).not.toBeNull();
		expect(loaded!.seed).toBe(42);
		expect(loaded!.name).toBe('World 42');
		expect(loaded!.chunks).toHaveLength(1);
		expect(loaded!.chunks[0].blocks[0]).toBe(3);
	});

	it('returns null for missing world', async () => {
		const loaded = await adapter.loadWorld(999);
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
		await adapter.deleteWorld(7);
		expect(await adapter.loadWorld(7)).toBeNull();
		expect((await adapter.listWorlds()).find((w) => w.seed === 7)).toBeUndefined();
	});
});
