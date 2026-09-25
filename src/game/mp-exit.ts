import { CLOSE, type ErrorMsg } from '../net/protocol';
import type { StorageLike } from '../net/mp-sync';
import { MP_ERROR_KEY } from '../ui/menu';
import { AUTOJOIN_KEY } from './boot';
import { decideOutdated, UPDATING_SCREEN_MS, withVersionMarker } from './outdated';

export type FatalScreen = 'replaced' | 'updated';

export type FatalDeps = {
	/** sessionStorage. */
	storage: StorageLike;
	reload: () => void;
	/** A full-screen message whose one button reloads (4001: Menu; 4004/4005: reload). */
	showScreen: (kind: FatalScreen) => void;
	/** Outdated auto-reload (spec §5): the "Updating Minicraft…" screen, no button. */
	showUpdating: () => void;
	/** `location.replace`, injected so a test never actually navigates. */
	replace: (url: string) => void;
	/** The current page URL, for building the reload target. */
	href: string;
	now: () => number;
	setTimeout: (fn: () => void, ms: number) => unknown;
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
 *
 * One deliberate exception to K2 (spec §5, gate-2 §12a): a 4004 whose last `error` message was the
 * "outdated" refusal gets a chance at an automatic reload, decided by {@link decideOutdated}. On
 * `auto` this function returns WITHOUT clearing `mp:autojoin` — the ruling keeps it so the reload
 * rejoins the same world and boot()/bootSession() reads the flag as a reconnect, exempting the play
 * timer from the refresh rule exactly like the existing resume reload. On `click`, it falls through
 * to the ordinary K2 clear and the "updated" screen below (today's behaviour).
 */
export function onFatalClose(code: number | undefined, err: ErrorMsg | undefined, deps: FatalDeps): void {
	if (code === CLOSE.proto && err?.message === 'outdated') {
		if (decideOutdated(deps.storage, deps.now()) === 'auto') {
			deps.showUpdating();
			deps.setTimeout(() => deps.replace(withVersionMarker(deps.href, deps.now())), UPDATING_SCREEN_MS);
			return;
		}
	}
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
