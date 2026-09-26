import type { BlockDef, BlockSound } from '../data/blocks.base.data';

/**
 * What a block sounds like (sound spec §2): the row's own `sound` when it has one, else the first
 * rule whose token appears in its name (split on '_'), else stone. Order matters: bricks win
 * over mud, lantern rules see sea_lantern first.
 */
export const SOUND_RULES: [BlockSound, string[]][] = [
	['stone', ['bricks', 'sandstone']],
	['leaves', ['leaves']],
	['glass', ['glass', 'ice', 'amethyst', 'froglight']],
	['glass', ['sea_lantern']],
	['sand', ['powder', 'gravel', 'sand', 'snow']],
	['wood', ['log', 'wood', 'planks', 'stem', 'hyphae', 'bamboo', 'bookshelf', 'barrel', 'table', 'loom', 'jukebox', 'note', 'beehive', 'bee', 'pumpkin', 'melon', 'lantern', 'target', 'creaking', 'chest']],
	['dirt', ['dirt', 'grass', 'podzol', 'mycelium', 'mud', 'clay', 'moss', 'wool', 'hay', 'sponge', 'nylium', 'wart', 'sculk', 'kelp', 'shroomlight', 'roots', 'slime']],
];

export function soundByName(name: string): BlockSound {
	const tokens = name.split('_');
	for (const [sound, keys] of SOUND_RULES) {
		for (const k of keys) {
			if (k.includes('_') ? name.includes(k) : tokens.includes(k)) return sound;
		}
	}
	return 'stone';
}

const cache = new Map<number, BlockSound>();
export function blockSound(def: BlockDef): BlockSound {
	let s = cache.get(def.id);
	if (!s) {
		s = def.sound ?? soundByName(def.name);
		cache.set(def.id, s);
	}
	return s;
}
