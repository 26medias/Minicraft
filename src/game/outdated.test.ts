// Protocol/bots plan, task 3 (spec §5, gate-2 §12a): outdated-client auto-reload decision.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { outdatedAction, decideOutdated, withVersionMarker, AUTO_RELOAD_KEY, AUTO_RELOAD_WINDOW_MS } from './outdated';

function memStorage(init: Record<string, string> = {}) {
	const m = new Map(Object.entries(init));
	return {
		m,
		getItem: (k: string): string | null => m.get(k) ?? null,
		setItem: (k: string, v: string): void => void m.set(k, v),
		removeItem: (k: string): void => void m.delete(k),
	};
}

describe('outdatedAction (spec §5 table)', () => {
	const NOW = 1_000_000;
	it.each([
		[NOW, null, true, 'auto'],
		[NOW, 'abc', true, 'auto'],
		[NOW, String(NOW - AUTO_RELOAD_WINDOW_MS), true, 'auto'],
		[NOW, String(NOW - AUTO_RELOAD_WINDOW_MS + 1), true, 'click'],
		[NOW, String(NOW + 5_000), true, 'click'],
		[NOW, null, false, 'click'],
	] as const)('now=%s marker=%s canWrite=%s → %s', (now, marker, canWrite, expected) => {
		expect(outdatedAction(now, marker, canWrite)).toBe(expected);
	});
});

describe('decideOutdated (the browser wrapper)', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('no marker: auto, and writes the marker = now', () => {
		const s = memStorage();
		expect(decideOutdated(s, 1_000_000)).toBe('auto');
		expect(s.m.get(AUTO_RELOAD_KEY)).toBe('1000000');
	});

	it('a throwing write: click', () => {
		const s = memStorage();
		s.setItem = () => { throw new Error('quota'); };
		expect(decideOutdated(s, 1_000_000)).toBe('click');
	});

	it('a throwing read: click', () => {
		const s = memStorage();
		s.getItem = () => { throw new Error('denied'); };
		expect(decideOutdated(s, 1_000_000)).toBe('click');
	});

	it('two calls in a row: auto, then click (the marker sticks)', () => {
		const s = memStorage();
		expect(decideOutdated(s, 1_000_000)).toBe('auto');
		expect(decideOutdated(s, 1_000_100)).toBe('click');
	});

	it('a write that does not read back (mismatched value): click', () => {
		const s = memStorage();
		s.setItem = () => {}; // silently drops the write
		expect(decideOutdated(s, 1_000_000)).toBe('click');
	});

	it('backstop: a fresh v= already in the URL forces click even with no marker', () => {
		vi.stubGlobal('location', { search: '?v=999900' } as unknown as Location);
		const s = memStorage();
		expect(decideOutdated(s, 1_000_000)).toBe('click');
	});

	it('backstop: a v= older than the window does not force click', () => {
		vi.stubGlobal('location', { search: `?v=${1_000_000 - AUTO_RELOAD_WINDOW_MS}` } as unknown as Location);
		const s = memStorage();
		expect(decideOutdated(s, 1_000_000)).toBe('auto');
	});
});

describe('withVersionMarker', () => {
	it('adds v when absent', () => {
		expect(withVersionMarker('https://noah.leap-forward.ca/minicraft/', 42)).toBe('https://noah.leap-forward.ca/minicraft/?v=42');
	});

	it('replaces an existing v, keeping other params', () => {
		const url = withVersionMarker('https://x.example/y?v=1&other=2', 42);
		expect(url).toContain('v=42');
		expect(url).toContain('other=2');
		expect(url).not.toContain('v=1&');
	});
});
