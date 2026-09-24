// scripts/menu-smoke.ts — headless browser smoke of the menus (multiplayer spec §8).
//
//   npx tsx scripts/menu-smoke.ts [--port 5173]
//
// Starts its OWN Vite dev server on --port (default 5173, --strictPort: if the port is busy it
// stops and says so; it never reuses or stops a server it did not start) with
// VITE_MINICRAFT_API_URL pointed at a dead local port, and drives a headless Chromium:
// home (three buttons) → Multiplayer stub → Parents (maximum) → Single Player (duration control,
// New World → Create → Play: the world loads) → reload (world and duration remembered) →
// schedule → the card's Parents button asks for the PIN and cancels the schedule.
// Exit 0 = every check passed, 1 = a check failed, 2 = the page tried to reach a non-localhost
// host (aborted before it left the machine).
// SAFETY: the save API is blocked twice — every request to the dead API port is aborted, and
// every request to any host other than localhost/127.0.0.1 (the production site, *.run.app)
// aborts the whole run. The kid's worlds live at noah.leap-forward.ca: never point this there.
import { chromium, type Page } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';

function arg(name: string, def: string) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : def;
}
const PORT = Number(arg('--port', '5173'));
const DEAD_API = 'http://127.0.0.1:9099';
const BASE = `http://localhost:${PORT}/`;

let stopDev: (() => void) | null = null;
const failures: string[] = [];
function check(ok: boolean, what: string) {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
	if (!ok) failures.push(what);
}

async function startDev(): Promise<() => void> {
	try {
		await fetch(BASE);
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
		try { await fetch(BASE); return stop; }
		catch { await new Promise((r) => setTimeout(r, 500)); }
	}
	stop();
	throw new Error('dev server did not start');
}

async function guard(page: Page) {
	await page.route('**/*', (route) => {
		const url = new URL(route.request().url());
		if (url.origin === DEAD_API) return route.abort();  // save API: blocked
		if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
		// Anything else — the production site, the Cloud Function (*.run.app), a CDN — stops the run.
		console.error(`menu-smoke: ABORT — the page tried to reach ${url.href} (only localhost is allowed)`);
		void route.abort();
		stopDev?.();
		process.exit(2);
	});
}

const ls = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);
const text = async (page: Page, sel: string) => (await page.locator(sel).innerText()).trim();

process.on('exit', () => stopDev?.());
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => process.exit(130));

