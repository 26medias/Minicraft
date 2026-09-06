import { describe, it, expect } from 'vitest';
import { shouldHandleKey } from './input-gate';

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
});
