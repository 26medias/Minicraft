import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PlaytimeSession } from '../game/playtime';

const store: Record<string, string> = {};
const localStorageMock = {
	getItem: (k: string) => store[k] ?? null,
	setItem: (k: string, v: string) => {
		store[k] = v;
	},
	removeItem: (k: string) => {
		delete store[k];
	},
	clear: () => {
		for (const k of Object.keys(store)) delete store[k];
	},
};

beforeEach(() => {
	vi.stubGlobal('localStorage', localStorageMock);
	localStorageMock.clear();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const KEY = 'minicraft:v1:playtime';

function valid(over: Partial<PlaytimeSession> = {}): PlaytimeSession {
	return { limitMs: 1_800_000, breakMs: null, playedMs: 0, frozenAt: null, updatedAt: 1, startedAt: 1, ...over };
}

describe('playtime session storage', () => {
	it('returns null when nothing is stored', async () => {
		const { loadSession } = await import('./playtime');
		expect(loadSession()).toBeNull();
	});

	it('round-trips a session', async () => {
		const { loadSession, saveSession } = await import('./playtime');
		const s = valid({ playedMs: 5000, frozenAt: 99, updatedAt: 100 });
		saveSession(s);
		expect(loadSession()).toEqual(s);
	});

	it('round-trips a no-break session', async () => {
		const { loadSession, saveSession } = await import('./playtime');
		saveSession(valid({ breakMs: null }));
		expect(loadSession()?.breakMs).toBeNull();
	});

	it.each([
		['a numeric break (old record)', 1_200_000],
		['breakMs zero', 0],
		['breakMs absent (JSON drops undefined)', undefined],
		['breakMs a string', 'x'],
	])('loads any breakMs as null: %s', async (_name, breakMs) => {
		store[KEY] = JSON.stringify({ ...valid({ playedMs: 5, frozenAt: 9 }), breakMs });
		const { loadSession } = await import('./playtime');
		expect(loadSession()).toEqual(valid({ playedMs: 5, frozenAt: 9 }));
	});

	it('defaults startedAt to updatedAt for a legacy record', async () => {
		const { loadSession } = await import('./playtime');
		const legacy = { limitMs: 1_800_000, breakMs: null, playedMs: 5, frozenAt: null, updatedAt: 77 };
		localStorage.setItem(KEY, JSON.stringify(legacy));
		expect(loadSession()).toEqual({ ...legacy, startedAt: 77 });
	});

	it('rejects a record whose startedAt is not a finite number', async () => {
		const { loadSession } = await import('./playtime');
		localStorage.setItem(KEY, JSON.stringify(valid({ startedAt: 'x' as unknown as number })));
		expect(loadSession()).toBeNull();
	});

	it('returns null for garbage JSON', async () => {
		store[KEY] = 'not-json{{{';
		const { loadSession } = await import('./playtime');
		expect(loadSession()).toBeNull();
	});

	it.each([
		['limitMs zero', { limitMs: 0 }],
		['limitMs string', { limitMs: '1800000' }],
		['playedMs negative', { playedMs: -1 }],
		['playedMs null (what JSON makes of NaN)', { playedMs: null }],
		['frozenAt string', { frozenAt: 'now' }],
		['updatedAt absent (JSON drops undefined)', { updatedAt: undefined }],
	])('returns null for wrong shape: %s', async (_name, over) => {
		store[KEY] = JSON.stringify({ ...valid(), ...over });
		const { loadSession } = await import('./playtime');
		expect(loadSession()).toBeNull();
	});

	it('clearSession removes the key', async () => {
		const { saveSession, clearSession } = await import('./playtime');
		saveSession(valid());
		clearSession();
		expect(store[KEY]).toBeUndefined();
	});

	it('saveSession swallows storage errors', async () => {
		const { saveSession } = await import('./playtime');
		// Restore in `finally`: the mock object is shared across tests and
		// vi.unstubAllGlobals() does not undo a mutation of it.
		const real = localStorageMock.setItem;
		localStorageMock.setItem = () => {
			throw new Error('quota');
		};
		try {
			expect(() => saveSession(valid())).not.toThrow();
		} finally {
			localStorageMock.setItem = real;
		}
	});

	it('saving the Options screen does not remove the session', async () => {
		const { saveSession } = await import('./playtime');
		const { loadOptions, saveOptions } = await import('./options');
		saveSession(valid());
		saveOptions(loadOptions());
		expect(store[KEY]).toBeDefined();
	});
});

describe('applyMaxDuration', () => {
	it('saves the maximum and clears the session', async () => {
		const { applyMaxDuration, saveSession } = await import('./playtime');
		const { loadOptions } = await import('./options');
		saveSession(valid());
		const result = applyMaxDuration(30);
		expect(result.maxDurationMin).toBe(30);
		expect(loadOptions().maxDurationMin).toBe(30);
		expect(store[KEY]).toBeUndefined();
	});

	it('No limit saves null and clears the session', async () => {
		const { applyMaxDuration, saveSession } = await import('./playtime');
		const { loadOptions } = await import('./options');
		applyMaxDuration(30);
		saveSession(valid());
		applyMaxDuration(null);
		expect(loadOptions().maxDurationMin).toBeNull();
		expect(store[KEY]).toBeUndefined();
	});
});
