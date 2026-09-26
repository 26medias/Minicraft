import { describe, expect, it } from 'vitest';
import { Scheduler, type CallLine } from '../../src/brain2/scheduler.js';
import { debounce, every, on, type Engines, type Expert, type Signal } from '../../src/brain2/experts/expert.js';
import { Store, initialState } from '../../src/brain2/store.js';
import { ManualClock } from '../../src/brain2/clock.js';
import { PIP } from '../../src/brain2/data/personalities.data.js';

type Deferred<T> = { p: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
	let resolve!: (v: T) => void, reject!: (e: unknown) => void;
	const p = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
	return { p, resolve, reject };
}
function rig(engines: Partial<Engines> = {}) {
	const clock = new ManualClock(0);
	const store = new Store(initialState(PIP, { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 }), clock.now);
	const calls: CallLine[] = [];
	const sched = new Scheduler({ store, clock: clock.now, engines: () => ({ laya: null, llm: null, ...engines }), onCall: (l) => calls.push(l) });
	return { clock, store, sched, calls };
}
const healthyLaya = (impl: () => Promise<never> | Promise<unknown>) => ({ healthy: () => true, ask: impl as never });
/** A model expert that writes inventory[name] = answer. */
function modelExpert(name: string, over: Partial<Expert<{ n: number }, number>> = {}): Expert<{ n: number }, number> {
	return {
		name, layer: 2, engine: 'laya', priority: 1, trigger: on(() => true),
		reads: (s) => ({ n: s.inventory.key ?? 0 }),
		materialKey: (sl) => String(sl.n),
		run: async (_sl, ctx) => (await ctx.engines.laya!.ask('s', { type: 'choice', instructions: '', options: {} }, ctx.signal)) as unknown as number,
		merge: (p) => ({ patch: [{ path: ['inventory', name], value: p }], cause: { kind: 'appraisal', by: name } }),
		fallback: () => -1,
		...over,
	};
}
const poke = (store: Store, v: number) => store.apply([{ path: ['inventory', 'key'], value: v }], { kind: 'poke', by: 'test' });

