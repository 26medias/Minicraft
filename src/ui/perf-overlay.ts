import { RollingStats, type FrameSample } from './perf-stats';

/**
 * F3 performance panel (spec §3.F): top-left monospace, click-through, hidden
 * by default. The aggregation lives in RollingStats and is unit tested; this
 * panel is untested DOM like the other overlays. It re-renders at most twice a
 * second so the text itself does not become a frame cost.
 */
const REFRESH_MS = 500;

export class PerfOverlay {
	private readonly el: HTMLPreElement;
	private readonly stats = new RollingStats();
	private lastRender = -Infinity;
	private _visible = false;

	constructor(container: HTMLElement) {
		this.el = document.createElement('pre');
		this.el.id = 'perf-overlay';
		this.el.classList.add('hidden');
		container.appendChild(this.el);
	}

	get visible(): boolean {
		return this._visible;
	}

	toggle(): void {
		this._visible = !this._visible;
		this.el.classList.toggle('hidden', !this._visible);
		// Force the next tick to paint so the panel never shows stale text.
		this.lastRender = -Infinity;
	}

	/**
	 * Called every frame; the sample is always recorded (so the 10 s hitch count
	 * is honest the moment the panel opens), `live` is only read when painting.
	 */
	tick(now: number, sample: FrameSample, live: () => Record<string, string | number>): void {
		this.stats.push(sample);
		if (!this._visible) return;
		if (now - this.lastRender < REFRESH_MS) return;
		this.lastRender = now;
		const s = this.stats.summary(now);
		const v = live();
		const lines = [
			`${s.fps.toFixed(0)} fps  avg ${s.avgMs.toFixed(1)} ms  worst ${s.worstMs.toFixed(1)} ms  >50ms/10s ${s.over50In10s}  tick ${(s.tickShare * 100).toFixed(0)}%`,
			`calls ${v.calls ?? 'n/a'}  tris ${v.triangles ?? 'n/a'}`,
			`mounted ${v.mounted ?? 'n/a'}  data ${v.data ?? 'n/a'}`,
			`stream ${v.streamQueue ?? 'n/a'}  edit ${v.editQueue ?? 'n/a'}  worker ${v.workerInFlight ?? 'n/a'}`,
			`lastEdit ${v.lastEditMs ?? 'n/a'} ms`,
			`heap ${v.heapMB ?? 'n/a'} MB`,
			`dpr ${v.pixelRatio ?? 'n/a'}  ${v.width ?? '?'}x${v.height ?? '?'}`,
			`gpu ${v.gpu ?? 'n/a'}`,
		];
		this.el.textContent = lines.join('\n');
	}
}
