// scripts/menu-smoke.ts — headless browser smoke of the menus (multiplayer spec §8).
//
//   npx tsx scripts/menu-smoke.ts [--port 5173] [--mp-url http://127.0.0.1:1 | --mp-url none]
//
// Starts its OWN Vite dev server on --port (default 5173, --strictPort: if the port is busy it
// stops and says so; it never reuses or stops a server it did not start) with
// VITE_MINICRAFT_API_URL pointed at a dead local port, and drives a headless Chromium:
// home (Single Player, Multiplayer, a stone Parents button) → Multiplayer (name screen, sleeping server, automatic
// recovery, the name-taken message) → Parents (how to schedule, PIN form, multiplayer worlds) →
// Single Player free play (duration control, New World → Create → Play: the world loads) →
// reload (world and duration remembered) → Schedule (PIN typed twice, the dialog, OK locks the
// menu, a reload keeps the lock; Change to Now; used up → All done; +15; End schedule) → Parents
// behind the PIN; Remove PIN.
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
// No default: the caller passes it. An embedded default here could point at another live session's directory.
const MENU_SMOKE_SCRATCH = process.env.MENU_SMOKE_SCRATCH ?? '';
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
			check(await page.locator('.home-button').count() === 2, 'no multiplayer URL: home shows Single Player and Parents');
			check(await page.locator('#home-multi').count() === 0, 'no multiplayer URL: the Multiplayer button is hidden');
		} else {
			check(await page.locator('.home-button').count() === 3, 'home shows three buttons');
			check(await text(page, '#home-single') === 'Single Player' && await text(page, '#home-multi') === 'Multiplayer' && await text(page, '#home-parents') === 'Parents', 'they read Single Player, Multiplayer, Parents');
		}
		check(await page.locator('text=Grown-ups').count() === 0, 'no "Grown-ups" label left');
		check(await page.locator('#play-line').isHidden(), 'no plan: home has no status line');

		if (MP_URL !== '') {
			// 2. Multiplayer. Screen 1: a refused name shows the reason and Next refuses.
			await page.click('#home-multi');
			await page.waitForSelector('#mp-name');
			check(await page.locator('#mp-skins .skin-swatch').count() === 6, 'screen 1 has the 6 character buttons');
			await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLCanvasElement>('#mp-skins canvas')).every((c) => {
				const ctx = c.getContext('2d');
				if (!ctx) return false;
				const d = ctx.getImageData(0, 0, c.width, c.height).data;
				for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
				return false;
			}), null, { timeout: 10_000 });
			check(true, 'every character preview canvas painted non-transparent pixels');
			await page.fill('#mp-name', 'Noah!');
			await page.click('#mp-next');
			check(await text(page, '#mp-name-error') === 'Only letters, numbers and spaces', 'a bad name shows "Only letters, numbers and spaces"');
			check(await page.locator('#mp-name').count() === 1, 'Next refuses a bad name');
			await page.fill('#mp-name', ' Noah ');
			await page.click('#mp-skin-jj');
			if (MENU_SMOKE_SCRATCH !== '') {
				for (const w of ['360px', '480px']) {
					await page.evaluate((width) => { (document.querySelector('.menu-card') as HTMLElement).style.width = width; }, w);
					await page.locator('.menu-card').screenshot({ path: `${MENU_SMOKE_SCRATCH}/picker-${parseInt(w, 10)}.png` });
				}
				await page.evaluate(() => { (document.querySelector('.menu-card') as HTMLElement).style.width = ''; });
			}
			await page.click('#mp-next');
			// Screen 2 on a dead port: the sleeping text, a Retry button, and retries on its own.
			await page.waitForSelector('#mp-sleeping:not(.hidden)', { timeout: 10_000 });
			check((await text(page, '#mp-sleeping')).includes('The multiplayer server is sleeping. Ask a parent to wake it up.'), 'a dead server shows the sleeping text');
			check(await page.locator('#mp-retry').isVisible(), 'the sleeping screen has a Retry button');
			check((await text(page, '#mp-playing')).includes('Playing as Noah (JJ)'), 'screen 2 shows "Playing as Noah (JJ)"');
			check(await page.locator('#mp-playing .mp-mini').count() === 1, 'screen 2 shows a mini full-body preview instead of a colour dot');
			const prefs = JSON.parse((await ls(page, 'minicraft:v1:mp')) ?? '{}');
			check(prefs.name === 'Noah' && prefs.skin === 'jj' && typeof prefs.bid === 'string', `name, skin and bid are remembered (got ${JSON.stringify(prefs)})`);
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

			// 2c. A returning player with a pre-skins save: a remembered name but an old colour id
			// ("red") that no longer maps to a character. Screen 1 must show once (final-fix brief),
			// not skip straight to screen 2 with a made-up character.
			await page.evaluate(() => localStorage.setItem('minicraft:v1:mp', JSON.stringify({ name: 'Noah', skin: 'red', worldId: null, bid: 'smoke-bid' })));
			await page.goto(BASE);
			await page.click('#home-multi');
			await page.waitForSelector('#mp-name');
			check(await page.locator('#mp-name').inputValue() === 'Noah', 'a saved name with no valid character still shows screen 1, name pre-filled');
			check(await page.locator('#mp-skin-milo').evaluate((e) => e.classList.contains('selected')), 'screen 1 pre-selects Milo when the saved skin is invalid');
			await page.click('#mp-skin-jj');
			await page.click('#mp-next');
			await page.waitForSelector('#mp-sleeping:not(.hidden)', { timeout: 10_000 });
			check((await text(page, '#mp-playing')).includes('Playing as Noah (JJ)'), 'after picking a character once, screen 2 shows it');
			await page.goto(BASE);
			await page.click('#home-multi');
			await page.waitForSelector('#mp-sleeping:not(.hidden)', { timeout: 10_000 });
			check(true, 'a second visit goes straight to screen 2: the character is only picked once');
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

		// 4. Parents (no PIN): how to schedule, the PIN form, the multiplayer worlds.
		await page.click('#home-parents');
		await page.waitForSelector('#parents-how');
		for (const sel of ['#parents-how', '#pin-set-input', '#pin-set-again', '#pin-save', '#parents-mp-worlds']) {
			check(await page.locator(sel).count() === 1, `Parents has ${sel}`);
		}
		check(await page.locator('#reset-play').count() === 0, 'no free-play timer running: no Reset play time');
		await page.waitForTimeout(1_000);
		check(await page.locator('#parents-mp-worlds .world-row').count() === 0, 'Parents lists no multiplayer worlds while the server is asleep');
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

		// 5. Single Player, free play: the duration control, down to its 10-minute floor.
		await page.click('#home-single');
		await page.waitForSelector('#duration-value');
		check(await page.locator('#single-schedule').count() === 1, 'free play: Single Player offers Schedule');
		await page.click('#duration-minus');
		const menuState = JSON.parse((await ls(page, 'minicraft:v1:menu')) ?? '{}');
		check(menuState.duration === 115, `the duration is remembered in minicraft:v1:menu (got ${menuState.duration})`);
		// Down to the 10-minute floor: Play must start a 10-minute session (plan I1 solo duration wiring).
		for (let i = 0; i < 25 && !(await page.locator('#duration-minus').isDisabled()); i++) await page.click('#duration-minus');
		check(await text(page, '#duration-value') === '10 min', `− stops at 10 min (got ${await text(page, '#duration-value')})`);
		check(await page.locator('#duration-minus').isDisabled(), '− is disabled at 10 min');

		// 6. New World → Create: listed first and selected. Play: the world loads.
		await page.click('#single-new');
		await page.fill('#w-name', 'Smoke World');
		await page.fill('#w-seed', '3');
		await page.click('#w-create');
		await page.waitForSelector('#single-worlds .world-row');
		const first = page.locator('#single-worlds .world-row').first();
		check((await first.innerText()).includes('Smoke World') && await first.locator('.badge-new').count() === 1, 'the created world is listed first with the New badge');
		check(await first.evaluate((e) => e.classList.contains('selected')), 'the created world is selected');
		check(await text(page, '#duration-value') === '10 min', 'the duration survives Create');
		// A leftover multiplayer autojoin flag: starting a solo game must clear it (re-gate I1).
		await page.evaluate(() => sessionStorage.setItem('mp:autojoin', JSON.stringify({ world: 'w-x', name: 'Noah', skin: 'jj', duration: 30 })));
		await page.click('#single-play');
		await page.waitForFunction(() => (window as unknown as { __mc?: unknown }).__mc !== undefined, null, { timeout: 60_000 });
		await page.waitForFunction(() => {
			const m = (window as unknown as { __mc: { loop: { stats: { streamQueue: number; mounted: number } } } }).__mc;
			return m.loop.stats.streamQueue === 0 && m.loop.stats.mounted >= 81;
		}, null, { timeout: 60_000 });
		check(true, 'Single Player → New World → Create → Play loads the world');
		const pt = JSON.parse((await ls(page, 'minicraft:v1:playtime')) ?? '{}');
		check(pt.limitMs === 600_000, `Play with 10 min starts a 10-minute session (limitMs ${pt.limitMs})`);
		check(await page.evaluate(() => sessionStorage.getItem('mp:autojoin')) === null, 'starting a solo game clears mp:autojoin');
		check(await page.evaluate(() => (window as unknown as { __mc: { mp: unknown } }).__mc.mp) === null, 'solo: no multiplayer session objects');
		// Pause card: the texture credits link (texture replacement spec §4.4) opens CREDITS.txt next to index.html.
		await page.keyboard.press('Escape');
		await page.waitForSelector('#pause-credits');
		check(await page.locator('#pause-credits').getAttribute('href') === 'CREDITS.txt', 'the pause card links "Texture credits" to CREDITS.txt (relative)');
		check((await page.request.get(new URL('CREDITS.txt', page.url()).toString())).status() === 200, 'CREDITS.txt is served next to index.html');
		await page.click('#pause-resume');
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
		check(await text(page, '#duration-value') === '10 min', 'after a reload the duration is remembered');
		await page.click('#menu-back');

		// 8. Schedule from Single Player: a PIN first (typed twice), then the dialog; OK locks the menu.
		const worldRow = page.locator('#single-worlds .world-row.selected');
		await page.click('#home-single');
		await page.waitForSelector('#single-schedule');
		const lockedId = await worldRow.getAttribute('data-id');
		await page.click('#single-schedule');
		await page.waitForSelector('#pin-set-input');
		await page.fill('#pin-set-input', '1234');
		await page.fill('#pin-set-again', '1243');
		await page.click('#pin-save');
		check(await text(page, '#pin-msg') === "The two PINs don't match.", `a mistyped PIN is refused (got ${await text(page, '#pin-msg')})`);
		check(await ls(page, 'minicraft:v1:pin') === null, 'a mistyped PIN is not stored');
		await page.fill('#pin-set-again', '1234');
		await page.click('#pin-save');
		await page.waitForSelector('#sched-ok');
		check(await ls(page, 'minicraft:v1:pin') === '1234', 'Save PIN stores the PIN');
		check(await page.locator('#sched-only').isChecked(), 'the selected world is locked by default');
		const later = await page.evaluate(() => { const d = new Date(Date.now() + 2 * 3_600_000 + 5 * 60_000); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; });
		await page.fill('#sched-time', later);
		check((await text(page, '#sched-ok')).startsWith('Lock: Smoke World · '), `OK reads the plan back (got ${await text(page, '#sched-ok')})`);
		check(await ls(page, 'minicraft:v1:plan') === null, 'nothing is written before OK');
		await page.click('#sched-ok');
		await page.waitForSelector('#play-line');
		const plan = JSON.parse((await ls(page, 'minicraft:v1:plan')) ?? '{}');
		check(plan.mode === 'solo' && plan.worldId === lockedId && plan.limitMin === 45, `the plan is stored (got ${JSON.stringify(plan)})`);
		check((await text(page, '#play-line')).startsWith('Not yet · play at '), `before the start: Not yet (got ${await text(page, '#play-line')})`);
		check((await text(page, '#play-line')).endsWith('· in 2 hours'), 'the countdown is coarse');
		check(await page.locator('#single-play').isDisabled(), 'before the start Play is disabled');
		check(await page.locator('#single-new').count() === 0 && await page.locator('#single-worlds .delete').count() === 0, 'under a plan: no New World, no Delete');
		check(await page.locator('#single-worlds .world-row').count() === 1, 'a locked world: only that world is listed');
		check(await page.locator('#menu-back').count() === 0 && await page.locator('#plan-parents').count() === 1, 'under a plan: no Back to home, a Parents button');
		// A reload lands on the same lock.
		await page.goto(BASE);
		await page.waitForSelector('#play-line');
		check((await text(page, '#play-line')).startsWith('Not yet'), 'a reload shows the same lock');
		check(await page.locator('#home-single').count() === 0, 'a reload does not reach home');

		// Parents on the lock: PIN, then Change to Now → Play lights up without a reload.
		await page.click('#plan-parents');
		await page.fill('#pin-input', '9999');
		await page.click('#pin-go');
		check(await text(page, '#pin-error') === 'Wrong PIN', 'a wrong PIN is refused');
		await page.fill('#pin-input', '1234');
		await page.click('#pin-go');
		await page.waitForSelector('#plan-summary');
		check((await text(page, '#plan-summary')).startsWith('Starts '), `the parent sees when it starts (got ${await text(page, '#plan-summary')})`);
		await page.click('#plan-change');
		await page.waitForSelector('#sched-now');
		await page.check('#sched-now');
		await page.click('#sched-ok');
		await page.waitForSelector('#single-play:not([disabled])');
		check(await text(page, '#play-line') === '45 minutes left', `in time: minutes left (got ${await text(page, '#play-line')})`);
		const changed = JSON.parse((await ls(page, 'minicraft:v1:plan')) ?? '{}');
		check(changed.id === plan.id, 'Change keeps the plan (its played time)');

		// Used up: All done, Play off; +15 gives 15 minutes; End schedule frees play.
		await page.evaluate((id) => {
			const now = Date.now();
			localStorage.setItem('minicraft:v1:playtime', JSON.stringify({ limitMs: 2_700_000, breakMs: null, playedMs: 2_700_000, frozenAt: now, startedAt: now, updatedAt: now, planId: id }));
		}, plan.id);
		await page.goto(BASE);
		await page.waitForSelector('#play-line');
		check(await text(page, '#play-line') === 'All done! · your world is saved', `used up: All done (got ${await text(page, '#play-line')})`);
		check(await page.locator('#single-play').isDisabled(), 'used up: Play is disabled');
		await page.click('#plan-parents');
		await page.fill('#pin-input', '1234');
		await page.click('#pin-go');
		await page.waitForSelector('#plan-plus');
		await page.click('#plan-plus');
		await page.waitForSelector('#plan-msg.ok');
		check(await text(page, '#plan-msg') === '✓ Added 15 minutes.', `+15 confirms (got ${await text(page, '#plan-msg')})`);
		await page.click('#menu-back');
		await page.waitForSelector('#single-play:not([disabled])');
		check(await text(page, '#play-line') === '15 minutes left', `+15 gives 15 minutes (got ${await text(page, '#play-line')})`);
		await page.click('#plan-parents');
		await page.fill('#pin-input', '1234');
		await page.click('#pin-go');
		await page.waitForSelector('#plan-end');
		await page.click('#plan-end');
		await page.waitForSelector('#home-single');
		check(await ls(page, 'minicraft:v1:plan') === null && await ls(page, 'minicraft:v1:playtime') === null, "End schedule removes the plan and its session");
		check(await page.locator('#play-line').isHidden(), 'after End: free play, no status line');

		// 9. Parents behind the PIN; Remove PIN.
		await page.click('#home-parents');
		check(await page.locator('#parents-how').count() === 0, 'with a PIN set, Parents is gated');
		await page.fill('#pin-input', '1234');
		await page.click('#pin-go');
		await page.waitForSelector('#pin-reset');
		await page.click('#pin-reset');
		await page.waitForSelector('#pin-msg2.ok');
		check(await ls(page, 'minicraft:v1:pin') === null, 'Remove PIN removes it');
	} catch (e) {
		check(false, `run threw: ${(e as Error).message}`);
	} finally {
		await browser.close();
		stopDev?.();
	}
	console.log(failures.length === 0 ? 'menu-smoke: PASS' : `menu-smoke: ${failures.length} FAILED`);
	process.exit(failures.length === 0 ? 0 : 1);
})();
