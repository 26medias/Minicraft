/**
 * The navigation e2e leg: our own mcserver on a free port, a hilly world, the scripted kid ("Noah") put down on the far
 * side of a ridge from world spawn (where the builder joins), facing away from it, and the real CLI's `builder` run
 * in-process (every engine call failing, so each question falls back). Within 5 minutes the builder must finish a
 * build of ≥ 20 cells near the kid — across the ridge — and its stuck watchdog must never reach level 2 (a bot stuck
 * for 30 s).
 *
 *   BOTS_E2E_SCRATCH=<scratch> node_modules/.bin/tsx bots/test/e2e-nav.ts   (this leg alone)
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BotClient, worldSpawn } from 'minicraft-bot';
import { main as cliMain } from '../src/cli.js';
import type { BuilderHandle } from '../src/builder/builder.js';
import { generatedLookup } from '../src/port.js';
import { Kid } from './kid-client.js';
import { removeBuild, scratchRoot, startServer, TOKEN } from './mcserver.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GEN = 3;

/** The top solid-ish (non-air) block's y in a generated column. */
function topOf(look: (x: number, y: number, z: number) => number, x: number, z: number): number {
	for (let y = 250; y >= 0; y--) if (look(x, y, z) !== 0) return y;
	return -1;
}

/**
 * A seed and a kid spot 40–60 from world spawn whose straight route crosses a ridge at least 12 above both ends (no
 * straight walk), the best such ridge over seeds 1…40.
 */
export function hillyCase(): { seed: number; spawn: { x: number; z: number }; kid: { x: number; z: number }; ridge: number } {
	let best: { seed: number; spawn: { x: number; z: number }; kid: { x: number; z: number }; ridge: number } | null = null;
	for (let seed = 1; seed <= 40; seed++) {
		const look = generatedLookup(seed, GEN);
		const s = worldSpawn(seed, GEN);
		const s0 = topOf(look, s.x, s.z);
		for (let a = 0; a < 16; a++) {
			const ang = (a / 16) * Math.PI * 2;
			const d = 50;
			const k = { x: Math.round(s.x + Math.cos(ang) * d), z: Math.round(s.z + Math.sin(ang) * d) };
			if (k.x < 20 || k.z < 20 || k.x > 490 || k.z > 490) continue;
			const k0 = topOf(look, k.x, k.z);
			if (k0 < 0 || Math.abs(k0 - s0) > 6) continue;
			let top = -1;
			for (let i = 1; i < d; i++) top = Math.max(top, topOf(look, Math.round(s.x + Math.cos(ang) * i), Math.round(s.z + Math.sin(ang) * i)));
			const ridge = top - Math.max(s0, k0);
			if (ridge >= 12 && (!best || ridge > best.ridge)) best = { seed, spawn: s, kid: k, ridge };
		}
		if (best && best.ridge >= 20) break;
	}
	if (!best) throw new Error('no hilly case in seeds 1…40');
	return best;
}

export interface NavLegCtx { check(ok: boolean, what: string): boolean; info(what: string): void }

