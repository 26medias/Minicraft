import { describe, it, expect } from 'vitest';
import { AIR, BLOCK_BY_NAME, BLOCKS, DEFAULT_HOTBAR } from '../data/blocks.data';
import type { Inventory, PlayerTools } from '../data/crafting.data';
import { RECIPES, type Recipe } from '../data/recipes.data';
import {
	badgeText, blockTileView, craftCards, hotbarBadges, keycapLabel, pickaxeRow,
} from './craft-model';

const id = (name: string) => BLOCK_BY_NAME[name].id;
const def = (name: string) => BLOCK_BY_NAME[name];
const HAND: PlayerTools = { owned: [0], equipped: 0 };
const pickaxeRecipe = (tier: number) => RECIPES.find((r) => r.output.kind === 'pickaxe' && r.output.tier === tier)!;
const blockRecipe = (name: string) => RECIPES.find((r) => r.output.kind === 'block' && r.output.name === name)!;
/** Exactly enough of every ingredient, all on the first anyOf name. */
function enough(r: Recipe, minus = 0): Inventory {
	const inv: Inventory = {};
	for (const n of r.needs) inv[n.anyOf[0]] = (inv[n.anyOf[0]] ?? 0) + n.count;
	if (minus) inv[r.needs[0].anyOf[0]] -= minus;
	return inv;
}

describe('Blocks tab tiles (spec §3, §9)', () => {
	it('crafted-only blocks are hidden from the Blocks tab at count 0, in every world', () => {
		// Catches no filter at all (Big/Mega TNT pickable for free) and a filter applied only in must-mine worlds.
		for (const mustMine of [false, true]) {
			expect(blockTileView(def('big_tnt'), {}, mustMine).visible).toBe(false);
			expect(blockTileView(def('mega_tnt'), { mega_tnt: 0 }, mustMine).visible).toBe(false);
			expect(blockTileView(def('big_tnt'), { big_tnt: 1 }, mustMine)).toEqual({ visible: true, badge: '1', dimmed: false });
		}
	});

	it('plain TNT and counted blocks stay visible at 0; only must-mine dims counted blocks at 0', () => {
		// Catches hiding every block at 0 (the grid would be empty in a new world) and dimming in unlimited worlds.
		expect(blockTileView(def('tnt'), {}, false)).toEqual({ visible: true, badge: null, dimmed: false });
		expect(blockTileView(def('stone'), {}, false)).toEqual({ visible: true, badge: null, dimmed: false });
		expect(blockTileView(def('stone'), {}, true)).toEqual({ visible: true, badge: null, dimmed: true });
		expect(blockTileView(def('stone'), { stone: 12 }, true)).toEqual({ visible: true, badge: '12', dimmed: false });
		// cobblestone is free in must-mine worlds: never dimmed; shows a count if he has some.
		expect(blockTileView(def('cobblestone'), {}, true)).toEqual({ visible: true, badge: null, dimmed: false });
		expect(blockTileView(def('cobblestone'), { cobblestone: 3 }, true).badge).toBe('3');
	});

	it('badges cap at 999+', () => {
		// Catches a 4-digit count overflowing the 48 px tile.
		expect(badgeText(999)).toBe('999');
		expect(badgeText(1000)).toBe('999+');
	});
});

describe('hotbar badges (spec §3)', () => {
	it('unlimited world: only crafted-only slots carry a badge, even with counts seeded', () => {
		// Catches "badge whenever count > 0": free TNT in an unlimited world must not look limited.
		const bar = [id('tnt'), id('big_tnt'), id('stone'), AIR, ...DEFAULT_HOTBAR.slice(0, 5)];
		const b = hotbarBadges(bar, { tnt: 3, stone: 7 }, false);
		expect(b[0]).toBeNull();
		expect(b[1]).toEqual({ text: '0', grey: true });
		expect(b[2]).toBeNull();
		expect(b[3]).toBeNull();
	});

	it('must-mine world: counted slots show the count, grey at 0; free blocks show nothing', () => {
		// Catches a badge on cobblestone/planks (free) and a grey slot that has a count.
		const bar = [id('stone'), id('dirt'), id('cobblestone'), id('oak_planks'), id('tnt'), AIR, AIR, AIR, AIR];
		const b = hotbarBadges(bar, { stone: 4, dirt: 0 }, true);
		expect(b.slice(0, 5)).toEqual([{ text: '4', grey: false }, { text: '0', grey: true }, null, null, { text: '0', grey: true }]);
	});
});

