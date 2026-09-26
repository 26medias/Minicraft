import { describe, it, expect } from 'vitest';
import { escapeAction, shouldOpenOnUnlock, type PauseState } from './pause-model';

const idle: PauseState = { locked: false, pauseOpen: false, controlsShown: false, quitting: false, inventoryOpen: false, pickerOpen: false, frozen: false };

describe('shouldOpenOnUnlock (spec §3.1 a)', () => {
	it('opens on an unlock nobody owns (the real Esc, alt-tab)', () => {
		expect(shouldOpenOnUnlock(idle)).toBe(true);
	});
	it('does not open when the I screen, the colour picker or a freeze released the pointer', () => {
		expect(shouldOpenOnUnlock({ ...idle, inventoryOpen: true })).toBe(false);
		expect(shouldOpenOnUnlock({ ...idle, pickerOpen: true })).toBe(false);
		expect(shouldOpenOnUnlock({ ...idle, frozen: true })).toBe(false);
	});
	it('does not open twice, nor while quitting', () => {
		expect(shouldOpenOnUnlock({ ...idle, pauseOpen: true })).toBe(false);
		expect(shouldOpenOnUnlock({ ...idle, quitting: true })).toBe(false);
	});
});

describe('escapeAction (spec §3.1 b, §3.2)', () => {
	it('opens on Esc with the pointer free and nothing open', () => {
		expect(escapeAction(idle, false)).toBe('open');
	});
	it('does nothing on the Esc that closes the I screen or the colour picker, or under a freeze', () => {
		expect(escapeAction({ ...idle, inventoryOpen: true }, false)).toBe('none');
		expect(escapeAction({ ...idle, pickerOpen: true }, false)).toBe('none');
		expect(escapeAction({ ...idle, frozen: true }, false)).toBe('none');
	});
	it('does nothing while locked (a headless CDP Esc; the real one never arrives, M1)', () => {
		expect(escapeAction({ ...idle, locked: true }, false)).toBe('none');
	});
	it('does nothing on the pause card: Esc can never give the mouse back (M3)', () => {
		expect(escapeAction({ ...idle, pauseOpen: true }, false)).toBe('none');
	});
	it('goes back from the Controls view', () => {
		expect(escapeAction({ ...idle, pauseOpen: true, controlsShown: true }, false)).toBe('back');
	});
	it('ignores auto-repeat and anything while quitting', () => {
		expect(escapeAction(idle, true)).toBe('none');
		expect(escapeAction({ ...idle, pauseOpen: true, controlsShown: true }, true)).toBe('none');
		expect(escapeAction({ ...idle, quitting: true }, false)).toBe('none');
		expect(escapeAction({ ...idle, pauseOpen: true, controlsShown: true, quitting: true }, false)).toBe('none');
	});
});
