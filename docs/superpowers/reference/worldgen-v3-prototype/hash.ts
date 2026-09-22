// §10 bootstrap helper (reference dir on purpose: outside tsconfig include roots). Prints FNV-1a-32 over Uint16 elements
// of chunks (0,0),(16,16),(31,31),(5,27) at seed 12345 for the ENGINE and for the reference PROTOTYPE (ids remapped to engine ids).
// Run: ./node_modules/.bin/tsx docs/superpowers/reference/worldgen-v3-prototype/hash.ts
import { Chunk } from '../../../../src/engine/world/chunk';
import { generateChunk } from '../../../../src/engine/world/generation';
import { BLOCK_BY_NAME } from '../../../../src/data/blocks.data';
import { generateChunkV3 as protoGen, NAME } from './proto';

function hashBytes(bytes: ArrayLike<number>): number { let h = 2166136261 >>> 0; for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 16777619) >>> 0; } return h; }

// Prototype short names → catalog names (identity for everything not listed).
const RENAME: Record<string, string> = {
	grass: 'grass_block', snow: 'snow_block', coarse: 'coarse_dirt', moss: 'moss_block', dripstone: 'dripstone_block',
	amethyst: 'amethyst_block', budding: 'budding_amethyst', cobble: 'cobblestone', mossy_cobble: 'mossy_cobblestone',
	o_terra: 'orange_terracotta', y_terra: 'yellow_terracotta', w_terra: 'white_terracotta', r_terra: 'red_terracotta', br_terra: 'brown_terracotta', lg_terra: 'light_gray_terracotta',
	coal: 'coal_ore', iron: 'iron_ore', copper: 'copper_ore', gold: 'gold_ore', lapis: 'lapis_ore', redstone: 'redstone_ore', diamond: 'diamond_ore', emerald: 'emerald_ore',
	d_coal: 'deepslate_coal_ore', d_iron: 'deepslate_iron_ore', d_copper: 'deepslate_copper_ore', d_gold: 'deepslate_gold_ore', d_lapis: 'deepslate_lapis_ore', d_redstone: 'deepslate_redstone_ore', d_diamond: 'deepslate_diamond_ore', d_emerald: 'deepslate_emerald_ore',
};
const REMAP = new Uint16Array(256);
for (const [idStr, short] of Object.entries(NAME)) { const name = RENAME[short] ?? short; const def = BLOCK_BY_NAME[name]; if (!def) throw new Error(`prototype block ${short} → ${name} not in catalog`); REMAP[Number(idStr)] = def.id; }
REMAP[0] = 0;

const chunks: [number, number][] = [[0, 0], [16, 16], [31, 31], [5, 27]];
const eng = chunks.map(([cx, cz]) => { const c = new Chunk(cx, cz, 256); generateChunk(c, 12345, 3); return hashBytes(c.blocks); });
const protoBlocks = chunks.map(([cx, cz]) => { const b = new Uint16Array(16 * 256 * 16); protoGen(b, 12345, cx, cz); for (let i = 0; i < b.length; i++) b[i] = REMAP[b[i]]; return b; });
const proto = protoBlocks.map(hashBytes);
console.log('engine   ', JSON.stringify(eng)); console.log('prototype', JSON.stringify(proto));
if (eng.every((v, i) => v === proto[i])) console.log('AGREE');
else {
	console.log('DISAGREE — the engine port is presumed wrong (spec §10). First differing voxel per chunk:');
	chunks.forEach(([cx, cz], k) => { const c = new Chunk(cx, cz, 256); generateChunk(c, 12345, 3); const b = protoBlocks[k]; for (let i = 0; i < b.length; i++) if (c.blocks[i] !== b[i]) { console.log(`  chunk ${cx},${cz}: index ${i} (x ${i & 15}, y ${i >> 8}, z ${(i >> 4) & 15}) engine ${c.blocks[i]} proto ${b[i]}`); break; } });
	process.exit(1);
}
