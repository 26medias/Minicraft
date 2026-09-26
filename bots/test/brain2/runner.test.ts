import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WalkResult } from 'minicraft-bot';
import { BehaviourRunner, type RunnerDeps } from '../../src/brain2/runner.js';
import { BEHAVIOURS, type Behaviour, type Next } from '../../src/brain2/behaviours/behaviour.js';
import { createPerceiver } from '../../src/brain2/perception.js';
import { Ownership } from '../../src/brain2/ownership.js';
import { Tripwire } from '../../src/brain2/safety.js';
import { Store, initialState } from '../../src/brain2/store.js';
import { ManualClock } from '../../src/brain2/clock.js';
import { PIP } from '../../src/brain2/data/personalities.data.js';
import { StopSignal } from '../../src/body/stop-signal.js';
import type { Action } from '../../src/brain2/types.js';
import { FakeBody, FakeWorld, id, player } from '../fake-port.js';

// Seed 12345's surface is at y≈104–138, so these tests work in open air at y 200.
const Y = 200;

function scripted(actions: Array<Action | 'done' | { failed: string }>, owns = () => true): Behaviour<object, { i: number }> {
	return {
		kind: 'watch', typicalMs: [1000, 2000],
		plan: () => ({ i: 0 }),
		next: (p) => actions[Math.min(p.i, actions.length - 1)] as Next,
		plannedEdits: () => actions.filter((a) => typeof a === 'object' && 'cell' in a).length,
		owns,
		onResult: (p) => ((p.i += 1), []),
	};
}
const place = (x: number, z: number, y = Y): Action => ({ kind: 'place', cell: { x, y, z }, block: 'stone' });

const saved = BEHAVIOURS.watch;
afterEach(() => {
	BEHAVIOURS.watch = saved;
});

