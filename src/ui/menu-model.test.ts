import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { newWorldFields, singleModel } from './menu-model';
import { loadMenuState, saveMenuState, MENU_KEY } from '../persistence/menu-state';
import type { WorldSummary } from '../persistence/adapter';

const w1: WorldSummary = { id: 'w1', seed: 42, name: "Noah's World", createdAt: 0, updatedAt: 0, origin: 'local', version: 2 };

describe('newWorldFields (spec §3 New World checkbox)', () => {
	it('carries the checkbox into mustMine; unchecked is false', () => {
		// Catches the checkbox being drawn but never read (every new world unlimited).
		expect(newWorldFields({ nameRaw: 'Cave', seedRaw: '42', mustMine: true })).toEqual({ name: 'Cave', seed: 42, mustMine: true });
		expect(newWorldFields({ nameRaw: 'Cave', seedRaw: '42', mustMine: false }).mustMine).toBe(false);
	});
	it("keeps today's defaults for a blank name and a junk seed", () => {
		// Catches the refactor changing what Create did before (blank name → "My World", NaN seed → 0).
		expect(newWorldFields({ nameRaw: '   ', seedRaw: 'abc', mustMine: false })).toEqual({ name: 'My World', seed: 0, mustMine: false });
	});
});

// T13, single-player part (spec §8, §8.1).
describe('loadMenuState / saveMenuState (minicraft:v1:menu)', () => {
	const store: Record<string, string> = {};
	beforeEach(() => {
		for (const k of Object.keys(store)) delete store[k];
		vi.stubGlobal('localStorage', {
			getItem: (k: string) => store[k] ?? null,
			setItem: (k: string, v: string) => { store[k] = v; },
			removeItem: (k: string) => { delete store[k]; },
		});
	});
	afterEach(() => { vi.unstubAllGlobals(); });

	it('restores the selected id and the duration', () => {
		saveMenuState({ selectedId: 'w1', duration: 45 });
		expect(JSON.parse(store[MENU_KEY])).toEqual({ selectedId: 'w1', duration: 45 });
		expect(loadMenuState(null)).toEqual({ selectedId: 'w1', duration: 45 });
		expect(loadMenuState(60)).toEqual({ selectedId: 'w1', duration: 45 });
	});
	it('a stored "No limit" is restored under No limit', () => {
		saveMenuState({ selectedId: 'w1', duration: null });
		expect(loadMenuState(null)).toEqual({ selectedId: 'w1', duration: null });
	});
	it('a stored duration above the maximum is clamped to it', () => {
		saveMenuState({ selectedId: 'w1', duration: 90 });
		expect(loadMenuState(45).duration).toBe(45);
		// No limit stored, a maximum set since: the maximum.
		saveMenuState({ selectedId: 'w1', duration: null });
		expect(loadMenuState(45).duration).toBe(45);
	});
	it('no stored duration: No limit under No limit (never 30), 30 under a 45 maximum, the maximum under a 20 one', () => {
		expect(loadMenuState(null)).toEqual({ selectedId: null, duration: null });
		expect(loadMenuState(45)).toEqual({ selectedId: null, duration: 30 });
		expect(loadMenuState(20).duration).toBe(20);
	});
	it('junk is ignored: unparseable JSON, an off-list duration, a non-string id', () => {
		store[MENU_KEY] = '{nope';
		expect(loadMenuState(null)).toEqual({ selectedId: null, duration: null });
		store[MENU_KEY] = JSON.stringify({ selectedId: 7, duration: 33 });
		expect(loadMenuState(45)).toEqual({ selectedId: null, duration: 30 });
		store[MENU_KEY] = JSON.stringify({ selectedId: 'w1', duration: '30' });
		expect(loadMenuState(null)).toEqual({ selectedId: 'w1', duration: null });
	});
	it('storage that throws reads as defaults and a save does not throw', () => {
		vi.stubGlobal('localStorage', {
			getItem: () => { throw new Error('denied'); },
			setItem: () => { throw new Error('denied'); },
			removeItem: () => { throw new Error('denied'); },
		});
		expect(loadMenuState(45)).toEqual({ selectedId: null, duration: 30 });
		expect(() => saveMenuState({ selectedId: 'w1', duration: 30 })).not.toThrow();
	});
});

describe('singleModel', () => {
	const w2: WorldSummary = { id: 'w2', seed: 7, name: 'Cloud World', createdAt: 0, updatedAt: 50, origin: 'cloud', version: 2 };
	const w3: WorldSummary = { id: 'w3', seed: 8, name: 'Old', createdAt: 0, updatedAt: 10, origin: 'local', version: 2 };
	const created = { id: 'new-1', seed: 99, name: 'Fresh', mustMine: true };

	it('puts the newly created world first and selects it, over the remembered one', () => {
		const m = singleModel({ worlds: [w1, w2, w3], created, state: { selectedId: 'w3', duration: 30 }, max: 45 });
		expect(m.worlds[0]).toMatchObject({ id: 'new-1', name: 'Fresh', seed: 99, badge: 'new' });
		expect(m.worlds.map((r) => r.id)).toEqual(['new-1', 'w2', 'w3', 'w1']);
		expect(m.selectedId).toBe('new-1');
	});
	it('merges cloud and device worlds into one list, newest first, each with its badge', () => {
		const m = singleModel({ worlds: [w1, w2, w3], created: null, state: { selectedId: null, duration: null }, max: null });
		expect(m.worlds.map((r) => [r.id, r.badge])).toEqual([['w2', 'cloud'], ['w3', 'device'], ['w1', 'device']]);
	});
	it('selects the remembered world when it is listed, else the first row, else nothing', () => {
		expect(singleModel({ worlds: [w1, w2, w3], created: null, state: { selectedId: 'w3', duration: null }, max: null }).selectedId).toBe('w3');
		expect(singleModel({ worlds: [w1, w2, w3], created: null, state: { selectedId: 'gone', duration: null }, max: null }).selectedId).toBe('w2');
		expect(singleModel({ worlds: [], created: null, state: { selectedId: 'w1', duration: null }, max: null }).selectedId).toBeNull();
	});
	it('carries the duration and the maximum, clamping the duration to the maximum', () => {
		const m = singleModel({ worlds: [w1], created: null, state: { selectedId: 'w1', duration: 30 }, max: 45 });
		expect(m.duration).toBe(30);
		expect(m.max).toBe(45);
		expect(singleModel({ worlds: [w1], created: null, state: { selectedId: 'w1', duration: 90 }, max: 45 }).duration).toBe(45);
		expect(singleModel({ worlds: [w1], created: null, state: { selectedId: 'w1', duration: null }, max: null }).duration).toBeNull();
	});
	it('a degraded world stays listed with its recovery badge', () => {
		const bad: WorldSummary = { ...w3, id: 'w4', degraded: true };
		const m = singleModel({ worlds: [bad], created: null, state: { selectedId: null, duration: null }, max: null });
		expect(m.worlds[0]).toMatchObject({ id: 'w4', degraded: true });
	});
});
