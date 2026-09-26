/**
 * The companion e2e (plan Task 7): a real `mcserver` of our own, a scripted non-bot "kid" (a
 * `BotClient` whose hello has no `bot` flag), and the companion running in this process over
 * `realPort`. Each leg gets a fresh world (seed 12345, gen 3 — the fake port's world).
 *
 *   BOTS_E2E_SCRATCH=<your scratch dir> npm run bots:e2e
 *   BOTS_E2E_SCRATCH=<your scratch dir> npm --prefix bots run e2e -- --only companion,idle,laya,cli
 *
 * Legs:
 * - `companion` (scripted brain): parity checks, then the kid script, then assertions (a)–(e), the
 *   target rotation and the staircase/wall stretch.
 * - `idle`: the same script with a bot that connects and never acts; it must FAIL (a).
 * - `laya`: the same script with the real Laya brain, only when its `health()` passes (this script
 *   never starts Laya): ≥ 80% brain answers on the kid-present, no-rule ticks; (c), (c2), (d) hold.
 * - `cli`: the real CLI (`npx tsx src/cli.ts --target local …`) on its own server on the `local`
 *   target's port (18090): after SIGINT the process group exits by itself within 5 s, and
 *   `--revert-on-exit` removed its block.
 * - `brain2-help`, `brain2-alone`, `brain2-mine`, `brain2-revert`, `brain2-follow-watch`, `brain2-cli`, `brain2-productive`: brain v2,
 *   code engines only (Task 17b), on one server on the `local` port; see `e2e-brain2.ts`.
 * - `builder`: the builder bot's CLI in-process on its own free-port server; see `e2e-builder.ts`.
 * - `decorator`: the decorator bot's CLI in-process on its own free-port server; see `e2e-decorator.ts`.
 * - `helper`: the helper bot's CLI in-process on its own free-port server; see `e2e-helper.ts`.
 * - `architect`: the architect bot's CLI in-process on its own free-port server; see `e2e-architect.ts`.
 *
 * Safety: never port 8080, never `~/minicraft-mp`, never the live URL. Servers are ours, stopped by
 * PID with SIGTERM. Every temp dir is under BOTS_E2E_SCRATCH, and only those are removed.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BotClient, blockId, isLiquidId, isSolidId } from 'minicraft-bot';
import type { EditOut, Pose, WorldListing } from 'minicraft-bot';
import botsConfig from '../bots.config.js';
import type { Brain } from '../src/brain/brain.js';
import { SystemOneBrain } from '../src/brain/systemone.js';
import { runCompanion, seededRng } from '../src/bots/companion.js';
import type { CompanionHandle } from '../src/bots/companion.js';
import { jsonlLogger } from '../src/body/log.js';
import { realPort } from '../src/port.js';
import type { WorldView } from '../src/port.js';
import type { Vec3 } from '../src/types.js';
import { FakeWorld } from './fake-port.js';
import { Kid } from './kid-client.js';
import { removeBuild, scratchRoot, startServer, TOKEN } from './mcserver.js';
import { brain2CliLeg, brain2Legs, brain2ProductiveLeg } from './e2e-brain2.js';
import type { McServer } from './mcserver.js';
import { builderLeg } from './e2e-builder.js';
import { decoratorLeg } from './e2e-decorator.js';
import { villageLeg } from './e2e-village.js';
import { helperLeg } from './e2e-helper.js';
import { architectLeg } from './e2e-architect.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SCRATCH = scratchRoot();
const BOTS_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const TUNING = botsConfig.companion;
const FD = TUNING.followDist;
const LOCAL_PORT = Number(new URL(botsConfig.targets.local.url).port);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const onlyArg = (() => {
	const i = process.argv.indexOf('--only');
	return i >= 0 ? new Set(process.argv[i + 1].split(',').map((s) => s.trim().toLowerCase())) : null;
})();
const want = (id: string) => onlyArg === null || onlyArg.has(id);

// ---------------------------------------------------------------------------------------------
// Reporting

interface LegResult {
	id: string;
	ok: boolean;
	notes: string[];
}
const results: LegResult[] = [];
let current: LegResult | null = null;

function check(ok: boolean, what: string): boolean {
	console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${what}`);
	if (current) {
		current.notes.push(`${ok ? 'ok' : 'FAIL'} ${what}`);
		if (!ok) current.ok = false;
	}
	return ok;
}

function info(what: string): void {
	console.log(`   info ${what}`);
	current?.notes.push(`info ${what}`);
}

async function leg(id: string, title: string, body: () => Promise<void>): Promise<void> {
	console.log(`\n== ${id}: ${title}`);
	current = { id, ok: true, notes: [] };
	const t0 = Date.now();
	try {
		await body();
	} catch (e) {
		check(false, `threw: ${(e as Error).stack ?? e}`);
	}
	console.log(`${current.ok ? 'PASS' : 'FAIL'} ${id} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
	results.push(current);
	current = null;
}

const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);

// ---------------------------------------------------------------------------------------------
// Independent kid geometry (NOT guard.ts: a mutation there must not also change the oracle)

const KID_HALF = 0.3;
const KID_H = 1.8;
const BUFFER = 1;

function inKidBody(c: Vec3, k: Vec3): boolean {
	return c.x < k.x + KID_HALF && c.x + 1 > k.x - KID_HALF && c.z < k.z + KID_HALF && c.z + 1 > k.z - KID_HALF && c.y < k.y + KID_H && c.y + 1 > k.y;
}

function inKidBuffer(c: Vec3, k: Vec3): boolean {
	const x0 = Math.floor(k.x - KID_HALF), x1 = Math.ceil(k.x + KID_HALF) - 1;
	const z0 = Math.floor(k.z - KID_HALF), z1 = Math.ceil(k.z + KID_HALF) - 1;
	return c.x >= x0 - BUFFER && c.x <= x1 + BUFFER && c.z >= z0 - BUFFER && c.z <= z1 + BUFFER;
}

const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const sameCell = (a: Vec3, b: Vec3) => a.x === b.x && a.y === b.y && a.z === b.z;
const cellStr = (c: Vec3) => `${c.x},${c.y},${c.z}`;

function id(name: string): number {
	const v = blockId(name);
	if (v === null) throw new Error(`unknown block ${name}`);
	return v;
}

// ---------------------------------------------------------------------------------------------
// The site: flat 13 × 13 around the kid's column, plus a walkable course strip along +u

interface Site {
	/** The kid's column. */
	sx: number;
	sz: number;
	/** The kid's feet y (ground top is g − 1). */
	g: number;
	/** The u axis (horizontal unit); v = (−uz, ux). */
	ux: number;
	uz: number;
}

