import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { onFatalClose, type FatalDeps } from './mp-exit';
import { AUTOJOIN_KEY } from './boot';
import { MP_ERROR_KEY } from '../ui/menu';
import { CLOSE, type ErrorMsg } from '../net/protocol';
import { Reconnector, GIVE_UP_MS } from './mp-reconnect';
import { AUTO_RELOAD_KEY, AUTO_RELOAD_WINDOW_MS, UPDATING_SCREEN_MS } from './outdated';

// Gate-2 K2: `mp:autojoin` is cleared BEFORE acting on any fatal close (4001, 4004–4009), so no
// fatal close can turn into a reconnect loop. The one deliberate exception is the outdated
// auto-reload (spec §5): it KEEPS autojoin, so the reload rejoins the world and counts as a
// reconnect for the play timer (bootSession/boot reads the flag, see boot-session.test.ts).

const OUTDATED: ErrorMsg = { t: 'error', code: CLOSE.proto, message: 'outdated', min: 2 };

function harness() {
	const log: string[] = [];
	const m = new Map<string, string>([[AUTOJOIN_KEY, '{"world":"w"}']]);
	let scheduled: { fn: () => void; ms: number } | null = null;
	const deps: FatalDeps = {
		storage: {
			getItem: (k) => m.get(k) ?? null,
			setItem: (k, v) => { log.push(`set ${k}=${v}`); m.set(k, v); },
			removeItem: (k) => { log.push(`remove ${k}`); m.delete(k); },
		},
		reload: () => log.push('reload'),
		showScreen: (kind) => log.push(`screen ${kind}`),
		showUpdating: () => log.push('updating'),
		replace: (url) => log.push(`replace ${url}`),
		href: 'https://noah.leap-forward.ca/minicraft/',
		now: () => 1_000_000,
		setTimeout: (fn, ms) => { scheduled = { fn, ms }; return 0; },
	};
	return { log, m, deps, fireScheduled: () => scheduled?.fn(), scheduled: () => scheduled };
}

const FATAL: Array<[number, string, string | null]> = [
	[CLOSE.replaced, 'screen replaced', null],
	[CLOSE.proto, 'screen updated', null],
	[CLOSE.genUnsupported, 'screen updated', null],
	[CLOSE.unknownWorld, 'reload', 'unknown_world'],
	[CLOSE.badToken, 'reload', 'bad_token'],
	[CLOSE.badName, 'reload', 'bad_name'],
	[CLOSE.nameTaken, 'reload', 'name_taken'],
];

describe('onFatalClose (K2)', () => {
	it.each(FATAL)('%i: the autojoin flag is cleared first, then %s (reason %s)', (code, action, reason) => {
		const { log, m, deps } = harness();
		onFatalClose(code, undefined, deps);
		expect(m.has(AUTOJOIN_KEY)).toBe(false);
		const cleared = log.indexOf(`remove ${AUTOJOIN_KEY}`);
		const acted = log.indexOf(action);
		expect(cleared).toBeGreaterThanOrEqual(0);
		expect(acted).toBeGreaterThan(cleared);
		if (reason) {
			expect(m.get(MP_ERROR_KEY)).toBe(reason);
			expect(log.indexOf(`set ${MP_ERROR_KEY}=${reason}`)).toBeLessThan(acted);
		} else {
			expect(m.has(MP_ERROR_KEY)).toBe(false);
		}
	});

	it('an unknown code still clears the flag and goes back to the menu', () => {
		const { log, m, deps } = harness();
		onFatalClose(4999, undefined, deps);
		expect(m.has(AUTOJOIN_KEY)).toBe(false);
		expect(log.at(-1)).toBe('reload');
	});

	it('4004 without the "outdated" error message is unaffected: the K2 clear plus the updated screen', () => {
		const { log, m, deps } = harness();
		onFatalClose(CLOSE.proto, { t: 'error', code: CLOSE.proto, message: 'something else' }, deps);
		expect(m.has(AUTOJOIN_KEY)).toBe(false);
		expect(log).toEqual([`remove ${AUTOJOIN_KEY}`, 'screen updated']);
	});
});

