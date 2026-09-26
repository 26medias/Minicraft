// src/data/texture-credits.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { creditsText } from './texture-credits';
import { TEXTURE_SOURCES } from './texture-sources.data';
import { PACKS } from './texture-sources';

describe('texture credits (spec §4.4)', () => {
	const text = creditsText(TEXTURE_SOURCES);
	it('names every pack: authors, URL, pinned commit, licence URI', () => {
		const used = new Set(Object.values(TEXTURE_SOURCES).flatMap((r) => ('pack' in r ? [r.pack] : [])));
		for (const [id, p] of Object.entries(PACKS)) {
			if (!used.has(id as never)) continue;
			expect(text).toContain(p.title);
			expect(text).toContain(p.authors); expect(text).toContain(p.url); expect(text).toContain(p.commit); expect(text).toContain(p.licenceUri);
		}
		expect(text).toContain('Nova Wostra');
		expect(text).toContain('https://creativecommons.org/licenses/by-sa/3.0/');
	});
	it('says the tiles were modified, and how, with the list of derived/overlay rows', () => {
		expect(text).toMatch(/modified/i);
		for (const w of ['frame 0', 'alpha', 'tinted', 'composited']) expect(text).toContain(w);
		for (const [n, r] of Object.entries(TEXTURE_SOURCES)) if ('derive' in r || 'over' in r) expect(text, n).toContain(n);
	});
	it('carries the warranty disclaimer and the share-alike scope note', () => {
		expect(text).toMatch(/without warrant/i);
		expect(text).toMatch(/does not extend to the game code/i);
	});
	it('the committed CREDITS.md and public/CREDITS.txt are the current text', () => {
		expect(readFileSync('CREDITS.md', 'utf8')).toBe(text);
		expect(readFileSync('public/CREDITS.txt', 'utf8')).toBe(text);
	});
});
