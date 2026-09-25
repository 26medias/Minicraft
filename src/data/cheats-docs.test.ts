import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CHEATS } from './cheats.data';

/** The one table in docs/cheats.md: code | also | reward (spec §11 test 2). */
function tableRows(doc: string): string[][] {
	const lines = doc.split('\n').filter((l) => l.trim().startsWith('|'));
	return lines.map((l) => l.trim().slice(1, -1).split('|').map((c) => c.trim()));
}
const key = (r: { code: string; also: string[]; message: string }) => JSON.stringify([r.code, r.also, r.message]);

describe('docs/cheats.md stays in step with CHEATS, both ways (J4)', () => {
	it('has one code | also | reward table whose rows equal the data rows (catches an undocumented code, a stale doc row, a changed alias or reward text)', () => {
		const rows = tableRows(readFileSync('docs/cheats.md', 'utf8'));
		expect(rows[0]).toEqual(['code', 'also', 'reward']);
		expect(rows[1].every((c) => /^:?-+:?$/.test(c))).toBe(true);
		const doc = rows.slice(2).map(([code, also, reward]) => ({ code, also: also === '' ? [] : also.split(',').map((s) => s.trim()), message: reward }));
		const data = CHEATS.map((c) => ({ code: c.code, also: [...c.also], message: c.message }));
		expect(doc.map(key).sort()).toEqual(data.map(key).sort());
	});
});
