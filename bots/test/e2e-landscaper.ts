/**
 * The landscaper e2e leg: our own mcserver on a free port, a scripted kid ("Noah") standing still beside a dirt pillar
 * he made 30 blocks from spawn, and the real CLI's `landscaper` command in-process (engines down, so every question
 * falls back; a short mining time and an 8 × 8 area so one Flattening TNT levels it). The bot must mine the
 * ingredients, craft one Flattening TNT by the recipes, blast, and leave the area's heights within ±1; nothing it
 * edited may be within 12 of the pillar, and the pillar stays intact.
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BotClient, worldSpawn } from 'minicraft-bot';
import { main as cliMain } from '../src/cli.js';
import type { LandscaperHandle } from '../src/landscaper/landscaper.js';
import { terrainTop } from '../src/landscaper/blast-plan.js';
import { boardPath, list } from '../src/board/board.js';
import type { WorldView } from '../src/port.js';
import type { Vec3 } from '../src/types.js';
import { Kid } from './kid-client.js';
import { scratchRoot, startServer, TOKEN } from './mcserver.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LandscaperLegCtx { check(ok: boolean, what: string): boolean; info(what: string): void }

export async function landscaperLeg(c: LandscaperLegCtx, budgetMs = 1_500_000): Promise<void> {
	const server = await startServer();
	if (server.port === 8080) throw new Error('refusing 8080');
	c.info(`mcserver pid ${server.pid} on ${server.url}`);
	const stateRoot = mkdtempSync(join(scratchRoot(), 'landscaper-state-'));
	let kid: Kid | null = null;
	let handle: LandscaperHandle | null = null;
	let client: BotClient | null = null;
	try {
		const world = await server.createWorld('e2e-landscaper');
		kid = await Kid.connect({ url: server.url, token: TOKEN, world, name: 'Noah' });
		await sleep(500);
		const sp = worldSpawn(12345, 3);
		// The kid goes 30 blocks west of spawn and builds a pillar beside him.
		const kx = sp.x - 30 + 0.5, kz = sp.z + 0.5;
		const how = await kid.walkTo({ x: kx, z: kz });
		const p = kid.pose();
		c.info(`kid at ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} (${how})`);
		const px = Math.floor(p.x) + 2, pz = Math.floor(p.z);
		const g = kid.world.groundY(px + 0.5, pz + 0.5, p.y + 2) ?? Math.floor(p.y);
		const pillar: Vec3[] = [0, 1, 2, 3].map((i) => ({ x: px, y: g + i, z: pz }));
		for (const cell of pillar) c.check(await kid.place(cell, 'dirt'), `the kid placed his pillar cell ${cell.x},${cell.y},${cell.z}`);
		const lines: string[] = [];
		const failFetch = (async () => {
			throw new Error('engine unavailable (e2e)');
		}) as unknown as typeof fetch;
		await cliMain(['landscaper', '--target', 'local', '--world', world, '--name', 'Dozer', '--brain', 'laya', '--compare', '--max-blasts', '1'], {
			makeClient: (opts) => new BotClient({ ...opts, url: server.url }),
			stateRoot, env: {}, readFile: () => null, print: (l) => lines.push(l), fetchImpl: failFetch,
			landscaperRestMs: 2000, landscaperMineMs: 60, landscaperAreaSize: 8,
			onLandscaper: (h, cl) => {
				handle = h;
				client = cl;
			},
		});
		const h = handle as LandscaperHandle | null;
		if (!c.check(h !== null, `the CLI started the landscaper: ${lines.join(' | ')}`) || !h) return;
		const t0 = Date.now();
		let lastInfo = 0;
		const blasted = () => h.file.blasts.some((b) => !b.dropped && b.removed > 0) && h.file.areas.some((a) => a.status === 'done');
		while (Date.now() - t0 < budgetMs && !blasted() && !h.file.areas.some((a) => a.status === 'abandoned')) {
			await sleep(2000);
			if (Date.now() - lastInfo > 30_000) {
				lastInfo = Date.now();
				c.info(`${Math.round((Date.now() - t0) / 1000)} s: ${h.stats.current}; mined ${h.stats.mined}, crafted ${h.stats.crafted}, blasts ${h.stats.blasts}; inv ${JSON.stringify(h.file.inv)}`);
			}
		}
		const secs = Math.round((Date.now() - t0) / 1000);
		c.info(`areas: ${h.file.areas.map((a) => `${a.x0},${a.z0} ${a.size} L${a.L} ${a.status} ${a.why ?? ''}`).join('; ')}`);
		c.check(h.stats.mined > 0, `it mined its ingredients (${h.stats.mined} blocks)`);
		const crafted = h.file.crafts.flatMap((x) => x.recipes);
		c.check(crafted.includes('flatten_tnt') && crafted.filter((r) => r === 'tnt').length === 2 && crafted.filter((r) => r === 'big_tnt').length === 2, `it crafted one Flattening TNT by the recipes (${crafted.join(', ')})`);
		c.check(blasted(), `a blast went off and the area is done in ${secs} s (blasts ${JSON.stringify(h.file.blasts)})`);
		const area = h.file.areas.find((a) => a.status === 'done');
		if (area) {
			await sleep(1000);
			const tops: number[] = [];
			for (let x = area.x0; x < area.x0 + area.size; x++) for (let z = area.z0; z < area.z0 + area.size; z++) tops.push(terrainTop(kid.world as unknown as WorldView, x, z));
			c.check(Math.max(...tops) - Math.min(...tops) <= 1, `the kid's world shows the area flat within ±1 (tops ${Math.min(...tops)}..${Math.max(...tops)})`);
			const posts = list(boardPath(stateRoot, 'local', world), { type: 'flattened' });
			c.check(posts.length === 1 && posts[0].region?.x0 === area.x0, `a 'flattened' post for the area is on the board (${posts.length})`);
		}
		const edits = (client as BotClient | null)?.journal() ?? [];
		const near = edits.filter((e) => pillar.some((q) => Math.hypot(q.x - e.x, q.y - e.y, q.z - e.z) <= 12));
		c.check(edits.length > 0 && near.length === 0, `no edit within 12 of the kid's pillar (${edits.length} edits, ${near.length} near)`);
		c.check(pillar.every((q) => kid!.world.blockName(kid!.world.getBlock(q.x, q.y, q.z)) === 'dirt'), 'the pillar is intact');
		const logDir = join(stateRoot, 'logs', 'local', world);
		const log = readdirSync(logDir).map((f) => readFileSync(join(logDir, f), 'utf8')).join('');
		c.check(log.includes('"k":"prime"') && log.includes('"k":"blast"'), 'the log records the prime and the blast');
	} finally {
		const h = handle as LandscaperHandle | null;
		if (h) await Promise.race([h.stop(), sleep(5000)]);
		(client as BotClient | null)?.close();
		kid?.close();
		await server.stop();
	}
}
