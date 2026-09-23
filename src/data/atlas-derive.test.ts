import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { existsSync, readFileSync } from 'node:fs';
import {
	DERIVED_TEXTURES, ICON_SIZE, PICKAXE_HEAD, PICKAXE_TIERS, averageRgb, greyTint, pickaxeIcon, pickaxeIconName,
	type Rgb,
} from './atlas-derive';
import { BLOCKS } from './blocks.data';
import { textureNames } from './catalog-rules';

async function tile(name: string): Promise<Uint8Array> {
	const { data } = await sharp(`src/assets/blocks/${name}.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	return new Uint8Array(data);
}
/** Hue in degrees, 0..360. */
function hue([r, g, b]: Rgb): number {
	const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
	if (d === 0) return 0;
	const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return (h * 60 + 360) % 360;
}
const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

describe('derived TNT textures (spec §6)', () => {
	it('every block texture that is not a file is a derived texture with an existing source', () => {
		// Catches a Big/Mega texture name with no DERIVED_TEXTURES row: build-atlas would try to
		// read big_tnt_side.png and fail, and the bundle would fail with "Atlas missing tile".
		for (const b of BLOCKS) {
			if (!b.textures) continue;
			for (const t of textureNames(b.textures)) {
				if (existsSync(`src/assets/blocks/${t}.png`)) continue;
				expect(DERIVED_TEXTURES[t], t).toBeDefined();
				expect(existsSync(`src/assets/blocks/${DERIVED_TEXTURES[t].source}.png`)).toBe(true);
			}
		}
	});

	it('greyscale-then-tint: the output hue comes from the tint, not the source', () => {
		// Catches a plain multiply of the source (applyTint): red TNT × orange stays red-dominant
		// with blue > 0 in every pixel; after greyscale, a zero-blue tint gives zero blue.
		const red = new Uint8Array([200, 40, 40, 255, 0, 0, 0, 0]);
		const out = greyTint(red, [255, 128, 0]);
		expect(out[2]).toBe(0);
		expect(out[0]).toBeGreaterThan(out[1]);
		expect(out[1]).toBeGreaterThan(0);
		expect(out.slice(4)).toEqual(new Uint8Array([0, 0, 0, 0])); // transparent pixel keeps alpha 0
		// Equal luminance in → equal colour out, whatever the source hue.
		const l = (0.299 * 200 + 0.587 * 40 + 0.114 * 40);
		const grey = Math.round(l);
		const g = greyTint(new Uint8Array([grey, grey, grey, 255]), [255, 128, 0]);
		expect(Math.abs(g[0] - out[0])).toBeLessThanOrEqual(1);
	});

	it('Big is orange, Mega is purple, both far from plain TNT and from each other (per face)', async () => {
		// Catches a tint that is not applied (Big == plain), the same tint for both tiers, and a
		// tint so dark every face averages to near-black (all three would then sit close together).
		for (const face of ['top', 'bottom', 'side']) {
			const plain = averageRgb(await tile(`tnt_${face}`));
			const bigDef = DERIVED_TEXTURES[`big_tnt_${face}`];
			const megaDef = DERIVED_TEXTURES[`mega_tnt_${face}`];
			const big = averageRgb(greyTint(await tile(bigDef.source), bigDef.tint));
			const mega = averageRgb(greyTint(await tile(megaDef.source), megaDef.tint));
			// orange: r > g > b; purple: b > r > g
			expect(big[0]).toBeGreaterThan(big[1]);
			expect(big[1]).toBeGreaterThan(big[2]);
			expect(mega[2]).toBeGreaterThan(mega[0]);
			expect(mega[0]).toBeGreaterThan(mega[1]);
			expect(hueGap(hue(big), hue(plain))).toBeGreaterThanOrEqual(20);
			expect(hueGap(hue(mega), hue(plain))).toBeGreaterThanOrEqual(60);
			expect(hueGap(hue(big), hue(mega))).toBeGreaterThanOrEqual(90);
			// bright enough to read in a dim cave (mean channel sum)
			expect(big[0] + big[1] + big[2]).toBeGreaterThan(200);
			expect(mega[0] + mega[1] + mega[2]).toBeGreaterThan(200);
		}
	});
});

describe('blast toy tints (toys spec §2)', () => {
	const TOYS = ['tunnel_tnt', 'flatten_tnt', 'lake_tnt', 'fireworks'] as const;
	const avg = async (name: string): Promise<Rgb> => {
		const d = DERIVED_TEXTURES[name];
		expect(d, name).toBeDefined();
		return averageRgb(greyTint(await tile(d.source), d.tint));
	};

	it('every toy face is derived from the matching tnt_* face (catches a toy tinted from the wrong source or a missing face row)', () => {
		for (const toy of [...TOYS, 'block_bomb']) for (const face of ['top', 'bottom', 'side'])
			expect(DERIVED_TEXTURES[`${toy}_${face}`]?.source, `${toy}_${face}`).toBe(`tnt_${face}`);
	});

	it('Tunnel, Flatten, Lake and Fireworks are ≥ 20° of hue from each other and from plain, Big and Mega TNT, per face (catches two toys sharing a tint, or a toy the kid cannot tell from Big or Mega)', async () => {
		for (const face of ['top', 'bottom', 'side']) {
			const named: Array<[string, number]> = [['tnt', hue(averageRgb(await tile(`tnt_${face}`)))]];
			for (const n of ['big_tnt', 'mega_tnt', ...TOYS]) named.push([n, hue(await avg(`${n}_${face}`))]);
			for (let i = 0; i < named.length; i++) for (let j = i + 1; j < named.length; j++)
				expect(hueGap(named[i][1], named[j][1]), `${face}: ${named[i][0]} vs ${named[j][0]}`).toBeGreaterThanOrEqual(20);
			for (const n of TOYS) {
				const c = await avg(`${n}_${face}`);
				expect(c[0] + c[1] + c[2], `${n}_${face} bright enough`).toBeGreaterThan(200);
			}
		}
	});

	it('Block Bomb is the white one: no hue at all, and brighter than every tinted toy (catches a Block Bomb left red like plain TNT)', async () => {
		// White has no hue, so the ≥ 20° rule cannot apply to it; it is told apart by being achromatic instead.
		for (const face of ['top', 'bottom', 'side']) {
			const w = await avg(`block_bomb_${face}`);
			expect(Math.max(...w) - Math.min(...w), face).toBeLessThan(2);
			const plain = averageRgb(await tile(`tnt_${face}`));
			expect(Math.max(...plain) - Math.min(...plain), `plain tnt_${face} is chromatic`).toBeGreaterThan(20);
			for (const n of TOYS) {
				const c = await avg(`${n}_${face}`);
				expect(w[0] + w[1] + w[2], `${face}: block_bomb vs ${n}`).toBeGreaterThan(c[0] + c[1] + c[2]);
			}
		}
	});
});
describe('pickaxe icons (spec §5)', () => {
	it('one 16×16 RGBA icon per tier 0..7, transparent corners, named pickaxe_<tier>', () => {
		// Catches a missing tier (the HUD would show no icon for it) and an opaque background.
		expect([...PICKAXE_TIERS]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		for (const t of PICKAXE_TIERS) {
			const px = pickaxeIcon(t);
			expect(px.length).toBe(ICON_SIZE * ICON_SIZE * 4);
			expect(px[3]).toBe(0);
			expect(px[(ICON_SIZE * ICON_SIZE - 1) * 4 + 3]).toBe(0);
			expect(pickaxeIconName(t)).toBe(`pickaxe_${t}`);
		}
	});

	it('each pickaxe tier shows its own head colour, and every icon differs', () => {
		// Catches every tier drawn with the same colour (the kid could not tell Iron from Stone).
		const keys = new Set<string>();
		for (const t of PICKAXE_TIERS) {
			const px = pickaxeIcon(t);
			keys.add(Buffer.from(px).toString('base64'));
			if (t === 0) continue;
			const head = PICKAXE_HEAD[t];
			let found = 0;
			for (let i = 0; i < px.length; i += 4) if (px[i] === head[0] && px[i + 1] === head[1] && px[i + 2] === head[2]) found++;
			expect(found).toBeGreaterThanOrEqual(15);
		}
		expect(keys.size).toBe(8);
	});
});

describe('built atlas (npm run build-atlas)', () => {
	it('holds every block face texture and every pickaxe icon', () => {
		// Catches build-atlas collecting names from BLOCKS only (no icons: blank HUD pickaxe) and a
		// stale public/atlas.json from before the TNT tiers (the bundle would throw "Atlas missing tile").
		if (!existsSync('public/atlas.json')) throw new Error('public/atlas.json missing: run npm run build-atlas (it is gitignored)');
		const tiles = (JSON.parse(readFileSync('public/atlas.json', 'utf8')) as { tiles: Record<string, unknown> }).tiles;
		for (const b of BLOCKS) if (b.textures) for (const t of textureNames(b.textures)) expect(tiles[t], t).toBeDefined();
		for (const t of PICKAXE_TIERS) expect(tiles[pickaxeIconName(t)], pickaxeIconName(t)).toBeDefined();
	});
});

describe('launch pad texture (toys spec §2)', () => {
	it('launch_pad is slime_block turned red; slime_pad keeps the real slime file', async () => {
		// Catches a launch pad with no derived row (build-atlas would look for launch_pad.png and fail),
		// one derived from TNT instead of slime, and a tint too close to slime green to tell apart.
		expect(DERIVED_TEXTURES['launch_pad']?.source).toBe('slime_block');
		expect(DERIVED_TEXTURES['slime_block']).toBeUndefined();
		const slime = averageRgb(await tile('slime_block'));
		const launch = averageRgb(greyTint(await tile('slime_block'), DERIVED_TEXTURES['launch_pad'].tint));
		expect(launch[0]).toBeGreaterThan(launch[1]);
		expect(launch[0]).toBeGreaterThan(launch[2]);
		expect(hueGap(hue(launch), hue(slime))).toBeGreaterThanOrEqual(90);
		expect(launch[0] + launch[1] + launch[2]).toBeGreaterThan(200);
	});
});
