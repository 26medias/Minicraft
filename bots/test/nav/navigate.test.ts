import { describe, expect, it } from 'vitest';
import { BlockedError } from 'minicraft-bot';
import { airPathToSky, bodyFits, flyHigh, navigate, StuckWatchdog, walkOrFly } from '../../src/nav/navigate.js';
import { pickWanderSpot, standable, wanderer } from '../../src/nav/wander.js';
import { FakeBody, FakeWorld } from '../fake-port.js';
import type { Vec3 } from '../../src/types.js';

/**
 * A physical body over a FakeWorld. A walk fails at a step up > 1 (or no ground), where it stands. A flight follows
 * the SDK's rules in 1-block ticks (bot-client stepFly): straight toward the target when the body fits, else across at
 * the same height, else straight up — at most 16 above where the flight started — else blocked where it is. Scenes are
 * built high in the sky (y ≥ 200), above the generated terrain, so every one is exactly what the test fills.
 */
function physBody(world: FakeWorld, at: Vec3): FakeBody {
	const body = new FakeBody();
	body.world = world;
	body.current = { ...at, yaw: 0, pitch: 0 };
	const fits = (x: number, y: number, z: number) => !world.isSolid(world.getBlock(x, y, z)) && !world.isSolid(world.getBlock(x, y + 1, z));
	const blocked = (kind: 'walkTo' | 'flyTo') => new BlockedError({ ...body.current }, 'wall', kind);
	body.walkImpl = async (t) => {
		const p = body.pose();
		const n = Math.max(1, Math.ceil(Math.hypot(t.x - p.x, t.z - p.z) * 4));
		for (let i = 1; i <= n; i++) {
			const x = p.x + ((t.x - p.x) * i) / n, z = p.z + ((t.z - p.z) * i) / n;
			const g = world.groundY(x, z, body.current.y);
			if (g === null || g > body.current.y + 1) throw blocked('walkTo');
			body.current = { ...body.current, x, y: g, z };
		}
		return 'arrived';
	};
	body.flyImpl = async (t) => {
		const startY = body.current.y;
		for (let tick = 0; tick < 2000; tick++) {
			const c = body.current;
			const dx = t.x - c.x, dy = t.y - c.y, dz = t.z - c.z;
			const d = Math.hypot(dx, dy, dz), h = Math.hypot(dx, dz);
			if (d < 1e-9) return 'arrived';
			const s = Math.min(d, 1);
			const n = { x: c.x + (dx / d) * s, y: c.y + (dy / d) * s, z: c.z + (dz / d) * s };
			if (fits(n.x, n.y, n.z)) {
				body.current = { ...c, ...n };
				continue;
			}
			const hs = Math.min(h, 1);
			if (h > 1e-9 && fits(c.x + (dx / h) * hs, c.y, c.z + (dz / h) * hs)) {
				body.current = { ...c, x: c.x + (dx / h) * hs, z: c.z + (dz / h) * hs };
				continue;
			}
			if (h <= 1e-9 || c.y + 1 > startY + 16 || !fits(c.x, c.y + 1, c.z)) throw blocked('flyTo');
			body.current = { ...c, y: c.y + 1 };
		}
		throw blocked('flyTo');
	};
	return body;
}

const Y = 200;
/** A stone floor at y = Y − 1 over x, z ∈ [280, 360]. */
function floorWorld(): FakeWorld {
	const w = new FakeWorld();
	w.fill({ x: 280, y: Y - 1, z: 280 }, { x: 360, y: Y - 1, z: 360 }, 'stone');
	return w;
}

