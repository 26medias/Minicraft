import { describe, it, expect } from 'vitest';
import { controlRows, keyText } from './controls-model';
import { DEFAULT_KEYBINDINGS } from '../data/keybindings.data';

const row = (rows: { does: string; keys: string }[], does: string) => rows.find((r) => r.does === does);

describe('keyText', () => {
	it('shows keys the way the kid sees them on the keyboard', () => {
		expect(keyText('KeyW')).toBe('W');
		expect(keyText('Digit3')).toBe('3');
		expect(keyText('Numpad3')).toBe('Num 3');
		expect(keyText('Space')).toBe('Space');
		expect(keyText('Equal')).toBe('=');
		expect(keyText('Minus')).toBe('-');
		expect(keyText('ShiftLeft')).toBe('Shift');
		expect(keyText('Escape')).toBe('Esc');
		expect(keyText('ArrowUp')).toBe('↑');
		expect(keyText('F7')).toBe('F7');
	});
});

describe('controlRows (spec §3.5)', () => {
	it('lists the default controls in order, kid words', () => {
		const rows = controlRows({ ...DEFAULT_KEYBINDINGS });
		expect(rows.map((r) => r.does)).toEqual([
			'Walk', 'Jump', 'Mine', 'Build', 'Swap a block', 'Choose a block', 'Inventory', 'Change pickaxe',
			'Fly', 'Fly faster / slower', 'Light TNT', 'Lamp color', 'Stop bouncing', 'Menu',
		]);
		expect(row(rows, 'Walk')!.keys).toBe('W A S D');
		expect(row(rows, 'Jump')!.keys).toBe('Space');
		expect(row(rows, 'Fly faster / slower')!.keys).toBe('= / -');
		expect(row(rows, 'Choose a block')!.keys).toBe('1 – 9, Tab');
		expect(row(rows, 'Menu')!.keys).toBe('Esc');
	});
	it('follows a rebinding', () => {
		const rows = controlRows({ ...DEFAULT_KEYBINDINGS, jump: 'KeyJ' });
		expect(row(rows, 'Jump')!.keys).toBe('J');
	});
	it('leaves out an unbound key, and a row whose keys are all unbound', () => {
		const rows = controlRows({ ...DEFAULT_KEYBINDINGS, flySpeedDown: '', ignite: '' });
		expect(row(rows, 'Fly faster / slower')!.keys).toBe('=');
		expect(row(rows, 'Light TNT')).toBeUndefined();
	});
	it('lists the nine slot keys when they are not Digit1…Digit9', () => {
		const rows = controlRows({ ...DEFAULT_KEYBINDINGS, slot1: 'KeyZ' });
		expect(row(rows, 'Choose a block')!.keys).toBe('Z 2 3 4 5 6 7 8 9, Tab');
	});
	it('never shows a key that does nothing: a code bound twice shows on the later action only', () => {
		// buildKeyToAction: the later action in ACTIONS wins; toggleFly comes after jump.
		const rows = controlRows({ ...DEFAULT_KEYBINDINGS, toggleFly: DEFAULT_KEYBINDINGS.jump });
		expect(row(rows, 'Jump')).toBeUndefined();
		expect(row(rows, 'Fly')!.keys).toBe('Space');
	});
});
