import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { onFatalClose, type FatalDeps } from './mp-exit';
import { AUTOJOIN_KEY } from './boot';
import { MP_ERROR_KEY } from '../ui/menu';
import { CLOSE } from '../net/protocol';
import { Reconnector, RETRY_AT_MS, GIVE_UP_MS } from './mp-reconnect';

// Gate-2 K2: `mp:autojoin` is cleared BEFORE acting on any fatal close (4001, 4004–4009), so no
// fatal close can turn into a reconnect loop.

function harness() {
	const log: string[] = [];
	const m = new Map<string, string>([[AUTOJOIN_KEY, '{"world":"w"}']]);
	const deps: FatalDeps = {
		storage: {
			getItem: (k) => m.get(k) ?? null,
			setItem: (k, v) => { log.push(`set ${k}=${v}`); m.set(k, v); },
			removeItem: (k) => { log.push(`remove ${k}`); m.delete(k); },
		},
		reload: () => log.push('reload'),
		showScreen: (kind) => log.push(`screen ${kind}`),
	};
	return { log, m, deps };
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
		onFatalClose(code, deps);
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
		onFatalClose(4999, deps);
		expect(m.has(AUTOJOIN_KEY)).toBe(false);
		expect(log.at(-1)).toBe('reload');
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
		expect(probeAt).toEqual([...RETRY_AT_MS]);
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
