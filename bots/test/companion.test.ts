import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlockedError, EYE_HEIGHT, FLY_SPEED, WALK_SPEED } from 'minicraft-bot';
import type { BotPlayer, PoseInput, WalkResult } from 'minicraft-bot';
import { hopCell, watchPoint } from '../src/body/act.js';
import { columnKey, kidBuffer } from '../src/body/guard.js';
import { DECISION_KEYS, jsonlLogger } from '../src/body/log.js';
import type { DecisionEntry, Logger } from '../src/body/log.js';
import type { Answer, Brain, Choice } from '../src/brain/brain.js';
import { runCompanion } from '../src/bots/companion.js';
import type { CompanionHandle } from '../src/bots/companion.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotClient, BotClientOptions } from 'minicraft-bot';
import { brainHealthMessage, buildBrain, main, parseCommand, shutdown } from '../src/cli.js';
import type { CompanionTuning } from '../src/config.js';
import type { KidInfo, Vec3 } from '../src/types.js';
import { AIR, FakeBody, FakeWorld, id, player } from './fake-port.js';

/**
 * Task 4: the companion loop (spec §6, §12a, §12b), against the fake port, vitest's fake timers (the
 * clock is `Date.now`, which they drive) and fake brains.
 */

const T0 = 1_000_000;
/** The platform's top: feet level on it. Terrain in this area is below 161, so everything above the
 *  platform is generated AIR and `groundY` from up to 64 above finds the platform. */
const FLOOR = 200;

const TUNING: CompanionTuning = {
	tickMs: 500,
	editEveryMs: 2000,
	editBudget: 50,
	followDist: 2,
	minConfidence: 0.4,
	stopMs: 600_000,
	wanderTether: 12,
	statusEveryMs: 30_000,
	idleSwitchMs: 30_000,
	minTargetMs: 20_000,
};

const clock = () => Date.now();

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
});

afterEach(() => {
	vi.useRealTimers();
});

function platform(world: FakeWorld): void {
	world.fill({ x: 70, y: FLOOR - 1, z: 70 }, { x: 130, y: FLOOR - 1, z: 130 }, 'stone');
}

function memoryLog(): Logger & { decisions: DecisionEntry[]; events: { kind: string; data?: Record<string, unknown> }[] } {
	const decisions: DecisionEntry[] = [];
	const events: { kind: string; data?: Record<string, unknown> }[] = [];
	return {
		decisions,
		events,
		decision: (e) => decisions.push(e),
		event: (kind, data) => events.push({ kind, data }),
	};
}

interface Run {
	handle: CompanionHandle;
	log: ReturnType<typeof memoryLog>;
	status: string[];
}

