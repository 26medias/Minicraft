import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blockId, blockNames } from 'minicraft-bot';
import { templateOf } from '../../src/brain2/behaviours/templates.data.js';
import { runBuilder, type BuilderBuild, type BuilderFile } from '../../src/builder/builder.js';
import { cellKey, planCells } from '../../src/builder/moves.js';
import { PALETTES } from '../../src/builder/palettes.data.js';
import { runDecorator, type DecoratorFile } from '../../src/decorator/decorator.js';
import { capCount, capMsUntilSlot, capReached } from '../../src/shared/cap.js';
import { readPlan, type NeighbourhoodPlan } from '../../src/foreman/plan-file.js';
import { FakeBody, FakeWorld } from '../fake-port.js';

const known = new Set(blockNames());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HOUR = 60 * 60_000;

/** A finished small house at (ox, oz), built into the world, as a builder record timestamped `t` (default now). */
function house(world: FakeWorld, id: string, ox: number, oz: number, t = Date.now()): BuilderBuild {
	const tpl = templateOf('house', 'small');
	const oy = world.surfaceY(ox, oz) + 1;
	const cells = planCells(tpl, { x: ox, y: oy, z: oz }, PALETTES[0]);
	for (const c of cells) world.set(c.cell.x, c.cell.y, c.cell.z, c.block);
	return {
		id, template: 'house', variant: 'small', palette: PALETTES[0].name, origin: { x: ox, y: oy, z: oz }, w: tpl.w, d: tpl.d, h: tpl.h,
		cells, placed: cells.map((c) => cellKey(c.cell)), skipped: [], status: 'done', t,
	};
}

