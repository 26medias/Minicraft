import { getAudioSettings, playSound, setAudioSettings } from '../audio/engine';
import type { AudioSettings } from '../persistence/audio-settings';

const ROWS: { key: keyof AudioSettings; label: string }[] = [
	{ key: 'music', label: 'Music' },
	{ key: 'sfx', label: 'Sound effects' },
	{ key: 'ambient', label: 'Nature' },
];

/**
 * The Audio screen's three sliders (sound spec §8), shared by the Esc menu and the main menu so the
 * two cannot drift apart. Applied live while dragging, saved on every change.
 */
export function buildAudioPanel(card: HTMLElement): void {
	const s = getAudioSettings();
	for (const { key, label } of ROWS) {
		const row = document.createElement('label');
		row.className = 'audio-row';
		const name = document.createElement('span');
		name.className = 'audio-name';
		name.textContent = label;
		const input = document.createElement('input');
		input.type = 'range';
		input.id = `audio-${key}`;
		input.min = '0';
		input.max = '100';
		input.step = '5';
		input.value = String(s[key]);
		const value = document.createElement('span');
		value.className = 'audio-value';
		const paint = () => (value.textContent = input.value === '0' ? 'Off' : `${input.value}%`);
		paint();
		input.oninput = () => {
			paint();
			setAudioSettings({ ...getAudioSettings(), [key]: Number(input.value) });
		};
		// Let the effects level be judged by ear (spec §8).
		if (key === 'sfx') input.onchange = () => playSound('place_soft');
		row.append(name, input, value);
		card.appendChild(row);
	}
}
