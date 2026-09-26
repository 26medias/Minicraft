import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { worldSpawn } from 'minicraft-bot';
import { seededRng } from '../../src/bots/companion.js';
import { runBrain2, type Brain2Deps, type Brain2Handle } from '../../src/brain2/brain.js';
import { ManualClock } from '../../src/brain2/clock.js';
import { PIP } from '../../src/brain2/data/personalities.data.js';
import { parseLog, type LogLine } from '../../src/brain2/log.js';
import { Ownership } from '../../src/brain2/ownership.js';
import { bandOf } from '../../src/brain2/emotions.js';
import type { Relation } from '../../src/brain2/types.js';
import { paramsBuild } from '../../src/brain2/params.js';
import { FAKE_GEN, FAKE_SEED, FakeBody, FakeWorld, id, player } from '../fake-port.js';
import { KidScript } from './kid-script.js';

const WALL0 = 1_790_000_000_000;
const SPAWN = worldSpawn(FAKE_SEED, FAKE_GEN);
const MIN = 60_000;
type Select = Extract<LogLine, { k: 'select' }>;

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface RigOpts { at?: { x: number; z: number }; dir?: string; clock?: ManualClock; world?: FakeWorld; over?: Partial<Brain2Deps> }
function rig(o: RigOpts = {}) {
	const clock = o.clock ?? new ManualClock(0);
	const world = o.world ?? new FakeWorld();
	const body = new FakeBody();
	body.world = world;
	const at = o.at ?? { x: SPAWN.x + 0.5, z: SPAWN.z + 0.5 };
	body.current = { x: at.x, y: world.surfaceY(Math.floor(at.x), Math.floor(at.z)) + 1, z: at.z, yaw: 0, pitch: 0 };
	// The SDK journals the bot's own edits (the stop signal reads it).
	const journal = (x: number, y: number, z: number, oldId: number, newId: number) => body.entries.push({ x, y, z, oldId, newId, t: WALL0 + clock.t });
	const place0 = body.placeImpl, mine0 = body.mineImpl, break0 = body.breakImpl;
	body.placeImpl = async (x, y, z, n) => {
		const ok = await place0(x, y, z, n);
		if (ok) journal(x, y, z, world.getBlock(x, y, z), id(n));
		return ok;
	};
	body.mineImpl = async (x, y, z) => {
		const old = world.getBlock(x, y, z);
		const ok = await mine0(x, y, z);
		if (ok) journal(x, y, z, old, 0);
		return ok;
	};
	body.breakImpl = async (x, y, z) => {
		const old = world.getBlock(x, y, z);
		const ok = await break0(x, y, z);
		if (ok) journal(x, y, z, old, 0);
		return ok;
	};
	const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'brain2-'));
	if (!o.dir) dirs.push(dir);
	const lines: string[] = [];
	const deps: Brain2Deps = {
		port: { body, world }, clock: clock.now, wall: () => WALL0 + clock.t, rng: seededRng(7), seed: 7, personality: PIP,
		statePaths: { brainFile: join(dir, 'brain.json'), logDir: join(dir, 'logs') },
		meta: { worldUuid: 'w-test', bot: 'Pip', target: 'test', live: false }, world: { seed: FAKE_SEED, gen: FAKE_GEN },
		engines: () => ({ laya: null, llm: null }), noEdits: false, logWrite: (l) => lines.push(l), manual: true, ...o.over,
	};
	const h: Brain2Handle = runBrain2(deps);
	const log = () => parseLog(lines.join('\n'));
	const selects = () => log().filter((l): l is Select => l.k === 'select');
	/** Runs `ms` of 100 ms beats; `each` runs before every beat. */
	const run = async (ms: number, each?: () => void) => {
		for (let t = 0; t < ms; t += 100) {
			clock.advance(100);
			each?.();
			await h.step();
			await new Promise((r) => setImmediate(r));   // the un-awaited runner tick settles
		}
	};
	return { clock, world, body, h, lines, log, selects, run, dir, deps };
}

function coolRelation(): Relation {
	const a = (value: number) => ({ value, band: bandOf(value), deltas: [] });
	return { axes: { affection: a(-0.9), cooperation: a(-0.5), respect: a(0), grievance: a(-0.5) }, metSessions: 3, minutesTogether: 0, lastSeenT: 0 };
}

/** The behaviours that started, from the select lines (a winner differing from the current one). */
const started = (ss: Select[]) => ss.filter((s) => s.winner !== null && s.winner !== s.inputs.current);

