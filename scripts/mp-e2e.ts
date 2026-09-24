// scripts/mp-e2e.ts — the two-client multiplayer end-to-end suite (plan I2, spec §10 E1–E7, plus E8
// and the 4009 step from the gate-2 amendments).
//
//   npx tsx scripts/mp-e2e.ts [--only E2,E6]
//
// Setup: builds `mcserver` into the scratchpad and runs it on 127.0.0.1:18080 against a temp DB
// (token `e2e`), and starts its OWN Vite dev servers on :5174 (and :5175 for E7) with
// VITE_MINICRAFT_MP_URL=http://localhost:18080 and VITE_MINICRAFT_API_URL on a dead local port.
// Every port must be free: the script never reuses or stops a server it did not start, and it
// stops its own by port only (`fuser -k <port>/tcp`, never pkill).
// Browsers are headless Chromium. Every page aborts any request that is not to localhost or
// 127.0.0.1 (the production site, the save API on *.run.app), and such a request fails the run.
// Oracles: `window.__mc` (DEV only): `worldHash`, `refReplay`, `mp.log`, `mp.remote`, `playtime`.
// Each scenario prints PASS or FAIL; the exit code is 1 when any failed.
// `--only` still runs the joins the named scenarios need.
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ROOT = new URL('..', import.meta.url).pathname;
const SCRATCH = process.env.MP_E2E_SCRATCH
	?? '/tmp/claude-1000/-home-julien-Projects-Minicraft/025905b6-e89d-412e-8343-fd1da268b0f3/scratchpad';
const MC_PORT = 18080;
const VITE_PORT = 5174;
const VITE_DEAD_PORT = 5175;
const MP_URL = `http://localhost:${MC_PORT}`;
const BASE = `http://localhost:${VITE_PORT}/`;
const BASE2 = `http://localhost:${VITE_DEAD_PORT}/`;
const DEAD_API = 'http://127.0.0.1:1';
const TOKEN = 'e2e';
const SEED = 7;
const GO = join(process.env.HOME ?? '', '.local/go/bin/go');

const onlyArg = (() => {
	const i = process.argv.indexOf('--only');
	return i >= 0 ? new Set(process.argv[i + 1].split(',').map((s) => s.trim().toUpperCase())) : null;
})();
const want = (id: string) => onlyArg === null || onlyArg.has(id);

// ---------------------------------------------------------------------------------------------
// Reporting

const results: Array<{ id: string; ok: boolean; notes: string[] }> = [];
let current: { id: string; ok: boolean; notes: string[] } | null = null;
function check(ok: boolean, what: string): boolean {
	console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${what}`);
	if (current) {
		current.notes.push(`${ok ? 'ok' : 'FAIL'} ${what}`);
		if (!ok) current.ok = false;
	}
	return ok;
}
async function scenario(id: string, title: string, body: () => Promise<void>): Promise<void> {
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// Servers (ours only, stopped by port)

const ownedPorts = new Set<number>();
let mc: ChildProcess | null = null;
let dbDir = '';

async function portBusy(port: number): Promise<boolean> {
	const r = spawnSync('fuser', [`${port}/tcp`], { stdio: 'ignore' });
	return r.status === 0;
}

function stopPort(port: number, signal = 'KILL'): void {
	spawnSync('fuser', ['-k', `-${signal}`, `${port}/tcp`], { stdio: 'ignore' });
}

async function waitHttp(url: string, headers: Record<string, string> = {}, tries = 120): Promise<void> {
	for (let i = 0; i < tries; i++) {
		try {
			const r = await fetch(url, { headers });
			if (r.status < 500) return;
		} catch {
			// not up yet
		}
		await sleep(250);
	}
	throw new Error(`${url} never came up`);
}

function buildServer(): string {
	const out = join(SCRATCH, 'mcserver-e2e');
	const env = { ...process.env, PATH: `${join(process.env.HOME ?? '', '.local/go/bin')}:${process.env.PATH}` };
	const r = spawnSync(GO, ['build', '-o', out, './cmd/mcserver'], { cwd: join(ROOT, 'server'), env, stdio: 'inherit' });
	if (r.status !== 0) throw new Error('go build mcserver failed');
	return out;
}

let serverBin = '';
async function startMc(): Promise<void> {
	const env = { ...process.env };
	delete env.MC_GCS_BUCKET;
	delete env.MC_TOKEN;
	mc = spawn(serverBin, [
		'-addr', `127.0.0.1:${MC_PORT}`,
		'-db', join(dbDir, 'mc.sqlite'),
		'-token', TOKEN,
		'-origins', `http://localhost:${VITE_PORT},http://localhost:${VITE_DEAD_PORT}`,
		'-gcs-bucket', '',
	], { env, stdio: ['ignore', 'ignore', 'pipe'] });
	mc.stderr?.on('data', (d: Buffer) => {
		if (process.env.MP_E2E_VERBOSE) process.stderr.write(`[mcserver] ${d}`);
	});
	ownedPorts.add(MC_PORT);
	await waitHttp(`${MP_URL}/worlds`, { Authorization: `Bearer ${TOKEN}` });
}

/** Signals the server by its port and waits for the process to exit. */
async function killMc(signal: 'TERM' | 'KILL'): Promise<number> {
	const p = mc;
	const t0 = Date.now();
	const exited = p && p.exitCode === null && p.signalCode === null ? new Promise<void>((r) => p.once('exit', () => r())) : Promise.resolve();
	stopPort(MC_PORT, signal);
	await Promise.race([exited, sleep(15_000)]);
	mc = null;
	return Date.now() - t0;
}

function startVite(port: number): ChildProcess {
	const p = spawn('npx', ['vite', '--port', String(port), '--strictPort'], {
		cwd: ROOT,
		env: {
			...process.env,
			VITE_MINICRAFT_API_URL: DEAD_API,
			VITE_MINICRAFT_MP_URL: MP_URL,
			VITE_MINICRAFT_MP_TOKEN: TOKEN,
		},
		stdio: 'ignore',
	});
	ownedPorts.add(port);
	return p;
}

