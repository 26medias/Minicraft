import { audioContext, bus, getAudioSettings } from './engine';
import { between, FIRST_TRACK_MS, nextTrack, TRACK_GAP_MS } from './rules';
import { MUSIC_TRACKS } from './sounds.data';

/**
 * Background music (sound spec §7): a playlist that loops, one track after another with a few
 * seconds between, shuffled, never the same twice in a row. Each track streams through an <audio> element into the music bus.
 */
class MusicPlayer {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private el: HTMLAudioElement | null = null;
	private fade: GainNode | null = null;
	private prev: number | null = null;
	private running = false;

	get isRunning(): boolean {
		return this.running;
	}

	/** A track is sounding right now (dev oracle for sound-smoke). */
	get playing(): boolean {
		return this.el !== null && !this.el.paused;
	}

	/** Which track is sounding, or null (dev oracle). */
	get track(): number | null {
		return this.playing ? this.prev : null;
	}

	/** Dev oracle: jump the current track to its last half second, to see the next one follow. */
	skipToEnd(): void {
		if (this.el && Number.isFinite(this.el.duration)) this.el.currentTime = this.el.duration - 0.5;
	}

	/**
	 * From the first click or key on the page, main menu included (Julien: music should already play
	 * there): the first track in 1–3 s, then long gaps. Already running (menu → game): nothing changes.
	 */
	start(): void {
		if (this.running) return;
		this.running = true;
		this.schedule(between(FIRST_TRACK_MS, Math.random));
	}

	/** Quit or play-time lock: fade out over 0.5 s and cancel what was coming. */
	stop(): void {
		this.running = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		const el = this.el;
		const fade = this.fade;
		this.el = null;
		this.fade = null;
		if (el && fade) {
			const a = audioContext();
			if (a) fade.gain.setTargetAtTime(0, a.currentTime, 0.15);
			setTimeout(() => {
				el.pause();
				el.removeAttribute('src');
				fade.disconnect();
			}, 600);
		}
	}

	private schedule(ms: number): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => this.play(), ms);
	}

	private play(): void {
		this.timer = null;
		if (!this.running) return;
		const a = audioContext();
		const out = bus('music');
		// Sound not running yet (the context is still resuming, or the tab is hidden): try again soon.
		if (!a || !out || a.state !== 'running') {
			this.schedule(2_000);
			return;
		}
		// Music at 0 does not start tracks at all (spec §8); look again soon, so turning it up starts it.
		if (getAudioSettings().music === 0) {
			this.schedule(5_000);
			return;
		}
		const i = nextTrack(this.prev, MUSIC_TRACKS.length, Math.random);
		this.prev = i;
		const el = new Audio(MUSIC_TRACKS[i].url);
		const fade = a.createGain();
		fade.gain.value = 0;
		fade.gain.setTargetAtTime(MUSIC_TRACKS[i].gain, a.currentTime, 0.7); // ~2 s fade in
		a.createMediaElementSource(el).connect(fade).connect(out);
		el.onended = () => {
			fade.disconnect();
			if (this.el === el) {
				this.el = null;
				this.fade = null;
				this.schedule(between(TRACK_GAP_MS, Math.random));
			}
		};
		this.el = el;
		this.fade = fade;
		void el.play().catch(() => {
			// refused (no gesture yet): try again later
			if (this.el === el) {
				this.el = null;
				this.schedule(between(TRACK_GAP_MS, Math.random));
			}
		});
	}
}

/** One player for the whole page, so the music carries on from the main menu into the game. */
export const music = new MusicPlayer();

/** Boot: the first click or key anywhere wakes sound and starts the music. */
export function startMusicOnFirstGesture(): void {
	const go = () => {
		window.removeEventListener('pointerdown', go);
		window.removeEventListener('keydown', go);
		audioContext();
		music.start();
	};
	window.addEventListener('pointerdown', go);
	window.addEventListener('keydown', go);
}
