// scripts/perf-bench.ts — the browser benchmark of the performance spec (§6.5).
//
//   npm run perf:bench [-- --reps 6] [--phases still,walk,fly,load,edit,memory,craft] [--port 5174]
//
// Starts a Vite dev server on --port with VITE_MINICRAFT_API_URL pointed at a dead local port
// (never the production save API), drives a headed Chromium through Playwright, creates a new
// seed-3 world per repetition, runs each phase REPS times (first repetition = warm-up, median of
// the rest), prints the spec §1 table as markdown, writes bench-out/<timestamp>.json and exits 1
// when a gated target is missed. Exit 2 = the page tried to reach a non-localhost host (aborted).
import { UNMOUNT_RADIUS, DATA_RADIUS } from '../src/engine/world/radii';
import { chromium, type Page, type CDPSession } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawnV3 } from '../src/engine/world/v3/spawn';
import { BLOCK_BY_NAME, BLOCKS, isSolid, isLiquid } from '../src/data/blocks.data';

function arg(name: string, def: string) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : def;
}

const PORT = Number(arg('--port', '5174'));
const REPS = Number(arg('--reps', '6'));
const PHASES = arg('--phases', 'still,walk,fly,load,edit,memory,craft').split(',');
const SEED = 3;
const GATES = {
	walkLongTaskMs: 100, walkOver50: 0,
	flyLongTaskMs: 400, flyOver50: 5,
	editInteriorMs: 20, editEdgeMs: 50,
	// ring arithmetic from the radii, not tuned numbers: (2r+1)² chunks
	heapMB: 250, mounted: (2 * UNMOUNT_RADIUS + 1) ** 2, data: (2 * DATA_RADIUS + 1) ** 2 /* + modified, read at run time */,
	walkMinBlocks: 40, flyMinBlocks: 160,
	// Crafting rows (crafting spec §8): no frame over 50 ms, light work under 15 ms per frame, every bulk chunk
	// mounted within 16 frames of its edit. The dev box is faster than Noah's laptop: a value past the margin
	// (80 % of the gate) prints "thin" beside "ok".
	craftFrameMs: 50, craftLightMs: 15, craftBulkFrames: 16, craftMargin: 0.8,
};
const STONE = BLOCK_BY_NAME['stone'].id; // 3 in the frozen base catalog; never guess it
if (!(REPS >= 2)) throw new Error('--reps must be ≥ 2 (first repetition is warm-up)');

const median = (xs: number[]) => {
	if (xs.length === 0) throw new Error('median of nothing: --reps must be ≥ 2 (first repetition is warm-up)');
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
};

let stopDev: (() => void) | null = null;
async function startDev(): Promise<() => void> {
	const p = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
		env: { ...process.env, VITE_MINICRAFT_API_URL: 'http://127.0.0.1:9099' },
		stdio: 'ignore',
	});
	const stop = () => { spawn('fuser', ['-k', `${PORT}/tcp`], { stdio: 'ignore' }); p.kill(); };
	for (let i = 0; i < 60; i++) {
		if (p.exitCode !== null) throw new Error(`dev server exited with ${p.exitCode} (is port ${PORT} busy?)`);
		try { await fetch(`http://localhost:${PORT}/`); return stop; }
		catch { await new Promise((r) => setTimeout(r, 500)); }
	}
	stop();
	throw new Error('dev server did not start');
}

type Raw = { frames: { t: number; ms: number }[]; long: { t: number; ms: number }[] };

/** In-page instrumentation: rAF sampler + longtask observer. `window.__bench` is read and reset by the phases. */
const INSTRUMENT = `(() => {
	const S = { frames: [], long: [] };
	let last = performance.now();
	const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) S.long.push({ t: e.startTime, ms: e.duration }); });
	po.observe({ entryTypes: ['longtask'] });
	function f() { const n = performance.now(); S.frames.push({ t: n, ms: n - last }); last = n; requestAnimationFrame(f); }
	requestAnimationFrame(f);
	window.__bench = { reset() { S.frames = []; S.long = []; }, take() { return { frames: S.frames.slice(), long: S.long.slice() }; } };
})()`;

/**
 * Safety guard: a stray dev server on this port WITHOUT the env var would point at the production save API, and the menu
 * fetches the cloud world list BEFORE window.__mc exists, so the guard is a route hook registered before the first goto
 * (an in-page `import.meta.env` read is impossible: page.evaluate compiles a classic script → SyntaxError). Any request to
 * a host other than 127.0.0.1/localhost is aborted and the whole run stops with exit code 2.
 */
async function guardRequests(page: Page) {
	await page.route('**/*', (route) => {
		const url = route.request().url();
		const host = new URL(url).hostname;
		if (host === '127.0.0.1' || host === 'localhost') return route.continue();
		console.error(`perf-bench: ABORT — the page tried to reach ${url} (only 127.0.0.1/localhost are allowed; is a dev server on ${PORT} running without VITE_MINICRAFT_API_URL?)`);
		void route.abort();
		stopDev?.();
		process.exit(2);
	});
}

