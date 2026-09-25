// scripts/cheat-smoke.ts — browser smoke of the cheat codes (spec 2026-09-25-cheat-codes-design §11 tests 6–10).
//
//   npm run smoke:cheats -- --port 5186
//
// Starts its OWN Vite dev server on --port (required; never 5173 or 8080; --strictPort) with
// VITE_MINICRAFT_API_URL on a dead local port, drives HEADLESS Chromium at 1280×720 in a new
// Sandbox world. Exit 0 = every check passed, 1 = a check failed, 2 = the page tried to reach a
// non-localhost host. It stops only the server it started, by port.
import { chromium, type Page } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';

function arg(name: string): string | null {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : null;
}
const PORT = Number(arg('--port'));
if (!Number.isInteger(PORT) || PORT === 5173 || PORT === 8080) {
	console.error('cheat-smoke: pass --port <free port> (never 5173 or 8080)');
	process.exit(1);
}
const DEAD_API = 'http://127.0.0.1:9099';
let stopDev: (() => void) | null = null;
const failures: string[] = [];
function check(ok: boolean, what: string) {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
	if (!ok) failures.push(what);
}

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
		console.error(`cheat-smoke: ABORT — the page tried to reach ${url.href}`);
		void route.abort();
		stopDev?.();
		process.exit(2);
	});
}

type Mc = {
	player: { inventory: Record<string, number>; tools: { owned: number[]; equipped: number }; selected: number };
	markDirtyCalls(): number;
	loop: { stats: { streamQueue: number; mounted: number } };
};
const mc = <T>(page: Page, fn: (m: Mc) => T) => page.evaluate(`(${fn.toString()})(window.__mc)`) as Promise<T>;
const inv = (page: Page, name: string) => mc(page, (m) => m.player.inventory).then((i) => i[name] ?? 0);
const isOpen = (page: Page) => page.locator('#inventory-root').isVisible();
const boxValue = (page: Page) => page.locator('.inventory-search').inputValue();
/**
 * The blur→rAF refocus lands one frame later: wait for it before typing (else "Jump!" loses its J).
 * Resolves true/false, never throws, so a missing refocus prints a FAIL line through check().
 */
const boxFocused = (page: Page) => page.waitForFunction(() => document.activeElement === document.querySelector('.inventory-search'), null, { timeout: 2_000 }).then(() => true, () => false);
/** Blur events on the search box so far (the listener is installed after the world loads). */
const blurs = (page: Page) => page.evaluate(() => (window as unknown as { __searchBlurs: number }).__searchBlurs);
const badge = (page: Page, name: string) => page.locator(`.inventory-tile[data-block="${name}"] .count-badge`).innerText().then((s) => s.trim());

async function enterWorld(page: Page) {
	await page.waitForFunction(() => (window as unknown as { __mc?: unknown }).__mc !== undefined, null, { timeout: 60_000 });
	await page.waitForFunction(() => {
		const m = (window as unknown as { __mc: Mc }).__mc;
		return m.loop.stats.streamQueue === 0 && m.loop.stats.mounted >= 81;
	}, null, { timeout: 60_000 });
}

process.on('exit', () => stopDev?.());
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => process.exit(130));

