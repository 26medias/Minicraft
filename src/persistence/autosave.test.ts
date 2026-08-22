import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AutoSave } from './autosave';
import type { PersistenceAdapter, PlayerSave, WorldSave } from './adapter';
import type { World } from '../engine/world/world';

type Listeners = Map<string, () => void>;

function stubDom(): Listeners {
	const listeners: Listeners = new Map();
	vi.stubGlobal('window', {
		addEventListener: (e: string, f: () => void) => listeners.set(e, f),
	});
	vi.stubGlobal('document', {
		addEventListener: (e: string, f: () => void) => listeners.set(`doc:${e}`, f),
		visibilityState: 'visible',
	});
	return listeners;
}

function fakeWorld(): World {
	return { seed: 1, modifiedChunks: () => [] } as unknown as World;
}

const WORLD_ID = '11111111-1111-4111-8111-111111111111';
const PLAYER: PlayerSave = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hotbar: [], selected: 0 };

function makeAdapter(saveWorld: (s: WorldSave) => Promise<void>): PersistenceAdapter {
	const wrapped = async (s: WorldSave) => {
		await saveWorld(s);
		return { local: 'ok', cloud: 'skipped' } as const;
	};
	return {
		saveWorld: wrapped,
		loadWorld: async () => null,
		listWorlds: async () => [],
		deleteWorld: async () => {},
	};
}

function makeAutoSave(adapter: PersistenceAdapter, onQuota: () => void = () => {}) {
	return new AutoSave(adapter, fakeWorld(), () => PLAYER, { id: WORLD_ID, name: 'w', createdAt: 0 }, onQuota);
}

