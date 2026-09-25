import { beforeEach, describe, expect, it } from 'vitest';
import { EYE_HEIGHT } from 'minicraft-bot';
import type { BotPlayer } from 'minicraft-bot';
import { bearing, createPerception, perceive, recordAction, renderText } from '../src/body/perceive.js';
import type { PerceptionState } from '../src/body/perceive.js';
import { StopSignal } from '../src/body/stop-signal.js';
import type { KidInfo, Snapshot } from '../src/types.js';
import { AIR, FakeBody, FakeWorld, id, player } from './fake-port.js';

/**
 * Task 3 perception (spec §6, §12a, §12b): the snapshot built from a fake body over the real
 * generator, the sticky target keyed by NAME with idle rotation, kid motion and the flying flag,
 * the look target, the placement filter, and the deterministic text state.
 */

const TUNING = { followDist: 2, idleSwitchMs: 30_000, minTargetMs: 20_000 };
const T0 = 1_000_000;

let world: FakeWorld;
let body: FakeBody;
let now: number;
let state: PerceptionState;
let stop: StopSignal;

function tick(): Snapshot {
	return perceive(state, body, world, now).snapshot;
}

/** Advances the clock in `stepMs` steps up to `ms`, perceiving each step; returns the last snapshot. */
function advance(ms: number, stepMs = 500, each?: (s: Snapshot) => void): Snapshot {
	let s = tick();
	for (let t = stepMs; t <= ms; t += stepMs) {
		now += stepMs;
		s = tick();
		each?.(s);
	}
	return s;
}

/** Feet y standing on the ground at (x, z). */
function feet(x: number, z: number): number {
	const g = world.groundY(x, z, world.surfaceY(x, z) + 1);
	if (g === null) throw new Error('no ground');
	return g;
}

function kid(name: string, pid: number, x: number, z: number, extra: Partial<BotPlayer> = {}): BotPlayer {
	return player({ id: pid, name, x, y: feet(x, z), z, ...extra });
}

function setKids(...kids: BotPlayer[]): void {
	body.list = kids;
}

/** Walks a kid around a 1-block square, one step per call: over any 1 s window (2 ticks of 500 ms)
 *  he has moved √2, so he is never idle. (Back-and-forth would cancel out over the window.) */
const SQUARE: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const wiggles = new Map<string, number>();
function wiggle(name: string): void {
	const i = wiggles.get(name) ?? 0;
	wiggles.set(name, i + 1);
	const [dx, dz] = SQUARE[i % 4];
	moveKid(name, dx, dz);
}

function moveKid(name: string, dx: number, dz: number): void {
	const p = body.list.find((k) => k.name === name)!;
	p.x += dx;
	p.z += dz;
	p.y = feet(p.x, p.z);
}

beforeEach(() => {
	world = new FakeWorld();
	body = new FakeBody();
	now = T0;
	stop = new StopSignal(600_000);
	wiggles.clear();
	state = createPerception(body, { tuning: TUNING, clock: () => now, stop });
	const bx = 200.5, bz = 200.5;
	body.current = { x: bx, y: feet(bx, bz), z: bz, yaw: 0, pitch: 0 };
});

describe('bearing (north = −z, 8 points)', () => {
	it.each([
		[0, -1, 'north'],
		[1, -1, 'north-east'],
		[1, 0, 'east'],
		[1, 1, 'south-east'],
		[0, 1, 'south'],
		[-1, 1, 'south-west'],
		[-1, 0, 'west'],
		[-1, -1, 'north-west'],
	])('dx %d, dz %d → %s', (dx, dz, want) => {
		expect(bearing(dx, dz)).toBe(want);
	});
});

