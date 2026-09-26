// Headless look screenshots for the texture review (texture replacement spec §8). Not deployed.
//   npx tsx scripts/texture-look.ts --port <free port> --out <dir outside the repo> [--only 09,12]
// Starts its OWN Vite dev server on --port (--strictPort) with VITE_MINICRAFT_API_URL pointed at a dead
// local port, refuses to shoot unless that server serves this worktree's CREDITS.txt, builds each scene
// in the air next to spawn with world.setBlock, and saves one PNG per scene. Stops its server by port only.
import { chromium, type Page } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { BLOCK_BY_NAME } from '../src/data/blocks.data';

function arg(name: string, def: string) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : def;
}
const PORT = Number(arg('--port', '5181'));
const OUT = resolve(arg('--out', ''));
const DEAD_API = 'http://127.0.0.1:9099';
const BASE = `http://localhost:${PORT}/`;
if (!arg('--out', '') || OUT.startsWith(resolve('.') + '/')) throw new Error('--out <dir> is required and must be outside the repo');

let stopDev: (() => void) | null = null;
process.on('exit', () => stopDev?.());
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => process.exit(130));

async function startDev(): Promise<() => void> {
	try {
		await fetch(BASE);
		throw new Error(`port ${PORT} is already serving; pass --port <free port>`);
	} catch (e) {
		if ((e as Error).message.startsWith('port')) throw e;
	}
	const p = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
		env: { ...process.env, VITE_MINICRAFT_API_URL: DEAD_API, VITE_MINICRAFT_MP_URL: '', VITE_MINICRAFT_MP_TOKEN: '' },
		stdio: 'ignore',
	});
	// Stop by port only (never pkill by name).
	const stop = () => { spawnSync('fuser', ['-k', `${PORT}/tcp`], { stdio: 'ignore' }); p.kill(); };
	for (let i = 0; i < 60; i++) {
		if (p.exitCode !== null) throw new Error(`dev server exited with ${p.exitCode}`);
		try { await fetch(BASE); return stop; } catch { await new Promise((r) => setTimeout(r, 500)); }
	}
	stop();
	throw new Error('dev server did not start');
}

async function guard(page: Page) {
	await page.route('**/*', (route) => {
		const url = new URL(route.request().url());
		if (url.origin === DEAD_API) return route.abort();
		if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
		console.error(`texture-look: ABORT — the page tried to reach ${url.href}`);
		void route.abort();
		stopDev?.();
		process.exit(2);
	});
}

const id = (name: string): number => {
	const b = BLOCK_BY_NAME[name];
	if (!b) throw new Error(`No block ${name}`);
	return b.id;
};
type Put = [number, number, number, string];          // dx, dy, dz relative to the anchor, block name
type Scene = { file: string; puts: Put[]; yaw?: number; pitch?: number; eye?: [number, number, number] };

/** A vertical wall of blocks at dz = -8, rows top-down, centred on x. */
function wall(rows: string[][], dz = -8, y0 = 3): Put[] {
	const out: Put[] = [];
	rows.forEach((row, r) => row.forEach((n, c) => out.push([c - Math.floor(row.length / 2), y0 - r, dz, n])));
	return out;
}
function tree(x: number, z: number, log: string, leaves: string, h = 4): Put[] {
	const out: Put[] = [];
	for (let y = 0; y < h; y++) out.push([x, y, z, log]);
	for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = h - 1; dy <= h; dy++)
		if (!(dx === 0 && dz === 0 && dy === h - 1)) out.push([x + dx, dy, z + dz, leaves]);
	out.push([x, h + 1, z, leaves]);
	return out;
}
function floor(name: string, y = -1, x0 = -10, x1 = 10, z0 = -14, z1 = -2): Put[] {
	const out: Put[] = [];
	for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) out.push([x, y, z, name]);
	return out;
}
const COLOURS = ['white', 'light_gray', 'gray', 'black', 'brown', 'red', 'orange', 'yellow', 'lime', 'green', 'cyan', 'light_blue', 'blue', 'purple', 'magenta', 'pink'];
const TREES: Array<[string, string]> = [
	['oak_log', 'oak_leaves'], ['birch_log', 'birch_leaves'], ['spruce_log', 'spruce_leaves'], ['jungle_log', 'jungle_leaves'],
	['acacia_log', 'acacia_leaves'], ['dark_oak_log', 'dark_oak_leaves'], ['mangrove_log', 'mangrove_leaves'], ['cherry_log', 'cherry_leaves'], ['pale_oak_log', 'pale_oak_leaves'],
];

