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
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const at = (h: number, m = 0, day = 7) => new Date(2026, 8, day, h, m).getTime();
const good = { id: 'p1', mode: 'solo' as const, worldId: 'w1', worldName: 'Big Crafting', startAt: at(7), limitMin: 45, extraMin: 0, createdAt: at(21, 0, 6) };
const OLD_SCHEDULE = { worldId: 'w1', seed: 42, name: 'N', limitMin: 45, startMin: 420 };

describe('plan storage', () => {
	it('absent → none', async () => {
		const { loadPlan } = await import('./plan');
		expect(loadPlan(at(9))).toEqual({ kind: 'none' });
	});
	it('round trip; "let him choose" (null world) too', async () => {
		const { loadPlan, savePlan } = await import('./plan');
		expect(savePlan(good)).toBe(true);
		expect(loadPlan(at(9))).toEqual({ kind: 'set', plan: good });
		const any = { ...good, mode: 'mp' as const, worldId: null, worldName: null };
		expect(savePlan(any)).toBe(true);
		expect(loadPlan(at(9))).toEqual({ kind: 'set', plan: any });
	});
	it.each([
		['bad json', 'nope'],
		['empty object', '{}'],
		['no id', JSON.stringify({ ...good, id: '' })],
		['bad mode', JSON.stringify({ ...good, mode: 'both' })],
		['limit not a choice', JSON.stringify({ ...good, limitMin: 7 })],
		['no limit', JSON.stringify({ ...good, limitMin: null })],
		['negative extra', JSON.stringify({ ...good, extraMin: -15 })],
		['start not a time', JSON.stringify({ ...good, startAt: 'soon' })],
	])('present but invalid → broken (%s)', async (_l, raw) => {
		const { loadPlan } = await import('./plan');
		localStorage.setItem('minicraft:v1:plan', raw);
		expect(loadPlan(at(9))).toEqual({ kind: 'broken' });
	});
	it('save refuses an invalid plan and reports a write that does not stick', async () => {
		const { savePlan } = await import('./plan');
		expect(savePlan({ ...good, limitMin: 7 })).toBe(false);
		vi.spyOn(localStorage, 'setItem').mockImplementation(() => {});
		expect(savePlan(good)).toBe(false);
	});
	it('End (clearPlan) removes the plan and any old schedule', async () => {
		const { clearPlan, loadPlan, savePlan } = await import('./plan');
		savePlan(good);
		localStorage.setItem('minicraft:v1:schedule', JSON.stringify(OLD_SCHEDULE));
		expect(clearPlan()).toBe(true);
		expect(loadPlan(at(9))).toEqual({ kind: 'none' });
	});
	it('newPlanId gives a fresh id each time', async () => {
		const { newPlanId } = await import('./plan');
		expect(newPlanId()).not.toBe(newPlanId());
	});
});

describe('migration of the old daily schedule', () => {
	it('becomes a solo plan on its world at the next start, for its minutes; the old record goes', async () => {
		const { loadPlan } = await import('./plan');
		localStorage.setItem('minicraft:v1:schedule', JSON.stringify(OLD_SCHEDULE));
		const got = loadPlan(at(5));
		expect(got.kind).toBe('set');
		if (got.kind !== 'set') return;
		expect(got.plan).toMatchObject({ mode: 'solo', worldId: 'w1', worldName: 'N', startAt: at(7), limitMin: 45, extraMin: 0, createdAt: at(5) });
		expect(localStorage.getItem('minicraft:v1:schedule')).toBeNull();
		// Migrated once: a later load reads the plan, not the old record again.
		expect(loadPlan(at(6))).toEqual(got);
	});
	it('after today\'s start time it moves to tomorrow', async () => {
		const { loadPlan } = await import('./plan');
		localStorage.setItem('minicraft:v1:schedule', JSON.stringify(OLD_SCHEDULE));
		const got = loadPlan(at(9));
		expect(got.kind === 'set' && got.plan.startAt).toBe(at(7, 0, 8));
	});
	it('an unreadable old schedule is broken (fails closed)', async () => {
		const { loadPlan } = await import('./plan');
		localStorage.setItem('minicraft:v1:schedule', JSON.stringify({ ...OLD_SCHEDULE, limitMin: 7 }));
		expect(loadPlan(at(9))).toEqual({ kind: 'broken' });
		localStorage.setItem('minicraft:v1:schedule', 'nope');
		expect(loadPlan(at(9))).toEqual({ kind: 'broken' });
	});
});

describe('pin storage', () => {
	it('round-trips four digits; rejects others; clears', async () => {
		const { loadPin, savePin, clearPin } = await import('./plan');
		expect(savePin('1234')).toBe(true);
		expect(loadPin()).toBe('1234');
		expect(savePin('12')).toBe(false);
		localStorage.setItem('minicraft:v1:pin', 'abcd');
		expect(loadPin()).toBeNull();
		savePin('1234');
		expect(clearPin()).toBe(true);
		expect(loadPin()).toBeNull();
	});
});
