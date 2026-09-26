import { describe, expect, it } from 'vitest';
import { RECIPES } from 'minicraft-bot';
import { craftOnce, craftUpTo, rawShortfall, recipeFor, type Inventory } from '../../src/landscaper/craft.js';

describe('landscaper crafting (the Craft tab rules)', () => {
	it('a Flattening TNT from nothing needs 10 sand, 8 coal, 8 redstone, 16 stone', () => {
		const s = rawShortfall('flatten_tnt', 1, {});
		const by = Object.fromEntries(s.map((m) => [m.anyOf[0], m.count]));
		expect(by).toEqual({ sand: 10, coal_ore: 8, redstone_ore: 8, stone: 16 });
		expect(s.find((m) => m.anyOf[0] === 'coal_ore')!.anyOf).toEqual(['coal_ore', 'deepslate_coal_ore']);
	});

	it('crafting deducts exactly per recipe (plain before deepslate) and adds the output', () => {
		const inv: Inventory = { sand: 11, coal_ore: 3, deepslate_coal_ore: 6, deepslate_redstone_ore: 8, stone: 20, dirt: 4 };
		const done = craftUpTo('flatten_tnt', 1, inv);
		expect(done).toEqual(['tnt', 'big_tnt', 'tnt', 'big_tnt', 'flatten_tnt']);
		expect(inv).toEqual({ sand: 1, deepslate_coal_ore: 1, stone: 4, dirt: 4, flatten_tnt: 1 });
		expect(rawShortfall('flatten_tnt', 1, inv)).toEqual([]);
	});

	it('short of anything: null, and the inventory is untouched; the shortfall names it', () => {
		const inv: Inventory = { sand: 10, coal_ore: 8, redstone_ore: 7, stone: 16 };
		const before = { ...inv };
		expect(craftUpTo('flatten_tnt', 1, inv)).toBeNull();
		expect(inv).toEqual(before);
		expect(rawShortfall('flatten_tnt', 1, inv)).toEqual([{ anyOf: ['redstone_ore', 'deepslate_redstone_ore'], count: 1 }]);
	});

	it('intermediates in the inventory are used first', () => {
		const inv: Inventory = { big_tnt: 1, tnt: 2, redstone_ore: 4, stone: 16 };
		expect(rawShortfall('flatten_tnt', 1, inv)).toEqual([]);
		expect(craftUpTo('flatten_tnt', 1, inv)).toEqual(['big_tnt', 'flatten_tnt']);
		expect(inv).toEqual({ flatten_tnt: 1 });
	});

	it('craftOnce matches each RECIPES row: every need taken, output added', () => {
		for (const r of RECIPES) {
			if (r.output.kind !== 'block') continue;
			const inv: Inventory = {};
			for (const n of r.needs) inv[n.anyOf[0]] = n.count;
			expect(craftOnce(r, inv)).toBe(true);
			expect(inv).toEqual({ [r.output.name]: r.output.count });
			expect(recipeFor(r.output.name)).toBe(r);
		}
	});
});
