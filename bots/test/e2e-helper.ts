/**
 * The helper e2e leg: our own mcserver on a free port, the real CLI's `helper` command run in-process (its client
 * pointed at our server, every engine call failing, so each question falls back), then a scripted kid ("Noah") lays a
 * line of 10 oak_planks. Within ~4 minutes the helper must finish a small matching build (≥ 6 cells placed), every cell
 * ≥ 4 blocks (never within 3) from the kid's cells, only oak_planks, and the kid's line intact.
 *
 *   BOTS_E2E_SCRATCH=<scratch> node_modules/.bin/tsx bots/test/e2e-helper.ts   (this leg alone)
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BotClient } from 'minicraft-bot';
import { main as cliMain } from '../src/cli.js';
import type { HelperHandle } from '../src/helper/helper.js';
import type { Vec3 } from '../src/types.js';
import { Kid } from './kid-client.js';
import { removeBuild, scratchRoot, startServer, TOKEN } from './mcserver.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface HelperLegCtx { check(ok: boolean, what: string): boolean; info(what: string): void }

export async function helperLeg(c: HelperLegCtx, budgetMs = 240_000): Promise<void> {
	const server = await startServer();
	if (server.port === 8080 || server.port === 18090) throw new Error(`refusing port ${server.port}`);
	c.info(`mcserver pid ${server.pid} on ${server.url}`);
	const stateRoot = mkdtempSync(join(scratchRoot(), 'helper-state-'));
	let kid: Kid | null = null;
	let handle: HelperHandle | null = null;
	let client: BotClient | null = null;
	try {
		const world = await server.createWorld('e2e-helper');
		kid = await Kid.connect({ url: server.url, token: TOKEN, world, name: 'Noah' });
		await sleep(500);
		const lines: string[] = [];
		const failFetch = (async () => {
			throw new Error('engine unavailable (e2e)');
		}) as unknown as typeof fetch;
		await cliMain(['helper', '--target', 'local', '--world', world, '--name', 'Buddy', '--brain', 'laya', '--compare'], {
			makeClient: (opts) => new BotClient({ ...opts, url: server.url }),
			stateRoot, env: {}, readFile: () => null, print: (l) => lines.push(l), fetchImpl: failFetch, builderRestMs: 2000,
			onHelper: (h, cl) => {
				handle = h;
				client = cl;
			},
		});
		const h = handle as HelperHandle | null;
		if (!c.check(h !== null, `the CLI started the helper: ${lines.join(' | ')}`) || !h) return;
		await sleep(3000);
		c.check(h.stats.placed === 0 && h.file.builds.length === 0, `no kid building: the helper idles (${h.stats.current})`);
		// The kid lays a line of 10 oak_planks along +x, walking beside it.
		const p = kid.pose();
		const x0 = Math.floor(p.x) + 2, z0 = Math.floor(p.z);
		const line: Vec3[] = [];
		for (let i = 0; i < 10; i++) {
			const x = x0 + i;
			const g = kid.world.groundY(x + 0.5, z0 + 0.5, p.y + 4) ?? Math.floor(p.y);
			const cell = { x, y: g, z: z0 };
			await kid.walkTo({ x: x + 0.5, z: z0 - 1.5 });
			if (await kid.place(cell, 'oak_planks')) line.push(cell);
			await sleep(800);
		}
		c.check(line.length >= 8, `the kid placed his line (${line.length}/10)`);
		const t0 = Date.now();
		let lastInfo = 0;
		while (Date.now() - t0 < budgetMs && h.stats.buildsDone < 1) {
			await sleep(2000);
			if (Date.now() - lastInfo > 30_000) {
				lastInfo = Date.now();
				c.info(`${Math.round((Date.now() - t0) / 1000)} s: ${h.stats.current}; placed ${h.stats.placed}, done ${h.stats.buildsDone}, abandoned ${h.stats.buildsAbandoned}, refused ${h.stats.refused}, failed ${h.stats.failed}`);
			}
		}
		const secs = Math.round((Date.now() - t0) / 1000);
		const b = h.file.builds.find((x) => x.status === 'done');
		c.info(`builds: ${h.file.builds.map((x) => `${x.template} ${x.status} ${x.placed.length}/${x.cells.length} at ${x.origin.x},${x.origin.z} rot ${x.rot} gap ${x.minGap}`).join('; ') || 'none'}`);
		c.check(!!b && b.placed.length >= 6, `a matching build finished with ≥ 6 cells in ${secs} s (${b ? b.placed.length : 0})`);
		const cells = Object.keys(h.file.owned).map((k) => k.split(',').map(Number) as [number, number, number]);
		const gaps = cells.map(([x, , z]) => Math.min(...line.map((q) => Math.hypot(q.x - x, q.z - z))));
		c.check(cells.length > 0 && gaps.every((g) => g > 3), `every helper cell is > 3 blocks from the kid's cells (min ${Math.min(...gaps).toFixed(1)}, ${cells.length} cells)`);
		c.check(Math.min(...gaps) <= 8, `the build is next to his (nearest ${Math.min(...gaps).toFixed(1)} ≤ 8)`);
		const names = new Set(cells.map(([x, y, z]) => kid!.world.blockName(kid!.world.getBlock(x, y, z))));
		c.check([...names].every((n) => n === 'oak_planks'), `only his block: ${[...names].join(', ')}`);
		c.check(line.every((q) => kid!.world.blockName(kid!.world.getBlock(q.x, q.y, q.z)) === 'oak_planks'), 'his line is intact');
		const logDir = join(stateRoot, 'logs', 'local', world);
		const log = readdirSync(logDir).map((f) => readFileSync(join(logDir, f), 'utf8')).join('');
		c.check(log.includes('"what":"help"') && log.includes('"k":"project"'), 'the help decision and the project are logged');
		const shared = readFileSync(join(stateRoot, 'shared', 'local', world, 'bot-cells.jsonl'), 'utf8').trim().split('\n');
		c.check(shared.length === h.stats.placed, `every placed cell is in the shared registry (${shared.length}/${h.stats.placed})`);
	} finally {
		const h = handle as HelperHandle | null;
		if (h) await Promise.race([h.stop(), sleep(5000)]);
		(client as BotClient | null)?.close();
		kid?.close();
		await server.stop();
	}
}

// Run alone: `tsx bots/test/e2e-helper.ts`.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	let ok = true;
	const ctx: HelperLegCtx = {
		check: (v, what) => {
			console.log(`   ${v ? 'ok  ' : 'FAIL'} ${what}`);
			if (!v) ok = false;
			return v;
		},
		info: (what) => console.log(`   info ${what}`),
	};
	helperLeg(ctx)
		.catch((e: unknown) => {
			ok = false;
			console.error(e);
		})
		.finally(() => {
			removeBuild();
			console.log(ok ? 'PASS helper' : 'FAIL helper');
			process.exit(ok ? 0 : 1);
		});
}
