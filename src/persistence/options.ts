import { DEFAULT_KEYBINDINGS, type Options } from '../data/keybindings.data';

const KEY = 'minicraft:v1:options';

export function loadOptions(): Options {
	const raw = localStorage.getItem(KEY);
	if (!raw) return { kidMode: true, keybindings: { ...DEFAULT_KEYBINDINGS } };
	try {
		const parsed = JSON.parse(raw) as Partial<Options>;
		return {
			kidMode: parsed.kidMode ?? true,
			keybindings: { ...DEFAULT_KEYBINDINGS, ...(parsed.keybindings ?? {}) },
		};
	} catch {
		return { kidMode: true, keybindings: { ...DEFAULT_KEYBINDINGS } };
	}
}

export function saveOptions(opts: Options) {
	localStorage.setItem(KEY, JSON.stringify(opts));
}