describe('Scheduler (spec §3, §3.1)', () => {
	it('every(ms) fires on schedule', async () => {
		const { clock, store, sched } = rig();
		let n = 0;
		sched.register({ ...modelExpert('e'), engine: 'code', trigger: every(500), run: async () => ++n });
		for (let t = 0; t <= 2000; t += 100) {
			clock.t = t;
			await sched.tick();
		}
		expect(n).toBe(5); // 0, 500, 1000, 1500, 2000
		expect(store.state.inventory.e).toBe(5);
	});
	// Red if debounce is leading, or has no maxWait (rev 1 M3: a trailing-only debounce never fired during a build).
	it('debounce fires after quietMs, or at maxWaitMs under a steady stream', async () => {
		const { clock, store, sched } = rig();
		const fired: number[] = [];
		const match = (s: Signal) => s.changes.some((c) => c.path === 'inventory.key');
		sched.register({ ...modelExpert('d'), engine: 'code', trigger: debounce(match, { quietMs: 1000, maxWaitMs: 3000 }), run: async () => (fired.push(clock.t), 1) });
		for (let t = 0; t <= 10_000; t += 100) {
			clock.t = t;
			if (t <= 5000 && t % 500 === 0) poke(store, t); // a steady stream until 5 s
			// Background churn that doesn't match (decay), all the way through. Red on the rev-1 plan's rule,
			// which refreshed `last` on any change: the quiet fire moved to 6500.
			if (t % 500 === 300) store.apply([{ path: ['emotions', 'mood', 'value'], value: (t % 1000) / 10_000 }], { kind: 'decay', by: 'decay' });
			await sched.tick();
		}
		expect(fired[0]).toBe(3000);   // maxWait under a stream
		expect(fired[1]).toBe(6000);   // quiet 1 s after the last poke at 5000
		expect(fired).toHaveLength(2);
	});
	it('a lane runs one job at a time, higher priority first', async () => {
		const order: string[] = [];
		const gates: Record<string, Deferred<unknown>> = {};
		const laya = healthyLaya(() => Promise.resolve(0));
		const { clock, sched } = rig({ laya });
		for (const [name, pr] of [['low', 1], ['high', 3], ['mid', 2]] as const) {
			gates[name] = deferred();
			sched.register(modelExpert(name, { priority: pr, trigger: every(10_000), run: async () => (order.push(name), (await gates[name].p) as number) }));
		}
		const flush = () => new Promise((r) => setImmediate(r));
		clock.t = 1;
		await sched.tick();
		expect(sched.lanes().laya.running).toBe('high');
		gates.high.resolve(1);
		await flush();
		await sched.tick();
		expect(sched.lanes().laya.running).toBe('mid');
		gates.mid.resolve(1); gates.low.resolve(1);
		await sched.idle();
		expect(order).toEqual(['high', 'mid', 'low']);
	});
	it('a newer request replaces the queued one (at most one queued per expert)', async () => {
		const g = deferred<unknown>();
		const laya = healthyLaya(() => g.p);
		const { clock, store, sched } = rig({ laya });
		let runs = 0;
		sched.register(modelExpert('busy', { priority: 3, trigger: every(10_000), run: async (_s, ctx) => (await ctx.engines.laya!.ask('', { type: 'choice', instructions: '', options: {} }, ctx.signal)) as unknown as number }));
		sched.register(modelExpert('q', { priority: 1, trigger: on((s) => s.changes.length > 0), run: async (sl) => (runs++, sl.n) }));
		clock.t = 1; await sched.tick();           // busy runs; q queued
		poke(store, 1); clock.t = 2; await sched.tick();
		poke(store, 2); clock.t = 3; await sched.tick();
		expect(sched.lanes().laya.queued).toEqual(['q']);
		g.resolve(0);
		await sched.idle();
		expect(runs).toBe(1);
	});
	// Red if a stale answer is used, or retried (spec §3: fallback, no retry).
	it('stale answer → fallback, no retry', async () => {
		const g = deferred<unknown>();
		const { clock, store, sched, calls } = rig({ laya: healthyLaya(() => g.p) });
		let runs = 0;
		sched.register(modelExpert('s', { trigger: every(10_000), run: async (_sl, ctx) => (runs++, (await ctx.engines.laya!.ask('', { type: 'choice', instructions: '', options: {} }, ctx.signal)) as unknown as number) }));
		clock.t = 0; await sched.tick();
		poke(store, 9); // the key changes while the call is in flight
		g.resolve(42);
		await sched.idle();
		expect(store.state.inventory.s).toBe(-1);
		expect(calls.find((c) => c.expert === 's')).toMatchObject({ fallback: true, reason: 'stale' });
		expect(runs).toBe(1);
	});
	// Red if staleness looked at `version` (rev 2 M1): decay bumps version every tick.
	it('decay patches never make an answer stale', async () => {
		const g = deferred<unknown>();
		const { clock, store, sched } = rig({ laya: healthyLaya(() => g.p) });
		sched.register(modelExpert('k', { trigger: every(10_000) }));
		clock.t = 0; await sched.tick();
		store.apply([{ path: ['emotions', 'mood', 'value'], value: 0.3 }], { kind: 'decay', by: 'decay' });
		g.resolve(7);
		await sched.idle();
		expect(store.state.inventory.k).toBe(7);
	});
	// Review Focus 4. Red on an unhandled rejection (vitest fails the run), a stuck lane, or a missing fallback.
	it('engine dies with calls in flight', async () => {
		const gs = [deferred<unknown>(), deferred<unknown>()];
		let i = 0;
		const { clock, store, sched, calls } = rig({ laya: healthyLaya(() => gs[i++].p) });
		sched.register(modelExpert('a', { priority: 2, trigger: every(10_000) }));
		sched.register(modelExpert('b', { priority: 1, trigger: every(10_000) }));
		clock.t = 0; await sched.tick();
		gs[0].reject(new Error('ECONNRESET'));
		await sched.tick();
		gs[1].reject(new Error('ECONNRESET'));
		await sched.idle();
		expect(store.state.inventory.a).toBe(-1);
		expect(store.state.inventory.b).toBe(-1);
		expect(calls.filter((c) => c.fallback)).toHaveLength(2);
		expect(sched.lanes().laya.running).toBeNull();
	});
	it('an unhealthy engine is never called', async () => {
		let called = false;
		const { clock, store, sched } = rig({ laya: { healthy: () => false, ask: async () => ((called = true), {}) as never } });
		sched.register(modelExpert('u', { trigger: every(10_000) }));
		clock.t = 0; await sched.tick(); await sched.idle();
		expect(called).toBe(false);
		expect(store.state.inventory.u).toBe(-1);
	});
	it('a timeout aborts the call and falls back', async () => {
		const { clock, store, sched, calls } = rig({ laya: healthyLaya(() => new Promise(() => {})) });
		sched.register(modelExpert('t', { trigger: every(100_000) }));
		clock.t = 0; await sched.tick();
		clock.t = 401; await sched.tick();
		await sched.idle();
		expect(store.state.inventory.t).toBe(-1);
		expect(calls[0]).toMatchObject({ reason: 'timeout' });
	});
	it('a code expert that throws falls back, and tick() resolves', async () => {
		const { clock, store, sched, calls } = rig();
		sched.register(modelExpert('c', {
			engine: 'code', trigger: every(10_000),
			run: async () => { throw new Error('boom'); },
		}));
		clock.t = 0;
		await expect(sched.tick()).resolves.toBeUndefined();
		expect(store.state.inventory.c).toBe(-1);
		expect(calls.find((c) => c.expert === 'c')).toMatchObject({ fallback: true, reason: 'error: boom' });
	});
});
