/**
 * The decorator e2e leg: our own mcserver on a free port, a bot-flagged "Milo" who builds a small house and leaves a
 * builder record for it (as the builder bot would), a scripted kid ("Noah") with a dirt pillar right beside the house,
 * and the real CLI's `decorator` command run in-process (its client pointed at our server, every engine call failing,
 * so each question falls back). Within 4 minutes it must place ≥ 10 decoration cells, all within 4 of the house's
 * footprint and outside it, nothing on or next to the kid's pillar.
 *
 *   BOTS_E2E_SCRATCH=<scratch> npm --prefix bots run e2e -- --only decorator
 *   BOTS_E2E_SCRATCH=<scratch> node_modules/.bin/tsx bots/test/e2e-decorator.ts   (this leg alone)
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BotClient, blockId } from 'minicraft-bot';
import { main as cliMain } from '../src/cli.js';
import { templateOf } from '../src/brain2/behaviours/templates.data.js';
import type { BuilderBuild, BuilderFile } from '../src/builder/builder.js';
import { cellKey, planCells } from '../src/builder/moves.js';
import { PALETTES } from '../src/builder/palettes.data.js';
import { footDist } from '../src/decorator/decor.js';
import type { DecoratorHandle } from '../src/decorator/decorator.js';
import type { Vec3 } from '../src/types.js';
import { Kid } from './kid-client.js';
import { removeBuild, scratchRoot, startServer, TOKEN } from './mcserver.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DecoratorLegCtx { check(ok: boolean, what: string): boolean; info(what: string): void }

export async function decoratorLeg(c: DecoratorLegCtx, budgetMs = 240_000): Promise<void> {
	const server = await startServer();
	if (server.port === 8080 || server.port === 18090) throw new Error(`refusing port ${server.port}`);
	c.info(`mcserver pid ${server.pid} on ${server.url}`);
	const stateRoot = mkdtempSync(join(scratchRoot(), 'decorator-state-'));
	let kid: Kid | null = null;
	let handle: DecoratorHandle | null = null;
	let client: BotClient | null = null;
	try {
		const world = await server.createWorld('e2e-decorator');
		kid = await Kid.connect({ url: server.url, token: TOKEN, world, name: 'Noah' });
		await sleep(500);
		const p = kid.pose();
		// The house: 7 blocks east of the kid, on the ground at its centre.
		const t = templateOf('house', 'small');
		const ox = Math.floor(p.x) + 7, oz = Math.floor(p.z) - 2;
		const g = kid.world.groundY(ox + t.w / 2, oz + t.d / 2, p.y + 20) ?? Math.floor(p.y);
		const origin = { x: ox, y: g, z: oz };
		const cells = planCells(t, origin, PALETTES[0]);
		const milo = new BotClient({ url: server.url, token: TOKEN, editGapMs: 25 });
		await milo.connect({ world, name: 'Milo', skin: 'chip' });
		const owned: Record<string, number> = {};
		const placed: string[] = [];
		for (const pc of cells) {
			if (milo.world.getBlock(pc.cell.x, pc.cell.y, pc.cell.z) !== 0) continue;
			if (await milo.place(pc.cell.x, pc.cell.y, pc.cell.z, pc.block)) {
				owned[cellKey(pc.cell)] = blockId(pc.block)!;
				placed.push(cellKey(pc.cell));
			}
		}
		milo.close();
		c.check(placed.length >= 30, `Milo built the house (${placed.length}/${cells.length} cells)`);
		const build: BuilderBuild = {
			id: 'e2e-house', template: 'house', variant: 'small', palette: PALETTES[0].name, origin, w: t.w, d: t.d, h: t.h,
			cells, placed, skipped: [], status: 'done', t: Date.now(),
		};
		const rec: BuilderFile = { v: 1, builds: [build], owned };
		mkdirSync(join(stateRoot, 'builder', 'local', world), { recursive: true });
		writeFileSync(join(stateRoot, 'builder', 'local', world, 'Milo.json'), JSON.stringify(rec));
		// The kid's pillar on the house's north-west outside corner: exactly where the corner lights would go.
		const px = ox - 1, pz = oz - 1;
		const pg = (kid.world.groundY(px + 0.5, pz + 0.5, g + 10) ?? g - 1);
		const pillar: Vec3[] = [0, 1, 2].map((i) => ({ x: px, y: pg + i, z: pz }));
		for (const cell of pillar) c.check(await kid.place(cell, 'dirt'), `the kid placed his pillar cell ${cell.x},${cell.y},${cell.z}`);
		await sleep(300);

		const lines: string[] = [];
		const failFetch = (async () => {
			throw new Error('engine unavailable (e2e)');
		}) as unknown as typeof fetch;
		await cliMain(['decorator', '--target', 'local', '--world', world, '--name', 'Deco', '--skin', 'chip', '--brain', 'laya', '--compare'], {
			makeClient: (opts) => new BotClient({ ...opts, url: server.url }),
			stateRoot, env: {}, readFile: () => null, print: (l) => lines.push(l), fetchImpl: failFetch, builderRestMs: 1000,
			onDecorator: (h, cl) => {
				handle = h;
				client = cl;
			},
		});
		const h = handle as DecoratorHandle | null;
		if (!c.check(h !== null, `the CLI started the decorator: ${lines.join(' | ')}`) || !h) return;
		const t0 = Date.now();
		let lastInfo = 0;
		while (Date.now() - t0 < budgetMs && h.stats.placed < 10) {
			await sleep(1000);
			if (Date.now() - lastInfo > 30_000) {
				lastInfo = Date.now();
				c.info(`${Math.round((Date.now() - t0) / 1000)} s: ${h.stats.current}; placed ${h.stats.placed}, refused ${h.stats.refused}, failed ${h.stats.failed}`);
			}
		}
		const secs = Math.round((Date.now() - t0) / 1000);
		c.check(h.stats.placed >= 10, `≥ 10 decoration cells placed in ${secs} s (placed ${h.stats.placed}, done ${h.stats.done}, abandoned ${h.stats.abandoned})`);
		const deco = h.file.decorations.flatMap((d) => d.placed.map((k) => k.split(',').map(Number) as [number, number, number]));
		c.info(`decorations: ${h.file.decorations.map((d) => `${d.kind} ${d.status} ${d.placed.length}/${d.cells.length}`).join('; ')}`);
		const nearPillar = deco.filter(([x, y, z]) => pillar.some((q) => Math.max(Math.abs(q.x - x), Math.abs(q.y - y), Math.abs(q.z - z)) <= 1));
		c.check(nearPillar.length === 0, `nothing placed on or next to the kid's pillar (${nearPillar.length})`);
		c.check(pillar.every((q) => kid!.world.blockName(kid!.world.getBlock(q.x, q.y, q.z)) === 'dirt'), 'the pillar is intact');
		const far = deco.filter(([x, , z]) => footDist(build, x, z) < 1 || footDist(build, x, z) > 4);
		c.check(far.length === 0, `every decoration cell is outside the house and within 4 of it (${far.length} not)`);
		const houseIntact = placed.every((k) => {
			const [x, y, z] = k.split(',').map(Number);
			return kid!.world.getBlock(x, y, z) === owned[k];
		});
		c.check(houseIntact, 'the house is untouched');
		const seen = deco.filter(([x, y, z]) => kid!.world.getBlock(x, y, z) !== 0).length;
		c.check(seen === deco.length, `the kid's world shows every decoration (${seen}/${deco.length})`);
		const logDir = join(stateRoot, 'logs', 'local', world);
		const log = readdirSync(logDir).map((f) => readFileSync(join(logDir, f), 'utf8')).join('');
		const decisions = log.split('\n').filter((l) => l.includes('"k":"decision"'));
		c.check(decisions.length > 0 && decisions.every((l) => l.includes('"fallback":true')), `decisions logged, all fallbacks with the engines down (${decisions.length})`);
		const stateFile = readFileSync(join(stateRoot, 'decorator', 'local', world, 'Deco.json'), 'utf8');
		c.check(JSON.parse(stateFile).decorations.length >= 1, 'the decorator state file holds its decorations');
	} finally {
		const h = handle as DecoratorHandle | null;
		if (h) await Promise.race([h.stop(), sleep(5000)]);
		(client as BotClient | null)?.close();
		kid?.close();
		await server.stop();
	}
}

// Run alone: `tsx bots/test/e2e-decorator.ts`.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	let ok = true;
	const ctx: DecoratorLegCtx = {
		check: (v, what) => {
			console.log(`   ${v ? 'ok  ' : 'FAIL'} ${what}`);
			if (!v) ok = false;
			return v;
		},
		info: (what) => console.log(`   info ${what}`),
	};
	decoratorLeg(ctx)
		.catch((e: unknown) => {
			ok = false;
			console.error(e);
		})
		.finally(() => {
			removeBuild();
			console.log(ok ? 'PASS decorator' : 'FAIL decorator');
			process.exit(ok ? 0 : 1);
		});
}