/** Navigates ONCE per call; every timestamp of a phase is then taken inside this same document (performance.now() is per-document). */
async function newWorld(page: Page, timed = false) {
	await guardRequests(page);
	// tsx (esbuild keepNames) wraps inner functions of the serialised page.evaluate callbacks in a `__name(fn, name)` helper
	// that does not exist in the page; give it an identity stub before any script of the document runs.
	await page.addInitScript('window.__name = (f) => f;');
	await page.goto(`http://localhost:${PORT}/`);
	await page.evaluate(INSTRUMENT);
	if (timed) await page.evaluate(() => { (window as unknown as { __benchT0: number }).__benchT0 = performance.now(); });
	// menu (src/ui/menu.ts): "New World" button → renderNew() card with #w-seed and a "Create" button
	await page.click('text=New World');
	await page.fill('#w-seed', String(SEED));
	await page.click('text=Create');
	await page.waitForFunction(() => (window as unknown as { __mc?: unknown }).__mc !== undefined);
	console.log('api:', await page.evaluate(() => (window as unknown as { __mc: { apiUrl?: string } }).__mc.apiUrl ?? '(no apiUrl on __mc: Task 7 adds it)')); // informational; the route guard is the safety property
	// Initial load done: the whole view ring mounted (≥ 81 = the 9×9 walk ring; Task 4 raises it to 121) and nothing queued.
	// `mounted ≥ 81` keeps the first poll from seeing the pre-first-tick 0 queue.
	await page.waitForFunction(() => {
		const mc = (window as unknown as { __mc: { loop: { stats: { streamQueue: number; mounted: number } } } }).__mc;
		return mc.loop.stats.streamQueue === 0 && mc.loop.stats.mounted >= 81;
	}, null, { timeout: 60_000 });
}

/** Load-phase variant: same single navigation, but t0/t1 are read in-page around the world creation and handed back with the raw samples. */
async function newWorldTimed(page: Page, cb: (t0: number, t1: number, raw: Raw, ready: number) => void) {
	await newWorld(page, true);
	const r = await page.evaluate(() => {
		const w = window as unknown as { __benchT0: number; __bench: { take(): Raw } };
		const ready = performance.getEntriesByName('minicraft:world-ready')[0]?.startTime ?? -1;
		return { t0: w.__benchT0, t1: performance.now(), raw: w.__bench.take(), ready };
	});
	if (!(r.ready > r.t0)) throw new Error('load phase: no minicraft:world-ready mark inside the window');
	cb(r.t0, r.t1, r.raw, r.ready);
}

/** `slow` lists every frame > 50 ms as (offset from t0 in ms, frame ms) — diagnostics only, first 20. */
type PhaseResult = { longTaskMs: number; over50: number; frames: number; fps: number; p95: number; travelled?: number; slow: { t: number; ms: number }[] };
function summarise(raw: Raw, t0: number, t1: number): PhaseResult {
	const fr = raw.frames.filter((f) => f.t >= t0 && f.t <= t1);
	const lt = raw.long.filter((l) => l.t >= t0 && l.t <= t1);
	const ms = fr.map((f) => f.ms).sort((a, b) => a - b);
	return {
		longTaskMs: lt.reduce((s, l) => s + l.ms, 0),
		over50: fr.filter((f) => f.ms > 50).length,
		frames: fr.length,
		fps: fr.length / ((t1 - t0) / 1000),
		p95: ms[Math.floor(ms.length * 0.95)] ?? 0,
		slow: fr.filter((f) => f.ms > 50).slice(0, 20).map((f) => ({ t: Math.round(f.t - t0), ms: Math.round(f.ms * 10) / 10 })),
	};
}

/**
 * Drives player.position directly (key events moved 0 blocks — spec R-B2).
 * 'still': touch nothing. 'walk': flying=false, y tracks the surface (+1) so ground rendering is exercised.
 * 'fly': flying=true, tier 5, y = 140 above the terrain (never inside stone).
 */
