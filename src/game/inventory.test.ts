import { describe, it, expect } from 'vitest';
import { AIR, BLOCK_BY_NAME } from '../data/blocks.data';
import { RECIPES } from '../data/recipes.data';
import { WORLDGEN_BLOCKS } from '../data/crafting.data';
import { countOf, isCounted, needsCount, needsCountName, canPlace, onRemoved, onPlaced, onReplaced, autoHotbar } from './inventory';
import { resolvePlayerExtras } from './player-extras';
import type { PlayerSave } from '../persistence/adapter';

const id = (name: string) => BLOCK_BY_NAME[name].id;
const stone = id('stone'), dirt = id('dirt'), sand = id('sand'), tnt = id('tnt'), coal = id('coal_ore'), iron = id('iron_ore');
const cobble = id('cobblestone'), planks = id('oak_planks'), glass = id('glass'), lamp = id('lamp'), water = id('water');

describe('counted set (spec §3)', () => {
	it('tnt is counted; cobblestone is not (catches a set built from v3 NAMES, which lists cobblestone, or one that forgets recipe outputs)', () => {
		expect(isCounted('tnt')).toBe(true);
		expect(isCounted('cobblestone')).toBe(false);
		expect(isCounted('mossy_cobblestone')).toBe(false);
		expect(isCounted('red_sandstone')).toBe(false);
		for (const n of WORLDGEN_BLOCKS) expect(isCounted(n), n).toBe(true);
	});

	it('every recipe anyOf name needs a count in a must-mine world (catches a set built from worldgen alone, which leaves deepslate_emerald_ore free to farm)', () => {
		const names = RECIPES.flatMap((r) => r.needs.flatMap((n) => n.anyOf));
		expect(names).toContain('deepslate_emerald_ore');
		for (const n of names) expect(needsCountName(n, true), n).toBe(true);
		// ingredient names that are blocks today resolve through the id form too
		for (const n of names) if (BLOCK_BY_NAME[n]) expect(needsCount(BLOCK_BY_NAME[n].id, true), n).toBe(true);
	});
});

describe('needsCount / canPlace (spec §3)', () => {
	it('must-mine refuses a counted block at 0 and allows it at 1 (catches a canPlace that ignores the world mode)', () => {
		expect(canPlace({}, stone, true)).toBe(false);
		expect(canPlace({ stone: 0 }, stone, true)).toBe(false);
		expect(canPlace({ stone: 1 }, stone, true)).toBe(true);
		expect(canPlace({}, stone, false)).toBe(true);
	});

	it('non-counted blocks are always placeable, at 0, in both modes (catches a must-mine rule applied to every block)', () => {
		for (const b of [cobble, planks, glass, lamp, water]) {
			expect(canPlace({}, b, true)).toBe(true);
			expect(canPlace({}, b, false)).toBe(true);
			expect(needsCount(b, true)).toBe(false);
		}
	});

	it('plain tnt needs a count only in must-mine worlds (catches plain TNT treated as crafted-only)', () => {
		expect(needsCount(tnt, false)).toBe(false);
		expect(needsCount(tnt, true)).toBe(true);
		expect(needsCountName('big_tnt', false)).toBe(true);
		expect(needsCountName('mega_tnt', false)).toBe(true);
	});
});

