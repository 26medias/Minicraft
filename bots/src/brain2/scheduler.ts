import type { Clock } from './clock.js';
import type { Patch, Store } from './store.js';
import type { State, WorldEvent } from './types.js';
import { TIMEOUT_MS, laneOf, type CallRecord, type Engines, type EngineChoice, type Expert, type Lane, type Signal } from './experts/expert.js';

export interface CallLine { expert: string; engine: EngineChoice; lane: Lane; latencyMs: number; fallback: boolean; reason?: string; materialKey: string; prompt?: string; promptWords?: number; answer?: unknown; selectionId?: number; patch: Patch }

interface Slot { e: Expert; sig: Signal; fresh: Signal; lastFire: number; first: number | null; last: number | null }
const CAP = 200;
interface Job { slot: Slot; slice: unknown; key: string; sig: Signal; started: number; ctrl: AbortController; rec: CallRecord }
interface LaneState { running: Job | null; queue: Job[] }

/** The tick-driven expert scheduler (spec §3). Deterministic under a ManualClock. */
export class Scheduler {
	private slots: Slot[] = [];
	private lanesState: Record<'laya' | 'llm', LaneState> = { laya: { running: null, queue: [] }, llm: { running: null, queue: [] } };
	private lastEventId = 0;
	private inflight = new Set<Promise<void>>();

	constructor(private readonly d: { store: Store; clock: Clock; engines: () => Engines; onCall: (l: { expert: string } & Omit<CallLine, 'expert'>) => void }) {
		d.store.subscribe((changes) => {
			const events = this.newEvents(d.store.state);
			for (const s of this.slots) {
				for (const g of [s.sig, s.fresh]) {
					g.changes.push(...changes);
					g.events.push(...events);
					if (g.changes.length > CAP) g.changes.splice(0, g.changes.length - CAP);
					if (g.events.length > CAP) g.events.splice(0, g.events.length - CAP);
				}
			}
		});
	}

	register(e: Expert): void {
		this.slots.push({ e, sig: { changes: [], events: [] }, fresh: { changes: [], events: [] }, lastFire: -Infinity, first: null, last: null });
	}

	private newEvents(s: Readonly<State>): WorldEvent[] {
		const out = s.events.filter((ev) => ev.id > this.lastEventId);
		if (out.length) this.lastEventId = Math.max(...out.map((e) => e.id));
		return out;
	}

	private due(s: Slot, now: number): boolean {
		const t = s.e.trigger;
		if (t.kind === 'every') return now - s.lastFire >= t.ms;
		if (t.kind === 'on') return t.match(s.sig);
		// Only a match among what arrived since the previous tick refreshes `last` (gate 2 M1).
		if (s.fresh.changes.length + s.fresh.events.length > 0 && t.match(s.fresh)) {
			s.first ??= now;
			s.last = now;
		}
		if (s.first === null || s.last === null) return false;
		return now - s.last >= t.quietMs || now - s.first >= t.maxWaitMs;
	}

	async tick(): Promise<void> {
		const now = this.d.clock();
		try {
			await this.tickInner(now);
		} finally {
			for (const s of this.slots) s.fresh = { changes: [], events: [] };
		}
	}

	private async tickInner(now: number): Promise<void> {
		for (const lane of ['laya', 'llm'] as const) {
			const r = this.lanesState[lane].running;
			if (r && now - r.started > TIMEOUT_MS[lane]) r.ctrl.abort(new Error('timeout'));
		}
		for (const s of this.slots) {
			if (!this.due(s, now)) continue;
			const sig = s.sig;
			s.sig = { changes: [], events: [] };
			s.lastFire = now;
			s.first = s.last = null;
			const slice = s.e.reads(this.d.store.state, sig);
			const key = s.e.materialKey(slice);
			const lane = laneOf(s.e.engine);
			const job: Job = { slot: s, slice, key, sig, started: now, ctrl: new AbortController(), rec: {} };
			if (lane === 'code') await this.runCode(job);
			else {
				const L = this.lanesState[lane];
				L.queue = L.queue.filter((j) => j.slot !== s);
				L.queue.push(job);
				L.queue.sort((a, b) => b.slot.e.priority - a.slot.e.priority);
			}
		}
		this.pump('laya');
		this.pump('llm');
		await Promise.resolve();
	}

	private async runCode(job: Job): Promise<void> {
		try {
			const p = await job.slot.e.run(job.slice, this.ctx(job));
			this.finish(job, p, false);
		} catch (e) {
			this.finish(job, undefined, true, `error: ${(e as Error).message}`);
		}
	}

	private ctx(job: Job) {
		return { signal: job.ctrl.signal, engines: this.d.engines(), record: (r: Job['rec']) => Object.assign(job.rec, r) };
	}

	private pump(lane: 'laya' | 'llm'): void {
		const L = this.lanesState[lane];
		if (L.running || L.queue.length === 0) return;
		const job = L.queue.shift()!;
		job.started = this.d.clock();
		L.running = job;
		const engines = this.d.engines();
		const healthy = job.slot.e.engine === 'jev' ? engines.jev?.healthy() : lane === 'laya' ? engines.laya?.healthy() : engines.llm?.healthy() && (job.slot.e.engine === 'llm' || engines.laya?.healthy());
		const done = (async () => {
			if (!healthy) return this.finish(job, undefined, true, 'engine down');
			const aborted = new Promise<never>((_, rej) => job.ctrl.signal.addEventListener('abort', () => rej(new Error('timeout'))));
			try {
				const p = await Promise.race([job.slot.e.run(job.slice, this.ctx(job)), aborted]);
				const keyNow = job.slot.e.materialKey(job.slot.e.reads(this.d.store.state, job.sig));
				if (keyNow !== job.key) return this.finish(job, undefined, true, 'stale');
				this.finish(job, p, false);
			} catch (e) {
				this.finish(job, undefined, true, job.ctrl.signal.aborted ? 'timeout' : `error: ${(e as Error).message}`);
			}
		})().finally(() => {
			L.running = null;
			this.inflight.delete(done);
			this.pump(lane);
		});
		this.inflight.add(done);
	}

	private finish(job: Job, proposal: unknown, fallback: boolean, reason?: string): void {
		const e = job.slot.e;
		let merged = fallback ? null : e.merge(proposal, this.d.store.state);
		if (!fallback && merged === null) {
			fallback = true;
			reason = 'invalid';
		}
		if (fallback) merged = e.merge(e.fallback(job.slice), this.d.store.state);
		const patch = merged?.patch ?? [];
		if (merged && patch.length) this.d.store.apply(patch, merged.cause);
		this.d.onCall({
			expert: e.name, engine: e.engine, lane: laneOf(e.engine), latencyMs: this.d.clock() - job.started, fallback, reason,
			materialKey: job.key, ...job.rec, patch,
		});
	}

	async idle(): Promise<void> {
		while (this.inflight.size) await Promise.all([...this.inflight]);
	}

	lanes() {
		const v = (l: LaneState) => ({ running: l.running?.slot.e.name ?? null, queued: l.queue.map((j) => j.slot.e.name) });
		return { laya: v(this.lanesState.laya), llm: v(this.lanesState.llm) };
	}
}