/** Local (a along u, b along v) → the world cell/point. */
function L(s: Site, a: number, b: number, y: number): Vec3 {
	const vx = -s.uz, vz = s.ux;
	return { x: s.sx + a * s.ux + b * vx, y, z: s.sz + a * s.uz + b * vz };
}

/** The centre of local cell (a, b), at height y. */
function Lp(s: Site, a: number, b: number, y: number): Vec3 {
	const c = L(s, a, b, y);
	return { x: c.x + 0.5, y, z: c.z + 0.5 };
}

const DIRS: [number, number][] = [
	[1, 0],
	[-1, 0],
	[0, 1],
	[0, -1],
];

interface SurfaceWorld {
	surfaceY(x: number, z: number): number;
	getBlock(x: number, y: number, z: number): number;
}

function siteOk(w: SurfaceWorld, s: Site): boolean {
	const inWorld = (c: Vec3) => c.x >= 3 && c.x <= 508 && c.z >= 3 && c.z <= 508;
	for (const [a, b] of [
		[-10, -7],
		[-10, 7],
		[27, -7],
		[27, 7],
	]) {
		if (!inWorld(L(s, a, b, 0))) return false;
	}
	for (let a = 6; a <= 26; a++) {
		for (let b = -5; b <= 1; b++) {
			const c = L(s, a, b, 0);
			const top = w.surfaceY(c.x, c.z);
			if (Math.abs(top - (s.g - 1)) > 1) return false;
			if (w.getBlock(c.x, top + 1, c.z) !== 0 || w.getBlock(c.x, top + 2, c.z) !== 0) return false;
		}
	}
	return true;
}

function squareFlat(w: SurfaceWorld, cx: number, cz: number): number | null {
	const g = w.surfaceY(cx, cz) + 1;
	if (g <= 1) return null;
	for (let dx = -6; dx <= 6; dx++) {
		for (let dz = -6; dz <= 6; dz++) {
			if (w.surfaceY(cx + dx, cz + dz) !== g - 1) return null;
			if (w.getBlock(cx + dx, g, cz + dz) !== 0 || w.getBlock(cx + dx, g + 1, cz + dz) !== 0) return null;
		}
	}
	return g;
}

async function findSite(w: SurfaceWorld, from: Vec3, minDist: number): Promise<Site> {
	for (let r = minDist; r <= 110; r += 2) {
		const steps = Math.max(8, Math.round((2 * Math.PI * r) / 4));
		for (let i = 0; i < steps; i++) {
			const ang = (2 * Math.PI * i) / steps;
			const sx = Math.floor(from.x + r * Math.cos(ang));
			const sz = Math.floor(from.z + r * Math.sin(ang));
			if (sx < 12 || sz < 12 || sx > 500 || sz > 500) continue;
			const g = squareFlat(w, sx, sz);
			if (g === null) continue;
			// Prefer u pointing away from the spawn: the kid approaches along +u, the bot trails at −u.
			const dirs = [...DIRS].sort((p, q) => p[0] * (from.x - sx) + p[1] * (from.z - sz) - (q[0] * (from.x - sx) + q[1] * (from.z - sz)));
			for (const [ux, uz] of dirs) {
				const s: Site = { sx, sz, g, ux, uz };
				if (siteOk(w, s)) return s;
			}
		}
		await sleep(0); // chunk generation is synchronous: let the sockets breathe
	}
	throw new Error('no flat site found within 110 blocks');
}

// ---------------------------------------------------------------------------------------------
// Parity: realPort's WorldView vs the fake WorldView, before any edit

