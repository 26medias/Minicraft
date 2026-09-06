import { describe, it, expect } from 'vitest';
import {
	assignIds, classifyAlpha, facesToTextures, firstVariantModel, groupOf,
	hardnessFor, isExcluded, isFullCube, labelFor, makeRows, modelKey, resolveFaces,
	selectCandidates, type Models, type BlockstateJson,
} from './catalog-rules';
import { BASE_BLOCKS } from './blocks.base.data';

// Trimmed copies of the real 1.21.6 models.
const models: Models = {
	block: {},
	cube: { parent: 'block/block', elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: {
		down: { texture: '#down' }, up: { texture: '#up' }, north: { texture: '#north' },
		south: { texture: '#south' }, west: { texture: '#west' }, east: { texture: '#east' } } }] },
	cube_all: { parent: 'block/cube', textures: { particle: '#all', down: '#all', up: '#all', north: '#all', east: '#all', south: '#all', west: '#all' } },
	cube_column: { parent: 'block/cube', textures: { particle: '#side', down: '#end', up: '#end', north: '#side', east: '#side', south: '#side', west: '#side' } },
	cube_bottom_top: { parent: 'block/cube', textures: { particle: '#side', down: '#bottom', up: '#top', north: '#side', east: '#side', south: '#side', west: '#side' } },
	orientable_with_bottom: { parent: 'block/cube', textures: { particle: '#front', down: '#bottom', up: '#top', north: '#front', east: '#side', south: '#side', west: '#side' } },
	orientable: { parent: 'block/orientable_with_bottom', textures: { bottom: '#top' } },
	orientable_vertical: { parent: 'block/cube', textures: { particle: '#side', down: '#side', up: '#front', north: '#side', east: '#side', south: '#side', west: '#side' } },
	template_glazed_terracotta: { parent: 'block/cube', textures: { particle: '#pattern' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: {
		down: { texture: '#pattern' }, up: { texture: '#pattern' }, north: { texture: '#pattern' },
		south: { texture: '#pattern' }, west: { texture: '#pattern' }, east: { texture: '#pattern' } } }] },
	stairs: { parent: 'block/block', elements: [{ from: [0, 0, 0], to: [16, 8, 16], faces: { up: { texture: '#top' } } }, { from: [8, 8, 0], to: [16, 16, 16], faces: { up: { texture: '#top' } } }] },
	stone: { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/stone' } },
	oak_log: { parent: 'minecraft:block/cube_column', textures: { end: 'minecraft:block/oak_log_top', side: 'minecraft:block/oak_log' } },
	sandstone: { parent: 'minecraft:block/cube_bottom_top', textures: { bottom: 'minecraft:block/sandstone_bottom', side: 'minecraft:block/sandstone', top: 'minecraft:block/sandstone_top' } },
	furnace: { parent: 'minecraft:block/orientable', textures: { front: 'minecraft:block/furnace_front', side: 'minecraft:block/furnace_side', top: 'minecraft:block/furnace_top' } },
	furnace_on: { parent: 'minecraft:block/orientable', textures: { front: 'minecraft:block/furnace_front_on', side: 'minecraft:block/furnace_side', top: 'minecraft:block/furnace_top' } },
	dispenser: { parent: 'minecraft:block/orientable', textures: { front: 'minecraft:block/dispenser_front', side: 'minecraft:block/furnace_side', top: 'minecraft:block/furnace_top' } },
	dispenser_vertical: { parent: 'minecraft:block/orientable_vertical', textures: { front: 'minecraft:block/dispenser_front_vertical', side: 'minecraft:block/furnace_top' } },
	cyan_glazed_terracotta: { parent: 'minecraft:block/template_glazed_terracotta', textures: { pattern: 'minecraft:block/cyan_glazed_terracotta' } },
	stone_stairs: { parent: 'minecraft:block/stairs', textures: { bottom: 'minecraft:block/stone', side: 'minecraft:block/stone', top: 'minecraft:block/stone' } },
	infested_stone: { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/stone' } },
	stone_bricks: { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/stone_bricks' } },
	infested_stone_bricks: { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/stone_bricks' } },
	glowstone: { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/glowstone' } },
	broken: { parent: 'minecraft:block/cube_all', textures: {} },
	redstone_lamp: { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/redstone_lamp' } },
	redstone_lamp_on: { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/redstone_lamp_on' } },
};

const bs = (model: string, extra: Record<string, { model: string }> = {}): BlockstateJson => ({
	variants: { '': { model: `minecraft:block/${model}` }, ...extra },
});

describe('modelKey', () => {
	it('strips namespace and block/ prefix', () => {
		expect(modelKey('minecraft:block/cube_all')).toBe('cube_all');
		expect(modelKey('block/cube')).toBe('cube');
		expect(modelKey('cube')).toBe('cube');
	});
});

describe('isFullCube', () => {
	it('accepts cube_all, template chains, and rejects stairs', () => {
		expect(isFullCube(models, 'stone')).toBe(true);
		expect(isFullCube(models, 'cyan_glazed_terracotta')).toBe(true);
		expect(isFullCube(models, 'stone_stairs')).toBe(false);
		expect(isFullCube(models, 'block')).toBe(false);
	});
});

describe('firstVariantModel', () => {
	it('takes the first variant in file order, array form included', () => {
		expect(firstVariantModel(bs('stone'))).toBe('stone');
		expect(firstVariantModel({ variants: { 'lit=false': [{ model: 'minecraft:block/furnace' }], 'lit=true': { model: 'minecraft:block/furnace_on' } } })).toBe('furnace');
		expect(firstVariantModel({ multipart: [] })).toBeNull();
	});
	it('prefers axis=y (upright logs) and facing=north (front on north) over file order', () => {
		// cherry_log lists axis=x first; its x model has a sideways element.
		expect(firstVariantModel({ variants: {
			'axis=x': { model: 'minecraft:block/cherry_log_horizontal' },
			'axis=y': { model: 'minecraft:block/cherry_log' },
			'axis=z': { model: 'minecraft:block/cherry_log_horizontal' } } })).toBe('cherry_log');
		expect(firstVariantModel({ variants: {
			'facing=down': { model: 'minecraft:block/dispenser_vertical' },
			'facing=north': { model: 'minecraft:block/dispenser' } } })).toBe('dispenser');
	});
});

describe('resolveFaces / facesToTextures', () => {
	it('resolves #var indirection through the chain', () => {
		expect(facesToTextures(resolveFaces(models, 'stone'))).toEqual({ kind: 'uniform', all: 'stone' });
		expect(facesToTextures(resolveFaces(models, 'oak_log'))).toEqual({ kind: 'columnar', top: 'oak_log_top', bottom: 'oak_log_top', sides: 'oak_log' });
		expect(facesToTextures(resolveFaces(models, 'sandstone'))).toEqual({ kind: 'top-bottom-side', top: 'sandstone_top', bottom: 'sandstone_bottom', side: 'sandstone' });
	});
	it('keeps the front of orientable blocks on nz (north) as a six-kind', () => {
		expect(facesToTextures(resolveFaces(models, 'furnace'))).toEqual({
			kind: 'six', px: 'furnace_side', nx: 'furnace_side', py: 'furnace_top', ny: 'furnace_top',
			pz: 'furnace_side', nz: 'furnace_front',
		});
	});
	it('resolves orientable_vertical (dispenser) with front on top', () => {
		const t = facesToTextures(resolveFaces(models, 'dispenser_vertical'));
		expect(t).toEqual({ kind: 'top-bottom-side', top: 'dispenser_front_vertical', bottom: 'furnace_top', side: 'furnace_top' });
	});
	it('resolves glazed terracotta through its template element', () => {
		expect(facesToTextures(resolveFaces(models, 'cyan_glazed_terracotta'))).toEqual({ kind: 'uniform', all: 'cyan_glazed_terracotta' });
	});
	it('throws on an unresolved face', () => {
		expect(() => resolveFaces(models, 'broken')).toThrow(/unresolved/);
	});
});

describe('isExcluded / groupOf / hardnessFor / labelFor', () => {
	it('excludes dev blocks and waxed/infested prefixes', () => {
		for (const n of ['jigsaw', 'structure_block', 'spawner', 'waxed_copper_block', 'infested_stone', 'respawn_anchor', 'barrier'])
			expect(isExcluded(n)).toBe(true);
		expect(isExcluded('copper_block')).toBe(false);
	});
	it.each([
		['cyan_glazed_terracotta', 'glazed'], ['blue_stained_glass', 'glass'], ['tinted_glass', 'glass'], ['ice', 'glass'],
		['pink_wool', 'wool'], ['red_concrete', 'concrete'], ['red_concrete_powder', 'concrete'], ['orange_terracotta', 'terracotta'],
		['brain_coral_block', 'coral'], ['sea_lantern', 'light'], ['redstone_lamp', 'light'], ['jack_o_lantern', 'light'],
		['deepslate', 'deepslate'], ['deepslate_gold_ore', 'deepslate'], ['tuff', 'deepslate'], ['sculk', 'deepslate'],
		['end_stone', 'end'], ['purpur_block', 'end'], ['netherrack', 'nether'], ['nether_bricks', 'nether'], ['blackstone', 'nether'],
		['ancient_debris', 'nether'], ['warped_planks', 'nether'], ['iron_ore', 'ore'], ['raw_gold_block', 'ore'],
		['copper_block', 'metal'], ['redstone_block', 'metal'], ['amethyst_block', 'metal'],
		['oak_planks', 'wood'], ['birch_log', 'wood'], ['acacia_leaves', 'wood'], ['bookshelf', 'wood'], ['bamboo_block', 'wood'],
		['furnace', 'utility'], ['crafting_table', 'utility'], ['note_block', 'utility'], ['bone_block', 'utility'], ['bee_nest', 'utility'],
		['sandstone', 'stone'], ['mossy_cobblestone', 'stone'], ['packed_mud', 'stone'], ['resin_bricks', 'stone'], ['bricks', 'stone'],
		['quartz_block', 'stone'], ['calcite', 'stone'], ['sand', 'sand'], ['gravel', 'sand'], ['clay', 'sand'],
		['coarse_dirt', 'earth'], ['moss_block', 'earth'], ['mycelium', 'earth'], ['snow_block', 'earth'], ['hay_block', 'earth'],
		['pumpkin', 'earth'], ['honey_block', 'earth'], ['slime_block', 'earth'], ['dried_kelp_block', 'earth'],
		['target', 'utility'], ['budding_amethyst', 'metal'], ['creaking_heart', 'other'],
	])('groups %s as %s', (name, group) => {
		expect(groupOf(name)).toBe(group);
	});
	it('assigns hardness by group', () => {
		expect(hardnessFor('wool')).toBe(0.3);
		expect(hardnessFor('wood')).toBe(0.8);
		expect(hardnessFor('stone')).toBe(1.2);
		expect(hardnessFor('metal')).toBe(1.5);
	});
	it('title-cases labels', () => {
		expect(labelFor('dark_oak_planks')).toBe('Dark Oak Planks');
		expect(labelFor('jack_o_lantern')).toBe('Jack O Lantern');
	});
});

describe('classifyAlpha', () => {
	it('distinguishes opaque, cutout, translucent', () => {
		expect(classifyAlpha([255, 255])).toEqual({ transparent: false, translucent: false });
		expect(classifyAlpha([255, 0])).toEqual({ transparent: true, translucent: false });
		expect(classifyAlpha([255, 102])).toEqual({ transparent: true, translucent: true });
	});
});

describe('selectCandidates', () => {
	const blockstates: Record<string, BlockstateJson> = {
		stone: bs('stone'),                      // in base → skipped by name
		stone_bricks: bs('stone_bricks'),
		infested_stone_bricks: bs('infested_stone_bricks'),   // excluded by prefix
		infested_stone: bs('infested_stone'),
		glowstone: bs('glowstone'),              // same look as base lamp → dropped
		furnace: { variants: { 'facing=north,lit=false': { model: 'minecraft:block/furnace' }, 'facing=north,lit=true': { model: 'minecraft:block/furnace_on' } } },
		dispenser: { variants: { 'facing=north': { model: 'minecraft:block/dispenser' }, 'facing=up': { model: 'minecraft:block/dispenser_vertical' } } },
		cyan_glazed_terracotta: bs('cyan_glazed_terracotta'),
		stone_stairs: bs('stone_stairs'),
		oak_fence: { multipart: [] },
		redstone_lamp: { variants: { 'lit=false': { model: 'minecraft:block/redstone_lamp' }, 'lit=true': { model: 'minecraft:block/redstone_lamp_on' } } },
		broken: bs('broken'),
	};
	it('keeps full cubes, applies exclusions, dedupes against base and shortest name, applies overrides', () => {
		const { candidates, dropped } = selectCandidates(blockstates, models, BASE_BLOCKS);
		const names = candidates.map((c) => c.name);
		expect(names).toEqual(['cyan_glazed_terracotta', 'dispenser', 'furnace', 'redstone_lamp', 'stone_bricks']);
		expect(candidates.find((c) => c.name === 'redstone_lamp')!.textures).toEqual({ kind: 'uniform', all: 'redstone_lamp_on' });
		expect(candidates.find((c) => c.name === 'furnace')!.textures.kind).toBe('six');
		const reasons = Object.fromEntries(dropped.map((d) => [d.name, d.reason]));
		expect(reasons.stone).toMatch(/base/);
		expect(reasons.infested_stone_bricks).toMatch(/excluded/);
		expect(reasons.glowstone).toMatch(/duplicate of lamp/);
		expect(reasons.stone_stairs).toMatch(/not a full cube/);
		expect(reasons.oak_fence).toMatch(/multipart|not a full cube/);
		expect(reasons.broken).toMatch(/unresolved/);
	});
});

describe('assignIds', () => {
	const empty = { ids: {}, retired: [] };
	it('keeps existing ids, appends new names in name order from max+1, starts at 20', () => {
		expect(assignIds(empty, ['b', 'a'], [])).toEqual({ ids: { a: 20, b: 21 }, retired: [] });
		expect(assignIds({ ids: { a: 20, b: 21 }, retired: [] }, ['b', 'a', 'c'], [])).toEqual({ ids: { a: 20, b: 21, c: 22 }, retired: [] });
	});
	it('records a retirement, never reuses the id, and needs no flag on later runs', () => {
		const once = assignIds({ ids: { a: 20, b: 21 }, retired: [] }, ['a', 'c'], ['b']);
		expect(once).toEqual({ ids: { a: 20, b: 21, c: 22 }, retired: ['b'] });
		expect(assignIds(once, ['a', 'c'], [])).toEqual(once);
	});
	it('throws when a frozen name disappears without --retire', () => {
		expect(() => assignIds({ ids: { a: 20, b: 21 }, retired: [] }, ['a'], [])).toThrow(/b/);
	});
	it('un-retires a name that resolves again, keeping its id', () => {
		expect(assignIds({ ids: { a: 20, b: 21 }, retired: ['b'] }, ['a', 'b'], [])).toEqual({ ids: { a: 20, b: 21 }, retired: [] });
	});
});

describe('makeRows', () => {
	it('emits rows in id order with tombstones for retired ids', () => {
		const map = { ids: { blue_stained_glass: 20, gone: 21, c: 22 }, retired: ['gone'] };
		const rows = makeRows(
			[{ name: 'c', textures: { kind: 'uniform', all: 'c' } }, { name: 'blue_stained_glass', textures: { kind: 'uniform', all: 'blue_stained_glass' } }],
			map,
			(t) => (t === 'blue_stained_glass' ? { transparent: true, translucent: true } : { transparent: false, translucent: false }),
		);
		expect(rows.map((r) => r.id)).toEqual([20, 21, 22]);
		expect(rows[1].retired).toBe(true);
		expect(rows[1].textures).toBeNull();
		expect(rows[0]).toMatchObject({ name: 'blue_stained_glass', transparent: true, translucent: true, lightFilter: 0, group: 'glass', hardness: 0.3 });
		expect(rows[2]).toMatchObject({ name: 'c', transparent: false, lightFilter: 15, group: 'other', hardness: 0.8, lightLevel: 0 });
	});
	it('applies LIGHT_LEVELS', () => {
		const rows = makeRows([{ name: 'sea_lantern', textures: { kind: 'uniform', all: 'sea_lantern' } }], { ids: { sea_lantern: 20 }, retired: [] }, () => ({ transparent: false, translucent: false }));
		expect(rows[0].lightLevel).toBe(15);
	});
});