function stopAll(): void {
	for (const p of ownedPorts) stopPort(p);
}
process.on('exit', stopAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => process.exit(130));

// ---------------------------------------------------------------------------------------------
// Pages

const offHost: string[] = [];

/** Only localhost is reachable; the dead save API is aborted; anything else is recorded and aborted. */
async function guard(page: Page): Promise<void> {
	await page.route('**/*', (route) => {
		const u = new URL(route.request().url());
		if (u.origin === DEAD_API) return route.abort();
		if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return route.continue();
		offHost.push(u.href);
		console.error(`mp-e2e: BLOCKED ${u.href} (only localhost is allowed)`);
		return route.abort();
	});
}

type Who = { name: string; skin: string };

async function newPage(ctx: BrowserContext, who: Who | null, label: string): Promise<Page> {
	const page = await ctx.newPage();
	page.on('pageerror', (e) => console.log(`   [${label}] pageerror ${e.message}`));
	page.on('console', (m) => {
		if (m.type() === 'error' && process.env.MP_E2E_VERBOSE) console.log(`   [${label}] console.error ${m.text()}`);
	});
	page.on('dialog', (d) => void d.accept());
	await guard(page);
	// esbuild's keepNames helper, referenced by functions passed to evaluate.
	await page.addInitScript('window.__name = (f) => f;');
	// Count WebSocket constructions (E7, the 4009 step). Resets on every document. Vite's own HMR
	// socket (to the dev server's port) is the harness, not the game: it is listed but not counted.
	await page.addInitScript((mcPort) => {
		const w = window as any;
		w.__wsCount = 0;
		w.__wsUrls = [];
		const Native = w.WebSocket;
		const Spy = function (this: unknown, ...a: unknown[]) {
			const url = String(a[0]);
			w.__wsUrls.push(url);
			const hmr = new URL(url, location.href).port === location.port && a[1] === 'vite-hmr';
			if (!hmr || url.includes(`:${mcPort}`)) w.__wsCount++;
			return new Native(...a);
		} as unknown as typeof WebSocket;
		(Spy as any).prototype = Native.prototype;
		for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) (Spy as any)[k] = Native[k];
		w.WebSocket = Spy;
	}, MC_PORT);
	if (who) {
		await page.addInitScript(([n, s]) => {
			if (!localStorage.getItem('minicraft:v1:mp')) localStorage.setItem('minicraft:v1:mp', JSON.stringify({ name: n, skin: s, worldId: null }));
		}, [who.name, who.skin]);
	}
	return page;
}

/** Home → Multiplayer → the world → (duration) → Play; resolves when the world has streamed in. */
async function joinWorld(page: Page, base: string, worldId: string, durationLabel: string | null): Promise<void> {
	await page.goto(base);
	await page.click('#home-multi');
	await page.waitForSelector(`#mp-worlds .world-row[data-id="${worldId}"]`, { timeout: 20_000 });
	await page.click(`#mp-worlds .world-row[data-id="${worldId}"]`);
	if (durationLabel) await setDuration(page, durationLabel);
	await page.click('#mp-play');
	await waitInGame(page);
}

async function setDuration(page: Page, label: string): Promise<void> {
	for (let i = 0; i < 40; i++) {
		if ((await page.locator('#duration-value').innerText()).trim() === label) return;
		await page.click('#duration-minus');
	}
	throw new Error(`could not set the duration to ${label}`);
}

async function waitInGame(page: Page, timeout = 60_000): Promise<void> {
	await page.waitForFunction(() => (window as any).__mc?.mp != null, null, { timeout });
	await page.waitForFunction(() => (window as any).__mc.loop.stats.streamQueue === 0, null, { timeout });
}

const pos = (page: Page) => page.evaluate(() => [...(window as any).__mc.player.position] as [number, number, number]);
const dist3 = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const distXZ = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[2] - b[2]);

/** The block ids and predicates, loaded once per document from the dev server's own module. */
async function loadBlocks(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const w = window as any;
		if (w.__blocks) return;
		const u = '/src/data/blocks.data.ts';
		w.__blocks = await import(/* @vite-ignore */ u);
	});
}

/** Stands the player on the ground of column (x, z), facing yaw 0; returns the feet position. */
async function standAt(page: Page, x: number, z: number): Promise<[number, number, number]> {
	await loadBlocks(page);
	return page.evaluate(([x, z]) => {
		const w = window as any;
		const { world, player, cam } = w.__mc;
		const B = w.__blocks;
		let y = world.height - 2;
		while (y > 1 && !(B.isSolid(world.getBlock(x, y, z)) && !B.isLiquid(world.getBlock(x, y, z)))) y--;
		player.position = [x + 0.5, y + 1, z + 0.5];
		player.vy = 0;
		cam.yaw = 0;
		cam.pitch = 0;
		return player.position as [number, number, number];
	}, [x, z]);
}

function chunksAround(x: number, z: number, r = 1): Array<[number, number]> {
	const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
	const out: Array<[number, number]> = [];
	for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) out.push([cx + dx, cz + dz]);
	return out;
}

const hashOf = (page: Page, chunks: Array<[number, number]>) =>
	page.evaluate((c) => (window as any).__mc.worldHash(c) as string | null, chunks);

/** Polls the pages' hashes until none changed for `quietMs`; returns the final hashes. */
async function untilQuiet(pages: Page[], chunks: Array<[number, number]>, quietMs: number, maxMs: number): Promise<Array<string | null>> {
	const t0 = Date.now();
	let last: Array<string | null> = [];
	let since = Date.now();
	while (Date.now() - t0 < maxMs) {
		const now = await Promise.all(pages.map((p) => hashOf(p, chunks)));
		if (now.some((h, i) => h !== last[i])) {
			last = now;
			since = Date.now();
		} else if (Date.now() - since >= quietMs) {
			return last;
		}
		await sleep(500);
	}
	throw new Error(`no quiet ${quietMs} ms window within ${maxMs} ms`);
}