describe('craft cards (spec §9)', () => {
	it('one card per recipe, in recipe order; the 7 pickaxes are the icon cards', () => {
		// Catches a card list built from PICKAXES alone (no TNT or toy cards) or including the Hand.
		const cards = craftCards(RECIPES, {}, HAND);
		expect(cards.map((c) => c.recipeId)).toEqual(RECIPES.map((r) => r.id));
		expect(cards.filter((c) => c.picture.kind === 'icon').map((c) => c.outputKey)).toEqual([1, 2, 3, 4, 5, 6, 7].map((t) => `pickaxe:${t}`));
		expect(cards.find((c) => c.recipeId === blockRecipe('tnt').id)!.countLabel).toBe('×2');
		expect(cards.find((c) => c.recipeId === blockRecipe('slime_pad').id)!.countLabel).toBe('×2');
	});

	it('have sums every accepted variant; the bar fills to have/need and caps at 1', () => {
		// Catches `have` read from anyOf[0] only (deepslate ore would not count) and an uncapped bar.
		const r = pickaxeRecipe(4);
		const oreNeed = r.needs.find((n) => n.anyOf.length === 2)!;
		const [plain, deep] = oreNeed.anyOf;
		const card = craftCards([r], { [plain]: 5, [deep]: 3 }, HAND)[0];
		const ing = card.ingredients[r.needs.indexOf(oreNeed)];
		expect(ing).toMatchObject({ have: 8, need: oreNeed.count, short: true, label: BLOCK_BY_NAME[plain].label });
		expect(ing.fill).toBeCloseTo(8 / oreNeed.count);
		expect(ing.title).toContain(BLOCK_BY_NAME[deep].label);
		const rich = craftCards([r], { [plain]: 500 }, HAND)[0].ingredients[r.needs.indexOf(oreNeed)];
		expect(rich.fill).toBe(1);
	});

	it('ready with exactly enough; short by one is disabled; an owned pickaxe shows a check mark', () => {
		// Catches an off-by-one (have > need instead of >=) and an owned pickaxe still craftable.
		for (const r of RECIPES) {
			expect(craftCards([r], enough(r), HAND)[0].state).toBe('ready');
			expect(craftCards([r], enough(r, 1), HAND)[0].state).toBe('short');
		}
		const wood = pickaxeRecipe(1);
		expect(craftCards([wood], enough(wood), { owned: [0, 1], equipped: 1 })[0].state).toBe('owned');
	});

	it('an owned pickaxe card has no ingredient rows (catches red "0 / 8" bars under the check mark, which read as unfinished)', () => {
		const wood = pickaxeRecipe(1);
		expect(craftCards([wood], {}, { owned: [0, 1], equipped: 1 })[0].ingredients).toEqual([]);
		expect(craftCards([wood], {}, HAND)[0].ingredients).toHaveLength(1);
	});
});

describe('pickaxe row and keycap', () => {
	it('owned pickaxes ascending, equipped one flagged', () => {
		// Catches save order leaking into the row and a row that frames the highest tier instead of the equipped one.
		const row = pickaxeRow({ owned: [4, 0, 1], equipped: 1 });
		expect(row.map((p) => p.tier)).toEqual([0, 1, 4]);
		expect(row.map((p) => p.equipped)).toEqual([false, true, false]);
		expect(row[2].icon).toBe('pickaxe_4');
	});

	it('keycap shows the bound key; unbound shows nothing', () => {
		// Catches a hard-coded "P" after he rebinds cyclePickaxe, and "undefined" when unbound.
		expect(keycapLabel('KeyP')).toBe('P');
		expect(keycapLabel('KeyO')).toBe('O');
		expect(keycapLabel('Digit0')).toBe('0');
		expect(keycapLabel('')).toBe('');
	});
});

it('every BLOCKS row used as a picture exists (no retired ids on cards)', () => {
	// Catches an ingredient name with no block (a typo in recipes would render an empty icon).
	for (const c of craftCards(RECIPES, {}, HAND)) {
		for (const i of c.ingredients) if (i.picture.kind === 'block') expect(BLOCKS[i.picture.id].retired).toBeUndefined();
	}
});