describe('AutoSave failure handling', () => {
	beforeEach(() => {
		stubDom();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('keeps the world dirty when a save fails, so a later flush retries it', async () => {
		let calls = 0;
		const adapter = makeAdapter(async () => {
			calls++;
			if (calls === 1) throw new Error('NETWORK');
		});
		const autosave = makeAutoSave(adapter);

		autosave.markDirty();
		await expect(autosave.flush()).rejects.toThrow('NETWORK');
		expect(calls).toBe(1);

		await autosave.flush();
		expect(calls).toBe(2);
	});

	it('does not permanently disable saving after a quota error', async () => {
		let calls = 0;
		const adapter = makeAdapter(async () => {
			calls++;
			if (calls === 1) throw new Error('QUOTA_EXCEEDED');
		});
		let quotaReports = 0;
		const autosave = makeAutoSave(adapter, () => {
			quotaReports++;
		});

		autosave.markDirty();
		await autosave.flush();
		expect(quotaReports).toBe(1);

		autosave.markDirty();
		await autosave.flush();
		expect(calls).toBe(2);
	});

	it('clears the dirty flag only after a successful save', async () => {
		let calls = 0;
		const adapter = makeAdapter(async () => {
			calls++;
		});
		const autosave = makeAutoSave(adapter);

		autosave.markDirty();
		await autosave.flush();
		expect(calls).toBe(1);

		await autosave.flush();
		expect(calls).toBe(1);
	});

	it('never runs two saves concurrently', async () => {
		let inFlight = 0;
		let maxConcurrent = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let n = 0;
		const adapter = makeAdapter(async () => {
			inFlight++;
			maxConcurrent = Math.max(maxConcurrent, inFlight);
			if (++n === 1) await gate;
			inFlight--;
		});
		const autosave = makeAutoSave(adapter);

		autosave.markDirty();
		const first = autosave.flush();
		autosave.markDirty();
		const second = autosave.flush();

		release();
		await Promise.all([first, second]);

		expect(maxConcurrent).toBe(1);
	});

	it('persists an edit made during an in-flight save', async () => {
		const snapshots: number[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let n = 0;
		let dug = 0;
		const world = { seed: 1, modifiedChunks: () => new Array(dug) } as unknown as World;
		const adapter = makeAdapter(async (s) => {
			snapshots.push(s.chunks.length);
			if (++n === 1) await gate;
		});
		const autosave = new AutoSave(adapter, world, () => PLAYER, { id: WORLD_ID, name: 'w', createdAt: 0 });

		dug = 1;
		autosave.markDirty();
		const inFlight = autosave.flush();

		// The kid digs while the save is still uploading.
		dug = 2;
		autosave.markDirty();

		release();
		await inFlight;
		await autosave.flush();

		expect(snapshots).toEqual([1, 2]);
	});

	it('still saves the edits made while a save was in flight', async () => {
		let saves = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const adapter = makeAdapter(async () => {
			if (++saves === 1) await gate;
		});
		const autosave = makeAutoSave(adapter);

		autosave.markDirty();
		const first = autosave.flush();
		autosave.markDirty();
		const second = autosave.flush();

		release();
		await Promise.all([first, second]);

		expect(saves).toBe(2);
	});
});

describe('AutoSave cloud behaviour', () => {
	let listeners: Listeners;
	beforeEach(() => {
		listeners = stubDom();
	});
	afterEach(() => vi.unstubAllGlobals());

	function dualLike(result: () => SaveResultLike, sync?: () => void) {
		const calls = { save: 0, sync: 0, needsUpload: [] as string[] };
		const adapter = {
			saveWorld: async () => {
				calls.save++;
				return result();
			},
			saveLocalSync: () => {
				calls.sync++;
				sync?.();
			},
			markNeedsUpload: (id: string) => calls.needsUpload.push(id),
			loadWorld: async () => null,
			listWorlds: async () => [],
			deleteWorld: async () => {},
		} as unknown as PersistenceAdapter;
		return { adapter, calls };
	}

	it('reports local-only when the cloud leg fails but the local one succeeds', async () => {
		const { adapter } = dualLike(() => ({ local: 'ok', cloud: 'failed' }));
		const a = makeAutoSave(adapter);
		const seen: string[] = [];
		a.onStatus = (s) => seen.push(s);

		a.markDirty();
		await a.flush();

		expect(seen).toContain('local-only');
		a.dispose();
	});

	it('reports saved when both legs succeed', async () => {
		const { adapter } = dualLike(() => ({ local: 'ok', cloud: 'ok' }));
		const a = makeAutoSave(adapter);
		const seen: string[] = [];
		a.onStatus = (s) => seen.push(s);

		a.markDirty();
		await a.flush();

		expect(seen[seen.length - 1]).toBe('saved');
		a.dispose();
	});

	it('reports error when both legs fail', async () => {
		const { adapter } = dualLike(() => ({ local: 'error', cloud: 'failed' }));
		const a = makeAutoSave(adapter);
		const seen: string[] = [];
		a.onStatus = (s) => seen.push(s);

		a.markDirty();
		await a.flush();

		expect(seen[seen.length - 1]).toBe('error');
		a.dispose();
	});

	it('surfaces a local quota failure even when the cloud write succeeded', async () => {
		const { adapter } = dualLike(() => ({ local: 'quota', cloud: 'ok' }));
		let quota = 0;
		const a = makeAutoSave(adapter, () => quota++);

		a.markDirty();
		await a.flush();

		expect(quota).toBe(1);
		a.dispose();
	});

	it('stays dirty and retries after a failed cloud leg', async () => {
		const { adapter, calls } = dualLike(() => ({ local: 'ok', cloud: 'failed' }));
		const a = makeAutoSave(adapter);

		a.markDirty();
		await a.flush();
		expect(calls.save).toBe(1);

		// Still dirty, so an explicit flush saves again rather than short-circuiting.
		await a.flush();
		expect(calls.save).toBe(2);
		a.dispose();
	});

	it('writes locally and flags an upload on pagehide, with no cloud call', async () => {
		// keepalive fetch caps at 64 KiB, so the cloud leg cannot run during unload.
		const { adapter, calls } = dualLike(() => ({ local: 'ok', cloud: 'ok' }));
		const a = makeAutoSave(adapter);

		a.markDirty();
		listeners.get('pagehide')!();

		expect(calls.sync).toBe(1);
		expect(calls.save).toBe(0);
		expect(calls.needsUpload).toContain(WORLD_ID);
		a.dispose();
	});

	it('does nothing on pagehide when there are no unsaved edits', async () => {
		const { adapter, calls } = dualLike(() => ({ local: 'ok', cloud: 'ok' }));
		const a = makeAutoSave(adapter);

		listeners.get('pagehide')!();

		expect(calls.sync).toBe(0);
		a.dispose();
	});
});

type SaveResultLike = { local: 'ok' | 'quota' | 'error'; cloud: 'ok' | 'failed' | 'skipped' };