(async () => {
	stopDev = await startDev();
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
		await guard(page);
		await page.addInitScript('window.__name = (f) => f;');
		await page.goto(`http://localhost:${PORT}/`);
		// A new Sandbox world (no must-mine): home → Single Player → New World → Create → Play.
		await page.click('#home-single');
		await page.click('#single-new');
		await page.fill('#w-seed', '5');
		await page.click('#w-create');
		await page.click('#single-play');
		await enterWorld(page);
		// Count blur events on the box: the refocus hides a blur from activeElement, not from this counter.
		await page.evaluate(() => {
			const w = window as unknown as { __searchBlurs: number };
			w.__searchBlurs = 0;
			document.querySelector('.inventory-search')!.addEventListener('blur', () => { w.__searchBlurs++; });
		});

		// --- Held keys: a repeat keydown for a letter is swallowed (spec §5). ---
		// A synthetic keydown never types, so the oracle is defaultPrevented: the guard calls preventDefault.
		await page.keyboard.press('KeyI');
		const held = await page.evaluate(() => {
			const box = document.querySelector('.inventory-search') as HTMLInputElement;
			const fire = (code: string, key: string) => {
				const ev = new KeyboardEvent('keydown', { code, key, repeat: true, bubbles: true, cancelable: true });
				box.dispatchEvent(ev);
				return ev.defaultPrevented;
			};
			return { i: fire('KeyI', 'i'), w: fire('KeyW', 'w'), box: box.value };
		});
		check(held.i && held.w && held.box === '', `held I and W repeats are swallowed (I ${held.i}, W ${held.w}, box ${JSON.stringify(held.box)})`);
		await page.keyboard.press('Escape'); // empty box: closes

		// --- Test 6: I then type at once (J1). ---
		await page.keyboard.press('KeyI');
		await page.keyboard.type('I am so rich!');
		check(await boxValue(page) === 'I am so rich!', `the box holds exactly the code, no leading "i" (got ${JSON.stringify(await boxValue(page))})`);
		await page.keyboard.press('Enter');
		check(await isOpen(page), 'the I screen is still open after typing "I am so rich!"');
		check(await inv(page, 'deepslate_emerald_ore') === 500, 'deepslate_emerald_ore is 500');
		check(await boxValue(page) === '', 'a granted code empties the box');
		// Own a second pickaxe first, so a stray P would really switch; the alias covers J3 in the browser.
		await page.keyboard.type("I'm Mole Man");
		await page.keyboard.press('Enter');
		check(await mc(page, (m) => m.player.tools.equipped) === 4, `"I'm Mole Man" (alias): the Iron Pickaxe is equipped`);
		await page.keyboard.type('Jump!');
		await page.keyboard.press('Enter');
		check(await isOpen(page), 'the I screen is still open after "Jump!"');
		check(await mc(page, (m) => m.player.tools.equipped) === 4, 'the P in "Jump!" did not swap the pickaxe (still Iron)');
		check(await inv(page, 'slime_pad') === 50, 'slime_pad is 50');

		// --- Test 7: click, Tab, Shift+Tab and the backdrop keep the box. ---
		const blurs0 = await blurs(page);
		await page.click('.inventory-tile[data-block="stone"]');
		check(await blurs(page) === blurs0, `a tile click never blurs the box (blur events ${blurs0} → ${await blurs(page)})`);
		check(await boxFocused(page), 'after a tile click, focus is in the box');
		await page.keyboard.type('Tunnel this!');
		await page.keyboard.press('Enter');
		check(await isOpen(page) && await inv(page, 'tunnel_tnt') === 50, 'after a tile click, "Tunnel this!" grants and the screen stays open');
		await page.keyboard.press('Tab');
		check(await boxFocused(page), 'after Tab, focus returns to the box');
		await page.keyboard.press('Shift+Tab');
		check(await boxFocused(page), 'after Shift+Tab, focus returns to the box');
		const spot = await page.evaluate(() => {
			const card = document.querySelector('.inventory-card')!.getBoundingClientRect();
			const x = Math.max(4, Math.floor(card.left / 2)), y = Math.floor(window.innerHeight / 2);
			return { x, y, root: document.elementFromPoint(x, y)?.id ?? '' };
		});
		check(spot.root === 'inventory-root', `the backdrop point (${spot.x}, ${spot.y}) is #inventory-root (got ${spot.root})`);
		await page.mouse.click(spot.x, spot.y);
		check(await boxFocused(page), 'after a backdrop click, focus returns to the box');
		await page.keyboard.type('Jump!');
		await page.keyboard.press('Enter');
		check(await isOpen(page) && await inv(page, 'slime_pad') === 100, 'after Tab, Shift+Tab and a backdrop click, "Jump!" grants (slime_pad 100)');

		// --- Test 8: no match keeps the box. ---
		await page.keyboard.type('diamond');
		await page.keyboard.press('Enter');
		check(await boxValue(page) === 'diamond', 'no match: the box still says "diamond"');
		check(!(await page.locator('.inventory-tile[data-block="stone"]').isVisible()), 'no match: the grid is still filtered');
		await page.keyboard.press('Escape'); // clears; the screen stays open

		// --- Test 9: grant, toast and markDirty (one evaluate). ---
		const g = await page.evaluate(() => {
			const m = (window as unknown as { __mc: Mc }).__mc;
			const box = document.querySelector('.inventory-search') as HTMLInputElement;
			const n0 = m.markDirtyCalls();
			box.value = '  big BOOM!! ';
			box.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true }));
			return { calls: m.markDirtyCalls() - n0, box: box.value, big: m.player.inventory.big_tnt ?? 0 };
		});
		check(g.calls === 1, `one Enter = exactly one markDirty (got ${g.calls})`);
		check(g.box === '' && g.big === 50, `the box is empty and big_tnt is 50 (box ${JSON.stringify(g.box)}, big_tnt ${g.big})`);
		check(await badge(page, 'big_tnt') === '50', 'the Big TNT tile shows 50');
		const t = await page.evaluate(() => {
			const host = document.getElementById('mp-toasts')!;
			const toasts = [...host.querySelectorAll('.mp-toast')];
			const pill = document.getElementById('save-status')!.getBoundingClientRect();
			return {
				solo: host.classList.contains('solo'),
				n: toasts.length,
				text: toasts.map((e) => e.textContent ?? ''),
				hostZ: Number(getComputedStyle(host).zIndex),
				invZ: Number(getComputedStyle(document.getElementById('inventory-root')!).zIndex),
				top: toasts[0]?.getBoundingClientRect().top ?? -1,
				pillBottom: pill.bottom,
				pillHeight: pill.height,
			};
		});
		check(t.solo, 'the toast host has .solo in a solo game');
		check(t.n === 1 && t.text[0].includes('Big Boom!'), `exactly one toast, and it says "Big Boom!" (${JSON.stringify(t.text)})`);
		check(t.hostZ > t.invZ, `toast z-index ${t.hostZ} is above the I screen's ${t.invZ}`);
		// The pill is laid out in solo even at opacity 0 (class "saved"), so its box is its solo position.
		check(t.pillHeight > 0 && t.top >= t.pillBottom, `the toast (top ${t.top}) is below the save pill (bottom ${t.pillBottom})`);
		await page.keyboard.type('Big Boom');
		await page.keyboard.press('Enter');
		check(await inv(page, 'big_tnt') === 100, 'a repeat stacks: big_tnt 100');
		check(await page.locator('#mp-toasts .mp-toast').count() === 1, 'a second cheat toast replaced the first');

		// --- Review Focus legs. ---
		// Esc after grant: the box is empty, so one Esc closes. Reopen: empty and focused.
		await page.keyboard.press('Escape');
		check(!(await isOpen(page)), 'Esc after a grant closes the I screen in one press');
		// J5 Esc only: I types, never closes; Esc clears, then Esc closes.
		await page.keyboard.press('KeyI');
		await page.keyboard.press('KeyI');
		await page.keyboard.press('KeyI');
		check(await isOpen(page) && await boxValue(page) === 'ii', `I, I: the screen stays open and the box holds "ii" (got ${JSON.stringify(await boxValue(page))})`);
		await page.keyboard.press('Escape');
		check(await isOpen(page) && await boxValue(page) === '', 'the first Esc clears the text and keeps the screen open');
		await page.keyboard.press('Escape');
		check(!(await isOpen(page)), 'the second Esc closes the screen');
		await page.keyboard.press('KeyI');
		check(await isOpen(page) && await boxValue(page) === '', 'reopen: the screen opens with an empty box');
		check(await boxFocused(page), 'reopen: the box has focus');
		await page.keyboard.type('Mole Power!');
		await page.keyboard.press('Enter');
		// Test 10 rides on the reopen leg.
		check(await page.locator('#hud-pickaxe').getAttribute('data-tier') === '6', 'Mole Power!: the HUD shows the diamond pickaxe');
		// Wheel scrolls the grid (Review Focus 1; the scrollbar drag was probed at gate 2).
		const before = await page.locator('.inventory-grid').evaluate((e) => e.scrollTop);
		await page.locator('.inventory-grid').hover();
		await page.mouse.wheel(0, 600);
		await page.waitForTimeout(300);
		check(await page.locator('.inventory-grid').evaluate((e) => e.scrollTop) > before, 'the mouse wheel over the Blocks grid scrolls it');
		// Strip click selects a slot and focus returns to the box.
		const sel0 = await mc(page, (m) => m.player.selected);
		const target = (sel0 + 3) % 9;
		await page.locator('.inventory-strip > *').nth(target).click();
		check(await mc(page, (m) => m.player.selected) === target, `a strip click selects slot ${target}`);
		check(await boxFocused(page), 'after a strip click, focus is in the box');
		// Craft round trip: I closes from Craft; back on Blocks the box has focus.
		await page.click('.inventory-tab[data-tab="craft"]');
		await page.keyboard.press('KeyI');
		check(!(await isOpen(page)), 'I on the Craft tab closes the screen');
		await page.keyboard.press('KeyI');
		await page.click('.inventory-tab[data-tab="blocks"]');
		check(await boxFocused(page), 'back on Blocks, the box has focus');
		await page.keyboard.press('Escape');

		// Persistence: wait past AutoSave's 5 s debounce, reload, and continue the same world.
		await page.waitForTimeout(6_000);
		await page.reload();
		await page.click('#home-single');
		await page.waitForSelector('#single-worlds .world-row.selected');
		await page.click('#single-play');
		await enterWorld(page);
		check(await inv(page, 'big_tnt') === 100, 'after a reload big_tnt is still 100');
		check(await inv(page, 'deepslate_emerald_ore') === 500, 'after a reload deepslate_emerald_ore is still 500');
		check(await mc(page, (m) => m.player.tools.owned.includes(6)), 'after a reload the Diamond Pickaxe is still owned');
	} finally {
		await browser.close();
	}
	stopDev?.();
	console.log(failures.length === 0 ? 'cheat-smoke: PASS' : `cheat-smoke: ${failures.length} FAIL`);
	process.exit(failures.length === 0 ? 0 : 1);
})().catch((e) => {
	console.error(e);
	stopDev?.();
	process.exit(1);
});
