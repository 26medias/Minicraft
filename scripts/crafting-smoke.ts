// scripts/crafting-smoke.ts — browser smoke of the crafting feature (spec §11 "Browser smoke").
//
//   npm run smoke:crafting [-- --port 5173]
//
// Starts its OWN Vite dev server on --port (default 5173, --strictPort: if the port is busy it
// stops and says so; it never reuses or kills a server it did not start) with
// VITE_MINICRAFT_API_URL pointed at a dead local port, drives a headed Chromium at 1280×720:
// new must-mine world → mine → the block joins the hotbar → I → Craft → craft Wood with seeded
// counts → P switches → HUD icon opens I → craft TNT tiers → Iron → orange area highlight.
// Screenshots go to smoke-out/<timestamp>/. Exit 0 = every check passed, 1 = a check failed,
// 2 = the page tried to reach a non-localhost host (aborted before it left the machine).
// SAFETY: the save API is blocked twice — every request to the dead API port is aborted, and
// every request to any host other than localhost/127.0.0.1 aborts the whole run. The kid's
// worlds live at noah.leap-forward.ca and in gs://minicraft-worlds: never point this there.
import { chromium, type Page } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { BLOCK_BY_NAME } from '../src/data/blocks.data';
import { RECIPES, type Recipe } from '../src/data/recipes.data';

function arg(name: string, def: string) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : def;
}
const PORT = Number(arg('--port', '5173'));
const DEAD_API = 'http://127.0.0.1:9099';
const SEED = 3;
const OUT = `smoke-out/${Date.now()}`;
const COAL = BLOCK_BY_NAME['coal_ore'].id;
const BIG = BLOCK_BY_NAME['big_tnt'].id;
const MEGA = BLOCK_BY_NAME['mega_tnt'].id;

let stopDev: (() => void) | null = null;
let blockedApiCalls = 0;
const failures: string[] = [];
function check(ok: boolean, what: string) {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
	if (!ok) failures.push(what);
}

async function startDev(): Promise<() => void> {
	try {
		await fetch(`http://localhost:${PORT}/`);
		throw new Error(`port ${PORT} is already serving (your dev server?). Stop it yourself or pass --port <free port>; this script never reuses a server it did not start (it could be wired to the production save API).`);
	} catch (e) {
		if ((e as Error).message.startsWith('port')) throw e;
	}
	const p = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
		env: { ...process.env, VITE_MINICRAFT_API_URL: DEAD_API },
		stdio: 'ignore',
	});
	// Stop by port only (never pkill by name: it has killed other servers on this machine).
	const stop = () => { spawnSync('fuser', ['-k', `${PORT}/tcp`], { stdio: 'ignore' }); p.kill(); };
	for (let i = 0; i < 60; i++) {
		if (p.exitCode !== null) throw new Error(`dev server exited with ${p.exitCode} (is port ${PORT} busy?)`);
		try { await fetch(`http://localhost:${PORT}/`); return stop; }
		catch { await new Promise((r) => setTimeout(r, 500)); }
	}
	stop();
	throw new Error('dev server did not start');
}

async function guard(page: Page) {
	await page.route('**/*', (route) => {
		const url = new URL(route.request().url());
		if (url.origin === DEAD_API) { blockedApiCalls++; return route.abort(); }  // save API: blocked
		if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
		// Anything else — the production site, the minicraft-api Cloud Function (*.a.run.app,
		// *.cloudfunctions.net), a CDN — is aborted and the run stops.
		console.error(`crafting-smoke: ABORT — the page tried to reach ${url.href} (only localhost is allowed)`);
		void route.abort();
		stopDev?.();
		process.exit(2);
	});
}

type Mc = {
	world: { getBlock(x: number, y: number, z: number): number; setBlock(x: number, y: number, z: number, id: number): void };
	player: { position: number[]; hotbar: number[]; selected: number; inventory: Record<string, number>; tools: { owned: number[]; equipped: number } };
	loop: { setLeftMouseDown(d: boolean): void; markChunkDirtyAround(x: number, z: number): void; applyLightUpdate(x: number, y: number, z: number): void };
	cam: { pitch: number; yaw: number };
	highlight: { setArea(min: number[], max: number[], multi: boolean): void };
	mustMine: boolean;
	syncHotbar(): void;
};

