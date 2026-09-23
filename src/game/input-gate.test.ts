import { describe, it, expect } from 'vitest';
import { shouldHandleKey, buildKeyToAction } from './input-gate';
import { DEFAULT_KEYBINDINGS } from '../data/keybindings.data';

const free = { frozen: false, inventoryOpen: false, pickerOpen: false };

describe('shouldHandleKey', () => {
	it('processes every keyup in every state so held keys never stick', () => {
		for (const state of [free, { ...free, frozen: true }, { ...free, inventoryOpen: true }, { ...free, pickerOpen: true }])
			for (const a of ['forward', 'jump', 'inventory', 'slot3', 'ignite'] as const)
				expect(shouldHandleKey(false, a, state)).toBe(true);
	});
	it('drops every keydown while frozen', () => {
		for (const a of ['forward', 'inventory', 'slot1', 'toggleFly'] as const)
			expect(shouldHandleKey(true, a, { ...free, frozen: true })).toBe(false);
	});
	it('allows only inventory and slot keys while the inventory is open', () => {
		const s = { ...free, inventoryOpen: true };
		expect(shouldHandleKey(true, 'inventory', s)).toBe(true);
		expect(shouldHandleKey(true, 'slot7', s)).toBe(true);
		for (const a of ['forward', 'jump', 'ignite', 'toggleFly', 'pickLightColor'] as const)
			expect(shouldHandleKey(true, a, s)).toBe(false);
	});
	it('ignores the inventory key while the colour picker is open, nothing else', () => {
		const s = { ...free, pickerOpen: true };
		expect(shouldHandleKey(true, 'inventory', s)).toBe(false);
		expect(shouldHandleKey(true, 'forward', s)).toBe(true);
	});
	it('handles everything when free', () => {
		for (const a of ['forward', 'inventory', 'slot1', 'ignite'] as const) expect(shouldHandleKey(true, a, free)).toBe(true);
	});
	it('drops cyclePickaxe while the colour picker, the I screen or the freeze is open (catches a P that switches pickaxes behind a modal; the picker case is the one today\'s gate lets through)', () => {
		for (const s of [{ ...free, pickerOpen: true }, { ...free, inventoryOpen: true }, { ...free, frozen: true }])
			expect(shouldHandleKey(true, 'cyclePickaxe', s)).toBe(false);
		expect(shouldHandleKey(true, 'cyclePickaxe', free)).toBe(true);
		expect(shouldHandleKey(false, 'cyclePickaxe', { ...free, pickerOpen: true })).toBe(true);
	});
});

describe('buildKeyToAction', () => {
	it('skips the unbound value \'\' (catches main.ts\'s old loop, which maps \'\' to the action, so any key whose e.code is \'\' would cycle the pickaxe)', () => {
		const map = buildKeyToAction({ ...DEFAULT_KEYBINDINGS, cyclePickaxe: '' });
		expect('' in map).toBe(false);
		expect(Object.values(map)).not.toContain('cyclePickaxe');
		expect(map['KeyP']).toBeUndefined();
		expect(map['KeyI']).toBe('inventory');
	});
});
