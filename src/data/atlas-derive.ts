/**
 * Build-time texture derivations for scripts/build-atlas.ts (pure: no fs, no sharp,
 * so vitest can check them). Two kinds of tile are not files in src/assets/blocks:
 *   - DERIVED_TEXTURES: a Mojang tile turned to greyscale, then tinted (Big/Mega TNT, spec §6);
 *   - pickaxe icons: original 16×16 pixel art drawn from the templates below (spec §5).
 */

export type Rgb = [number, number, number];

/** Brightens the greyscale before tinting: TNT's mean luminance is ~100, a plain multiply would be muddy. */
export const TINT_GAIN = 1.8;

export const DERIVED_TEXTURES: Record<string, { source: string; tint: Rgb }> = {
	big_tnt_top: { source: 'tnt_top', tint: [0xff, 0x8c, 0x1a] },
	big_tnt_bottom: { source: 'tnt_bottom', tint: [0xff, 0x8c, 0x1a] },
	big_tnt_side: { source: 'tnt_side', tint: [0xff, 0x8c, 0x1a] },
	mega_tnt_top: { source: 'tnt_top', tint: [0xa8, 0x3c, 0xff] },
	mega_tnt_bottom: { source: 'tnt_bottom', tint: [0xa8, 0x3c, 0xff] },
	mega_tnt_side: { source: 'tnt_side', tint: [0xa8, 0x3c, 0xff] },
	// Toys spec §2: the Launch Pad is the Slime Pad's texture turned red.
	launch_pad: { source: 'slime_block', tint: [0xff, 0x38, 0x28] },
	...toyTints(),
};

/** Toys spec §2: each blast toy is TNT, greyed, then tinted. Block Bomb is white (achromatic), the rest ≥ 20° of hue apart. */
function toyTints(): Record<string, { source: string; tint: Rgb }> {
	const tints: Record<string, Rgb> = {
		tunnel_tnt: [0x3c, 0xdc, 0x3c],   // green
		flatten_tnt: [0x28, 0xdc, 0xe6],  // cyan
		lake_tnt: [0x3c, 0x64, 0xff],     // blue
		block_bomb: [0xff, 0xff, 0xff],   // white
		fireworks: [0xff, 0x3c, 0xc8],    // magenta
	};
	const out: Record<string, { source: string; tint: Rgb }> = {};
	for (const [name, tint] of Object.entries(tints)) for (const face of ['top', 'bottom', 'side'])
		out[`${name}_${face}`] = { source: `tnt_${face}`, tint };
	return out;
}

/** RGBA in, RGBA out, same length: luminance (Rec. 601) × gain × tint / 255, clamped; alpha kept. */
export function greyTint(raw: Uint8Array, tint: Rgb, gain = TINT_GAIN): Uint8Array {
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i += 4) {
		const l = (0.299 * raw[i] + 0.587 * raw[i + 1] + 0.114 * raw[i + 2]) * gain;
		out[i] = Math.min(255, Math.round((l * tint[0]) / 255));
		out[i + 1] = Math.min(255, Math.round((l * tint[1]) / 255));
		out[i + 2] = Math.min(255, Math.round((l * tint[2]) / 255));
		out[i + 3] = raw[i + 3];
	}
	return out;
}

/** Mean RGB over pixels with alpha > 0. */
export function averageRgb(raw: Uint8Array): Rgb {
	let r = 0, g = 0, b = 0, n = 0;
	for (let i = 0; i < raw.length; i += 4) {
		if (raw[i + 3] === 0) continue;
		r += raw[i]; g += raw[i + 1]; b += raw[i + 2]; n++;
	}
	return n === 0 ? [0, 0, 0] : [r / n, g / n, b / n];
}

export const ICON_SIZE = 16;
export const PICKAXE_TIERS = [0, 1, 2, 3, 4, 5, 6, 7] as const;

/** Atlas tile name of a tier's HUD/inventory icon. Tier 0 (Hand) is a fist. */
export function pickaxeIconName(tier: number): string {
	return `pickaxe_${tier}`;
}

/** Head colours, tier 1..7: wood, stone, copper, iron, gold, diamond, emerald. */
export const PICKAXE_HEAD: Record<number, Rgb> = {
	1: [0xa8, 0x7a, 0x45],
	2: [0x8a, 0x8a, 0x8a],
	3: [0xd8, 0x74, 0x3c],
	4: [0xe6, 0xe6, 0xe6],
	5: [0xf5, 0xd4, 0x2a],
	6: [0x4e, 0xe6, 0xe0],
	7: [0x2e, 0xd1, 0x5a],
};
const OUTLINE: Rgb = [0x1c, 0x1c, 0x1c];
const HANDLE: Rgb = [0x7a, 0x4e, 0x22];
const SKIN: Rgb = [0xe0, 0xac, 0x7d];

// O outline, h head (tier colour), w handle, s skin, '.' transparent.
const PICKAXE_ART = [
	'................',
	'....OOOOOO......',
	'...OhhhhhhOO....',
	'....OOOOhhhhO...',
	'........OOhhhO..',
	'........OwOOhhO.',
	'.......OwO..OhO.',
	'......OwO...OhO.',
	'.....OwO....OhO.',
	'....OwO......OO.',
	'...OwO..........',
	'..OwO...........',
	'.OwO............',
	'.OO.............',
	'................',
	'................',
];
const FIST_ART = [
	'................',
	'................',
	'................',
	'................',
	'...OOOOOOOO.....',
	'..OsssOsssOO....',
	'..OsssOsssOsO...',
	'..OOOOOOOOOsO...',
	'..OsssssssssO...',
	'..OsssssssssO...',
	'..OsssssssssO...',
	'...OssssssssO...',
	'....OOOOOOOO....',
	'................',
	'................',
	'................',
];

/** 16×16 RGBA icon for a tier (0 = fist, 1..7 = pickaxe with that head colour). */
export function pickaxeIcon(tier: number): Uint8Array {
	const art = tier === 0 ? FIST_ART : PICKAXE_ART;
	const head = PICKAXE_HEAD[tier];
	if (tier !== 0 && !head) throw new Error(`No pickaxe icon for tier ${tier}`);
	const out = new Uint8Array(ICON_SIZE * ICON_SIZE * 4);
	for (let y = 0; y < ICON_SIZE; y++) {
		for (let x = 0; x < ICON_SIZE; x++) {
			const ch = art[y][x];
			const c = ch === 'O' ? OUTLINE : ch === 'h' ? head : ch === 'w' ? HANDLE : ch === 's' ? SKIN : null;
			if (!c) continue;
			const o = (y * ICON_SIZE + x) * 4;
			out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
		}
	}
	return out;
}
