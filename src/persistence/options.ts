import { DEFAULT_KEYBINDINGS, type Options } from '../data/keybindings.data';

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
		return {
			kidMode: parsed.kidMode ?? true,
			keybindings: { ...DEFAULT_KEYBINDINGS, ...(parsed.keybindings ?? {}) },
			currentLightColor: parsed.currentLightColor ?? DEFAULT_LIGHT_COLOR,
		};
	} catch {
		return defaults();
	}
}

export function saveOptions(opts: Options) {
	localStorage.setItem(KEY, JSON.stringify(opts));
}
