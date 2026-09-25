import { describe, it, expect } from 'vitest';
import { isHandEdit } from './hand-edit';
import { BLOCKS, AIR } from '../data/blocks.data';
import type { Op } from '../net/protocol';

const STONE = 1;
const WATER = BLOCKS.findIndex((b) => b?.liquid === 'water');
const op = (id: number, x = 0): Op => [x, 64, 0, id, 0, 0];

describe('isHandEdit', () => {
	const world = new Map<string, number>([['0,64,0', STONE], ['1,64,0', WATER]]);
	const at = (x: number, y: number, z: number) => world.get(`${x},${y},${z}`) ?? AIR;
	it('placing a solid block is a hand edit', () => expect(isHandEdit([op(STONE, 5)], at)).toBe(true));
	it('breaking a solid block (air over stone) is a hand edit', () => expect(isHandEdit([op(AIR, 0)], at)).toBe(true));
	it('water spreading is not', () => expect(isHandEdit([op(WATER, 5), op(WATER, 6)], at)).toBe(false));
	it('water receding (air over water) is not', () => expect(isHandEdit([op(AIR, 1)], at)).toBe(false));
	it('air over air (a drain echo) is not', () => expect(isHandEdit([op(AIR, 9)], at)).toBe(false));
	it('an explosion-sized edit is not', () => expect(isHandEdit(Array.from({ length: 10 }, (_, i) => op(AIR, i === 0 ? 0 : 100 + i)), at)).toBe(false));
	it('a 3×3 pickaxe break is', () => expect(isHandEdit(Array.from({ length: 9 }, () => op(AIR, 0)), at)).toBe(true));
});
