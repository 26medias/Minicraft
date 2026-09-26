// src/data/texture-sources.test.ts
import { describe, it, expect } from 'vitest';
import { TEXTURE_SOURCES } from './texture-sources.data';
import { BLOCKS } from './blocks.data';
import {
	CRACK_STAGES, PACKS, TRACED_SOURCES, alphaModeFor, requiredTextureNames, resolveOrder, type TextureSource,
} from './texture-sources';

describe('texture-sources data (spec §4.1, §6)', () => {
	it('has exactly one row per required texture: 448 block textures + 10 crack stages', () => {
		// Catches a block added later with no source row (Review Focus 1) and a stale extra row.
		expect(Object.keys(TEXTURE_SOURCES).sort()).toEqual(requiredTextureNames());
		expect(requiredTextureNames()).toHaveLength(458);
	});
	it('never takes a traced Pixel Perfection file, including through derive/over rows', () => {
		for (const [name, r] of Object.entries(TEXTURE_SOURCES)) {
			if (!('pack' in r)) continue;
			expect(TRACED_SOURCES.some((t) => t.pack === r.pack && t.file === r.file), name).toBe(false);
		}
	});
	it('every pack is pinned to a full 40-char commit', () => {
		for (const p of Object.values(PACKS)) expect(p.commit).toMatch(/^[0-9a-f]{40}$/);
	});
	it('over/same rows resolve after their targets, and cycles are refused', () => {
		const order = resolveOrder(TEXTURE_SOURCES);
		for (const [name, r] of Object.entries(TEXTURE_SOURCES)) {
			const dep = 'over' in r ? r.over : 'same' in r ? r.same : null;
			if (dep) expect(order.indexOf(dep), name).toBeLessThan(order.indexOf(name));
		}
		const cyclic: Record<string, TextureSource> = { a: { same: 'b' }, b: { same: 'a' } };
		expect(() => resolveOrder(cyclic)).toThrow(/Cycle/);
	});
	it('alpha modes follow spec §5.1', () => {
		expect(alphaModeFor('water_still')).toBe('keep');
		expect(alphaModeFor('lava_still')).toBe('keep');
		expect(alphaModeFor('destroy_stage_3')).toBe('keep');
		expect(alphaModeFor('stone')).toBe('opaque');
		expect(alphaModeFor('slime_block')).toBe('opaque');
		expect(alphaModeFor('oak_leaves')).toBe('cutout');
		expect(alphaModeFor('blue_stained_glass')).toBe('translucent');
		expect(CRACK_STAGES).toHaveLength(10);
	});
	it('a texture shared by blocks with different alpha flags is refused (Review Focus 4)', () => {
		// Synthetic catalog: one opaque and one cutout block share 'shared_tile'. Deleting the conflict check goes red here.
		const base = BLOCKS.find((b) => b.name === 'stone')!;
		const blocks = [
			{ ...base, name: 'a', transparent: false, translucent: false, textures: { kind: 'uniform' as const, all: 'shared_tile' } },
			{ ...base, name: 'b', transparent: true, translucent: false, textures: { kind: 'uniform' as const, all: 'shared_tile' } },
		];
		expect(() => alphaModeFor('shared_tile', blocks)).toThrow(/different alpha flags/);
	});
	it('every texture has a consistent alpha mode (no texture shared by conflicting blocks)', () => {
		// Review Focus 4: alphaModeFor throws on a conflict; run it over every row.
		for (const name of Object.keys(TEXTURE_SOURCES)) expect(() => alphaModeFor(name), name).not.toThrow();
	});
});
