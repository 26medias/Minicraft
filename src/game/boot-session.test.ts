import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bootSession } from './boot-session';
import { AUTOJOIN_KEY, beginSolo, boot, failRejoin, setAutojoin, type AutojoinArgs } from './boot';
import { loadSession, saveSession, PLAYTIME_KEY } from '../persistence/playtime';
import { PIN_KEY, RULES_KEY, SCHEDULE_KEY } from '../persistence/rules';
import { MP_PRESELECT_KEY } from '../ui/menu';
import type { PlaytimeSession } from './playtime';
import type { LoadedRules } from './rules';

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
	const none: LoadedRules = { kind: 'none' };
	const armed: LoadedRules = { kind: 'set', rules: { startMin: 0, dailyMin: 30 } };
	it.each([
		['no PIN', { pin: null, rules: none, autojoin: false }, true],
		['PIN', { pin: '1234', rules: none, autojoin: false }, false],
		['rules', { pin: null, rules: armed, autojoin: false }, false],
		['broken rules (fails closed)', { pin: null, rules: { kind: 'broken' } as LoadedRules, autojoin: false }, false],
		['autojoin', { pin: null, rules: none, autojoin: true }, false],
	])('%s → discarded: %s', (_n, st, discarded) => {
		const clear = vi.fn();
		bootSession(st, () => stored, clear);
		expect(clear).toHaveBeenCalledTimes(discarded ? 1 : 0);
	});

	it('no stored session: nothing to clear', () => {
		const clear = vi.fn();
		bootSession({ pin: null, rules: none, autojoin: false }, () => null, clear);
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

	it('an old schedule (migrated to rules): the stored session is kept', () => {
		armSchedule();
		boot({ mpUrl: URL_, storage: session });
		expect(loadSession()?.playedMs).toBe(stored.playedMs);
	});

	it('rules with only a start time: the stored session is kept', () => {
		local.setItem(RULES_KEY, JSON.stringify({ startMin: 420, dailyMin: null }));
		boot({ mpUrl: URL_, storage: session });
		expect(loadSession()?.playedMs).toBe(stored.playedMs);
	});

	it('rules saved as "no rules": a reload discards the session (honour system)', () => {
		armSchedule(); // the old record must not come back once rules are saved
		local.setItem(RULES_KEY, JSON.stringify({ startMin: null, dailyMin: null }));
		boot({ mpUrl: URL_, storage: session });
		expect(loadSession()).toBeNull();
	});

	it('autojoin flag plus an MP URL: session kept, autojoin with the args', () => {
		setAutojoin(session, ARGS);
		expect(boot({ mpUrl: URL_, storage: session })).toEqual({ kind: 'autojoin', args: ARGS });
		expect(loadSession()?.playedMs).toBe(stored.playedMs);
		// One-shot: consumed by this boot. The game writes it again only right before its own rejoin reload.
		expect(session.getItem(AUTOJOIN_KEY)).toBeNull();
	});

	it('a plain F5 after that rejoin goes to the menu, like any refresh (Julien: "if I refresh I get back in the game")', () => {
		setAutojoin(session, ARGS);
		expect(boot({ mpUrl: URL_, storage: session }).kind).toBe('autojoin');
		// The kid presses F5 in the rejoined game: nothing re-armed the flag.
		expect(boot({ mpUrl: URL_, storage: session })).toEqual({ kind: 'menu' });
		expect(loadSession()).toBeNull(); // no PIN: an ordinary refresh discards the session
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
