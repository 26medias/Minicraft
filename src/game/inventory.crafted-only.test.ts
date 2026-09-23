import { describe, it, expect } from 'vitest';
import { BLOCK_BY_NAME } from '../data/blocks.data';
import { canPlace, onPlaced } from './inventory';

const big = BLOCK_BY_NAME['big_tnt'].id;
const mega = BLOCK_BY_NAME['mega_tnt'].id;

describe('crafted-only blocks (spec §3)', () => {
	it('are refused at 0 in an unlimited world and spend a count there (catches crafted-only treated like plain TNT)', () => {
		expect([big, mega]).toEqual([1000, 1001]); // the real rows, no stand-in
		for (const [id, name] of [[big, 'big_tnt'], [mega, 'mega_tnt']] as const) {
			expect(canPlace({}, id, false)).toBe(false);
			expect(canPlace({ [name]: 0 }, id, false)).toBe(false);
			expect(canPlace({ [name]: 1 }, id, false)).toBe(true);
			expect(onPlaced({ [name]: 2 }, id, false)).toEqual({ [name]: 1 });
		}
	});
});
