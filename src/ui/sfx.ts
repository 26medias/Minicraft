// Tiny synthesized sounds (no audio files). The AudioContext is created on first use,
// which is always inside a click or key handler, so autoplay rules allow it.
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
	try {
		ctx ??= new AudioContext();
		if (ctx.state === 'suspended') void ctx.resume();
		return ctx;
	} catch {
		return null; // no Web Audio: stay silent
	}
}

function tone(freq: number, start: number, dur: number, type: OscillatorType, peak: number): void {
	const a = audio();
	if (!a) return;
	const t0 = a.currentTime + start;
	const osc = a.createOscillator();
	const gain = a.createGain();
	osc.type = type;
	osc.frequency.setValueAtTime(freq, t0);
	gain.gain.setValueAtTime(0.0001, t0);
	gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.01);
	gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
	osc.connect(gain).connect(a.destination);
	osc.start(t0);
	osc.stop(t0 + dur + 0.02);
}

/** Crafting worked: a quick rising three-note chime (spec §9). */
export function playCraft(): void {
	tone(784, 0, 0.12, 'triangle', 0.18);    // G5
	tone(988, 0.08, 0.12, 'triangle', 0.18); // B5
	tone(1319, 0.16, 0.22, 'triangle', 0.2); // E6
}

/** Placing refused (no count): a soft low blip (spec §3). */
export function playNope(): void {
	tone(160, 0, 0.12, 'sine', 0.15);
}
