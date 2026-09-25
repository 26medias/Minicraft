import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EYE_HEIGHT } from 'minicraft-bot';
import { candidates, planCandidates } from '../src/body/candidates.js';
import type { EditGuard } from '../src/body/candidates.js';
import { inBodyBox, kidBuffer } from '../src/body/guard.js';
import type { KidInfo, Placement, Snapshot, Vec3 } from '../src/types.js';
import { AIR, FakeWorld } from './fake-port.js';

/**
 * Task 3 candidates and guard (spec §6, §12a): which actions are offered, and the kid buffer / body
 * box. `help_build` (§12a, gate 2): the kid's last 3 placements A, B, C0 collinear, consecutive,
 * same block, single-op, gaps ≤ 4 s, the last < 4 s old; his look target (a raycast hit) on B or a
 * face-neighbour of N = C0 + (C0 − B), held ≥ 1 s with no placement; at most once per line; N AIR,
 * outside every kid's buffer and body box, within 6 of the bot's eye; the block is C0's.
 */

// The body-box rule can't be isolated while the buffer is on (a body box's columns always lie inside
// the buffer), so one row switches the buffer OFF through this test-only mock of `kidBuffer`.
const flags = vi.hoisted(() => ({ bufferOff: false }));
vi.mock('../src/body/guard.js', async (importOriginal) => {
	const real = await importOriginal<typeof import('../src/body/guard.js')>();
	return { ...real, kidBuffer: (kids: readonly Vec3[]) => (flags.bufferOff ? new Set<string>() : real.kidBuffer(kids)) };
});

const T0 = 1_000_000;
/** High in the air over the fake world, so every cell used here is generated AIR. */
const Y = 200;

let world: FakeWorld;

function pose(x: number, y: number, z: number) {
	return { x, y, z, yaw: 0, pitch: 0 };
}

function kid(over: Partial<KidInfo> = {}): KidInfo {
	return {
		name: 'Noah',
		id: 1,
		pose: pose(100.5, Y, 100.5),
		velocity: { x: 0, y: 0, z: 0 },
		speedLast0_3s: 0,
		speedLast1s: 0,
		flying: false,
		inLiquid: false,
		lookTarget: null,
		lookBlock: null,
		lookDistance: null,
		lookHeldMs: 1500,
		placements: [],
		idleSinceMs: null,
		...over,
	};
}

function snap(over: Partial<Snapshot> = {}): Snapshot {
	return {
		nowMs: T0,
		followDist: 2,
		bot: { pose: pose(103.5, Y, 97.5), lastActions: [] },
		target: kid(),
		others: [],
		stopActiveForTarget: false,
		switchedFrom: null,
		...over,
	};
}

function guard(over: Partial<EditGuard> = {}): EditGuard {
	return {
		noEdits: false,
		budgetLeft: 50,
		editEveryMs: 2000,
		lastEditMs: null,
		offeredLines: new Set(),
		wanderTether: 12,
		anchor: { x: 100, y: Y, z: 100 },
		rng: mulberry32(1),
		...over,
	};
}

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * The standard line: the kid (at 100.5, 100.5) placed oak_planks going east at x = 103, 104, 105
 * (z = 100, y = Y), 3 s, 2 s and 1.5 s ago. N = (106, Y, 100): 5 columns from the kid (outside his
 * buffer x 99…101), 2.5 from the bot's eye. The kid looks at C0 (105, Y, 100), held 1.5 s.
 */
const A: Vec3 = { x: 103, y: Y, z: 100 };
const B: Vec3 = { x: 104, y: Y, z: 100 };
const C0: Vec3 = { x: 105, y: Y, z: 100 };
const N: Vec3 = { x: 106, y: Y, z: 100 };

function line(ages: [number, number, number] = [3000, 2000, 1500], blocks: [string, string, string] = ['oak_planks', 'oak_planks', 'oak_planks']): Placement[] {
	return [
		{ cell: A, block: blocks[0], ageMs: ages[0] },
		{ cell: B, block: blocks[1], ageMs: ages[1] },
		{ cell: C0, block: blocks[2], ageMs: ages[2] },
	];
}

function builder(over: Partial<KidInfo> = {}): KidInfo {
	return kid({ placements: line(), lookTarget: C0, lookHeldMs: 1500, ...over });
}

function offersHelp(s: Snapshot, g: EditGuard = guard()): boolean {
	return candidates(s, world, g).includes('help_build');
}

