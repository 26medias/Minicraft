// scripts/build-atlas-tints.ts
/** Grey masks tinted at build time; no biomes, so one colour each (texture replacement spec §5.2). Keys = TEXTURE_TINTED. */
export const TEXTURE_TINTS: Record<string, [number, number, number]> = {
	grass_block_top: [0x79, 0xc0, 0x5a], // plains-biome grass green
	oak_leaves: [0x77, 0xab, 0x2f],
	jungle_leaves: [0x77, 0xab, 0x2f],
	mangrove_leaves: [0x77, 0xab, 0x2f],
	birch_leaves: [0x80, 0xa7, 0x55],
};