describe('target selection', () => {
	it('picks the nearest kid; bots and pose-less players are not kids', () => {
		setKids(
			player({ id: 5, name: 'Robo2', bot: true, x: 201, y: feet(201, 200), z: 200 }),
			player({ id: 6, name: 'Ghost', hasPos: false, x: 201, y: 0, z: 201 }),
			kid('Noah', 1, 206, 200),
			kid('Julien', 2, 210, 200),
		);
		const s = tick();
		expect(s.target?.name).toBe('Noah');
		expect(s.others.map((k) => k.name)).toEqual(['Julien']);
	});

	it('is sticky: a second kid who comes nearer does not take the target', () => {
		setKids(kid('Noah', 1, 206, 200), kid('Julien', 2, 212, 200));
		expect(tick().target?.name).toBe('Noah');
		moveKid('Julien', -10, 0); // Julien is now 1.5 away, Noah 5.5
		now += 500;
		expect(tick().target?.name).toBe('Noah');
	});

	it('reconnect: a new id with the same name keeps the same target', () => {
		setKids(kid('Noah', 1, 206, 200), kid('Julien', 2, 212, 200));
		expect(tick().target?.name).toBe('Noah');
		moveKid('Julien', -10, 0); // Julien is nearer now
		now += 500;
		tick();
		// Noah drops and comes back with a new id, in the same tick.
		setKids(kid('Julien', 2, 202, 200), kid('Noah', 7, 206, 200));
		now += 500;
		const s = tick();
		expect(s.target?.name).toBe('Noah');
		expect(s.target?.id).toBe(7);
	});

	it('drops a kid who leaves, and picks the nearest remaining one', () => {
		setKids(kid('Noah', 1, 206, 200), kid('Julien', 2, 212, 200));
		tick();
		setKids(kid('Julien', 2, 212, 200));
		now += 500;
		expect(tick().target?.name).toBe('Julien');
	});
});

describe('target rotation (spec §12b)', () => {
	it('an idle target plus another kid online → switches to the nearest OTHER kid after idleSwitchMs', () => {
		setKids(kid('Noah', 1, 204, 200), kid('Julien', 2, 212, 200), kid('Mia', 3, 218, 200));
		expect(tick().target?.name).toBe('Noah');
		const seen: string[] = [];
		// Noah stands still; Julien and Mia keep walking around.
		const s = advance(35_000, 500, (snap) => {
			seen.push(snap.target!.name);
			wiggle('Julien');
			wiggle('Mia');
		});
		// Still Noah until he has been idle for idleSwitchMs (30 s since first seen at T0).
		const firstSwitch = seen.findIndex((n) => n !== 'Noah');
		expect(firstSwitch).toBe(59); // the tick at T0 + 30 000 ms (60 × 500 ms, 0-based from +500)
		expect(s.target?.name).toBe('Julien'); // Julien is nearer than Mia
		expect(s.switchedFrom?.name).toBe('Noah');
		expect(s.switchedFrom!.idleMs).toBeGreaterThanOrEqual(30_000);
	});

	it('a single idle kid → no switch, ever', () => {
		setKids(kid('Noah', 1, 204, 200));
		advance(90_000, 500, (snap) => expect(snap.target?.name).toBe('Noah'));
	});

	it('the new target is kept ≥ minTargetMs even when the old kid moves; all idle → round-robin, at most once per minTargetMs', () => {
		setKids(kid('Noah', 1, 204, 200), kid('Julien', 2, 212, 200));
		const switches: { at: number; to: string }[] = [];
		let last = tick().target!.name;
		advance(95_000, 500, (snap) => {
			if (snap.target!.name !== last) {
				switches.push({ at: now - T0, to: snap.target!.name });
				last = snap.target!.name;
			}
			// For 10 s after the first switch, Noah (the old target) walks: Julien is still kept.
			if (switches.length === 1 && now - T0 < switches[0].at + 10_000) wiggle('Noah');
		});
		// Both idle from T0: Noah idle 30 s → Julien (kept 20 s even though Noah moved) → Noah (active
		// again) → then both idle: round-robin, one switch per minTargetMs.
		expect(switches).toEqual([
			{ at: 30_000, to: 'Julien' },
			{ at: 50_000, to: 'Noah' },
			// Noah's last step (made at 39.5 s) is still inside the 1 s window at 40.5 s: idle from then.
			{ at: 70_500, to: 'Julien' },
			{ at: 90_500, to: 'Noah' },
		]);
	});

	it('an edit by the target counts as activity (no switch while he builds)', () => {
		setKids(kid('Noah', 1, 204, 200), kid('Julien', 2, 212, 200));
		const noah = body.list[0];
		let n = 0;
		advance(60_000, 500, (snap) => {
			expect(snap.target?.name).toBe('Noah');
			if (++n % 20 === 0) body.kidEdit(world, noah, { x: 206, y: feet(206, 203) + n / 20, z: 203 }, id('stone'));
		});
	});
});

