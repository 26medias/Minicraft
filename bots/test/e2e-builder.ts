/**
 * The builder e2e leg: our own mcserver on a free port, a scripted kid ("Noah") who stands still beside a dirt pillar
 * he made, and the real CLI's `builder` command run in-process (its client pointed at our server, every engine call
 * failing, so each question falls back). Within 5 minutes the bot must finish at least one build of ≥ 20 placed
 * cells, and place nothing on or next to the kid's pillar.
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BotClient } from 'minicraft-bot';
import { main as cliMain } from '../src/cli.js';
import type { BuilderHandle } from '../src/builder/builder.js';
import type { Vec3 } from '../src/types.js';
import { Kid } from './kid-client.js';
import { scratchRoot, startServer, TOKEN } from './mcserver.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BuilderLegCtx { check(ok: boolean, what: string): boolean; info(what: string): void }

export async function builderLeg(c: BuilderLegCtx, budgetMs = 300_000): Promise<void> {
	const server = await startServer();
	if (server.port === 8080) throw new Error('refusing 8080');
	c.info(`mcserver pid ${server.pid} on ${server.url}`);
	const stateRoot = mkdtempSync(join(scratchRoot(), 'builder-state-'));
	let kid: Kid | null = null;
	let handle: BuilderHandle | null = null;
	let client: BotClient | null = null;
	try {
		const world = await server.createWorld('e2e-builder');
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
		await cliMain(['builder', '--target', 'local', '--world', world, '--name', 'Robo', '--brain', 'laya', '--compare'], {
			makeClient: (opts) => new BotClient({ ...opts, url: server.url }),
			stateRoot, env: {}, readFile: () => null, print: (l) => lines.push(l), fetchImpl: failFetch, builderRestMs: 2000,
			onBuilder: (h, cl) => {
				handle = h;
				client = cl;
			},
		});
		const h = handle as BuilderHandle | null;
		if (!c.check(h !== null, `the CLI started the builder: ${lines.join(' | ')}`) || !h) return;
		const t0 = Date.now();
		let lastInfo = 0;
		const bigDone = () => h.file.builds.some((b) => b.status === 'done' && b.placed.length >= 20);
		while (Date.now() - t0 < budgetMs && !bigDone()) {
			await sleep(2000);
			if (Date.now() - lastInfo > 30_000) {
				lastInfo = Date.now();
				c.info(`${Math.round((Date.now() - t0) / 1000)} s: ${h.stats.current}; placed ${h.stats.placed}, done ${h.stats.buildsDone}, abandoned ${h.stats.buildsAbandoned}`);
			}
		}
		const secs = Math.round((Date.now() - t0) / 1000);
		c.check(bigDone(), `a build of ≥ 20 cells finished in ${secs} s (placed ${h.stats.placed}, done ${h.stats.buildsDone}, abandoned ${h.stats.buildsAbandoned})`);
		const placed = h.file.builds.flatMap((b) => b.placed.map((k) => k.split(',').map(Number) as [number, number, number]));
		const nearPillar = placed.filter(([x, y, z]) => pillar.some((q) => Math.max(Math.abs(q.x - x), Math.abs(q.y - y), Math.abs(q.z - z)) <= 1));
		c.check(nearPillar.length === 0, `nothing placed on or next to the kid's pillar (${nearPillar.length})`);
		c.check(pillar.every((q) => kid!.world.blockName(kid!.world.getBlock(q.x, q.y, q.z)) === 'dirt'), 'the pillar is intact');
		const minDist = Math.min(...placed.map(([x, , z]) => Math.hypot(x - px, z - pz)));
		c.info(`closest placement to the pillar: ${minDist.toFixed(1)} blocks; builds ${h.file.builds.map((b) => `${b.variant} ${b.template} (${b.palette}) ${b.status} ${b.placed.length}/${b.cells.length}`).join('; ')}`);
		const seen = placed.filter(([x, y, z]) => kid!.world.getBlock(x, y, z) !== 0).length;
		c.check(seen === placed.length, `the kid's world shows every placed block (${seen}/${placed.length})`);
		const logDir = join(stateRoot, 'logs', 'local', world);
		const log = readdirSync(logDir).map((f) => readFileSync(join(logDir, f), 'utf8')).join('');
		const decisions = log.split('\n').filter((l) => l.includes('"k":"decision"'));
		c.check(decisions.length > 0 && decisions.every((l) => l.includes('"fallback":true')), `decisions logged, all fallbacks with the engines down (${decisions.length})`);
		const stateFile = readFileSync(join(stateRoot, 'builder', 'local', world, 'Robo.json'), 'utf8');
		c.check(JSON.parse(stateFile).builds.length >= 1, 'the builder state file holds its builds');
	} finally {
		const h = handle as BuilderHandle | null;
		if (h) await Promise.race([h.stop(), sleep(5000)]);
		(client as BotClient | null)?.close();
		kid?.close();
		await server.stop();
	}
}
