import type { BlockDef } from './blocks.base.data';

/**
 * Hand-written blocks outside the generated catalog (spec §6). Their ids start at
 * EXTRA_ID_START and are NOT in blocks.catalog.ids.json; assignIds refuses to
 * generate an id this high, so the two ranges can never collide. Never renumber.
 */
export const EXTRA_ID_START = 1000;

export const EXTRA_BLOCKS: BlockDef[] = [
	{ id: 1000, name: 'big_tnt', label: 'Big TNT', solid: true, transparent: false, translucent: false, group: 'basics', hardness: 0.5,
		lightLevel: 0, lightFilter: 15, liquid: 'none', tnt: { radius: 5, fuse: 4 },
		textures: { kind: 'top-bottom-side', top: 'big_tnt_top', bottom: 'big_tnt_bottom', side: 'big_tnt_side' } },
	{ id: 1001, name: 'mega_tnt', label: 'Mega TNT', solid: true, transparent: false, translucent: false, group: 'basics', hardness: 0.5,
		lightLevel: 0, lightFilter: 15, liquid: 'none', tnt: { radius: 8, fuse: 6 },
		textures: { kind: 'top-bottom-side', top: 'mega_tnt_top', bottom: 'mega_tnt_bottom', side: 'mega_tnt_side' } },
];
