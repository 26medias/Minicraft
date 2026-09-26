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
import { capCount } from '../../src/shared/cap.js';
import { FakeBody, FakeWorld } from '../fake-port.js';

const known = new Set(blockNames());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A finished small house at (ox, oz), built into the world, as a builder record. */
function house(world: FakeWorld, id: string, ox: number, oz: number): BuilderBuild {
	const t = templateOf('house', 'small');
	const oy = world.surfaceY(ox, oz) + 1;
	const cells = planCells(t, { x: ox, y: oy, z: oz }, PALETTES[0]);
	for (const c of cells) world.set(c.cell.x, c.cell.y, c.cell.z, c.block);
	return {
		id, template: 'house', variant: 'small', palette: PALETTES[0].name, origin: { x: ox, y: oy, z: oz }, w: t.w, d: t.d, h: t.h,
		cells, placed: cells.map((c) => cellKey(c.cell)), skipped: [], status: 'done', t: 1,
	};
}

function rng(seed: number) {
	let s = seed >>> 0;
	return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('build cap', () => {
	it('counts finished builds and any that placed a block; not attempts that placed nothing', () => {
		expect(capCount([
			{ status: 'done', placed: ['a'] }, { status: 'abandoned', placed: ['a'] }, { status: 'abandoned', placed: [] }, { status: 'building', placed: [] },
		])).toBe(2);
	});

	/** Runs a builder over a state file holding `n` finished builds, with --max-builds `max`; returns its log kinds and the body's places. */
	async function builderRun(n: number, max: number) {
		const world = new FakeWorld();
		const builds = Array.from({ length: n }, (_, i) => house(world, `b${i}`, 100 + i * 12, 100));
		const owned: Record<string, number> = {};
		for (const b of builds) for (const c of b.cells) owned[cellKey(c.cell)] = blockId(c.block)!;
		const file: BuilderFile = { v: 1, builds, owned };
		const root = mkdtempSync(join(tmpdir(), 'cap-'));
		const statePath = join(root, 'Milo.json');
		writeFileSync(statePath, JSON.stringify(file));
		const body = new FakeBody();
		body.world = world;
		body.current = { x: 90, y: world.surfaceY(90, 90) + 1, z: 90, yaw: 0, pitch: 0 };
		const log: Array<Record<string, unknown>> = [];
		const h = runBuilder({
			name: 'Milo', body, world, spawn: { x: 0, y: 0, z: 0 }, primary: null, noEdits: false, statePath, rng: rng(3), paceMs: 0, restMs: 10,
			known, maxBuilds: max, log: (e) => log.push(e),
		});
		const t0 = Date.now();
		while (Date.now() - t0 < 1500 && !log.some((e) => e.k === 'cap-reached' || (e.k === 'decision' && e.what === 'project'))) await sleep(20);
		await sleep(200);
		await h.stop();
		return { log, places: body.calls.filter((c) => c.fn === 'place').length, current: h.stats.current };
	}

	it('the builder at its cap (restored from its file) never plans another build and never places', async () => {
		const r = await builderRun(3, 3);
		expect(r.log.some((e) => e.k === 'cap-reached' && e.builds === 3 && e.max === 3)).toBe(true);
		expect(r.log.some((e) => e.k === 'decision' && e.what === 'project')).toBe(false);
		expect(r.places).toBe(0);
		expect(r.current).toMatch(/cap reached/);
	});

	it('control: one under the cap, the same builder plans its next build', async () => {
		const r = await builderRun(3, 4);
		expect(r.log.some((e) => e.k === 'cap-reached')).toBe(false);
		expect(r.log.some((e) => e.k === 'decision' && e.what === 'project')).toBe(true);
	});

	async function decoratorRun(n: number, max: number) {
		const world = new FakeWorld();
		const b = house(world, 'b1', 100, 100);
		const root = mkdtempSync(join(tmpdir(), 'cap-deco-'));
		const bdir = join(root, 'builder');
		mkdirSync(bdir, { recursive: true });
		const owned: Record<string, number> = {};
		for (const c of b.cells) owned[cellKey(c.cell)] = blockId(c.block)!;
		writeFileSync(join(bdir, 'Milo.json'), JSON.stringify({ v: 1, builds: [b], owned }));
		const deco: DecoratorFile = {
			v: 1, owned: {},
			decorations: Array.from({ length: n }, (_, i) => ({
				id: `d${i}`, bot: 'Milo', buildId: 'gone', kind: 'lights' as const, description: 'x', cells: [], placed: ['1,2,3'], skipped: [], status: 'done' as const, t: 1,
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

	it('the decorator at its cap never starts a decoration; control one under it does', async () => {
		const capped = await decoratorRun(5, 5);
		expect(capped.log.some((e) => e.k === 'cap-reached')).toBe(true);
		expect(capped.log.some((e) => e.k === 'decoration')).toBe(false);
		expect(capped.places).toBe(0);
		const under = await decoratorRun(5, 6);
		expect(under.log.some((e) => e.k === 'decoration')).toBe(true);
	});
});
