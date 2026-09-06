import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DEFAULT_KEYBINDINGS } from '../data/keybindings.data';

// ---------------------------------------------------------------------------
// Minimal localStorage stub (vitest/jsdom may not provide one in all configs)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadOptions', () => {
	it('returns defaults when localStorage is empty', async () => {
		const { loadOptions } = await import('./options');
		const opts = loadOptions();
		expect(opts.keybindings).toEqual(DEFAULT_KEYBINDINGS);
	});

	it('strips stale flyUp / flyDown keys that were removed in Task 20', async () => {
		// Simulate a save that still has old flyUp / flyDown bindings, where
		// flyUp was mapped to 'Space' (which would shadow the jump binding).
		const stale = {
			keybindings: {
				...DEFAULT_KEYBINDINGS,
				flyUp: 'Space',
				flyDown: 'ShiftLeft',
			},
		};
		store['minicraft:v1:options'] = JSON.stringify(stale);

		const { loadOptions } = await import('./options');
		const opts = loadOptions();

		// stale keys must NOT appear in the returned keybindings
		expect((opts.keybindings as Record<string, string>)['flyUp']).toBeUndefined();
		expect((opts.keybindings as Record<string, string>)['flyDown']).toBeUndefined();

		// jump must still be bound to Space (not overwritten by stale flyUp)
		expect(opts.keybindings.jump).toBe('Space');
	});

	it('preserves known overrides from saved options', async () => {
		const saved = {
			keybindings: {
				...DEFAULT_KEYBINDINGS,
				forward: 'ArrowUp', // custom override
			},
		};
		store['minicraft:v1:options'] = JSON.stringify(saved);

		const { loadOptions } = await import('./options');
		const opts = loadOptions();
		expect(opts.keybindings.forward).toBe('ArrowUp');
	});

	it('falls back to defaults for unknown / corrupt payload', async () => {
		store['minicraft:v1:options'] = 'not-json{{{';

		const { loadOptions } = await import('./options');
		const opts = loadOptions();
		expect(opts.keybindings).toEqual(DEFAULT_KEYBINDINGS);
	});

	it('defaults play-time fields to null when absent', async () => {
		const { loadOptions } = await import('./options');
		const opts = loadOptions();
		expect(opts.playLimitMin).toBeNull();
		expect(opts.playBreakMin).toBeNull();
	});

	it('round-trips play-time fields', async () => {
		const { loadOptions, saveOptions } = await import('./options');
		const opts = loadOptions();
		opts.playLimitMin = 30;
		opts.playBreakMin = 20;
		saveOptions(opts);
		const back = loadOptions();
		expect(back.playLimitMin).toBe(30);
		expect(back.playBreakMin).toBe(20);
	});

	it('rejects play-time values that are not in the choice lists', async () => {
		store['minicraft:v1:options'] = JSON.stringify({
			keybindings: DEFAULT_KEYBINDINGS,
			playLimitMin: '30',
			playBreakMin: 7,
		});
		const { loadOptions } = await import('./options');
		const opts = loadOptions();
		expect(opts.playLimitMin).toBeNull();
		expect(opts.playBreakMin).toBeNull();
	});

	it('ignores a stored kidMode', async () => {
		store['minicraft:v1:options'] = JSON.stringify({ kidMode: false, keybindings: DEFAULT_KEYBINDINGS });
		const { loadOptions } = await import('./options');
		expect('kidMode' in loadOptions()).toBe(false);
	});

	it('binds inventory to KeyI by default', async () => {
		const { loadOptions } = await import('./options');
		expect(loadOptions().keybindings.inventory).toBe('KeyI');
	});
});
