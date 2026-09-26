import { describe, expect, it } from 'vitest';
import { BehaviourRunner, type RunnerDeps } from '../../src/brain2/runner.js';
import { createPerceiver } from '../../src/brain2/perception.js';
import { Ownership } from '../../src/brain2/ownership.js';
import { Tripwire } from '../../src/brain2/safety.js';
import { Store, initialState } from '../../src/brain2/store.js';
import { ManualClock } from '../../src/brain2/clock.js';
import { PIP } from '../../src/brain2/data/personalities.data.js';
import { StopSignal } from '../../src/body/stop-signal.js';
import { FakeBody, FakeWorld, id, player } from '../fake-port.js';

// Open air at y 200 (seed 12345's surface is at y≈104–138), over a natural stone floor at y 199 so walks land at y 200.
const Y = 200;

/** The Task 10 runner rig with the real Help-build, a creative world unless `mustMine`. */
function helpRig(o: { mustMine?: boolean; inventory?: Record<string, number>; over?: Partial<RunnerDeps> } = {}) {
	const clock = new ManualClock(0);
	const world = new FakeWorld();
	world.mustMine = o.mustMine ?? false;
	for (let x = 0; x <= 48; x++) for (let z = 0; z <= 24; z++) world.setNatural(x, Y - 1, z, 'stone');
	const body = new FakeBody();
	body.world = world;
	body.current = { x: 13.5, y: Y, z: 7.5, yaw: 0, pitch: 0 };
	const store = new Store(initialState(PIP, body.current), clock.now);
	store.apply([{ path: ['inventory'], value: o.inventory ?? {} }], { kind: 'body', by: 'test' });
	const own = new Ownership(world, () => store.state.owned);
	const perceiver = createPerceiver({ body, world, own, store, tuning: { followDist: 2, idleSwitchMs: 30_000, minTargetMs: 20_000 }, clock: clock.now });
	const tripwire = new Tripwire(600);
	const stop = new StopSignal(600_000);
	const logs: Array<[string, unknown]> = [];
	const runner = new BehaviourRunner({
		store, body, world, own, perceiver, tripwire, stop, clock: clock.now, noEdits: () => false, fit: async () => 'yes',
		log: (k, d) => logs.push([k, d]), rng: () => 0, spawn: { x: 256, y: 120, z: 256 }, styleOverride: { editGapMs: 600 }, ...o.over,
	});
	const see = () => store.apply(perceiver.tick(clock.t), { kind: 'perception', by: 'perceive' });
	let pose = { x: 10.5, z: 13.5 };
	const kidAt = (name: string, x: number, y: number, z: number) => {
		pose = { x, z };
		body.list = [player({ id: 7, name, x, y, z })];
		see();
	};
	/** The kid places one block (his single-op edit), then 500 ms pass. */
	const kidPlaces = (name: string, [x, y, z]: number[], block: string) => {
		body.list = [player({ id: 7, name, x: pose.x, y: Y, z: pose.z })];
		world.set(x, y, z, block);
		body.emitEdit({ by: 7, byName: name, byBot: false, opCount: 1, cells: [{ x, y, z, oldId: 0, newId: id(block) }] });
		clock.advance(500);
		see();
	};
	const layLine = (name: string, cells: number[][], block: string) => {
		for (const c of cells) kidPlaces(name, c, block);
	};
	const startHelp = (name: string) => {
		const ev = store.state.events.filter((e) => e.kind === 'line-started' && e.player === name).at(-1);
		if (!ev) throw new Error('no line-started');
		runner.start('help-build', { kid: name, ...JSON.parse(ev.detail!) });
	};
	const ticks = async (n: number) => {
		for (let i = 0; i < n; i++) {
			clock.advance(100);
			see();
			await runner.tick();
		}
	};
	const placed = () => body.calls.filter((c) => c.fn === 'place').map((c) => c.args);
	const rejects = () => logs.filter(([k]) => k === 'reject');
	kidAt('Noah', 10.5, Y, 13.5);
	return { clock, world, body, store, runner, tripwire, stop, logs, see, kidAt, kidPlaces, layLine, startHelp, ticks, placed, rejects };
}
const LINE = [[10, Y, 10], [11, Y, 10], [12, Y, 10]];

