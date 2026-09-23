import { describe, it, expect, vi } from 'vitest';

// Big TNT gets its real id (1000) in Phase D (blocks.extra.data.ts). Until then this file adds a
// stand-in row at 1000 named big_tnt, so the id-level rule is tested now. Phase D deletes the mock.
vi.mock('../data/blocks.data', async (importOriginal) => {
	const orig = await importOriginal<typeof import('../data/blocks.data')>();
	const BLOCKS = [...orig.BLOCKS];
	BLOCKS[1000] = { ...orig.BLOCK_BY_NAME['tnt'], id: 1000, name: 'big_tnt', label: 'Big TNT' };
	return { ...orig, BLOCKS };
});

import { canPlace, onPlaced } from './inventory';

describe('crafted-only blocks (spec §3)', () => {
	it('are refused at 0 in an unlimited world and spend a count there (catches crafted-only treated like plain TNT)', () => {
		expect(canPlace({}, 1000, false)).toBe(false);
		expect(canPlace({ big_tnt: 0 }, 1000, false)).toBe(false);
		expect(canPlace({ big_tnt: 1 }, 1000, false)).toBe(true);
		expect(onPlaced({ big_tnt: 2 }, 1000, false)).toEqual({ big_tnt: 1 });
	});
});
