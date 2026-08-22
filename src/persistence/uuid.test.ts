import { describe, it, expect, vi, afterEach } from 'vitest';
import { newWorldId, legacyId, isLegacyId, seedFromLegacyId } from './uuid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newWorldId', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('produces a v4 uuid', () => {
		expect(newWorldId()).toMatch(V4);
	});

	it('produces distinct ids', () => {
		const ids = new Set(Array.from({ length: 100 }, () => newWorldId()));
		expect(ids.size).toBe(100);
	});

	it('falls back when crypto.randomUUID is unavailable (insecure LAN dev origin)', () => {
		vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => a.fill(7) });
		expect(newWorldId()).toMatch(V4);
	});

	it('falls back when crypto is absent entirely', () => {
		vi.stubGlobal('crypto', undefined);
		expect(newWorldId()).toMatch(V4);
	});
});

describe('legacy ids', () => {
	it('round-trips a seed', () => {
		expect(seedFromLegacyId(legacyId(42))).toBe(42);
	});

	it('round-trips a negative seed', () => {
		expect(seedFromLegacyId(legacyId(-12345))).toBe(-12345);
	});

	it('distinguishes legacy ids from uuids', () => {
		expect(isLegacyId(legacyId(1))).toBe(true);
		expect(isLegacyId(newWorldId())).toBe(false);
	});
});