describe('navigator', () => {
	it('a cliff 25 high between start and target: flies high (lift past the 16 climb) and arrives on top', async () => {
		const world = floorWorld();
		world.fill({ x: 320, y: Y, z: 280 }, { x: 360, y: Y + 24, z: 360 }, 'stone'); // plateau top at Y + 24
		const body = physBody(world, { x: 300.5, y: Y, z: 300.5 });
		const logs: Array<Record<string, unknown>> = [];
		const r = await navigate(body, world, { x: 335.5, z: 300.5 }, { log: (e) => logs.push(e) });
		expect(r).toEqual({ ok: true, via: 'walk' });
		expect(body.pose()).toMatchObject({ x: 335.5, y: Y + 25, z: 300.5 });
		const flights = body.calls.filter((c) => c.fn === 'flyTo').map((c) => c.args[0] as Vec3);
		// the walk stops at the cliff's foot; straight up from there first (the route is 25 above: past flyTo's
		// climb), then across onto the plateau
		expect(flights[0]).toEqual({ x: 319.75, y: Y + 25, z: 300.5 });
		expect(flights).toHaveLength(2);
		expect(logs.some((e) => e.k === 'walk-fly' && e.lift === Y + 25)).toBe(true);
	});

	it('a target under an overhang: lands on a standable open-sky cell beside it, not on the roof', async () => {
		const world = floorWorld();
		// A wall 3 high between: no walk across; the column-top flight alone would land on the roof.
		world.fill({ x: 315, y: Y, z: 280 }, { x: 315, y: Y + 2, z: 360 }, 'stone');
		world.fill({ x: 329, y: Y + 4, z: 299 }, { x: 331, y: Y + 4, z: 301 }, 'stone'); // a 3 × 3 roof over the target
		const body = physBody(world, { x: 300.5, y: Y, z: 300.5 });
		const r = await navigate(body, world, { x: 330.5, y: Y, z: 300.5 });
		expect(r.ok).toBe(true);
		const p = body.pose();
		expect(p.y).toBe(Y); // on the floor, not on the roof (Y + 5)
		expect(Math.hypot(p.x - 330.5, p.z - 300.5)).toBeLessThanOrEqual(3);
		expect(Math.floor(p.x) >= 329 && Math.floor(p.x) <= 331 && Math.floor(p.z) >= 299 && Math.floor(p.z) <= 301).toBe(false);
	});

	it('start in a tunnel (dead end toward the target): along the tunnel to open sky, up, across, down', async () => {
		const world = floorWorld();
		// A rock mass 8 high over x 295–315, with a tunnel along z = 300 from x 300 to its west mouth at x 295.
		world.fill({ x: 295, y: Y, z: 290 }, { x: 315, y: Y + 7, z: 310 }, 'stone');
		world.fill({ x: 295, y: Y, z: 300 }, { x: 300, y: Y + 1, z: 300 }, 0);
		const body = physBody(world, { x: 300.5, y: Y, z: 300.5 });
		const r = await navigate(body, world, { x: 330.5, z: 300.5 });
		expect(r).toEqual({ ok: true, via: 'fly-high' });
		expect(body.pose()).toMatchObject({ x: 330.5, y: Y, z: 300.5 });
		expect(airPathToSky(world, { x: 300.5, y: Y, z: 300.5 })?.at(-1)).toMatchObject({ x: 294.5, y: Y });
	});

	it('walkOrFly with mayFly false: a blocked walk stays a failure, no flight', async () => {
		const world = floorWorld();
		world.fill({ x: 310, y: Y, z: 280 }, { x: 310, y: Y + 3, z: 360 }, 'stone');
		const body = physBody(world, { x: 300.5, y: Y, z: 300.5 });
		await expect(walkOrFly(body, world, { x: 330.5, z: 300.5 }, { mayFly: false })).rejects.toThrow();
		expect(body.calls.some((c) => c.fn === 'flyTo')).toBe(false);
	});

	it('flyHigh: a dry air pocket under an ice sheet wider than the search radius teleports up onto the ice', async () => {
		const world = floorWorld();
		// The kid mined out the water here, but never touched the ice above: a dry, enclosed pocket (feet and head
		// both clear) under an unbroken ice ceiling that reaches well past SUBMERGED_SKY_SEARCH in every direction —
		// SKY_SEARCH (6) finds nothing, and neither does the widened search.
		world.fill({ x: 290, y: Y + 3, z: 290 }, { x: 329, y: Y + 3, z: 329 }, 'ice');
		const body = physBody(world, { x: 309.5, y: Y, z: 309.5 }); // dead centre, well past 16 from any edge
		const logs: Array<Record<string, unknown>> = [];
		const r = await flyHigh(body, world, { x: 340.5, z: 340.5 }, { log: (e) => logs.push(e) });
		expect(r).toBe('arrived');
		expect(body.pose()).toMatchObject({ x: 309.5, y: Y + 4, z: 309.5 }); // straight up onto the ice, not toward the target
		expect(body.calls.some((c) => c.fn === 'flyTo')).toBe(false); // no flight leg — the teleport alone
		expect(logs.some((e) => e.k === 'unstick' && e.level === 3 && e.how === 'teleport-up' && e.reason === 'no-open-sky')).toBe(true);
	});
});

