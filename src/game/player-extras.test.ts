import { describe, it, expect } from 'vitest';
import { resolvePlayerExtras } from './player-extras';
import { DEFAULT_TOOLS, MAX_PICKAXE_TIER } from '../data/crafting.data';
import type { PlayerSave } from '../persistence/adapter';

const BASE: PlayerSave = { x: 0, y: 60, z: 0, yaw: 0, pitch: 0, hotbar: [1], selected: 0 };

/** A save as it arrives from JSON: the typed fields may hold anything. */
function junk(extra: Record<string, unknown>): PlayerSave {
	return { ...BASE, ...extra } as unknown as PlayerSave;
}

describe('resolvePlayerExtras', () => {
	it('gives defaults for a save from before crafting, as fresh objects', () => {
		// Catches: returning undefined fields (the first place/craft would throw), and
		// handing out DEFAULT_TOOLS itself (the first craft would mutate every world's default).
		for (const player of [undefined, BASE]) {
			const r = resolvePlayerExtras(player, undefined);
			expect(r).toEqual({ inventory: {}, tools: { owned: [0], equipped: 0 }, mustMine: false });
			expect(r.tools).not.toBe(DEFAULT_TOOLS);
			expect(r.tools.owned).not.toBe(DEFAULT_TOOLS.owned);
			r.tools.owned.push(3);
			expect(DEFAULT_TOOLS.owned).toEqual([0]);
		}
	});

	it('keeps zero counts and drops unknown names and bad values', () => {
		// Catches: a `count > 0` filter (a key used up to 0 would come back at a later
		// non-zero start value), a lookup with `in`/`[]` that lets 'constructor' through,
		// and accepting negative, fractional, NaN or string counts.
		const r = resolvePlayerExtras(
			junk({
				inventory: {
					stone: 5,
					dirt: 0,
					not_a_block: 3,
					constructor: 4,
					sand: -1,
					glass: 2.5,
					oak_log: Number.NaN,
					oak_planks: '3',
				},
			}),
			false,
		);
		expect(r.inventory).toEqual({ stone: 5, dirt: 0 });
	});

	it('treats a non-object inventory as empty', () => {
		// Catches: Object.entries on an array/string producing index keys, or a throw on null.
		for (const inventory of [null, [4, 5], 'stone', 7]) {
			expect(resolvePlayerExtras(junk({ inventory }), false).inventory).toEqual({});
		}
	});

	it('drops unknown tiers, de-duplicates, sorts, and always owns 0', () => {
		// Catches: a save without 0 leaving him with no pickaxe to fall back to, a tier
		// past MAX_PICKAXE_TIER surviving (it has no row to look up), and duplicates.
		const r = resolvePlayerExtras(
			junk({ tools: { owned: [3, 3, MAX_PICKAXE_TIER + 2, -1, 2.5, 'x', 1], equipped: 3 } }),
			false,
		);
		expect(r.tools).toEqual({ owned: [0, 1, 3], equipped: 3 });
	});

	it('moves an equipped tier that is not owned to the highest owned tier', () => {
		// Catches: resetting to 0 (he would lose the pickaxe he had in hand), and keeping
		// an unowned or unknown tier equipped.
		expect(resolvePlayerExtras(junk({ tools: { owned: [0, 2, 5], equipped: 4 } }), false).tools).toEqual({
			owned: [0, 2, 5],
			equipped: 5,
		});
		expect(resolvePlayerExtras(junk({ tools: { owned: [2], equipped: 99 } }), false).tools).toEqual({
			owned: [0, 2],
			equipped: 2,
		});
		expect(resolvePlayerExtras(junk({ tools: 'pickaxe' }), false).tools).toEqual({ owned: [0], equipped: 0 });
	});

	it('is must-mine only for a literal true', () => {
		// Catches: truthiness, which would turn an unlimited world must-mine on a junk value.
		expect(resolvePlayerExtras(BASE, true).mustMine).toBe(true);
		expect(resolvePlayerExtras(BASE, false).mustMine).toBe(false);
		expect(resolvePlayerExtras(BASE, undefined).mustMine).toBe(false);
		expect(resolvePlayerExtras(BASE, 'true' as unknown as boolean).mustMine).toBe(false);
		expect(resolvePlayerExtras(BASE, 1 as unknown as boolean).mustMine).toBe(false);
	});
});
