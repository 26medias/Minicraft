/** Types and helpers for texture-sources.data.ts (texture replacement spec §4.1, §5.1). Pure. */
import type { AlphaMode } from './texture-import';
import { BLOCKS, type BlockDef } from './blocks.data';
import { textureNames } from './catalog-rules';
import { DERIVED_TEXTURES } from './atlas-derive';

export type Pack = 'ppce' | 'bauniclonia' | 'refi' | 'mineclonia';
export type Rgb = [number, number, number];
export type TextureSource =
	| { pack: Pack; file: string; alpha?: 'keep' }
	| { over: string; pack: Pack; file: string; overlayAlpha?: number }
	| { derive: 'tint'; pack: Pack; file: string; tint: Rgb; targetLum?: number }
	| { same: string }
	| { flat: Rgb; alpha: number }; // one colour, no texture (glass; user decision 2026-09-26). Original, not from a pack.

export const PACKS: Record<Pack, { title: string; repo: string; commit: string; licence: string; licenceUri: string; authors: string; url: string }> = {
	ppce: {
		title: 'Pixel Perfection Community Edition',
		repo: 'https://github.com/Athemis/PixelPerfectionCE', url: 'https://github.com/Athemis/PixelPerfectionCE',
		commit: '28e38cab7c1f03f86364ef704f705bebcc13cb3d', licence: 'CC BY-SA 4.0',
		licenceUri: 'https://creativecommons.org/licenses/by-sa/4.0/',
		authors: 'Hugh "XSSheep" Rutland and the Pixel Perfection CE contributors (StonePendant, freejusticehere, Stingraych, Nova_Wostra, lazerl0rd, Athemis and others)',
	},
	refi: {
		title: 'REFI Textures',
		repo: 'https://github.com/MysticTempest/REFI_Textures', url: 'https://content.luanti.org/packages/MysticTempest/refi_textures/',
		commit: '33f1f719930d1d202beaa5fa6251c26d3a711149', licence: 'CC BY-SA 4.0',
		licenceUri: 'https://creativecommons.org/licenses/by-sa/4.0/', authors: 'MysticTempest',
	},
	bauniclonia: {
		title: 'Bauniclonia',
		repo: 'https://codeberg.org/mirtilo/Bauniclonia.git', url: 'https://content.luanti.org/packages/Mirtilo/bauniclonia/',
		commit: '77318ecabc046efb2caa9237a9efb45c7b401523', licence: 'CC BY-SA 4.0',
		licenceUri: 'https://creativecommons.org/licenses/by-sa/4.0/', authors: 'Mirtilo',
	},
	mineclonia: {
		title: 'Mineclonia (textures)',
		repo: 'https://codeberg.org/mineclonia/mineclonia', url: 'https://codeberg.org/mineclonia/mineclonia',
		commit: 'c1898e3951ded8b3445f4396cc7d7b17844da357',
		licence: 'CC BY-SA 4.0 (textures based on Pixel Perfection); other files CC BY-SA 3.0 (https://creativecommons.org/licenses/by-sa/3.0/), adapted under 4.0',
		licenceUri: 'https://creativecommons.org/licenses/by-sa/4.0/',
		authors: 'the Mineclonia contributors; Pixel Perfection by XSSheep; Pixel Perfection Legacy by Nova Wostra',
	},
};

export const CRACK_STAGES = Array.from({ length: 10 }, (_, i) => `destroy_stage_${i}`);

/** Pixel Perfection CE files that trace Mojang's (spec §3, trace score ≥ 0.81). Never a row's pack+file. */
export const TRACED_SOURCES: Array<{ pack: Pack; file: string }> = [
	'green_glazed_terracotta', 'light_blue_glazed_terracotta', 'red_glazed_terracotta', 'lime_glazed_terracotta',
	'pink_glazed_terracotta', 'purple_glazed_terracotta', 'yellow_glazed_terracotta',
	'loom_side', 'loom_bottom', 'loom_top', 'loom_front', 'smithing_table_front', 'smithing_table_side', 'smithing_table_bottom',
	'bee_nest_top', 'bee_nest_front', 'bee_nest_side', 'bee_nest_bottom', 'beehive_front', 'beehive_side', 'beehive_end',
	'lodestone_side', 'tnt_bottom',
].map((n) => ({ pack: 'ppce' as const, file: `assets/minecraft/textures/block/${n}.png` }));

/** Grey masks the atlas tints (spec §5.2). build-atlas's TEXTURE_TINTS keys must equal this list. */
export const TEXTURE_TINTED = ['grass_block_top', 'oak_leaves', 'jungle_leaves', 'mangrove_leaves', 'birch_leaves'];
export const HUE_EXEMPT = ['pale_oak_leaves', 'cherry_leaves'];
export const UNTINTED_GREY = ['pale_oak_leaves'];

export function requiredTextureNames(): string[] {
	const names = new Set<string>(CRACK_STAGES);
	for (const b of BLOCKS) {
		if (b.retired || !b.textures) continue;
		for (const t of textureNames(b.textures)) if (!DERIVED_TEXTURES[t]) names.add(t);
	}
	return [...names].sort();
}

export function alphaModeFor(name: string, blocks: readonly BlockDef[] = BLOCKS): AlphaMode {
	if (CRACK_STAGES.includes(name)) return 'keep';
	const modes = new Set<AlphaMode>();
	for (const b of blocks) {
		if (b.retired || !b.textures || !textureNames(b.textures).includes(name)) continue;
		modes.add(b.liquid !== 'none' ? 'keep' : !b.transparent ? 'opaque' : b.translucent ? 'translucent' : 'cutout');
	}
	if (modes.size > 1) throw new Error(`Texture ${name} is used by blocks with different alpha flags: ${[...modes].join(', ')}`);
	const [m] = modes;
	if (!m) throw new Error(`Texture ${name} is used by no block`);
	return m;
}

export function resolveOrder(rows: Record<string, TextureSource>): string[] {
	const order: string[] = [], state = new Map<string, 'visiting' | 'done'>();
	const visit = (n: string, from?: string) => {
		const row = rows[n];
		if (!row) throw new Error(`Row ${from ?? '?'} refers to unknown row ${n}`);
		if (state.get(n) === 'done') return;
		if (state.get(n) === 'visiting') throw new Error(`Cycle through ${n}`);
		state.set(n, 'visiting');
		const dep = 'over' in row ? row.over : 'same' in row ? row.same : null;
		if (dep) visit(dep, n);
		state.set(n, 'done');
		order.push(n);
	};
	for (const n of Object.keys(rows).sort()) visit(n);
	return order;
}