function parity(real: WorldView, around: Vec3): void {
	const fake = new FakeWorld();
	const rng = seededRng(424242);
	const cx = Math.floor(around.x), cz = Math.floor(around.z);
	const surf = (x: number, z: number) => fake.surfaceY(x, z);

	// The generated chunks: every cell of a 32 × 40 × 32 box around the kid, and the ids seen.
	const seen = new Set<number>();
	let cellMismatch = 0;
	const y0 = Math.max(0, surf(cx, cz) - 20);
	for (let x = cx - 16; x < cx + 16; x++) {
		for (let z = cz - 16; z < cz + 16; z++) {
			for (let y = y0; y < y0 + 40; y++) {
				const a = real.getBlock(x, y, z);
				seen.add(a);
				if (a !== fake.getBlock(x, y, z)) cellMismatch++;
			}
		}
	}
	check(cellMismatch === 0, `parity: getBlock real = fake on 40 960 cells (${cellMismatch} differ)`);

	let idBad = 0;
	for (const v of seen) {
		if (isSolidId(v) !== real.isSolid(v) || fake.isSolid(v) !== real.isSolid(v)) idBad++;
		if (isLiquidId(v) !== real.isLiquid(v) || fake.isLiquid(v) !== real.isLiquid(v)) idBad++;
	}
	check(idBad === 0 && seen.size > 1, `parity: isSolidId/isLiquidId = world.isSolid/isLiquid on the ${seen.size} ids seen (${idBad} differ)`);

	let rayBad = 0, rayHits = 0;
	for (let i = 0; i < 20; i++) {
		const ox = cx - 12 + rng() * 24, oz = cz - 12 + rng() * 24;
		const oy = surf(Math.floor(ox), Math.floor(oz)) + 0.5 + rng() * 8;
		const th = rng() * Math.PI * 2, ph = -Math.PI / 2 + rng() * Math.PI * 0.8;
		const dir: [number, number, number] = [Math.cos(ph) * Math.cos(th), Math.sin(ph), Math.cos(ph) * Math.sin(th)];
		const a = real.raycast([ox, oy, oz], dir, 20);
		const b = fake.raycast([ox, oy, oz], dir, 20);
		if (a) rayHits++;
		const same = a === null ? b === null : b !== null && a.x === b.x && a.y === b.y && a.z === b.z && a.face === b.face && Math.abs(a.distance - b.distance) < 1e-9;
		if (!same) {
			rayBad++;
			info(`ray ${i}: real ${JSON.stringify(a)} fake ${JSON.stringify(b)}`);
		}
	}
	check(rayBad === 0 && rayHits >= 5, `parity: raycast real = fake on 20 random rays (${rayHits} hit, ${rayBad} differ)`);

	let gBad = 0;
	for (let i = 0; i < 20; i++) {
		const x = cx - 16 + Math.floor(rng() * 32), z = cz - 16 + Math.floor(rng() * 32);
		const nearY = surf(x, z) + Math.floor(rng() * 12) - 3;
		const a = real.groundY(x + 0.3, z + 0.7, nearY + 0.4);
		const b = fake.groundY(x + 0.3, z + 0.7, nearY + 0.4);
		if (a !== b) {
			gBad++;
			info(`groundY ${x},${z} near ${nearY}: real ${a} fake ${b}`);
		}
	}
	check(gBad === 0, `parity: groundY real = fake on 20 columns (${gBad} differ)`);
}

// ---------------------------------------------------------------------------------------------
// One leg of the kid script

type Mode = 'companion' | 'idle' | 'laya';

interface Sample {
	t: number;
	phase: string;
	kid: Pose;
	bot: Vec3 | null;
}

interface BotEdit {
	t: number;
	cell: Vec3;
	id: number;
	kids: Vec3[];
}

