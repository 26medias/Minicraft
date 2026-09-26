/**
 * The village e2e leg: our own mcserver on a free port, a scripted kid ("Noah") beside a dirt pillar he made, and the
 * real CLI's `village` command run in-process (its client pointed at our server, every engine call failing, so each
 * question falls back). Within 8 minutes the bot must finish ≥ 2 lots and ≥ 1 path, and place nothing on or next to
 * the kid's pillar.
 *
 *   BOTS_E2E_SCRATCH=<scratch> node_modules/.bin/tsx bots/test/e2e-village.ts   (this leg alone)
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BotClient } from 'minicraft-bot';
import { main as cliMain } from '../src/cli.js';
import type { VillageHandle } from '../src/village/village.js';
import type { Vec3 } from '../src/types.js';
import { Kid } from './kid-client.js';
import { removeBuild, scratchRoot, startServer, TOKEN } from './mcserver.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface VillageLegCtx { check(ok: boolean, what: string): boolean; info(what: string): void }

export async function villageLeg(c: VillageLegCtx, budgetMs = 480_000): Promise<void> {
	const server = await startServer();
	if (server.port === 8080 || server.port === 18090) throw new Error(`refusing port ${server.port}`);
	c.info(`mcserver pid ${server.pid} on ${server.url}`);
	const stateRoot = mkdtempSync(join(scratchRoot(), 'village-state-'));
	let kid: Kid | null = null;
	let handle: VillageHandle | null = null;
	let client: BotClient | null = null;
	try {
		const world = await server.createWorld('e2e-village');
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
		await cliMain(['village', '--target', 'local', '--world', world, '--name', 'Mayor', '--brain', 'laya', '--compare'], {
			makeClient: (opts) => new BotClient({ ...opts, url: server.url }),
			stateRoot, env: {}, readFile: () => null, print: (l) => lines.push(l), fetchImpl: failFetch, builderRestMs: 1000,
			onVillage: (h, cl) => {
				handle = h;
				client = cl;
			},
		});
		const h = handle as VillageHandle | null;
		if (!c.check(h !== null, `the CLI started the village bot: ${lines.join(' | ')}`) || !h) return;
		const t0 = Date.now();
		let lastInfo = 0;
		while (Date.now() - t0 < budgetMs && !(h.stats.lotsDone >= 2 && h.stats.pathsDone >= 1)) {
			await sleep(2000);
			if (Date.now() - lastInfo > 30_000) {
				lastInfo = Date.now();
				c.info(`${Math.round((Date.now() - t0) / 1000)} s: ${h.stats.current}; placed ${h.stats.placed}, lots ${h.stats.lotsDone}/${h.stats.lotsAbandoned}, paths ${h.stats.pathsDone}, refused ${h.stats.refused}, failed ${h.stats.failed}`);
			}
		}
		const secs = Math.round((Date.now() - t0) / 1000);
		const v = h.file.village;
		c.info(`village: ${v ? `${v.theme} ${v.layout}, ${v.lots.map((l) => `${l.spec.role} ${l.build.status} ${l.build.placed.length}/${l.build.cells.length}${l.path ? ` path ${l.path.status} ${l.path.placed.length}/${l.path.cells.length}` : ''}${l.lamps ? ` lamps ${l.lamps.placed.length}` : ''}`).join('; ')}` : 'none'}`);
		c.check(h.stats.lotsDone >= 2, `≥ 2 lots finished in ${secs} s (${h.stats.lotsDone} done, ${h.stats.lotsAbandoned} abandoned)`);
		c.check(h.stats.pathsDone >= 1, `≥ 1 path finished (${h.stats.pathsDone})`);
		const cells = Object.keys(h.file.owned).map((k) => k.split(',').map(Number) as [number, number, number]);
		const nearPillar = cells.filter(([x, y, z]) => pillar.some((q) => Math.max(Math.abs(q.x - x), Math.abs(q.y - y), Math.abs(q.z - z)) <= 1));
		c.check(nearPillar.length === 0, `nothing placed on or next to the kid's pillar (${nearPillar.length} of ${cells.length})`);
		c.check(pillar.every((q) => kid!.world.blockName(kid!.world.getBlock(q.x, q.y, q.z)) === 'dirt'), 'the pillar is intact');
		if (v) {
			const near = v.lots.filter((l) => Math.hypot(l.build.origin.x + l.build.w / 2 - px, l.build.origin.z + l.build.d / 2 - pz) < 12);
			c.check(near.length === 0, `every lot ≥ 12 from the kid's pillar (${near.length} closer)`);
		}
		const logDir = join(stateRoot, 'logs', 'local', world);
		const log = readdirSync(logDir).map((f) => readFileSync(join(logDir, f), 'utf8')).join('');
		const decisions = log.split('\n').filter((l) => l.includes('"k":"decision"'));
		c.check(decisions.some((l) => l.includes('"what":"theme"')) && decisions.some((l) => l.includes('"what":"layout"')), `theme and layout decisions logged (${decisions.length} decisions)`);
		const shared = readFileSync(join(stateRoot, 'shared', 'local', world, 'bot-cells.jsonl'), 'utf8').trim().split('\n');
		c.check(shared.length === h.stats.placed, `every placed cell is in the shared registry (${shared.length}/${h.stats.placed})`);
	} finally {
		const h = handle as VillageHandle | null;
		if (h) await Promise.race([h.stop(), sleep(5000)]);
		(client as BotClient | null)?.close();
		kid?.close();
		await server.stop();
	}
}

// Run alone: `tsx bots/test/e2e-village.ts`.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	let ok = true;
	const ctx: VillageLegCtx = {
		check: (v, what) => {
			console.log(`   ${v ? 'ok  ' : 'FAIL'} ${what}`);
			if (!v) ok = false;
			return v;
		},
		info: (what) => console.log(`   info ${what}`),
	};
	villageLeg(ctx)
		.catch((e: unknown) => {
			ok = false;
			console.error(e);
		})
		.finally(() => {
			removeBuild();
			console.log(ok ? 'PASS village' : 'FAIL village');
			process.exit(ok ? 0 : 1);
		});
}