describe('runBrain2, code only (spec §10 step 2)', () => {
	let lone: ReturnType<typeof rig>;
	const rejections: unknown[] = [];
	const onRejection = (r: unknown) => rejections.push(r);
	beforeAll(async () => {
		process.on('unhandledRejection', onRejection);
		lone = rig();
		await lone.run(20 * MIN);
		await lone.h.stop();
	}, 300_000);
	afterEach(() => undefined);
	afterAll(() => {
		process.off('unhandledRejection', onRejection);
	});

	// Criterion 1, code path. Red if the selection or runner isn't wired (nothing starts), or if the 20 s minimum
	// isn't honoured by the wired triggers (a non-outcome, non-urgent switch sooner than 20 s after the last).
	it('a lone bot on a fresh world keeps doing things', () => {
		const ss = lone.selects();
		const kinds = new Set(started(ss).map((s) => s.winner));
		expect(kinds.size, `behaviours: ${[...kinds].join(', ')}`).toBeGreaterThanOrEqual(3);
		let last = -Infinity;
		for (const s of started(ss)) {
			const ok = s.t - last >= 20_000 || s.trigger.startsWith('outcome') || s.trigger === 'start' || s.urgent || s.inputs.current === null;
			expect(ok, `select #${s.selectionId} at ${s.t} (${s.trigger}) came ${s.t - last} ms after the previous switch`).toBe(true);
			last = s.t;
		}
	});

	// Criterion 5, code path. Red if a rejection escapes the un-awaited runner tick, or if behaviours stop changing.
	it('criterion 5 (code path): runs with engines { laya: null, llm: null }', () => {
		const st = started(lone.selects());
		expect(st.length).toBeGreaterThanOrEqual(5);
		expect(st.at(-1)!.t).toBeGreaterThan(15 * MIN);                   // still changing in the last 5 minutes
		expect(rejections).toEqual([]);
		const errors = lone.log().filter((l) => l.k === 'event' && /error/.test(l.kind));
		expect(errors, JSON.stringify(errors.slice(0, 3))).toEqual([]);
	});

	// Criterion 4, session level. Red if the runner (safety, site search, Mine) doesn't see the kid's cells: with a runner
	// Ownership blind to edited cells (mutation run: isEdited → false), 29 of 62 edits landed on his floor or its buffer.
	it('criterion 4 (session level): after 20 min with a scripted kid building around, no bot edit ever landed on a kid cell or its buffer', async () => {
		const r = rig({ at: { x: SPAWN.x + 20.5, z: SPAWN.z + 0.5 } });
		// The bot needs blocks to build: a stocked brain file would do too, but the kid's lines are the point here.
		// Stocked, and cool towards Noah, so Build and Mine win while he plays nearby (they anchor on the nearest kid).
		r.h.store.apply([
			{ path: ['inventory'], value: { stone: 40, dirt: 20 } },
			{ path: ['relations', 'Noah'], value: coolRelation() },
		], { kind: 'body', by: 'test' });
		const home = { x: SPAWN.x + 24, z: SPAWN.z + 4 };
		// His earlier work: a 21 × 21 cobblestone floor around his home, the ground a blind Build or Mine would dig.
		for (let x = home.x - 10; x <= home.x + 10; x++) for (let z = home.z - 10; z <= home.z + 10; z++) r.world.set(x, r.world.surfaceY(x, z), z, 'cobblestone');
		const kid = new KidScript({ world: r.world, body: r.body, home });
		const oracle = new Ownership(r.world, () => r.h.store.state.owned);
		const bad: string[] = [];
		let edits = 0;
		const check = (fn: string, x: number, y: number, z: number) => {
			const helping = fn === 'place' && r.h.store.state.behaviour?.kind === 'help-build';
			const onKid = oracle.classify(x, y, z) === 'kid';
			const buffer = !helping && oracle.kidNeighbour(x, y, z, 1);
			if (onKid || buffer) bad.push(`${fn} ${x},${y},${z}${onKid ? ' (kid cell)' : ' (buffer)'} as ${r.h.store.state.behaviour?.kind}`);
		};
		for (const fn of ['placeImpl', 'mineImpl', 'breakImpl'] as const) {
			const inner = r.body[fn] as (x: number, y: number, z: number, n?: string) => Promise<boolean>;
			(r.body as unknown as Record<string, unknown>)[fn] = async (x: number, y: number, z: number, n?: string) => {
				check(fn.replace('Impl', ''), x, y, z);                      // before the write: the world as the bot judged it
				const ok = await inner(x, y, z, n);
				if (ok) edits++;
				return ok;
			};
		}
		await r.run(20 * MIN, () => kid.tick(r.clock.t));
		await r.h.stop();
		expect(kid.placed.length).toBeGreaterThanOrEqual(12);
		expect(edits, 'the bot made edits').toBeGreaterThan(0);
		expect(new Set(started(r.selects()).map((s) => s.winner)).size).toBeGreaterThanOrEqual(3);
		expect(bad).toEqual([]);
	}, 300_000);

	// Red if stop() doesn't flush, or the load path doesn't apply the brain file.
	it('the brain file is written, and reloading it restores inventory, builds and relations', async () => {
		const r = rig({ at: { x: SPAWN.x + 20.5, z: SPAWN.z + 0.5 } });
		r.h.store.apply([{ path: ['inventory'], value: { stone: 40, dirt: 20 } }], { kind: 'body', by: 'test' });
		const kid = new KidScript({ world: r.world, body: r.body, home: { x: SPAWN.x + 24, z: SPAWN.z + 4 } });
		await r.run(5 * MIN, () => kid.tick(r.clock.t));
		r.h.runner.start('build', { ...paramsBuild(r.h.store.state) });
		await r.run(1 * MIN);
		await r.h.stop();
		const before = r.h.store.state;
		expect(Object.keys(before.relations)).toContain('Noah');
		expect(before.builds.length).toBeGreaterThan(0);
		const again = rig({ dir: r.dir, clock: r.clock, world: r.world });
		const after = again.h.store.state;
		expect(after.inventory).toEqual(before.inventory);
		expect(after.builds).toEqual(before.builds);
		expect(after.relations).toEqual(before.relations);
		expect(again.log().some((l) => l.k === 'event' && l.kind === 'brain-file' && (l.data as { note: string }).note === 'loaded')).toBe(true);
		await again.h.stop();
	}, 120_000);

	// Review Focus 1. Red if body.onReconnect isn't wired to own.reset(): the kid-cell index stays stale.
	it('reconnect → ownership reset', async () => {
		const r = rig();
		await r.run(1000);
		const c = { x: SPAWN.x + 5, y: r.world.surfaceY(SPAWN.x + 5, SPAWN.z) + 1, z: SPAWN.z };
		expect(r.h.own.kidCellWithin(c.x, c.z, 3)).toBe(false);          // indexes the chunk
		r.world.set(c.x, c.y, c.z, 'oak_planks');                          // a kid's block placed while the bot was away
		expect(r.h.own.kidCellWithin(c.x, c.z, 3)).toBe(false);          // the stale index
		r.body.emitReconnect();
		expect(r.h.own.kidCellWithin(c.x, c.z, 3)).toBe(true);
		await r.h.stop();
	});

	// §6 (rev 3.3). Red if the runner's spawn is the join pose: the lone Build anchors on it, 100 blocks away.
	it('spawn is the world spawn, not the join pose', async () => {
		const r = rig({ at: { x: SPAWN.x + 100.5, z: SPAWN.z + 0.5 } });
		expect(r.h.spawn).toMatchObject({ x: SPAWN.x, z: SPAWN.z });
		r.h.store.apply([{ path: ['inventory'], value: { stone: 60 } }], { kind: 'body', by: 'test' });
		r.h.runner.start('build', { ...paramsBuild(r.h.store.state) });
		for (let i = 0; i < 600 && r.h.store.state.builds.length === 0; i++) await r.run(100);
		const b = r.h.store.state.builds[0];
		expect(b, 'a build was planned').toBeDefined();
		const d = Math.hypot(b.origin.x - SPAWN.x, b.origin.z - SPAWN.z);
		expect(d).toBeGreaterThanOrEqual(16);
		expect(d).toBeLessThanOrEqual(40);                                  // anchored on the world spawn (leash 32)
		await r.h.stop();
	});
});

