import { describe, it, expect } from 'vitest';
import { BLOCKS, BLOCK_BY_NAME, AIR, isSolid, isTransparent, faceTexture, isLiquid, WATER, LAVA } from './blocks.data';

describe('block catalog', () => {
	it('has air at id 0', () => {
		expect(AIR).toBe(0);
		expect(BLOCKS[0].name).toBe('air');
	});

	it('has unique ids matching array index', () => {
		for (let i = 0; i < BLOCKS.length; i++) {
			expect(BLOCKS[i].id).toBe(i);
		}
	});

	it('has unique names', () => {
		const names = BLOCKS.map((b) => b.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it('indexes by name', () => {
		expect(BLOCK_BY_NAME['grass_block'].name).toBe('grass_block');
		expect(BLOCK_BY_NAME['stone'].id).toBeGreaterThan(0);
	});

	it('treats air as non-solid and transparent', () => {
		expect(isSolid(AIR)).toBe(false);
		expect(isTransparent(AIR)).toBe(true);
	});

	it('treats stone as solid and opaque', () => {
		const stone = BLOCK_BY_NAME['stone'].id;
		expect(isSolid(stone)).toBe(true);
		expect(isTransparent(stone)).toBe(false);
	});

	it('treats glass as solid and transparent', () => {
		const glass = BLOCK_BY_NAME['glass'].id;
		expect(isSolid(glass)).toBe(true);
		expect(isTransparent(glass)).toBe(true);
	});

	it('returns face textures for grass (top/bottom/side differ)', () => {
		const grass = BLOCK_BY_NAME['grass_block'].id;
		expect(faceTexture(grass, 'py')).toBe('grass_block_top');
		expect(faceTexture(grass, 'ny')).toBe('dirt');
		expect(faceTexture(grass, 'px')).toBe('grass_block_side');
	});

	it('flags exactly the kid-mode set', () => {
		const kid = BLOCKS.filter((b) => b.kidMode).map((b) => b.name);
		expect(kid).toContain('grass_block');
		expect(kid).toContain('dirt');
		expect(kid).toContain('stone');
	});

	it('assigns hardness per block — air 0, soft < wood < stone, glass fastest', () => {
		expect(BLOCK_BY_NAME['air'].hardness).toBe(0);
		expect(BLOCK_BY_NAME['glass'].hardness).toBeGreaterThan(0);
		expect(BLOCK_BY_NAME['glass'].hardness).toBeLessThan(BLOCK_BY_NAME['dirt'].hardness);
		expect(BLOCK_BY_NAME['dirt'].hardness).toBeLessThan(BLOCK_BY_NAME['oak_planks'].hardness);
		expect(BLOCK_BY_NAME['oak_planks'].hardness).toBeLessThan(BLOCK_BY_NAME['stone'].hardness);
	});
});

describe('BlockDef light + liquid fields', () => {
	it('every block defines lightLevel, lightFilter, liquid', () => {
		for (const b of BLOCKS) {
			expect(typeof b.lightLevel).toBe('number');
			expect(typeof b.lightFilter).toBe('number');
			expect(['none', 'water', 'lava']).toContain(b.liquid);
			expect(b.lightLevel).toBeGreaterThanOrEqual(0);
			expect(b.lightLevel).toBeLessThanOrEqual(15);
			expect(b.lightFilter).toBeGreaterThanOrEqual(0);
			expect(b.lightFilter).toBeLessThanOrEqual(15);
		}
	});

	it('air has filter 0 and emits nothing', () => {
		const air = BLOCKS[AIR];
		expect(air.lightFilter).toBe(0);
		expect(air.lightLevel).toBe(0);
		expect(air.liquid).toBe('none');
	});

	it('glass is fully transparent to light (filter 0)', () => {
		expect(BLOCK_BY_NAME['glass'].lightFilter).toBe(0);
		expect(BLOCK_BY_NAME['glass'].lightLevel).toBe(0);
	});

	it('lamp emits max light (15) and blocks transmitted light (filter 15)', () => {
		expect(BLOCK_BY_NAME['lamp'].lightLevel).toBe(15);
		expect(BLOCK_BY_NAME['lamp'].lightFilter).toBe(15);
	});

	it('all non-lamp non-glass solid blocks have filter 15 and lightLevel 0', () => {
		const exceptions = new Set(['air', 'glass', 'lamp', 'water', 'lava']);
		for (const b of BLOCKS) {
			if (exceptions.has(b.name)) continue;
			expect(b.lightFilter).toBe(15);
			expect(b.lightLevel).toBe(0);
			expect(b.liquid).toBe('none');
		}
	});

	it('isLiquid returns false for air and solids, true for water/lava (once added)', () => {
		expect(isLiquid(AIR)).toBe(false);
		expect(isLiquid(BLOCK_BY_NAME['stone'].id)).toBe(false);
		// water/lava assertions land in Task 2.
	});
});

describe('water and lava', () => {
	it('water has id 17, is non-solid, translucent, liquid=water, filter 2, emit 0', () => {
		const w = BLOCK_BY_NAME['water'];
		expect(w.id).toBe(17);
		expect(w.solid).toBe(false);
		expect(w.transparent).toBe(true);
		expect(w.kidMode).toBe(true);
		expect(w.liquid).toBe('water');
		expect(w.lightFilter).toBe(2);
		expect(w.lightLevel).toBe(0);
		expect(w.hardness).toBe(0);
	});

	it('lava has id 18, is non-solid, translucent, liquid=lava, filter 3, emit 12', () => {
		const l = BLOCK_BY_NAME['lava'];
		expect(l.id).toBe(18);
		expect(l.solid).toBe(false);
		expect(l.transparent).toBe(true);
		expect(l.kidMode).toBe(true);
		expect(l.liquid).toBe('lava');
		expect(l.lightFilter).toBe(3);
		expect(l.lightLevel).toBe(12);
		expect(l.hardness).toBe(0);
	});

	it('WATER and LAVA constants match the block rows', () => {
		expect(BLOCKS[WATER].name).toBe('water');
		expect(BLOCKS[LAVA].name).toBe('lava');
	});

	it('isLiquid is true for water and lava', () => {
		expect(isLiquid(WATER)).toBe(true);
		expect(isLiquid(LAVA)).toBe(true);
	});
});

describe('obsidian block', () => {
	it('is defined and has expected properties', () => {
		const obsidian = BLOCK_BY_NAME['obsidian'];
		expect(obsidian).toBeDefined();
		expect(obsidian.solid).toBe(true);
		expect(obsidian.transparent).toBe(false);
		expect(obsidian.kidMode).toBe(true);
		expect(obsidian.liquid).toBe('none');
		expect(obsidian.hardness).toBe(1.2);
		expect(obsidian.lightLevel).toBe(0);
		expect(obsidian.lightFilter).toBe(15);
		expect(obsidian.textures).toEqual({ kind: 'uniform', all: 'obsidian' });
	});
});