(async () => {
	stopDev = await startDev();
	// Headless: a headed window steals the user's focus (standing rule).
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
		page.on('dialog', (d) => void d.accept());
		await guard(page);
		await page.addInitScript('window.__name = (f) => f;');
		await page.goto(BASE);

		// 1. Home: three big buttons.
		await page.waitForSelector('#home-single');
		check(await page.locator('.home-button').count() === 3, 'home shows three big buttons');
		check(await text(page, '#home-single') === 'Single Player' && await text(page, '#home-multi') === 'Multiplayer' && await text(page, '#home-parents') === 'Parents', 'they read Single Player, Multiplayer, Parents');
		check(await page.locator('text=Grown-ups').count() === 0, 'no "Grown-ups" label left');

		// 2. Multiplayer: the stub, and Back.
		await page.click('#home-multi');
		check(await page.locator('.menu-card[data-screen="multi"]').count() === 1, 'Multiplayer opens its screen');
		await page.click('#menu-back');
		await page.waitForSelector('#home-single');

		// 3. Single Player under No limit: the default duration is No limit.
		await page.click('#home-single');
		await page.waitForSelector('#duration-value');
		check(await text(page, '#duration-value') === 'No limit', `duration defaults to No limit under No limit (got ${await text(page, '#duration-value')})`);
		await page.click('#duration-minus');
		check(await text(page, '#duration-value') === '2 h', 'No limit − → 2 h');
		await page.click('#menu-back');

		// 4. Parents (no PIN): every section; set the maximum to 45 min.
		await page.click('#home-parents');
		await page.waitForSelector('#max-duration');
		for (const sel of ['#sched-world', '#sched-start', '#sched-duration', '#sched-save', '#max-duration', '#reset-states', '#pin-set-input', '#pin-save', '#parents-mp-worlds']) {
			check(await page.locator(sel).count() === 1, `Parents has ${sel}`);
		}
		await page.selectOption('#max-duration', '45');
		const opts = JSON.parse((await ls(page, 'minicraft:v1:options')) ?? '{}');
		check(opts.maxDurationMin === 45, `the maximum is saved (got ${opts.maxDurationMin})`);
		await page.click('#menu-back');

		// 5. Single Player under a 45 max: the stored 2 h is clamped to 45; steps stop at 45.
		await page.click('#home-single');
		await page.waitForSelector('#duration-value');
		check(await text(page, '#duration-value') === '45 min', `a remembered 2 h is clamped to the 45 min maximum (got ${await text(page, '#duration-value')})`);
		check(await page.locator('#duration-plus').isDisabled(), '+ is disabled at the maximum');
		await page.click('#duration-minus');
		check(await text(page, '#duration-value') === '40 min', '− steps 5 minutes');
		const menuState = JSON.parse((await ls(page, 'minicraft:v1:menu')) ?? '{}');
		check(menuState.duration === 40, `the duration is remembered in minicraft:v1:menu (got ${menuState.duration})`);

		// 6. New World → Create: listed first and selected. Play: the world loads.
		await page.click('#single-new');
		await page.fill('#w-name', 'Smoke World');
		await page.fill('#w-seed', '3');
		await page.click('#w-create');
		await page.waitForSelector('#single-worlds .world-row');
		const first = page.locator('#single-worlds .world-row').first();
		check((await first.innerText()).includes('Smoke World') && await first.locator('.badge-new').count() === 1, 'the created world is listed first with the New badge');
		check(await first.evaluate((e) => e.classList.contains('selected')), 'the created world is selected');
		check(await text(page, '#duration-value') === '40 min', 'the duration survives Create');
		await page.click('#single-play');
		await page.waitForFunction(() => (window as unknown as { __mc?: unknown }).__mc !== undefined, null, { timeout: 60_000 });
		await page.waitForFunction(() => {
			const m = (window as unknown as { __mc: { loop: { stats: { streamQueue: number; mounted: number } } } }).__mc;
			return m.loop.stats.streamQueue === 0 && m.loop.stats.mounted >= 81;
		}, null, { timeout: 60_000 });
		check(true, 'Single Player → New World → Create → Play loads the world');
		// A new world is saved on its first change: mark it dirty and wait for its record.
		const createdId = JSON.parse((await ls(page, 'minicraft:v1:menu')) ?? '{}').selectedId as string;
		await page.evaluate(() => (window as unknown as { __mc: { loop: { onWorldMutated: () => void } } }).__mc.loop.onWorldMutated());
		await page.waitForFunction((id) => Object.keys(localStorage).some((k) => k.includes(id)), createdId, { timeout: 30_000 });
		await page.waitForTimeout(1_000);

		// 7. Reload: the world is listed on this device and selected; the duration is remembered.
		await page.goto(BASE);
		await page.click('#home-single');
		await page.waitForSelector('#single-worlds .world-row');
		const sel = page.locator('#single-worlds .world-row.selected');
		check(await sel.count() === 1 && (await sel.innerText()).includes('Smoke World'), 'after a reload the played world is selected');
		check(await sel.locator('.badge-device').count() === 1, 'it carries the This device badge');
		check(await text(page, '#duration-value') === '40 min', 'after a reload the duration is remembered');
		await page.click('#menu-back');

		// 8. Parents: set a PIN, schedule the world → the card; the card's Parents button asks for
		// the PIN and cancels the schedule.
		await page.click('#home-parents');
		await page.waitForSelector('#pin-set-input');
		await page.fill('#pin-set-input', '1234');
		await page.click('#pin-save');
		check(await ls(page, 'minicraft:v1:pin') === '1234', 'Save PIN stores the PIN');
		const worldId = await page.locator('#sched-world option').nth(1).getAttribute('value');
		await page.selectOption('#sched-world', worldId!);
		await page.fill('#sched-start', '00:00');
		await page.click('#sched-save');
		await page.waitForSelector('#card-parents');
		check(await page.locator('#home-multi').count() === 0, 'the scheduled card replaces home: no Multiplayer');
		check(await ls(page, 'minicraft:v1:schedule') !== null, 'the schedule is stored');
		await page.click('#card-parents');
		await page.fill('#pin-input', '9999');
		await page.click('#pin-go');
		check(await text(page, '#pin-error') === 'Wrong PIN', 'a wrong PIN is refused');
		check(await ls(page, 'minicraft:v1:schedule') !== null, 'a wrong PIN leaves the schedule');
		await page.fill('#pin-input', '1234');
		await page.click('#pin-go');
		await page.waitForSelector('#home-single');
		check(await ls(page, 'minicraft:v1:schedule') === null, 'the right PIN cancels the schedule and home is back');

		// 9. Parents behind the PIN; Reset PIN removes it.
		await page.click('#home-parents');
		check(await page.locator('#max-duration').count() === 0, 'with a PIN set, Parents is gated');
		await page.fill('#pin-input', '1234');
		await page.click('#pin-go');
		await page.waitForSelector('#pin-reset');
		await page.click('#pin-reset');
		check(await ls(page, 'minicraft:v1:pin') === null, 'Reset PIN removes it');
	} catch (e) {
		check(false, `run threw: ${(e as Error).message}`);
	} finally {
		await browser.close();
		stopDev?.();
	}
	console.log(failures.length === 0 ? 'menu-smoke: PASS' : `menu-smoke: ${failures.length} FAILED`);
	process.exit(failures.length === 0 ? 0 : 1);
})();
