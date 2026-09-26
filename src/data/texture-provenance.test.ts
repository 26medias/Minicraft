// src/data/texture-provenance.test.ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { TEXTURE_SOURCES } from './texture-sources.data';
import { requiredTextureNames } from './texture-sources';
import { readTile } from './texture-test-util';
import mojang from './mojang-tile-hashes.json';

describe('texture provenance (spec §6)', () => {
	const files = readdirSync('src/assets/blocks').filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)).sort();
	it('the PNG files are exactly the source rows: no stray file, none missing', () => {
		// Review Focus 1 + stray Mojang PNGs: a leftover or re-added file goes red here.
		expect(files).toEqual(Object.keys(TEXTURE_SOURCES).sort());
		expect(files).toEqual(requiredTextureNames());
	});
	it('every PNG matches its SOURCES.json sha256', () => {
		const sources = JSON.parse(readFileSync('src/assets/blocks/SOURCES.json', 'utf8')) as Record<string, { sha256: string }>;
		for (const n of files) {
			const sha = createHash('sha256').update(readFileSync(`src/assets/blocks/${n}.png`)).digest('hex');
			expect(sha, n).toBe(sources[n]?.sha256);
		}
	});
	it('no shipped tile decodes to a Mojang tile', async () => {
		const set = new Set(mojang as string[]);
		for (const n of files) expect(set.has(createHash('sha256').update(await readTile(n)).digest('hex')), n).toBe(false);
	});
});
