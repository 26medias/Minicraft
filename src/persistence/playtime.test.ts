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
	return { limitMs: 1_800_000, breakMs: 1_200_000, playedMs: 0, frozenAt: null, updatedAt: 1, ...over };
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

	it('returns null for garbage JSON', async () => {
		store[KEY] = 'not-json{{{';
		const { loadSession } = await import('./playtime');
		expect(loadSession()).toBeNull();
	});

	it.each([
		['limitMs zero', { limitMs: 0 }],
		['limitMs string', { limitMs: '1800000' }],
		['breakMs zero', { breakMs: 0 }],
		['breakMs absent (JSON drops undefined)', { breakMs: undefined }],
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

describe('applyPlaytimeSetting', () => {
	it('saves the patched options and clears the session', async () => {
		const { applyPlaytimeSetting, saveSession } = await import('./playtime');
		const { loadOptions } = await import('./options');
		saveSession(valid());
		const result = applyPlaytimeSetting({ playLimitMin: 30 });
		expect(result.playLimitMin).toBe(30);
		expect(loadOptions().playLimitMin).toBe(30);
		expect(store[KEY]).toBeUndefined();
	});

	it('keeps playBreakMin when playLimitMin is set to Off', async () => {
		const { applyPlaytimeSetting } = await import('./playtime');
		const { loadOptions } = await import('./options');
		applyPlaytimeSetting({ playLimitMin: 30, playBreakMin: 20 });
		applyPlaytimeSetting({ playLimitMin: null });
		expect(loadOptions().playBreakMin).toBe(20);
	});
});
