import { describe, expect, it } from 'vitest';
import { createPerceiver } from '../../src/brain2/perception.js';
import { Ownership } from '../../src/brain2/ownership.js';
import { Store, initialState } from '../../src/brain2/store.js';
import { ManualClock } from '../../src/brain2/clock.js';
import { PIP } from '../../src/brain2/data/personalities.data.js';
import { FakeBody, FakeWorld, id, player } from '../fake-port.js';

function rig() {
	const clock = new ManualClock(0);
	const world = new FakeWorld();
	const body = new FakeBody();
	body.world = world;
	const store = new Store(initialState(PIP, body.current), clock.now);
	const own = new Ownership(world, () => store.state.owned);
	const p = createPerceiver({ body, world, own, store, tuning: { followDist: 2, idleSwitchMs: 30_000, minTargetMs: 20_000 }, clock: clock.now });
	const step = (ms = 500) => {
		clock.advance(ms);
		store.apply(p.tick(clock.t), { kind: 'perception', by: 'perceive' });
	};
	const kinds = () => store.state.events.map((e) => `${e.kind}${e.salient ? '*' : ''}`);
	return { clock, world, body, store, own, p, step, kinds };
}
const noah = (x = 5, z = 5, over = {}) => player({ id: 7, name: 'Noah', x, y: 64, z, ...over });

describe('perception v2 (spec §4.4, §5.1)', () => {
	it('arrivals and departures; other bots are ignored', () => {
		const r = rig();
		r.body.list = [noah(), player({ id: 8, name: 'Robo', bot: true })];
		r.step();
		r.body.list = [];
		r.step();
		expect(r.kinds()).toEqual(expect.arrayContaining(['player-arrived*', 'player-gone*']));
		expect(r.store.state.events.some((e) => e.player === 'Robo')).toBe(false);
		expect(r.store.state.relations.Noah.metSessions).toBe(1);
	});
	// Red if the bot's own edits become events (rev 2 M3: the bot appraised itself 12× a second).
	it('the bot\'s own edits are never events', () => {
		const r = rig();
		r.body.emitEdit({ by: 99, byName: 'Pip', byBot: true, opCount: 1, cells: [{ x: 5, y: 64, z: 6, oldId: 0, newId: id('stone') }] });
		r.step();
		expect(r.store.state.events).toEqual([]);
	});
	it('broke-my-block is detected before ownership forgets the cell', () => {
		const r = rig();
		r.world.set(3, 64, 3, 'stone');
		r.store.apply([r.own.ownWrite(3, 64, 3, id('stone'))], { kind: 'body', by: 't' });
		r.body.list = [noah()];
		r.world.set(3, 64, 3, 0);
		r.body.emitEdit({ by: 7, byName: 'Noah', byBot: false, opCount: 1, cells: [{ x: 3, y: 64, z: 3, oldId: id('stone'), newId: 0 }] });
		r.step();
		expect(r.kinds()).toContain('broke-my-block*');
		expect('3,64,3' in r.store.state.owned).toBe(false);
	});
	// Red without buckets (rev 3 M5): a kid placing a block every 2 s made ~20 salient bursts a minute.
	// Counted cumulatively through a store subscription (the event list is capped at 30), on cells that stay within
	// 16 blocks and are never 3 in a line (so no line-started crowds the list). Gate 2: the old version stayed green without buckets.
	it('steady building is salient only on bucket changes', () => {
		const r = rig();
		r.body.list = [noah(4, 4)];
		r.step();
		let salientPlaced = 0;
		const seen = new Set<number>();
		r.store.subscribe(() => {
			for (const e of r.store.state.events) if (!seen.has(e.id)) {
				seen.add(e.id);
				if (e.kind === 'placed' && e.salient) salientPlaced++;
			}
		});
		const spots = [[3, 5], [6, 2], [2, 8], [7, 7], [5, 1], [1, 3]];
		for (let i = 0; i < 30; i++) {
			const [x, z] = spots[i % spots.length];
			r.body.emitEdit({ by: 7, byName: 'Noah', byBot: false, opCount: 1, cells: [{ x, y: 64 + Math.floor(i / 6), z, oldId: 0, newId: id('stone') }] });
			r.step(2000);
		}
		expect(salientPlaced).toBeLessThanOrEqual(2);
		expect(salientPlaced).toBeGreaterThan(0);
	});

	it('line-started fires once per line with the next cell', () => {
		const r = rig();
		r.body.list = [noah(4, 4)];
		r.step();
		for (let i = 0; i < 4; i++) {
			r.body.emitEdit({ by: 7, byName: 'Noah', byBot: false, opCount: 1, cells: [{ x: 10 + i, y: 64, z: 4, oldId: 0, newId: id('oak_planks') }] });
			r.step(1000);
		}
		const lines = r.store.state.events.filter((e) => e.kind === 'line-started');
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0].detail!)).toMatchObject({ next: { x: 13, y: 64, z: 4 }, d: { x: 1, y: 0, z: 0 }, block: 'oak_planks' });
	});
	it('looking-at-me needs 2 s of gaze within 12°', () => {
		const r = rig();
		// The bot at (0, 64, 0); Noah at (0, 64, 5) facing −z (yaw 0 faces −z in this game), pitch pointing to the chest.
		r.body.current = { x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 0 };
		r.body.list = [noah(0.5, 5.5, { yaw: 0, pitch: -0.14 })];
		for (let i = 0; i < 3; i++) r.step(500);
		expect(r.kinds()).not.toContain('looking-at-me*');
		r.step(1000);
		expect(r.kinds()).toContain('looking-at-me*');
	});
	it('keeps at most 30 events, none older than 60 s', () => {
		const r = rig();
		r.body.list = [noah(100, 100)];
		for (let i = 0; i < 50; i++) {
			r.body.emitEdit({ by: 7, byName: 'Noah', byBot: false, opCount: 1, cells: [{ x: 100, y: 64, z: 110 + i, oldId: 0, newId: id('stone') }] });
			r.step(100);
		}
		expect(r.store.state.events.length).toBeLessThanOrEqual(30);
		r.step(61_000);
		expect(r.store.state.events.every((e) => r.clock.t - e.t <= 60_000)).toBe(true);
	});
});
