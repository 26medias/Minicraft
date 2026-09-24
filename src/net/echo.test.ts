// Multiplayer plan task C4, T7 (spec §6, echo rule).
import { describe, it, expect } from 'vitest';
import { shouldApplyEcho } from './echo';

describe('shouldApplyEcho (spec §6)', () => {
	it('applies an echo when nothing is pending for the cell', () => {
		const pending = new Map<string, number>();
		expect(shouldApplyEcho(pending, '1,2,3', 5)).toBe(true);
		expect(pending.size).toBe(0);
	});

	it('skips an echo when a newer own write to the cell is pending, and keeps the pending entry', () => {
		const pending = new Map([['1,2,3', 2]]);
		expect(shouldApplyEcho(pending, '1,2,3', 1)).toBe(false);
		expect(pending.get('1,2,3')).toBe(2);
	});

	it('applies the echo of the latest own write and forgets the cell', () => {
		const pending = new Map([['1,2,3', 2]]);
		expect(shouldApplyEcho(pending, '1,2,3', 2)).toBe(true);
		expect(pending.has('1,2,3')).toBe(false);
	});

	it('only touches the given cell', () => {
		const pending = new Map([['1,2,3', 2], ['4,5,6', 2]]);
		shouldApplyEcho(pending, '1,2,3', 2);
		expect(pending.get('4,5,6')).toBe(2);
	});
});
