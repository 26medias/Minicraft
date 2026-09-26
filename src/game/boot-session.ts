import type { PlaytimeSession } from './playtime';
import { planActive, type LoadedPlan } from './plan';
import { sessionPolicy } from './session-policy';

/**
 * Spec §8.1 refresh rule, applied once at boot before anything reads the stored
 * session: without a PIN, a parent's plan or a multiplayer reconnect
 * (`mp:autojoin`), a reload discards the stored play session.
 */
export function bootSession(
	storage: { pin: string | null; plan: LoadedPlan; autojoin: boolean },
	load: () => PlaytimeSession | null,
	clear: () => void,
): void {
	if (load() === null) return;
	if (sessionPolicy(storage.pin !== null, planActive(storage.plan), storage.autojoin) === 'discard') clear();
}
