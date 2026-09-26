// scripts/sound-smoke.ts — browser smoke of sound (docs/sound.md §9).
//
//   npm run smoke:sound [-- --port 5199]
//
// Starts its OWN Vite dev server on --port (default 5199, --strictPort; never reuses or kills a
// server it did not start) with the save API pointed at a dead local port, drives headless
// Chromium (autoplay allowed, so the AudioContext really runs): mine a stone block with the real
// mouse, place one with the real right-click, stand over a pool, fly to the sky, sit in rock,
// then the Audio screen in the Esc menu and on the main menu.
// Exit 0 = every check passed, 1 = a check failed, 2 = the page tried to leave localhost.
// SAFETY: every request to a host other than localhost/127.0.0.1 aborts the run.
import { chromium, type Page } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { BLOCK_BY_NAME } from '../src/data/blocks.data';

function arg(name: string, def: string) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : def;
}
const PORT = Number(arg('--port', '5199'));
const DEAD_API = 'http://127.0.0.1:9099';
const STONE = BLOCK_BY_NAME['stone'].id;
const PLANKS = BLOCK_BY_NAME['oak_planks'].id;
const WATER = BLOCK_BY_NAME['water'].id;

let stopDev: (() => void) | null = null;
const failures: string[] = [];
function check(ok: boolean, what: string) {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
	if (!ok) failures.push(what);
}

async function startDev(): Promise<() => void> {
	try {
		await fetch(`http://localhost:${PORT}/`);
		throw new Error(`port ${PORT} is already serving. Pass --port <free port>; this script never reuses a server it did not start.`);
	} catch (e) {
		if ((e as Error).message.startsWith('port')) throw e;
	}
	const p = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
		env: { ...process.env, VITE_MINICRAFT_API_URL: DEAD_API },
		stdio: 'ignore',
	});
	// Stop by port only (never pkill by name).
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
		console.error(`sound-smoke: ABORT — the page tried to reach ${url.href}`);
		void route.abort();
		stopDev?.();
		process.exit(2);
	});
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mc = <T>(page: Page, fn: (m: any, a: any) => T, a?: unknown) => page.evaluate(`(${fn.toString()})(window.__mc, ${JSON.stringify(a ?? null)})`) as Promise<T>;
const log = (page: Page) => page.evaluate(() => (window as unknown as { __soundLog: string[] }).__soundLog.slice());
const clearLog = (page: Page) => page.evaluate(() => { (window as unknown as { __soundLog: string[] }).__soundLog.length = 0; });
/** Mouse events under pointer lock turn the camera; aim straight down right before a click. */
const lookDown = (page: Page) => mc(page, (m) => { m.cam.pitch = -Math.PI / 2 + 0.01; });
const levels = (page: Page) => mc(page, (m) => m.audio.debug().levels) as Promise<Record<string, number>>;

process.on('exit', () => stopDev?.());
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => process.exit(130));

