import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bootSession } from './boot-session';
import { AUTOJOIN_KEY, beginSolo, boot, failRejoin, setAutojoin, type AutojoinArgs } from './boot';
import { loadSession, saveSession, PLAYTIME_KEY } from '../persistence/playtime';
import { PIN_KEY, SCHEDULE_KEY } from '../persistence/schedule';
import { MP_PRESELECT_KEY } from '../ui/menu';
import type { PlaytimeSession } from './playtime';
import type { LoadedSchedule } from './schedule';

// T12b (spec §10, plan I1 + gate-2 amendments): the BOOT path, not just sessionPolicy. A stored
// session is run through boot for each of no PIN / PIN / schedule / autojoin; only the first
// discards it. boot() reads the real persistence (localStorage is mocked), so a boot that never
// consults the policy, or consults it with the wrong inputs, goes red here.

function memStorage() {
	const m = new Map<string, string>();
	return {
		map: m,
		getItem: (k: string) => m.get(k) ?? null,
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k),
		clear: () => m.clear(),
	};
}

const local = memStorage();
let session = memStorage();

const NOW = Date.now();
const stored: PlaytimeSession = {
	limitMs: 30 * 60_000,
	breakMs: null,
	playedMs: 12 * 60_000,
	frozenAt: null,
	startedAt: NOW - 20 * 60_000,
	updatedAt: NOW - 1_000,
};
const ARGS: AutojoinArgs = { world: 'w-1', name: 'Noah', skin: 'jj', duration: 30 };
const URL_ = 'http://localhost:18081';

function armSchedule() {
	local.setItem(SCHEDULE_KEY, JSON.stringify({ worldId: 'w', seed: 1, name: 'W', limitMin: 30, startMin: 0 }));
}

beforeEach(() => {
	vi.stubGlobal('localStorage', local);
	local.clear();
	session = memStorage();
	saveSession(stored);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('bootSession (T12b, the function)', () => {
	const none: LoadedSchedule = { kind: 'none' };
	const armed: LoadedSchedule = { kind: 'armed', schedule: { worldId: 'w', seed: 1, name: 'W', limitMin: 30, startMin: 0 } };
	it.each([
		['no PIN', { pin: null, schedule: none, autojoin: false }, true],
		['PIN', { pin: '1234', schedule: none, autojoin: false }, false],
		['schedule', { pin: null, schedule: armed, autojoin: false }, false],
		['broken schedule (fails closed)', { pin: null, schedule: { kind: 'broken' } as LoadedSchedule, autojoin: false }, false],
		['autojoin', { pin: null, schedule: none, autojoin: true }, false],
	])('%s → discarded: %s', (_n, st, discarded) => {
		const clear = vi.fn();
		bootSession(st, () => stored, clear);
		expect(clear).toHaveBeenCalledTimes(discarded ? 1 : 0);
	});

	it('no stored session: nothing to clear', () => {
		const clear = vi.fn();
		bootSession({ pin: null, schedule: none, autojoin: false }, () => null, clear);
		expect(clear).not.toHaveBeenCalled();
	});
});

describe('boot() (T12b, boot-level)', () => {
	it('no PIN, no schedule, no autojoin: the stored session is discarded; menu', () => {
		expect(boot({ mpUrl: URL_, storage: session })).toEqual({ kind: 'menu' });
		expect(local.getItem(PLAYTIME_KEY)).toBeNull();
		expect(loadSession()).toBeNull();
	});

	it('PIN: the stored session is kept', () => {
		local.setItem(PIN_KEY, '1234');
		expect(boot({ mpUrl: URL_, storage: session })).toEqual({ kind: 'menu' });
		expect(loadSession()?.playedMs).toBe(stored.playedMs);
	});

	it('schedule: the stored session is kept', () => {
		armSchedule();
		boot({ mpUrl: URL_, storage: session });
		expect(loadSession()?.playedMs).toBe(stored.playedMs);
	});

	it('autojoin flag plus an MP URL: session kept, autojoin with the args', () => {
		setAutojoin(session, ARGS);
		expect(boot({ mpUrl: URL_, storage: session })).toEqual({ kind: 'autojoin', args: ARGS });
		expect(loadSession()?.playedMs).toBe(stored.playedMs);
		// The flag stays until the game decides (a reconnect reload needs it again).
		expect(session.getItem(AUTOJOIN_KEY)).not.toBeNull();
	});

	it('autojoin flag but no MP URL: menu, flag cleared, and the session is NOT exempted', () => {
		setAutojoin(session, ARGS);
		expect(boot({ mpUrl: null, storage: session })).toEqual({ kind: 'menu' });
		expect(session.getItem(AUTOJOIN_KEY)).toBeNull();
		expect(loadSession()).toBeNull();
	});

	it('a broken autojoin flag: menu, flag cleared, session discarded', () => {
		session.setItem(AUTOJOIN_KEY, '{nope');
		expect(boot({ mpUrl: URL_, storage: session })).toEqual({ kind: 'menu' });
		expect(session.getItem(AUTOJOIN_KEY)).toBeNull();
		expect(loadSession()).toBeNull();
	});

	it('starting a solo game clears the autojoin flag', () => {
		setAutojoin(session, ARGS);
		beginSolo(session);
		expect(session.getItem(AUTOJOIN_KEY)).toBeNull();
		// ...so the next reload is an ordinary boot: no exemption.
		expect(boot({ mpUrl: URL_, storage: session })).toEqual({ kind: 'menu' });
		expect(loadSession()).toBeNull();
	});

	it('a failed rejoin moves the args to the one-shot preselect and clears the flag', () => {
		setAutojoin(session, ARGS);
		failRejoin(session, ARGS);
		expect(session.getItem(AUTOJOIN_KEY)).toBeNull();
		expect(JSON.parse(session.getItem(MP_PRESELECT_KEY)!)).toEqual(ARGS);
	});
});