function start(body: FakeBody, world: FakeWorld, opts: { brain?: Brain | null; noEdits?: boolean; tuning?: Partial<CompanionTuning>; brainTimeoutMs?: number } = {}): Run {
	const log = memoryLog();
	const status: string[] = [];
	const handle = runCompanion({
		body,
		world,
		brain: opts.brain ?? null,
		config: { companion: { ...TUNING, ...opts.tuning }, noEdits: opts.noEdits ?? false, brainTimeoutMs: opts.brainTimeoutMs ?? 400, name: 'Robo' },
		log,
		clock,
		rng: () => 0.5,
		seed: 7,
		status: (l) => status.push(l),
	});
	return { handle, log, status };
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function calls(body: FakeBody, fn: string) {
	return body.calls.filter((c) => c.fn === fn);
}

function answer(best: string, probs: Record<string, number>, confidence = 1): Answer {
	return { type: 'choice', best, probs, confidence };
}

/** A brain that answers with `decide(options)`; records every ask. */
function fakeBrain(decide: (q: Choice) => Answer | Promise<Answer>): Brain & { asks: { state: string; q: Choice; signal: AbortSignal }[] } {
	const asks: { state: string; q: Choice; signal: AbortSignal }[] = [];
	return {
		name: 'fake',
		asks,
		health: async () => true,
		ask: async (state, q, signal) => {
			asks.push({ state, q, signal });
			return decide(q);
		},
	};
}

function dist3(a: Vec3, b: Vec3): number {
	return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function hdist(a: { x: number; z: number }, b: { x: number; z: number }): number {
	return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * A body whose walks and flights really move it (one step per 100 ms at WALK_SPEED / FLY_SPEED), share
 * one movement slot, and are cancelled by `move` — as the SDK. Hops (a `move` that changes the
 * position) are recorded with the kids' poses at that moment.
 */
class SimBody extends FakeBody {
	private gen = 0;
	hops: { t: number; from: Vec3; to: Vec3; kids: Vec3[] }[] = [];

	constructor(private readonly sim: FakeWorld) {
		super();
		this.walkImpl = (t) => this.run({ x: t.x, y: NaN, z: t.z }, WALK_SPEED, true);
		this.flyImpl = (t) => this.run(t, FLY_SPEED, false);
	}

	override move(p: PoseInput): void {
		this.gen++;
		const from = this.pose();
		if (dist3(from, p) > 1e-6) this.hops.push({ t: Date.now(), from, to: { x: p.x, y: p.y, z: p.z }, kids: this.list.filter((k) => !k.bot).map((k) => ({ x: k.x, y: k.y, z: k.z })) });
		super.move(p);
	}

	private run(target: Vec3, speed: number, walking: boolean): Promise<WalkResult> {
		const my = ++this.gen;
		return new Promise((resolve) => {
			const step = () => {
				if (my !== this.gen) return resolve('cancelled');
				const c = this.current;
				const ty = walking ? c.y : target.y;
				const dx = target.x - c.x, dy = ty - c.y, dz = target.z - c.z;
				const d = Math.hypot(dx, dy, dz);
				const s = speed * 0.1;
				if (d <= s) {
					this.current = { ...c, x: target.x, y: ty, z: target.z };
					return resolve('arrived');
				}
				const nx = c.x + (dx / d) * s, nz = c.z + (dz / d) * s;
				const ny = walking ? (this.sim.groundY(Math.floor(nx), Math.floor(nz), c.y) ?? c.y) : c.y + (dy / d) * s;
				this.current = { ...c, x: nx, y: ny, z: nz };
				setTimeout(step, 100);
			};
			setTimeout(step, 100);
		});
	}
}

const blocked = () => Promise.reject(new BlockedError({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, 'wall'));

function kidAt(x: number, y: number, z: number, over: Partial<BotPlayer> = {}): BotPlayer {
	return player({ id: 1, name: 'Noah', x, y, z, ...over });
}

describe('the loop', () => {
	it('never overlaps ticks, even when the brain is slower than a tick', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new FakeBody();
		body.current = { x: 100.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.list = [kidAt(104.5, FLOOR, 100.5)];
		let active = 0, maxActive = 0;
		const brain = fakeBrain(async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((r) => setTimeout(r, 1200));
			active--;
			return answer('watch', { watch: 1 });
		});
		const run = start(body, world, { brain, brainTimeoutMs: 5000 });
		await advance(6000);
		const stopping = run.handle.stop();
		await advance(2000);
		await stopping;
		expect(brain.asks.length).toBeGreaterThanOrEqual(3);
		expect(maxActive).toBe(1);
		const ts = run.log.decisions.map((d) => d.t);
		for (let i = 1; i < ts.length; i++) expect(ts[i] - ts[i - 1]).toBeGreaterThanOrEqual(1200);
	});

	it('low confidence (max(p) < 0.40, never the brain\'s own field) → follow when offered, else watch', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new FakeBody();
		body.current = { x: 100.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.walkImpl = () => new Promise(() => undefined);
		// 4 away, in the near band (follow offered, not out of reach): the brain is asked. The answer
		// says watch with max(p) 0.35 and a bogus confidence field of 0.99.
		body.list = [kidAt(104.5, FLOOR, 100.5)];
		const brain = fakeBrain(() => answer('watch', { watch: 0.35, follow: 0.3, idle: 0.35 }, 0.99));
		const run = start(body, world, { brain });
		await advance(0);
		expect(run.log.decisions[0].action).toBe('follow');
		expect(run.log.decisions[0].reason).toBe('low-confidence');
		// Close and still: follow is not offered → watch.
		body.list = [kidAt(101.5, FLOOR, 100.5)];
		await advance(1000);
		const last = run.log.decisions[run.log.decisions.length - 1];
		expect(last.candidates).not.toContain('follow');
		expect(last.action).toBe('watch');
		expect(last.reason).toBe('low-confidence');
		await run.handle.stop();
	});

	it('confident answers are taken as the brain chose (max(p) ≥ 0.40, even with a low confidence field)', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new FakeBody();
		body.current = { x: 100.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.list = [kidAt(104.5, FLOOR, 100.5)];
		const brain = fakeBrain(() => answer('watch', { watch: 0.6, follow: 0.4 }, 0.1));
		const run = start(body, world, { brain });
		await advance(0);
		expect(run.log.decisions[0]).toMatchObject({ action: 'watch', reason: 'brain', brain: 'fake' });
		await run.handle.stop();
	});

	it('a brain timeout → the scripted decision (fallback:timeout); 5 in a row → scripted for the session', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new FakeBody();
		body.current = { x: 100.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.walkImpl = () => new Promise(() => undefined);
		body.list = [kidAt(104.5, FLOOR, 100.5)];
		const brain = fakeBrain(() => new Promise<Answer>(() => undefined));
		const run = start(body, world, { brain, brainTimeoutMs: 400 });
		await advance(400);
		expect(run.log.decisions[0]).toMatchObject({ reason: 'fallback:timeout', action: 'follow', brain: 'scripted' });
		expect(brain.asks[0].signal.aborted).toBe(true);
		await advance(10_000);
		expect(brain.asks.length).toBe(5);
		expect(run.handle.stats.scriptedSession).toBe(true);
		expect(run.log.decisions.slice(0, 5).every((d) => d.reason === 'fallback:timeout')).toBe(true);
		expect(run.log.decisions.slice(5).every((d) => d.reason === 'fallback:session')).toBe(true);
		const line = run.handle.statusLine();
		expect(line).toContain('SCRIPTED-FALLBACK');
		expect(line).toContain(`fallbacks ${run.handle.stats.fallbacks}`);
		// Ruling R-c: once scripted for the session, the fallback count stops at the 5 real failures.
		expect(run.log.decisions.length).toBeGreaterThan(8);
		expect(run.handle.stats.fallbacks).toBe(5);
		expect(line).toContain('fallbacks 5');
		await run.handle.stop();
	});

	it('only failures IN A ROW switch to scripted: 4 timeouts, 1 answer, 4 timeouts → still asking the brain', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new FakeBody();
		body.current = { x: 100.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.walkImpl = () => new Promise(() => undefined);
		body.list = [kidAt(104.5, FLOOR, 100.5)];
		let n = 0;
		const brain = fakeBrain(() => (++n === 5 ? answer('watch', { watch: 1 }) : new Promise<Answer>(() => undefined)));
		const run = start(body, world, { brain, brainTimeoutMs: 400 });
		// Ask k (from 0) starts at 500·k; the 9th (k = 8) times out at 4400, the 10th starts at 4500.
		await advance(4450);
		expect(brain.asks).toHaveLength(9);
		expect(run.log.decisions.map((d) => d.reason)).toEqual([...Array(4).fill('fallback:timeout'), 'brain', ...Array(4).fill('fallback:timeout')]);
		expect(run.handle.stats.scriptedSession).toBe(false);
		await run.handle.stop();
	});

	for (const [p, reason, action] of [
		[0.4, 'brain', 'watch'],
		[0.39, 'low-confidence', 'follow'],
	] as const) {
		it(`confidence boundary: max(p) = ${p} → ${reason}`, async () => {
			const world = new FakeWorld();
			platform(world);
			const body = new FakeBody();
			body.current = { x: 100.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
			body.walkImpl = () => new Promise(() => undefined);
			body.list = [kidAt(104.5, FLOOR, 100.5)];
			const brain = fakeBrain(() => answer('watch', { watch: p, follow: 0.3 }, 1));
			const run = start(body, world, { brain });
			await advance(0);
			expect(run.log.decisions[0]).toMatchObject({ reason, action });
			await run.handle.stop();
		});
	}

	it('the follow floor (Fix round 1): a brain that always says watch (0.9) still follows when the kid is out of reach', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new FakeBody();
		body.current = { x: 100.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.walkImpl = () => new Promise(() => undefined);
		const brain = fakeBrain(() => answer('watch', { watch: 0.9 }));
		// 6 away horizontally: beyond followDist (2) + FOLLOW_FLOOR_MARGIN (3) = 5.
		body.list = [kidAt(106.5, FLOOR, 100.5)];
		const run = start(body, world, { brain });
		await advance(0);
		expect(run.log.decisions[0]).toMatchObject({ action: 'follow', reason: 'rule:follow-floor', brain: 'rule' });
		expect(brain.asks).toHaveLength(0);

		// Close horizontally (1 away) but 2 above: beyond VERTICAL_FOLLOW (1.5).
		body.list = [kidAt(101.5, FLOOR + 2, 100.5)];
		await advance(500);
		const last = run.log.decisions[run.log.decisions.length - 1];
		expect(last).toMatchObject({ action: 'follow', reason: 'rule:follow-floor', brain: 'rule' });
		expect(brain.asks).toHaveLength(0);
		expect(run.handle.stats.fallbacks).toBe(0);
		await run.handle.stop();
	});

	it('the follow floor (Task 7 R3): a brain that always says watch (0.9) still follows a kid walking away at 3 b/s, 3 blocks off', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new FakeBody();
		body.current = { x: 100.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.walkImpl = () => new Promise(() => undefined);
		const brain = fakeBrain(() => answer('watch', { watch: 0.9 }));
		// Tick 0: 3 away and still (one pose sample: speed 0) — the near band, so the brain is asked.
		body.list = [kidAt(103.5, FLOOR, 100.5)];
		const run = start(body, world, { brain });
		await advance(0);
		expect(run.log.decisions[0]).toMatchObject({ action: 'watch', reason: 'brain' });
		expect(brain.asks).toHaveLength(1);
		// Tick 1: 1.5 further in 0.5 s (3 b/s) — 4.5 away, still inside followDist + 3 = 5, so only
		// the moving condition can fire the floor.
		body.list = [kidAt(105, FLOOR, 100.5)];
		await advance(500);
		expect(run.log.decisions[1]).toMatchObject({ action: 'follow', reason: 'rule:follow-floor', brain: 'rule' });
		expect(brain.asks).toHaveLength(1);
		await run.handle.stop();
	});

	it('the follow floor (Fix round 1): at 4 away and still (the near band), the brain\'s watch is used', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new FakeBody();
		body.current = { x: 100.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.walkImpl = () => new Promise(() => undefined);
		// 4 away: follow is offered (> followDist + 1 = 3) but not out of reach (≤ followDist + 3 = 5).
		body.list = [kidAt(104.5, FLOOR, 100.5)];
		const brain = fakeBrain(() => answer('watch', { watch: 0.9 }));
		const run = start(body, world, { brain });
		await advance(0);
		expect(run.log.decisions[0]).toMatchObject({ action: 'watch', reason: 'brain' });
		expect(brain.asks).toHaveLength(1);
		await run.handle.stop();
	});

	it('an answer outside the candidates is a fallback, not an action', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new FakeBody();
		body.current = { x: 100.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.list = [kidAt(101.5, FLOOR, 100.5)];
		const brain = fakeBrain(() => answer('help_build', { help_build: 1 }));
		const run = start(body, world, { brain });
		await advance(0);
		expect(run.log.decisions[0]).toMatchObject({ reason: 'fallback:invalid', action: 'watch' });
		expect(calls(body, 'place')).toHaveLength(0);
		await run.handle.stop();
	});

	it('no kid → wander/idle by script, without asking the brain', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new FakeBody();
		body.current = { x: 100.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		const brain = fakeBrain(() => answer('idle', { idle: 1 }));
		const run = start(body, world, { brain });
		await advance(3000);
		await run.handle.stop();
		expect(brain.asks).toHaveLength(0);
		expect(run.log.decisions.length).toBeGreaterThan(3);
		for (const d of run.log.decisions) {
			expect(['wander', 'idle']).toContain(d.action);
			expect(d.reason).toBe('scripted');
			expect(d.raw).toBeNull();
		}
		expect(run.log.decisions.some((d) => d.action === 'wander')).toBe(true);
	});

	it('stop() ends the loop and removes every subscription', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new FakeBody();
		body.current = { x: 100.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		const run = start(body, world);
		await advance(1000);
		await run.handle.stop();
		const n = run.log.decisions.length;
		await advance(5000);
		expect(run.log.decisions.length).toBe(n);
		// Both perception subscriptions and the stop signal's are gone: no one hears an edit any more.
		const edits = (body as unknown as { editCbs: Set<unknown> }).editCbs;
		const fxs = (body as unknown as { fxCbs: Set<unknown> }).fxCbs;
		expect(edits.size).toBe(0);
		expect(fxs.size).toBe(0);
	});
});

describe('follow: a standing intent', () => {
	it('re-issues walkTo on the very next tick after the kid moved > 0.5, with a walk that never resolves', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new FakeBody();
		body.current = { x: 100.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.walkImpl = () => new Promise(() => undefined);
		body.list = [kidAt(110.5, FLOOR, 100.5)];
		const run = start(body, world);
		await advance(0);
		expect(calls(body, 'walkTo')).toHaveLength(1);
		body.list = [kidAt(110.5, FLOOR, 102.5)];
		await advance(500);
		expect(calls(body, 'walkTo')).toHaveLength(2);
		await run.handle.stop();
	});

	it('leaving follow stops the walk with move(pose())', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new FakeBody();
		body.current = { x: 100.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.walkImpl = () => new Promise(() => undefined);
		body.list = [kidAt(110.5, FLOOR, 100.5)];
		const run = start(body, world);
		await advance(0);
		expect(run.log.decisions[0].action).toBe('follow');
		expect(calls(body, 'move')).toHaveLength(0);
		// He comes over and stands still: follow is no longer offered.
		body.list = [kidAt(101.5, FLOOR, 100.5)];
		await advance(1500);
		const firstWatch = run.log.decisions.findIndex((d) => d.action === 'watch');
		expect(firstWatch).toBeGreaterThan(0);
		const moves = calls(body, 'move');
		expect(moves).toHaveLength(1);
		expect(moves[0].args[0]).toEqual({ x: 100.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 });
		await run.handle.stop();
	});

	it('stairs: the kid on step 5, the bot at the base 2 away → follow is offered and flyTo within one tick', async () => {
		const world = new FakeWorld();
		platform(world);
		// A staircase along −z: step k (1..5) is k high, step 5 at (101, ·, 100).
		for (let k = 1; k <= 5; k++) world.fill({ x: 101, y: FLOOR, z: 105 - k }, { x: 101, y: FLOOR + k - 1, z: 105 - k }, 'stone');
		const body = new FakeBody();
		body.current = { x: 99.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.flyImpl = () => new Promise(() => undefined);
		body.list = [kidAt(101.5, FLOOR + 5, 100.5)];
		const run = start(body, world);
		await advance(0);
		expect(run.log.decisions[0].candidates).toContain('follow');
		expect(run.log.decisions[0].action).toBe('follow');
		expect(calls(body, 'flyTo')).toHaveLength(1);
		expect(calls(body, 'walkTo')).toHaveLength(0);
		await run.handle.stop();
	});

	for (const speed of [3, 5, 8]) {
		it(`lead clamp: a kid flying away at ${speed} b/s then stopping → the bot is never within 1 block`, async () => {
			const world = new FakeWorld();
			platform(world);
			const body = new SimBody(world);
			const Y = FLOOR + 20;
			body.current = { x: 97.5, y: Y, z: 100.5, yaw: 0, pitch: 0 };
			body.list = [kidAt(100.5, Y, 100.5)];
			const run = start(body, world);
			let minDist = Infinity;
			const sample = () => (minDist = Math.min(minDist, dist3(body.pose(), body.list[0])));
			// Hover 1 s, fly +x for 3 s (the bot, at FLY_SPEED, catches up), stop dead, then 5 s still.
			for (let i = 0; i < 10; i++) {
				await advance(100);
				sample();
			}
			for (let i = 0; i < 30; i++) {
				body.list = [{ ...body.list[0], x: body.list[0].x + speed * 0.1 }];
				await advance(100);
				sample();
			}
			for (let i = 0; i < 50; i++) {
				await advance(100);
				sample();
			}
			await run.handle.stop();
			expect(minDist).toBeGreaterThanOrEqual(1);
			// …and it did follow: it ends near him.
			expect(dist3(body.pose(), body.list[0])).toBeLessThanOrEqual(TUNING.followDist + 1.5);
			expect(calls(body, 'flyTo').length).toBeGreaterThan(1);
		});
	}
});

describe('follow: vertical and settled (ruling R-a)', () => {
	it('the kid 2 above, 1 away horizontally, standing still → a flyTo beside him within one tick (not "settled")', async () => {
		const world = new FakeWorld();
		platform(world);
		world.fill({ x: 101, y: FLOOR, z: 100 }, { x: 101, y: FLOOR + 1, z: 100 }, 'stone');
		const body = new FakeBody();
		body.current = { x: 100.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.flyImpl = () => new Promise(() => undefined);
		body.list = [kidAt(101.5, FLOOR + 2, 100.5)];
		const run = start(body, world);
		await advance(0);
		expect(run.log.decisions[0].action).toBe('follow');
		expect(run.log.decisions[0].result).not.toBe('settled');
		const flights = calls(body, 'flyTo');
		expect(flights).toHaveLength(1);
		expect(Math.abs((flights[0].args[0] as Vec3).y - (FLOOR + 2))).toBeLessThanOrEqual(0.5);
		await run.handle.stop();
	});

	it('settled (the bot got close while the brain thought) → no walk, and it looks at the kid', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new FakeBody();
		body.current = { x: 100.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.walkImpl = () => new Promise(() => undefined);
		const kid = kidAt(104.5, FLOOR, 100.5);
		body.list = [kid];
		// 4 away: near band (follow offered, not out of reach), so the brain is actually asked. Its
		// walk carried it to 2 from him during the ask.
		const brain = fakeBrain(() => {
			body.current = { ...body.current, x: 102.5 };
			return answer('follow', { follow: 1 });
		});
		const run = start(body, world, { brain });
		await advance(0);
		expect(run.log.decisions[0]).toMatchObject({ action: 'follow', result: 'settled' });
		expect(calls(body, 'walkTo')).toHaveLength(0);
		expect(calls(body, 'lookAt').map((c) => c.args)).toContainEqual([kid.x, kid.y + EYE_HEIGHT, kid.z]);
		await run.handle.stop();
	});

	it('the kid below the bot (on the ground 5 lower, 8 away) → it walks down, it does not fly', async () => {
		const world = new FakeWorld();
		platform(world);
		world.fill({ x: 101, y: FLOOR, z: 90 }, { x: 115, y: FLOOR + 4, z: 110 }, 'stone');
		const body = new FakeBody();
		body.current = { x: 104.5, y: FLOOR + 5, z: 100.5, yaw: 0, pitch: 0 };
		body.walkImpl = () => new Promise(() => undefined);
		body.flyImpl = () => new Promise(() => undefined);
		body.list = [kidAt(96.5, FLOOR, 100.5)];
		const run = start(body, world);
		await advance(0);
		expect(run.log.decisions[0].action).toBe('follow');
		expect(calls(body, 'walkTo')).toHaveLength(1);
		expect(calls(body, 'flyTo')).toHaveLength(0);
		await run.handle.stop();
	});

	it('watchPoint: the look target\'s centre when he is still, his eye when he moves', () => {
		const k = { pose: { x: 1, y: 64, z: 2, yaw: 0, pitch: 0 }, lookTarget: { x: 3, y: 4, z: 5 }, speedLast0_3s: 0 } as KidInfo;
		expect(watchPoint(k)).toEqual({ x: 3.5, y: 4.5, z: 5.5 });
		expect(watchPoint({ ...k, speedLast0_3s: 2 })).toEqual({ x: 1, y: 64 + EYE_HEIGHT, z: 2 });
		expect(watchPoint({ ...k, lookTarget: null })).toEqual({ x: 1, y: 64 + EYE_HEIGHT, z: 2 });
	});
});

describe('follow modes (§12b)', () => {
	it('walk → fly on BlockedError', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new FakeBody();
		body.current = { x: 100.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.walkImpl = blocked;
		body.flyImpl = () => new Promise(() => undefined);
		body.list = [kidAt(108.5, FLOOR, 100.5)];
		const run = start(body, world);
		await advance(0);
		expect(calls(body, 'walkTo')).toHaveLength(1);
		expect(calls(body, 'flyTo')).toHaveLength(0);
		await advance(500);
		expect(calls(body, 'flyTo')).toHaveLength(1);
		await run.handle.stop();
	});

	it('a flying kid → the bot flies alongside at his height, not under him', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new FakeBody();
		body.current = { x: 100.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.flyImpl = () => new Promise(() => undefined);
		const Y = FLOOR + 6;
		body.list = [kidAt(108.5, Y, 100.5)];
		const run = start(body, world);
		for (let i = 0; i < 4; i++) {
			body.list = [{ ...body.list[0], z: body.list[0].z + 1 }];
			await advance(500);
		}
		const flights = calls(body, 'flyTo');
		expect(flights.length).toBeGreaterThanOrEqual(3);
		const kid = body.list[0];
		const last = flights[flights.length - 1].args[0] as Vec3;
		expect(Math.abs(last.y - Y)).toBeLessThanOrEqual(0.5);
		expect(hdist(last, kid)).toBeGreaterThanOrEqual(1.5);
		expect(hdist(last, kid)).toBeLessThanOrEqual(TUNING.followDist + 1.5);
		expect(calls(body, 'walkTo')).toHaveLength(0);
		await run.handle.stop();
	});

	it('the kid lands → the bot lands (not hovering beside him) → then walks', async () => {
		const world = new FakeWorld();
		platform(world);
		// A 1-high pillar the kid lands on; the ground around it is 1 lower than his feet.
		world.set(112, FLOOR, 100, 'stone');
		const body = new SimBody(world);
		body.current = { x: 96.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		const Y = FLOOR + 8;
		body.list = [kidAt(100.5, Y, 100.5)];
		const run = start(body, world);
		// Flying along +x at 3 b/s for 4 s: the bot flies too, never walks.
		for (let i = 0; i < 40; i++) {
			body.list = [{ ...body.list[0], x: body.list[0].x + 0.3 }];
			await advance(100);
		}
		expect(calls(body, 'flyTo').length).toBeGreaterThan(0);
		expect(calls(body, 'walkTo')).toHaveLength(0);
		expect(body.pose().y).toBeGreaterThan(FLOOR + 5);
		// He lands on the pillar and stays 4 s: the bot comes down to the ground beside it.
		body.list = [{ ...body.list[0], x: 112.5, y: FLOOR + 1, z: 100.5 }];
		await advance(4000);
		expect(body.pose().y).toBe(FLOOR);
		const landedAt = body.calls.length;
		// He steps down and walks on along +x at 2 b/s: the bot walks.
		body.list = [{ ...body.list[0], x: 113.5, y: FLOOR }];
		for (let i = 0; i < 40; i++) {
			body.list = [{ ...body.list[0], x: body.list[0].x + 0.2 }];
			await advance(100);
		}
		await run.handle.stop();
		expect(body.calls.slice(landedAt).some((c) => c.fn === 'walkTo')).toBe(true);
		expect(body.pose().y).toBe(FLOOR);
	});

	it('a hovering kid 20 up → the bot flies up beside him at followDist, hovers, is not re-issued, 0 hops', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new SimBody(world);
		body.current = { x: 104.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		const kid = kidAt(100.5, FLOOR + 20, 100.5);
		body.list = [kid];
		const run = start(body, world);
		await advance(10_000);
		await run.handle.stop();
		const flights = calls(body, 'flyTo');
		expect(flights).toHaveLength(1);
		const t = flights[0].args[0] as Vec3;
		expect(Math.abs(t.y - kid.y)).toBeLessThanOrEqual(0.5);
		expect(Math.abs(hdist(t, kid) - TUNING.followDist)).toBeLessThanOrEqual(0.5);
		expect(body.hops).toHaveLength(0);
		expect(run.handle.stats.hops).toBe(0);
		expect(dist3(body.pose(), kid)).toBeLessThanOrEqual(TUNING.followDist + 0.5);
	});

	it('flyTo is re-issued every tick without awaiting (a flight that never resolves)', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new FakeBody();
		body.current = { x: 100.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.flyImpl = () => new Promise(() => undefined);
		body.list = [kidAt(110.5, FLOOR + 10, 100.5)];
		const run = start(body, world);
		await advance(0);
		for (let i = 1; i <= 4; i++) {
			body.list = [{ ...body.list[0], z: body.list[0].z + 1 }];
			await advance(500);
			expect(calls(body, 'flyTo')).toHaveLength(i + 1);
		}
		await run.handle.stop();
	});
});

describe('landing rules', () => {
	const wet = (world: FakeWorld, x: number, y: number, z: number) => world.isLiquid(world.getBlock(x, y, z)) || world.isLiquid(world.getBlock(x, y + 1, z));

	it('the kid landed beside water, the bot is over it → it never lands in liquid (flights succeed)', async () => {
		const world = new FakeWorld();
		platform(world);
		world.fill({ x: 93, y: FLOOR, z: 90 }, { x: 115, y: FLOOR + 1, z: 110 }, 'water');
		const body = new SimBody(world);
		body.current = { x: 94.5, y: FLOOR + 4, z: 100.5, yaw: 0, pitch: 0 };
		body.list = [kidAt(91.5, FLOOR, 100.5)];
		const run = start(body, world);
		for (let t = 0; t < 6000; t += 100) {
			await advance(100);
			const p = body.pose();
			expect(wet(world, p.x, Math.floor(p.y), p.z)).toBe(false);
		}
		await run.handle.stop();
		for (const f of calls(body, 'flyTo')) {
			const t = f.args[0] as Vec3;
			expect(wet(world, t.x, Math.floor(t.y), t.z)).toBe(false);
		}
	});

	it('the kid on a ledge, the bot over the drop → it never lands more than 1.5 below him (flights succeed)', async () => {
		const world = new FakeWorld();
		platform(world);
		world.fill({ x: 101, y: FLOOR, z: 90 }, { x: 115, y: FLOOR + 4, z: 110 }, 'stone');
		const body = new SimBody(world);
		const kidY = FLOOR + 5;
		body.current = { x: 99.5, y: kidY, z: 100.5, yaw: 0, pitch: 0 };
		body.list = [kidAt(102.5, kidY, 100.5)];
		const run = start(body, world);
		let minY = Infinity;
		for (let t = 0; t < 6000; t += 100) {
			await advance(100);
			minY = Math.min(minY, body.pose().y);
		}
		await run.handle.stop();
		expect(minY).toBeGreaterThanOrEqual(kidY - 1.5);
	});
});

describe('hops: the last resort', () => {
	/** A flying kid 20 away and 6 up, moving at 2 b/s; the bot on the platform. */
	function flyingAway(body: FakeBody): void {
		body.current = { x: 90.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.list = [kidAt(110.5, FLOOR + 6, 100.5)];
	}

	async function driveKid(body: FakeBody, ms: number): Promise<void> {
		for (let t = 0; t < ms; t += 100) {
			body.list = [{ ...body.list[0], z: body.list[0].z + 0.2 }];
			await advance(100);
		}
	}

	for (const [rejections, hops] of [
		[1, 0],
		[2, 1],
	] as const) {
		it(`${rejections} rejected flyTo → ${hops} hop${hops === 1 ? '' : 's'}`, async () => {
			const world = new FakeWorld();
			platform(world);
			const body = new SimBody(world);
			flyingAway(body);
			let n = 0;
			body.flyImpl = () => (n++ < rejections ? blocked() : new Promise(() => undefined));
			const run = start(body, world);
			await driveKid(body, 5000);
			await run.handle.stop();
			expect(body.hops).toHaveLength(hops);
			for (const h of body.hops) {
				expect(dist3(h.from, h.to)).toBeLessThanOrEqual(7.5);
				expect(kidBuffer(h.kids).has(columnKey(h.to.x, h.to.z))).toBe(false);
				expect(hdist(h.to, h.kids[0])).toBeLessThan(hdist(h.from, h.kids[0]));
			}
		});
	}

	it('at most 1 hop per second, even when eligible on ticks < 1 s apart; every hop ≤ 7.5 and outside the buffers', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new SimBody(world);
		flyingAway(body);
		body.flyImpl = blocked;
		const run = start(body, world, { tuning: { tickMs: 200 } });
		await driveKid(body, 6000);
		await run.handle.stop();
		expect(body.hops.length).toBeGreaterThanOrEqual(2);
		for (let i = 1; i < body.hops.length; i++) expect(body.hops[i].t - body.hops[i - 1].t).toBeGreaterThanOrEqual(1000);
		// Eligible ticks were refused by the rate limit: fewer hops than 2-blocked-flight cycles.
		expect(run.log.decisions.filter((d) => d.result.startsWith('hop')).length).toBe(body.hops.length);
		for (const h of body.hops) {
			expect(dist3(h.from, h.to)).toBeLessThanOrEqual(7.5);
			expect(kidBuffer(h.kids).has(columnKey(h.to.x, h.to.z))).toBe(false);
		}
	});

	it('a hovering kid 20 up circling at radius ≤ 1.5, ~2 b/s, every walk and flight blocked → 0 hops in 10 s', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new SimBody(world);
		const c = { x: 100.5, z: 100.5 };
		const r = 1.5;
		const omega = 2 / r;
		// The bot 1.45 from the circle's centre: always within followDist + 1 = 3 of the kid horizontally.
		body.current = { x: c.x + 1.45, y: FLOOR, z: c.z, yaw: 0, pitch: 0 };
		body.walkImpl = blocked;
		body.flyImpl = blocked;
		body.list = [kidAt(c.x + r, FLOOR + 20, c.z)];
		const run = start(body, world);
		let maxH = 0;
		for (let t = 0; t < 10_000; t += 100) {
			const a = (omega * t) / 1000;
			body.list = [{ ...body.list[0], x: c.x + r * Math.cos(a), z: c.z + r * Math.sin(a) }];
			maxH = Math.max(maxH, hdist(body.list[0], body.pose()));
			await advance(100);
		}
		await run.handle.stop();
		expect(body.hops).toHaveLength(0);
		// Only the horizontal-distance condition held the hop back: he stayed within followDist + 1,
		// he was flying at > 1 b/s, and flights were blocked.
		expect(maxH).toBeLessThanOrEqual(TUNING.followDist + 1);
		expect(run.log.decisions.some((d) => d.snapshot.target?.flying && d.snapshot.target.speedLast1s > 1)).toBe(true);
		expect(calls(body, 'flyTo').length).toBeGreaterThanOrEqual(2);
	});

	it('a hovering kid far away but slow (not > 1 b/s), flights blocked → 0 hops: the speed condition decides', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new SimBody(world);
		body.current = { x: 90.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.walkImpl = blocked;
		body.flyImpl = blocked;
		body.list = [kidAt(110.5, FLOOR + 6, 100.5)];
		const run = start(body, world);
		for (let t = 0; t < 6000; t += 100) {
			body.list = [{ ...body.list[0], z: body.list[0].z + 0.05 }];
			await advance(100);
		}
		await run.handle.stop();
		expect(run.log.decisions.some((d) => d.snapshot.target?.flying)).toBe(true);
		expect(calls(body, 'flyTo').length).toBeGreaterThanOrEqual(2);
		expect(body.hops).toHaveLength(0);
	});

	it('an unreachable grounded kid far away, walks blocked 3 times in a row (flights too) → a hop', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new SimBody(world);
		body.current = { x: 90.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.walkImpl = blocked;
		body.flyImpl = blocked;
		body.list = [kidAt(110.5, FLOOR, 100.5)];
		const run = start(body, world);
		await advance(4000);
		await run.handle.stop();
		expect(run.log.decisions.every((d) => !d.snapshot.target?.flying)).toBe(true);
		expect(body.hops.length).toBeGreaterThanOrEqual(1);
		const h = body.hops[0];
		expect(dist3(h.from, h.to)).toBeLessThanOrEqual(7.5);
		expect(hdist(h.to, h.kids[0])).toBeLessThan(hdist(h.from, h.kids[0]));
	});

	it('hopCell measures the CENTRED final pose in 3D: a raised ledge within 7.5 horizontally is refused', () => {
		const world = new FakeWorld();
		platform(world);
		// A plateau from x = 106 on, 5 high: its nearest cell centre is 6 away horizontally but
		// √(6² + 5²) ≈ 7.8 in 3D (its corner would be ≈ 7.45).
		world.fill({ x: 106, y: FLOOR, z: 90 }, { x: 115, y: FLOOR + 4, z: 110 }, 'stone');
		const bot = { x: 100.5, y: FLOOR, z: 100.5 };
		const kid = { x: 130.5, y: FLOOR + 5, z: 100.5 };
		const cell = hopCell(world, bot, kid, [kid]);
		expect(cell).toEqual({ x: 105.5, y: FLOOR, z: 100.5 });
	});

	it('a swimming kid: no walk, flight or hop ever ends in liquid', async () => {
		const world = new FakeWorld();
		platform(world);
		// A pool 2 deep, x 93..115, z 90..110; the kid swims in its middle.
		world.fill({ x: 93, y: FLOOR, z: 90 }, { x: 115, y: FLOOR + 1, z: 110 }, 'water');
		const body = new SimBody(world);
		body.current = { x: 88.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.walkImpl = blocked;
		body.flyImpl = blocked;
		body.list = [kidAt(105.5, FLOOR + 0.5, 100.5)];
		const run = start(body, world);
		for (let t = 0; t < 10_000; t += 100) {
			body.list = [{ ...body.list[0], z: 100.5 + Math.sin(t / 1000) }];
			await advance(100);
		}
		await run.handle.stop();
		const wet = (x: number, y: number, z: number) => world.isLiquid(world.getBlock(x, y, z)) || world.isLiquid(world.getBlock(x, y + 1, z));
		expect(calls(body, 'flyTo').length).toBeGreaterThan(0);
		for (const f of calls(body, 'flyTo')) {
			const t = f.args[0] as Vec3;
			expect(wet(t.x, Math.floor(t.y), t.z)).toBe(false);
		}
		for (const w of calls(body, 'walkTo')) {
			const t = w.args[0] as { x: number; z: number };
			const g = world.groundY(Math.floor(t.x), Math.floor(t.z), FLOOR);
			expect(g === null || !wet(t.x, g, t.z)).toBe(true);
		}
		for (const h of body.hops) expect(wet(h.to.x, h.to.y, h.to.z)).toBe(false);
	});

	it('hopCell never picks a liquid cell, even when it is nearest the kid', () => {
		const world = new FakeWorld();
		platform(world);
		world.fill({ x: 93, y: FLOOR, z: 90 }, { x: 115, y: FLOOR + 1, z: 110 }, 'water');
		const bot = { x: 88.5, y: FLOOR, z: 100.5 };
		const kid = { x: 105.5, y: FLOOR + 0.5, z: 100.5 };
		const cell = hopCell(world, bot, kid, [kid]);
		expect(cell).not.toBeNull();
		expect(world.isLiquid(world.getBlock(cell!.x, cell!.y, cell!.z))).toBe(false);
		expect(cell!.x).toBeLessThan(93);
		expect(dist3(cell!, bot)).toBeLessThanOrEqual(7.5);
	});
});

describe('help_build', () => {
	const BLOCK = 'oak_planks';
	/** A line along +x at z = 100 on the floor: A 104, B 105, C0 106 → N (107, FLOOR, 100). */
	const A = { x: 104, y: FLOOR, z: 100 };
	const B = { x: 105, y: FLOOR, z: 100 };
	const C0 = { x: 106, y: FLOOR, z: 100 };
	const N = { x: 107, y: FLOOR, z: 100 };

	/** The kid south of the line (−z), looking at B's centre from his eye. */
	function builder(): BotPlayer {
		const k = { x: 105.5, y: FLOOR, z: 97.5 };
		const dx = B.x + 0.5 - k.x, dy = B.y + 0.5 - (k.y + EYE_HEIGHT), dz = B.z + 0.5 - k.z;
		return kidAt(k.x, k.y, k.z, { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) });
	}

	function setup(opts: { brain: Brain; noEdits?: boolean; tuning?: Partial<CompanionTuning> }) {
		const world = new FakeWorld();
		platform(world);
		const body = new FakeBody();
		// 4.24 from the kid (builder(), at 105.5, 97.5): in the near band (Fix round 1's follow floor
		// is > followDist + 3 = 5 away), so the brain is actually asked, still within reach (6) of N.
		body.current = { x: 108.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.walkImpl = () => new Promise(() => undefined);
		const kid = builder();
		body.list = [kid];
		const run = start(body, world, { brain: opts.brain, noEdits: opts.noEdits, tuning: opts.tuning });
		return { world, body, kid, run };
	}

	async function placeLine(world: FakeWorld, body: FakeBody, kid: BotPlayer): Promise<void> {
		for (const cell of [A, B, C0]) {
			await advance(100);
			body.kidEdit(world, kid, cell, id(BLOCK));
		}
	}

	/** Picks help_build whenever it is offered, else watch. */
	const eager = (onHelp?: () => void) =>
		fakeBrain((q) => {
			if ('help_build' in q.options) {
				onHelp?.();
				return answer('help_build', { help_build: 1 });
			}
			return answer('watch', { watch: 1 });
		});

	it('places N with the line\'s block when N is still AIR; edits used shows on the status line', async () => {
		const brain = eager();
		const { world, body, kid, run } = setup({ brain });
		await placeLine(world, body, kid);
		await advance(3500);
		await run.handle.stop();
		const places = calls(body, 'place');
		expect(places).toHaveLength(1);
		expect(places[0].args).toEqual([N.x, N.y, N.z, BLOCK]);
		expect(run.handle.statusLine()).toContain('edits 1/50');
	});

	it('the help_build rule (Fix round 2): a brain that always says watch still places, once help_build is offered', async () => {
		const dumbBrain = fakeBrain(() => answer('watch', { watch: 0.9 }));
		const { world, body, kid, run } = setup({ brain: dumbBrain });
		await placeLine(world, body, kid);
		await advance(3500);
		await run.handle.stop();
		const places = calls(body, 'place');
		expect(places).toHaveLength(1);
		expect(places[0].args).toEqual([N.x, N.y, N.z, BLOCK]);
		const d = run.log.decisions.find((e) => e.action === 'help_build');
		expect(d).toMatchObject({ reason: 'rule:help-build', brain: 'rule' });
		// The brain is never asked once help_build is offered: no ask ever carries it as an option.
		expect(dumbBrain.asks.some((a) => 'help_build' in a.q.options)).toBe(false);
	});

	it('the follow floor (Fix round 1) still wins over the help_build rule when the kid is out of reach', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new FakeBody();
		// The bot stays at floor height; the kid (and his line) are 2 above — out of reach
		// vertically for follow (> VERTICAL_FOLLOW = 1.5) — even though N stays within the bot's
		// 6-block reach: the whole scene is the standard help_build layout translated up by 2.
		body.current = { x: 108.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.walkImpl = () => new Promise(() => undefined);
		const kY = FLOOR + 2;
		const highA = { x: 104, y: kY, z: 100 };
		const highB = { x: 105, y: kY, z: 100 };
		const highC0 = { x: 106, y: kY, z: 100 };
		const kPos = { x: 105.5, y: kY, z: 97.5 };
		const dx = highB.x + 0.5 - kPos.x, dy = highB.y + 0.5 - (kPos.y + EYE_HEIGHT), dz = highB.z + 0.5 - kPos.z;
		const kid = kidAt(kPos.x, kPos.y, kPos.z, { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) });
		body.list = [kid];
		const brain = fakeBrain(() => answer('watch', { watch: 0.9 }));
		const run = start(body, world, { brain });
		for (const cell of [highA, highB, highC0]) {
			await advance(100);
			body.kidEdit(world, kid, cell, id(BLOCK));
		}
		await advance(3500);
		await run.handle.stop();
		expect(calls(body, 'place')).toHaveLength(0);
		const withHelpBuildOffered = run.log.decisions.find((d) => d.candidates.includes('help_build'));
		expect(withHelpBuildOffered).toBeTruthy();
		expect(withHelpBuildOffered).toMatchObject({ action: 'follow', reason: 'rule:follow-floor', brain: 'rule' });
	});

	/** A second line, one higher: A2 104, B2 105, C2 106 at y FLOOR + 1 → N2 (107, FLOOR + 1, 100). */
	const A2 = { x: 104, y: FLOOR + 1, z: 100 };
	const B2 = { x: 105, y: FLOOR + 1, z: 100 };
	const C2 = { x: 106, y: FLOOR + 1, z: 100 };

	/** He turns to look at B2, then places A2, B2, C2 100 ms apart. */
	async function placeLine2(world: FakeWorld, body: FakeBody): Promise<void> {
		const k = body.list[0];
		const dx = B2.x + 0.5 - k.x, dy = B2.y + 0.5 - (k.y + EYE_HEIGHT), dz = B2.z + 0.5 - k.z;
		body.list = [{ ...k, yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) }];
		for (const cell of [A2, B2, C2]) {
			await advance(100);
			body.kidEdit(world, body.list[0], cell, id(BLOCK));
		}
	}

	it('the edit budget: two lines with editBudget 1 → exactly 1 place', async () => {
		const brain = eager();
		const { world, body, kid, run } = setup({ brain, tuning: { editBudget: 1, editEveryMs: 0 } });
		await placeLine(world, body, kid);
		await advance(2500);
		expect(calls(body, 'place')).toHaveLength(1);
		await placeLine2(world, body);
		await advance(4000);
		await run.handle.stop();
		expect(calls(body, 'place')).toHaveLength(1);
		expect(run.handle.statusLine()).toContain('edits 1/1');
	});

	it('the edit interval: a second line < editEveryMs after the first place is deferred until the interval has passed', async () => {
		const brain = eager();
		const { world, body, kid, run } = setup({ brain });
		const times: number[] = [];
		body.placeImpl = async () => {
			times.push(Date.now());
			return true;
		};
		await placeLine(world, body, kid);
		for (let i = 0; i < 40 && times.length === 0; i++) await advance(100);
		expect(times).toHaveLength(1);
		await placeLine2(world, body);
		await advance(4000);
		await run.handle.stop();
		expect(times).toHaveLength(2);
		expect(times[1] - times[0]).toBeGreaterThanOrEqual(TUNING.editEveryMs);
		expect(calls(body, 'place')[1].args).toEqual([107, FLOOR + 1, 100, BLOCK]);
	});

	it('(Fix round 2, adjusted) a stop already active before the line completes → help_build never offered, no place', async () => {
		// Previously this test broke a bot block INSIDE the brain's ask callback, exploiting the
		// async gap between the offer and the place. Ruling #1 (Fix round 2) removed that gap for
		// help_build entirely (it is taken by rule, never asked), so there is no longer a window to
		// race: the stop must already be active by the time perceive() runs, which means
		// editsAllowed() already refuses the offer — the guard fires earlier (never offered) rather
		// than later (offered, then recheck fails), but the outcome — no place, ever — is the same.
		const brain = eager();
		const { world, body, kid, run } = setup({ brain });
		const cell = { x: 120, y: FLOOR, z: 120 };
		world.set(cell.x, cell.y, cell.z, 'stone');
		body.entries = [{ ...cell, oldId: AIR, newId: id('stone'), t: Date.now() - 1000 }];
		body.kidEdit(world, kid, cell, AIR);
		await placeLine(world, body, kid);
		await advance(3500);
		await run.handle.stop();
		expect(calls(body, 'place')).toHaveLength(0);
		expect(run.log.decisions.some((d) => d.candidates.includes('help_build'))).toBe(false);
	});

	it('(Fix round 2, adjusted) the kid already stands in N\'s buffer → help_build never offered, no place', async () => {
		// Previously this test moved the kid INTO the buffer INSIDE the brain's ask callback, for the
		// same reason as above: that async gap no longer exists for help_build. The kid is placed in
		// N's buffer from the start instead (mirroring candidates.test.ts's pure "NOT offered when N
		// is in the target kid's buffer" case) — the offer never happens, so there is nothing to
		// place, end to end through the real companion loop.
		const world = new FakeWorld();
		platform(world);
		const body = new FakeBody();
		body.current = { x: 108.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.walkImpl = () => new Promise(() => undefined);
		const kPos = { x: 107.5, y: FLOOR, z: 100.5 };
		const dx = B.x + 0.5 - kPos.x, dy = B.y + 0.5 - (kPos.y + EYE_HEIGHT), dz = B.z + 0.5 - kPos.z;
		const kid = kidAt(kPos.x, kPos.y, kPos.z, { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) });
		body.list = [kid];
		const brain = eager();
		const run = start(body, world, { brain });
		await placeLine(world, body, kid);
		await advance(3500);
		await run.handle.stop();
		expect(calls(body, 'place')).toHaveLength(0);
		expect(run.log.decisions.some((d) => d.candidates.includes('help_build'))).toBe(false);
	});

	it('--no-edits → never place, and help_build is never offered', async () => {
		const brain = eager();
		const { world, body, kid, run } = setup({ brain, noEdits: true });
		await placeLine(world, body, kid);
		await advance(3500);
		await run.handle.stop();
		expect(calls(body, 'place')).toHaveLength(0);
		expect(brain.asks.some((a) => 'help_build' in a.q.options)).toBe(false);
		expect(brain.asks.length).toBeGreaterThan(3);
	});
});

describe('the log and the status line', () => {
	it('writes one JSONL line per tick with the schema keys, in order', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new FakeBody();
		body.current = { x: 100.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		body.list = [kidAt(104.5, FLOOR, 100.5)];
		const lines: string[] = [];
		const handle = runCompanion({
			body,
			world,
			brain: fakeBrain(() => answer('watch', { watch: 0.9 })),
			config: { companion: TUNING, noEdits: false, brainTimeoutMs: 400 },
			log: jsonlLogger((l) => lines.push(l), 42, clock),
			clock,
			rng: () => 0.5,
			seed: 42,
		});
		await advance(1600);
		await handle.stop();
		const decisions = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((o) => 'tick' in o);
		expect(decisions).toHaveLength(4);
		decisions.forEach((d, i) => {
			expect(Object.keys(d)).toEqual([...DECISION_KEYS]);
			expect(d).toMatchObject({ seed: 42, tick: i, brain: 'fake', action: 'watch', reason: 'brain' });
			expect(typeof d.text).toBe('string');
			expect((d.snapshot as { target: { name: string } }).target.name).toBe('Noah');
			expect(d.raw).toMatchObject({ best: 'watch' });
			expect(typeof d.latency).toBe('number');
		});
		for (const l of lines) expect(l.endsWith('\n') && l.indexOf('\n') === l.length - 1).toBe(true);
	});

	it('shows fallbacks, edits used / 50, and "paused near <kid> <min>m" while a stop is active', async () => {
		const world = new FakeWorld();
		platform(world);
		const body = new FakeBody();
		body.current = { x: 100.5, y: FLOOR, z: 100.5, yaw: 0, pitch: 0 };
		const kid = kidAt(110.5, FLOOR, 100.5);
		body.list = [kid];
		// The bot's block at (112, FLOOR, 100); Noah breaks it.
		world.set(112, FLOOR, 100, 'stone');
		body.entries = [{ x: 112, y: FLOOR, z: 100, oldId: AIR, newId: id('stone'), t: T0 - 1000 }];
		const run = start(body, world);
		await advance(0);
		expect(run.handle.statusLine()).not.toContain('paused near');
		body.kidEdit(world, kid, { x: 112, y: FLOOR, z: 100 }, AIR);
		await advance(500);
		const line = run.handle.statusLine();
		expect(line).toContain('paused near Noah 10m');
		expect(line).toContain('fallbacks 0');
		expect(line).toContain('edits 0/50');
		expect(run.log.events.some((e) => e.kind === 'stop' && e.data?.kid === 'Noah')).toBe(true);
		// The periodic status sink got the first line at once.
		expect(run.status.length).toBeGreaterThanOrEqual(1);
		await advance(10 * 60_000);
		expect(run.handle.statusLine()).not.toContain('paused near');
		await run.handle.stop();
	});
});

describe('cli helpers', () => {
	const BRAINS = {
		laya: { url: 'http://127.0.0.1:8000', health: '/health', home: '~/Projects/AI/laya', start: ['env', 'LAYA_PORT=8000', 'laya-serve'], timeoutMs: 400 },
		clm: { url: 'http://127.0.0.1:8701', health: '/health', home: '~/Projects/AI/clm', start: ['env', 'CLM_PORT=8701', 'clm-serve'], timeoutMs: 400, experimental: true },
	};

	it('buildBrain: scripted needs no brain; laya/clm build a SystemOneBrain named after the brain', () => {
		expect(buildBrain('scripted', BRAINS, fetch)).toBeNull();
		const laya = buildBrain('laya', BRAINS, fetch);
		expect(laya).not.toBeNull();
		expect(laya!.name).toBe('laya');
		const clm = buildBrain('clm', BRAINS, fetch);
		expect(clm!.name).toBe('clm');
	});

	it('brainHealthMessage: laya points at the launcher and BRAINS.md; clm names the GPU reason', () => {
		expect(brainHealthMessage('laya')).toContain('npm run brains -- laya');
		expect(brainHealthMessage('laya')).toContain('~/Projects/AI/BRAINS.md');
		expect(brainHealthMessage('clm')).toBe('clm is not running — its encoder does not fit this GPU; see ~/Projects/AI/BRAINS.md');
	});

	function fakeFetch(healthOk: boolean, urls: string[]): typeof fetch {
		return (async (url: string | URL) => {
			urls.push(url.toString());
			return new Response(JSON.stringify({ status: healthOk ? 'ok' : 'down' }), { status: healthOk ? 200 : 500 });
		}) as typeof fetch;
	}

	it('--brain laya builds a SystemOneBrain against bots.config.ts\'s configured URL, and health-checks it before ever touching the game server', async () => {
		const urls: string[] = [];
		let clientMade = 0;
		const makeClient = (_opts: BotClientOptions): BotClient => {
			clientMade++;
			return { listWorlds: async () => [] } as unknown as BotClient;
		};
		const printed: string[] = [];
		await main(['companion', '--target', 'local', '--brain', 'laya'], {
			makeClient,
			stateRoot: '/tmp/task6-unused-state-root',
			env: {},
			readFile: () => null,
			print: (l) => printed.push(l),
			fetchImpl: fakeFetch(true, urls),
		});
		// bots.config.ts's laya.url is http://127.0.0.1:8000 and health is /health.
		expect(urls).toContain('http://127.0.0.1:8000/health');
		expect(clientMade).toBe(1); // health passed, so it proceeded to list worlds
		expect(printed).toContain('no worlds on this target');
	});

	it('a down brain refuses to start, before ever calling makeClient, with a message naming how to start it', async () => {
		let clientMade = 0;
		const makeClient = (): BotClient => {
			clientMade++;
			throw new Error('must not connect when the brain is unhealthy');
		};
		await expect(
			main(['companion', '--target', 'local', '--brain', 'laya'], {
				makeClient,
				stateRoot: '/tmp/task6-unused-state-root',
				env: {},
				readFile: () => null,
				print: () => undefined,
				fetchImpl: fakeFetch(false, []),
			}),
		).rejects.toThrow(/npm run brains -- laya/);
		expect(clientMade).toBe(0);
	});

	it('clm: the health-failure message names the GPU reason, not the generic one', async () => {
		await expect(
			main(['companion', '--target', 'local', '--brain', 'clm'], {
				makeClient: (): BotClient => {
					throw new Error('must not connect');
				},
				stateRoot: '/tmp/task6-unused-state-root',
				env: {},
				readFile: () => null,
				print: () => undefined,
				fetchImpl: fakeFetch(false, []),
			}),
		).rejects.toThrow('clm is not running — its encoder does not fit this GPU; see ~/Projects/AI/BRAINS.md');
	});

	it('--brain scripted never touches fetch (no health check for the deterministic fallback)', async () => {
		let fetchCalled = false;
		const makeClient = (): BotClient => ({ listWorlds: async () => [] }) as unknown as BotClient;
		const printed: string[] = [];
		await main(['companion', '--target', 'local', '--brain', 'scripted'], {
			makeClient,
			stateRoot: '/tmp/task6-unused-state-root',
			env: {},
			readFile: () => null,
			print: (l) => printed.push(l),
			fetchImpl: (async () => {
				fetchCalled = true;
				return new Response('{}', { status: 200 });
			}) as typeof fetch,
		});
		expect(fetchCalled).toBe(false);
		expect(printed).toContain('no worlds on this target');
	});

	it('parses the command: companion (default) or revert', () => {
		expect(parseCommand(['revert', '--target', 'local'])).toEqual({ command: 'revert', flags: ['--target', 'local'] });
		expect(parseCommand(['companion', '--no-edits'])).toEqual({ command: 'companion', flags: ['--no-edits'] });
		expect(parseCommand(['--target', 'local'])).toEqual({ command: 'companion', flags: ['--target', 'local'] });
		expect(() => parseCommand(['dance'])).toThrow(/unknown bot/);
	});

	function fakeShutdown(opts: { revert?: () => Promise<number>; stop?: () => Promise<void> } = {}) {
		const order: string[] = [];
		const printed: string[] = [];
		const handle = {
			stop: async () => {
				order.push('stop');
				await opts.stop?.();
			},
		};
		const client = {
			revert: async () => {
				order.push('revert');
				return opts.revert ? opts.revert() : 3;
			},
			close: () => void order.push('close'),
		};
		return { order, printed, handle, client, print: (l: string) => void printed.push(l) };
	}

	it('shutdown: stop → revert → close with --revert-on-exit; stop → close without', async () => {
		const a = fakeShutdown();
		await shutdown({ ...a, revertOnExit: true });
		expect(a.order).toEqual(['stop', 'revert', 'close']);
		expect(a.printed).toContain('reverted 3 cells');
		const b = fakeShutdown();
		await shutdown({ ...b, revertOnExit: false });
		expect(b.order).toEqual(['stop', 'close']);
	});

	it('shutdown: close still runs when revert rejects (reported) or stop throws', async () => {
		const a = fakeShutdown({ revert: () => Promise.reject(new Error('socket gone')) });
		await shutdown({ ...a, revertOnExit: true });
		expect(a.order).toEqual(['stop', 'revert', 'close']);
		expect(a.printed.some((l) => l.includes('revert failed: socket gone'))).toBe(true);
		const b = fakeShutdown({ stop: () => Promise.reject(new Error('boom')) });
		await expect(shutdown({ ...b, revertOnExit: true })).rejects.toThrow('boom');
		expect(b.order).toEqual(['stop', 'close']);
	});

	it('the revert subcommand connects with the companion\'s statePath, reverts, prints the count and closes', async () => {
		vi.useRealTimers();
		const root = mkdtempSync(join(tmpdir(), 'bots-cli-'));
		try {
			const made: BotClientOptions[] = [];
			const order: string[] = [];
			const printed: string[] = [];
			const makeClient = (opts: BotClientOptions) => {
				made.push(opts);
				return {
					listWorlds: async () => [{ uuid: 'u-1', name: 'Home', mustMine: false, createdAt: 0, online: [] }],
					connect: async (o: { world: string; name: string }) => {
						order.push(`connect ${o.world} ${o.name}`);
						return {};
					},
					revert: async () => {
						order.push('revert');
						return 2;
					},
					close: () => void order.push('close'),
				} as unknown as BotClient;
			};
			await main(['revert', '--target', 'local', '--world', 'Home', '--name', 'Robo'], { makeClient, stateRoot: root, env: {}, readFile: () => null, print: (l) => void printed.push(l) });
			expect(made).toHaveLength(2);
			expect(made[1].statePath).toBe(`${root}/local/u-1/Robo.json`);
			expect(order).toEqual(['connect u-1 Robo', 'revert', 'close']);
			expect(printed).toContain('reverted 2 cells');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