async function runLeg(server: McServer, mode: Mode, brain: Brain | null, runDir: string): Promise<void> {
	const world = await server.createWorld(`e2e-${mode}`);
	const kid = await Kid.connect({ url: server.url, token: TOKEN, world, name: 'Kid', skin: 'jj' });
	const spawn = kid.pose();
	info(`world ${world}; kid spawn ${spawn.x.toFixed(1)},${spawn.y.toFixed(1)},${spawn.z.toFixed(1)}`);
	const site = await findSite(kid.world, spawn, 25);
	info(`site ${site.sx},${site.g},${site.sz} u=(${site.ux},${site.uz}), ${Math.hypot(site.sx - spawn.x, site.sz - spawn.z).toFixed(0)} blocks away`);

	// The companion (or the idle bot) connects while the kid is still at spawn.
	const botName = mode === 'idle' ? 'IdleBot' : 'Robo';
	const bot = new BotClient({ url: server.url, token: TOKEN, statePath: join(runDir, `${mode}-bot.json`) });
	const listing: WorldListing = (await bot.listWorlds()).find((w) => w.uuid === world)!;
	await bot.connect({ world, name: botName, skin: 'enderman' });
	const port = realPort(bot, listing);
	info(`bot spawned ${dist3(bot.pose(), kid.pose()).toFixed(1)} from the kid`);

	parity(port.world, kid.pose());

	// The course (stairs, platform, wall), built by a bot-flagged builder far from the kid and the bot.
	const planks = 'oak_planks';
	{
		const builder = new BotClient({ url: server.url, token: TOKEN, editGapMs: 25 });
		await builder.connect({ world, name: 'Builder', skin: 'chip' });
		const heights: [number, number][] = [
			[2, 1],
			[3, 2],
			[4, 3],
			[5, 4],
			[6, 4],
			[7, 4],
		];
		const put = async (c: Vec3) => {
			if (!(await builder.place(c.x, c.y, c.z, 'stone'))) throw new Error(`builder: place refused at ${cellStr(c)}`);
		};
		for (const [a, h] of heights) for (let b = -3; b <= -1; b++) for (let y = 0; y < h; y++) await put(L(site, a, b, site.g + y));
		for (let b = -6; b <= 2; b++) for (let y = 0; y < 3; y++) await put(L(site, 12, b, site.g + y));
		await sleep(300);
		builder.close();
	}

	// The companion.
	const decisions: any[] = [];
	const events: any[] = [];
	const logPath = join(runDir, `${mode}.jsonl`);
	let handle: CompanionHandle | null = null;
	if (mode !== 'idle') {
		const seed = 7;
		const log = jsonlLogger(
			(line) => {
				appendFileSync(logPath, line);
				const o = JSON.parse(line);
				if (o.event) events.push(o);
				else decisions.push(o);
			},
			seed,
			() => Date.now(),
		);
		handle = runCompanion({
			body: port.body,
			world: port.world,
			brain,
			config: { companion: TUNING, noEdits: false, brainTimeoutMs: (botsConfig.brains as any).laya.timeoutMs, name: botName },
			log,
			clock: () => Date.now(),
			rng: seededRng(seed),
			seed,
		});
	}

	// Observation, from the kid's client: samples every 100 ms, and every bot edit's echo.
	let phase = 'approach';
	let kid2: Kid | null = null;
	const samples: Sample[] = [];
	const botPose = (): Vec3 | null => {
		const p = kid.client.players().find((q) => q.name === botName && q.hasPos);
		return p ? { x: p.x, y: p.y, z: p.z } : null;
	};
	const sampler = setInterval(() => samples.push({ t: Date.now(), phase, kid: kid.pose(), bot: botPose() }), 100);
	const botEdits: BotEdit[] = [];
	kid.client.on('edit', (msg: EditOut) => {
		const author = kid.client.players().find((p) => p.id === msg.by);
		if (!author || author.name !== botName) return;
		const kids: Vec3[] = [kid.pose()];
		if (kid2) kids.push(kid2.pose());
		for (const [x, y, z, v] of msg.ops) botEdits.push({ t: Date.now(), cell: { x, y, z }, id: v, kids });
	});

	// 1. Walk to the site: to a waypoint 8 blocks down −u, then along +u onto the kid's column.
	const tStart = Date.now();
	const walkLine = async (to: { x: number; z: number }) => {
		const how: string[] = [];
		for (;;) {
			const p = kid.pose();
			const d = Math.hypot(to.x - p.x, to.z - p.z);
			if (d < 0.6) break;
			const k = Math.min(1, 8 / d);
			how.push(await kid.walkTo({ x: p.x + (to.x - p.x) * k, z: p.z + (to.z - p.z) * k }));
		}
		return how;
	};
	const way = Lp(site, -8, 0, site.g);
	const how1 = await walkLine(way);
	const how2 = await walkLine(Lp(site, 0, 0, site.g));
	const center = Lp(site, 0, 0, site.g);
	kid.client.move({ x: center.x, y: site.g, z: center.z });
	const lookAhead = Lp(site, 3, 0, site.g + 1.6);
	kid.lookAt(lookAhead.x, lookAhead.y, lookAhead.z);
	const tArrive = Date.now();
	phase = 'stand';
	const summary = (h: string[]) => `${h.filter((x) => x === 'walked').length} walked, ${h.filter((x) => x === 'flew').length} flew, ${h.filter((x) => x === 'moved').length} moved`;
	info(`arrived after ${((tArrive - tStart) / 1000).toFixed(1)} s (segments: ${summary([...how1, ...how2])})`);

	// 2. Pause.
	await sleep(2000);
	const bp = botPose();
	if (bp) {
		const du = (bp.x - center.x) * site.ux + (bp.z - center.z) * site.uz;
		const dv = (bp.x - center.x) * -site.uz + (bp.z - center.z) * site.ux;
		info(`bot at local u=${du.toFixed(1)} v=${dv.toFixed(1)} before 3a`);
	}

	const g = site.g;
	const aimUnder = (n: Vec3) => {
		kid.lookAt(n.x + 0.5, n.y - 0.01, n.z + 0.5);
	};
	const line = async (cells: Vec3[], block: string, facing: boolean) => {
		for (const c of cells) {
			await kid.place(c, block, facing);
			await sleep(400);
		}
	};

	// 3a. A line along −u towards the kid; N outside his buffer; aim at the block under N for 4 s.
	const n3a = L(site, 2, 0, g);
	await line([L(site, 5, 0, g), L(site, 4, 0, g), L(site, 3, 0, g)], planks, true);
	aimUnder(n3a);
	await sleep(4000);

	// 3b. N2 inside his buffer, outside his body box.
	const n3b = L(site, 0, 1, g);
	await line([L(site, 0, 4, g), L(site, 0, 3, g), L(site, 0, 2, g)], 'cobblestone', true);
	aimUnder(n3b);
	await sleep(4000);

	// 4. Turned away BEFORE the first placement, never facing the cells; N outside every buffer.
	const t4 = Date.now();
	const n4 = L(site, 0, -2, g);
	const away = Lp(site, -20, 10, g + 30);
	kid.lookAt(away.x, away.y, away.z);
	await sleep(300);
	await line([L(site, 0, -5, g), L(site, 0, -4, g), L(site, 0, -3, g)], 'bricks', false);
	kid.lookAt(away.x, away.y, away.z);
	await sleep(5000);

	// 5. Break one bot-placed block (3a's N if the bot placed it).
	const botBlock = botEdits.find((e) => sameCell(e.cell, n3a))?.cell ?? botEdits.find((e) => e.id !== 0)?.cell ?? null;
	let t5 = Date.now();
	if (botBlock) {
		t5 = Date.now();
		await kid.break(botBlock);
		info(`step 5: the kid broke the bot's block at ${cellStr(botBlock)}`);
	} else {
		info('step 5: no bot block to break');
	}
	await sleep(1500);

	// 6. Another valid 3a-style line: N AIR, outside the buffer, within 6 of the bot's eye.
	const n6 = L(site, 2, 2, g);
	await line([L(site, 2, 5, g), L(site, 2, 4, g), L(site, 2, 3, g)], 'stone_bricks', true);
	aimUnder(n6);
	await sleep(4000);
	const bp6 = botPose();
	if (bp6) info(`step 6: N ${dist3({ x: n6.x + 0.5, y: n6.y + 0.5, z: n6.z + 0.5 }, { x: bp6.x, y: bp6.y + 1.6, z: bp6.z }).toFixed(1)} from the bot's eye`);

	// 8. Kid2 joins near Kid and stands idle.
	kid2 = await Kid.connect({ url: server.url, token: TOKEN, world, name: 'Kid2', skin: 'milo' });
	info(`Kid2 joined ${dist3(kid2.pose(), kid.pose()).toFixed(1)} from Kid`);
	await sleep(1000);

	// 9. The staircase (4 steps), the wall (flown over), then 10 more blocks.
	const hopsBefore = handle?.stats.hops ?? 0;
	const tCourse = Date.now();
	phase = 'course-walk';
	const courseWalks: string[] = [];
	courseWalks.push(await kid.walkTo(Lp(site, 1, -2, g)));
	courseWalks.push(await kid.walkTo(Lp(site, 7, -2, g)));
	courseWalks.push(await kid.walkTo(Lp(site, 10, -2, g)));
	phase = 'course-fly';
	const over = Lp(site, 14, -2, g);
	await kid.flyTo({ x: over.x, y: g, z: over.z }).catch((e: Error) => info(`kid flyTo: ${e.message}`));
	phase = 'course-walk';
	courseWalks.push(await kid.walkTo(Lp(site, 24, -2, g)));
	const tCourseEnd = Date.now();
	const hopsCourse = (handle?.stats.hops ?? 0) - hopsBefore;

	// Target rotation: Kid stands idle, Kid2 walks.
	let rotationMs: number | null = null;
	if (mode !== 'idle') {
		phase = 'rotation';
		const tIdle = Date.now();
		let walking = true;
		const k2 = kid2;
		const p1 = Lp(site, -4, -4, g), p2 = Lp(site, -4, 4, g);
		const kid2Walk = (async () => {
			for (let i = 0; walking; i++) {
				const p = i % 2 === 0 ? p1 : p2;
				try {
					await k2.client.walkTo({ x: p.x, z: p.z });
				} catch {
					await sleep(200);
				}
			}
		})();
		const deadline = tIdle + TUNING.idleSwitchMs + 8000;
		while (Date.now() < deadline) {
			const ev = events.find((e) => e.event === 'target' && e.to === 'Kid2' && e.t >= tIdle);
			if (ev) {
				rotationMs = ev.t - tIdle;
				break;
			}
			await sleep(200);
		}
		walking = false;
		k2.client.move(k2.pose());
		await kid2Walk;
	}
	phase = 'end';
	clearInterval(sampler);
	if (handle) await handle.stop();
	const tEnd = Date.now();
	const hopsTotal = handle?.stats.hops ?? 0;
	bot.close();
	kid2.close();
	kid.close();

	// ---- Assertions ----
	const within = (ss: Sample[], lim: number) => ss.filter((s) => s.bot !== null && dist3(s.kid, s.bot) <= lim).length;
	const stand = samples.filter((s) => s.phase === 'stand' && s.t >= tArrive + 2000);
	const walk = samples.filter((s) => s.phase === 'course-walk');
	const standIn = within(stand, FD + 2);
	const walkIn = within(walk, FD + 4);
	const aOk = stand.length > 0 && walk.length > 0 && standIn / stand.length >= 0.8 && walkIn / walk.length >= 0.8;
	const aText = `(a) stand: ${standIn}/${stand.length} = ${pct(standIn, stand.length)} within followDist+2; walk: ${walkIn}/${walk.length} = ${pct(walkIn, walk.length)} within followDist+4`;
	/** Asserted in the companion leg; reported (not asserted) in the Laya leg. */
	const must = (ok: boolean, what: string) => (mode === 'companion' ? check(ok, what) : info(`${ok ? '(holds)' : '(does not hold)'} ${what}`));
	if (mode === 'idle') {
		const seen = [...stand, ...walk].filter((s) => s.bot !== null);
		const ds = seen.map((s) => dist3(s.kid, s.bot!));
		check(seen.length === stand.length + walk.length && seen.length > 0, `idle baseline: the kid saw the idle bot in ${seen.length}/${stand.length + walk.length} samples (all non-null)`);
		info(`idle baseline distances: min ${Math.min(...ds).toFixed(1)}, max ${Math.max(...ds).toFixed(1)}`);
		check(!aOk, `idle baseline FAILS (a): ${aText}`);
		return;
	}
	must(aOk, aText);

	const planksId = id(planks);
	const b = botEdits.some((e) => sameCell(e.cell, n3a) && e.id === planksId);
	must(b, `(b) a bot block of ${planks} at 3a's N ${cellStr(n3a)}: ${b}`);

	const bad = botEdits.filter((e) => e.kids.some((k) => inKidBuffer(e.cell, k) || inKidBody(e.cell, k)));
	const n2Placed = botEdits.some((e) => sameCell(e.cell, n3b));
	check(bad.length === 0 && !n2Placed, `(c) no bot edit in any kid's buffer or body box (${bad.length} of ${botEdits.length}${bad.length ? `: ${bad.map((e) => cellStr(e.cell)).join(' ')}` : ''}); N2 ${cellStr(n3b)} placed: ${n2Placed}`);

	// Any bot edit from the start of step 4 until the kid's break in step 5, not only at N.
	const c2 = botEdits.filter((e) => e.t >= t4 && e.t < t5);
	check(c2.length === 0, `(c2) no bot edit between step 4 (turned-away line, N ${cellStr(n4)}) and step 5: ${c2.length}${c2.length ? `: ${c2.map((e) => cellStr(e.cell)).join(' ')}` : ''}`);

	const after5 = botEdits.filter((e) => e.t >= t5);
	check(botBlock !== null && after5.length === 0, `(d) no bot edit after step 5 (${after5.length}${after5.length ? `: ${after5.map((e) => cellStr(e.cell)).join(' ')}` : ''})`);

	// (e) the log.
	const ts = decisions.map((d) => d.t as number);
	let mono = true, maxGap = 0, minGap = Infinity;
	for (let i = 1; i < ts.length; i++) {
		const gap = ts[i] - ts[i - 1];
		if (gap <= 0) mono = false;
		maxGap = Math.max(maxGap, gap);
		minGap = Math.min(minGap, gap);
	}
	let evMono = true;
	for (let i = 1; i < events.length; i++) if (events[i].t < events[i - 1].t) evMono = false;
	const span = ts.length > 1 ? ts[ts.length - 1] - ts[0] : 0;
	const maxLines = Math.floor(span / TUNING.tickMs) + 1;
	const minLines = Math.floor(span / (TUNING.tickMs + 4000 + 500)) + 1;
	const eOk = mono && evMono && ts.length > 10 && maxGap <= TUNING.tickMs + 4000 + 500 && ts.length <= maxLines && ts.length >= minLines;
	must(
		eOk,
		`(e) ${ts.length} decisions over ${(span / 1000).toFixed(1)} s (bounds ${minLines}–${maxLines}; ${(ts.length / (span / TUNING.tickMs + 1) * 100).toFixed(0)}% of the tick rate), t increasing: ${mono}, events ordered: ${evMono}, gaps ${minGap}–${maxGap} ms (≤ ${TUNING.tickMs + 4500})`,
	);

	// The rotation.
	const rotOk = rotationMs !== null && rotationMs >= TUNING.idleSwitchMs - 1000 && rotationMs <= TUNING.idleSwitchMs + 2000;
	must(rotOk, `rotation: switched to Kid2 ${rotationMs === null ? 'never' : `${(rotationMs / 1000).toFixed(1)} s`} after Kid went idle (${(TUNING.idleSwitchMs - 1000) / 1000}–${(TUNING.idleSwitchMs + 2000) / 1000} s); logged: ${events.filter((e) => e.event === 'target').map((e) => `${e.from}→${e.to}`).join(', ')}`);

	// The staircase/wall stretch (ruling R1). A single sample compares the kid's LOCAL pose with the
	// bot's pose as RELAYED by the server (≤ 100 ms send interval + relay ≈ 0.4 of extra lag at
	// walking speed), so the max of single samples flakes around any tight bound (measured 5.2–6.0
	// walking, up to 6.4 flying on unmodified code). Instead: ≥ 95% of samples within followDist + 4
	// horizontally, walking and flying alike, and a hard 3D maximum of 8 (the kids' snap threshold).
	const course = samples.filter((s) => s.t >= tCourse && s.t <= tCourseEnd && s.bot !== null);
	const courseTotal = samples.filter((s) => s.t >= tCourse && s.t <= tCourseEnd).length;
	const hIn = course.filter((s) => Math.hypot(s.kid.x - s.bot!.x, s.kid.z - s.bot!.z) <= FD + 4).length;
	let max3 = 0, maxJump = 0, kidMaxY = -Infinity;
	for (let i = 0; i < course.length; i++) {
		max3 = Math.max(max3, dist3(course[i].kid, course[i].bot!));
		kidMaxY = Math.max(kidMaxY, course[i].kid.y);
		if (i > 0) maxJump = Math.max(maxJump, dist3(course[i].bot!, course[i - 1].bot!));
	}
	const courseOk = course.length === courseTotal && course.length > 0 && hIn / course.length >= 0.95 && max3 <= 8 && maxJump <= 8 && hopsCourse === 0;
	must(
		courseOk,
		`stairs/wall: ${hIn}/${course.length} = ${pct(hIn, course.length)} within followDist+4 = ${FD + 4} horizontally (≥ 95%); max 3D distance ${max3.toFixed(2)} (≤ 8); max pose jump ${maxJump.toFixed(2)} (≤ 8); hops ${hopsCourse} (session ${hopsTotal}); ${((tCourseEnd - tCourse) / 1000).toFixed(1)} s`,
	);
	check(courseWalks.every((w) => w === 'walked') && kidMaxY >= g + 4, `the course was really walked: walkTo results ${courseWalks.join(',')}; the kid's max y ${kidMaxY.toFixed(2)} (≥ g+4 = ${g + 4})`);
	info(`bot edits seen by the kid: ${botEdits.map((e) => `${cellStr(e.cell)}#${e.id}@${((e.t - tArrive) / 1000).toFixed(1)}s`).join(' ') || 'none'}; leg ${((tEnd - tStart) / 1000).toFixed(0)} s; log ${logPath}`);

	if (mode === 'laya') {
		const present = decisions.filter((d) => d.snapshot.target !== null || d.snapshot.others.length > 0);
		const noRule = present.filter((d) => !String(d.reason).startsWith('rule:'));
		const answered = noRule.filter((d) => d.reason === 'brain' || d.reason === 'low-confidence');
		const byReason: Record<string, number> = {};
		for (const d of decisions) byReason[d.reason] = (byReason[d.reason] ?? 0) + 1;
		check(noRule.length > 0 && answered.length / noRule.length >= 0.8, `laya: ${answered.length}/${noRule.length} = ${pct(answered.length, noRule.length)} of the kid-present, no-rule ticks have a brain answer (≥ 80%); reasons ${JSON.stringify(byReason)}`);
		// Ruling R2: a logged count, not an assertion. With help_build taken by rule and follow taken
		// by the follow floor whenever the kid is far, high or moving, the brain only decides for a
		// still, near kid, where the script offers watch/idle (and follow only at 3–5 blocks): too few
		// ticks where a "non-default" choice is even possible to assert one exists.
		const nonDefault = answered.filter((d) => d.reason === 'brain' && d.action !== (d.candidates.includes('follow') ? 'follow' : 'watch'));
		const actions: Record<string, number> = {};
		for (const d of answered) actions[d.action] = (actions[d.action] ?? 0) + 1;
		const lat = answered.map((d) => d.latency as number).sort((x, y) => x - y);
		info(`laya: brain choices that are not the safe default (follow if offered, else watch): ${nonDefault.length} (${nonDefault.map((d) => d.action).join(',') || '-'}); answered actions ${JSON.stringify(actions)}; latency p50 ${lat[Math.floor(lat.length / 2)] ?? '-'} ms, max ${lat[lat.length - 1] ?? '-'} ms`);
	}
}

// ---------------------------------------------------------------------------------------------
// The CLI leg: the real process, SIGINT, exit within 5 s, --revert-on-exit

async function cliLeg(): Promise<void> {
	let server: McServer | null = null;
	let kid: Kid | null = null;
	let worldUuid = '';
	let child: ReturnType<typeof spawn> | null = null;
	try {
		server = await startServer(LOCAL_PORT);
		check(server.url === `http://127.0.0.1:${LOCAL_PORT}` && LOCAL_PORT !== 8080, `our server on the \`local\` target's port ${LOCAL_PORT} (pid ${server.pid})`);
		worldUuid = await server.createWorld('e2e-cli');
		kid = await Kid.connect({ url: server.url, token: TOKEN, world: worldUuid, name: 'Kid', skin: 'jj' });
		const site = await findSite(kid.world, kid.pose(), 0);

		child = spawn('npx', ['tsx', 'src/cli.ts', 'companion', '--target', 'local', '--world', worldUuid, '--name', 'CliBot', '--brain', 'scripted', '--revert-on-exit'], {
			cwd: BOTS_DIR,
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let out = '';
		child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
		child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
		const exited = new Promise<string>((r) => child!.once('exit', (code, sig) => r(`${code}/${sig}`)));
		const k = kid;
		const joinDeadline = Date.now() + 40_000;
		while (Date.now() < joinDeadline && !k.client.players().some((p) => p.name === 'CliBot' && p.hasPos)) await sleep(200);
		const cli = k.client.players().find((p) => p.name === 'CliBot');
		check(cli !== undefined && cli.bot, `the CLI bot joined, seen by the kid as a bot: ${cli ? `bot=${cli.bot}` : 'no'}`);

		// Walk to a flat spot, then a 3a line; the CLI bot places N.
		const center = Lp(site, 0, 0, site.g);
		await k.walkTo({ x: Lp(site, -6, 0, 0).x, z: Lp(site, -6, 0, 0).z });
		await k.walkTo({ x: center.x, z: center.z });
		k.client.move({ x: center.x, y: site.g, z: center.z });
		await sleep(2500);
		const n = L(site, 2, 0, site.g);
		let placedAt = 0;
		const off = k.client.on('edit', (msg: EditOut) => {
			const author = k.client.players().find((p) => p.id === msg.by);
			if (author?.name === 'CliBot' && msg.ops.some(([x, y, z, v]) => x === n.x && y === n.y && z === n.z && v !== 0)) placedAt = Date.now();
		});
		for (const c of [L(site, 5, 0, site.g), L(site, 4, 0, site.g), L(site, 3, 0, site.g)]) {
			await k.place(c, 'oak_planks');
			await sleep(400);
		}
		k.lookAt(n.x + 0.5, n.y - 0.01, n.z + 0.5);
		for (let i = 0; i < 40 && placedAt === 0; i++) await sleep(100);
		off();
		check(placedAt !== 0 && k.world.getBlock(n.x, n.y, n.z) === id('oak_planks'), `the CLI bot placed its block at N ${cellStr(n)}`);

		// Ctrl-C: SIGINT to the whole process group, as a terminal does.
		const t0 = Date.now();
		process.kill(-child.pid!, 'SIGINT');
		const code = await Promise.race([exited, sleep(5000).then(() => 'timeout' as const)]);
		const exitMs = Date.now() - t0;
		let groupGone = false;
		try {
			process.kill(-child.pid!, 0);
		} catch {
			groupGone = true;
		}
		check(code !== 'timeout' && groupGone, `after SIGINT the CLI exited by itself in ${code === 'timeout' ? '> 5000' : exitMs} ms (≤ 5000), npx exit ${code}, process group gone: ${groupGone}`);
		await sleep(500);
		const reverted = k.world.getBlock(n.x, n.y, n.z) === 0;
		check(reverted && /reverted 1 cell\b/.test(out), `--revert-on-exit: N is air again (${reverted}); the CLI printed "${(out.match(/reverted \d+ cells?/) ?? ['nothing'])[0]}"`);
		info(`CLI output: ${out.trim().split('\n').map((l) => l.slice(0, 160)).join(' | ')}`);
	} finally {
		if (child && child.exitCode === null && child.signalCode === null) {
			// Ours, and it did not exit: stop the whole group.
			try {
				process.kill(-child.pid!, 'SIGKILL');
			} catch {
				// gone
			}
		}
		kid?.close();
		await server?.stop();
		if (worldUuid) {
			// The CLI's state and logs for this (fresh) world only.
			rmSync(join(BOTS_DIR, '.state', 'local', worldUuid), { recursive: true, force: true });
			rmSync(join(BOTS_DIR, '.state', 'logs', 'local', worldUuid), { recursive: true, force: true });
			// …and the parents the run created, only while empty (rmdir refuses a non-empty dir).
			for (const d of [['local'], ['logs', 'local'], ['logs'], []]) {
				try {
					rmdirSync(join(BOTS_DIR, '.state', ...d));
				} catch {
					// not empty, or not there: leave it
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
	const runDir = mkdtempSync(join(SCRATCH, 'run-'));
	console.log(`bots e2e: logs in ${runDir}`);
	let server: McServer | null = null;
	try {
		if (want('companion') || want('idle') || want('laya')) {
			server = await startServer();
			if (server.port === 8080) throw new Error('refusing 8080');
			console.log(`mcserver pid ${server.pid} on ${server.url}`);
		}
		if (want('companion')) await leg('companion', 'companion, scripted brain', () => runLeg(server!, 'companion', null, runDir));
		if (want('idle')) await leg('idle', 'idle baseline (must fail (a))', () => runLeg(server!, 'idle', null, runDir));
		if (want('laya')) {
			const def = (botsConfig.brains as any).laya;
			const laya = new SystemOneBrain({ name: 'laya', url: def.url, healthPath: def.health });
			let healthy = false;
			let why = 'health() is false';
			try {
				healthy = await laya.health();
			} catch (e) {
				why = (e as Error).message;
			}
			if (healthy) await leg('laya', 'companion, Laya brain', () => runLeg(server!, 'laya', laya, runDir));
			else console.log(`\nSKIP laya: ${why} (${def.url}${def.health}); start it with \`npm run brains -- laya\``);
		}
		const B2 = ['brain2-help', 'brain2-alone', 'brain2-mine', 'brain2-revert', 'brain2-follow-watch', 'brain2-cli', 'brain2-productive'];
		if (B2.some(want)) {
			// On the `local` target's port when a leg runs the real CLI (`revert`, `--brain v2`): it reaches the server by
			// the committed config. The in-process legs alone take a free port (18090 may be another session's server).
			const b2 = await startServer(want('brain2-revert') || want('brain2-cli') ? LOCAL_PORT : undefined);
			console.log(`\nbrain2: mcserver pid ${b2.pid} on ${b2.url}`);
			try {
				const ctx = { server: b2, stateRoot: join(runDir, 'state'), botsDir: BOTS_DIR, want, leg, check, info };
				await brain2Legs(ctx);
				if (want('brain2-productive')) await leg('brain2-productive', 'the real CLI alone: mines ≥ 8 and finishes a Build, no kid cell touched', () => brain2ProductiveLeg(ctx));
				if (want('brain2-cli')) {
					await leg('brain2-cli', 'the real CLI, --brain v2: runs, logs, SIGTERM exits with the brain file flushed', () => brain2CliLeg(ctx, 'SIGTERM'));
					await leg('brain2-cli-int', 'the same, SIGINT', () => brain2CliLeg(ctx, 'SIGINT', 20_000));
				}
			} finally {
				await b2.stop();
			}
		}
		if (want('cli')) await leg('cli', 'the real CLI: SIGINT exit and --revert-on-exit', cliLeg);
		if (want('builder')) await leg('builder', 'the builder CLI, engines down: finishes a build (≥ 20 cells), nothing on the kid pillar', () => builderLeg({ check, info }));
		if (want('village')) await leg('village', 'the village CLI, engines down: ≥ 2 lots and ≥ 1 path, nothing on the kid pillar', () => villageLeg({ check, info }));
		if (want('architect')) await leg('architect', 'the architect CLI, engines down: one design ≥ 30 cells, nothing within 3 of the kid pillar', () => architectLeg({ check, info }));
		if (want('helper')) await leg('helper', 'the helper CLI, engines down: a matching build ≥ 6 cells, > 3 from the kid line, his block only', () => helperLeg({ check, info }));
		if (want('decorator')) await leg('decorator', 'the decorator CLI, engines down: ≥ 10 decoration cells, nothing on the kid pillar', () => decoratorLeg({ check, info }));
	} finally {
		try {
			await server?.stop();
		} catch (e) {
			console.error(`FAIL server stop: ${(e as Error).message}`);
			results.push({ id: 'server-stop', ok: false, notes: [(e as Error).message] });
		}
		removeBuild();
		if (results.every((r) => r.ok) && !process.env.BOTS_E2E_KEEP) rmSync(runDir, { recursive: true, force: true });
		else console.log(`logs kept in ${runDir}`);
	}
	console.log('\n== summary');
	for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}`);
	process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
