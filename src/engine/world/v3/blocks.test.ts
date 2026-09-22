import { describe, it, expect } from 'vitest';
import { V3, TERRA, ORE_DEEPSLATE } from './blocks';
import { BLOCK_BY_NAME, BLOCKS } from '../../../data/blocks.data';

describe('v3 block table', () => {
	it('resolves every name to a live catalog id', () => {
		for (const [name, id] of Object.entries(V3)) {
			const def = BLOCKS[id];
			expect(def, name).toBeDefined();
			expect(def.retired ?? false, name).toBe(false);
			if (name !== 'air') expect(id, name).toBeGreaterThan(0);
		}
		expect(V3.air).toBe(0);
		expect(V3.grass_block).toBe(BLOCK_BY_NAME['grass_block'].id);
	});
	it('terracotta band has 16 entries in the §4 order', () => {
		expect(TERRA.length).toBe(16);
		expect(TERRA[0]).toBe(V3.terracotta); expect(TERRA[1]).toBe(V3.orange_terracotta); expect(TERRA[3]).toBe(V3.yellow_terracotta);
		expect(TERRA[5]).toBe(V3.white_terracotta); expect(TERRA[6]).toBe(V3.red_terracotta); expect(TERRA[8]).toBe(V3.brown_terracotta);
		expect(TERRA[11]).toBe(V3.light_gray_terracotta); expect(TERRA[13]).toBe(V3.red_terracotta); expect(TERRA[14]).toBe(V3.orange_terracotta);
	});
	it('maps every plain ore to its deepslate variant', () => {
		for (const n of ['coal', 'iron', 'copper', 'gold', 'lapis', 'redstone', 'diamond', 'emerald'] as const)
			expect(ORE_DEEPSLATE.get(V3[`${n}_ore`])).toBe(V3[`deepslate_${n}_ore`]);
		expect(ORE_DEEPSLATE.size).toBe(8);
	});
});