describe('stuck watchdog', () => {
	it('a body that never moves: fly-high, then the air path, then a teleport up, then abandon — 15 s apart', async () => {
		const world = floorWorld();
		// Sealed in a stone box: nothing gets out except the teleport.
		world.fill({ x: 298, y: Y, z: 298 }, { x: 302, y: Y + 6, z: 302 }, 'stone');
		world.set(300, Y, 300, 0);
		world.set(300, Y + 1, 300, 0);
		const body = new FakeBody();
		body.current = { x: 300.5, y: Y, z: 300.5, yaw: 0, pitch: 0 };
		body.walkImpl = async () => {
			throw new BlockedError({ ...body.current }, 'wall', 'walkTo');
		};
		body.flyImpl = async () => {
			throw new BlockedError({ ...body.current }, 'wall', 'flyTo');
		};
		let t = 0;
		const logs: Array<Record<string, unknown>> = [];
		const wd = new StuckWatchdog({ body, world, clock: () => t, log: (e) => logs.push(e) });
		const levels = () => logs.filter((e) => e.k === 'unstick' && !e.abandon).map((e) => e.level);
		wd.want({ x: 330.5, z: 300.5 });
		expect(await wd.guard()).toBe('ok');
		t = 14_999;
		expect(await wd.guard()).toBe('ok');
		expect(levels()).toEqual([]);
		t = 15_000;
		expect(await wd.guard()).toBe('ok');
		expect(levels()).toEqual([1]);
		t = 20_000;
		expect(await wd.guard()).toBe('ok');
		expect(levels()).toEqual([1]); // not yet: 15 s from the last escalation
		t = 30_000;
		expect(await wd.guard()).toBe('ok');
		expect(levels()).toEqual([1, 2]);
		expect(body.calls.some((c) => c.fn === 'move')).toBe(false);
		t = 45_000;
		expect(await wd.guard()).toBe('abandon');
		expect(levels()).toEqual([1, 2, 3]);
		const moves = body.calls.filter((c) => c.fn === 'move');
		expect(moves).toHaveLength(1);
		expect(moves[0].args[0]).toMatchObject({ x: 300.5, y: Y + 6 + 2, z: 300.5 });
		expect(wd.active).toBe(false);
	});

	it('a bot that keeps moving, or that reaches its goal, never escalates', async () => {
		const world = floorWorld();
		const body = new FakeBody();
		body.current = { x: 300.5, y: Y, z: 300.5, yaw: 0, pitch: 0 };
		let t = 0;
		const logs: Array<Record<string, unknown>> = [];
		const wd = new StuckWatchdog({ body, world, clock: () => t, log: (e) => logs.push(e) });
		wd.want({ x: 330.5, z: 300.5 });
		for (let i = 1; i <= 10; i++) {
			t = i * 10_000;
			body.current = { ...body.current, x: body.current.x + 1 };
			await wd.guard();
		}
		wd.reached();
		t += 60_000;
		await wd.guard();
		expect(logs).toEqual([]);
	});

	// Review mutant. Red if a goal after a long idle inherits the old window: the first guard would escalate at once.
	it('after 15 s with no goal, a new goal starts a fresh window', async () => {
		const world = floorWorld();
		const body = new FakeBody();
		body.current = { x: 300.5, y: Y, z: 300.5, yaw: 0, pitch: 0 };
		let t = 0;
		const logs: Array<Record<string, unknown>> = [];
		const wd = new StuckWatchdog({ body, world, clock: () => t, log: (e) => logs.push(e) });
		wd.want({ x: 330.5, z: 300.5 });
		wd.reached();
		t = 60_000;
		wd.want({ x: 330.5, z: 300.5 });
		expect(await wd.guard()).toBe('ok');
		t = 74_999;
		expect(await wd.guard()).toBe('ok');
		expect(logs).toEqual([]);
	});
});

