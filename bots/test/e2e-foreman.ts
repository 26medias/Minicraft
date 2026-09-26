/**
 * The foreman e2e leg (experiment E7): our own mcserver on a free port, a scripted kid ("Noah") beside a dirt pillar
 * he made, the real CLI's `foreman` command run in-process, and once its plan is written a `builder --join-plan`
 * (every engine call failing, so each question falls back). Within 8 minutes the foreman must finish the roads and
 * ≥ 1 lot must be built by the builder, on the lot it claimed; nothing on or next to the kid's pillar.
 *
 *   BOTS_E2E_SCRATCH=<scratch> node_modules/.bin/tsx bots/test/e2e-foreman.ts   (this leg alone)
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BotClient } from 'minicraft-bot';
import { main as cliMain } from '../src/cli.js';
import type { BuilderHandle } from '../src/builder/builder.js';
import type { ForemanHandle } from '../src/foreman/foreman.js';
import { planFilePath, readPlan } from '../src/foreman/plan-file.js';
import type { Vec3 } from '../src/types.js';
import { Kid } from './kid-client.js';
import { removeBuild, scratchRoot, startServer, TOKEN } from './mcserver.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ForemanLegCtx { check(ok: boolean, what: string): boolean; info(what: string): void }

export async function foremanLeg(c: ForemanLegCtx, budgetMs = 480_000): Promise<void> {
	const server = await startServer();
	if (server.port === 8080 || server.port === 18090) throw new Error(`refusing port ${server.port}`);
	c.info(`mcserver pid ${server.pid} on ${server.url}`);
	const stateRoot = mkdtempSync(join(scratchRoot(), 'foreman-state-'));
	let kid: Kid | null = null;
	let fh: ForemanHandle | null = null;
	let bh: BuilderHandle | null = null;
	const clients: BotClient[] = [];
	try {
		const world = await server.createWorld('e2e-foreman');
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
		const deps = {
			makeClient: (opts: ConstructorParameters<typeof BotClient>[0]) => new BotClient({ ...opts, url: server.url }),
			stateRoot, env: {}, readFile: () => null, print: (l: string) => lines.push(l), fetchImpl: failFetch, builderRestMs: 1000,
		};
		await cliMain(['foreman', '--target', 'local', '--world', world, '--name', 'Boss'], {
			...deps,
			onForeman: (h, cl) => {
				fh = h;
				clients.push(cl);
			},
		});
		const f = fh as ForemanHandle | null;
		if (!c.check(f !== null, `the CLI started the foreman: ${lines.join(' | ')}`) || !f) return;
		const t0 = Date.now();
		const planPath = planFilePath(stateRoot, 'local', world);
		while (Date.now() - t0 < 60_000 && !existsSync(planPath)) await sleep(500);
		const plan0 = readPlan(planPath);
		if (!c.check(plan0 !== null, `the foreman wrote its plan in ${Math.round((Date.now() - t0) / 1000)} s (${f.stats.current})`) || !plan0) return;
		c.info(`plan: ${plan0.lots.length} lots at ${plan0.corner.x},${plan0.corner.z}, ${plan0.roads.length} road cells, ${plan0.lamps.length / 2} lamps`);
		c.check(plan0.lots.length >= 4 && plan0.lots.length <= 10, `4–10 lots (${plan0.lots.length})`);
		await cliMain(['builder', '--target', 'local', '--world', world, '--name', 'Robo', '--brain', 'laya', '--join-plan'], {
			...deps,
			onBuilder: (h, cl) => {
				bh = h;
				clients.push(cl);
			},
		});
		const b = bh as BuilderHandle | null;
		if (!c.check(b !== null, `the CLI started the builder --join-plan: ${lines.join(' | ')}`) || !b) return;
		const built = () => (readPlan(planPath)?.lots ?? []).filter((l) => l.status === 'built');
		let lastInfo = 0;
		while (Date.now() - t0 < budgetMs && !(f.stats.roadsDone && built().length >= 1)) {
			await sleep(2000);
			if (Date.now() - lastInfo > 30_000) {
				lastInfo = Date.now();
				c.info(`${Math.round((Date.now() - t0) / 1000)} s: foreman ${f.stats.current}, placed ${f.stats.placed}; builder ${b.stats.current}, placed ${b.stats.placed}`);
			}
		}
		const secs = Math.round((Date.now() - t0) / 1000);
		const plan = readPlan(planPath)!;
		c.info(`lots: ${plan.lots.map((l) => `${l.id} ${l.status}${l.claimedBy ? ` by ${l.claimedBy}` : ''}${l.design ? ` (${l.design})` : ''}${l.why ? ` [${l.why}]` : ''}`).join('; ')}`);
		c.check(f.stats.roadsDone, `the foreman finished the roads in ${secs} s (${f.file.roads.placed.length} placed, ${f.file.roads.skipped.length} skipped of ${plan.roads.length})`);
		c.check(f.file.roads.placed.length >= plan.roads.length * 0.8, `≥ 80% of the road cells placed (${f.file.roads.placed.length}/${plan.roads.length})`);
		const onRoad = plan.roads.filter((r) => kid!.world.blockName(kid!.world.getBlock(r.cell.x, r.cell.y, r.cell.z)) === r.block).length;
		c.check(onRoad >= plan.roads.length * 0.8, `the kid's world shows the road blocks (${onRoad}/${plan.roads.length})`);
		const lots = built();
		c.check(lots.length >= 1, `≥ 1 lot built (${lots.length})`);
		const joined = b.file.builds.filter((x) => x.lot && x.status === 'done');
		c.check(joined.length >= 1, `the builder finished a build on a claimed lot (${joined.map((x) => `${x.template} on ${x.lot}`).join(', ') || 'none'})`);
		for (const x of joined) {
			const l = plan.lots.find((q) => q.id === x.lot)!;
			const inside = x.origin.x >= l.origin.x && x.origin.x + x.w <= l.origin.x + l.w && x.origin.z >= l.origin.z && x.origin.z + x.d <= l.origin.z + l.d;
			c.check(inside && l.claimedBy === 'Robo' && l.status === 'built', `${x.template} stands inside ${l.id}, which is Robo's and built`);
		}
		const cells = [...Object.keys(f.file.owned), ...Object.keys(b.file.owned)].map((k) => k.split(',').map(Number) as [number, number, number]);
		const nearPillar = cells.filter(([x, y, z]) => pillar.some((q) => Math.max(Math.abs(q.x - x), Math.abs(q.y - y), Math.abs(q.z - z)) <= 1));
		c.check(nearPillar.length === 0, `nothing placed on or next to the kid's pillar (${nearPillar.length} of ${cells.length})`);
		c.check(pillar.every((q) => kid!.world.blockName(kid!.world.getBlock(q.x, q.y, q.z)) === 'dirt'), 'the pillar is intact');
		const close = plan.lots.filter((l) => Math.hypot(l.origin.x + l.w / 2 - px, l.origin.z + l.d / 2 - pz) < 12);
		c.check(close.length === 0, `every lot ≥ 12 from the kid's pillar (${close.length} closer)`);
	} finally {
		const f = fh as ForemanHandle | null;
		const b = bh as BuilderHandle | null;
		await Promise.all([f ? Promise.race([f.stop(), sleep(5000)]) : null, b ? Promise.race([b.stop(), sleep(5000)]) : null]);
		for (const cl of clients) cl.close();
		kid?.close();
		await server.stop();
	}
}

// Run alone: `tsx bots/test/e2e-foreman.ts`.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	let ok = true;
	const ctx: ForemanLegCtx = {
		check: (v, what) => {
			console.log(`   ${v ? 'ok  ' : 'FAIL'} ${what}`);
			if (!v) ok = false;
			return v;
		},
		info: (what) => console.log(`   info ${what}`),
	};
	foremanLeg(ctx)
		.catch((e: unknown) => {
			ok = false;
			console.error(e);
		})
		.finally(() => {
			removeBuild();
			console.log(ok ? 'PASS foreman' : 'FAIL foreman');
			process.exit(ok ? 0 : 1);
		});
}
