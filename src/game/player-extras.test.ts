import { describe, it, expect } from 'vitest';
import { playerSave, resolvePlayerExtras } from './player-extras';
import { Player } from './player';
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
describe('Player crafting fields and playerSave', () => {
	it('gives every Player its own default inventory and tools', () => {
		// Catches: a shared default object (a craft in one session would leak into the
		// next world), and a Player without the fields (the snapshot would throw).
		const a = new Player([10.5, 60, 10.5]);
		const b = new Player([10.5, 60, 10.5]);
		expect(a.inventory).toEqual({});
		expect(a.tools).toEqual({ owned: [0], equipped: 0 });
		a.tools.owned.push(2);
		a.inventory.stone = 1;
		expect(b.tools).toEqual({ owned: [0], equipped: 0 });
		expect(b.inventory).toEqual({});
	});

	it('always writes inventory and tools, defaults included', () => {
		// Catches: main.ts's old fixed player field list, which silently drops the new
		// fields from every save (spec §10: the new client always writes all three).
		const p = new Player([10.5, 60, 10.5]);
		p.hotbar = [1, 2, 3];
		p.selected = 2;
		const s = playerSave(p, 0.5, -0.25);
		expect(s).toEqual({
			x: p.position[0],
			y: p.position[1],
			z: p.position[2],
			yaw: 0.5,
			pitch: -0.25,
			hotbar: [1, 2, 3],
			selected: 2,
			inventory: {},
			tools: { owned: [0], equipped: 0 },
		});
	});

	it('copies the live counts and tools', () => {
		// Catches: aliasing the live objects, so mining after the snapshot is taken
		// would change a save that is still being written.
		const p = new Player([10.5, 60, 10.5]);
		p.inventory = { stone: 3 };
		p.tools = { owned: [0, 1], equipped: 1 };
		const s = playerSave(p, 0, 0);
		p.inventory.stone = 9;
		p.tools.owned.push(2);
		p.tools.equipped = 2;
		expect(s.inventory).toEqual({ stone: 3 });
		expect(s.tools).toEqual({ owned: [0, 1], equipped: 1 });
	});
});
