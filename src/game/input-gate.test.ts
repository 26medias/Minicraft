import { describe, it, expect } from 'vitest';
import { shouldHandleKey, buildKeyToAction, sneakKeyChange } from './input-gate';
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

describe('sneakKeyChange (toys spec §4: Shift is the sneak key)', () => {
	it('either Shift key sets sneak on keydown and clears it on keyup; no other key touches it', () => {
		// Catches only ShiftLeft wired (a right-handed Shift would do nothing), and e.key 'Shift' or KeyS used as the code.
		for (const code of ['ShiftLeft', 'ShiftRight']) {
			expect(sneakKeyChange(code, true, free)).toBe(true);
			expect(sneakKeyChange(code, false, free)).toBe(false);
		}
		for (const code of ['Shift', 'KeyS', 'ControlLeft', 'Space', '']) {
			expect(sneakKeyChange(code, true, free)).toBeNull();
			expect(sneakKeyChange(code, false, free)).toBeNull();
		}
	});

	it('a keydown behind the freeze or the I screen is dropped; a keyup always clears sneak', () => {
		// Catches an ungated keydown (Shift pressed in the I screen would stop his next bounce), and a gated
		// keyup (Shift released while frozen would leave sneak stuck on: no pad would ever work again).
		for (const s of [{ ...free, frozen: true }, { ...free, inventoryOpen: true }]) {
			expect(sneakKeyChange('ShiftLeft', true, s)).toBeNull();
			expect(sneakKeyChange('ShiftLeft', false, s)).toBe(false);
		}
		expect(sneakKeyChange('ShiftRight', true, { ...free, pickerOpen: true })).toBe(true); // movement keys work behind the picker too
	});
});
