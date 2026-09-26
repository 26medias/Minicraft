/**
 * The three volumes of the Audio screen (sound spec §8), 0–100. Kept under their own key, not in
 * Options: main.ts holds an Options copy from world start and saves it back (light colour), which
 * would put back old volumes.
 */
export type AudioSettings = { music: number; sfx: number; ambient: number };

const KEY = 'minicraft:v1:audio';
export const AUDIO_DEFAULTS: AudioSettings = { music: 50, sfx: 80, ambient: 80 };

function volume(value: unknown, fallback: number): number {
	return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100 ? (value as number) : fallback;
}

export function loadAudioSettings(): AudioSettings {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return { ...AUDIO_DEFAULTS };
		const p = JSON.parse(raw) as Record<string, unknown>;
		return {
			music: volume(p.music, AUDIO_DEFAULTS.music),
			sfx: volume(p.sfx, AUDIO_DEFAULTS.sfx),
			ambient: volume(p.ambient, AUDIO_DEFAULTS.ambient),
		};
	} catch {
		return { ...AUDIO_DEFAULTS };
	}
}

export function saveAudioSettings(s: AudioSettings): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(s));
	} catch {
		// storage full or blocked: the volumes still apply for this session
	}
}
