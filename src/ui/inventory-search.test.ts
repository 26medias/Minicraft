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
});