async function move(page: Page, mode: 'still' | 'walk' | 'fly', dirX: number, dirZ: number, bps: number, seconds: number): Promise<PhaseResult> {
	const r = await page.evaluate(async ({ mode, dirX, dirZ, bps, seconds }) => {
		const mc = (window as unknown as { __mc: { world: { getBlock(x: number, y: number, z: number): number }; player: { position: number[]; flying: boolean; flySpeedTier: number } } }).__mc;
		const b = (window as unknown as { __bench: { reset(): void; take(): Raw } }).__bench;
		const surfaceY = (x: number, z: number) => { for (let y = 255; y > 0; y--) if (mc.world.getBlock(Math.floor(x), y, Math.floor(z)) !== 0) return y; return 0; };
		if (mode === 'fly') { mc.player.flying = true; mc.player.flySpeedTier = 5; mc.player.position[1] = 140; }
		if (mode === 'walk') { mc.player.flying = false; }
		const start = mc.player.position.slice();
		b.reset();
		const t0 = performance.now();
		let last = t0;
		await new Promise<void>((done) => {
			const step = () => {
				const n = performance.now();
				const dt = (n - last) / 1000;
				last = n;
				if (mode !== 'still') {
					mc.player.position[0] += dirX * bps * dt;
					mc.player.position[2] += dirZ * bps * dt;
					if (mode === 'walk') mc.player.position[1] = surfaceY(mc.player.position[0], mc.player.position[2]) + 1;
				}
				if (n - t0 < seconds * 1000) requestAnimationFrame(step); else done();
			};
			requestAnimationFrame(step);
		});
		const t1 = performance.now();
		const raw = b.take();
		const travelled = Math.hypot(mc.player.position[0] - start[0], mc.player.position[2] - start[2]);
		return { raw, t0, t1, travelled };
	}, { mode, dirX, dirZ, bps, seconds });
	return { ...summarise(r.raw, r.t0, r.t1), travelled: r.travelled };
}

async function still(page: Page, seconds: number): Promise<PhaseResult> { return move(page, 'still', 0, 0, 0, seconds); }

/** Direction with the most land (column top ≥ 121 = above sea level) within 200 blocks of spawn, so walk/fly/memory stay over land. */
async function landDirection(page: Page): Promise<{ dirX: number; dirZ: number; name: string }> {
	return page.evaluate(() => {
		const mc = (window as unknown as { __mc: { world: { getBlock(x: number, y: number, z: number): number }; player: { position: number[] } } }).__mc;
		const top = (x: number, z: number) => { for (let y = 255; y > 0; y--) if (mc.world.getBlock(x, y, z) !== 0) return y; return 0; };
		const [px, , pz] = mc.player.position.map(Math.floor);
		const dirs = [{ dirX: 1, dirZ: 0, name: '+x' }, { dirX: -1, dirZ: 0, name: '-x' }, { dirX: 0, dirZ: 1, name: '+z' }, { dirX: 0, dirZ: -1, name: '-z' }];
		let best = dirs[0], bestLand = -1;
		for (const d of dirs) {
			let land = 0;
			for (let s = 8; s <= 200; s += 8) {
				const x = px + d.dirX * s, z = pz + d.dirZ * s;
				if (x < 24 || x > 487 || z < 24 || z > 487) break;
				if (top(x, z) >= 121) land++;
			}
			if (land > bestLand) { bestLand = land; best = d; }
		}
		return best;
	});
}

type EditResult = PhaseResult & { edge: number[]; interior: number[]; latencyMax: number };
async function edits(page: Page): Promise<EditResult> {
	const s = spawnV3(SEED);
	const edgeX = (Math.floor(s.x / 16) + 1) * 16; // chunk boundary nearest spawn in +x
	const r = await page.evaluate(async ({ edgeX, z0, STONE }) => {
		const mc = (window as unknown as { __mc: {
			world: { getBlock(x: number, y: number, z: number): number; setBlock(x: number, y: number, z: number, id: number): void };
			loop: { replaceBlock(hit: { x: number; y: number; z: number; face: string }, id: number, color: string): boolean; markChunkDirtyAround(x: number, z: number): void; applyLightUpdate(x: number, y: number, z: number): void; stats: { lastEditMs: number; lastEditWorkMs: number } };
		} }).__mc;
		const b = (window as unknown as { __bench: { reset(): void; take(): Raw } }).__bench;
		const surfaceY = (x: number, z: number) => { for (let y = 255; y > 0; y--) if (mc.world.getBlock(x, y, z) !== 0) return y; return 0; };
		const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		// One edit = replace the SOLID surface block (canReplace refuses air), then break it. Each is asserted to have happened.
		const editAt = async (x: number, z: number, into: number[]) => {
			const y = surfaceY(x, z);
			mc.loop.stats.lastEditMs = -1; mc.loop.stats.lastEditWorkMs = -1;
			if (!mc.loop.replaceBlock({ x, y, z, face: 'py' }, STONE, '#ffffff')) throw new Error(`replaceBlock refused at ${x},${y},${z}`);
			await frame(); await frame();
			if (!(mc.loop.stats.lastEditMs > 0)) throw new Error(`place at ${x},${z}: no edit mounted`);
			into.push(mc.loop.stats.lastEditWorkMs); lat.push(mc.loop.stats.lastEditMs);
			mc.loop.stats.lastEditMs = -1; mc.loop.stats.lastEditWorkMs = -1;
			mc.world.setBlock(x, y, z, 0); mc.loop.markChunkDirtyAround(x, z); mc.loop.applyLightUpdate(x, y, z);
			await frame(); await frame();
			if (!(mc.loop.stats.lastEditMs > 0)) throw new Error(`break at ${x},${z}: no edit mounted`);
			into.push(mc.loop.stats.lastEditWorkMs); lat.push(mc.loop.stats.lastEditMs);
		};
		const edge: number[] = [], interior: number[] = [], lat: number[] = [];
		b.reset();
		const t0 = performance.now();
		for (let k = 0; k < 20; k++) await editAt(edgeX - 1, z0 + k, edge);       // 20 on the boundary column (lx = 15): place + break = 40 edits
		const zBase = Math.floor(z0 / 16) * 16 + 3;                                 // anchored to the chunk: lz runs 3..12, never straddling a z boundary
		for (let k = 0; k < 10; k++) await editAt(edgeX - 8, zBase + k, interior);  // 10 interior (≥ 3 blocks from any boundary): 20 edits
		const t1 = performance.now();
		return { raw: b.take(), t0, t1, edge, interior, latencyMax: Math.max(...lat) };
	}, { edgeX, z0: Math.floor(s.z), STONE });
	return { ...summarise(r.raw, r.t0, r.t1), edge: r.edge, interior: r.interior, latencyMax: r.latencyMax };
}