describe('onFatalClose: outdated auto-reload (spec §5, gate-2 §12a)', () => {
	it('no marker (first outdated close): auto — keeps autojoin, shows Updating, schedules a replace with v=now after UPDATING_SCREEN_MS', () => {
		const { log, m, deps, fireScheduled, scheduled } = harness();
		onFatalClose(CLOSE.proto, OUTDATED, deps);
		expect(m.has(AUTOJOIN_KEY)).toBe(true); // NOT cleared: this reload must count as a reconnect.
		// decideOutdated writes the loop-guard marker before the Updating screen shows.
		expect(log).toEqual([`set ${AUTO_RELOAD_KEY}=1000000`, 'updating']);
		expect(m.get(AUTO_RELOAD_KEY)).toBe('1000000');
		expect(scheduled()?.ms).toBe(UPDATING_SCREEN_MS);
		fireScheduled();
		expect(log.at(-1)).toBe('replace https://noah.leap-forward.ca/minicraft/?v=1000000');
	});

	it('a fresh marker (a second outdated close inside the window): click — clears autojoin, shows the updated screen, schedules nothing', () => {
		const { log, m, deps, scheduled } = harness();
		deps.storage.setItem(AUTO_RELOAD_KEY, String(1_000_000 - 1_000));
		onFatalClose(CLOSE.proto, OUTDATED, deps);
		expect(m.has(AUTOJOIN_KEY)).toBe(false);
		expect(log).toContain('screen updated');
		expect(scheduled()).toBeNull();
	});

	it('a marker exactly at the window boundary: still auto', () => {
		const { m, deps } = harness();
		deps.storage.setItem(AUTO_RELOAD_KEY, String(1_000_000 - AUTO_RELOAD_WINDOW_MS));
		onFatalClose(CLOSE.proto, OUTDATED, deps);
		expect(m.has(AUTOJOIN_KEY)).toBe(true);
	});

	it('a storage that cannot write the marker: click (never loops)', () => {
		const { log, m, deps } = harness();
		deps.storage.setItem = () => { throw new Error('quota'); };
		onFatalClose(CLOSE.proto, OUTDATED, deps);
		expect(m.has(AUTOJOIN_KEY)).toBe(false);
		expect(log).toContain('screen updated');
	});
});

describe('Reconnector (spec §7.5)', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('probes at 1, 2, 4, 8 and 15 s, then gives up at 30 s', async () => {
		const probeAt: number[] = [];
		const t0 = Date.now();
		const onSuccess = vi.fn();
		const onGiveUp = vi.fn();
		const r = new Reconnector({
			probe: () => { probeAt.push(Date.now() - t0); return Promise.reject(new Error('down')); },
			onSuccess, onGiveUp,
		});
		r.start();
		await vi.advanceTimersByTimeAsync(29_999);
		// Literal spec values (§7.5): comparing to RETRY_AT_MS could never go red.
		expect(probeAt).toEqual([1_000, 2_000, 4_000, 8_000, 15_000]);
		expect(onGiveUp).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(GIVE_UP_MS).toBe(30_000);
		expect(onGiveUp).toHaveBeenCalledTimes(1);
		expect(onSuccess).not.toHaveBeenCalled();
	});

	it('the first successful probe calls onSuccess once and stops', async () => {
		let n = 0;
		const onSuccess = vi.fn();
		const onGiveUp = vi.fn();
		const r = new Reconnector({
			probe: () => (++n === 3 ? Promise.resolve([]) : Promise.reject(new Error('down'))),
			onSuccess, onGiveUp,
		});
		r.start();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(n).toBe(3);
		expect(onSuccess).toHaveBeenCalledTimes(1);
		expect(onGiveUp).not.toHaveBeenCalled();
	});
});