function rig(over: Partial<RunnerDeps> = {}) {
	const clock = new ManualClock(0);
	const world = new FakeWorld();
	const body = new FakeBody();
	body.world = world;
	body.current = { x: 0.5, y: Y, z: 0.5, yaw: 0, pitch: 0 };
	const store = new Store(initialState(PIP, body.current), clock.now);
	store.apply([{ path: ['inventory'], value: { stone: 5 } }], { kind: 'body', by: 'test' });
	const own = new Ownership(world, () => store.state.owned);
	const perceiver = createPerceiver({ body, world, own, store, tuning: { followDist: 2, idleSwitchMs: 30_000, minTargetMs: 20_000 }, clock: clock.now });
	const tripwire = new Tripwire(600);
	const stop = new StopSignal(600_000);
	const logs: Array<[string, unknown]> = [];
	const deps: RunnerDeps = {
		store, body, world, own, perceiver, tripwire, stop, clock: clock.now, noEdits: () => false, fit: async () => 'yes',
		log: (k, d) => logs.push([k, d]), rng: () => 0, spawn: { x: 256, y: 120, z: 256 }, styleOverride: { editGapMs: 600 }, ...over,
	};
	const runner = new BehaviourRunner(deps);
	/** Refreshes the perceiver's kids (as the brain's 500 ms perception tick does). */
	const see = () => store.apply(perceiver.tick(clock.t), { kind: 'perception', by: 'perceive' });
	const step = async (ms = 100) => {
		clock.advance(ms);
		see();
		await runner.tick();
	};
	const steps = async (n: number, ms = 100) => {
		for (let i = 0; i < n; i++) await step(ms);
	};
	const calls = (fn: string) => body.calls.filter((c) => c.fn === fn);
	const noah = (x: number, z: number, y = Y) => {
		body.list = [player({ id: 7, name: 'Noah', x, y, z })];
		see();
	};
	return { clock, world, body, store, own, perceiver, tripwire, stop, runner, logs, see, step, steps, calls, noah, deps };
}
/** Lets pending promise callbacks run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('BehaviourRunner (spec §7)', () => {
	// 1. Red if inventory isn't decremented, or `owned` isn't written, or the tripwire isn't told.
	it('executes a place, updates owned, inventory and the tripwire', async () => {
		const r = rig();
		const rec = vi.spyOn(r.tripwire, 'recordEdit');
		BEHAVIOURS.watch = scripted([place(5, 5), 'done']);
		r.runner.start('watch', {});
		await r.step();
		expect(r.calls('place')).toHaveLength(1);
		expect(r.store.state.owned[`5,${Y},5`]).toBe(id('stone'));
		expect(r.store.state.inventory.stone).toBe(4);
		expect(rec).toHaveBeenCalledTimes(1);
		await r.step(700);
		expect(r.store.state.memory.past[0]).toMatchObject({ behaviour: 'watch', outcome: 'done' });
	});

	// 2. Red if a liquid or a crafted-only block reaches the inventory (spec §6: never held), or a mined block doesn't.
	it('a break adds the mined block to inventory; a liquid or crafted-only block never does', async () => {
		const r = rig();
		r.world.setNatural(5, Y, 5, 'stone');
		r.world.setNatural(9, Y, 5, 'water');
		r.world.setNatural(13, Y, 5, 'big_tnt');
		BEHAVIOURS.watch = scripted([{ kind: 'break', cell: { x: 5, y: Y, z: 5 } }, { kind: 'break', cell: { x: 9, y: Y, z: 5 } }, { kind: 'mine', cell: { x: 13, y: Y, z: 5 } }, 'done']);
		r.runner.start('watch', {});
		await r.steps(4, 700);
		expect(r.calls('break')).toHaveLength(2);
		expect(r.calls('mine')).toHaveLength(1);
		expect(r.store.state.inventory).toEqual({ stone: 6 });
		expect(r.store.state.owned[`9,${Y},5`]).toBe(0);
	});

	// 3. Red if rejections don't end the behaviour, or the reason is lost.
	it('3 safety rejections in a row end the behaviour failed with the reason', async () => {
		const r = rig();
		r.noah(5.5, 5.5);
		BEHAVIOURS.watch = scripted([place(5, 5), 'done']);
		r.runner.start('watch', {});
		await r.steps(2);
		expect(r.store.state.behaviour?.rejections).toBe(2);
		await r.step();
		expect(r.store.state.behaviour).toBeNull();
		expect(r.store.state.memory.past[0]).toMatchObject({ outcome: 'failed', why: 'kid body buffer' });
		expect(r.calls('place')).toHaveLength(0);
	});

	// 4. Red if a plan veto isn't passed to the tripwire, or if start() doesn't reset the plan budget (it is Infinity
	// until the first resetPlan, so with no resetPlan(0) the vetoes could never overrun).
	it('a plan veto counts toward the tripwire overrun', async () => {
		const r = rig();
		BEHAVIOURS.watch = { ...scripted([place(5, 5), place(6, 5), 'done'], () => false), plannedEdits: () => 0 };
		r.runner.start('watch', {});
		await r.steps(2);
		expect(r.tripwire.halted).toMatch(/overrun/);
		expect(r.store.state.body.editsHalted).toMatch(/overrun/);
		expect(r.calls('place')).toHaveLength(0);
	});

	// 5. Red if the style edit gap is ignored (a second place at 700 ms).
	it('respects the style edit gap', async () => {
		const r = rig({ styleOverride: { editGapMs: 1000 } });
		BEHAVIOURS.watch = scripted([place(5, 5), place(7, 5), 'done']);
		r.runner.start('watch', {});
		await r.step();                     // t = 100: the first place
		expect(r.calls('place')).toHaveLength(1);
		while (r.clock.t < 900) await r.step();
		expect(r.calls('place')).toHaveLength(1);
		while (r.clock.t < 1100) await r.step();
		expect(r.calls('place')).toHaveLength(2);
	});

	// 6. Red if waits are skipped (a place before 6 000 ms) or unbounded (no place by 6 200 ms).
	it('fit wait pauses 2–4 s, at most 3 times, then acts', async () => {
		const fit = vi.fn(async () => 'wait' as const);
		const r = rig({ fit, rng: () => 0 });
		r.noah(10.5, 5.5);                // 5 blocks from the cell: within 8, outside the body buffer
		BEHAVIOURS.watch = scripted([place(5, 5), 'done']);
		r.runner.start('watch', {});
		while (r.clock.t < 5900) await r.step();
		expect(r.calls('place')).toHaveLength(0);
		while (r.clock.t < 6200) await r.step();
		expect(r.calls('place')).toHaveLength(1);
		expect(fit).toHaveBeenCalledTimes(4);
	});

	// 7. Red if the runner acts during a gesture.
	it('a gesture pauses the runner', async () => {
		const r = rig();
		BEHAVIOURS.watch = scripted([place(5, 5), 'done']);
		r.runner.start('watch', {});
		r.store.apply([{ path: ['body', 'gesture'], value: 'hop' }], { kind: 'gesture', by: 'test' });
		await r.steps(10);
		expect(r.body.calls).toHaveLength(0);
		r.store.apply([{ path: ['body', 'gesture'], value: null }], { kind: 'gesture', by: 'test' });
		await r.step();
		expect(r.calls('place')).toHaveLength(1);
	});

	// 8. Red if end() leaves the walk running, or doesn't write memory.past.
	it('end() cancels a walk in flight and writes memory.past', async () => {
		const r = rig();
		r.body.walkImpl = () => new Promise<WalkResult>(() => undefined);
		BEHAVIOURS.watch = scripted([{ kind: 'walk', to: { x: 20, z: 20 }, speed: 1 }, 'done']);
		r.runner.start('watch', {});
		r.clock.advance(100);
		const pending = r.runner.tick();
		expect(r.runner.busy).toBe(true);
		r.runner.end('interrupted', 'x');
		await pending;
		expect(r.calls('move')).toHaveLength(1);
		expect(r.store.state.memory.past[0]).toMatchObject({ outcome: 'interrupted', why: 'x' });
		expect(r.store.state.memory.current).toBeNull();
		expect(r.store.state.events.at(-1)).toMatchObject({ kind: 'outcome', detail: 'interrupted', salient: true });
	});

	// 9. Review Focus 5. Red if the runner spins on rejections (no end), writes no stuck event, or counts the kid's
	// body-buffer rejections as plan vetoes (the tripwire would halt). plannedEdits is pinned to 2 (not the plan's
	// natural 3): at 3, the overrun threshold is 3 × 1.1 = 3.3, which 3 miscounted vetoes never clear, so a runner
	// that mixed up body-buffer rejections with plan vetoes would still pass; at 2 the threshold is 2.2.
	it('Review Focus 5: a kid standing inside the plan\'s cells', async () => {
		const r = rig();
		r.noah(6.5, 5.5);
		BEHAVIOURS.watch = { ...scripted([place(5, 5), place(6, 5), place(7, 5), 'done']), plannedEdits: () => 2 };
		r.runner.start('watch', {});
		await r.steps(3);
		expect(r.store.state.memory.past[0]).toMatchObject({ outcome: 'failed', why: 'kid body buffer' });
		expect(r.store.state.events.filter((e) => e.kind === 'stuck')).toEqual([expect.objectContaining({ detail: 'kid body buffer', salient: true })]);
		expect(r.tripwire.halted).toBeNull();
		expect(r.calls('place')).toHaveLength(0);
	});

	// 10. Rule 0. Red on the plan's first tick(), which awaited fit without a busy flag: a broken runner still places
	// once, but asks fit 4 times (the assertion that catches it).
	it('no re-entrancy', async () => {
		let resolveFit: (v: 'yes') => void = () => undefined;
		const fit = vi.fn(() => new Promise<'yes' | 'wait' | 'no'>((res) => (resolveFit = res)));
		const r = rig({ fit });
		r.noah(10.5, 5.5);
		BEHAVIOURS.watch = scripted([place(5, 5), 'done']);
		r.runner.start('watch', {});
		r.clock.advance(100);
		const first = r.runner.tick();
		for (let i = 0; i < 3; i++) {
			r.clock.advance(100);
			void r.runner.tick();
		}
		resolveFit('yes');
		await first;
		await flush();
		expect(fit).toHaveBeenCalledTimes(1);
		expect(r.calls('place')).toHaveLength(1);
	});

	// 11. Rule 8. Red if a cancelled walk counts as a result (the script moves on after 1 walk) or a failure.
	it('a cancelled walk is reissued, not a failure', async () => {
		const r = rig();
		const results: WalkResult[] = ['cancelled', 'cancelled', 'arrived'];
		r.body.walkImpl = async () => results.shift() ?? 'arrived';
		BEHAVIOURS.watch = scripted([{ kind: 'walk', to: { x: 20, z: 20 }, speed: 1 }, 'done']);
		r.runner.start('watch', {});
		await r.steps(5);
		expect(r.calls('walkTo')).toHaveLength(3);
		expect(r.store.state.memory.past[0]).toMatchObject({ outcome: 'done' });
	});

	// 12. Rule 6. Red if a late result writes inventory/owned, or end() doesn't stop the mine.
	it('a mine result arriving after end() is discarded', async () => {
		const r = rig();
		r.world.setNatural(5, Y, 5, 'stone');
		let resolveMine: (ok: boolean) => void = () => undefined;
		r.body.mineImpl = () => new Promise<boolean>((res) => (resolveMine = res));
		BEHAVIOURS.watch = scripted([{ kind: 'mine', cell: { x: 5, y: Y, z: 5 } }, 'done']);
		r.runner.start('watch', {});
		r.clock.advance(100);
		const pending = r.runner.tick();
		r.runner.end('interrupted', 'switch');
		resolveMine(true);
		await pending;
		expect(r.calls('stopMining')).toHaveLength(1);
		expect(r.store.state.inventory).toEqual({ stone: 5 });
		expect(r.store.state.owned).toEqual({});
		expect(r.logs.some(([k]) => k === 'late-edit')).toBe(true);
	});

	// 13. Rule 10. Red if a plan failure writes a stuck event, or doesn't end at once.
	it('plan() {failed} ends at once with no stuck event', () => {
		const r = rig();
		BEHAVIOURS.watch = { ...scripted(['done']), plan: () => ({ failed: 'no site' }) } as unknown as Behaviour;
		r.runner.start('watch', {});
		expect(r.store.state.behaviour).toBeNull();
		expect(r.store.state.memory.past[0]).toMatchObject({ outcome: 'failed', why: 'no site' });
		expect(r.store.state.events.some((e) => e.kind === 'stuck')).toBe(false);
		expect(r.store.state.events.some((e) => e.kind === 'outcome')).toBe(true);
	});

	// 14. Rule 9c. Red on the plan's rev-f195a1c tick(), which neither re-checked gen nor re-judged after fit.
	it('nothing stale after fit', async () => {
		for (const variant of ['ended', 'kid moved in'] as const) {
			let resolveFit: (v: 'yes') => void = () => undefined;
			const r = rig({ fit: () => new Promise((res) => (resolveFit = res)) });
			r.noah(10.5, 5.5);
			BEHAVIOURS.watch = scripted([place(5, 5), place(5, 5), 'done']);
			r.runner.start('watch', {});
			r.clock.advance(100);
			const first = r.runner.tick();
			for (let i = 0; i < 3; i++) {
				r.clock.advance(100);
				void r.runner.tick();
			}
			if (variant === 'ended') r.runner.end('interrupted', 'switch');
			else r.noah(5.5, 5.5);        // Noah steps onto the cell while fit is pending
			resolveFit('yes');
			await first;
			expect(r.calls('place'), variant).toHaveLength(0);
			if (variant === 'kid moved in') expect(r.store.state.behaviour?.rejections).toBe(1);
		}
	});

	// Rule 11 and rule 4's reset. Red if lastResults isn't kept (to 3), or a success doesn't reset the rejections.
	it('keeps the last 3 results, and a success resets the rejections', async () => {
		const r = rig();
		r.noah(5.5, 5.5);
		let n = 0;
		r.body.placeImpl = async () => ++n !== 2;   // the second place fails
		BEHAVIOURS.watch = scripted([place(5, 5), place(7, 5), place(9, 5), place(11, 5), 'done']);
		r.runner.start('watch', {});
		await r.steps(2);
		expect(r.store.state.behaviour?.rejections).toBe(2);
		r.noah(15.5, 25.5);
		await r.step(700);
		expect(r.store.state.behaviour?.rejections).toBe(0);
		await r.steps(3, 700);
		expect(r.store.state.behaviour?.lastResults).toEqual([false, true, true]);
	});

	// Fix-round finding 3: an exception from next()/onResult/plan must not escape the un-awaited tick() as an
	// unhandled rejection (a crash on Node 22). Red on the old tick(), which had no catch around the body: the
	// throw rejected tick()'s promise instead of ending the behaviour.
	it('a behaviour whose next() throws ends failed, and tick() resolves', async () => {
		const r = rig();
		BEHAVIOURS.watch = { ...scripted(['done']), next: () => { throw new Error('boom'); } };
		r.runner.start('watch', {});
		await expect(r.runner.tick()).resolves.toBeUndefined();
		expect(r.store.state.behaviour).toBeNull();
		expect(r.store.state.memory.past[0]).toMatchObject({ outcome: 'failed' });
		expect(r.store.state.memory.past[0].why).toMatch(/^error: boom/);
	});

	// Fix-round finding 4: a gesture that starts while fit is pending must still pause the runner (rule 1 only
	// checks the gesture before fit is asked). Red on the old tick(), which executed the action once fit
	// resolved regardless of a gesture set meanwhile.
	it('a gesture set while fit is pending pauses the runner', async () => {
		let resolveFit: (v: 'yes') => void = () => undefined;
		const fit = vi.fn(() => new Promise<'yes' | 'wait' | 'no'>((res) => (resolveFit = res)));
		const r = rig({ fit });
		r.noah(10.5, 5.5);
		BEHAVIOURS.watch = scripted([place(5, 5), 'done']);
		r.runner.start('watch', {});
		r.clock.advance(100);
		const pending = r.runner.tick();
		r.store.apply([{ path: ['body', 'gesture'], value: 'hop' }], { kind: 'gesture', by: 'test' });
		resolveFit('yes');
		await pending;
		expect(r.calls('place')).toHaveLength(0);
		expect(r.store.state.behaviour).not.toBeNull();
	});
});