/**
 * Crafting rows (crafting spec §8). Each row is a blast or an area-mining run at a fixed site near the seed-3 spawn, run
 * once per repetition in a fresh world. Sites are chunk offsets from the spawn chunk, 2–6 chunks out (inside the mounted
 * ring, clear of the player and of each other). `corner` puts the origin on a chunk corner (lx = lz = 0) or, for the
 * tunnel, the 5-wide cross-section across a z boundary.
 *
 * `real: true` places `blockId` at every origin and ignites the first with loop.ignite: the game's own TNT path.
 * `real: false` is the radius-8 STAND-IN while no radius-8 block exists: the bench computes detonate()'s cell set
 * itself (origin + every solid, hardness > 0, non-TNT cell within `radius`) and removes it through the build's removal
 * path, one origin every TNT_CHAIN_FUSE (0.1 s), the chain's real rhythm. Phase D switches MEGA to the real block.
 */
type CraftRowDef =
	| { name: string; kind: 'tnt'; dcx: number; dcz: number; corner: boolean; radius: number; count: number; step: [number, number]; real: boolean; blockId: number }
	| { name: string; kind: 'area'; dcx: number; dcz: number; corner: boolean; swings: number; everyMs: number };
const PLAIN_TNT = BLOCK_BY_NAME['tnt'].id;
/** Radius-8 rows. Stand-in until a radius-8 block exists (Phase D: `real: true, blockId: BLOCK_BY_NAME['mega_tnt'].id`). */
const MEGA = { radius: 8, real: true, blockId: BLOCK_BY_NAME['mega_tnt'].id };
const CRAFT_ROWS: CraftRowDef[] = [
	{ name: 'TNT r3 interior', kind: 'tnt', dcx: -3, dcz: -3, corner: false, radius: 3, count: 1, step: [0, 0], real: true, blockId: PLAIN_TNT },
	{ name: 'TNT r3 corner', kind: 'tnt', dcx: -3, dcz: 0, corner: true, radius: 3, count: 1, step: [0, 0], real: true, blockId: PLAIN_TNT },
	{ name: 'area 5×5×5 ×10 held interior', kind: 'area', dcx: 3, dcz: 2, corner: false, swings: 10, everyMs: 250 },
	{ name: 'area 5×5×5 ×10 held corner', kind: 'area', dcx: 3, dcz: -3, corner: true, swings: 10, everyMs: 250 },
	{ name: 'Mega r8 interior', kind: 'tnt', dcx: -3, dcz: 3, corner: false, count: 1, step: [0, 0], ...MEGA },
	{ name: 'Mega r8 corner', kind: 'tnt', dcx: 3, dcz: 0, corner: true, count: 1, step: [0, 0], ...MEGA },
	{ name: 'Mega r8 chain ×4 interior', kind: 'tnt', dcx: -5, dcz: -2, corner: false, count: 4, step: [0, 6], ...MEGA },
	{ name: 'Mega r8 chain ×4 corner', kind: 'tnt', dcx: -1, dcz: 4, corner: true, count: 4, step: [6, 0], ...MEGA },
];
/** detonate()'s and removeBlocks' rule: solid with hardness > 0 (skips air, liquids, bedrock). */
const REMOVABLE = BLOCKS.map((b) => !!b && isSolid(b.id) && b.hardness > 0);
const LIQUID = BLOCKS.map((b) => !!b && isLiquid(b.id));