/** Seed exactly the recipe's needs (first anyOf name) on top of what he has, then refresh the UI. */
async function seed(page: Page, r: Recipe) {
	const add: Record<string, number> = {};
	for (const n of r.needs) add[n.anyOf[0]] = (add[n.anyOf[0]] ?? 0) + n.count;
	await page.evaluate((add) => {
		const mc = (window as unknown as { __mc: Mc }).__mc;
		const inv = { ...mc.player.inventory };
		for (const [k, v] of Object.entries(add)) inv[k] = (inv[k] ?? 0) + v;
		mc.player.inventory = inv;
		mc.syncHotbar();
	}, add);
}
const recipeFor = (key: string) => RECIPES.find((r) => (r.output.kind === 'pickaxe' ? `pickaxe:${r.output.tier}` : `block:${r.output.name}`) === key)!;
const mc = <T>(page: Page, fn: (m: Mc) => T) => page.evaluate(`(${fn.toString()})(window.__mc)`) as Promise<T>;

async function craftVia(page: Page, key: string) {
	await page.keyboard.press('KeyI');
	await page.click('.inventory-tab[data-tab="craft"]');
	await page.click(`.craft-card[data-output="${key}"] .craft-button`);
}

// However the run ends (Ctrl-C, a pipe closing, an exception), the server it started goes with it.
process.on('exit', () => stopDev?.());
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => process.exit(130));

