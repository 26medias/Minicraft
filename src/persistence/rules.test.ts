import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const store: Record<string, string> = {};
const localStorageMock = {
	getItem: (k: string) => store[k] ?? null,
	setItem: (k: string, v: string) => {
		store[k] = v;
	},
	removeItem: (k: string) => {
		delete store[k];
	},
	clear: () => {
		for (const k of Object.keys(store)) delete store[k];
	},
};

beforeEach(() => {
	vi.stubGlobal('localStorage', localStorageMock);
	localStorageMock.clear();
});

afterEach(() => {
	// The mock object is module-scoped, so a spy on it survives unstubAllGlobals.
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const good = { startMin: 420, dailyMin: 45 };
const OLD_SCHEDULE = { worldId: 'w1', seed: 42, name: 'N', limitMin: 45, startMin: 420 };

describe('rules storage', () => {
	it('absent, and nothing to migrate → none', async () => {
		const { loadRules } = await import('./rules');
		expect(loadRules()).toEqual({ kind: 'none' });
	});
	it('round trip → set, and save reports success', async () => {
		const { loadRules, saveRules } = await import('./rules');
		expect(saveRules(good)).toBe(true);
		expect(loadRules()).toEqual({ kind: 'set', rules: good });
		expect(saveRules({ startMin: null, dailyMin: 120 })).toBe(true);
		expect(loadRules()).toEqual({ kind: 'set', rules: { startMin: null, dailyMin: 120 } });
	});
	it('"no rules" saved → none, and the old records are not migrated again', async () => {
		const { loadRules, saveRules } = await import('./rules');
		localStorage.setItem('minicraft:v1:schedule', JSON.stringify(OLD_SCHEDULE));
		expect(saveRules({ startMin: null, dailyMin: null })).toBe(true);
		expect(loadRules()).toEqual({ kind: 'none' });
	});
	it.each([
		['bad json', 'nope'],
		['empty object', '{}'],
		['daily not a choice', JSON.stringify({ ...good, dailyMin: 7 })],
		['startMin 1440', JSON.stringify({ ...good, startMin: 1440 })],
		['startMin fractional', JSON.stringify({ ...good, startMin: 7.5 })],
		['daily a string', JSON.stringify({ ...good, dailyMin: '45' })],
	])('present but invalid → broken (%s)', async (_label, raw) => {
		const { loadRules } = await import('./rules');
		localStorage.setItem('minicraft:v1:rules', raw);
		expect(loadRules()).toEqual({ kind: 'broken' });
	});
	it('save returns false when storage throws, or the write does not stick', async () => {
		const { saveRules } = await import('./rules');
		const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
			throw new Error('quota');
		});
		expect(saveRules(good)).toBe(false);
		spy.mockImplementation(() => {});
		expect(saveRules(good)).toBe(false);
	});
	it('refuses to save invalid rules', async () => {
		const { saveRules, loadRules } = await import('./rules');
		expect(saveRules({ startMin: 420, dailyMin: 7 })).toBe(false);
		expect(loadRules()).toEqual({ kind: 'none' });
	});
});

describe('migration from the old records', () => {
	it('an old schedule becomes its start time and minutes per day (the world is dropped)', async () => {
		const { loadRules } = await import('./rules');
		localStorage.setItem('minicraft:v1:schedule', JSON.stringify(OLD_SCHEDULE));
		expect(loadRules()).toEqual({ kind: 'set', rules: { startMin: 420, dailyMin: 45 } });
	});
	it('an unreadable old schedule stays broken (fails closed)', async () => {
		const { loadRules } = await import('./rules');
		localStorage.setItem('minicraft:v1:schedule', JSON.stringify({ ...OLD_SCHEDULE, limitMin: 7 }));
		expect(loadRules()).toEqual({ kind: 'broken' });
		localStorage.setItem('minicraft:v1:schedule', 'nope');
		expect(loadRules()).toEqual({ kind: 'broken' });
	});
	it('an old maximum becomes minutes per day', async () => {
		const { loadRules } = await import('./rules');
		localStorage.setItem('minicraft:v1:options', JSON.stringify({ maxDurationMin: 60 }));
		expect(loadRules()).toEqual({ kind: 'set', rules: { startMin: null, dailyMin: 60 } });
	});
	it('an old "No limit" maximum → none', async () => {
		const { loadRules } = await import('./rules');
		localStorage.setItem('minicraft:v1:options', JSON.stringify({ maxDurationMin: null }));
		expect(loadRules()).toEqual({ kind: 'none' });
	});
	it('saved rules win over the old records', async () => {
		const { loadRules, saveRules } = await import('./rules');
		localStorage.setItem('minicraft:v1:schedule', JSON.stringify(OLD_SCHEDULE));
		saveRules({ startMin: 480, dailyMin: null });
		expect(loadRules()).toEqual({ kind: 'set', rules: { startMin: 480, dailyMin: null } });
	});
});

describe('today storage', () => {
	const now = new Date(2026, 8, 7, 9, 0).getTime();
	it('round trip for today', async () => {
		const { loadToday, saveToday } = await import('./rules');
		const { dayKey } = await import('../game/rules');
		const t = { day: dayKey(now), extraMin: 15, unlimited: false };
		expect(saveToday(t)).toBe(true);
		expect(loadToday(now)).toEqual(t);
	});
	it("yesterday's record reads as nothing", async () => {
		const { loadToday, saveToday } = await import('./rules');
		const { dayKey } = await import('../game/rules');
		saveToday({ day: dayKey(now - 24 * 3_600_000), extraMin: 15, unlimited: true });
		expect(loadToday(now)).toBeNull();
	});
	it.each([
		['bad json', 'nope'],
		['negative extra', { extraMin: -15, unlimited: false }],
		['string extra', { extraMin: '15', unlimited: false }],
		['missing unlimited', { extraMin: 15 }],
	])('an unreadable record gives no extras (%s)', async (_l, v) => {
		const { loadToday } = await import('./rules');
		const { dayKey } = await import('../game/rules');
		localStorage.setItem('minicraft:v1:today', typeof v === 'string' ? v : JSON.stringify({ day: dayKey(now), ...v }));
		expect(loadToday(now)).toBeNull();
	});
	it('clearToday', async () => {
		const { loadToday, saveToday, clearToday } = await import('./rules');
		const { dayKey } = await import('../game/rules');
		saveToday({ day: dayKey(now), extraMin: 15, unlimited: false });
		expect(clearToday()).toBe(true);
		expect(loadToday(now)).toBeNull();
	});
});

describe('pin storage', () => {
	it('round-trips four digits', async () => {
		const { loadPin, savePin } = await import('./rules');
		expect(savePin('1234')).toBe(true);
		expect(loadPin()).toBe('1234');
	});
	it.each(['12', '12345', 'abcd', ' 1234', '1234\n'])('rejects %j on load', async (bad) => {
		const { loadPin } = await import('./rules');
		localStorage.setItem('minicraft:v1:pin', bad);
		expect(loadPin()).toBeNull();
	});
	it('refuses to save a bad pin', async () => {
		const { savePin, loadPin } = await import('./rules');
		expect(savePin('12')).toBe(false);
		expect(loadPin()).toBeNull();
	});
	it('clearPin', async () => {
		const { savePin, clearPin, loadPin } = await import('./rules');
		savePin('1234');
		expect(clearPin()).toBe(true);
		expect(loadPin()).toBeNull();
	});
});
