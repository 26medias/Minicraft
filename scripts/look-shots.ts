// scripts/look-shots.ts — screenshots of a fixed set of views, for judging lighting changes by eye.
//
//   npx tsx scripts/look-shots.ts --port 5187 --out <dir> [--seed 5]
//
// Starts its OWN Vite dev server on --port (never 5173 or 8080; --strictPort) with
// VITE_MINICRAFT_API_URL on a dead local port, drives HEADLESS Chromium at 1280×720 in a new
// Sandbox world, flies up above spawn and saves one PNG per view. Any non-localhost request
// aborts the run (exit 2). It stops only the server it started, by port.
import { chromium, type Page } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

function arg(name: string): string | null {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : null;
}
const PORT = Number(arg('--port'));
const OUT = arg('--out');
const SEED = arg('--seed') ?? '5';
/** --no-cloud-shadow: every view without cloud shadows (to compare terrain with a build that has none). */
const NO_CLOUD_SHADOW = process.argv.includes('--no-cloud-shadow');
if (!Number.isInteger(PORT) || PORT === 5173 || PORT === 8080 || !OUT) {
	console.error('look-shots: pass --port <free port> (never 5173 or 8080) and --out <dir>');
	process.exit(1);
}
const DEAD_API = 'http://127.0.0.1:9099';
let stopDev: (() => void) | null = null;

async function startDev(): Promise<() => void> {
	try {
		await fetch(`http://localhost:${PORT}/`);
		throw new Error(`port ${PORT} is already serving; this script never reuses a server it did not start`);
	} catch (e) {
		if ((e as Error).message.startsWith('port')) throw e;
	}
	const p = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
		env: { ...process.env, VITE_MINICRAFT_API_URL: DEAD_API },
		stdio: 'ignore',
	});
	const stop = () => { spawnSync('fuser', ['-k', `${PORT}/tcp`], { stdio: 'ignore' }); p.kill(); };
	for (let i = 0; i < 60; i++) {
		if (p.exitCode !== null) throw new Error(`dev server exited with ${p.exitCode}`);
		try { await fetch(`http://localhost:${PORT}/`); return stop; }
		catch { await new Promise((r) => setTimeout(r, 500)); }
	}
	stop();
	throw new Error('dev server did not start');
}

async function guard(page: Page) {
	await page.route('**/*', (route) => {
		const url = new URL(route.request().url());
		if (url.origin === DEAD_API) return route.abort();
		if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
		console.error(`look-shots: ABORT — the page tried to reach ${url.href}`);
		void route.abort();
		stopDev?.();
		process.exit(2);
	});
}

type Mc = {
	cloudUniforms: { cloudShadowScale: { value: number } };
	player: { position: [number, number, number]; flying: boolean; vy: number };
	cam: { yaw: number; pitch: number };
	loop: { stats: { streamQueue: number; mounted: number } };
};

const settled = (page: Page) => page.waitForFunction(() => {
	const m = (window as unknown as { __mc: Mc }).__mc;
	return m.loop.stats.streamQueue === 0 && m.loop.stats.mounted >= 81;
}, null, { timeout: 90_000 });

// Sun is toward −x, −z (shadows.ts SUN_DIR_RAW): yaw ≈ 1.03 faces it.
const VIEWS: { name: string; yaw: number; pitch: number }[] = [
	{ name: 'toward-sun', yaw: 1.03, pitch: -0.12 },
	{ name: 'away-from-sun', yaw: 1.03 + Math.PI, pitch: -0.25 },
	{ name: 'side-lit', yaw: 1.03 + Math.PI / 2, pitch: -0.2 },
	{ name: 'down', yaw: 1.03 + Math.PI * 0.75, pitch: -0.7 },
	{ name: 'up', yaw: 1.03 + Math.PI / 2, pitch: 0.35 },
	{ name: 'up-steep', yaw: 1.03 + Math.PI / 2, pitch: 0.95 },
];

process.on('exit', () => stopDev?.());
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => process.exit(130));

(async () => {
	mkdirSync(OUT, { recursive: true });
	stopDev = await startDev();
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
		page.setDefaultTimeout(10_000);
		await guard(page);
		await page.addInitScript('window.__name = (f) => f;');
		await page.goto(`http://localhost:${PORT}/`);
		await page.click('#home-single');
		await page.click('#single-new');
		await page.fill('#w-seed', SEED);
		await page.click('#w-create');
		await page.click('#single-play');
		await page.waitForFunction(() => (window as unknown as { __mc?: unknown }).__mc !== undefined, null, { timeout: 60_000 });
		await settled(page);
		await page.evaluate(() => {
			const m = (window as unknown as { __mc: Mc }).__mc;
			m.player.flying = true;
			m.player.vy = 0;
			m.player.position = [m.player.position[0], m.player.position[1] + 18, m.player.position[2]];
		});
		await settled(page);
		if (NO_CLOUD_SHADOW) await page.evaluate(() => { (window as unknown as { __mc: Mc }).__mc.cloudUniforms.cloudShadowScale.value = 0; });
		for (const v of VIEWS) {
			await page.evaluate(([yaw, pitch]) => {
				const m = (window as unknown as { __mc: Mc }).__mc;
				m.cam.yaw = yaw;
				m.cam.pitch = pitch;
			}, [v.yaw, v.pitch]);
			await page.waitForTimeout(400);
			await page.screenshot({ path: `${OUT}/${v.name}.png` });
			console.log(`saved ${OUT}/${v.name}.png`);
		}
		// Straight down: cloud shadows on the ground.
		await page.evaluate(() => {
			const m = (window as unknown as { __mc: Mc }).__mc;
			m.cam.pitch = -1.5;
		});
		await settled(page);
		await page.waitForTimeout(400);
		await page.screenshot({ path: `${OUT}/topdown.png` });
		console.log(`saved ${OUT}/topdown.png`);
		// The same frame without cloud shadows: diff the pair to see exactly where they fall.
		await page.evaluate(() => { (window as unknown as { __mc: Mc }).__mc.cloudUniforms.cloudShadowScale.value = 0; });
		await page.waitForTimeout(200);
		await page.screenshot({ path: `${OUT}/topdown-no-cloud-shadow.png` });
		console.log(`saved ${OUT}/topdown-no-cloud-shadow.png`);
	} finally {
		await browser.close();
		stopDev?.();
	}
})().catch((e) => {
	console.error(e);
	stopDev?.();
	process.exit(1);
});