(async () => {
	mkdirSync(OUT, { recursive: true });
	stopDev = await startDev();
	// Headless: a headed window steals the user's focus (standing rule).
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
		await guard(page);
		await page.addInitScript('window.__name = (f) => f;');
		await page.goto(`http://localhost:${PORT}/`);

		// 1. New World with the checkbox ticked.
		await page.click('text=New World');
		await page.fill('#w-seed', String(SEED));
		await page.check('#w-must-mine');
		await page.click('text=Create');
		await page.waitForFunction(() => (window as unknown as { __mc?: unknown }).__mc !== undefined);
		await page.waitForFunction(() => {
			const m = (window as unknown as { __mc: { loop: { stats: { streamQueue: number; mounted: number } } } }).__mc;
			return m.loop.stats.streamQueue === 0 && m.loop.stats.mounted >= 81;
		}, null, { timeout: 60_000 });
		check(await mc(page, (m) => m.mustMine), 'the New World checkbox made a must-mine world');
		check(await page.locator('#hud-hotbar .hotbar-slot.grey').count() > 0, 'must-mine: counted hotbar slots at 0 are greyed');

		// 2. Mine a coal ore under his feet (not on the default hotbar) → it joins the hotbar with a 1.
		const cell = await page.evaluate((COAL) => {
			const m = (window as unknown as { __mc: Mc }).__mc;
			const [x, y, z] = [Math.floor(m.player.position[0]), Math.floor(m.player.position[1]) - 1, Math.floor(m.player.position[2])];
			m.world.setBlock(x, y, z, COAL);
			m.loop.markChunkDirtyAround(x, z);
			m.loop.applyLightUpdate(x, y, z);
			m.cam.pitch = -Math.PI / 2 + 0.01;
			return { x, y, z };
		}, COAL);
		await page.waitForTimeout(300);
		await mc(page, (m) => m.loop.setLeftMouseDown(true));
		await page.waitForFunction((c) => (window as unknown as { __mc: Mc }).__mc.world.getBlock(c.x, c.y, c.z) === 0, cell, { timeout: 15_000 });
		await mc(page, (m) => m.loop.setLeftMouseDown(false));
		check((await mc(page, (m) => m.player.hotbar)).includes(COAL), 'mined coal ore joined the hotbar');
		check(await mc(page, (m) => m.player.inventory['coal_ore'] === 1), 'coal ore count is 1');
		const coalSlot = (await mc(page, (m) => m.player.hotbar)).indexOf(COAL);
		check((await page.locator('#hud-hotbar .hotbar-slot').nth(coalSlot).innerText()).trim() === '1', 'its hotbar slot shows the badge 1');

		// 3. I → Craft: 10 cards, all on screen at 1280×720, no scrolling.
		await page.keyboard.press('KeyI');
		await page.click('.inventory-tab[data-tab="craft"]');
		const boxes = await page.locator('.craft-card').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ top: r.top, left: r.left, bottom: r.bottom, right: r.right })));
		check(boxes.length === 10, `10 craft cards (got ${boxes.length})`);
		check(boxes.every((b) => b.top >= 0 && b.left >= 0 && b.bottom <= 720 && b.right <= 1280), 'every card fully inside 1280×720');
		check(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight), 'the page does not scroll');
		check(await page.locator('.craft-card[data-output="pickaxe:1"] .craft-button').isDisabled(), 'Wood is disabled with no logs');
		await page.screenshot({ path: `${OUT}/craft-tab-empty.png` });

		// 4. Seed logs, craft Wood: owned, equipped, check mark, HUD icon tier 1.
		await seed(page, recipeFor('pickaxe:1'));
		check(!(await page.locator('.craft-card[data-output="pickaxe:1"] .craft-button').isDisabled()), 'Wood enabled once the logs are there');
		await page.click('.craft-card[data-output="pickaxe:1"] .craft-button');
		const tools = await mc(page, (m) => m.player.tools);
		check(tools.owned.includes(1) && tools.equipped === 1, 'Wood pickaxe owned and equipped');
		check(await page.locator('.craft-card[data-output="pickaxe:1"] .craft-owned').count() === 1, 'Wood card shows the check mark');
		check(await page.locator('#hud-pickaxe').getAttribute('data-tier') === '1', 'HUD pickaxe shows tier 1');
		await page.screenshot({ path: `${OUT}/craft-tab-wood.png` });
		await page.keyboard.press('Escape');

		// 5. P cycles owned pickaxes (0 ↔ 1); the HUD icon follows; its keycap reads P.
		await page.keyboard.press('KeyP');
		check(await mc(page, (m) => m.player.tools.equipped) === 0, 'P switched to the hand');
		check(await page.locator('#hud-pickaxe').getAttribute('data-tier') === '0', 'HUD icon follows P');
		await page.keyboard.press('KeyP');
		check(await mc(page, (m) => m.player.tools.equipped) === 1, 'P switched back to Wood');
		check((await page.locator('#hud-pickaxe .keycap').innerText()).trim() === 'P', 'HUD keycap reads P');

		// 6. Clicking the HUD icon opens the I screen.
		await page.click('#hud-pickaxe');
		check(await page.locator('#inventory-root').isVisible(), 'HUD pickaxe click opens I');
		await page.keyboard.press('Escape');

		// 7. TNT tiers: Big TNT hidden in the Blocks tab at 0; crafted → hotbar slot rule + badge; screenshots of the tiles.
		await page.keyboard.press('KeyI');
		await page.click('.inventory-tab[data-tab="blocks"]');
		check(!(await page.locator('.inventory-tile[data-block="big_tnt"]').isVisible()), 'Big TNT hidden in the Blocks tab at 0');
		await page.keyboard.press('Escape');
		await seed(page, recipeFor('block:big_tnt'));
		const before = await mc(page, (m) => ({ hotbar: m.player.hotbar.slice(), selected: m.player.selected }));
		await craftVia(page, 'block:big_tnt');
		const after = await mc(page, (m) => m.player.hotbar.slice());
		// §9 rule (gate 2): holding → first empty → first other greyed (counted, at 0) slot → selected.
		// A new must-mine world's bar is full of greyed blocks, so the selected slot must be left alone.
		const changed = after.findIndex((b, i) => b !== before.hotbar[i]);
		check(changed >= 0 && after[changed] === BIG && changed !== before.selected, `crafted Big TNT went to slot ${changed}, not the selected slot ${before.selected}`);
		await seed(page, recipeFor('block:big_tnt'));
		await seed(page, recipeFor('block:big_tnt'));
		await page.click('.craft-card[data-output="block:big_tnt"] .craft-button');
		await page.click('.craft-card[data-output="block:big_tnt"] .craft-button');
		await seed(page, recipeFor('block:mega_tnt'));
		await page.click('.craft-card[data-output="block:mega_tnt"] .craft-button');
		check(await mc(page, (m) => m.player.inventory['mega_tnt'] === 1), 'Mega TNT crafted from two Big TNT');
		await page.click('.inventory-tab[data-tab="blocks"]');
		check(await page.locator('.inventory-tile[data-block="big_tnt"]').isVisible(), 'Big TNT visible once he has one');
		check((await page.locator('.inventory-tile[data-block="mega_tnt"]').innerText()).trim() === '1', 'Mega TNT tile shows 1');
		await page.locator('.inventory-tile[data-block="big_tnt"]').screenshot({ path: `${OUT}/tile-big-tnt.png` });
		await page.locator('.inventory-tile[data-block="mega_tnt"]').screenshot({ path: `${OUT}/tile-mega-tnt.png` });
		await page.screenshot({ path: `${OUT}/blocks-tab.png` });
		await page.keyboard.press('Escape');
		// In-world look: a Big/Mega pair on each side of him, camera level.
		await page.evaluate(({ BIG, MEGA }) => {
			const m = (window as unknown as { __mc: Mc }).__mc;
			const [x, y, z] = m.player.position.map(Math.floor);
			for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) {
				m.world.setBlock(x + dx, y + 1, z + dz, BIG);
				m.world.setBlock(x + dx + dz, y + 1, z + dz + dx, MEGA);
				m.loop.markChunkDirtyAround(x + dx, z + dz);
				m.loop.applyLightUpdate(x + dx, y + 1, z + dz);
			}
			m.cam.pitch = 0;
		}, { BIG, MEGA });
		await page.waitForTimeout(500);
		await page.screenshot({ path: `${OUT}/world-tnt-tiers.png` });

		// 8. Iron (multi-block tier) → the highlight becomes the orange 3×3 area.
		await page.evaluate(() => {
			const w = window as unknown as { __mc: Mc; __area?: { min: number[]; max: number[]; multi: boolean } };
			const h = w.__mc.highlight;
			const orig = h.setArea.bind(h);
			h.setArea = (min, max, multi) => { w.__area = { min: [...min], max: [...max], multi }; orig(min, max, multi); };
			w.__mc.cam.pitch = -Math.PI / 2 + 0.01;
		});
		await page.keyboard.press('Escape'); // no-op if already closed
		await seed(page, recipeFor('pickaxe:4'));
		await craftVia(page, 'pickaxe:4');
		await page.keyboard.press('Escape');
		check(await mc(page, (m) => m.player.tools.equipped) === 4, 'Iron crafted and equipped');
		await page.waitForFunction(() => (window as unknown as { __area?: { multi: boolean } }).__area?.multi === true, null, { timeout: 5_000 }).catch(() => undefined);
		const area = await page.evaluate(() => (window as unknown as { __area?: { min: number[]; max: number[]; multi: boolean } }).__area ?? null);
		check(area !== null && area.multi, 'highlight got a multi-block (orange) area at Iron');
		if (area) {
			const ext = area.max.map((v, i) => v - area.min[i]).sort((a, b) => a - b);
			check(ext[1] === ext[2] && ext[2] > ext[0], `area is square across the face and thinner in depth (extents ${ext.join('×')})`);
		}
		await page.screenshot({ path: `${OUT}/iron-highlight.png` });
		console.log(`save API requests blocked: ${blockedApiCalls}`);
	} finally {
		await browser.close();
		stopDev?.();
	}
	console.log(`screenshots: ${OUT}/`);
	if (failures.length) { console.error(`${failures.length} check(s) failed`); process.exit(1); }
	process.exit(0);
})().catch((e) => { console.error(e); stopDev?.(); process.exit(1); });
