// scripts/menu-shots.ts — screenshots of every menu screen, for eyeballing the menu design.
//
//   npx tsx scripts/menu-shots.ts --out <dir> [--port 5188] [--width 1280 --height 800]
//
// Starts its OWN Vite dev server on --port (strict) with the save API pointed at a dead local port
// and a fake multiplayer server answered from a Playwright route; any request to a non-local host
// is aborted. Never point this at the production site.
import { chromium, type Route } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

function arg(name: string, def: string) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : def;
}
const PORT = Number(arg('--port', '5188'));
const OUT = arg('--out', '');
const W = Number(arg('--width', '1280'));
const H = Number(arg('--height', '800'));
if (OUT === '') throw new Error('--out <dir> is required');
mkdirSync(OUT, { recursive: true });
const DEAD_API = 'http://127.0.0.1:9099';
const MP_URL = 'http://127.0.0.1:9098';
const BASE = `http://localhost:${PORT}/`;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
let mpRows: unknown[] | null = [
	{ uuid: 'a', name: 'Castle Island', mustMine: false, createdAt: 1, online: [{ name: 'Noah', skin: 'milo' }, { name: 'Leo', skin: 'chip' }] },
	{ uuid: 'b', name: 'Mining Trip', mustMine: true, createdAt: 2, online: [] },
];

function fakeMp(route: Route) {
	const req = route.request();
	if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
	if (mpRows === null) return route.abort('connectionrefused');
	return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(mpRows) });
}

async function main() {
	const dev = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
		env: { ...process.env, VITE_MINICRAFT_API_URL: DEAD_API, VITE_MINICRAFT_MP_URL: MP_URL, VITE_MINICRAFT_MP_TOKEN: 'shots' },
		stdio: 'ignore',
	});
	const stop = () => { dev.kill('SIGTERM'); spawnSync('fuser', ['-k', `${PORT}/tcp`]); };
	try {
		for (let i = 0; ; i++) {
			try { await fetch(BASE); break; } catch { if (i > 60) throw new Error('vite did not start'); await new Promise((r) => setTimeout(r, 500)); }
		}
		const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
		const page = await browser.newPage({ viewport: { width: W, height: H } });
		await page.route('**/*', (route) => {
			const url = new URL(route.request().url());
			if (url.origin === DEAD_API) return route.abort();
			if (url.origin === MP_URL) return fakeMp(route);
			if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
			return route.abort();
		});
		page.on('dialog', (d) => void d.dismiss());
		page.on('pageerror', (e) => console.log('pageerror', e.message));
		page.on('console', (m) => { if (m.type() === 'error') console.log('console', m.text()); });
		const shot = async (name: string) => {
			await page.waitForTimeout(400);
			await page.screenshot({ path: `${OUT}/${name}.png` });
			console.log('shot', name);
		};
		await page.addInitScript('window.__name = (f) => f;');
		await page.goto(BASE);
		await page.waitForSelector('#home-single');
		await shot('01-home');
		await page.click('#home-single');
		await page.waitForSelector('#single-new');
		await shot('02-single-empty');
		await page.click('#single-new');
		await shot('03-new-world');
		await page.click('#w-create');
		await page.waitForSelector('#single-play');
		await shot('04-single-created');
		await page.click('#menu-back');
		await page.click('#home-multi');
		await page.waitForSelector('#mp-name');
		await shot('05-mp-name');
		await page.fill('#mp-name', 'Noah');
		await page.click('#mp-next');
		await page.waitForSelector('#mp-worlds .world-row');
		await shot('06-mp-worlds');
		mpRows = null;
		await page.click('#menu-back');
		await page.click('#home-multi');
		await page.waitForSelector('#mp-sleeping:not(.hidden)');
		await shot('07-mp-sleeping');
		mpRows = [];
		await page.click('#menu-back');
		await page.click('#home-parents');
		await page.waitForSelector('#rules-save');
		await shot('08-parents');
		// Rules: 7:00, 45 min a day, and today already used up.
		await page.check('#rule-start-on');
		await page.fill('#rule-start', '07:00');
		await page.selectOption('#rule-daily', '45');
		await page.click('#rules-save');
		await page.waitForSelector('#rules-msg.ok');
		await page.evaluate(() => {
			const now = Date.now();
			localStorage.setItem('minicraft:v1:playtime', JSON.stringify({ limitMs: 2_700_000, breakMs: null, playedMs: 1_200_000, frozenAt: null, startedAt: now, updatedAt: now }));
		});
		await page.click('#menu-back');
		await page.click('#home-parents');
		await page.waitForSelector('#rules-save');
		await shot('08b-parents-rules');
		await page.click('#menu-back');
		await shot('08c-home-rules');
		await page.click('#home-single');
		await page.waitForSelector('#single-play');
		await shot('08d-single-rules');
		await page.click('#menu-back');
		await page.evaluate(() => {
			for (const k of ['minicraft:v1:rules', 'minicraft:v1:playtime', 'minicraft:v1:today']) localStorage.removeItem(k);
		});
		await page.click('#home-options');
		await shot('09-options');
		await page.goto(BASE);
		await page.click('#home-single');
		await page.click('#single-new');
		await page.click('#w-create');
		await page.click('#single-play');
		await page.waitForFunction(() => (window as unknown as { __mc?: unknown }).__mc !== undefined, null, { timeout: 90_000 });
		await page.waitForTimeout(3000);
		await page.keyboard.press('Escape');
		await page.waitForSelector('#pause-root:not(.hidden)');
		await shot('10-pause');
		await page.click('#pause-controls');
		await shot('11-pause-controls');
		await browser.close();
	} finally {
		stop();
	}
}
main().catch((e) => { console.error(e); process.exit(1); });