(async () => {
	stopDev = await startDev();
	const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
	try {
		const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
		await guard(page);
		await page.addInitScript('window.__name = (f) => f; window.__soundLog = [];');
		await page.goto(`http://localhost:${PORT}/`);

		// 0. The main menu has an Audio button next to Options.
		check(await page.locator('#home-audio').count() === 1, 'main menu: Audio button');

		// Music starts on the main menu at the first click (not only in a world).
		await page.click('#home-single');
		const menuMusic = await page.waitForFunction(() => (window as unknown as { __music: { playing: boolean } }).__music.playing, null, { timeout: 8_000 }).then(() => true, () => false);
		check(menuMusic, 'music plays on the menu within a few seconds of the first click');
		await page.click('#single-new');
		await page.fill('#w-seed', '3');
		await page.click('#w-create');
		await page.click('#single-play');
		await page.waitForFunction(() => (window as unknown as { __mc?: unknown }).__mc !== undefined);
		await page.waitForFunction(() => {
			const m = (window as unknown as { __mc: { loop: { stats: { streamQueue: number; mounted: number } } } }).__mc;
			return m.loop.stats.streamQueue === 0 && m.loop.stats.mounted >= 81;
		}, null, { timeout: 60_000 });

		// Preconditions: the context runs and the files are decoded, or nothing below means anything.
		const ready = await page.waitForFunction(() => {
			const d = (window as unknown as { __mc: { audio: { debug(): { state: string; ready: boolean; loops: boolean } } } }).__mc.audio.debug();
			return d.state === 'running' && d.ready && d.loops;
		}, null, { timeout: 15_000 }).then(() => true, () => false);
		check(ready, `AudioContext running, files decoded, loops started (${JSON.stringify(await mc(page, (m) => m.audio.debug()))})`);
		if (!ready) throw new Error('no audio: stopping');

		// Pointer lock through a real click on the game canvas.
		await page.locator('#app > canvas[data-engine]').click();
		const locked = await page.waitForFunction(() => document.pointerLockElement !== null, null, { timeout: 5_000 }).then(() => true, () => false);
		check(locked, 'pointer lock on the game canvas');

		// A 3×3 stone platform in open air; he stands still on its middle, looking straight down.
		const cell = await mc(page, (m, ids) => {
			const [x, z] = [Math.floor(m.player.position[0]), Math.floor(m.player.position[2])];
			const y = 170;
			for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
				m.world.setBlock(x + dx, y, z + dz, ids.STONE);
				for (let up = 1; up <= 3; up++) m.world.setBlock(x + dx, y + up, z + dz, 0);
			}
			m.loop.markChunkDirtyAround(x, z);
			m.loop.applyLightUpdate(x, y, z);
			m.player.flying = false;
			m.player.position = [x + 0.5, y + 1, z + 0.5];
			m.player.vy = 0;
			m.player.tools.equipped = 0;
			m.cam.pitch = -Math.PI / 2 + 0.01;
			return { x, y, z };
		}, { STONE });
		await page.waitForTimeout(500);
		const standing = await mc(page, (m, c) => Math.abs(m.player.position[1] - (c.y + 1)) < 0.01, cell);
		check(standing, 'standing still on the stone platform');

		// 1. Shift + real right-click replaces the stone underfoot with planks: place_soft.
		await mc(page, (m, ids) => {
			m.player.hotbar[m.player.selected] = ids.PLANKS;
			m.player.inventory.oak_planks = 5;
			m.syncHotbar();
		}, { PLANKS });
		await clearLog(page);
		await lookDown(page);
		await page.keyboard.down('Shift');
		await page.mouse.down({ button: 'right' });
		await page.mouse.up({ button: 'right' });
		await page.keyboard.up('Shift');
		await page.waitForTimeout(200);
		const placed = await log(page);
		const nowPlanks = await mc(page, (m, c) => m.world.getBlock(c.x, c.y, c.z), cell);
		check(nowPlanks === PLANKS, `the stone underfoot became planks (${nowPlanks})`);
		check(placed.length === 1 && placed[0] === 'place_soft', `placing planks plays exactly place_soft (${placed.join(' ')})`);

		// 2. Put the stone back and mine it with the hand: hits every 250 ms, one break, then pickup.
		await mc(page, (m, a) => {
			m.world.setBlock(a.c.x, a.c.y, a.c.z, a.STONE);
			m.loop.markChunkDirtyAround(a.c.x, a.c.z);
		}, { c: cell, STONE });
		await page.waitForTimeout(300);
		await lookDown(page);
		await clearLog(page);
		const t0 = Date.now();
		// The mouse handler's own call (as crafting-smoke mines): a synthetic left click under pointer
		// lock also turns the camera in headless Chromium, which would aim away from the block.
		await mc(page, (m) => m.loop.setLeftMouseDown(true));
		const broke = await page.waitForFunction((c) => (window as unknown as { __mc: { world: { getBlock(x: number, y: number, z: number): number } } }).__mc.world.getBlock(c.x, c.y, c.z) === 0, cell, { timeout: 15_000 }).then(() => true, () => false);
		const took = Date.now() - t0;
		await mc(page, (m) => m.loop.setLeftMouseDown(false));
		await page.waitForTimeout(200);
		check(broke, `the stone broke (${took} ms)`);
		const mined = await log(page);
		console.log(`     sounds: ${mined.join(' ')}`);
		const hits = mined.filter((n) => n === 'hit_stone').length;
		const expected = Math.floor((took - 100) / 250) + 1;
		check(mined.every((n) => ['hit_stone', 'break_stone', 'pickup'].includes(n)), 'only stone sounds and the pickup');
		check(Math.abs(hits - expected) <= 1, `one hit per 250 ms: ${hits} hits in ${took} ms (expected ${expected} ± 1)`);
		check(mined.filter((n) => n === 'break_stone').length === 1 && mined.lastIndexOf('hit_stone') < mined.indexOf('break_stone'), 'one break_stone, after the hits');
		check(mined.indexOf('pickup') > mined.indexOf('break_stone'), 'pickup after the break');

		// 3. Nature. Over a 12×12 pool of still water in the open: lake up, no wind near sea level.
		await mc(page, (m, ids) => {
			m.player.flying = true;
			const [px, , pz] = m.player.position.map(Math.floor);
			const top = 140;
			for (let x = px - 6; x < px + 6; x++) for (let z = pz - 6; z < pz + 6; z++) {
				m.world.setBlock(x, top, z, ids.WATER);
				m.world.setBlock(x, top + 1, z, 0);
				m.world.setBlock(x, top + 2, z, 0);
				m.world.setBlock(x, top + 3, z, 0);
			}
			m.player.position = [px + 0.5, top + 1.2, pz + 0.5];
		}, { WATER });
		await page.waitForTimeout(1500);
		const pool = await levels(page);
		check(pool.lake > 0.5, `standing over a pool: lake ${pool.lake.toFixed(2)} > 0.5`);
		// High in the sky, far from the pool: no water, strong wind.
		await mc(page, (m) => { m.player.position = [m.player.position[0] + 60, 235, m.player.position[2]]; });
		await page.waitForTimeout(1500);
		const sky = await levels(page);
		check(sky.lake === 0 && sky.strong > 0.8, `y 235 in the sky: lake ${sky.lake.toFixed(2)} = 0, strong wind ${sky.strong.toFixed(2)} > 0.8`);
		// Inside the rock (no sky light): no wind.
		await mc(page, (m) => { m.player.position = [m.player.position[0], 60, m.player.position[2]]; });
		await page.waitForTimeout(1500);
		const rock = await levels(page);
		check(rock.light === 0 && rock.strong === 0, `in the rock at y 60: no wind (${rock.light.toFixed(2)}, ${rock.strong.toFixed(2)})`);

		// 4. Esc → Audio: three sliders; Music to 0 is saved and applied.
		await page.evaluate(() => document.exitPointerLock());
		await page.waitForTimeout(300);
		if (!(await mc(page, (m) => m.pause.isOpen()))) await page.keyboard.press('Escape');
		await page.waitForFunction(() => (window as unknown as { __mc: { pause: { isOpen(): boolean } } }).__mc.pause.isOpen(), null, { timeout: 5_000 });
		await page.click('#pause-audio');
		check(await page.locator('#audio-music, #audio-sfx, #audio-ambient').count() === 3, 'Esc → Audio shows three sliders');
		await page.evaluate(() => {
			const el = document.querySelector<HTMLInputElement>('#audio-music')!;
			el.value = '0';
			el.dispatchEvent(new Event('input'));
		});
		const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('minicraft:v1:audio') ?? '{}'));
		check(saved.music === 0 && saved.sfx === 80 && saved.ambient === 80, `Music 0 saved (${JSON.stringify(saved)})`);
		await page.keyboard.press('Escape');
		check(await mc(page, (m) => m.pause.isOpen() && !m.pause.controlsShown()), 'Esc on Audio goes back to the card');

		// 5. The main menu's Audio screen shows the saved value.
		await page.goto(`http://localhost:${PORT}/`);
		await page.click('#home-audio');
		check(await page.locator('#audio-music').inputValue() === '0', 'main menu → Audio shows Music at 0');
	} finally {
		await browser.close();
	}
	console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nall sound checks passed');
	process.exit(failures.length ? 1 : 0);
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