describe('onRemoved / onPlaced / onReplaced (spec §2)', () => {
	it('+1 per block removed, −1 per counted place, floor 0 (catches a −1 that goes negative)', () => {
		const a = onRemoved({}, [stone, stone, dirt]).inv;
		expect(a).toEqual({ stone: 2, dirt: 1 });
		const b = onPlaced(onPlaced(onPlaced(a, stone, true), stone, true), stone, true);
		expect(b.stone).toBe(0);
		expect(onPlaced({ stone: 0 }, stone, true).stone).toBe(0);
	});

	it('a free place leaves the count unchanged: tnt 3, placed in an unlimited world, is still 3 (catches an unconditional −1, which a fixture at 0 would hide behind the floor)', () => {
		expect(onPlaced({ tnt: 3 }, tnt, false)).toEqual({ tnt: 3 });
		expect(onPlaced({}, stone, false)).toEqual({}); // and writes no key
	});

	it('replace: −1 of the placed block under the rule, +1 of the replaced block always (catches a replace that only does one side)', () => {
		expect(onReplaced({ stone: 2 }, stone, dirt, true)).toEqual({ stone: 1, dirt: 1 });
		expect(onReplaced({ tnt: 3 }, tnt, dirt, false)).toEqual({ tnt: 3, dirt: 1 });
		expect(onReplaced({}, cobble, stone, true)).toEqual({ stone: 1 });
	});

	it('startingCount injected as 5 is used for untouched keys everywhere (catches a hard-coded 0)', () => {
		expect(countOf({}, 'stone', 5)).toBe(5);
		expect(onRemoved({}, [stone], 5).inv.stone).toBe(6);
		expect(onRemoved({}, [stone], 5).rose).toEqual([]);
		expect(canPlace({}, stone, true, 5)).toBe(true);
		expect(onPlaced({}, stone, true, 5).stone).toBe(4);
		expect(countOf({ stone: 0 }, 'stone', 5)).toBe(0);
	});

	it('a key touched down to 0 stays 0 after save/load (catches dropping zero keys, which a later non-zero start would resurrect)', () => {
		const inv = onPlaced({ stone: 1 }, stone, true);
		expect(inv).toEqual({ stone: 0 });
		const player: PlayerSave = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hotbar: [], selected: 0, inventory: inv, tools: { owned: [0], equipped: 0 } };
		const back = resolvePlayerExtras(JSON.parse(JSON.stringify(player)) as PlayerSave, true).inventory;
		expect(back).toEqual({ stone: 0 });
		expect(countOf(back, 'stone', 5)).toBe(0);
	});

	it('rose lists each id whose count went 0 → >0, once, including a 0 → 5 in one call (catches a trigger on === 1)', () => {
		expect(onRemoved({}, [coal, coal, coal, coal, coal]).rose).toEqual([coal]);
		expect(onRemoved({ coal_ore: 0, iron_ore: 2 }, [iron, coal, coal]).rose).toEqual([coal]);
		expect(onRemoved({ coal_ore: 1 }, [coal]).rose).toEqual([]);
	});
});
describe('autoHotbar (spec §3)', () => {
	// slot:   0      1       2       3     4      5      6      7      8
	const bar = () => [stone, cobble, dirt, sand, AIR, planks, glass, lamp, iron];

	it('a TNT-sized rise 0 → 5 puts the block in the first empty slot (catches a trigger keyed to count === 1)', () => {
		const { inv, rose } = onRemoved({ stone: 4, dirt: 0 }, [coal, coal, coal, coal, coal]);
		expect(autoHotbar(bar(), 0, inv, rose, true)).toEqual([stone, cobble, dirt, sand, coal, planks, glass, lamp, iron]);
	});

	it('slot order is empty → untouched → at 0 (catches taking the first counted slot whatever its state)', () => {
		const noEmpty = [stone, cobble, dirt, sand, planks, planks, glass, lamp, iron];
		// sand (slot 3) untouched, dirt (slot 2) at 0: untouched wins even though dirt comes first
		expect(autoHotbar(noEmpty, 0, { stone: 4, dirt: 0, iron_ore: 1, coal_ore: 1 }, [coal], true)).toEqual(
			[stone, cobble, dirt, coal, planks, planks, glass, lamp, iron],
		);
		// nothing untouched: the counted slot at 0
		expect(autoHotbar(noEmpty, 0, { stone: 4, dirt: 0, sand: 3, iron_ore: 1, coal_ore: 1 }, [coal], true)).toEqual(
			[stone, cobble, coal, sand, planks, planks, glass, lamp, iron],
		);
	});

	it('never fills the selected slot (catches a candidate search that includes it)', () => {
		const onlySelectedEmpty = [stone, cobble, dirt, sand, AIR, planks, glass, lamp, iron];
		expect(autoHotbar(onlySelectedEmpty, 4, { stone: 4, dirt: 2, sand: 1, iron_ore: 1, coal_ore: 1 }, [coal], true)).toBeNull();
	});

	it('never replaces a free block or a slot with a count > 0 (catches "first non-selected slot")', () => {
		const full = [stone, cobble, dirt, sand, planks, planks, glass, lamp, iron];
		expect(autoHotbar(full, 0, { stone: 1, dirt: 1, sand: 1, iron_ore: 1, coal_ore: 1 }, [coal], true)).toBeNull();
	});

	it('a block already on the hotbar does not move (catches a second copy in another slot)', () => {
		expect(autoHotbar(bar(), 0, { stone: 1 }, [stone], true)).toBeNull();
		expect(autoHotbar(bar(), 3, { sand: 1 }, [sand], true)).toBeNull();
	});

	it('is a no-op in unlimited worlds and for free blocks (catches the rule leaking into existing worlds)', () => {
		expect(autoHotbar(bar(), 0, { coal_ore: 1 }, [coal], false)).toBeNull();
		expect(autoHotbar(bar(), 0, { cobblestone: 1 }, [cobble], true)).toBeNull();
	});

	it('two rises in one blast fill two slots in order', () => {
		const two = [stone, cobble, AIR, sand, AIR, planks, glass, lamp, iron];
		expect(autoHotbar(two, 0, { stone: 1, sand: 1, iron_ore: 1, coal_ore: 1, gold_ore: 1 }, [coal, id('gold_ore')], true)).toEqual(
			[stone, cobble, coal, sand, id('gold_ore'), planks, glass, lamp, iron],
		);
	});
});
