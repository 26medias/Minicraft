/**
 * The pause menu's decisions (pause menu spec §3.1–§3.2), pure so they are unit tested.
 * main.ts builds the state from its own flags; `locked` is read from document.pointerLockElement.
 */
export type PauseState = {
	locked: boolean;
	pauseOpen: boolean;
	controlsShown: boolean;
	quitting: boolean;
	inventoryOpen: boolean;
	pickerOpen: boolean;
	frozen: boolean;
};

/** The I screen, the colour picker, a freeze or a quit in progress owns the screen. */
function ownedElsewhere(s: PauseState): boolean {
	return s.inventoryOpen || s.pickerOpen || s.frozen || s.quitting;
}

/** Rule (a): a pointer unlock nobody owns — the real Esc (M1), alt-tab — opens the menu. */
export function shouldOpenOnUnlock(s: PauseState): boolean {
	return !s.pauseOpen && !ownedElsewhere(s);
}

export type EscapeAction = 'open' | 'back' | 'none';

/**
 * An Escape keydown, judged on the state from BEFORE any other Esc handler of this event ran
 * (main.ts listens in the capture phase, spec §5.2). Esc on the pause card does nothing: a lock
 * requested from Esc is always refused or dropped (M3), so it could never resume the game.
 */
export function escapeAction(s: PauseState, repeat: boolean): EscapeAction {
	if (repeat || s.quitting) return 'none';
	if (s.pauseOpen) return s.controlsShown ? 'back' : 'none';
	if (s.locked || ownedElsewhere(s)) return 'none';
	return 'open';
}
