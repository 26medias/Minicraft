import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrainLog, parseLog, rotateLogs } from '../../src/brain2/log.js';

describe('brain2 log (spec §8)', () => {
	// Red if a deletion (value undefined) round-trips as "no change": replay would keep deleted owned cells.
	it('round-trips changes including deletions', () => {
		const out: string[] = [];
		const log = new BrainLog((l) => out.push(l));
		log.changes([
			{ id: 1, path: 'inventory.stone', old: undefined, new: 3, cause: { kind: 'behaviour', by: 'mine' }, t: 5 },
			{ id: 2, path: 'owned.1,2,3', old: 1, new: undefined, cause: { kind: 'perception', by: 'own' }, t: 6 },
		]);
		const lines = parseLog(out.join('\n'));
		expect(lines[0]).toMatchObject({ k: 'change', path: 'inventory.stone', new: 3 });
		expect(lines[1]).toMatchObject({ k: 'change', path: 'owned.1,2,3', deleted: true });
	});
	it('rejects an unknown line kind with its line number', () => {
		expect(() => parseLog('{"k":"meta","v":1,"t":0,"bot":"P","world":"w","personality":"pip","seed":1,"wallStart":0}\n{"k":"bogus"}')).toThrow(/line 2/);
	});
	it('keeps the newest 20 logs', () => {
		const dir = mkdtempSync(join(tmpdir(), 'b2log-'));
		for (let i = 0; i < 23; i++) {
			const f = join(dir, `Pip-${i}.jsonl`);
			writeFileSync(f, '');
			utimesSync(f, i, i);
		}
		const gone = rotateLogs(dir);
		expect(gone.sort()).toEqual(['Pip-0.jsonl', 'Pip-1.jsonl', 'Pip-2.jsonl']);
		expect(readdirSync(dir)).toHaveLength(20);
	});
});