type CraftRow = PhaseResult & { name: string; maxFrame: number; lightMax: number; bulkMax: number; bulkLane: boolean; removed: number; expected: number; events: number[]; eventMs: number[] };
type CraftResult = { rows: CraftRow[] };

async function crafting(page: Page): Promise<CraftResult> {
	const s = spawnV3(SEED);
	const pcx = Math.floor(s.x / 16), pcz = Math.floor(s.z / 16);
	const rows: CraftRow[] = [];
	for (const def of CRAFT_ROWS) {
		const r = await page.evaluate(async ({ def, pcx, pcz, REMOVABLE, LIQUID }) => {
			type Cell = { x: number; y: number; z: number };
			const mc = (window as unknown as { __mc: {
				world: { getBlock(x: number, y: number, z: number): number; setBlock(x: number, y: number, z: number, id: number): void };
				loop: {
					ignite(hit: { x: number; y: number; z: number; face: string; distance: number }): boolean;
					markChunkDirtyAround(x: number, z: number): void;
					applyLightUpdate(x: number, y: number, z: number): void;
					removeBlocks?: (cells: Cell[], anchor: Cell) => { removed: unknown[] };
					bulkLane?: Set<number>;
					stats: { editQueue: number; lightMs?: number };
				};
			} }).__mc;
			const b = (window as unknown as { __bench: { reset(): void; take(): Raw } }).__bench;
			const { world, loop } = mc;
			const raf = () => new Promise<number>((res) => requestAnimationFrame(res));
			// Light work: Phase A keeps a cumulative stats.lightMs; before it, every removal went through applyLightUpdate.
			let lightAcc = 0;
			if (loop.stats.lightMs === undefined) {
				const orig = loop.applyLightUpdate.bind(loop);
				loop.applyLightUpdate = (x, y, z) => { const t = performance.now(); orig(x, y, z); lightAcc += performance.now() - t; };
			}
			const lightNow = () => loop.stats.lightMs ?? lightAcc;
			// The build's batched removal path: removeBlocks when it exists, else today's detonateAt loop verbatim.
			const remove = (cells: Cell[], anchor: Cell) => {
				if (loop.removeBlocks) { loop.removeBlocks(cells, anchor); return; }
				for (const c of cells) {
					if (!REMOVABLE[world.getBlock(c.x, c.y, c.z)]) continue;
					world.setBlock(c.x, c.y, c.z, 0);
					loop.markChunkDirtyAround(c.x, c.z);
					loop.applyLightUpdate(c.x, c.y, c.z);
				}
			};
			const top = (x: number, z: number) => { for (let y = 255; y > 0; y--) { const id = world.getBlock(x, y, z); if (id !== 0 && !LIQUID[id]) return y; } return 0; };
			const sphere = (o: Cell, r: number) => {
				const out: Cell[] = [];
				for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
					if (dx * dx + dy * dy + dz * dz > r * r) continue;
					const x = o.x + dx, y = o.y + dy, z = o.z + dz;
					if (x < 0 || x > 511 || z < 0 || z > 511 || y < 0 || y > 255) continue;
					out.push({ x, y, z });
				}
				return out;
			};
			const cx = pcx + def.dcx, cz = pcz + def.dcz;
			const bx = cx * 16 + (def.corner ? 0 : 8), bz = cz * 16 + (def.corner ? 0 : 8);
			// events[k] = the frame of the k-th blast or swing; `due(frame, now)` runs the emulated ones inside a rAF callback.
			const events: number[] = [];
			const expected: Cell[] = [];
			let due: (frame: number, now: number) => void = () => {};
			let done: () => boolean = () => true;
			let arm: () => void = () => {};
			if (def.kind === 'tnt') {
				const origins: Cell[] = [];
				for (let k = 0; k < def.count; k++) {
					const x = bx + def.step[0] * k, z = bz + def.step[1] * k;
					origins.push({ x, y: top(x, z) - 2, z });
				}
				for (const o of origins) { world.setBlock(o.x, o.y, o.z, def.blockId); loop.markChunkDirtyAround(o.x, o.z); loop.applyLightUpdate(o.x, o.y, o.z); }
				const seen = new Set<string>();
				for (const o of origins) for (const c of sphere(o, def.radius)) {
					const k = `${c.x},${c.y},${c.z}`;
					if (seen.has(k)) continue;
					seen.add(k);
					const id = world.getBlock(c.x, c.y, c.z);
					if (REMOVABLE[id]) expected.push(c);
				}
				const gone = (o: Cell) => world.getBlock(o.x, o.y, o.z) !== def.blockId;
				done = () => origins.every(gone);
				if (def.real) {
					arm = () => { if (!loop.ignite({ ...origins[0], face: 'py', distance: 1 })) throw new Error(`${def.name}: ignite refused`); };
					due = (frame) => { while (events.length < origins.length && gone(origins[events.length])) events.push(frame); };
				} else {
					let t0 = -1;
					due = (frame, now) => {
						if (t0 < 0) t0 = now;
						while (events.length < origins.length && now - t0 >= 100 * events.length) {
							const o = origins[events.length];
							const cells = sphere(o, def.radius).filter((c) => (c.x === o.x && c.y === o.y && c.z === o.z) || (world.getBlock(c.x, c.y, c.z) !== def.blockId && REMOVABLE[world.getBlock(c.x, c.y, c.z)]));
							remove(cells, o);
							events.push(frame);
						}
					};
				}
			} else {
				// Tunnel along −x (depth runs away from a player standing at +x), 5 wide in z, 5 high, 10 swings.
				let minTop = 255;
				for (let x = bx - 5 * def.swings; x <= bx; x++) minTop = Math.min(minTop, top(x, bz));
				const yc = minTop - 12;
				const boxes: { cells: Cell[]; anchor: Cell }[] = [];
				for (let k = 0; k < def.swings; k++) {
					const x1 = bx - 5 * k, cells: Cell[] = [];
					for (let x = x1; x > x1 - 5; x--) for (let y = yc - 2; y <= yc + 2; y++) for (let z = bz - 2; z <= bz + 2; z++) cells.push({ x, y, z });
					boxes.push({ cells, anchor: { x: x1, y: yc, z: bz } });
					for (const c of cells) if (REMOVABLE[world.getBlock(c.x, c.y, c.z)]) expected.push(c);
				}
				let t0 = -1;
				due = (frame, now) => {
					if (t0 < 0) t0 = now;
					if (events.length < boxes.length && now - t0 >= def.everyMs * events.length) {
						const { cells, anchor } = boxes[events.length];
						remove(cells, anchor);
						events.push(frame);
					}
				};
				done = () => events.length === boxes.length;
			}
			// Settle the placement edits before the window opens.
			for (let k = 0; k < 30; k++) await raf();
			b.reset();
			const t0 = performance.now();
			arm();
			let frame = 0, lastLight = lightNow(), lightMax = 0, bulkMax = 0, quiet = 0, prevNow = -1;
			const enter = new Map<number, number>();
			const deltas: number[] = [];
			for (;;) {
				await raf();
				// performance.now(), not the rAF timestamp: rAF timestamps are vsync-aligned and hide a long frame (gate 2 measured 16.8 ms gaps against 30–40 ms real frames).
				const now = performance.now();
				frame++;
				deltas[frame] = prevNow < 0 ? 0 : now - prevNow;
				prevNow = now;
				due(frame, now);
				const l = lightNow();
				lightMax = Math.max(lightMax, l - lastLight);
				lastLight = l;
				const lane = loop.bulkLane; // Phase A's bulk lane (a private field; absent before Phase A)
				if (lane) {
					for (const i of lane) if (!enter.has(i)) enter.set(i, frame);
					for (const [i, f] of enter) if (!lane.has(i)) { bulkMax = Math.max(bulkMax, frame - f); enter.delete(i); }
				}
				const idle = (!lane || lane.size === 0) && loop.stats.editQueue === 0;
				quiet = done() && idle ? quiet + 1 : 0;
				if (quiet >= 10) break;
				if (performance.now() - t0 > 20_000) throw new Error(`${def.name}: did not finish in 20 s (${events.length} events)`);
			}
			for (const [, f] of enter) bulkMax = Math.max(bulkMax, frame - f);
			const t1 = performance.now();
			const removed = expected.filter((c) => { const id = world.getBlock(c.x, c.y, c.z); return id === 0 || LIQUID[id]; }).length;
			// The frame a blast or swing lands in, and the two after it (the loop's tick may run before or after this callback).
			const eventMs = events.map((f) => Math.max(deltas[f] ?? 0, deltas[f + 1] ?? 0, deltas[f + 2] ?? 0));
			return { raw: b.take(), t0, t1, lightMax, bulkMax, bulkLane: !!loop.bulkLane, removed, expected: expected.length, events, eventMs };
		}, { def, pcx, pcz, REMOVABLE, LIQUID });
		if (r.removed !== r.expected) throw new Error(`${def.name}: ${r.expected - r.removed} of ${r.expected} cells were not removed`);
		const sum = summarise(r.raw, r.t0, r.t1);
		const maxFrame = r.raw.frames.filter((f) => f.t >= r.t0 && f.t <= r.t1).reduce((m, f) => Math.max(m, f.ms), 0);
		rows.push({ ...sum, name: def.name, maxFrame, lightMax: r.lightMax, bulkMax: r.bulkMax, bulkLane: r.bulkLane, removed: r.removed, expected: r.expected, events: r.events, eventMs: r.eventMs });
	}
	return { rows };
}
type MemoryResult = { heapMB: number; mounted: number; data: number; modified: number };
async function memory(page: Page, cdp: CDPSession, dir: { dirX: number; dirZ: number }): Promise<MemoryResult> {
	await move(page, 'fly', dir.dirX, dir.dirZ, 25, 30);
	await still(page, 2);
	await cdp.send('HeapProfiler.collectGarbage');
	// usedSize EXCLUDES typed-array backing stores — which is everything the radii bound. Gate on both.
	const u = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number; backingStorageSize?: number };
	const st = await page.evaluate(() => {
		const mc = (window as unknown as { __mc: { world: { modifiedChunks(): unknown[] }; loop: { stats: { mounted: number; data: number } } } }).__mc;
		return { mounted: mc.loop.stats.mounted, data: mc.loop.stats.data, modified: mc.world.modifiedChunks().length };
	});
	return { heapMB: Math.round((u.usedSize + (u.backingStorageSize ?? 0)) / 1048576), mounted: st.mounted, data: st.data, modified: st.modified };
}