describe('kid motion', () => {
	it('velocity from pose samples over the last 1 s', () => {
		setKids(kid('Noah', 1, 206.5, 200.5));
		tick();
		for (let i = 0; i < 4; i++) {
			now += 250;
			moveKid('Noah', 1.25, 0); // 5 b/s east
			tick();
		}
		const s = tick();
		expect(s.target!.velocity.x).toBeCloseTo(5, 5);
		expect(s.target!.velocity.z).toBeCloseTo(0, 5);
		expect(s.target!.speedLast1s).toBeCloseTo(5, 5);
		expect(s.target!.speedLast0_3s).toBeCloseTo(5, 5);
	});

	it('a still kid has zero speed', () => {
		setKids(kid('Noah', 1, 206.5, 200.5));
		const s = advance(2000);
		expect(s.target!.speedLast1s).toBe(0);
		expect(s.target!.idleSinceMs).toBe(T0);
	});
});

describe('the flying flag (§12a)', () => {
	const X = 230.5, Z = 230.5;

	it('a kid hovering 20 blocks above the ground → flying, only after > 0.5 s', () => {
		setKids(player({ id: 1, name: 'Noah', x: X, y: feet(X, Z) + 20, z: Z }));
		expect(tick().target!.flying).toBe(false);
		now += 400;
		expect(tick().target!.flying).toBe(false);
		now += 200;
		expect(tick().target!.flying).toBe(true);
	});

	it('a jump apex of 1.33 → never flying', () => {
		setKids(player({ id: 1, name: 'Noah', x: X, y: feet(X, Z) + 1.33, z: Z }));
		advance(3000, 250, (s) => expect(s.target!.flying).toBe(false));
	});

	it('a kid swimming at the surface of a 4-deep lake → NOT flying (in liquid)', () => {
		const g = feet(X, Z);
		// Dig a 7 × 7 pit 4 deep and flood it: the bed is at g − 4, water fills g − 4 … g − 1.
		world.fill({ x: 227, y: g - 4, z: 227 }, { x: 233, y: g + 3, z: 233 }, AIR);
		world.fill({ x: 227, y: g - 4, z: 227 }, { x: 233, y: g - 1, z: 233 }, 'water');
		expect(world.groundY(X, Z, g)).toBe(g - 4);
		setKids(player({ id: 1, name: 'Noah', x: X, y: g - 0.8, z: Z }));
		const s = advance(3000, 250, (snap) => expect(snap.target!.flying).toBe(false));
		expect(s.target!.inLiquid).toBe(true);
	});

	it('a kid on a cliff edge, centre over air but box on the block → NOT flying', () => {
		const g = feet(X, Z);
		// Column x = 231 is a deep drop; the kid stands on column 230 with his centre at x = 231.2.
		world.fill({ x: 231, y: g - 20, z: 225 }, { x: 236, y: g + 5, z: 236 }, AIR);
		world.fill({ x: 230, y: g, z: 225 }, { x: 230, y: g + 5, z: 236 }, AIR);
		world.set(230, g - 1, 230, 'stone');
		setKids(player({ id: 1, name: 'Noah', x: 231.2, y: g, z: Z }));
		expect(world.groundY(231.2, Z, g)).toBeLessThan(g - 1.5);
		advance(3000, 250, (s) => expect(s.target!.flying).toBe(false));
	});
});