function mine(): Put[] {
	// A closed deepslate room lit only by two sea lanterns; the back wall carries every deepslate ore.
	const out: Put[] = [];
	for (let x = -7; x <= 7; x++) for (let y = -2; y <= 5; y++) for (let z = -10; z <= 3; z++) {
		const shell = x === -7 || x === 7 || y === -2 || y === 5 || z === -10 || z === 3;
		if (shell) out.push([x, y, z, 'deepslate']);
	}
	const ores = ['deepslate_coal_ore', 'deepslate_iron_ore', 'deepslate_copper_ore', 'deepslate_gold_ore', 'deepslate_redstone_ore', 'deepslate_lapis_ore', 'deepslate_diamond_ore', 'deepslate_emerald_ore'];
	// 8 ores spread over the 13 inner columns (x = -6..6), two rows each.
	ores.forEach((n, i) => { const x = -6 + Math.round((i * 12) / 7); out.push([x, 1, -10, n], [x, 3, -10, n]); });
	out.push([-6, 2, -3, 'sea_lantern'], [6, 2, -3, 'sea_lantern']);
	return out;
}

const SCENES: Scene[] = [
	{ file: '03-birch-forest.png', puts: [...floor('grass_block'), ...tree(-6, -9, 'birch_log', 'birch_leaves'), ...tree(-1, -11, 'birch_log', 'birch_leaves', 5), ...tree(4, -8, 'birch_log', 'birch_leaves'), ...tree(8, -12, 'birch_log', 'birch_leaves', 5)], pitch: -0.1 },
	{ file: '04-deepslate-mine.png', puts: mine(), eye: [0, 1, 1], pitch: 0 },
	{ file: '05-stone-ores.png', puts: wall([
		['stone', 'coal_ore', 'stone', 'iron_ore', 'stone', 'copper_ore', 'stone', 'gold_ore', 'stone'],
		['stone', 'stone', 'redstone_ore', 'stone', 'lapis_ore', 'stone', 'diamond_ore', 'stone', 'emerald_ore'],
		['stone', 'coal_ore', 'stone', 'stone', 'copper_ore', 'stone', 'stone', 'iron_ore', 'stone'],
		['nether_gold_ore', 'netherrack', 'nether_quartz_ore', 'netherrack', 'gravel', 'andesite', 'granite', 'diorite', 'cobblestone'],
	]) },
	{ file: '06-clay-by-water.png', puts: [...floor('sand'), ...(() => { const o: Put[] = []; for (let x = -3; x <= 3; x++) for (let z = -10; z <= -5; z++) { o.push([x, -1, z, (x === -3 || x === 3 || z === -10 || z === -5) ? 'clay' : 'water']); } return o; })()], pitch: -0.45 },
	{ file: '07-house.png', puts: wall([
		['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'pale_oak_planks'],
		['oak_planks', 'glass', 'glass', 'oak_planks', 'furnace', 'crafting_table', 'oak_planks', 'glass', 'oak_planks'],
		['oak_log', 'bookshelf', 'bookshelf', 'oak_planks', 'loom', 'barrel', 'oak_planks', 'bricks', 'stone_bricks'],
	]) },
	{ file: '08-glass-wall.png', puts: wall([['glass', ...COLOURS.slice(0, 8).map((c) => `${c}_stained_glass`)], ['glass', ...COLOURS.slice(8).map((c) => `${c}_stained_glass`)]]) },
	{ file: '09-tnt-row.png', puts: wall([['tnt', 'big_tnt', 'mega_tnt', 'tunnel_tnt', 'flatten_tnt', 'lake_tnt', 'block_bomb', 'fireworks', 'slime_pad', 'launch_pad']], -6, 0), pitch: -0.25 },
	{ file: '10-wools.png', puts: wall([COLOURS.slice(0, 8).map((c) => `${c}_wool`), COLOURS.slice(8).map((c) => `${c}_wool`)]) },
	{ file: '11-concrete.png', puts: wall([COLOURS.slice(0, 8).map((c) => `${c}_concrete`), COLOURS.slice(8).map((c) => `${c}_concrete`), COLOURS.slice(0, 8).map((c) => `${c}_terracotta`)]) },
	{ file: '12-derived.png', puts: wall([
		['tnt', 'ochre_froglight', 'verdant_froglight', 'pearlescent_froglight', 'creaking_heart', 'copper_ore'],
		['muddy_mangrove_roots', 'suspicious_sand', 'suspicious_gravel', 'sculk_catalyst', 'mud', 'shroomlight'],
	]) },
	{ file: '13-trees.png', puts: [...floor('grass_block', -1, -20, 20, -16, -2), ...TREES.flatMap(([log, leaves], i) => tree(-16 + i * 4, -11, log, leaves))], eye: [0, 3, 6], pitch: -0.12 },
];

async function main() {
	mkdirSync(OUT, { recursive: true });
	stopDev = await startDev();
	const credits = await fetch(new URL('CREDITS.txt', BASE));
	if (credits.status !== 200 || !(await credits.text()).startsWith('# Minicraft texture credits'))
		throw new Error('The server on this port is not this worktree (no texture CREDITS.txt): refusing to shoot');
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
		await guard(page);
		await page.goto(BASE);
		await page.click('#home-single');
		await page.click('#single-new');
		await page.fill('#w-name', 'Texture Look');
		await page.fill('#w-seed', '7');
		await page.click('#w-create');
		await page.waitForSelector('#single-worlds .world-row');
		await page.click('#single-play');
		await page.waitForFunction(() => (window as unknown as { __mc?: unknown }).__mc !== undefined, null, { timeout: 60_000 });
		await page.waitForFunction(() => {
			const m = (window as unknown as { __mc: { loop: { stats: { streamQueue: number; mounted: number } } } }).__mc;
			return m.loop.stats.streamQueue === 0 && m.loop.stats.mounted >= 81;
		}, null, { timeout: 90_000 });
		await page.waitForTimeout(1500);
		await page.screenshot({ path: `${OUT}/01-spawn.png` });
		await page.evaluate(() => { const m = (window as unknown as { __mc: { cam: { yaw: number; pitch: number } } }).__mc; m.cam.yaw += Math.PI; m.cam.pitch = 0; });
		await page.waitForTimeout(1500);
		await page.screenshot({ path: `${OUT}/02-grassland.png` });

		// Anchor: 40 blocks above the spawn point, in loaded chunks and clear air.
		const anchor = await page.evaluate(() => {
			const p = (window as unknown as { __mc: { player: { position: number[] } } }).__mc.player.position;
			return [Math.floor(p[0]), Math.floor(p[1]) + 40, Math.floor(p[2])];
		});
		const only = arg('--only', '');
		for (const scene of SCENES.filter((sc) => !only || only.split(',').some((o) => sc.file.startsWith(o)))) {
			const puts = scene.puts.map(([dx, dy, dz, n]) => [anchor[0] + dx, anchor[1] + dy, anchor[2] + dz, id(n)]);
			await page.evaluate(({ a, puts, eye, yaw, pitch }) => {
				const w = window as unknown as { __lookPrev?: number[][]; __mc: {
					world: { setBlock(x: number, y: number, z: number, id: number): void };
					loop: { markChunkDirtyAround(x: number, z: number): void; applyLightUpdate(x: number, y: number, z: number, lane?: 'edit' | 'bulk'): void };
					player: { position: number[]; flying: boolean; velocity?: number[] };
					cam: { yaw: number; pitch: number };
				} };
				const m = w.__mc;
				// Clear the previous scene's blocks, place this one's, then re-mesh and re-light through the
				// loop (world.setBlock alone never queues a re-mesh).
				const changed: number[][] = [];
				for (const [x, y, z] of w.__lookPrev ?? []) { m.world.setBlock(x, y, z, 0); changed.push([x, y, z]); }
				for (const [x, y, z, b] of puts) { m.world.setBlock(x, y, z, b); changed.push([x, y, z]); }
				w.__lookPrev = puts;
				const cols = new Set<string>();
				for (const [x, , z] of changed) cols.add(`${x},${z}`);
				for (const c of cols) { const [x, z] = c.split(',').map(Number); m.loop.markChunkDirtyAround(x, z); }
				for (const [x, y, z] of changed) m.loop.applyLightUpdate(x, y, z, 'bulk');
				m.player.flying = true;
				m.player.position[0] = a[0] + eye[0] + 0.5; m.player.position[1] = a[1] + eye[1]; m.player.position[2] = a[2] + eye[2] + 0.5;
				if (m.player.velocity) m.player.velocity.fill(0);
				m.cam.yaw = yaw; m.cam.pitch = pitch;
			}, { a: anchor, puts, eye: scene.eye ?? [0, 1, 0], yaw: scene.yaw ?? 0, pitch: scene.pitch ?? 0 });
			// Wait for the chunk rebuilds the edits queued, then a few frames for the meshes to swap in.
			await page.waitForTimeout(500);
			await page.waitForFunction(() => {
				const st = (window as unknown as { __mc: { loop: { stats: { editQueue: number; bulkQueue: number; workerInFlight: number } } } }).__mc.loop.stats;
				return st.editQueue === 0 && st.bulkQueue === 0 && st.workerInFlight === 0;
			}, null, { timeout: 60_000 });
			await page.waitForTimeout(Number(process.env.LOOK_SETTLE_MS ?? 1000));
			if (process.env.LOOK_DEBUG) console.log(scene.file, JSON.stringify(await page.evaluate(({ p }) => {
				const m = (window as unknown as { __mc: { loop: { stats: unknown }; world: { getBlock(x: number, y: number, z: number): number } } }).__mc;
				return { stats: m.loop.stats, probe: m.world.getBlock(p[0], p[1], p[2]), want: p[3] };
			}, { p: puts[puts.length - 1] })));
			await page.screenshot({ path: `${OUT}/${scene.file}` });
			console.log(`shot ${scene.file}`);
		}
	} finally {
		await browser.close();
		stopDev?.();
	}
}

main().catch((e) => { console.error(e); stopDev?.(); process.exit(1); });
