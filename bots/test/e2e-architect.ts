/**
 * The architect e2e leg: our own mcserver on a free port, a scripted kid ("Noah") beside a dirt pillar he made, and
 * the real CLI's `architect` command run in-process (its client pointed at our server, every engine call failing, so
 * each question falls back: a random idea and theme, the smallest size). Within ~5 minutes it must finish one design
 * with ≥ 30 cells placed, place nothing within 3 blocks of the kid's pillar, and log its design decisions.
 *
 *   BOTS_E2E_SCRATCH=<scratch> node_modules/.bin/tsx bots/test/e2e-architect.ts   (this leg alone)
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BotClient } from 'minicraft-bot';
import { main as cliMain } from '../src/cli.js';
import type { ArchitectHandle } from '../src/architect/architect.js';
import type { Vec3 } from '../src/types.js';
import { Kid } from './kid-client.js';
import { removeBuild, scratchRoot, startServer, TOKEN } from './mcserver.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ArchitectLegCtx { check(ok: boolean, what: string): boolean; info(what: string): void }

export async function architectLeg(c: ArchitectLegCtx, budgetMs = 330_000): Promise<void> {
	const server = await startServer();
	if (server.port === 8080 || server.port === 18090) throw new Error(`refusing port ${server.port}`);
	c.info(`mcserver pid ${server.pid} on ${server.url}`);
	const stateRoot = mkdtempSync(join(scratchRoot(), 'architect-state-'));
	let kid: Kid | null = null;
	let handle: ArchitectHandle | null = null;
	let client: BotClient | null = null;
	try {
		const world = await server.createWorld('e2e-architect');
		kid = await Kid.connect({ url: server.url, token: TOKEN, world, name: 'Noah' });
		await sleep(500);
		const p = kid.pose();
		const px = Math.floor(p.x) + 2, pz = Math.floor(p.z);
		const g = kid.world.groundY(px + 0.5, pz + 0.5, p.y + 2) ?? Math.floor(p.y);
		const pillar: Vec3[] = [0, 1, 2, 3].map((i) => ({ x: px, y: g + i, z: pz }));
		for (const cell of pillar) c.check(await kid.place(cell, 'dirt'), `the kid placed his pillar cell ${cell.x},${cell.y},${cell.z}`);
		const lines: string[] = [];
		const failFetch = (async () => {
			throw new Error('engine unavailable (e2e)');
		}) as unknown as typeof fetch;
		await cliMain(['architect', '--target', 'local', '--world', world, '--name', 'Archie', '--brain', 'laya', '--compare'], {
			makeClient: (opts) => new BotClient({ ...opts, url: server.url }),
			stateRoot, env: {}, readFile: () => null, print: (l) => lines.push(l), fetchImpl: failFetch, builderRestMs: 1000,
			onArchitect: (h, cl) => {
				handle = h;
				client = cl;
			},
		});
		const h = handle as ArchitectHandle | null;
		if (!c.check(h !== null, `the CLI started the architect: ${lines.join(' | ')}`) || !h) return;
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
		c.info(`builds: ${h.file.builds.map((x) => `${x.size} ${x.idea} (${x.theme}, ${x.style}) ${x.status} ${x.placed.length}/${x.cells.length} at ${x.origin.x},${x.origin.z}`).join('; ') || 'none'}`);
		const b = h.file.builds.find((x) => x.status === 'done');
		c.check(!!b && b.placed.length >= 30, `one design finished with ≥ 30 cells in ${secs} s (${b ? `${b.placed.length}/${b.cells.length}` : 'none'})`);
		const cells = Object.keys(h.file.owned).map((k) => k.split(',').map(Number) as [number, number, number]);
		const gaps = cells.map(([x, , z]) => Math.min(...pillar.map((q) => Math.hypot(q.x - x, q.z - z))));
		c.check(cells.length > 0 && gaps.every((g) => g > 3), `nothing within 3 blocks of the kid's pillar (nearest ${cells.length ? Math.min(...gaps).toFixed(1) : '-'}, ${cells.length} cells)`);
		c.check(pillar.every((q) => kid!.world.blockName(kid!.world.getBlock(q.x, q.y, q.z)) === 'dirt'), 'the pillar is intact');
		if (b) {
			// What stands is the design: every placed cell holds its design block.
			const wrong = b.cells.filter((dc) => b.placed.includes(`${dc.cell.x},${dc.cell.y},${dc.cell.z}`) && kid!.world.blockName(kid!.world.getBlock(dc.cell.x, dc.cell.y, dc.cell.z)) !== dc.block);
			c.check(wrong.length === 0, `every placed cell holds its design block (${wrong.length} differ)`);
		}
		const logDir = join(stateRoot, 'logs', 'local', world);
		const log = readdirSync(logDir).map((f) => readFileSync(join(logDir, f), 'utf8')).join('');
		const decisions = log.split('\n').filter((l) => l.includes('"k":"decision"'));
		c.check(['idea', 'theme', 'size', 'style'].every((w) => decisions.some((l) => l.includes(`"what":"${w}"`))), `idea, theme, size and style decisions logged (${decisions.length} decisions)`);
		c.check(log.includes('"k":"project"') && log.includes('"k":"build-end"'), 'the project and its end are logged');
		const shared = readFileSync(join(stateRoot, 'shared', 'local', world, 'bot-cells.jsonl'), 'utf8').trim().split('\n');
		c.check(shared.length === h.stats.placed, `every placed cell is in the shared registry (${shared.length}/${h.stats.placed})`);
	} finally {
		const h = handle as ArchitectHandle | null;
		if (h) await Promise.race([h.stop(), sleep(5000)]);
		(client as BotClient | null)?.close();
		kid?.close();
		await server.stop();
	}
}

// Run alone: `tsx bots/test/e2e-architect.ts`.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	let ok = true;
	const ctx: ArchitectLegCtx = {
		check: (v, what) => {
			console.log(`   ${v ? 'ok  ' : 'FAIL'} ${what}`);
			if (!v) ok = false;
			return v;
		},
		info: (what) => console.log(`   info ${what}`),
	};
	architectLeg(ctx)
		.catch((e: unknown) => {
			ok = false;
			console.error(e);
		})
		.finally(() => {
			removeBuild();
			console.log(ok ? 'PASS architect' : 'FAIL architect');
			process.exit(ok ? 0 : 1);
		});
}
