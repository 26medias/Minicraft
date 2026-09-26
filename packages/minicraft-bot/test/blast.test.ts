// The toy TNT exports (landscaper): the game's own blast cells and recipes, through the SDK's source entry.
import { describe, expect, it } from 'vitest';
import { blastCells, FLATTEN_HEIGHT, RECIPES, tntSpec, TUNNEL_LENGTH } from '../src/index';
import { BLOCK_BY_NAME } from '../../../src/data/blocks.data';

const STONE = BLOCK_BY_NAME['stone'].id;
const WATER = BLOCK_BY_NAME['water'].id;
const TNT = BLOCK_BY_NAME['tnt'].id;

/** A solid stone world from y 0 to 100 (bedrock-free), air above, one water cell and one TNT. */
const world = {
	inBounds: (_x: number, y: number) => y >= 0 && y < 256,
	getBlock: (x: number, y: number, z: number) => (x === 3 && y === 60 && z === 0 ? WATER : x === -2 && y === 55 && z === 1 ? TNT : y <= 100 ? STONE : 0),
};

describe('blast exports', () => {
	it('tntSpec gives the catalog radius, fuse and shape', () => {
		expect(tntSpec('flatten_tnt')).toEqual({ radius: 6, fuse: 3, shape: 'flatten' });
		expect(tntSpec('tunnel_tnt')).toEqual({ radius: 0, fuse: 3, shape: 'tunnel' });
		expect(tntSpec('stone')).toBeNull();
	});

	it('flatten: the radius-6 cylinder from the TNT y up FLATTEN_HEIGHT, solid only; other TNT primed, water kept', () => {
		const { destroyed, primed } = blastCells(world, 'flatten_tnt', { x: 0, y: 50, z: 0 });
		const inShape = (c: { x: number; y: number; z: number }) => c.x * c.x + c.z * c.z <= 36 && c.y >= 50 && c.y <= 50 + FLATTEN_HEIGHT;
		expect(destroyed.every(inShape)).toBe(true);
		expect(destroyed.some((c) => c.x === 3 && c.y === 60 && c.z === 0)).toBe(false);
		expect(primed).toEqual([{ x: -2, y: 55, z: 1 }]);
		// 113 columns × 13 layers, less the water and the TNT.
		expect(destroyed.length).toBe(113 * 13 - 2);
		// Above y 100 is air: nothing removed there.
		expect(blastCells(world, 'flatten_tnt', { x: 0, y: 95, z: 0 }).destroyed.every((c) => c.y <= 100)).toBe(true);
	});

	it('tunnel: 3 wide × 3 tall × TUNNEL_LENGTH along dir', () => {
		const { destroyed } = blastCells(world, 'tunnel_tnt', { x: 0, y: 20, z: 0 }, 'nz');
		expect(destroyed.length).toBe(9 * TUNNEL_LENGTH);
		expect(Math.min(...destroyed.map((c) => c.z))).toBe(-(TUNNEL_LENGTH - 1));
		expect(new Set(destroyed.map((c) => c.x))).toEqual(new Set([-1, 0, 1]));
	});

	it('the flatten and tunnel recipes are the Craft tab rows', () => {
		const f = RECIPES.find((r) => r.id === 'flatten_tnt')!;
		expect(f.output).toEqual({ kind: 'block', name: 'flatten_tnt', count: 1 });
		expect(f.needs).toEqual([{ anyOf: ['big_tnt'], count: 2 }, { anyOf: ['stone'], count: 16 }]);
		expect(RECIPES.find((r) => r.id === 'tunnel_tnt')!.needs).toEqual([{ anyOf: ['tnt'], count: 2 }, { anyOf: ['iron_ore', 'deepslate_iron_ore'], count: 8 }]);
	});
});
