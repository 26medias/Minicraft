import { loadAudioSettings, saveAudioSettings, type AudioSettings } from '../persistence/audio-settings';
import { SOUND_FILES, SOUND_VOLUME, type SoundName } from './sounds.data';

/**
 * The one AudioContext of the game (sound spec §3): three buses (sounds, nature, music) into a
 * master gain. The context is created by the first click or key (autoplay rules), and every
 * sound asked for before its file is decoded is dropped, not queued.
 */
export type Bus = 'sfx' | 'ambient' | 'music';

export type LoopHandle = {
	/** Move the loop's level (0..1) with a smoothing time constant in seconds. */
	setLevel(level: number, timeConstant: number): void;
	stop(): void;
};

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const buses = new Map<Bus, GainNode>();
/** The in-game duck (pause menu or inventory open): multiplies the sounds and nature buses. */
let duck = 1;
let settings: AudioSettings = loadAudioSettings();
const buffers = new Map<SoundName, AudioBuffer>();
const loopStarts = new Map<SoundName, number>();
let loading: Promise<void> | null = null;

/** Test hook (sound-smoke): every one-shot that actually starts, by name. */
declare global {
	interface Window {
		__soundLog?: string[];
	}
}

export function audioContext(): AudioContext | null {
	if (ctx) {
		if (ctx.state === 'suspended' && document.visibilityState === 'visible') void ctx.resume();
		return ctx;
	}
	try {
		ctx = new AudioContext();
	} catch {
		return null; // no Web Audio: stay silent
	}
	master = ctx.createGain();
	// A limiter on everything (kid-lens review): stacked booms and the hottest loops must not
	// distort laptop speakers.
	const limiter = ctx.createDynamicsCompressor();
	limiter.threshold.value = -10;
	limiter.knee.value = 0;
	limiter.ratio.value = 12;
	limiter.attack.value = 0.003;
	limiter.release.value = 0.25;
	master.connect(limiter).connect(ctx.destination);
	for (const b of ['sfx', 'ambient', 'music'] as const) {
		const g = ctx.createGain();
		g.connect(master);
		buses.set(b, g);
	}
	applyVolumes();
	return ctx;
}

export function bus(b: Bus): GainNode | null {
	return audioContext() ? buses.get(b)! : null;
}

/** 0–100 slider to gain: squared, so the low half of the slider is usable. */
function gainOf(v: number): number {
	return (v / 100) ** 2;
}

function applyVolumes(): void {
	if (!ctx) return;
	const t = ctx.currentTime;
	buses.get('sfx')!.gain.setTargetAtTime(gainOf(settings.sfx) * duck, t, 0.05);
	buses.get('ambient')!.gain.setTargetAtTime(gainOf(settings.ambient) * duck, t, 0.05);
	buses.get('music')!.gain.setTargetAtTime(gainOf(settings.music), t, 0.05);
}

export function getAudioSettings(): AudioSettings {
	return { ...settings };
}

/** Live from the Audio screen's sliders; saved each time. */
export function setAudioSettings(next: AudioSettings): void {
	settings = { ...next };
	saveAudioSettings(settings);
	applyVolumes();
	for (const fn of settingsListeners) fn(settings);
}

const settingsListeners: ((s: AudioSettings) => void)[] = [];
export function onAudioSettings(fn: (s: AudioSettings) => void): void {
	settingsListeners.push(fn);
}

export function setDuck(factor: number): void {
	duck = factor;
	applyVolumes();
}

/**
 * A seamless loop point (engine review: wind_strong clicks where it wraps). The last `n` samples
 * are faded into the first `n`, and the loop restarts at `n`: the sample after the end is then
 * exactly the one that followed the blended tail. Returns the loop start in samples.
 */
export function crossfadeLoop(channels: Float32Array[], n: number): number {
	for (const ch of channels) {
		const end = ch.length;
		if (end < 4 * n) return 0;
		for (let i = 0; i < n; i++) {
			const t = (i + 1) / n; // the last tail sample becomes exactly ch[n - 1]
			ch[end - n + i] = ch[end - n + i] * (1 - t) + ch[i] * t;
		}
	}
	return n;
}

/** Decode every effect and loop, once. Music streams (music.ts). */
export function loadSounds(): Promise<void> {
	const a = audioContext();
	if (!a) return Promise.resolve();
	loading ??= Promise.all(
		(Object.keys(SOUND_FILES) as SoundName[]).map(async (name) => {
			try {
				const res = await fetch(SOUND_FILES[name]);
				const buf = await a.decodeAudioData(await res.arrayBuffer());
				buffers.set(name, buf);
				if (name.startsWith('amb_')) {
					const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
					loopStarts.set(name, crossfadeLoop(chans, Math.round(buf.sampleRate * 0.01)) / buf.sampleRate);
				}
			} catch {
				// a missing or broken file stays silent
			}
		}),
	).then(() => undefined);
	return loading;
}

export function soundsReady(): boolean {
	return buffers.size > 0;
}

/**
 * A one-shot on the sounds bus. `gain` is on top of the file's base volume (distance falloff for
 * other players' sounds); the rate is jittered ±6% so repeats don't sound mechanical.
 */
export function playSound(name: SoundName, gain = 1, delay = 0): void {
	if (gain <= 0) return;
	const a = audioContext();
	const buf = buffers.get(name);
	if (!a || !buf) return;
	const src = a.createBufferSource();
	src.buffer = buf;
	src.playbackRate.value = 0.94 + Math.random() * 0.12;
	const g = a.createGain();
	g.gain.value = SOUND_VOLUME[name] * gain;
	src.connect(g).connect(buses.get('sfx')!);
	src.start(a.currentTime + delay);
	window.__soundLog?.push(name);
}

/** A seamless loop on the nature bus, starting silent. Null until its file is decoded. */
export function startLoop(name: SoundName): LoopHandle | null {
	const a = audioContext();
	const buf = buffers.get(name);
	if (!a || !buf) return null;
	const src = a.createBufferSource();
	src.buffer = buf;
	src.loop = true;
	const start = loopStarts.get(name) ?? 0;
	src.loopStart = start;
	src.loopEnd = buf.duration;
	const g = a.createGain();
	g.gain.value = 0;
	src.connect(g).connect(buses.get('ambient')!);
	src.start(a.currentTime, start);
	const base = SOUND_VOLUME[name];
	return {
		setLevel(level, tc) {
			g.gain.setTargetAtTime(level * base, a.currentTime, tc);
		},
		stop() {
			g.gain.setTargetAtTime(0, a.currentTime, 0.15);
			src.stop(a.currentTime + 0.8);
		},
	};
}

/** A tab in the background goes quiet (rAF stops too); back in front, it resumes. */
export function installVisibilityHandling(): void {
	document.addEventListener('visibilitychange', () => {
		if (!ctx) return;
		if (document.visibilityState === 'hidden') void ctx.suspend();
		else void ctx.resume();
	});
}
