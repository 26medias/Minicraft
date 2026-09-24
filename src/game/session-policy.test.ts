import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	clampDuration, defaultDuration, formatDuration, scheduleActive, sessionPolicy, stepDuration,
} from './session-policy';
import { DURATION_CHOICES_MIN } from '../data/playtime.data';
import { DEFAULT_KEYBINDINGS } from '../data/keybindings.data';

// T12 (spec §10): sessionPolicy truth table, break-field migration, playLimitMin → maximum.

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
	vi.unstubAllGlobals();
});

describe('sessionPolicy (T12 truth table)', () => {
	it.each([
		[false, false, false, 'discard'],
		[true, false, false, 'keep'],
		[false, true, false, 'keep'],
		[false, false, true, 'keep'],
		[true, true, false, 'keep'],
		[true, false, true, 'keep'],
		[false, true, true, 'keep'],
		[true, true, true, 'keep'],
	] as const)('pin=%s schedule=%s autojoin=%s → %s', (pin, sched, autojoin, want) => {
		expect(sessionPolicy(pin, sched, autojoin)).toBe(want);
	});
});

describe('scheduleActive', () => {
	it('armed and broken are active (a broken schedule fails closed); none is not', () => {
		expect(scheduleActive({ kind: 'none' })).toBe(false);
		expect(scheduleActive({ kind: 'broken' })).toBe(true);
		expect(scheduleActive({
			kind: 'armed',
			schedule: { worldId: 'w', seed: 1, name: 'n', limitMin: 45, startMin: 420 },
		})).toBe(true);
	});
});

describe('DURATION_CHOICES_MIN', () => {
	it('is 10..120 in 5-minute steps (23 values)', () => {
		expect(DURATION_CHOICES_MIN.length).toBe(23);
		expect(DURATION_CHOICES_MIN[0]).toBe(10);
		expect(DURATION_CHOICES_MIN.at(-1)).toBe(120);
		for (let i = 1; i < DURATION_CHOICES_MIN.length; i++) {
			expect(DURATION_CHOICES_MIN[i] - DURATION_CHOICES_MIN[i - 1]).toBe(5);
		}
	});
	it('is a superset of the old play-limit choices', () => {
		for (const m of [15, 20, 30, 45, 60, 90]) expect(DURATION_CHOICES_MIN).toContain(m);
	});
});

describe('defaultDuration', () => {
	it('is No limit under No limit, else 30 clamped to the maximum', () => {
		expect(defaultDuration(null)).toBeNull();
		expect(defaultDuration(45)).toBe(30);
		expect(defaultDuration(20)).toBe(20);
		expect(defaultDuration(120)).toBe(30);
	});
});

describe('clampDuration', () => {
	it('caps at the maximum', () => {
		expect(clampDuration(60, 45)).toBe(45);
		expect(clampDuration(30, 45)).toBe(30);
	});
	it('No limit chosen under a maximum becomes the maximum', () => {
		expect(clampDuration(null, 45)).toBe(45);
	});
	it('No limit stays No limit under No limit', () => {
		expect(clampDuration(null, null)).toBeNull();
	});
	it('enforces the 10-minute minimum, with or without a maximum', () => {
		expect(clampDuration(5, 45)).toBe(10);
		expect(clampDuration(5, null)).toBe(10);
		expect(clampDuration(0, null)).toBe(10);
		expect(clampDuration(60, null)).toBe(60);
	});
});

describe('stepDuration', () => {
	it('walks 10 → 15 → … → 120 → No limit when the maximum is No limit', () => {
		const seen: (number | null)[] = [];
		let cur: number | null = 10;
		for (let i = 0; i < 30 && cur !== null; i++) {
			seen.push(cur);
			cur = stepDuration(cur, 1, null);
		}
		seen.push(cur);
		expect(seen).toEqual([...DURATION_CHOICES_MIN, null]);
		// + past No limit stays No limit.
		expect(stepDuration(null, 1, null)).toBeNull();
	});
	it('from No limit, − goes to 120', () => {
		expect(stepDuration(null, -1, null)).toBe(120);
	});
	it('stops at the maximum', () => {
		let cur: number | null = 10;
		for (let i = 0; i < 30; i++) cur = stepDuration(cur, 1, 45);
		expect(cur).toBe(45);
		expect(stepDuration(40, 1, 45)).toBe(45);
		expect(stepDuration(45, 1, 45)).toBe(45);
	});
	it('stops at 10 going down', () => {
		expect(stepDuration(15, -1, null)).toBe(10);
		expect(stepDuration(10, -1, null)).toBe(10);
		expect(stepDuration(10, -1, 45)).toBe(10);
	});
	it('walks down from the top', () => {
		expect(stepDuration(120, -1, null)).toBe(115);
		expect(stepDuration(45, -1, 45)).toBe(40);
	});
});

describe('formatDuration', () => {
	it('shows minutes under an hour, hours and minutes from 60, and No limit for null', () => {
		expect(formatDuration(null)).toBe('No limit');
		expect(formatDuration(10)).toBe('10 min');
		expect(formatDuration(30)).toBe('30 min');
		expect(formatDuration(55)).toBe('55 min');
		expect(formatDuration(60)).toBe('1 h');
		expect(formatDuration(90)).toBe('1 h 30 min');
		expect(formatDuration(95)).toBe('1 h 35 min');
		expect(formatDuration(120)).toBe('2 h');
	});
});

