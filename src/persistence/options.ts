import { ACTIONS, DEFAULT_KEYBINDINGS, type Action, type Options } from '../data/keybindings.data';
import { PLAY_BREAK_CHOICES_MIN, PLAY_LIMIT_CHOICES_MIN } from '../data/playtime.data';

const KEY = 'minicraft:v1:options';
const DEFAULT_LIGHT_COLOR = '#FFF5E0'; // warm white

/** Only a member of the choice list gets through; a string "30" must not reach the timer arithmetic. */
function choiceOrNull(value: unknown, choices: number[]): number | null {
	return typeof value === 'number' && choices.includes(value) ? value : null;
}

function defaults(): Options {
	return {
		keybindings: { ...DEFAULT_KEYBINDINGS },
		currentLightColor: DEFAULT_LIGHT_COLOR,
		playLimitMin: null,
		playBreakMin: null,
	};
}

export function loadOptions(): Options {
	const raw = localStorage.getItem(KEY);
	if (!raw) return defaults();
	try {
		const parsed = JSON.parse(raw) as Partial<Options>;
		// Merge saved bindings over defaults, then strip any keys that are no longer
		// valid Actions (e.g. stale 'flyUp' / 'flyDown' from older saves). Without
		// this filter, a stale key like { flyUp: 'Space' } would overwrite the
		// jump binding during keyToAction construction in main.ts.
		const saved = parsed.keybindings ?? {};
		const filteredBindings = {} as Record<Action, string>;
		for (const action of ACTIONS) {
			filteredBindings[action] =
				(saved as Record<string, string>)[action] ?? DEFAULT_KEYBINDINGS[action];
		}
		return {
			keybindings: filteredBindings,
			currentLightColor: parsed.currentLightColor ?? DEFAULT_LIGHT_COLOR,
			playLimitMin: choiceOrNull(parsed.playLimitMin, PLAY_LIMIT_CHOICES_MIN),
			playBreakMin: choiceOrNull(parsed.playBreakMin, PLAY_BREAK_CHOICES_MIN),
		};
	} catch {
		return defaults();
	}
}

export function saveOptions(opts: Options) {
	localStorage.setItem(KEY, JSON.stringify(opts));
}
