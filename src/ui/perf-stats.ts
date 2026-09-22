/**
 * Pure frame-time aggregator behind the F3 overlay (spec §3.F, §6.6). No DOM,
 * no clock: `summary(now)` is a function of the pushed samples and `now`.
 *
 * `frameMs` is the raw `performance.now()` delta between ticks, never the
 * clamped `dt` the renderer hands the loop (that clamps at 100 ms, so a 400 ms
 * hitch would read as 100).
 */
export type FrameSample = { t: number; frameMs: number; tickMs: number };

export type FrameSummary = {
	fps: number;
	avgMs: number;
	worstMs: number;
	over50In10s: number;
	tickShare: number;
};

const CAPACITY = 1200;
const SHORT_WINDOW_MS = 1000;
const LONG_WINDOW_MS = 10_000;
const HITCH_MS = 50;

export class RollingStats {
	private readonly t = new Float64Array(CAPACITY);
	private readonly frameMs = new Float64Array(CAPACITY);
	private readonly tickMs = new Float64Array(CAPACITY);
	private head = 0;
	private count = 0;

	push(s: FrameSample): void {
		this.t[this.head] = s.t;
		this.frameMs[this.head] = s.frameMs;
		this.tickMs[this.head] = s.tickMs;
		this.head = (this.head + 1) % CAPACITY;
		if (this.count < CAPACITY) this.count++;
	}

	/**
	 * Windows are strict: a sample at exactly `now - 1000` is outside the 1 s
	 * window, one at exactly `now - 10000` outside the 10 s window.
	 */
	summary(now: number): FrameSummary {
		const shortEdge = now - SHORT_WINDOW_MS;
		const longEdge = now - LONG_WINDOW_MS;
		let n = 0;
		let sumFrame = 0;
		let sumTick = 0;
		let worst = 0;
		let over50 = 0;
		for (let k = 0; k < this.count; k++) {
			const i = (this.head - 1 - k + CAPACITY) % CAPACITY;
			const t = this.t[i];
			if (t > longEdge && this.frameMs[i] > HITCH_MS) over50++;
			if (t > shortEdge) {
				n++;
				sumFrame += this.frameMs[i];
				sumTick += this.tickMs[i];
				if (this.frameMs[i] > worst) worst = this.frameMs[i];
			}
		}
		const avgMs = n > 0 ? sumFrame / n : 0;
		return {
			fps: n > 0 && sumFrame > 0 ? (n * 1000) / sumFrame : 0,
			avgMs,
			worstMs: worst,
			over50In10s: over50,
			tickShare: sumFrame > 0 ? sumTick / sumFrame : 0,
		};
	}
}
