// src/data/texture-derived.test.ts
import { describe, it, expect } from 'vitest';
import { TEXTURE_SOURCES } from './texture-sources.data';
import { clipFraction, lumStd } from './texture-import';
import { DERIVED_TEXTURES, greyTint } from './atlas-derive';
import { readTile } from './texture-test-util';

describe('derived tiles keep their texture (spec §5.4, §5.6)', () => {
	it('every build-atlas DERIVED_TEXTURES tile: luminance std > 8, ≤ 50% clipped', async () => {
		// Catches a gain that washes a tile out (launch_pad clipped 52% at gain 2.5) or flattens it (froglights at constant gain).
		for (const [name, d] of Object.entries(DERIVED_TEXTURES)) {
			const out = greyTint(await readTile(d.source), d.tint, d.targetLum);
			expect(lumStd(out), `${name} std`).toBeGreaterThan(8);
			expect(clipFraction(out), `${name} clip`).toBeLessThanOrEqual(0.5);
		}
	});
	it('the instrument can go red: the creaking heart at targetLum 70 is too flat', async () => {
		const r = TEXTURE_SOURCES.creaking_heart_awake;
		if (!('derive' in r)) throw new Error('creaking_heart_awake must be a derive row');
		const flat = greyTint(await readTile('pale_oak_log'), r.tint, 70);
		expect(lumStd(flat)).toBeLessThan(8);
	});
	it('every derive/over row: luminance std > 8 and ≤ 50% clipped', async () => {
		// The build-atlas DERIVED_TEXTURES are checked in atlas-derive.test.ts; these are the importer's baked rows
		// (plain TNT, froglights, creaking heart, copper, roots, suspicious blocks).
		for (const [n, r] of Object.entries(TEXTURE_SOURCES)) {
			if (!('derive' in r) && !('over' in r)) continue;
			const t = await readTile(n);
			expect(lumStd(t), `${n} std`).toBeGreaterThan(8);
			expect(clipFraction(t), `${n} clip`).toBeLessThanOrEqual(0.5);
		}
	});
});
