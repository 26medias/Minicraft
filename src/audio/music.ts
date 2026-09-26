import { audioContext, bus, getAudioSettings } from './engine';
import { between, FIRST_TRACK_MS, nextTrack, TRACK_GAP_MS } from './rules';
import { MUSIC_TRACKS } from './sounds.data';

/**
 * Background music (sound spec §7): one track at a time, long silences between, shuffled, never the
 * same twice in a row. Each track streams through an <audio> element into the music bus.
 */
export class MusicPlayer {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private el: HTMLAudioElement | null = null;
	private fade: GainNode | null = null;
	private prev: number | null = null;
	private running = false;

	/** Entering a world: the first track after 20–60 s. */
	start(): void {
		this.stop();
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
		// Music at 0 does not start tracks at all (spec §8); try again after a gap.
		if (!a || !out || getAudioSettings().music === 0 || a.state !== 'running') {
			this.schedule(between(TRACK_GAP_MS, Math.random));
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
