/**
 * Keeping a bot's event loop responsive during long searches. A bot's WebSocket (pings, poses, the server's tick
 * stream) is served by the same event loop as its planning: a search that runs for seconds without yielding lets the
 * server's send queue fill and the connection drop (live: the landscaper's 128-radius area search, 1006, exit).
 *
 * - `Slicer`: call `await slicer.due()` between small steps of work; it yields to the event loop (setImmediate, so I/O
 *   runs) once `budgetMs` of work has passed since the last yield, and is a no-op otherwise.
 * - `LagMonitor`: a repeating timer that reports when the event loop was blocked longer than `thresholdMs`.
 */

const nowMs = () => performance.now();

/** The default work per slice before yielding. */
export const SLICE_MS = 15;
/** The default event-loop lag worth a log line. */
export const LAG_MS = 200;

export class Slicer {
	private start: number;
	/** How many times it yielded. */
	yields = 0;
	/** The longest slice of work seen (ms), for tests and the log. */
	longest = 0;

	constructor(private readonly budgetMs = SLICE_MS, private readonly now: () => number = nowMs, private readonly onSlice?: (ms: number) => void) {
		this.start = now();
	}

	/** True when the current slice has used its budget. */
	get over(): boolean {
		return this.now() - this.start >= this.budgetMs;
	}

	/** Yields to the event loop if the slice's budget is spent. */
	async due(): Promise<void> {
		if (!this.over) return;
		await this.yieldNow();
	}

	/** Ends the current slice and yields to the event loop unconditionally. */
	async yieldNow(): Promise<void> {
		const ms = this.now() - this.start;
		this.longest = Math.max(this.longest, ms);
		this.onSlice?.(ms);
		this.yields++;
		await new Promise<void>((res) => setImmediate(res));
		this.start = this.now();
	}
}

/** Drives a step generator (one that yields between small steps) to its result, yielding to the event loop per `slicer`. */
export async function drive<T>(it: Generator<void, T>, slicer: Slicer, alive: () => boolean = () => true): Promise<T | null> {
	for (;;) {
		const r = it.next();
		if (r.done) return r.value;
		if (!alive()) return null;
		await slicer.due();
	}
}

/** Reports event-loop lag: `onLag(ms)` when a `everyMs` timer fired more than `thresholdMs` late. The timer is unref'd. */
export class LagMonitor {
	private last = nowMs();
	private readonly timer: ReturnType<typeof setInterval>;
	/** The worst lag seen (ms). */
	worst = 0;

	constructor(onLag: (ms: number) => void, thresholdMs = LAG_MS, everyMs = 100) {
		this.timer = setInterval(() => {
			const t = nowMs();
			const lag = t - this.last - everyMs;
			this.last = t;
			if (lag > this.worst) this.worst = lag;
			if (lag > thresholdMs) onLag(Math.round(lag));
		}, everyMs);
		this.timer.unref?.();
	}

	stop(): void {
		clearInterval(this.timer);
	}
}