describe('options migration (T12: playLimitMin → maximum)', () => {
	const KEY = 'minicraft:v1:options';
	it('{playLimitMin: 45} → maxDurationMin 45', async () => {
		store[KEY] = JSON.stringify({ keybindings: DEFAULT_KEYBINDINGS, playLimitMin: 45 });
		const { loadOptions } = await import('../persistence/options');
		expect(loadOptions().maxDurationMin).toBe(45);
	});
	it('{playLimitMin: null} → No limit', async () => {
		store[KEY] = JSON.stringify({ keybindings: DEFAULT_KEYBINDINGS, playLimitMin: null });
		const { loadOptions } = await import('../persistence/options');
		expect(loadOptions().maxDurationMin).toBeNull();
	});
	it('{playBreakMin: 20} is ignored', async () => {
		store[KEY] = JSON.stringify({ keybindings: DEFAULT_KEYBINDINGS, playBreakMin: 20 });
		const { loadOptions } = await import('../persistence/options');
		const opts = loadOptions();
		expect(opts.maxDurationMin).toBeNull();
		expect('playBreakMin' in opts).toBe(false);
		expect('playLimitMin' in opts).toBe(false);
	});
	it('{playLimitMin: 30, playBreakMin: 20} → maximum 30, no break', async () => {
		store[KEY] = JSON.stringify({ keybindings: DEFAULT_KEYBINDINGS, playLimitMin: 30, playBreakMin: 20 });
		const { loadOptions } = await import('../persistence/options');
		const opts = loadOptions();
		expect(opts.maxDurationMin).toBe(30);
		expect('playBreakMin' in opts).toBe(false);
	});
	it('maxDurationMin wins over a leftover playLimitMin', async () => {
		store[KEY] = JSON.stringify({ keybindings: DEFAULT_KEYBINDINGS, maxDurationMin: 25, playLimitMin: 90 });
		const { loadOptions } = await import('../persistence/options');
		expect(loadOptions().maxDurationMin).toBe(25);
	});
	it('a stored maxDurationMin: null stays No limit even with a leftover playLimitMin', async () => {
		store[KEY] = JSON.stringify({ keybindings: DEFAULT_KEYBINDINGS, maxDurationMin: null, playLimitMin: 90 });
		const { loadOptions } = await import('../persistence/options');
		expect(loadOptions().maxDurationMin).toBeNull();
	});
	it('rejects a maximum that is not on the list', async () => {
		store[KEY] = JSON.stringify({ keybindings: DEFAULT_KEYBINDINGS, maxDurationMin: 7 });
		const { loadOptions } = await import('../persistence/options');
		expect(loadOptions().maxDurationMin).toBeNull();
		store[KEY] = JSON.stringify({ keybindings: DEFAULT_KEYBINDINGS, maxDurationMin: '30' });
		expect(loadOptions().maxDurationMin).toBeNull();
	});
	it('a new maximum round-trips', async () => {
		const { loadOptions, saveOptions } = await import('../persistence/options');
		const opts = loadOptions();
		opts.maxDurationMin = 25;
		saveOptions(opts);
		expect(loadOptions().maxDurationMin).toBe(25);
	});
});

describe('session migration (T12: break field)', () => {
	it('a stored session with breakMs: 600000 loads with breakMs === null', async () => {
		store['minicraft:v1:playtime'] = JSON.stringify({
			limitMs: 1_800_000, breakMs: 600_000, playedMs: 5, frozenAt: null, startedAt: 1, updatedAt: 1,
		});
		const { loadSession } = await import('../persistence/playtime');
		expect(loadSession()).toEqual({
			limitMs: 1_800_000, breakMs: null, playedMs: 5, frozenAt: null, startedAt: 1, updatedAt: 1,
		});
	});
});

describe('schedule durations (T12)', () => {
	const base = { worldId: 'w1', seed: 42, name: 'N', startMin: 420 };
	it('limitMin: 25 (new) saves and loads', async () => {
		const { loadSchedule, saveSchedule } = await import('../persistence/schedule');
		expect(saveSchedule({ ...base, limitMin: 25 })).toBe(true);
		expect(loadSchedule()).toEqual({ kind: 'armed', schedule: { ...base, limitMin: 25 } });
	});
	it('limitMin: 15 (old) saves and loads', async () => {
		const { loadSchedule, saveSchedule } = await import('../persistence/schedule');
		expect(saveSchedule({ ...base, limitMin: 15 })).toBe(true);
		expect(loadSchedule()).toEqual({ kind: 'armed', schedule: { ...base, limitMin: 15 } });
	});
	it('limitMin: 120 loads; 125 and 7 are broken', async () => {
		const { loadSchedule } = await import('../persistence/schedule');
		store['minicraft:v1:schedule'] = JSON.stringify({ ...base, limitMin: 120 });
		expect(loadSchedule().kind).toBe('armed');
		store['minicraft:v1:schedule'] = JSON.stringify({ ...base, limitMin: 125 });
		expect(loadSchedule()).toEqual({ kind: 'broken' });
		store['minicraft:v1:schedule'] = JSON.stringify({ ...base, limitMin: 7 });
		expect(loadSchedule()).toEqual({ kind: 'broken' });
	});
});