(async () => {
	stopDev = await startDev();
	const browser = await chromium.launch({ headless: false, args: ['--use-gl=angle'] });
	const out: Record<string, Record<string, unknown>[]> = {};
	let failed = false;
	try {
		for (const phase of PHASES) {
			const runs: Record<string, unknown>[] = [];
			for (let rep = 0; rep < REPS; rep++) {
				const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
				const cdp = await page.context().newCDPSession(page);
				if (phase === 'load') {
					// ONE navigation per repetition (fresh page + fresh world); t0 taken inside the final document, right after INSTRUMENT, before the menu clicks.
					await newWorldTimed(page, (t0, t1, raw, ready) => {
						const r = summarise(raw, t0, t1);
						// The gate covers streaming: tasks that START after the world exists (spawn search excluded, reported separately).
						const afterReady = raw.long.filter((l) => l.t >= ready).map((l) => l.ms);
						const beforeReady = raw.long.filter((l) => l.t < ready).map((l) => l.ms);
						runs.push({ ...r, wallMs: t1 - t0, worstAfterFirst: Math.max(0, ...afterReady), spawnTaskMs: Math.max(0, ...beforeReady) });
					});
				} else {
					await newWorld(page);
					// Settle: the initial load leaves ~80 MB of garbage that V8 collects on idle ~100 ms later as one 60 ms frame with no
					// long task (measured on the Task-1 tree: every still rep had exactly one, at t0 + 92 ms). That is the load's
					// garbage, not the phase's, so each phase starts from a collected, idle page.
					await cdp.send('HeapProfiler.collectGarbage');
					await still(page, 1);
					const dir = await landDirection(page);
					if (rep === 0) console.log(`# ${phase}: land direction ${dir.name}`);
					if (phase === 'still') runs.push(await still(page, 10));
					if (phase === 'walk') runs.push(await move(page, 'walk', dir.dirX, dir.dirZ, 5, 10));
					if (phase === 'fly') runs.push(await move(page, 'fly', dir.dirX, dir.dirZ, 25, 8));
					if (phase === 'edit') runs.push(await edits(page));
					if (phase === 'memory') runs.push(await memory(page, cdp, dir));
					if (phase === 'craft') runs.push(await crafting(page));
				}
				console.log(`# ${phase} rep ${rep}${rep === 0 ? ' (warm-up)' : ''}: ${JSON.stringify(runs[runs.length - 1], (k, v) => (k === 'edge' || k === 'interior' || k === 'slow' || k === 'events' || k === 'eventMs' ? undefined : typeof v === 'number' ? Math.round(v * 10) / 10 : v))}`);
				await page.close();
			}
			out[phase] = runs.slice(1); // first repetition is warm-up
		}
	} finally {
		await browser.close();
		stopDev();
	}
	mkdirSync('bench-out', { recursive: true });
	writeFileSync(`bench-out/${Date.now()}.json`, JSON.stringify(out, null, 2));
	const med = (phase: string, key: string) => median(out[phase].map((r) => r[key] as number));
	const rows: string[] = ['| Phase | long-task ms | frames > 50 ms | fps (info) | p95 ms (info) | gate |', '|---|---|---|---|---|---|'];
	const gate = (ok: boolean) => { if (!ok) failed = true; return ok ? 'ok' : 'FAIL'; };
	if (out.still) rows.push(`| still 10 s | ${med('still', 'longTaskMs').toFixed(0)} | ${med('still', 'over50')} | ${med('still', 'fps').toFixed(1)} | ${med('still', 'p95').toFixed(1)} | ${gate(med('still', 'over50') === 0)} |`);
	if (out.walk) {
		const trav = med('walk', 'travelled');
		rows.push(`| walk 5 b/s 10 s (${trav.toFixed(0)} blocks) | ${med('walk', 'longTaskMs').toFixed(0)} | ${med('walk', 'over50')} | ${med('walk', 'fps').toFixed(1)} | ${med('walk', 'p95').toFixed(1)} | ${gate(trav >= GATES.walkMinBlocks && med('walk', 'longTaskMs') <= GATES.walkLongTaskMs && med('walk', 'over50') <= GATES.walkOver50)} |`);
	}
	if (out.fly) {
		const trav = med('fly', 'travelled');
		rows.push(`| fly tier 5 8 s (${trav.toFixed(0)} blocks) | ${med('fly', 'longTaskMs').toFixed(0)} | ${med('fly', 'over50')} | ${med('fly', 'fps').toFixed(1)} | ${med('fly', 'p95').toFixed(1)} | ${gate(trav >= GATES.flyMinBlocks && med('fly', 'longTaskMs') <= GATES.flyLongTaskMs && med('fly', 'over50') <= GATES.flyOver50)} |`);
	}
	if (out.load) rows.push(`| initial load | ${med('load', 'longTaskMs').toFixed(0)} | ${med('load', 'over50')} | wall ${med('load', 'wallMs').toFixed(0)} ms | worst after world ready ${med('load', 'worstAfterFirst').toFixed(0)} (spawn search ${med('load', 'spawnTaskMs').toFixed(0)}, one-time) | ${gate(med('load', 'worstAfterFirst') <= 50)} |`);
	if (out.edit) {
		const E = out.edit as unknown as EditResult[];
		const edge = E.flatMap((r) => r.edge), interior = E.flatMap((r) => r.interior);
		rows.push(`| edits 40 edge + 20 interior | ${med('edit', 'longTaskMs').toFixed(0)} | ${med('edit', 'over50')} | work max edge ${Math.max(...edge).toFixed(1)} ms / interior ${Math.max(...interior).toFixed(1)} ms | click-to-mount max ${med('edit', 'latencyMax').toFixed(1)} ms (info) | ${gate(med('edit', 'over50') === 0 && Math.max(...edge) <= GATES.editEdgeMs && Math.max(...interior) <= GATES.editInteriorMs)} |`);
	}
	if (out.memory) {
		const modified = med('memory', 'modified');
		rows.push(`| memory after 30 s tier-5 flight | heap ${med('memory', 'heapMB')} MB (used + backing) | mounted ${med('memory', 'mounted')} | data ${med('memory', 'data')} (modified ${modified}) | — | ${gate(med('memory', 'heapMB') <= GATES.heapMB && med('memory', 'mounted') <= GATES.mounted && med('memory', 'data') <= GATES.data + modified)} |`);
	}
	if (out.craft) {
		const C = out.craft as unknown as CraftResult[];
		rows.push('', '| Crafting row | max frame ms (median / worst) | frames > 50 ms | light ms, worst frame | bulk frames, worst chunk | cells removed | gate |', '|---|---|---|---|---|---|---|');
		for (const def of CRAFT_ROWS) {
			const rs = C.map((c) => c.rows.find((x) => x.name === def.name)!);
			const mf = median(rs.map((x) => x.maxFrame)), worst = Math.max(...rs.map((x) => x.maxFrame));
			// Spec §8: no frame over 50 ms in ANY repetition, so gate on the worst, never the median.
			const over = Math.max(...rs.map((x) => x.over50)), light = Math.max(...rs.map((x) => x.lightMax)), bulk = Math.max(...rs.map((x) => x.bulkMax));
			const ok = over === 0 && light < GATES.craftLightMs && bulk <= GATES.craftBulkFrames;
			const thin = worst > GATES.craftFrameMs * GATES.craftMargin || light > GATES.craftLightMs * GATES.craftMargin || bulk > GATES.craftBulkFrames * GATES.craftMargin;
			const bulkCell = rs[0].bulkLane ? String(bulk) : '— (no bulk lane)';
			rows.push(`| ${def.name} | ${mf.toFixed(1)} / ${worst.toFixed(1)} | ${over} | ${light.toFixed(1)} | ${bulkCell} | ${rs[0].removed} | ${gate(ok)}${ok && thin ? ' (thin)' : ''} |`);
		}
		// Spec §8: the chain rows report each detonation's frame (worst repetition per detonation).
		for (const def of CRAFT_ROWS) {
			if (def.kind !== 'tnt' || def.count < 2) continue;
			const rs = C.map((c) => c.rows.find((x) => x.name === def.name)!);
			const per = rs[0].eventMs.map((_, k) => Math.max(...rs.map((x) => x.eventMs[k] ?? 0)).toFixed(1));
			rows.push(`${def.name}: detonation frames ${per.join(' / ')} ms`);
		}
	}
	console.log(rows.join('\n'));
	process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); stopDev?.(); process.exit(1); });
