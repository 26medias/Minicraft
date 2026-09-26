import { afterEach, describe, expect, it } from 'vitest';
import { BlockedError } from 'minicraft-bot';
import { BehaviourRunner } from '../../src/brain2/runner.js';
import { BEHAVIOURS, type Behaviour, type Next } from '../../src/brain2/behaviours/behaviour.js';
import { createPerceiver } from '../../src/brain2/perception.js';
import { Ownership } from '../../src/brain2/ownership.js';
import { Tripwire } from '../../src/brain2/safety.js';
import { Store, initialState } from '../../src/brain2/store.js';
import { ManualClock } from '../../src/brain2/clock.js';
import { PIP } from '../../src/brain2/data/personalities.data.js';
import { StopSignal } from '../../src/body/stop-signal.js';
import type { Action } from '../../src/brain2/types.js';
import { FakeBody, FakeWorld } from '../fake-port.js';

const Y = 200;
const saved = BEHAVIOURS.watch;
afterEach(() => {
	BEHAVIOURS.watch = saved;
});

/** A behaviour that only ever walks to the same far column. */
const walker: Behaviour<object, object> = {
	kind: 'watch', typicalMs: [1000, 2000], plan: () => ({}), plannedEdits: () => 0, owns: () => true,
	next: () => ({ kind: 'walk', to: { x: 40.5, z: 0.5 }, speed: 1 }) as Action as Next,
};

describe('BehaviourRunner stuck watchdog', () => {
	// Red if the runner has no watchdog, escalates out of order, or never gives the stuck walk up.
	it('a bot whose walks and flights never move it: fly-high, air path, teleport up, then the behaviour fails stuck', async () => {
		const clock = new ManualClock(0);
		const world = new FakeWorld();
		// Sealed in stone at y 200: nothing but the teleport gets out.
		world.fill({ x: -2, y: Y, z: -2 }, { x: 2, y: Y + 6, z: 2 }, 'stone');
		world.set(0, Y, 0, 0);
		world.set(0, Y + 1, 0, 0);
		const body = new FakeBody();
		body.world = world;
		body.current = { x: 0.5, y: Y, z: 0.5, yaw: 0, pitch: 0 };
		body.walkImpl = async () => {
			throw new BlockedError({ ...body.current }, 'wall', 'walkTo');
		};
		body.flyImpl = async () => {
			throw new BlockedError({ ...body.current }, 'wall', 'flyTo');
		};
		const store = new Store(initialState(PIP, body.current), clock.now);
		const own = new Ownership(world, () => store.state.owned);
		const perceiver = createPerceiver({ body, world, own, store, tuning: { followDist: 2, idleSwitchMs: 30_000, minTargetMs: 20_000 }, clock: clock.now });
		const logs: Array<[string, unknown]> = [];
		const runner = new BehaviourRunner({
			store, body, world, own, perceiver, tripwire: new Tripwire(600), stop: new StopSignal(600_000), clock: clock.now, noEdits: () => false,
			fit: async () => 'yes', log: (k, d) => logs.push([k, d]), rng: () => 0, spawn: { x: 256, y: 120, z: 256 },
		});
		BEHAVIOURS.watch = walker;
		const stuck = () => store.state.memory.past.some((e) => e.why === 'stuck (unstick)');
		// The selection would start a new behaviour after each failure: here, the same walker again.
		for (let i = 0; i < 1000 && !stuck(); i++) {
			if (!store.state.behaviour) runner.start('watch', {});
			clock.advance(500);
			await runner.tick();
		}
		const levels = logs.filter(([k, d]) => k === 'unstick' && !(d as { abandon?: boolean }).abandon).map(([, d]) => (d as { level: number }).level);
		expect(levels).toEqual([1, 2, 3]);
		expect(stuck()).toBe(true);
		expect(clock.t).toBeGreaterThanOrEqual(45_000);
		expect(clock.t).toBeLessThan(50_000);
		expect(body.calls.filter((c) => c.fn === 'move').at(-1)?.args[0]).toMatchObject({ x: 0.5, y: Y + 8, z: 0.5 });
	});
});
