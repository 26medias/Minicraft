import { ACTIONS, DEFAULT_KEYBINDINGS, type Action, type Options } from '../data/keybindings.data';
import { DURATION_CHOICES_MIN } from '../data/playtime.data';

const KEY = 'minicraft:v1:options';
const DEFAULT_LIGHT_COLOR = '#FFF5E0'; // warm white

/** Only a member of the choice list gets through; a string "30" must not reach the timer arithmetic. */
function choiceOrNull(value: unknown, choices: number[]): number | null {
	return typeof value === 'number' && choices.includes(value) ? value : null;
}

/**
 * Spec §8.3: the parent's maximum. A stored `maxDurationMin` (even null) wins;
 * otherwise the old `playLimitMin` becomes the maximum (null = No limit).
 * `playBreakMin` is dropped: break time no longer exists.
 */
function migrateMaxDuration(parsed: Record<string, unknown>): number | null {
	if ('maxDurationMin' in parsed) return choiceOrNull(parsed.maxDurationMin, DURATION_CHOICES_MIN);
	if ('playLimitMin' in parsed) return choiceOrNull(parsed.playLimitMin, DURATION_CHOICES_MIN);
	return null;
}

function defaults(): Options {
	return {
		keybindings: { ...DEFAULT_KEYBINDINGS },
		currentLightColor: DEFAULT_LIGHT_COLOR,
		maxDurationMin: null,
	};
}

export function loadOptions(): Options {
	const raw = localStorage.getItem(KEY);
	if (!raw) return defaults();
	try {
		const parsed = JSON.parse(raw) as Partial<Options> & { playLimitMin?: unknown };
		// Merge saved bindings over defaults, then strip any keys that are no longer
		// valid Actions (e.g. stale 'flyUp' / 'flyDown' from older saves). Without
		// this filter, a stale key like { flyUp: 'Space' } would overwrite the
		// jump binding during keyToAction construction in main.ts.
		const saved = (parsed.keybindings ?? {}) as Record<string, unknown>;
		// A default for an action missing from the save (one added since, like cyclePickaxe) is
		// used only if no saved binding already holds that key; otherwise the new action loads
		// unbound (''), so the key keeps doing what the player chose (spec §11).
		const taken = new Set<string>();
		for (const action of ACTIONS) {
			const code = saved[action];
			if (typeof code === 'string' && code !== '') taken.add(code);
		}
		const filteredBindings = {} as Record<Action, string>;
		for (const action of ACTIONS) {
			const code = saved[action];
			if (typeof code === 'string') filteredBindings[action] = code;
			else filteredBindings[action] = taken.has(DEFAULT_KEYBINDINGS[action]) ? '' : DEFAULT_KEYBINDINGS[action];
		}
		return {
			keybindings: filteredBindings,
			currentLightColor: parsed.currentLightColor ?? DEFAULT_LIGHT_COLOR,
			maxDurationMin: migrateMaxDuration(parsed),
		};
	} catch {
		return defaults();
	}
}

export function saveOptions(opts: Options) {
	localStorage.setItem(KEY, JSON.stringify(opts));
}
