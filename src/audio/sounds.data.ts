// The sound files and their base volumes (sound spec §3). Pure data: one row per sound.
import type { BlockSound } from '../data/blocks.base.data';

const sfx = import.meta.glob('../assets/sounds/sfx/*.mp3', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const ambient = import.meta.glob('../assets/sounds/ambient/*.mp3', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

const url = (files: Record<string, string>, base: string): string => {
	const key = Object.keys(files).find((k) => k.endsWith(`/${base}.mp3`));
	if (!key) throw new Error(`missing sound file ${base}.mp3`);
	return files[key];
};

// Base volumes even out the files' own loudness (measured with ffmpeg ebur128, kid-lens review
// 2026-09-26), so a slider moves every sound together. Gains above 1 are safe: those files peak
// at −21 dBFS or lower, and the master bus has a limiter.
export const SOUND_VOLUME = {
	hit_stone: 0.47,
	hit_dirt: 0.31,
	hit_wood: 0.47,
	hit_sand: 0.36,
	hit_leaves: 1.0,
	hit_glass: 3.0,
	break_stone: 0.75,
	break_dirt: 1.0,
	break_wood: 0.6,
	break_sand: 0.27,
	break_leaves: 0.42,
	break_glass: 0.56,
	place_soft: 0.8,
	place_hard: 1.25,
	pickup: 2.4,
	splash: 0.68,
	tnt: 0.8,
	amb_lake: 0.56,
	amb_stream: 1.6,
	amb_waterfall: 0.32,
	amb_wind_light: 0.7,
	amb_wind_strong: 0.3,
} as const;

export type SoundName = keyof typeof SOUND_VOLUME;

export const SOUND_FILES: Record<SoundName, string> = Object.fromEntries(
	(Object.keys(SOUND_VOLUME) as SoundName[]).map((name) => [
		name,
		name.startsWith('amb_') ? url(ambient, name.slice(4)) : url(sfx, name),
	]),
) as Record<SoundName, string>;

export const hitSound = (m: BlockSound): SoundName => `hit_${m}`;
export const breakSound = (m: BlockSound): SoundName => `break_${m}`;
export const placeSound = (m: BlockSound): SoundName => (m === 'stone' || m === 'glass' ? 'place_hard' : 'place_soft');

/** Music files and their levelling gains (same review). */
const music = import.meta.glob('../assets/sounds/music/*.mp3', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
export const MUSIC_TRACKS: { url: string; gain: number }[] = [
	{ url: url(music, 'morning_piano'), gain: 0.45 },
	{ url: url(music, 'building_time'), gain: 0.6 },
	{ url: url(music, 'over_the_mountains'), gain: 0.46 },
	{ url: url(music, 'forest_clearing'), gain: 1.0 },
];