/**
 * An inland surface cell (T3's rule: solid ground, no liquid within 10 blocks, two air cells above)
 * near (x0, z0), whose 3×3 chunks are loaded on every page and at least `awayFrom` chunks (Chebyshev)
 * from each chunk in `avoid`, and whose single-client reference settles.
 */
async function findSpot(
	pages: Page[],
	x0: number,
	z0: number,
	avoid: Array<[number, number]>,
	refFor: (s: { x: number; y: number; z: number }) => Promise<boolean>,
): Promise<{ x: number; y: number; z: number }> {
	for (const p of pages) await loadBlocks(p);
	const cands = await pages[0].evaluate(([x0, z0, avoid]) => {
		const w = window as any;
		const { world } = w.__mc;
		const B = w.__blocks;
		const out: Array<{ x: number; y: number; z: number }> = [];
		for (let r = 0; r <= 40 && out.length < 12; r += 3) {
			for (let dx = -r; dx <= r; dx += 3) for (const dz of r === 0 ? [0] : [-r, r]) {
				for (const [ax, az] of [[dx, dz], [dz, dx]]) {
					const x = Math.floor(x0) + ax, z = Math.floor(z0) + az;
					const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
					// Disjoint 3×3 neighbourhoods: another scenario's water never reaches this one's hash.
					if (avoid.some(([vx, vz]) => Math.max(Math.abs(vx - cx), Math.abs(vz - cz)) < 3)) continue;
					let loaded = true;
					for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (!world.getChunk(cx + i, cz + j)) loaded = false;
					if (!loaded) continue;
					let y = world.height - 2;
					while (y > 1 && world.getBlock(x, y, z) === 0) y--;
					const g = world.getBlock(x, y, z);
					if (!B.isSolid(g) || B.isLiquid(g)) continue;
					let wet = false;
					for (let a = -10; a <= 10 && !wet; a++) for (let b = -10; b <= 10 && !wet; b++) for (let c = -3; c <= 2; c++) {
						if (B.isLiquid(world.getBlock(x + a, y + c, z + b))) { wet = true; break; }
					}
					if (!wet && world.getBlock(x, y + 1, z) === 0 && world.getBlock(x, y + 2, z) === 0 && !out.some((o) => o.x === x && o.z === z)) out.push({ x, y: y + 1, z });
				}
			}
		}
		return out;
	}, [x0, z0, avoid] as const);
	for (const s of cands) {
		let loadedEverywhere = true;
		for (const p of pages.slice(1)) {
			const ok = await p.evaluate((c) => c.every(([cx, cz]) => (window as any).__mc.world.getChunk(cx, cz) !== undefined), chunksAround(s.x, s.z));
			if (!ok) loadedEverywhere = false;
		}
		if (!loadedEverywhere) continue;
		if (await refFor(s)) return s;
	}
	throw new Error(`no usable spot near (${Math.floor(x0)}, ${Math.floor(z0)}) among ${cands.length} candidates`);
}

/** The single-client reference, run in `page` against its current overlay (`base`). */
async function reference(page: Page, actions: unknown[], chunks: Array<[number, number]>, player: number[], baseVar: string): Promise<{ hash: string; settledAt: number; writes: number } | null> {
	return page.evaluate(([actions, chunks, player, baseVar]) => {
		const w = window as any;
		return w.__mc.refReplay(actions, { base: w[baseVar], chunks, player });
	}, [actions, chunks, player, baseVar] as const);
}

