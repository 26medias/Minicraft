import { CHEATS, type Cheat } from '../data/cheats.data';

/**
 * Cheat codes (spec §4, §7). Pure. Matching folds Unicode (NFKD, combining marks dropped),
 * lower-cases, then keeps only a–z and 0–9: case, punctuation and every space are ignored.
 */
export function normalizeCode(s: string): string {
	return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** A row's normalised code and aliases. */
export function cheatKeys(c: Cheat): string[] {
	return [c.code, ...c.also].map(normalizeCode);
}

/** The cheat whose normalised code or alias equals the normalised text, or null. Blank → null. */
export function matchCheat(text: string, cheats: readonly Cheat[] = CHEATS): Cheat | null {
	const k = normalizeCode(text);
	if (k === '') return null;
	return cheats.find((c) => cheatKeys(c).includes(k)) ?? null;
}
