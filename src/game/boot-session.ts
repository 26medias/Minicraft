import type { PlaytimeSession } from './playtime';
import type { LoadedSchedule } from './schedule';
import { scheduleActive, sessionPolicy } from './session-policy';

/**
 * Spec §8.1 refresh rule, applied once at boot before anything reads the stored
 * session: without a PIN, an active schedule or a multiplayer reconnect
 * (`mp:autojoin`), a reload discards the stored play session.
 */
export function bootSession(
	storage: { pin: string | null; schedule: LoadedSchedule; autojoin: boolean },
	load: () => PlaytimeSession | null,
	clear: () => void,
): void {
	if (load() === null) return;
	if (sessionPolicy(storage.pin !== null, scheduleActive(storage.schedule), storage.autojoin) === 'discard') clear();
}
