import { describe, it, expect } from 'vitest';
import { resolveContinue } from './continue-policy';
import { SaveCorrupt, SaveMismatch } from '../persistence/errors';
import type { WorldSave } from '../persistence/adapter';

const save = { version: 2, height: 64, genVersion: 1, id: 'x', seed: 1, name: 'Castle', createdAt: 0, updatedAt: 0, player: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hotbar: [], selected: 0 }, chunks: [] } as WorldSave;

describe('resolveContinue', () => {
	it('continues on a loaded save', () => {
		expect(resolveContinue({ save }, 'Castle')).toEqual({ ok: true, save });
	});
	it('refuses a null load (today main.ts warns and starts a fresh world, whose first autosave prunes the local copy)', () => {
		const d = resolveContinue({ save: null }, 'Castle');
		expect(d.ok).toBe(false);
		if (!d.ok) expect(d.notice).toBe("Couldn't find the save for Castle. Nothing was changed.");
	});
	it('refuses a corrupt save and names the error', () => {
		const d = resolveContinue({ error: new SaveCorrupt('chunk 1,0 wrong length') }, 'Castle');
		expect(d.ok).toBe(false);
		if (!d.ok) expect(d.notice).toBe("Couldn't open Castle (SaveCorrupt). Nothing was changed.");
	});
	it('gives a mismatch its own wording', () => {
		const d = resolveContinue({ error: new SaveMismatch('64 vs 256') }, 'Castle');
		expect(d.ok).toBe(false);
		if (!d.ok) expect(d.notice).toBe('Castle has two different copies (this device and the cloud). Ask a parent. Nothing was changed.');
	});
	it('handles a non-Error throw', () => {
		const d = resolveContinue({ error: 'boom' }, 'Castle');
		expect(d.ok).toBe(false);
		if (!d.ok) expect(d.notice).toBe("Couldn't open Castle (Error). Nothing was changed.");
	});
});
