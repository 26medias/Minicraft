import { ACTIONS, DEFAULT_KEYBINDINGS, type Action, type Options } from '../data/keybindings.data';

const KEY = 'minicraft:v1:options';
const DEFAULT_LIGHT_COLOR = '#FFF5E0'; // warm white

function defaults(): Options {
	return {
		kidMode: true,
		keybindings: { ...DEFAULT_KEYBINDINGS },
		currentLightColor: DEFAULT_LIGHT_COLOR,
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
			kidMode: parsed.kidMode ?? true,
			keybindings: filteredBindings,
			currentLightColor: parsed.currentLightColor ?? DEFAULT_LIGHT_COLOR,
		};
	} catch {
		return defaults();
	}
}

export function saveOptions(opts: Options) {
	localStorage.setItem(KEY, JSON.stringify(opts));
}
