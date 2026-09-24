// scripts/menu-smoke.ts — headless browser smoke of the menus (multiplayer spec §8).
//
//   npx tsx scripts/menu-smoke.ts [--port 5173] [--mp-url http://127.0.0.1:1 | --mp-url none]
//
// Starts its OWN Vite dev server on --port (default 5173, --strictPort: if the port is busy it
// stops and says so; it never reuses or stops a server it did not start) with
// VITE_MINICRAFT_API_URL pointed at a dead local port, and drives a headless Chromium:
// home (three buttons) → Multiplayer (name screen, sleeping server, automatic recovery, the
// name-taken message) → Parents (maximum, multiplayer worlds) → Single Player (duration control,
// New World → Create → Play: the world loads) → reload (world and duration remembered) →
// schedule → the card's Parents button asks for the PIN and cancels the schedule.
// Exit 0 = every check passed, 1 = a check failed, 2 = the page tried to reach a non-localhost
// host (aborted before it left the machine).
// --mp-url sets VITE_MINICRAFT_MP_URL (default a dead local port, http://127.0.0.1:1). With
// `--mp-url none` it is unset and the smoke checks that the Multiplayer button is hidden instead.
// No real mcserver is needed: the "server wakes up" step answers /worlds from a Playwright route.
// SAFETY: the save API is blocked twice — every request to the dead API port is aborted, and
// every request to any host other than localhost/127.0.0.1 (the production site, *.run.app)
// aborts the whole run. The kid's worlds live at noah.leap-forward.ca: never point this there.
import { chromium, type Page, type Route } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';

function arg(name: string, def: string) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : def;
}
const PORT = Number(arg('--port', '5173'));
const DEAD_API = 'http://127.0.0.1:9099';
const BASE = `http://localhost:${PORT}/`;
const MP_ARG = arg('--mp-url', 'http://127.0.0.1:1');
const MP_URL = MP_ARG === 'none' ? '' : MP_ARG.replace(/\/+$/, '');
if (MP_URL !== '') {
	const h = new URL(MP_URL).hostname;
	if (h !== '127.0.0.1' && h !== 'localhost') throw new Error(`--mp-url must be local (got ${MP_URL})`);
}
/** The fake multiplayer server: null = asleep (requests aborted), else the /worlds rows. */
let mpRows: { uuid: string; name: string; mustMine: boolean; createdAt: number; online: { name: string; skin: string }[] }[] | null = null;
let mpListCalls = 0;

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
		env: { ...process.env, VITE_MINICRAFT_API_URL: DEAD_API, VITE_MINICRAFT_MP_URL: MP_URL, VITE_MINICRAFT_MP_TOKEN: 'smoke' },
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
		if (MP_URL !== '' && url.origin === new URL(MP_URL).origin) return fakeMp(route);
		if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
		// Anything else — the production site, the Cloud Function (*.run.app), a CDN — stops the run.
		console.error(`menu-smoke: ABORT — the page tried to reach ${url.href} (only localhost is allowed)`);
		void route.abort();
		stopDev?.();
		process.exit(2);
	});
}

