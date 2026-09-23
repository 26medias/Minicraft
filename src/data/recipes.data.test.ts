import { describe, it, expect } from 'vitest';
import { RECIPES, type CraftTab } from './recipes.data';

const flat = (id: string) => {
	const r = RECIPES.find((x) => x.id === id)!;
	return { output: r.output, needs: r.needs.map((n) => [n.anyOf.join('|'), n.count]) };
};
const LOGS = 'oak_log|birch_log|spruce_log|acacia_log|cherry_log';

describe('RECIPES (spec §4 tables)', () => {
	it('has the 7 pickaxes, 3 TNT tiers, 5 blast toys and 2 pads; ids unique; one recipe per pickaxe tier 1–7', () => {
		// Catches a dropped or duplicated row. The blast toys' ids are phase T's, so they are matched by output.
		expect(RECIPES.slice(0, 10).map((r) => r.id)).toEqual([
			'wood_pickaxe', 'stone_pickaxe', 'copper_pickaxe', 'iron_pickaxe', 'gold_pickaxe', 'diamond_pickaxe', 'emerald_pickaxe', 'tnt', 'big_tnt', 'mega_tnt',
		]);
		expect(RECIPES.length).toBe(17);
		expect(new Set(RECIPES.map((r) => r.id)).size).toBe(17);
		const later = RECIPES.slice(10).map((r) => (r.output.kind === 'block' ? r.output.name : `pickaxe:${r.output.tier}`));
		expect(later.sort()).toEqual(['block_bomb', 'fireworks', 'flatten_tnt', 'lake_tnt', 'launch_pad', 'slime_pad', 'tunnel_tnt']);
		const tiers = RECIPES.flatMap((r) => (r.output.kind === 'pickaxe' ? [r.output.tier] : []));
		expect(tiers).toEqual([1, 2, 3, 4, 5, 6, 7]);
	});

	it('pickaxe ingredients match the table, plain ore before deepslate (catches a wrong count, or deepslate taken first)', () => {
		expect(flat('wood_pickaxe').needs).toEqual([[LOGS, 8]]);
		expect(flat('stone_pickaxe').needs).toEqual([['stone', 24], [LOGS, 4]]);
		expect(flat('copper_pickaxe').needs).toEqual([['copper_ore|deepslate_copper_ore', 16], ['stone', 32]]);
		expect(flat('iron_pickaxe').needs).toEqual([['iron_ore|deepslate_iron_ore', 16], ['stone', 48]]);
		expect(flat('gold_pickaxe').needs).toEqual([['gold_ore|deepslate_gold_ore', 16], ['redstone_ore|deepslate_redstone_ore', 8]]);
		expect(flat('diamond_pickaxe').needs).toEqual([['diamond_ore|deepslate_diamond_ore', 8], ['lapis_ore|deepslate_lapis_ore', 6]]);
		expect(flat('emerald_pickaxe').needs).toEqual([['emerald_ore|deepslate_emerald_ore', 3], ['diamond_ore|deepslate_diamond_ore', 4], ['deepslate', 32]]);
	});

	it('TNT rows match the table (catches 1 TNT per craft instead of 2)', () => {
		expect(flat('tnt')).toEqual({ output: { kind: 'block', name: 'tnt', count: 2 }, needs: [['sand', 5], ['coal_ore|deepslate_coal_ore', 4]] });
		expect(flat('big_tnt')).toEqual({ output: { kind: 'block', name: 'big_tnt', count: 1 }, needs: [['tnt', 2], ['redstone_ore|deepslate_redstone_ore', 4]] });
		expect(flat('mega_tnt')).toEqual({ output: { kind: 'block', name: 'mega_tnt', count: 1 }, needs: [['big_tnt', 2], ['lapis_ore|deepslate_lapis_ore', 4]] });
	});
	it('blast toy rows match toys spec §3 and sit in the Boom tab (catches a wrong count, Fireworks making 1 instead of 3, or a toy row in no tab)', () => {
		expect(flat('fireworks')).toEqual({ output: { kind: 'block', name: 'fireworks', count: 3 }, needs: [['sand', 1], ['coal_ore|deepslate_coal_ore', 2]] });
		expect(flat('tunnel_tnt')).toEqual({ output: { kind: 'block', name: 'tunnel_tnt', count: 1 }, needs: [['tnt', 2], ['iron_ore|deepslate_iron_ore', 8]] });
		expect(flat('block_bomb')).toEqual({ output: { kind: 'block', name: 'block_bomb', count: 1 }, needs: [['tnt', 2], ['sand', 8]] });
		expect(flat('flatten_tnt')).toEqual({ output: { kind: 'block', name: 'flatten_tnt', count: 1 }, needs: [['big_tnt', 2], ['stone', 16]] });
		expect(flat('lake_tnt')).toEqual({ output: { kind: 'block', name: 'lake_tnt', count: 1 }, needs: [['tnt', 2], ['ice', 4]] });
		for (const id of ['fireworks', 'tunnel_tnt', 'block_bomb', 'flatten_tnt', 'lake_tnt']) expect(RECIPES.find((r) => r.id === id)!.tab, id).toBe('boom');
	});
});

describe('pad recipes and Craft tabs (toys spec §3.1, §3.2, §5)', () => {
	it('Slime Pad: 4 moss block + 2 clay → 2; Launch Pad: 1 slime pad + 4 redstone ore → 1', () => {
		// Catches 1 Slime Pad per craft (the Launch Pad would cost him every pad he makes) and a Launch Pad that
		// takes deepslate redstone before plain.
		expect(flat('slime_pad')).toEqual({ output: { kind: 'block', name: 'slime_pad', count: 2 }, needs: [['moss_block', 4], ['clay', 2]] });
		expect(flat('launch_pad')).toEqual({ output: { kind: 'block', name: 'launch_pad', count: 1 }, needs: [['slime_pad', 1], ['redstone_ore|deepslate_redstone_ore', 4]] });
	});

	it('every recipe is in exactly one tab: Pickaxes 7, Boom 8 (TNT, Big, Mega first), Toys 2', () => {
		// Catches a row with no tab (its card would be on no tab: uncraftable), a pad filed under Boom, and the
		// TNT tiers moved behind the blast toys.
		const key = (r: (typeof RECIPES)[number]) => (r.output.kind === 'pickaxe' ? `pickaxe:${r.output.tier}` : r.output.name);
		const inTab = (t: CraftTab) => RECIPES.filter((r) => r.tab === t).map(key);
		for (const r of RECIPES) expect(['pickaxes', 'boom', 'toys']).toContain(r.tab);
		expect(inTab('pickaxes')).toEqual([1, 2, 3, 4, 5, 6, 7].map((t) => `pickaxe:${t}`));
		const boom = inTab('boom');
		expect(boom.slice(0, 3)).toEqual(['tnt', 'big_tnt', 'mega_tnt']);
		expect([...boom].sort()).toEqual(['big_tnt', 'block_bomb', 'fireworks', 'flatten_tnt', 'lake_tnt', 'mega_tnt', 'tnt', 'tunnel_tnt']);
		expect(inTab('toys')).toEqual(['slime_pad', 'launch_pad']);
	});
});
