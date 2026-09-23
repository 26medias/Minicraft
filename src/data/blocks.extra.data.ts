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
	// Toys spec §3.1–3.2: pads are plain solid blocks; Player.update reads `pad` from the block under his feet.
	{ id: 1002, name: 'slime_pad', label: 'Slime Pad', solid: true, transparent: false, translucent: false, group: 'basics', hardness: 0.5,
		lightLevel: 0, lightFilter: 15, liquid: 'none', pad: 'slime',
		textures: { kind: 'uniform', all: 'slime_block' } },
	{ id: 1003, name: 'launch_pad', label: 'Launch Pad', solid: true, transparent: false, translucent: false, group: 'basics', hardness: 0.5,
		lightLevel: 0, lightFilter: 15, liquid: 'none', pad: 'launch',
		textures: { kind: 'uniform', all: 'launch_pad' } },
	// Toys spec §3.3–3.7: the blast toys. 1002/1003 are the pads (phase P). Never renumber.
	{ id: 1004, name: 'fireworks', label: 'Fireworks', solid: true, transparent: false, translucent: false, group: 'basics', hardness: 0.5,
		lightLevel: 0, lightFilter: 15, liquid: 'none', tnt: { radius: 0, fuse: 1, shape: 'firework' },
		textures: { kind: 'top-bottom-side', top: 'fireworks_top', bottom: 'fireworks_bottom', side: 'fireworks_side' } },
	{ id: 1005, name: 'tunnel_tnt', label: 'Tunnel TNT', solid: true, transparent: false, translucent: false, group: 'basics', hardness: 0.5,
		lightLevel: 0, lightFilter: 15, liquid: 'none', tnt: { radius: 0, fuse: 3, shape: 'tunnel' },
		textures: { kind: 'top-bottom-side', top: 'tunnel_tnt_top', bottom: 'tunnel_tnt_bottom', side: 'tunnel_tnt_side' } },
	{ id: 1006, name: 'block_bomb', label: 'Block Bomb', solid: true, transparent: false, translucent: false, group: 'basics', hardness: 0.5,
		lightLevel: 0, lightFilter: 15, liquid: 'none', tnt: { radius: 5, fuse: 3, shape: 'dome' },
		textures: { kind: 'top-bottom-side', top: 'block_bomb_top', bottom: 'block_bomb_bottom', side: 'block_bomb_side' } },
	{ id: 1007, name: 'flatten_tnt', label: 'Flattening TNT', solid: true, transparent: false, translucent: false, group: 'basics', hardness: 0.5,
		lightLevel: 0, lightFilter: 15, liquid: 'none', tnt: { radius: 6, fuse: 3, shape: 'flatten' },
		textures: { kind: 'top-bottom-side', top: 'flatten_tnt_top', bottom: 'flatten_tnt_bottom', side: 'flatten_tnt_side' } },
	{ id: 1008, name: 'lake_tnt', label: 'Lake TNT', solid: true, transparent: false, translucent: false, group: 'basics', hardness: 0.5,
		lightLevel: 0, lightFilter: 15, liquid: 'none', tnt: { radius: 4, fuse: 3, shape: 'lake' },
		textures: { kind: 'top-bottom-side', top: 'lake_tnt_top', bottom: 'lake_tnt_bottom', side: 'lake_tnt_side' } },
];