function rng(seed: number) {
	let s = seed >>> 0;
	return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('build cap (pure)', () => {
	const now = 10_000_000;

	it('counts finished builds and any that placed a block; not attempts that placed nothing', () => {
		expect(capCount([
			{ status: 'done', placed: ['a'], t: now }, { status: 'abandoned', placed: ['a'], t: now },
			{ status: 'abandoned', placed: [], t: now }, { status: 'building', placed: [], t: now },
		], now)).toBe(2);
	});

	it('builds on claimed plan lots never count toward the cap', () => {
		expect(capCount([{ status: 'done', placed: ['a'], lot: 'lot-1', t: now }, { status: 'done', placed: ['a'], t: now }], now)).toBe(1);
	});

	it('a build older than the rolling hour no longer counts, or reaches the cap', () => {
		const recs = [{ status: 'done' as const, placed: ['a'], t: now - HOUR - 1 }];
		expect(capCount(recs, now)).toBe(0);
		expect(capReached(recs, 1, now)).toBe(false);
	});

	it('a build within the rolling hour counts, and reaches the cap at max', () => {
		const recs = [{ status: 'done' as const, placed: ['a'], t: now - (HOUR - 60_000) }];
		expect(capCount(recs, now)).toBe(1);
		expect(capReached(recs, 1, now)).toBe(true);
		expect(capReached(recs, 2, now)).toBe(false);
	});

	it('msUntilSlot is the time until the oldest counted record ages out, 0 once under the cap', () => {
		const recs = [{ status: 'done' as const, placed: ['a'], t: now - 50 * 60_000 }];
		expect(capMsUntilSlot(recs, 1, now)).toBe(10 * 60_000);
		expect(capMsUntilSlot(recs, 2, now)).toBe(0);
	});
});

describe('build cap (bots)', () => {
	/** Runs a builder over a state file holding `n` builds `ageMinutes` old, with --max-builds `max`; returns its log and the body's places. */
	async function builderRun(n: number, max: number, opts: { planLot?: boolean; ageMinutes?: number } = {}) {
		const { planLot = false, ageMinutes = 0 } = opts;
		const world = new FakeWorld();
		const t = Date.now() - ageMinutes * 60_000;
		const builds = Array.from({ length: n }, (_, i) => house(world, `b${i}`, 100 + i * 12, 100, t));
		const owned: Record<string, number> = {};
		for (const b of builds) for (const c of b.cells) owned[cellKey(c.cell)] = blockId(c.block)!;
		const file: BuilderFile = { v: 1, builds, owned };
		const root = mkdtempSync(join(tmpdir(), 'cap-'));
		const statePath = join(root, 'Milo.json');
		writeFileSync(statePath, JSON.stringify(file));
		let planPath: string | undefined;
		if (planLot) {
			planPath = join(root, 'plan.json');
			const lx = 200, lz = 100, ly = world.surfaceY(lx, lz) + 1;
			const plan: NeighbourhoodPlan = {
				v: 1, id: 'p1', foreman: 'Boss', t: 1, anchor: { x: lx, y: ly, z: lz }, corner: { x: lx, z: lz }, cols: 1, rows: 1,
				lots: [{ id: 'lot-1', origin: { x: lx, y: ly, z: lz }, w: 14, d: 14, h: 14, status: 'open' }], roads: [], lamps: [],
			};
			writeFileSync(planPath, JSON.stringify(plan));
		}
		const body = new FakeBody();
		body.world = world;
		body.current = { x: 90, y: world.surfaceY(90, 90) + 1, z: 90, yaw: 0, pitch: 0 };
		const log: Array<Record<string, unknown>> = [];
		const h = runBuilder({
			name: 'Milo', body, world, spawn: { x: 0, y: 0, z: 0 }, primary: null, noEdits: false, statePath, rng: rng(3), paceMs: 0, restMs: 10,
			known, maxBuilds: max, log: (e) => log.push(e), ...(planPath ? { planPath, joinPlan: true } : {}),
		});
		const t0 = Date.now();
		while (Date.now() - t0 < 1500 && !log.some((e) => e.k === 'cap-reached' || (e.k === 'decision' && e.what === 'project') || e.lot)) await sleep(20);
		await sleep(200);
		await h.stop();
		const lot = planPath ? readPlan(planPath)!.lots[0] : undefined;
		return { log, places: body.calls.filter((c) => c.fn === 'place').length, current: h.stats.current, lot };
	}

	it('the builder with N builds in the last hour (restored from its file) never plans another build and never places', async () => {
		const r = await builderRun(3, 3);
		expect(r.log.some((e) => e.k === 'cap-reached' && e.builds === 3 && e.max === 3)).toBe(true);
		expect(r.log.some((e) => e.k === 'decision' && e.what === 'project')).toBe(false);
		expect(r.places).toBe(0);
		expect(r.current).toMatch(/hourly limit reached/);
	});

	it('control: one under the cap, the same builder plans its next build', async () => {
		const r = await builderRun(3, 4);
		expect(r.log.some((e) => e.k === 'cap-reached')).toBe(false);
		expect(r.log.some((e) => e.k === 'decision' && e.what === 'project')).toBe(true);
	});

	it('a builder whose builds are all more than 60 min old builds again despite n >= max', async () => {
		const r = await builderRun(3, 3, { ageMinutes: 61 });
		expect(r.log.some((e) => e.k === 'cap-reached')).toBe(false);
		expect(r.log.some((e) => e.k === 'decision' && e.what === 'project')).toBe(true);
	});

	it('a capped --join-plan builder still claims the open plan lot (control: the same capped bot without a plan does not)', async () => {
		const r = await builderRun(3, 3, { planLot: true });
		expect(r.lot?.claimedBy).toBe('Milo');
		expect(r.log.some((e) => e.k === 'project' && e.lot === 'lot-1') || r.log.some((e) => e.k === 'lot-rejected' && e.lot === 'lot-1')).toBe(true);
	});

	/** Runs a decorator over a state file holding `n` decorations `ageMinutes` old, with --max-decorations `max`. */
	async function decoratorRun(n: number, max: number, ageMinutes = 0) {
		const world = new FakeWorld();
		const b = house(world, 'b1', 100, 100);
		const root = mkdtempSync(join(tmpdir(), 'cap-deco-'));
		const bdir = join(root, 'builder');
		mkdirSync(bdir, { recursive: true });
		const owned: Record<string, number> = {};
		for (const c of b.cells) owned[cellKey(c.cell)] = blockId(c.block)!;
		writeFileSync(join(bdir, 'Milo.json'), JSON.stringify({ v: 1, builds: [b], owned }));
		const t = Date.now() - ageMinutes * 60_000;
		const deco: DecoratorFile = {
			v: 1, owned: {},
			decorations: Array.from({ length: n }, (_, i) => ({
				id: `d${i}`, bot: 'Milo', buildId: 'gone', kind: 'lights' as const, description: 'x', cells: [], placed: ['1,2,3'], skipped: [], status: 'done' as const, t,
			})),
		};
		const statePath = join(root, 'Deco.json');
		writeFileSync(statePath, JSON.stringify(deco));
		const body = new FakeBody();
		body.world = world;
		body.current = { x: 96.5, y: b.origin.y, z: 96.5, yaw: 0, pitch: 0 };
		const log: Array<Record<string, unknown>> = [];
		const h = runDecorator({
			name: 'Deco', body, world, primary: null, noEdits: false, statePath, builderDir: bdir, rng: rng(5), paceMs: 0, restMs: 10,
			known, maxDecorations: max, log: (e) => log.push(e),
		});
		const t0 = Date.now();
		while (Date.now() - t0 < 1500 && !log.some((e) => e.k === 'cap-reached' || e.k === 'decoration')) await sleep(20);
		await h.stop();
		return { log, places: body.calls.filter((c) => c.fn === 'place').length };
	}

	it('the decorator with N decorations in the last hour never starts one; control one under it does', async () => {
		const capped = await decoratorRun(5, 5);
		expect(capped.log.some((e) => e.k === 'cap-reached')).toBe(true);
		expect(capped.log.some((e) => e.k === 'decoration')).toBe(false);
		expect(capped.places).toBe(0);
		const under = await decoratorRun(5, 6);
		expect(under.log.some((e) => e.k === 'decoration')).toBe(true);
	});

	it('a decorator whose decorations are all more than 60 min old decorates again despite n >= max', async () => {
		const r = await decoratorRun(5, 5, 61);
		expect(r.log.some((e) => e.k === 'cap-reached')).toBe(false);
		expect(r.log.some((e) => e.k === 'decoration')).toBe(true);
	});
});
