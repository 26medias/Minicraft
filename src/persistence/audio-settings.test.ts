import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AUDIO_DEFAULTS, loadAudioSettings, saveAudioSettings } from './audio-settings';

const store: Record<string, string> = {};
beforeEach(() => {
	for (const k of Object.keys(store)) delete store[k];
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => store[k] ?? null,
		setItem: (k: string, v: string) => {
			store[k] = v;
		},
	});
});
afterEach(() => vi.unstubAllGlobals());

describe('audio settings', () => {
	it('defaults when nothing is saved', () => {
		expect(loadAudioSettings()).toEqual({ music: 50, sfx: 80, ambient: 80 });
	});

	it('round-trips', () => {
		saveAudioSettings({ music: 0, sfx: 100, ambient: 35 });
		expect(loadAudioSettings()).toEqual({ music: 0, sfx: 100, ambient: 35 });
	});

	it('replaces each bad value with its default, keeping the good ones', () => {
		store['minicraft:v1:audio'] = JSON.stringify({ music: '30', sfx: 101, ambient: 20.5 });
		expect(loadAudioSettings()).toEqual(AUDIO_DEFAULTS);
		store['minicraft:v1:audio'] = JSON.stringify({ music: 10, sfx: -1 });
		expect(loadAudioSettings()).toEqual({ music: 10, sfx: 80, ambient: 80 });
	});

	it('survives broken JSON', () => {
		store['minicraft:v1:audio'] = '{nope';
		expect(loadAudioSettings()).toEqual(AUDIO_DEFAULTS);
	});
});