describe('look target', () => {
	/** A flat run of 4 cells going north from (x, z), same surface height, with 3 cells of air above. */
	function findFlatRun(): { x: number; z: number; g: number } {
		for (let x = 150; x < 300; x++) {
			for (let z = 150; z < 300; z++) {
				const g = feet(x, z);
				let ok = true;
				for (let k = 0; k < 4 && ok; k++) {
					if (feet(x, z - k) !== g) ok = false;
					for (let y = g; y < g + 3 && ok; y++) if (world.getBlock(x, y, z - k) !== AIR) ok = false;
				}
				// Open sky above the kid, for the looking-up row.
				for (let y = g; y < g + 10 && ok; y++) if (world.getBlock(x, y, z) !== AIR) ok = false;
				if (ok) return { x, z, g };
			}
		}
		throw new Error('no flat run');
	}

	it('the raycast from the kid eye hits the generated ground 2 cells ahead (yaw 0 = north)', () => {
		const { x, z, g } = findFlatRun();
		// From the eye (1.6 up), a pitch of −atan(1.6 / 2.3) lands on the top face 2.3 ahead: cell z − 2.
		const pitch = -Math.atan2(EYE_HEIGHT, 2.3);
		setKids(player({ id: 1, name: 'Noah', x: x + 0.5, y: g, z: z + 0.5, yaw: 0, pitch }));
		const s = tick();
		expect(s.target!.lookTarget).toEqual({ x, y: g - 1, z: z - 2 });
		expect(s.target!.lookBlock).toBe(world.blockName(world.generatedBlock(x, g - 1, z - 2)));
		expect(s.target!.lookDistance).toBeCloseTo(Math.hypot(EYE_HEIGHT, 2.3), 5);
	});

	it('looking at the sky → no look target; the held time resets when the target changes', () => {
		const { x, z, g } = findFlatRun();
		setKids(player({ id: 1, name: 'Noah', x: x + 0.5, y: g, z: z + 0.5, yaw: 0, pitch: Math.PI / 2 - 0.01 }));
		expect(tick().target!.lookTarget).toBeNull();
		now += 1500;
		expect(tick().target!.lookHeldMs).toBe(1500);
		body.list[0].pitch = -Math.atan2(EYE_HEIGHT, 2.3);
		now += 500;
		expect(tick().target!.lookHeldMs).toBe(0);
		now += 700;
		expect(tick().target!.lookHeldMs).toBe(700);
	});
});

describe('placement filtering', () => {
	it('keeps only single-op, solid, non-liquid placements BY that kid; last 5, with name and age', () => {
		const noah = kid('Noah', 1, 206, 200);
		const julien = kid('Julien', 2, 212, 200);
		setKids(noah, julien);
		tick();
		const y = 120;
		body.kidEdit(world, noah, { x: 206, y, z: 205 }, id('oak_planks')); // kept
		now += 100;
		body.kidEdit(world, noah, { x: 207, y, z: 205 }, id('stone'), 3); // multi-op (TNT, area pick): ignored
		now += 100;
		body.kidEdit(world, noah, { x: 208, y, z: 205 }, id('water')); // liquid: ignored
		now += 100;
		body.kidEdit(world, julien, { x: 209, y, z: 205 }, id('stone')); // another player's: not Noah's
		now += 100;
		body.emitEdit({ by: body.you, byName: null, byBot: true, opCount: 1, cells: [{ x: 210, y, z: 205, oldId: AIR, newId: id('stone') }] }); // the bot's own
		now += 100;
		body.kidEdit(world, noah, { x: 206, y, z: 205 }, AIR); // a break: not a placement
		now += 500;
		const s = tick();
		expect(s.target!.name).toBe('Noah');
		expect(s.target!.placements).toEqual([{ cell: { x: 206, y, z: 205 }, block: 'oak_planks', ageMs: 1000 }]);
		expect(s.others[0].placements.map((p) => p.cell.x)).toEqual([209]);
	});

	it('keeps the last 5, oldest first', () => {
		const noah = kid('Noah', 1, 206, 200);
		setKids(noah);
		for (let i = 0; i < 7; i++) {
			body.kidEdit(world, noah, { x: 210 + i, y: 130, z: 200 }, id('stone'));
			now += 100;
		}
		const s = tick();
		expect(s.target!.placements.map((p) => p.cell.x)).toEqual([212, 213, 214, 215, 216]);
		expect(s.target!.placements.map((p) => p.ageMs)).toEqual([500, 400, 300, 200, 100]);
	});
});

describe('snapshot plumbing', () => {
	it('carries followDist, the bot pose, the last 3 actions and the stop state for the target', () => {
		setKids(kid('Noah', 1, 206, 200));
		recordAction(state, 'follow');
		recordAction(state, 'watch');
		recordAction(state, 'help_build');
		recordAction(state, 'watch');
		let s = tick();
		expect(s.followDist).toBe(2);
		expect(s.bot.pose).toEqual(body.pose());
		expect(s.bot.lastActions).toEqual(['watch', 'help_build', 'watch']);
		expect(s.stopActiveForTarget).toBe(false);
		body.entries = [{ x: 206, y: 150, z: 206, oldId: AIR, newId: id('stone'), t: 0 }];
		stop.onEdit({ by: 1, byName: 'Noah', byBot: false, opCount: 1, cells: [{ x: 206, y: 150, z: 206, oldId: id('stone'), newId: AIR }] }, body.journal(), now);
		s = tick();
		expect(s.stopActiveForTarget).toBe(true);
	});

	it('no kid → target null, text says so', () => {
		const s = tick();
		expect(s.target).toBeNull();
		expect(renderText(s)).toBe('No one is here. You have not done anything yet.');
	});
});

