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

const good = { worldId: 'w1', seed: 42, name: 'N', limitMin: 45, startMin: 420 };

describe('schedule storage', () => {
	it('absent → none', async () => {
		const { loadSchedule } = await import('./schedule');
		expect(loadSchedule()).toEqual({ kind: 'none' });
	});
	it('round trip → armed, and save reports success', async () => {
		const { loadSchedule, saveSchedule } = await import('./schedule');
		expect(saveSchedule(good)).toBe(true);
		expect(loadSchedule()).toEqual({ kind: 'armed', schedule: good });
	});
	it.each([
		['bad json', 'nope'],
		['empty object', '{}'],
		['limit not a choice', JSON.stringify({ ...good, limitMin: 7 })],
		['startMin 1440', JSON.stringify({ ...good, startMin: 1440 })],
		['startMin fractional', JSON.stringify({ ...good, startMin: 7.5 })],
		['seed NaN', JSON.stringify({ ...good, seed: 'x' })],
		['name missing', JSON.stringify({ ...good, name: undefined })],
	])('present but invalid → broken (%s)', async (_label, raw) => {
		const { loadSchedule } = await import('./schedule');
		localStorage.setItem('minicraft:v1:schedule', raw);
		expect(loadSchedule()).toEqual({ kind: 'broken' });
	});
	it('save returns false when storage throws', async () => {
		const { saveSchedule } = await import('./schedule');
		vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
			throw new Error('quota');
		});
		expect(saveSchedule(good)).toBe(false);
	});
	it('save returns false when the write does not stick', async () => {
		const { saveSchedule } = await import('./schedule');
		vi.spyOn(localStorage, 'setItem').mockImplementation(() => {});
		expect(saveSchedule(good)).toBe(false);
	});
	it('clear reports whether the key is gone', async () => {
		const { saveSchedule, clearSchedule, loadSchedule } = await import('./schedule');
		saveSchedule(good);
		expect(clearSchedule()).toBe(true);
		expect(loadSchedule()).toEqual({ kind: 'none' });
	});
});

describe('pin storage', () => {
	it('round-trips four digits', async () => {
		const { loadPin, savePin } = await import('./schedule');
		expect(savePin('1234')).toBe(true);
		expect(loadPin()).toBe('1234');
	});
	it.each(['12', '12345', 'abcd', ' 1234', '1234\n'])('rejects %j on load', async (bad) => {
		const { loadPin } = await import('./schedule');
		localStorage.setItem('minicraft:v1:pin', bad);
		expect(loadPin()).toBeNull();
	});
	it('refuses to save a bad pin', async () => {
		const { savePin, loadPin } = await import('./schedule');
		expect(savePin('12')).toBe(false);
		expect(loadPin()).toBeNull();
	});
	it('clearPin', async () => {
		const { savePin, clearPin, loadPin } = await import('./schedule');
		savePin('1234');
		expect(clearPin()).toBe(true);
		expect(loadPin()).toBeNull();
	});
});
