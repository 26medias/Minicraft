// src/data/texture-alpha.test.ts
import { describe, it, expect } from 'vitest';
import { BLOCKS } from './blocks.data';
import { classifyAlpha, textureNames } from './catalog-rules';
import { DERIVED_TEXTURES } from './atlas-derive';
import { CRACK_STAGES } from './texture-sources';
import { readTile } from './texture-test-util';

const alphas = (t: Uint8Array) => Array.from({ length: t.length / 4 }, (_, i) => t[i * 4 + 3]);

describe('texture alpha agrees with the catalog flags (spec §5.1)', () => {
	it('every non-liquid block: classifyAlpha over its faces matches transparent/translucent', async () => {
		for (const b of BLOCKS) {
			if (b.retired || !b.textures || b.liquid !== 'none') continue;
			const faces = textureNames(b.textures).map((t) => DERIVED_TEXTURES[t]?.source ?? t);
			let transparent = false, translucent = false;
			for (const f of faces) { const c = classifyAlpha(alphas(await readTile(f))); transparent ||= c.transparent; translucent ||= c.translucent; }
			expect({ name: b.name, transparent, translucent }).toEqual({ name: b.name, transparent: b.transparent, translucent: b.translucent });
		}
	});
	it('water keeps partial alpha; lava is opaque; crack stages are 0/255', async () => {
		const w = alphas(await readTile('water_still'));
		expect(w.some((a) => a > 0 && a < 255)).toBe(true);
		expect(alphas(await readTile('lava_still')).every((a) => a === 255)).toBe(true);
		for (const s of CRACK_STAGES) expect(alphas(await readTile(s)).every((a) => a === 0 || a === 255), s).toBe(true);
	});
});