describe('renderText: exact fixtures', () => {
	function k(over: Partial<KidInfo>): KidInfo {
		return {
			name: 'Noah',
			id: 1,
			pose: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 },
			velocity: { x: 0, y: 0, z: 0 },
			speedLast0_3s: 0,
			speedLast1s: 0,
			flying: false,
			inLiquid: false,
			lookTarget: null,
			lookBlock: null,
			lookDistance: null,
			lookHeldMs: 0,
			placements: [],
			idleSinceMs: null,
			...over,
		};
	}
	function snap(over: Partial<Snapshot>): Snapshot {
		return {
			nowMs: T0,
			followDist: 2,
			bot: { pose: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 }, lastActions: [] },
			target: null,
			others: [],
			stopActiveForTarget: false,
			switchedFrom: null,
			...over,
		};
	}

	it('the asymmetric row: a kid at +dx, −dz is NORTH-EAST (not south-west), walking, building a line east', () => {
		const s = snap({
			bot: { pose: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 }, lastActions: ['watch', 'follow'] },
			target: k({
				pose: { x: 4.4, y: 64, z: -4.4, yaw: 0, pitch: 0 },
				speedLast0_3s: 3,
				speedLast1s: 3,
				lookTarget: { x: 5, y: 63, z: -6 },
				lookBlock: 'stone',
				lookDistance: 2,
				placements: [
					{ cell: { x: 5, y: 64, z: -8 }, block: 'oak_planks', ageMs: 9000 },
					{ cell: { x: 6, y: 64, z: -8 }, block: 'oak_planks', ageMs: 6000 },
					{ cell: { x: 7, y: 64, z: -8 }, block: 'oak_planks', ageMs: 3000 },
				],
			}),
		});
		expect(renderText(s)).toBe(
			'Noah is 6.2 blocks north-east, walking. Noah is looking at stone 2.0 blocks ahead. Noah placed oak_planks 3 times in the last 20 seconds, in a line going east. You last followed Noah.',
		);
	});

	it('flying above, not looking at anything, no placements, another kid, a stop, a switch', () => {
		const s = snap({
			bot: { pose: { x: 10, y: 64, z: 10, yaw: 0, pitch: 0 }, lastActions: ['help_build'] },
			target: k({ pose: { x: 7, y: 70, z: 14, yaw: 0, pitch: 0 }, flying: true, speedLast0_3s: 6 }),
			others: [k({ name: 'Julien', id: 2, pose: { x: 10, y: 64, z: 22, yaw: 0, pitch: 0 } })],
			stopActiveForTarget: true,
			switchedFrom: { name: 'Julien', idleMs: 31_000 },
		});
		expect(renderText(s)).toBe(
			'Noah is 7.8 blocks south-west, 6.0 above you, flying. Noah is not looking at any block. You came to Noah because Julien stood still for 31 seconds. Also here: Julien, 12.0 blocks south. Noah broke one of your blocks: do not build for Noah now. You last helped Noah build.',
		);
	});

	it('swimming below, standing still, mixed placements without a line', () => {
		const s = snap({
			target: k({
				pose: { x: 0, y: 60, z: 3, yaw: 0, pitch: 0 },
				inLiquid: true,
				placements: [
					{ cell: { x: 1, y: 60, z: 1 }, block: 'stone', ageMs: 25_000 },
					{ cell: { x: 5, y: 60, z: 1 }, block: 'stone', ageMs: 4000 },
					{ cell: { x: 9, y: 61, z: 1 }, block: 'glass', ageMs: 2000 },
				],
			}),
		});
		expect(renderText(s)).toBe(
			'Noah is 5.0 blocks south, 4.0 below you, swimming. Noah is not looking at any block. Noah placed 2 blocks in the last 20 seconds. You have not done anything yet.',
		);
	});

	it('is deterministic: the same snapshot renders the same text', () => {
		const s = snap({ target: k({ pose: { x: -3, y: 64, z: 0, yaw: 0, pitch: 0 } }) });
		expect(renderText(s)).toBe(renderText(structuredClone(s)));
		expect(renderText(s)).toBe('Noah is 3.0 blocks west, standing still. Noah is not looking at any block. You have not done anything yet.');
	});
});
