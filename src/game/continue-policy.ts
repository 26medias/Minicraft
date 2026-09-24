import type { WorldSave } from '../persistence/adapter';
import { SaveMismatch } from '../persistence/errors';

export type LoadOutcome = { save: WorldSave | null } | { error: unknown };
export type ContinueDecision = { ok: true; save: WorldSave } | { ok: false; notice: string };

/**
 * Whether "Continue" may start the game. Refusing is the whole point: starting
 * on a fresh world after a failed load makes the first autosave prune the local
 * copy to zero chunks (main.ts used to console.warn and carry on).
 */
export function resolveContinue(outcome: LoadOutcome, worldName: string): ContinueDecision {
	if ('error' in outcome) {
		const err = outcome.error;
		if (err instanceof SaveMismatch) {
			return { ok: false, notice: `${worldName} has two different copies (this device and the cloud). Ask a parent. Nothing was changed.` };
		}
		const name = err instanceof Error ? err.name : 'Error';
		return { ok: false, notice: `Couldn't open ${worldName} (${name}). Nothing was changed.` };
	}
	if (outcome.save === null) return { ok: false, notice: `Couldn't find the save for ${worldName}. Nothing was changed.` };
	return { ok: true, save: outcome.save };
}