beforeEach(() => {
	world = new FakeWorld();
	flags.bufferOff = false;
	// The line's cells hold the kid's planks, as they would in the real world.
	for (const c of [A, B, C0]) world.set(c.x, c.y, c.z, 'oak_planks');
});

describe('kid buffer and body box', () => {
	it('the buffer: the columns the box overlaps, widened by 1 (Chebyshev)', () => {
		expect([...kidBuffer([pose(10.5, 64, 20.5)])].sort()).toEqual(['10,20', '10,21', '10,19', '11,20', '11,21', '11,19', '9,20', '9,21', '9,19'].sort());
		// A box straddling x = 11 (10.8 ± 0.3) covers columns 10 and 11, so the buffer is 9…12.
		const straddle = kidBuffer([pose(10.8, 64, 20.5)]);
		expect(straddle.has('12,20')).toBe(true);
		expect(straddle.has('13,20')).toBe(false);
		expect(straddle.has('8,20')).toBe(false);
	});

	it('the body box: x ± 0.3, z ± 0.3, feet to feet + 1.8', () => {
		const k = [pose(10.5, 64, 20.5)];
		expect(inBodyBox({ x: 10, y: 64, z: 20 }, k)).toBe(true);
		expect(inBodyBox({ x: 10, y: 65, z: 20 }, k)).toBe(true);
		expect(inBodyBox({ x: 10, y: 66, z: 20 }, k)).toBe(false);
		expect(inBodyBox({ x: 10, y: 63, z: 20 }, k)).toBe(false);
		expect(inBodyBox({ x: 11, y: 64, z: 20 }, k)).toBe(false);
	});
});