const CORS = {
	'Access-Control-Allow-Origin': `http://localhost:${PORT}`,
	'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

/** The multiplayer server, faked: asleep (aborted) until `mpRows` is set. DELETE of an occupied world → 409. */
function fakeMp(route: Route) {
	const req = route.request();
	if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
	const path = new URL(req.url()).pathname;
	if (path === '/worlds' && req.method() === 'GET') mpListCalls++;
	if (mpRows === null) return route.abort('connectionrefused');
	if (req.headers()['authorization'] !== 'Bearer smoke') return route.fulfill({ status: 401, headers: CORS });
	if (path === '/worlds' && req.method() === 'GET') {
		return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(mpRows) });
	}
	if (path === '/worlds' && req.method() === 'POST') {
		const b = JSON.parse(req.postData() ?? '{}') as { name: string; seed: number; mustMine: boolean; gen: number };
		if (b.gen !== 3 || typeof b.seed !== 'number') return route.fulfill({ status: 400, headers: CORS });
		const w = { uuid: `w-new-${mpRows.length}`, name: b.name, mustMine: b.mustMine, createdAt: Date.now(), online: [] };
		mpRows = [...mpRows, w];
		return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(w) });
	}
	const del = /^\/worlds\/(.+)$/.exec(path);
	if (del && req.method() === 'DELETE') {
		const r = mpRows.find((w) => w.uuid === decodeURIComponent(del[1]));
		if (!r) return route.fulfill({ status: 404, headers: CORS });
		if (r.online.length > 0) return route.fulfill({ status: 409, headers: CORS });
		mpRows = mpRows.filter((w) => w !== r);
		return route.fulfill({ status: 204, headers: CORS });
	}
	return route.fulfill({ status: 404, headers: CORS });
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

		// 1. Home: three big buttons (two when the site has no multiplayer server).
		await page.waitForSelector('#home-single');
		if (MP_URL === '') {
			check(await page.locator('.home-button').count() === 2, 'no multiplayer URL: home shows two big buttons');
			check(await page.locator('#home-multi').count() === 0, 'no multiplayer URL: the Multiplayer button is hidden');
		} else {
			check(await page.locator('.home-button').count() === 3, 'home shows three big buttons');
			check(await text(page, '#home-single') === 'Single Player' && await text(page, '#home-multi') === 'Multiplayer' && await text(page, '#home-parents') === 'Parents', 'they read Single Player, Multiplayer, Parents');
		}
		check(await page.locator('text=Grown-ups').count() === 0, 'no "Grown-ups" label left');

		if (MP_URL !== '') {
			// 2. Multiplayer. Screen 1: a refused name shows the reason and Next refuses.
			await page.click('#home-multi');
			await page.waitForSelector('#mp-name');
			check(await page.locator('#mp-skins .skin-swatch').count() === 8, 'screen 1 has 8 skin swatches');
			await page.fill('#mp-name', 'Noah!');
			await page.click('#mp-next');
			check(await text(page, '#mp-name-error') === 'Only letters, numbers and spaces', 'a bad name shows "Only letters, numbers and spaces"');
			check(await page.locator('#mp-name').count() === 1, 'Next refuses a bad name');
			await page.fill('#mp-name', ' Noah ');
			await page.click('#mp-skin-blue');
			await page.click('#mp-next');
			// Screen 2 on a dead port: the sleeping text, a Retry button, and retries on its own.
			await page.waitForSelector('#mp-sleeping:not(.hidden)', { timeout: 10_000 });
			check((await text(page, '#mp-sleeping')).includes('The multiplayer server is sleeping. Ask a parent to wake it up.'), 'a dead server shows the sleeping text');
			check(await page.locator('#mp-retry').isVisible(), 'the sleeping screen has a Retry button');
			check((await text(page, '#mp-playing')).includes('Playing as Noah'), 'screen 2 shows "Playing as Noah"');
			const prefs = JSON.parse((await ls(page, 'minicraft:v1:mp')) ?? '{}');
			check(prefs.name === 'Noah' && prefs.skin === 'blue' && typeof prefs.bid === 'string', `name, skin and bid are remembered (got ${JSON.stringify(prefs)})`);
			const before = mpListCalls;
			await page.waitForTimeout(5_600);
			check(mpListCalls > before, `the sleeping screen retries on its own every 5 s (${mpListCalls - before} retries in 5.6 s)`);
			// The server wakes up: the list appears within 6 s with no click, busiest world preselected.
			mpRows = [
				{ uuid: 'w-empty', name: 'Empty World', mustMine: false, createdAt: 2, online: [] },
				{ uuid: 'w-busy', name: 'Busy World', mustMine: true, createdAt: 1, online: [{ name: 'Léo', skin: 'green' }] },
			];
			const woke = Date.now();
			await page.waitForSelector('#mp-worlds .world-row', { timeout: 6_000 }).catch(() => undefined);
			const rowsShown = await page.locator('#mp-worlds .world-row').count();
			check(rowsShown === 2, `after the server wakes the world list appears with no click (${rowsShown} rows in ${Date.now() - woke} ms)`);
			check(await page.locator('#mp-sleeping').isHidden(), 'the sleeping text is gone');
			const firstRow = page.locator('#mp-worlds .world-row').first();
			check((await firstRow.innerText()).includes('Busy World') && (await firstRow.innerText()).includes('Léo'), 'the busiest world is listed first, with who is in it');
			check(await firstRow.evaluate((e) => e.classList.contains('selected')), 'the busiest world is preselected');
			// New World: Create posts, then lists and selects the new (empty) world over the busy one.
			await page.click('#mp-new');
			await page.fill('#mp-w-name', 'Castle');
			await page.click('#mp-w-create');
			await page.waitForSelector('#mp-worlds .world-row.selected');
			const sel = page.locator('#mp-worlds .world-row.selected');
			check((await sel.innerText()).includes('Castle') && (await sel.innerText()).includes('Sandbox'), 'Create adds the world and selects it');
			check(JSON.parse((await ls(page, 'minicraft:v1:mp')) ?? '{}').worldId === (await sel.getAttribute('data-id')), 'the created world is remembered');
						// Kill the server again: back to sleeping, Single Player still unaffected (step 6).
			mpRows = null;
			await page.click('#mp-retry').catch(() => undefined);
			await page.waitForSelector('#mp-sleeping:not(.hidden)', { timeout: 10_000 });
			check(true, 'a server that goes away shows the sleeping text again');
			await page.click('#menu-back');
			await page.waitForSelector('#home-single');

			// 2b. A 4009 reload: screen 1 with the name-taken message.
			await page.evaluate(() => sessionStorage.setItem('mp:error', 'name_taken'));
			await page.goto(BASE);
			await page.waitForSelector('#mp-name');
			check(await text(page, '#mp-name-error') === 'Someone called Noah is already playing. Pick another name.', 'after a 4009 reload screen 1 says the name is taken');
			check(await page.evaluate(() => sessionStorage.getItem('mp:error')) === null, 'the 4009 reason is shown once');
			await page.click('#menu-back');
			await page.waitForSelector('#home-single');
		}

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
		await page.waitForTimeout(1_000);
		check(await page.locator('#parents-mp-worlds .world-row').count() === 0, 'Parents lists no multiplayer worlds while the server is asleep');
		await page.selectOption('#max-duration', '45');
		const opts = JSON.parse((await ls(page, 'minicraft:v1:options')) ?? '{}');
		check(opts.maxDurationMin === 45, `the maximum is saved (got ${opts.maxDurationMin})`);
		await page.click('#menu-back');

		if (MP_URL !== '') {
			// 4b. Parents with the server awake: the multiplayer worlds, Delete (409 while occupied).
			mpRows = [
				{ uuid: 'w-busy', name: 'Busy World', mustMine: true, createdAt: 1, online: [{ name: 'Léo', skin: 'green' }] },
				{ uuid: 'w-empty', name: 'Empty World', mustMine: false, createdAt: 2, online: [] },
			];
			const dialogs: string[] = [];
			page.on('dialog', (d) => dialogs.push(d.message()));
			await page.click('#home-parents');
			await page.waitForSelector('#parents-mp-worlds .world-row');
			check(await page.locator('#parents-mp-worlds .world-row').count() === 2, 'Parents lists the multiplayer worlds when the server is reachable');
			await page.locator('#parents-mp-worlds .world-row[data-id="w-busy"] .delete').click();
			await page.waitForSelector('text=Someone is playing in it right now.');
			check(dialogs.includes('Delete "Busy World" for everyone?'), `Delete confirms with the world's name (got ${JSON.stringify(dialogs)})`);
			check(mpRows.length === 2, 'an occupied world is not deleted');
			await page.locator('#parents-mp-worlds .world-row[data-id="w-empty"] .delete').click();
			await page.waitForFunction(() => document.querySelectorAll('#parents-mp-worlds .world-row').length === 1);
			check(mpRows.length === 1 && mpRows[0].uuid === 'w-busy', 'an empty world is deleted');
			mpRows = null;
			await page.click('#menu-back');
		}

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
