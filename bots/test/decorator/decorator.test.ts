import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blockId, blockNames } from 'minicraft-bot';
import { StopSignal } from '../../src/body/stop-signal.js';
import { Ownership } from '../../src/brain2/ownership.js';
import { templateOf } from '../../src/brain2/behaviours/templates.data.js';
import type { BuilderBuild, BuilderFile } from '../../src/builder/builder.js';
import { cellKey, planCells } from '../../src/builder/moves.js';
import { PALETTES } from '../../src/builder/palettes.data.js';
import { candidateDecorations, DECOR_BLOCKS, footDist } from '../../src/decorator/decor.js';
import { runDecorator } from '../../src/decorator/decorator.js';
import { FakeBody, FakeWorld } from '../fake-port.js';

const known = new Set(blockNames());

/** A small oak house built into the fake world, as a builder record (its cells owned by the builder). */
function builtHouse(world: FakeWorld, ox = 100, oz = 100): { build: BuilderBuild; file: BuilderFile } {
	const t = templateOf('house', 'small');
	// A flat natural lawn 6 blocks around the site (the builder only builds on flat sites).
	const gy = world.surfaceY(ox, oz);
	for (let x = ox - 7; x <= ox + t.w + 7; x++) {
		for (let z = oz - 7; z <= oz + t.d + 7; z++) {
			for (let y = gy - 3; y < gy; y++) world.setNatural(x, y, z, 'dirt');
			world.setNatural(x, gy, z, 'grass_block');
			for (let y = gy + 1; y <= gy + 14; y++) world.setNatural(x, y, z, 0);
		}
	}
	const oy = gy + 1;
	const cells = planCells(t, { x: ox, y: oy, z: oz }, PALETTES[0]);
	const owned: Record<string, number> = {};
	for (const c of cells) {
		world.set(c.cell.x, c.cell.y, c.cell.z, c.block);
		owned[cellKey(c.cell)] = blockId(c.block)!;
	}
	const build: BuilderBuild = {
		id: 'b1', template: 'house', variant: 'small', palette: PALETTES[0].name, origin: { x: ox, y: oy, z: oz }, w: t.w, d: t.d, h: t.h,
		cells, placed: cells.map((c) => cellKey(c.cell)), skipped: [], status: 'done', t: 1,
	};
	return { build, file: { v: 1, builds: [build], owned } };
}

function rng(seed: number) {
	let s = seed >>> 0;
	return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('decorator candidates', () => {
	it('decoration blocks are real catalog names', () => {
		for (const n of Object.values(DECOR_BLOCKS).flat()) expect(known.has(n), n).toBe(true);
	});

	it('stay within 4 of the build, outside it, in air, and off (and not next to) a kid cell', () => {
		const world = new FakeWorld();
		const { build, file } = builtHouse(world);
		// A kid block right where the flowers / fence / bush could go: 2 out from the west side, on the ground.
		const kid = { x: build.origin.x - 2, y: build.origin.y, z: build.origin.z + 2 };
		world.set(kid.x, kid.y, kid.z, 'dirt');
		const own = new Ownership(world, () => file.owned);
		let total = 0;
		const kinds = new Set<string>();
		for (let seed = 1; seed <= 12; seed++) {
			const cands = candidateDecorations(build, {
				world, own, kids: [], stop: new StopSignal(600_000), now: 1e9, lastEditT: null, noEdits: false,
				allBuilds: [build], known, rng: rng(seed),
			});
			expect(cands.length).toBeGreaterThan(0);
			expect(cands.length).toBeLessThanOrEqual(3);
			for (const d of cands) {
				kinds.add(d.kind);
				for (const { cell, block } of d.cells) {
					total++;
					const fd = footDist(build, cell.x, cell.z);
					expect(fd, `${d.kind} ${cellKey(cell)}`).toBeGreaterThanOrEqual(1);
					expect(fd, `${d.kind} ${cellKey(cell)}`).toBeLessThanOrEqual(4);
					expect(world.getBlock(cell.x, cell.y, cell.z)).toBe(0);
					expect(known.has(block)).toBe(true);
					const cheb = Math.max(Math.abs(cell.x - kid.x), Math.abs(cell.y - kid.y), Math.abs(cell.z - kid.z));
					expect(cheb, `${d.kind} ${cellKey(cell)} near the kid cell`).toBeGreaterThan(1);
				}
			}
		}
		expect(total).toBeGreaterThan(20);
		expect(kinds.size).toBeGreaterThanOrEqual(4);
	});
});

describe('decorator placement', () => {
	it('never places into a cell that stopped being air (a block appeared after the plan)', async () => {
		const world = new FakeWorld();
		const { build, file } = builtHouse(world);
		const root = mkdtempSync(join(tmpdir(), 'decorator-'));
		const bdir = join(root, 'builder');
		mkdirSync(bdir, { recursive: true });
		writeFileSync(join(bdir, 'Milo.json'), JSON.stringify(file));
		const body = new FakeBody();
		body.world = world;
		body.current = { x: build.origin.x - 3.5, y: build.origin.y, z: build.origin.z - 3.5, yaw: 0, pitch: 0 };
		const intoNonAir: string[] = [];
		const placed: string[] = [];
		body.placeImpl = async (x, y, z, name) => {
			if (world.getBlock(x, y, z) !== 0) intoNonAir.push(cellKey({ x, y, z }));
			world.set(x, y, z, name);
			placed.push(cellKey({ x, y, z }));
			return true;
		};
		const stoned: string[] = [];
		let t = 1e12;
		const h = runDecorator({
			name: 'Deco', body, world, primary: null, noEdits: false, statePath: join(root, 'd.json'), builderDir: bdir,
			clock: () => (t += 1000), rng: rng(7), paceMs: 0, restMs: 10, known,
			log: (e) => {
				// Every new decoration: a natural stone block appears in every other planned cell before it is placed.
				if (e.k !== 'decoration') return;
				const rec = h.file.decorations.at(-1)!;
				rec.cells.forEach((c, i) => {
					if (i % 2 === 1) {
						world.setNatural(c.cell.x, c.cell.y, c.cell.z, 'stone');
						stoned.push(cellKey(c.cell));
					}
				});
			},
		});
		const t0 = Date.now();
		while (h.stats.done + h.stats.abandoned < 3 && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 20));
		await h.stop();
		expect(stoned.length).toBeGreaterThan(0);
		expect(placed.length).toBeGreaterThan(0);
		expect(intoNonAir).toEqual([]);
		expect(placed.filter((k) => stoned.includes(k))).toEqual([]);
	}, 30_000);
});
