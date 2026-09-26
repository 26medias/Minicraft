import type { PlaytimeSession } from './playtime';
import { rulesActive, type LoadedRules } from './rules';
import { sessionPolicy } from './session-policy';

/**
 * Spec §8.1 refresh rule, applied once at boot before anything reads the stored
 * session: without a PIN, parent rules or a multiplayer reconnect
 * (`mp:autojoin`), a reload discards the stored play session.
 */
export function bootSession(
	storage: { pin: string | null; rules: LoadedRules; autojoin: boolean },
	load: () => PlaytimeSession | null,
	clear: () => void,
): void {
	if (load() === null) return;
	if (sessionPolicy(storage.pin !== null, rulesActive(storage.rules), storage.autojoin) === 'discard') clear();
}
