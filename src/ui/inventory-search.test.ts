import { describe, it, expect } from 'vitest';
import { matchesSearch, searchKey } from './craft-model';

describe('matchesSearch: the Blocks-tab search box', () => {
	it('matches the label, ignoring case and surrounding spaces (catches a case-sensitive match, which misses "diamond" in "Deepslate Diamond Ore")', () => {
		expect(matchesSearch('Deepslate Diamond Ore', 'diamond')).toBe(true);
		expect(matchesSearch('Deepslate Diamond Ore', '  DIAMOND ')).toBe(true);
		expect(matchesSearch('Oak Log', 'diamond')).toBe(false);
	});

	it('an empty or blank query matches everything (catches an empty box hiding every block)', () => {
		expect(matchesSearch('Stone', '')).toBe(true);
		expect(matchesSearch('Stone', '   ')).toBe(true);
	});

	it('matches anywhere in the name, not only at the start (catches a prefix match, which misses "ore" in "Iron Ore")', () => {
		expect(matchesSearch('Iron Ore', 'ore')).toBe(true);
		expect(matchesSearch('White Wool', 'wool')).toBe(true);
	});
});

describe('searchKey: what a key does while the search box has focus', () => {
	it('Escape with text clears the box; Escape on an empty box closes the I screen (catches Esc closing the screen and losing the search, or never closing it)', () => {
		expect(searchKey('Escape', 'dia')).toBe('clear');
		expect(searchKey('Escape', '')).toBe('close');
	});

	it('every other key stays in the box, including digits, I, Tab and Shift (catches typing "1" changing the hotbar slot, or "i" closing the screen)', () => {
		for (const code of ['Digit1', 'KeyI', 'KeyE', 'Tab', 'ShiftLeft', 'Space', 'KeyW']) expect(searchKey(code, 'x'), code).toBe('type');
	});

	it('Enter over a code-shaped query submits, from Enter, NumpadEnter or a virtual keyboard (catches Enter not distinguished, or code === "" ignored)', () => {
		expect(searchKey('Enter', 'big boom')).toBe('submit');
		expect(searchKey('NumpadEnter', 'x')).toBe('submit');
		expect(searchKey('', 'x', false, 'Enter')).toBe('submit');
	});

	it('Enter over an empty or punctuation-only box, or during IME composition, only types (catches an empty-box submit or a lost IME guard)', () => {
		expect(searchKey('Enter', '')).toBe('type');
		expect(searchKey('Enter', '  !! ')).toBe('type');
		expect(searchKey('Enter', 'x', true)).toBe('type');
	});

	it('I and P type into the box (J1: the game never sees them while he types)', () => {
		expect(searchKey('KeyI', 'x')).toBe('type');
		expect(searchKey('KeyP', 'x')).toBe('type');
	});
});