/** CIE76 ΔE between two sRGB colours. */
function deltaE(a: number[], b: number[]): number {
	const lab = (rgb: number[]) => {
		const [r, g, bl] = rgb.map((v) => {
			const c = v / 255;
			return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92;
		});
		const x = (r * 0.4124 + g * 0.3576 + bl * 0.1805) / 0.95047;
		const y = r * 0.2126 + g * 0.7152 + bl * 0.0722;
		const z = (r * 0.0193 + g * 0.1192 + bl * 0.9505) / 1.08883;
		const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
		return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
	};
	const p = lab(a), q = lab(b);
	return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
const hexRgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// ---------------------------------------------------------------------------------------------
// The run

const A_WHO: Who = { name: 'Ana', skin: 'red' };
const B_WHO: Who = { name: 'Bo', skin: 'blue' };

(async () => {
	if (!existsSync(SCRATCH)) mkdirSync(SCRATCH, { recursive: true });
	for (const p of [MC_PORT, VITE_PORT, VITE_DEAD_PORT]) {
		if (await portBusy(p)) throw new Error(`port ${p} is busy: stop that server yourself; this script never reuses or stops a server it did not start`);
	}
	serverBin = buildServer();
	dbDir = mkdtempSync(join(SCRATCH, 'mp-e2e-db-'));
	console.log(`mcserver ${serverBin}, DB ${dbDir}`);
	await startMc();
	startVite(VITE_PORT);
	await waitHttp(BASE);
	const created = await (await fetch(`${MP_URL}/worlds`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'E2E', seed: SEED, mustMine: false, gen: 3 }),
	})).json() as { uuid: string };
	const WORLD = created.uuid;
	console.log(`world ${WORLD} (seed ${SEED})`);

	// Headless only: a headed window steals the user's focus (standing rule).
	const browser: Browser = await chromium.launch({ headless: true });
	const ctxA = await browser.newContext({ viewport: { width: 960, height: 600 } });
	const ctxB = await browser.newContext({ viewport: { width: 960, height: 600 } });
	let A: Page | null = null;
	let B: Page | null = null;
	const needMp = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', '4009'].some(want);
	try {
		// ------------------------------------------------------------------ E7 (part 1)
		if (want('E7')) {
			await scenario('E7a', 'solo on the multiplayer build constructs no WebSocket', async () => {
				const ctx = await browser.newContext();
				const p = await newPage(ctx, null, 'solo');
				await soloPlay(p, BASE);
				const ws = await p.evaluate(() => (window as any).__wsCount as number);
				check(ws === 0, `Single Player → New World → Play: ${ws} WebSocket constructions (all sockets: ${JSON.stringify(await p.evaluate(() => (window as any).__wsUrls))})`);
				check(await p.evaluate(() => (window as any).__mc.mp === null), 'solo: no multiplayer session objects');
				check(await p.locator('#minimap').count() === 0, 'solo: no minimap');
				await ctx.close();
			});
		}

		if (needMp) {
			A = await newPage(ctxA, A_WHO, 'A');
			await joinWorld(A, BASE, WORLD, '10 min');
			B = await newPage(ctxB, B_WHO, 'B');
			await joinWorld(B, BASE, WORLD, null);
			await sleep(1_500);
		}

		// ------------------------------------------------------------------ E1
		if (want('E1') && A && B) {
			const a = A, b = B;
			await scenario('E1', 'a placed block relays within 500 ms; a mined one comes back as air', async () => {
				const p = await pos(a);
				const cell = [Math.floor(p[0]) + 1, Math.floor(p[1]) + 3, Math.floor(p[2]) + 1];
				check(await b.evaluate((c) => (window as any).__mc.world.getBlock(c[0], c[1], c[2]), cell) === 0, `the cell (${cell}) starts as air on B`);
				await a.evaluate((c) => (window as any).__mc.world.setBlock(c[0], c[1], c[2], 1), cell);
				const t0 = Date.now();
				const seenAfter = await b.evaluate(async (c) => {
					const t = performance.now();
					while (performance.now() - t < 3000) {
						if ((window as any).__mc.world.getBlock(c[0], c[1], c[2]) === 1) return performance.now() - t;
						await new Promise((r) => setTimeout(r, 10));
					}
					return -1;
				}, cell);
				const wall = Date.now() - t0;
				check(seenAfter >= 0 && wall <= 500, `B sees A's stone after ${wall} ms (B's own clock ${seenAfter.toFixed(0)} ms), limit 500 ms`);
				await b.evaluate((c) => (window as any).__mc.world.setBlock(c[0], c[1], c[2], 0), cell);
				const air = await a.evaluate(async (c) => {
					const t = performance.now();
					while (performance.now() - t < 3000) {
						if ((window as any).__mc.world.getBlock(c[0], c[1], c[2]) === 0) return performance.now() - t;
						await new Promise((r) => setTimeout(r, 10));
					}
					return -1;
				}, cell);
				check(air >= 0, `A sees air after B mines it (${air.toFixed(0)} ms)`);
			});
		}

		// ------------------------------------------------------------------ E4
		if (want('E4') && A && B) {
			const a = A, b = B;
			await scenario('E4', "B's minimap shows A's dot; B's scene has A's label", async () => {
				const b0 = await pos(b);
				const pb = await standAt(b, Math.floor(b0[0]), Math.floor(b0[2]));
				const pa = await standAt(a, Math.floor(pb[0]) + 10, Math.floor(pb[2]) + 6);
				await sleep(2_000);
				const seen = await b.evaluate(() => (window as any).__mc.mp.remote.positions() as Array<{ name: string; skin: string; x: number; y: number; z: number }>);
				const ra = seen.find((s) => s.name === A_WHO.name);
				check(ra !== undefined, `B's remote.positions() includes ${A_WHO.name} (${JSON.stringify(seen.map((s) => s.name))})`);
				if (!ra) return;
				check(dist3([ra.x, ra.y, ra.z], pa) < 0.5, `A's avatar on B is where A stands (${dist3([ra.x, ra.y, ra.z], pa).toFixed(2)} blocks off)`);
				const px = await b.evaluate(async (name) => {
					const w = window as any;
					const u = '/src/ui/minimap-model.ts';
					const mm = await import(/* @vite-ignore */ u);
					const { player, cam, mp } = w.__mc;
					const o = mp.remote.positions().find((s: { name: string }) => s.name === name);
					const canvas = document.getElementById('minimap') as HTMLCanvasElement;
					const ctx = canvas.getContext('2d')!;
					const dpr = canvas.width / 160;
					// Wait for a redraw after reading the state (10 Hz).
					await new Promise((r) => setTimeout(r, 250));
					const p = mm.toMap(player.position[0], player.position[2], cam.yaw, o.x, o.z, mm.MAP_RADIUS_BLOCKS, 80);
					// The pixel that contains the point (its centre is floor + 0.5).
					const at = (dx: number, dy: number) => Array.from(ctx.getImageData(Math.floor((80 + p.x + dx) * dpr), Math.floor((80 + p.y + dy) * dpr), 1, 1).data).slice(0, 3);
					// The dot is a radius-5 disc with a 2 px white stroke on its edge (4…6): its visible fill
					// ends at 4, and the ring one pixel out, on the stroke's centre line, is sampled all round.
					const ring: number[][] = [];
					for (let k = 0; k < 8; k++) {
						const a = (k * Math.PI) / 4;
						ring.push(at(5 * Math.cos(a), 5 * Math.sin(a)));
					}
					return { centre: at(0, 0), ring, clamped: p.clamped, map: [p.x, p.y] };
				}, A_WHO.name);
				const skin = hexRgb('#E53935');
				const dSkin = deltaE(px.centre, skin);
				check(!px.clamped && dSkin < 30, `the minimap pixel at A's projected spot (${px.map.map((v: number) => v.toFixed(1))}) is A's skin colour: rgb(${px.centre}) ΔE ${dSkin.toFixed(1)} < 30`);
				const white = px.ring.filter((c: number[]) => deltaE(c, [255, 255, 255]) < 30).length;
				check(white === 8, `the ring one pixel outside the dot's fill is white (${white}/8 samples ΔE < 30: ${JSON.stringify(px.ring)})`);
				const label = await b.evaluate((name) => {
					const w = window as any;
					const r = w.__mc.mp.remote;
					for (const av of r.avatars.values()) {
						if (av.name !== name) continue;
						let inScene = false;
						for (let o = av.group; o; o = o.parent) if (o.type === 'Scene') inScene = true;
						return { inScene, groupVisible: av.group.visible, label: av.label.type, labelInGroup: av.label.parent === av.group, map: !!av.label.material?.map };
					}
					return null;
				}, A_WHO.name);
				check(!!label && label.inScene && label.groupVisible && label.label === 'Sprite' && label.labelInGroup && label.map, `B's scene has A's visible avatar with its label sprite (${JSON.stringify(label)})`);
			});
		}

		// ------------------------------------------------------------------ E2
		let e2Chunks: Array<[number, number]> = [];
		if (want('E2') && A && B) {
			const a = A, b = B;
			await scenario('E2', 'A pours water and leaves ~1 s later; B alone finishes and equals the single-client reference', async () => {
				await loadBlocks(b);
				const WATER = await b.evaluate(() => (window as any).__blocks.WATER as number);
				const pb = await pos(b);
				await b.evaluate(() => { (window as any).__e2base = (window as any).__mc.mp.overlayCells(); });
				let ref: { hash: string; settledAt: number; writes: number } | null = null;
				const spot = await findSpot([b, a], pb[0], pb[2], [], async (s) => {
					ref = await reference(b, [{ t: 0, kind: 'set', x: s.x, y: s.y, z: s.z, id: WATER }], chunksAround(s.x, s.z), [s.x + 5.5, s.y + 1, s.z + 0.5], '__e2base');
					return ref !== null;
				});
				const r = ref as unknown as { hash: string; settledAt: number; writes: number };
				e2Chunks = chunksAround(spot.x, spot.z);
				const pristine = await hashOf(b, e2Chunks);
				console.log(`   spot (${spot.x}, ${spot.y}, ${spot.z}); reference settles at ${r.settledAt.toFixed(1)} s after ${r.writes} writes`);
				check(r.hash !== pristine && r.writes > 1, `the reference is not vacuous (hash ${r.hash} vs before ${pristine}, ${r.writes} writes)`);
				// B stands 5 blocks from the pour (in range), A 3 blocks the other way.
				await standAt(b, spot.x + 5, spot.z);
				await standAt(a, spot.x - 3, spot.z);
				await sleep(1_000);
				await a.evaluate(([x, y, z, id]) => (window as any).__mc.world.setBlock(x, y, z, id), [spot.x, spot.y, spot.z, WATER]);
				await sleep(1_000);
				await a.close();
				A = null;
				const [hb] = await untilQuiet([b], e2Chunks, 15_000, 240_000);
				check(hb === r.hash, `B's hash after A left equals the reference (B ${hb}, reference ${r.hash})`);
			});
		}

		// A comes back for everything after E2 (it left in E2).
		if (needMp && A === null && ['E3', 'E5', 'E6', '4009'].some(want)) {
			A = await newPage(ctxA, A_WHO, 'A');
			await joinWorld(A, BASE, WORLD, '10 min');
			await sleep(1_500);
		}

		// ------------------------------------------------------------------ E3
		if (want('E3') && A && B) {
			const a = A, b = B;
			await scenario('E3', 'A ignites TNT next to a pond: A, B and the reference end identical; B saw fx:boom', async () => {
				await loadBlocks(a);
				await loadBlocks(b);
				const { WATER, TNT } = await b.evaluate(() => ({ WATER: (window as any).__blocks.WATER as number, TNT: (window as any).__blocks.BLOCK_BY_NAME.tnt.id as number }));
				// Away from E2's pond: both walk (teleport) 56 blocks east and let the chunks stream in.
				const a0 = await pos(a);
				const pa = await standAt(a, Math.floor(a0[0]) + 56, Math.floor(a0[2]));
				await standAt(b, Math.floor(pa[0]) + 4, Math.floor(pa[2]));
				await sleep(1_000);
				await waitInGame(a);
				await waitInGame(b);
				await b.evaluate(() => { (window as any).__e3base = (window as any).__mc.mp.overlayCells(); });
				let full: { hash: string; settledAt: number; writes: number } | null = null;
				let pondOnly = '';
				const avoid = e2Chunks.length ? [e2Chunks[4]] : [];
				const spot = await findSpot([b, a], pa[0], pa[2], avoid, async (s) => {
					const chunks = chunksAround(s.x, s.z);
					// Both players stand outside the blast radius + 2: the reference needs no player box.
					const player = [s.x + 1 + 8.5, s.y + 1, s.z + 0.5];
					const pond = [
						{ t: 0, kind: 'set', x: s.x + 1, y: s.y, z: s.z, id: TNT },
						{ t: 0, kind: 'set', x: s.x, y: s.y, z: s.z, id: WATER },
					];
					const settled = await reference(b, pond, chunks, player, '__e3base');
					if (!settled) return false;
					pondOnly = settled.hash;
					full = await reference(b, [...pond, { t: settled.settledAt, kind: 'ignite', x: s.x + 1, y: s.y, z: s.z }], chunks, player, '__e3base');
					return full !== null;
				});
				const r = full as unknown as { hash: string; settledAt: number; writes: number };
				const chunks = chunksAround(spot.x, spot.z);
				const tnt = { x: spot.x + 1, y: spot.y, z: spot.z };
				console.log(`   pond (${spot.x}, ${spot.y}, ${spot.z}), TNT at (${tnt.x}, ${tnt.y}, ${tnt.z}); reference settles at ${r.settledAt.toFixed(1)} s`);
				check(r.hash !== pondOnly, `the blast changes the reference (pond only ${pondOnly}, after the blast ${r.hash})`);
				await standAt(a, tnt.x - 8, tnt.z);
				await standAt(b, tnt.x + 8, tnt.z);
				await sleep(1_000);
				await a.evaluate(([tx, ty, tz, tid, wx, wy, wz, wid]) => {
					const { world } = (window as any).__mc;
					world.setBlock(tx, ty, tz, tid);
					world.setBlock(wx, wy, wz, wid);
				}, [tnt.x, tnt.y, tnt.z, TNT, spot.x, spot.y, spot.z, WATER]);
				await untilQuiet([a, b], chunks, 6_000, 120_000);
				const primed = await a.evaluate((t) => (window as any).__mc.loop.ignite({ x: t.x, y: t.y, z: t.z, face: 'py', distance: 1 }, 0) as boolean, tnt);
				check(primed, 'A primed the TNT');
				const [ha, hb] = await untilQuiet([a, b], chunks, 15_000, 240_000);
				check(ha === hb, `A's crater equals B's (A ${ha}, B ${hb})`);
				check(ha === r.hash && hb === r.hash, `both equal the single-client reference (${r.hash})`);
				const boom = await b.evaluate((t) => (window as any).__mc.mp.log.some((m: any) => m.t === 'fx' && m.kind === 'boom' && m.x === t.x && m.y === t.y && m.z === t.z), tnt);
				check(boom, "B's log shows an fx boom at the TNT");
				const tntGone = await b.evaluate((t) => (window as any).__mc.world.getBlock(t.x, t.y, t.z) !== (window as any).__blocks.BLOCK_BY_NAME.tnt.id, tnt);
				check(tntGone, 'the TNT is gone on B');
			});
		}

		// ------------------------------------------------------------------ E6
		if (want('E6') && A && B) {
			const a = A;
			await scenario('E6', 'the server dies mid-game: A rejoins where it was, world and timer intact', async () => {
				const playtime = await a.evaluate(() => (window as any).__mc.playtime !== null);
				check(playtime, 'A has a play timer (10 min)');
				// Not the full 10 min, so a session handed out fresh by the reload cannot pass.
				await a.evaluate(() => (window as any).__mc.playtime.setRemaining(500_000));
				check(await a.evaluate(() => localStorage.getItem('minicraft:v1:pin')) === null, 'no PIN is set');

				for (const signal of ['TERM', 'KILL'] as const) {
					console.log(`   -- pass with SIG${signal}`);
					const b0 = await pos(B!);
					const spot = await standAt(a, Math.floor(b0[0]) + (signal === 'TERM' ? 24 : -24), Math.floor(b0[2]) + 4);
					// Stand still at least 3 s (the per-second flush has it), then record.
					await sleep(3_500);
					const before = await a.evaluate(() => {
						const m = (window as any).__mc;
						return { pos: [...m.player.position], left: m.playtime.remainingMs() as number, inv: JSON.stringify(m.player.inventory) };
					});
					const chunks = chunksAround(before.pos[0], before.pos[2]);
					const hashBefore = await hashOf(a, chunks);
					check(distXZ(before.pos, b0) > 20, `A stands more than 20 blocks from B (${distXZ(before.pos, b0).toFixed(1)})`);
					check(dist3(before.pos, spot) < 0.1, 'A stands still where it was put');
					if (signal === 'KILL') await sleep(1_000);
					await a.evaluate(() => { (window as any).__marker = 1; });
					await B!.evaluate(() => { (window as any).__marker = 1; });
					// Hold A's reconnect probe (and so its reload and its /ws upgrade) until B is back.
					let release!: () => void;
					const released = new Promise<void>((r) => { release = r; });
					let held = 0;
					const hold = async (route: import('playwright').Route) => {
						held++;
						await released;
						await route.fallback().catch(() => undefined);
					};
					await a.route(`${MP_URL}/worlds*`, hold);
					// The time left is read at the kill (the position a second before it, on the KILL pass).
					const leftAtKill = await a.evaluate(() => (window as any).__mc.playtime.remainingMs() as number);
					const tKill = Date.now();
					const ms = await killMc(signal);
					console.log(`   mcserver exited ${ms} ms after SIG${signal}`);
					await a.waitForSelector('#mp-reconnecting', { timeout: 10_000 });
					console.log(`   A shows Reconnecting ${Date.now() - tKill} ms after the signal`);
					check((await a.locator('#mp-reconnecting').innerText()).includes('Reconnecting'), 'A shows the Reconnecting overlay');
					await startMc();
					await B!.waitForFunction(() => (window as any).__marker === undefined && (window as any).__mc?.mp != null, null, { timeout: 45_000 });
					check(true, 'B reconnected (reloaded and got its welcome) first');
					check(await a.evaluate(() => (window as any).__marker === 1), `A is still waiting (its probe held, ${held} request(s))`);
					release();
					await a.unroute(`${MP_URL}/worlds*`, hold);
					// The time left the moment the rejoined game exists (before any play time accrues on it).
					const leftAtRejoin = await (await a.waitForFunction(() => {
						const m = (window as any).__mc;
						return (window as any).__marker === undefined && m?.mp != null ? (m.playtime ? m.playtime.remainingMs() as number : -1) : false;
					}, null, { timeout: 45_000, polling: 20 })).jsonValue() as number;
					await a.waitForFunction(() => !document.querySelector('#mp-reconnecting'), null, { timeout: 10_000 });
					await waitInGame(a);
					const after = await a.evaluate(() => {
						const m = (window as any).__mc;
						return { pos: [...m.player.position], left: m.playtime ? (m.playtime.remainingMs() as number) : null, inv: JSON.stringify(m.player.inventory), aj: sessionStorage.getItem('mp:autojoin') };
					});
					const b1 = await pos(B!);
					check(dist3(after.pos, before.pos) <= 1, `A is back within 1 block of where it was (${dist3(after.pos, before.pos).toFixed(2)} blocks)`);
					check(distXZ(after.pos, b1) > 10, `A is not put next to B (${distXZ(after.pos, b1).toFixed(1)} blocks from B)`);
					check(after.inv === before.inv, `A has the same inventory counts (${after.inv === before.inv ? 'same' : `${before.inv} → ${after.inv}`})`);
					check(leftAtRejoin >= 0 && Math.abs(leftAtRejoin - leftAtKill) <= 2_000, `A's remaining time is unchanged ±2 s (${leftAtKill} ms at the kill → ${leftAtRejoin} ms at the rejoin; ${after.left} ms once streamed in)`);
					check(after.aj !== null, 'the autojoin flag is still set while playing');
					const hashAfter = await hashOf(a, chunks);
					check(hashAfter === hashBefore && hashAfter !== null, `the world around A is unchanged (${hashBefore} → ${hashAfter})`);
				}

				// The server goes away for good: Reconnecting, then Try again → the sleeping screen.
				await killMc('KILL');
				await a.waitForSelector('#mp-reconnecting', { timeout: 10_000 });
				await a.waitForSelector('#mp-try-again', { timeout: 40_000 });
				check(true, 'after 30 s A offers Try again');
				await a.click('#mp-try-again');
				await a.waitForSelector('#mp-sleeping:not(.hidden)', { timeout: 20_000 });
				check((await a.locator('#mp-sleeping').innerText()).includes('The multiplayer server is sleeping. Ask a parent to wake it up.'), 'Try again with the server down shows the sleeping text');
			});
		}

		// ------------------------------------------------------------------ E7 (part 2) + P3's deferred step
		if (want('E7')) {
			await scenario('E7b', 'multiplayer server down: Single Player still plays; Multiplayer sleeps, then wakes by itself', async () => {
				if (mc) await killMc('KILL');
				startVite(VITE_DEAD_PORT);
				await waitHttp(BASE2);
				const ctx = await browser.newContext();
				const solo = await newPage(ctx, null, 'solo-dead');
				await soloPlay(solo, BASE2);
				check(await solo.evaluate(() => (window as any).__wsCount as number) === 0, 'solo with the multiplayer URL on a dead port: no WebSocket, and the world loads');
				const multi = await newPage(ctx, { name: 'Cy', skin: 'green' }, 'multi-dead');
				await multi.goto(BASE2);
				await multi.click('#home-multi');
				await multi.waitForSelector('#mp-sleeping:not(.hidden)', { timeout: 15_000 });
				check((await multi.locator('#mp-sleeping').innerText()).includes('The multiplayer server is sleeping. Ask a parent to wake it up.'), 'the Multiplayer screen says sleeping');
				// P3's deferred smoke step: start mcserver on that port; the list appears within 6 s, no click.
				await startMc();
				const woke = Date.now();
				const shown = await multi.waitForSelector('#mp-worlds .world-row', { timeout: 6_000 }).then(() => true, () => false);
				check(shown, `the world list appears ${Date.now() - woke} ms after mcserver starts, with no click (limit 6 s)`);
				check(await multi.locator('#mp-sleeping').isHidden(), 'the sleeping text is gone');
				if (A && await A.locator('#mp-sleeping').count() > 0) {
					const a = A;
					const aShown = await a.waitForSelector(`#mp-worlds .world-row.selected[data-id="${WORLD}"]`, { timeout: 6_000 }).then(() => true, () => false);
					check(aShown, "A's sleeping screen woke too, with A's world preselected");
				}
				check(await multi.evaluate(() => (window as any).__wsCount as number) === 0, 'the Multiplayer screen opened no WebSocket');
				await ctx.close();
			});
		}

		// Everyone back in for the 4009 step and E5.
		if (['4009', 'E5', 'E8'].some(want) && needMp) {
			if (!mc) await startMc();
			for (const [label, who, dur] of [['A', A_WHO, '10 min'], ['B', B_WHO, null]] as const) {
				let p = label === 'A' ? A : B;
				const inGame = p ? await p.evaluate(() => (window as any).__mc?.mp != null && !document.querySelector('#mp-reconnecting')).catch(() => false) : false;
				if (inGame) continue;
				if (p && await p.locator('#mp-try-again').count() > 0) {
					await p.click('#mp-try-again');
					await waitInGame(p).catch(() => undefined);
					if (await p.evaluate(() => (window as any).__mc?.mp != null).catch(() => false)) continue;
				}
				if (!p) p = await newPage(label === 'A' ? ctxA : ctxB, who, label);
				await joinWorld(p, BASE, WORLD, dur);
				if (label === 'A') A = p;
				else B = p;
			}
			await sleep(1_500);
		}

		// ------------------------------------------------------------------ 4009
		if (want('4009') && A && B) {
			const a = A;
			await scenario('4009', "a second computer using A's name is told to pick another; A is untouched", async () => {
				await a.evaluate(() => { (window as any).__marker = 1; });
				const ctx = await browser.newContext();
				const c = await newPage(ctx, { name: A_WHO.name, skin: 'green' }, 'C');
				await c.goto(BASE);
				await c.click('#home-multi');
				await c.waitForSelector(`#mp-worlds .world-row[data-id="${WORLD}"]`, { timeout: 15_000 });
				await c.click(`#mp-worlds .world-row[data-id="${WORLD}"]`);
				await c.click('#mp-play');
				await c.waitForSelector('#mp-name-error', { timeout: 20_000 });
				check((await c.locator('#mp-name-error').innerText()).includes(`Someone called ${A_WHO.name} is already playing. Pick another name.`), 'screen 1 says the name is taken');
				await sleep(3_000);
				const st = await c.evaluate(() => ({ ws: (window as any).__wsCount, aj: sessionStorage.getItem('mp:autojoin'), err: sessionStorage.getItem('mp:error') }));
				check(st.ws === 0, `after the 4009 reload: ${st.ws} WebSocket constructions (no reconnect loop)`);
				check(st.aj === null, 'the autojoin flag is cleared');
				check(await a.evaluate(() => (window as any).__marker === 1 && (window as any).__mc.mp != null && !document.querySelector('#mp-reconnecting')), 'A was never kicked (no reload, no Reconnecting)');
				await ctx.close();
			});
		}

		// ------------------------------------------------------------------ E8
		if (want('E8')) {
			await scenario('E8', 'a plain reload discards the stored session without a PIN, keeps it with one', async () => {
				const ctx = await browser.newContext();
				const p = await newPage(ctx, null, 'E8');
				await p.goto(BASE);
				await p.waitForSelector('#home-single');
				const store = (pin: string | null) => p.evaluate((pin) => {
					const now = Date.now();
					localStorage.setItem('minicraft:v1:playtime', JSON.stringify({ limitMs: 600_000, breakMs: null, playedMs: 120_000, frozenAt: null, startedAt: now, updatedAt: now }));
					if (pin) localStorage.setItem('minicraft:v1:pin', pin);
					else localStorage.removeItem('minicraft:v1:pin');
				}, pin);
				await store(null);
				await p.reload();
				await p.waitForSelector('#home-single');
				check(await p.evaluate(() => localStorage.getItem('minicraft:v1:playtime')) === null, 'no PIN: the reload discarded the session');
				await store('4321');
				await p.reload();
				await p.waitForSelector('#home-single');
				const kept = await p.evaluate(() => localStorage.getItem('minicraft:v1:playtime'));
				check(kept !== null && JSON.parse(kept).playedMs === 120_000, 'with a PIN: the reload kept the session');
				await ctx.close();
			});
		}

		// ------------------------------------------------------------------ E5
		if (want('E5') && A && B) {
			const a = A, b = B;
			await scenario('E5', "A's time runs out: B gets the toasts and \"went home\"; only A sees 10…1", async () => {
				check(await a.evaluate(() => (window as any).__mc.playtime !== null), 'A has a play timer');
				await b.evaluate(() => {
					const w = window as any;
					w.__toasts = [];
					w.__bigCountdown = false;
					w.__logStart = w.__mc.mp.log.length;
					new MutationObserver(() => {
						for (const el of document.querySelectorAll('#mp-toasts .mp-toast-text')) {
							const t = el.textContent ?? '';
							if (!w.__toasts.includes(t)) w.__toasts.push(t);
						}
						if (document.getElementById('mp-countdown')) w.__bigCountdown = true;
					}).observe(document.body, { childList: true, subtree: true, characterData: true });
				});
				await a.evaluate(() => {
					const w = window as any;
					w.__seen = [];
					const note = () => {
						const el = document.getElementById('mp-countdown');
						const n = el ? Number(el.textContent) : NaN;
						if (Number.isFinite(n) && !w.__seen.includes(n)) w.__seen.push(n);
					};
					new MutationObserver(note).observe(document.body, { childList: true, subtree: true, characterData: true });
					w.__mc.playtime.setRemaining(125_000);
				});
				const t0 = Date.now();
				// Real time: 125 s, then the freeze, the close and the relay.
				await b.waitForFunction((name) => (window as any).__toasts.includes(`${name} went home`), A_WHO.name, { timeout: 160_000, polling: 500 });
				console.log(`   "went home" after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
				await sleep(3_000);
				const got = await b.evaluate(() => {
					const w = window as any;
					return {
						msgs: w.__mc.mp.log.slice(w.__logStart).filter((m: any) => m.t === 'leaving' || m.t === 'left').map((m: any) => (m.t === 'leaving' ? `leaving ${m.secondsLeft}` : 'left')),
						toasts: w.__toasts as string[],
						big: w.__bigCountdown as boolean,
					};
				});
				check(JSON.stringify(got.msgs) === JSON.stringify(['leaving 120', 'leaving 60', 'leaving 30', 'leaving 0', 'left']), `B received leaving 120, 60, 30, 0 then left (${JSON.stringify(got.msgs)})`);
				const i2 = got.toasts.indexOf(`${A_WHO.name} has to go in 2 minutes`);
				const iHome = got.toasts.indexOf(`${A_WHO.name} went home`);
				check(i2 >= 0 && iHome > i2, `B's screen showed "…has to go in 2 minutes", then "…went home" (${JSON.stringify(got.toasts)})`);
				check(!got.big, 'B never had a big countdown');
				const seen = await a.evaluate(() => (window as any).__seen as number[]);
				const all = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].every((n) => seen.includes(n));
				check(all, `A showed the big 10…1 (${JSON.stringify(seen)})`);
				check(await a.evaluate(() => sessionStorage.getItem('mp:autojoin')) === null, 'A cleared its autojoin flag at 0');
			});
		}
	} finally {
		await browser.close().catch(() => undefined);
		stopAll();
	}

	if (offHost.length) {
		console.log(`FAIL a page tried to leave localhost: ${JSON.stringify(offHost)}`);
		results.push({ id: 'guard', ok: false, notes: offHost });
	}
	console.log('\n== summary');
	for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id}`);
	const ok = results.length > 0 && results.every((r) => r.ok);
	console.log(ok ? 'mp-e2e: PASS' : 'mp-e2e: FAIL');
	process.exit(ok ? 0 : 1);
})().catch((e) => {
	console.error(e);
	stopAll();
	process.exit(1);
});

/** Single Player → New World → Create → Play; resolves when the world has streamed in. */
async function soloPlay(p: Page, base: string): Promise<void> {
	await p.goto(base);
	await p.click('#home-single');
	await p.click('#single-new');
	await p.fill('#w-name', 'Solo');
	await p.fill('#w-seed', '3');
	await p.click('#w-create');
	await p.waitForSelector('#single-worlds .world-row.selected');
	await p.click('#single-play');
	await p.waitForFunction(() => (window as any).__mc !== undefined, null, { timeout: 60_000 });
	await p.waitForFunction(() => (window as any).__mc.loop.stats.streamQueue === 0, null, { timeout: 60_000 });
}
