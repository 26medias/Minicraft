import { describe, it, expect } from 'vitest';
import { BLOCKS, GROUP_ORDER } from '../data/blocks.data';
import { inventoryRows } from './craft-model';

const names = (group: string) => inventoryRows(BLOCKS, group).map((b) => b.name);

describe('inventoryRows: every ore sits in the ORE row (playtest: 10 deepslate diamonds showed 0 on the Diamond Ore tile)', () => {
	it('the ORE row holds every *_ore block, each deepslate or nether variant right after its plain ore (catches rows built from BlockDef.group, which files deepslate ores under DEEPSLATE)', () => {
		expect(names('ore')).toEqual([
			'coal_ore', 'deepslate_coal_ore',
			'copper_ore', 'deepslate_copper_ore',
			'diamond_ore', 'deepslate_diamond_ore',
			'emerald_ore', 'deepslate_emerald_ore',
			'gold_ore', 'deepslate_gold_ore', 'nether_gold_ore',
			'iron_ore', 'deepslate_iron_ore',
			'lapis_ore', 'deepslate_lapis_ore',
			'nether_quartz_ore',
			'redstone_ore', 'deepslate_redstone_ore',
			'raw_copper_block', 'raw_gold_block', 'raw_iron_block', // the rest of the catalog's ore group, after the ores
		]);
	});

	it('no other row lists an ore, and no block is lost or listed twice (catches copying ores into ORE without removing them from DEEPSLATE/NETHER)', () => {
		for (const g of GROUP_ORDER) if (g !== 'ore') expect(names(g).filter((n) => n.endsWith('_ore'))).toEqual([]);
		const all = GROUP_ORDER.flatMap((g) => names(g));
		expect(new Set(all).size).toBe(all.length);
		expect(all.length).toBe(BLOCKS.filter((b) => b && b.id !== 0 && !b.retired).length);
	});

	it('BASICS keeps hand order and other rows stay sorted by label (catches a sort that reorders grass/dirt/stone)', () => {
		expect(names('basics').slice(0, 3)).toEqual(['grass_block', 'dirt', 'stone']);
		const labels = inventoryRows(BLOCKS, 'deepslate').map((b) => b.label);
		expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
	});
});