describe('runBrain2 wiring details', () => {
	// Red if the StopSignal isn't fed the edits with the bot's journal (mutation run: an empty journal), or its start time
	// doesn't reach the perceiver: broke-my-block has no 'stop'. (Subscription order alone can't turn it red: the
	// perceiver queues edits and reads the start time at its next tick.)
	it("a kid breaking the bot's block marks broke-my-block detail 'stop'", async () => {
		const r = rig();
		const c = { x: SPAWN.x + 3, y: r.world.surfaceY(SPAWN.x + 3, SPAWN.z) + 1, z: SPAWN.z };
		r.world.set(c.x, c.y, c.z, 'stone');
		r.h.store.apply([{ path: ['owned', `${c.x},${c.y},${c.z}`], value: id('stone') }], { kind: 'behaviour', by: 'test' });
		r.body.entries.push({ ...c, oldId: 0, newId: id('stone'), t: WALL0 });
		const noah = player({ id: 7, name: 'Noah', x: c.x + 2, y: c.y, z: c.z });
		r.body.list = [noah];
		await r.run(600);
		r.body.kidEdit(r.world, noah, c, 0);
		await r.run(600);
		const ev = r.h.store.state.events.find((e) => e.kind === 'broke-my-block');
		expect(ev?.detail).toBe('stop');
		expect(r.h.stopSignal.activeFor('Noah', r.clock.t)).toBe(true);
		await r.h.stop();
	});

	// Red if the loaded relations' bands aren't recomputed after the halving.
	it('a brain file older than 30 min: halved relation values get fresh bands', async () => {
		const r = rig();
		r.h.store.apply([{ path: ['relations', 'Noah'], value: {
			axes: { affection: { value: 0.7, band: 'very high', deltas: [] }, cooperation: { value: 0, band: 'neutral', deltas: [] }, respect: { value: 0, band: 'neutral', deltas: [] }, grievance: { value: 0, band: 'neutral', deltas: [] } },
			metSessions: 1, minutesTogether: 3, lastSeenT: 0,
		} }], { kind: 'body', by: 'test' });
		await r.h.stop();
		r.clock.advance(31 * MIN);
		const again = rig({ dir: r.dir, clock: r.clock });
		const a = again.h.store.state.relations.Noah.axes.affection;
		expect(a.value).toBeCloseTo(0.35);
		expect(a.band).toBe('high');
		await again.h.stop();
	});
});
