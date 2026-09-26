import { beforeEach, describe, expect, it } from 'vitest';
import { BlockedError } from 'minicraft-bot';
import { BehaviourRunner } from '../../src/brain2/runner.js';
import { markSeen, resetSeenBlocks } from '../../src/brain2/behaviours/explore.js';
import { createPerceiver } from '../../src/brain2/perception.js';
import { Ownership } from '../../src/brain2/ownership.js';
import { Tripwire } from '../../src/brain2/safety.js';
import { Store, initialState } from '../../src/brain2/store.js';
import { ManualClock } from '../../src/brain2/clock.js';
import { PIP } from '../../src/brain2/data/personalities.data.js';
import { StopSignal } from '../../src/body/stop-signal.js';
import { FakeBody, FakeWorld } from '../fake-port.js';

// A flat natural stone platform at y 199 (feet 200) high above seed 12345's terrain, around world spawn (256, 256).
const P0 = 200, P1 = 312, FLOOR = 199, FEET = 200;
const SPAWN = { x: 256, y: FEET, z: 256 };

function rig() {
	const clock = new ManualClock(0);
	const world = new FakeWorld();
	for (let x = P0; x <= P1; x++) for (let z = P0; z <= P1; z++) world.setNatural(x, FLOOR, z, 'stone');
	const body = new FakeBody();
	body.world = world;
	body.current = { x: 256.5, y: FEET, z: 256.5, yaw: 0, pitch: 0 };
	const store = new Store(initialState(PIP, body.current), clock.now);
	const own = new Ownership(world, () => store.state.owned);
	const perceiver = createPerceiver({ body, world, own, store, tuning: { followDist: 2, idleSwitchMs: 30_000, minTargetMs: 20_000 }, clock: clock.now });
	const runner = new BehaviourRunner({
		store, body, world, own, perceiver, tripwire: new Tripwire(600), stop: new StopSignal(600_000), clock: clock.now, noEdits: () => false,
		fit: async () => 'yes', log: () => {}, rng: () => 0, spawn: SPAWN,
	});
	const ticks = async (n: number) => {
		for (let i = 0; i < n; i++) {
			clock.advance(100);
			store.apply(perceiver.tick(clock.t), { kind: 'perception', by: 'perceive' });
			await runner.tick();
		}
	};
	const walks = () => body.calls.filter((c) => c.fn === 'walkTo').map((c) => c.args[0] as { x: number; z: number });
	const found = () => store.state.events.filter((e) => e.kind === 'found');
	return { clock, world, body, store, runner, ticks, walks, found };
}

beforeEach(() => {
	resetSeenBlocks();
	markSeen(['stone']);
});

describe('Explore (spec §6)', () => {
	// Red if the waypoints aren't walked in order along the chosen direction, or explored isn't marked on arrival.
	it('walks the waypoints in order and marks explored chunks', async () => {
		const r = rig();
		r.runner.start('explore', {});
		await r.ticks(8);
		// No kid, no build: the anchor is world spawn; everything unexplored → north (−z), 12 apart, clamped to the leash.
		expect(r.walks().slice(0, 3)).toEqual([{ x: 256.5, z: 244.5 }, { x: 256.5, z: 232.5 }, { x: expect.closeTo(256.47, 1), z: expect.closeTo(224.03, 1) }]);
		const explored = Object.keys(r.store.state.explored);
		// The first waypoint (chunk 16,15) and the 8 around it.
		for (let cx = 15; cx <= 17; cx++) for (let cz = 14; cz <= 16; cz++) expect(explored).toContain(`${cx},${cz}`);
		expect(explored.length).toBeGreaterThan(9);
		expect(r.store.state.behaviour?.kind).toBe('explore');
	});

	// Red if a found fires for an already-seen block, fires twice, or doesn't end the behaviour.
	it('a never-seen surface block near a waypoint gives one found and ends it done; a second visit does not', async () => {
		const r = rig();
		r.world.setNatural(257, FLOOR, 235, 'sand');         // within 8 of the second waypoint only
		r.runner.start('explore', {});
		for (let i = 0; i < 50 && r.store.state.behaviour; i++) await r.ticks(1);
		expect(r.found()).toHaveLength(1);
		expect(r.found()[0]).toMatchObject({ block: 'sand', cell: { x: 257, y: FLOOR, z: 235 }, salient: true });
		expect(r.store.state.memory.past[0]).toMatchObject({ behaviour: 'explore', outcome: 'done' });
		expect(r.walks()).toHaveLength(2);                   // done right after the second waypoint
		// Back to the start, the same way again: sand is seen this session, so no new found.
		r.body.current = { x: 256.5, y: FEET, z: 256.5, yaw: 0, pitch: 0 };
		r.runner.start('explore', { dir: [0, -1] });
		await r.ticks(8);
		expect(r.walks().length).toBeGreaterThanOrEqual(4);
		expect(r.found()).toHaveLength(1);
		expect(r.store.state.behaviour?.kind).toBe('explore');
	});

	// Red if blocked walks are retried forever, or the failure isn't `stuck`.
	it('fails stuck after 3 blocked walks', async () => {
		const r = rig();
		r.body.walkImpl = () => Promise.reject(new BlockedError(r.body.pose(), 'wall'));
		r.runner.start('explore', {});
		for (let i = 0; i < 20 && r.store.state.behaviour; i++) await r.ticks(1);
		expect(r.walks()).toHaveLength(3);
		expect(r.store.state.memory.past[0]).toMatchObject({ behaviour: 'explore', outcome: 'failed', why: 'stuck' });
		expect(r.store.state.events.some((e) => e.kind === 'stuck')).toBe(true);
	});

	// Red if the duration isn't honoured.
	it('ends done after its duration (60–120 s)', async () => {
		const r = rig();
		r.runner.start('explore', {});
		await r.ticks(590);
		expect(r.store.state.behaviour?.kind).toBe('explore');
		await r.ticks(20);
		expect(r.store.state.memory.past[0]).toMatchObject({ behaviour: 'explore', outcome: 'done' });
	});
});
