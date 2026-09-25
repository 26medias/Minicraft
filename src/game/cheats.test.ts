import { describe, it, expect } from 'vitest';
import { matchCheat, normalizeCode } from './cheats';

const id = (text: string) => matchCheat(text)?.id ?? null;

describe('normalizeCode / matchCheat (spec §4)', () => {
	it('ignores case, punctuation and every space (catches a case-sensitive rule, kept punctuation, or only collapsed spaces)', () => {
		for (const s of ['mole power', 'MOLE POWER!!', '  Mole   Power ', 'mole-power', 'molepower']) expect(id(s), s).toBe('mole_power');
	});
	it('matches the aliases and folds accents and fullwidth letters (catches aliases ignored, or no NFKD fold)', () => {
		for (const s of ["I'm so rich!", 'i m so rich', 'I am so rích']) expect(id(s), s).toBe('so_rich');
		expect(id("I'm Mole Man")).toBe('mole_man');
		expect(id('ＪＵＭＰ')).toBe('jump');
	});
	it('is a whole-string match, and blank text matches nothing (catches a substring or prefix rule)', () => {
		for (const s of ['mole powers', 'mole', '', '   ', '!!!', 'diamond', 'tnt', 'big boom please']) expect(id(s), s).toBe(null);
	});
	it('normalizeCode keeps only a-z and 0-9', () => {
		expect(normalizeCode('Tunnel this!')).toBe('tunnelthis');
		expect(normalizeCode('Ünder 9')).toBe('under9');
	});
});
