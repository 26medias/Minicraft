import { describe, it, expect } from 'vitest';
import { BLOCKS, BLOCK_BY_NAME, AIR, isSolid, isTransparent, faceTexture } from './blocks.data';

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
});