describe('help_build (§12a)', () => {
	it('offered for 3 collinear same-block placements with the look target along the line; N and C0 type', () => {
		const s = snap({ target: builder() });
		const plan = planCandidates(s, world, guard());
		expect(plan.candidates).toContain('help_build');
		expect(plan.helpBuild).toMatchObject({ cell: N, block: 'oak_planks' });
	});

	it.each<[string, Partial<KidInfo>]>([
		['look target on B', { lookTarget: B }],
		['look target on the ground under N', { lookTarget: { x: 106, y: Y - 1, z: 100 } }],
		['look target past N', { lookTarget: { x: 107, y: Y, z: 100 } }],
	])('offered with the %s', (_label, over) => {
		expect(offersHelp(snap({ target: builder(over) }))).toBe(true);
	});

	it.each<[string, Partial<KidInfo>]>([
		['only 2 placements', { placements: line().slice(1) }],
		['the kid turned away (look target elsewhere)', { lookTarget: { x: 100, y: Y - 1, z: 95 } }],
		['no look target', { lookTarget: null }],
		['the look held < 1 s', { lookHeldMs: 900 }],
		['the last placement < 1 s ago', { placements: line([2500, 1500, 900]) }],
		// B older than 4 s while C0 is ≥ 1 s old: only the B → C0 gap (4.3 s) refuses it.
		["B's age > 4 s (gap B → C0 > 4 s)", { placements: line([8000, 5500, 1200]) }],
		['the last placement ≥ 4 s old', { placements: line([9000, 6000, 4000]) }],
		['the gap A → B > 4 s', { placements: line([8000, 3500, 1500]) }],
		['mixed blocks', { placements: line(undefined, ['oak_planks', 'stone', 'oak_planks']) }],
		// The look target is on the odd C0, so only the geometry refuses these two.
		['not collinear (a turn)', { placements: [{ cell: A, block: 'oak_planks', ageMs: 3000 }, { cell: B, block: 'oak_planks', ageMs: 2000 }, { cell: { x: 104, y: Y, z: 101 }, block: 'oak_planks', ageMs: 1500 }], lookTarget: { x: 104, y: Y, z: 101 } }],
		['not consecutive (a gap in the line)', { placements: [{ cell: A, block: 'oak_planks', ageMs: 3000 }, { cell: B, block: 'oak_planks', ageMs: 2000 }, { cell: { x: 106, y: Y, z: 100 }, block: 'oak_planks', ageMs: 1500 }], lookTarget: { x: 106, y: Y, z: 100 } }],
		['an off-line placement since', { placements: [...line([3500, 3000, 2500]), { cell: { x: 90, y: Y, z: 90 }, block: 'oak_planks', ageMs: 1500 }] }],
	])('NOT offered: %s', (_label, over) => {
		expect(offersHelp(snap({ target: builder(over) }))).toBe(false);
	});

	it('NOT offered when N is planks (N must be AIR)', () => {
		world.set(N.x, N.y, N.z, 'oak_planks');
		expect(offersHelp(snap({ target: builder() }))).toBe(false);
	});

	it("NOT offered when N is in the target kid's buffer (a Chebyshev-1 column, not his own)", () => {
		// The kid stands at x 107.5: his box is column 107, his buffer 106…108 — N (106) is only in the buffer.
		const t = builder({ pose: pose(107.5, Y, 100.5), lookTarget: C0 });
		expect(inBodyBox(N, [t.pose])).toBe(false);
		expect(offersHelp(snap({ target: t }))).toBe(false);
	});

	it("NOT offered when N is in ANOTHER kid's buffer", () => {
		const other = kid({ name: 'Julien', id: 2, pose: pose(107.5, Y + 3, 101.5) });
		expect(inBodyBox(N, [other.pose])).toBe(false);
		expect(offersHelp(snap({ target: builder(), others: [other] }))).toBe(false);
		// Control: the same kid 2 columns further away does not block it.
		const far = kid({ name: 'Julien', id: 2, pose: pose(108.5, Y + 3, 101.5) });
		expect(offersHelp(snap({ target: builder(), others: [far] }))).toBe(true);
	});

	it('NOT offered when N is in a body box (buffer switched OFF, so only the body-box rule can refuse it)', () => {
		flags.bufferOff = true;
		// Julien stands IN N (his feet in N): N is AIR (a kid's body is air), in his body box.
		const inN = kid({ name: 'Julien', id: 2, pose: pose(106.5, Y, 100.5) });
		expect(offersHelp(snap({ target: builder(), others: [inN] }))).toBe(false);
		// Control: with the buffer off, a kid one column over (buffer-only) no longer blocks it.
		const beside = kid({ name: 'Julien', id: 2, pose: pose(107.5, Y, 100.5) });
		expect(offersHelp(snap({ target: builder(), others: [beside] }))).toBe(true);
	});

	it('NOT offered when N is further than 6 from the bot eye', () => {
		const eyeAt = (x: number) => snap({ target: builder(), bot: { pose: pose(x, Y - EYE_HEIGHT, 100.5), lastActions: [] } });
		// N's centre is (106.5, Y + 0.5, 100.5): the eye at Y (+ 0.5 below the centre).
		expect(offersHelp(eyeAt(106.5 + 5.9))).toBe(true);
		expect(offersHelp(eyeAt(106.5 + 6.1))).toBe(false);
	});

	it.each<[string, Partial<EditGuard> | null, Partial<Snapshot> | null, boolean]>([
		['a mustMine world', null, null, true],
		['--no-edits', { noEdits: true }, null, false],
		['budget 0', { budgetLeft: 0 }, null, false],
		['before the edit interval', { lastEditMs: T0 - 1999 }, null, false],
		['a stop active for this kid', null, { stopActiveForTarget: true }, false],
	])('NOT offered: %s', (_label, g, s, mustMine) => {
		world.mustMine = mustMine;
		expect(offersHelp(snap({ target: builder(), ...(s ?? {}) }), guard(g ?? {}))).toBe(false);
	});

	it('offered once the edit interval has elapsed', () => {
		expect(offersHelp(snap({ target: builder() }), guard({ lastEditMs: T0 - 2000 }))).toBe(true);
	});

	it('offered at most once per line', () => {
		const g = guard();
		expect(offersHelp(snap({ target: builder() }), g)).toBe(true);
		expect(offersHelp(snap({ target: builder() }), g)).toBe(false);
		// The kid extends the same line himself (B, C0, N): still the same line → not again.
		world.set(N.x, N.y, N.z, 'oak_planks');
		const extended = builder({ placements: [{ cell: B, block: 'oak_planks', ageMs: 3000 }, { cell: C0, block: 'oak_planks', ageMs: 2500 }, { cell: N, block: 'oak_planks', ageMs: 1500 }], lookTarget: N });
		expect(offersHelp(snap({ target: extended }), g)).toBe(false);
		// A parallel line one row over is a new line.
		const row = (x: number): Vec3 => ({ x, y: Y, z: 102 });
		for (const x of [103, 104, 105]) world.set(x, Y, 102, 'oak_planks');
		const parallel = builder({ placements: [{ cell: row(103), block: 'oak_planks', ageMs: 3000 }, { cell: row(104), block: 'oak_planks', ageMs: 2000 }, { cell: row(105), block: 'oak_planks', ageMs: 1500 }], lookTarget: row(105) });
		expect(offersHelp(snap({ target: parallel }), g)).toBe(true);
	});
});

