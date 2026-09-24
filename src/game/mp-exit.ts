import { CLOSE } from '../net/protocol';
import type { StorageLike } from '../net/mp-sync';
import { MP_ERROR_KEY } from '../ui/menu';
import { AUTOJOIN_KEY } from './boot';

export type FatalScreen = 'replaced' | 'updated';

export type FatalDeps = {
	/** sessionStorage. */
	storage: StorageLike;
	reload: () => void;
	/** A full-screen message whose one button reloads (4001: Menu; 4004/4005: reload). */
	showScreen: (kind: FatalScreen) => void;
};

/** Close code → the reason the Multiplayer screen shows after the reload (menu.ts reads MP_ERROR_KEY). */
const REASON: Partial<Record<number, string>> = {
	[CLOSE.unknownWorld]: 'unknown_world',
	[CLOSE.badToken]: 'bad_token',
	[CLOSE.badName]: 'bad_name',
	[CLOSE.nameTaken]: 'name_taken',
};

/**
 * A close that must not reconnect (spec §5). Gate-2 K2: `mp:autojoin` is cleared FIRST, before any
 * screen or reload, so no fatal close can loop.
 * - 4001: "You opened the game somewhere else." with a Menu button.
 * - 4004/4005 (and two 4003s in a row, reported by MpClient as 4004): "Minicraft was updated".
 * - 4006–4009: a one-shot reason, then a reload into the Multiplayer screens.
 */
export function onFatalClose(code: number | undefined, deps: FatalDeps): void {
	try {
		deps.storage.removeItem(AUTOJOIN_KEY);
	} catch {
		// Storage unavailable: the flag could not have been stored either.
	}
	if (code === CLOSE.replaced) {
		deps.showScreen('replaced');
		return;
	}
	if (code === CLOSE.proto || code === CLOSE.genUnsupported) {
		deps.showScreen('updated');
		return;
	}
	const reason = code === undefined ? undefined : REASON[code];
	if (reason) {
		try {
			deps.storage.setItem(MP_ERROR_KEY, reason);
		} catch {
			// The reason is lost; the reload still lands on the menu.
		}
	}
	deps.reload();
}