export async function navLeg(c: NavLegCtx, budgetMs = 300_000): Promise<void> {
	const hc = hillyCase();
	c.info(`seed ${hc.seed}: spawn ${hc.spawn.x},${hc.spawn.z} → kid ${hc.kid.x},${hc.kid.z}, a ridge ${hc.ridge} above both ends`);
	const server = await startServer();
	if (server.port === 8080 || server.port === 18090) throw new Error(`refusing port ${server.port}`);
	c.info(`mcserver pid ${server.pid} on ${server.url}`);
	const stateRoot = mkdtempSync(join(scratchRoot(), 'nav-state-'));
	let kid: Kid | null = null;
	let handle: BuilderHandle | null = null;
	let client: BotClient | null = null;
	try {
		const world = await server.createWorld(`e2e-nav-${hc.seed}`, hc.seed, GEN);
		kid = await Kid.connect({ url: server.url, token: TOKEN, world, name: 'Noah' });
		await sleep(500);
		// The fresh world is the generated one: the kid's feet go on top of the generated column (his own chunks may not
		// have loaded that far yet).
		const g = topOf(generatedLookup(hc.seed, GEN), hc.kid.x, hc.kid.z) + 1;
		// Facing away from spawn: his showtime band lies further across the ridge.
		const yaw = Math.atan2(hc.spawn.x - hc.kid.x, hc.spawn.z - hc.kid.z);
		kid.client.move({ x: hc.kid.x + 0.5, y: g, z: hc.kid.z + 0.5, yaw, pitch: 0 });
		await sleep(500);
		const lines: string[] = [];
		const failFetch = (async () => {
			throw new Error('engine unavailable (e2e)');
		}) as unknown as typeof fetch;
		await cliMain(['builder', '--target', 'local', '--world', world, '--name', 'Robo', '--brain', 'laya'], {
			makeClient: (opts) => new BotClient({ ...opts, url: server.url }),
			stateRoot, env: {}, readFile: () => null, print: (l) => lines.push(l), fetchImpl: failFetch, builderRestMs: 2000,
			onBuilder: (h, cl) => {
				handle = h;
				client = cl;
				// A new player joins beside the one online: put the builder back at world spawn, across the ridge.
				cl.move({ x: hc.spawn.x + 0.5, y: topOf(generatedLookup(hc.seed, GEN), hc.spawn.x, hc.spawn.z) + 1, z: hc.spawn.z + 0.5, yaw: 0, pitch: 0 });
			},
		});
		const h = handle as BuilderHandle | null;
		if (!c.check(h !== null, `the CLI started the builder: ${lines.join(' | ')}`) || !h) return;
		const cl = client as BotClient | null;
		const start = cl!.pose();
		c.info(`the builder joined at ${start.x.toFixed(1)},${start.y.toFixed(1)},${start.z.toFixed(1)}`);
		const t0 = Date.now();
		let lastInfo = 0;
		const bigDone = () => h.file.builds.some((b) => b.status === 'done' && b.placed.length >= 20);
		while (Date.now() - t0 < budgetMs && !bigDone()) {
			await sleep(2000);
			if (Date.now() - lastInfo > 30_000) {
				lastInfo = Date.now();
				const p = cl!.pose();
				c.info(`${Math.round((Date.now() - t0) / 1000)} s: ${h.stats.current}; at ${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}; placed ${h.stats.placed}, done ${h.stats.buildsDone}, abandoned ${h.stats.buildsAbandoned}`);
			}
		}
		const secs = Math.round((Date.now() - t0) / 1000);
		const done = h.file.builds.find((b) => b.status === 'done' && b.placed.length >= 20);
		c.check(!!done, `a build of ≥ 20 cells finished in ${secs} s (placed ${h.stats.placed}, done ${h.stats.buildsDone}, abandoned ${h.stats.buildsAbandoned})`);
		if (done) {
			const fromSpawn = Math.hypot(done.origin.x - hc.spawn.x, done.origin.z - hc.spawn.z);
			const fromKid = Math.hypot(done.origin.x - hc.kid.x, done.origin.z - hc.kid.z);
			c.info(`the build: ${done.variant} ${done.template} at ${done.origin.x},${done.origin.y},${done.origin.z} — ${fromSpawn.toFixed(0)} from spawn, ${fromKid.toFixed(0)} from the kid`);
			c.check(fromKid < fromSpawn, 'the build stands on the kid\'s side of the ridge');
		}
		const logDir = join(stateRoot, 'logs', 'local', world);
		const log = readdirSync(logDir).map((f) => readFileSync(join(logDir, f), 'utf8')).join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
		const count = (k: string) => log.filter((e) => e.k === k).length;
		const unsticks = log.filter((e) => e.k === 'unstick');
		c.info(`moves: walk-fly ${count('walk-fly')}, fly-high ${count('fly-high')}, nav-failed ${count('nav-failed')}, unreachable ${count('unreachable')}, unstick ${unsticks.map((e) => e.level).join(',') || 'none'}`);
		c.check(!unsticks.some((e) => typeof e.level === 'number' && e.level >= 2), 'never stuck 30 s (no unstick level ≥ 2)');
	} finally {
		const h = handle as BuilderHandle | null;
		if (h) await Promise.race([h.stop(), sleep(5000)]);
		(client as BotClient | null)?.close();
		kid?.close();
		await server.stop();
	}
}

// Run alone: `tsx bots/test/e2e-nav.ts`.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	let ok = true;
	const ctx: NavLegCtx = {
		check: (v, what) => {
			console.log(`   ${v ? 'ok  ' : 'FAIL'} ${what}`);
			if (!v) ok = false;
			return v;
		},
		info: (what) => console.log(`   info ${what}`),
	};
	navLeg(ctx)
		.catch((e: unknown) => {
			ok = false;
			console.error(e);
		})
		.finally(() => {
			removeBuild();
			console.log(ok ? 'PASS nav' : 'FAIL nav');
			process.exit(ok ? 0 : 1);
		});
}