describe('Help-build (spec §6)', () => {
	// Red if it takes from inventory in a creative world (R12), or places anything but Noah's next cells with his block.
	it('places the next cell of Noah\'s line, free, in a creative world', async () => {
		const r = helpRig({ inventory: { oak_planks: 5 } });
		r.layLine('Noah', LINE, 'oak_planks');
		r.startHelp('Noah');
		await r.ticks(1);
		expect(r.placed()).toEqual([[13, Y, 10, 'oak_planks']]);
		expect(r.store.state.inventory).toEqual({ oak_planks: 5 });
		expect(r.store.state.behaviour?.plannedEdits).toBe(3);
	});

	// Criterion 8: a 20-block line never trips. Red if plannedEdits isn't recomputed when Noah extends the line
	// (the overrun trips at the 4th bot edit), or if the bot doesn't follow the line forward.
	it('follows the line as Noah extends it, and recomputes plannedEdits', async () => {
		const r = helpRig();
		r.layLine('Noah', LINE, 'oak_planks');
		r.startHelp('Noah');
		for (let x = 15; x < 30; x += 3) {
			await r.ticks(20);                                 // the bot fills the two cells ahead of Noah
			r.kidAt('Noah', x - 1.5, Y, 13.5);
			r.kidPlaces('Noah', [x, Y, 10], 'oak_planks');   // Noah extends the line past them
		}
		await r.ticks(20);
		for (let x = 10; x < 30; x++) expect(r.world.getBlock(x, Y, 10), `x=${x}`).toBe(id('oak_planks'));
		expect(r.placed()).toHaveLength(12);
		expect(r.tripwire.halted).toBeNull();
		expect(r.store.state.behaviour?.kind).toBe('help-build');
	});

	// Red if a must-mine world places free, or running out writes no `need` / doesn't end.
	it('in a must-mine world it uses inventory and writes need when out', async () => {
		const r = helpRig({ mustMine: true, inventory: { oak_planks: 1 } });
		r.layLine('Noah', LINE, 'oak_planks');
		r.startHelp('Noah');
		await r.ticks(10);
		expect(r.placed()).toHaveLength(1);
		expect(r.store.state.inventory.oak_planks).toBe(0);
		expect(r.store.state.events.filter((e) => e.kind === 'need')).toEqual([expect.objectContaining({ detail: 'oak_planks', salient: true })]);
		expect(r.store.state.memory.past[0]).toMatchObject({ behaviour: 'help-build', outcome: 'failed', why: 'need oak_planks' });
	});

	// Red if it never ends, or ends before 15 s of Noah placing nothing on the line.
	it('done after 15 s without the kid placing on the line', async () => {
		const r = helpRig();
		r.layLine('Noah', LINE, 'oak_planks');
		r.startHelp('Noah');
		const t0 = r.clock.t - 500;                            // Noah's last placement
		while (r.clock.t < t0 + 14_900) await r.ticks(1);
		expect(r.store.state.behaviour?.kind).toBe('help-build');
		await r.ticks(6);                                     // by 15.5 s (its idle `wait` is 500 ms)
		expect(r.store.state.memory.past[0]).toMatchObject({ behaviour: 'help-build', outcome: 'done' });
	});

	// Red if it keeps proposing the filled cell (the safety tier would reject it: 'cell not air').
	it('never places into a cell the kid filled first', async () => {
		const r = helpRig();
		r.layLine('Noah', LINE, 'oak_planks');
		r.startHelp('Noah');
		r.kidPlaces('Noah', [13, Y, 10], 'dirt');            // not his line's block: the line doesn't move
		await r.ticks(10);
		expect(r.placed()).toEqual([[14, Y, 10, 'oak_planks']]);
		expect(r.rejects()).toEqual([]);
	});

	// The rev 3.1 defect lived in the runner. Red if the runner counts non-plan rejections as plan vetoes.
	it('a kid standing on the next cell for 2 ticks does not trip the overrun', async () => {
		const r = helpRig();
		r.layLine('Noah', LINE, 'oak_planks');
		r.startHelp('Noah');
		r.kidAt('Noah', 13.5, Y, 10.5);                       // standing on the next cell
		await r.ticks(2);                                     // 2 safety rejections (body buffer)
		expect(r.rejects()).toHaveLength(2);
		r.kidAt('Noah', 13.5, Y, 14.5);                       // steps away
		await r.ticks(30);
		expect(r.placed()).toHaveLength(2);                   // the plan's two `ahead` cells
		expect(r.tripwire.halted).toBeNull();
	});

	// Fix-round finding 1: a line out of vertical reach. Red on the old code, which walked to a fixed 3-block
	// horizontal offset ignoring height, "arrived" instantly (FakeBody snaps to the target), and looped forever
	// without ever placing or ending — 20 ticks left it still in help-build with nothing placed.
	it('a line 6 blocks above the bot ends failed: stuck out of reach', async () => {
		const r = helpRig();
		const HIGH = Y + 6;
		r.layLine('Noah', [[10, HIGH, 10], [11, HIGH, 10], [12, HIGH, 10]], 'oak_planks');
		r.startHelp('Noah');
		await r.ticks(20);
		expect(r.placed()).toEqual([]);
		expect(r.store.state.memory.past[0]).toMatchObject({ behaviour: 'help-build', outcome: 'failed', why: 'stuck: out of reach' });
	});

	// Spec §7.1 (batch A ruling 1): no Help-build for a kid with an active stop signal, at any distance. Noah stands
	// 30 blocks from the line, outside STOP_RADIUS, so the safety tier's radius can't refuse first. Red without the rule.
	it('never helps a kid with an active stop signal', async () => {
		const breakBy = (r: ReturnType<typeof helpRig>) => r.stop.onEdit(
			{ by: 7, byName: 'Noah', byBot: false, opCount: 1, cells: [{ x: 1, y: 1, z: 1, oldId: 1, newId: 0 }] },
			[{ x: 1, y: 1, z: 1, oldId: 0, newId: 1, t: 0 }], r.clock.t);
		const mid = helpRig();
		mid.layLine('Noah', LINE, 'oak_planks');
		mid.startHelp('Noah');
		mid.kidAt('Noah', 10.5, Y, 40.5);
		breakBy(mid);
		await mid.ticks(5);
		expect(mid.placed()).toEqual([]);
		expect(mid.store.state.memory.past[0]).toMatchObject({ behaviour: 'help-build', outcome: 'failed', why: 'stop signal' });

		const before = helpRig();
		before.layLine('Noah', LINE, 'oak_planks');
		before.kidAt('Noah', 10.5, Y, 40.5);
		breakBy(before);
		before.startHelp('Noah');
		expect(before.store.state.memory.past[0]).toMatchObject({ outcome: 'failed', why: 'stop signal' });
		await before.ticks(5);
		expect(before.placed()).toEqual([]);
	});
});