describe('follow, watch, idle', () => {
	it('follow is offered only when far, moving, or more than 1.5 above/below', () => {
		const bot = pose(100.5, Y, 100.5);
		const at = (x: number, y: number, over: Partial<KidInfo> = {}) => candidates(snap({ bot: { pose: bot, lastActions: [] }, target: kid({ pose: pose(x, y, 100.5), ...over }) }), world, guard());
		expect(at(103, Y)).not.toContain('follow'); // 2.5 ≤ followDist + 1
		expect(at(103.6, Y)).toContain('follow'); // 3.1 > followDist + 1
		expect(at(101.5, Y, { speedLast0_3s: 0.5 })).toContain('follow'); // moving
		expect(at(101.5, Y, { speedLast0_3s: 0.4 })).not.toContain('follow');
		expect(at(102, Y + 6)).toContain('follow'); // the stairs case: 1.5 away, 6 above (§12b)
		expect(at(102, Y - 1.6)).toContain('follow');
		expect(at(102, Y + 1.5)).not.toContain('follow');
	});

	it('watch needs a target; idle is always offered', () => {
		expect(candidates(snap(), world, guard())).toEqual(expect.arrayContaining(['watch', 'idle']));
		expect(candidates(snap({ target: null }), world, guard())).not.toContain('watch');
		expect(candidates(snap({ target: null }), world, guard())).toContain('idle');
	});
});

describe('wander', () => {
	/** Ground-level bot and anchor on the generated terrain near (150, 150). */
	function groundPose(x: number, z: number) {
		const g = world.groundY(x, z, world.surfaceY(x, z) + 1);
		if (g === null) throw new Error('no ground');
		return pose(x, g, z);
	}

	it('only with no kid present', () => {
		const bot = groundPose(150.5, 150.5);
		const s = snap({ bot: { pose: bot, lastActions: [] } });
		expect(candidates(s, world, guard({ anchor: bot }))).not.toContain('wander');
		expect(candidates({ ...s, target: null }, world, guard({ anchor: bot }))).toContain('wander');
	});

	it('stays in the tether: 4–8 blocks from the bot and within wanderTether of the anchor, over 200 seeds', () => {
		const anchor = groundPose(150.5, 150.5);
		for (let seed = 1; seed <= 200; seed++) {
			const rng = mulberry32(seed);
			// The bot somewhere inside the tether.
			const bot = groundPose(anchor.x + (rng() - 0.5) * 16, anchor.z + (rng() - 0.5) * 16);
			const plan = planCandidates(snap({ target: null, bot: { pose: bot, lastActions: [] } }), world, guard({ anchor, rng }));
			if (!plan.wander) continue;
			const d = Math.hypot(plan.wander.x - bot.x, plan.wander.z - bot.z);
			expect(d).toBeGreaterThanOrEqual(3.5); // 4–8 before centring on the cell
			expect(d).toBeLessThanOrEqual(8.75);
			expect(Math.hypot(plan.wander.x - anchor.x, plan.wander.z - anchor.z)).toBeLessThanOrEqual(12);
			expect(world.isLiquid(world.getBlock(plan.wander.x, plan.wander.y, plan.wander.z))).toBe(false);
			expect(world.groundY(plan.wander.x, plan.wander.z, plan.wander.y)).toBe(plan.wander.y);
		}
	});

	it('a bot outside the tether wanders back toward the anchor', () => {
		const anchor = groundPose(150.5, 150.5);
		const bot = groundPose(150.5 + 30, 150.5);
		const plan = planCandidates(snap({ target: null, bot: { pose: bot, lastActions: [] } }), world, guard({ anchor, rng: mulberry32(7) }));
		expect(plan.wander).not.toBeNull();
		expect(Math.hypot(plan.wander!.x - anchor.x, plan.wander!.z - anchor.z)).toBeLessThan(30 - 3);
	});

	it('the wander cell is standable: not inside a solid block, and not in water', () => {
		const anchor = groundPose(150.5, 150.5);
		const plan = planCandidates(snap({ target: null, bot: { pose: anchor, lastActions: [] } }), world, guard({ anchor, rng: mulberry32(3) }));
		expect(plan.wander).not.toBeNull();
		const w = plan.wander!;
		expect(world.isSolid(world.getBlock(w.x, w.y, w.z))).toBe(false);
		expect(world.isSolid(world.getBlock(w.x, w.y - 1, w.z))).toBe(true);
		expect(world.getBlock(w.x, w.y + 1, w.z)).toBe(AIR);
	});
});
