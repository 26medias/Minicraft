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
		expect(opts.kidMode).toBe(true);
	});

	it('strips stale flyUp / flyDown keys that were removed in Task 20', async () => {
		// Simulate a save that still has old flyUp / flyDown bindings, where
		// flyUp was mapped to 'Space' (which would shadow the jump binding).
		const stale = {
			kidMode: false,
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
			kidMode: true,
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
});