describe('idle wander (nav/wander.ts)', () => {
	const seq = (seed: number) => {
		let s = seed >>> 0;
		return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
	};

	it('by a cliff: every destination is a standable open-sky cell within 12, reached through the navigator (no walk into the cliff face)', async () => {
		const world = floorWorld();
		world.fill({ x: 320, y: Y, z: 280 }, { x: 360, y: Y + 24, z: 360 }, 'stone'); // cliff face at x = 320
		const body = physBody(world, { x: 316.5, y: Y, z: 300.5 });
		const logs: Array<Record<string, unknown>> = [];
		const w = wanderer(body, world, { rng: seq(7), clock: () => Date.now(), log: (e) => logs.push(e) });
		const rng = seq(11);
		for (let i = 0; i < 8; i++) {
			const spot = pickWanderSpot(world, { x: 316.5, z: 300.5 }, rng);
			expect(spot).not.toBeNull();
			const s = spot!;
			expect(Math.hypot(s.x - 316.5, s.z - 300.5)).toBeLessThanOrEqual(13);
			expect(bodyFits(world, Math.floor(s.x), s.y, Math.floor(s.z))).toBe(true);
			expect(world.isSolid(world.getBlock(Math.floor(s.x), s.y - 1, Math.floor(s.z)))).toBe(true);
			expect(await w.go(s, () => true)).toBe(true);
			expect(body.pose()).toMatchObject({ x: s.x, y: s.y, z: s.z });
		}
		// every walk aimed at a picked standable column: none into the cliff's inside
		for (const c of body.calls.filter((c) => c.fn === 'walkTo')) {
			const t = c.args[0] as { x: number; z: number };
			const fx = Math.floor(t.x), fz = Math.floor(t.z);
			const top = fx >= 320 ? Y + 25 : Y;
			expect(bodyFits(world, fx, top, fz)).toBe(true);
		}
		expect(w.fails).toBe(0);
	});

	it('after two navigator failures it stands still and looks around instead of retrying against the wall', async () => {
		const world = floorWorld();
		const body = physBody(world, { x: 300.5, y: Y, z: 300.5 });
		const blocked = () => Promise.reject(new BlockedError({ ...body.current }, 'wall', 'walkTo'));
		body.walkImpl = blocked;
		body.flyImpl = blocked;
		const w = wanderer(body, world, { rng: seq(3), clock: () => Date.now(), log: () => undefined });
		const spot = { x: 305.5, y: Y, z: 300.5 };
		expect(await w.go(spot, () => true)).toBe(false);
		expect(await w.go(spot, () => true)).toBe(false);
		expect(w.fails).toBe(2);
		const moves = body.calls.filter((c) => c.fn === 'walkTo' || c.fn === 'flyTo').length;
		for (let i = 0; i < 5; i++) expect(await w.go(spot, () => true)).toBe(false);
		expect(body.calls.filter((c) => c.fn === 'walkTo' || c.fn === 'flyTo').length).toBe(moves);
		expect(body.calls.filter((c) => c.fn === 'lookAt').length).toBeGreaterThanOrEqual(5);
	});

	it('a lake under ice: no spot in an ice-free hole (real water up to the surface), the ice itself still stands', () => {
		const world = floorWorld();
		// A pond over x, z ∈ [300, 309], lakebed at Y − 1 (the floor), water Y..Y + 2, ice capping it at Y + 3 —
		// except a 3 × 3 hole with no ice, open straight to the sky above the water.
		world.fill({ x: 300, y: Y, z: 300 }, { x: 309, y: Y + 2, z: 309 }, 'water');
		world.fill({ x: 300, y: Y + 3, z: 300 }, { x: 309, y: Y + 3, z: 309 }, 'ice');
		world.fill({ x: 304, y: Y + 3, z: 304 }, { x: 306, y: Y + 3, z: 306 }, 0);
		for (let x = 304; x <= 306; x++)
			for (let z = 304; z <= 306; z++) expect(standable(world, x + 0.5, z + 0.5)).toBeNull();
		// standing on the ice itself is fine (only under it, in the water, is not)
		expect(standable(world, 300.5, 300.5)).toEqual({ x: 300.5, y: Y + 4, z: 300.5 });
	});

	it('a bot starting underwater (a hole in the ice) gets out via the nearest dry open-sky cell, not the far picked spot', async () => {
		const world = floorWorld();
		// The same pond, no ice this time: every cell in it is liquid, so none of it is ever a valid destination.
		world.fill({ x: 300, y: Y, z: 300 }, { x: 309, y: Y + 2, z: 309 }, 'water');
		const body = physBody(world, { x: 304.5, y: Y, z: 304.5 }); // feet and head both start submerged
		const w = wanderer(body, world, { rng: seq(5), clock: () => Date.now(), log: () => undefined });
		const farSpot = { x: 340.5, y: Y, z: 340.5 }; // a valid dry spot, but far — the nearby escape should win
		expect(await w.go(farSpot, () => true)).toBe(true);
		const p = body.pose();
		const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
		expect(world.isLiquid(world.getBlock(fx, fy, fz))).toBe(false);
		expect(world.isLiquid(world.getBlock(fx, fy + 1, fz))).toBe(false);
		expect(Math.hypot(p.x - 304.5, p.z - 304.5)).toBeLessThanOrEqual(17); // the nearby escape, not (340.5, 340.5)
	});

	it('under a 40 × 40 ice sheet over water: no dry cell within the escape search, so it teleports up onto the ice', async () => {
		const world = floorWorld();
		// A pond far wider than ESCAPE_SEARCH, capped edge to edge — no hole, no shore within reach.
		world.fill({ x: 290, y: Y, z: 290 }, { x: 329, y: Y + 2, z: 329 }, 'water');
		world.fill({ x: 290, y: Y + 3, z: 290 }, { x: 329, y: Y + 3, z: 329 }, 'ice');
		const body = physBody(world, { x: 309.5, y: Y + 1, z: 309.5 }); // dead centre, well past 16 from any edge
		const logs: Array<Record<string, unknown>> = [];
		const w = wanderer(body, world, { rng: seq(9), clock: () => Date.now(), log: (e) => logs.push(e) });
		const farSpot = { x: 340.5, y: Y, z: 340.5 };
		expect(await w.go(farSpot, () => true)).toBe(true);
		const p = body.pose();
		expect(p).toMatchObject({ x: 309.5, y: Y + 4, z: 309.5 }); // standing on top of the ice
		expect(body.calls.some((c) => c.fn === 'move')).toBe(true);
		expect(body.calls.some((c) => c.fn === 'walkTo' || c.fn === 'flyTo')).toBe(false); // no swim toward the far spot
		expect(logs.some((e) => e.k === 'unstick' && e.level === 3 && e.how === 'teleport-up' && e.reason === 'submerged')).toBe(true);
		expect(w.fails).toBe(0);
	});
});
