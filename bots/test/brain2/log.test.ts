import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrainLog, logFileWriter, parseLog, rotateLogs } from '../../src/brain2/log.js';

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

	// Red if one session's file grows without bound (a night is ~11 MB an hour), if a continuation file has no meta
	// line (it can't be read on its own), if a line is lost or duplicated across the cut, or if rolling doesn't
	// rotate (the directory would keep every part).
	it('a session continues in <bot>-<stamp>-<n>.jsonl past the byte cap, each with a meta line, and rotation keeps 20', () => {
		const dir = mkdtempSync(join(tmpdir(), 'b2cap-'));
		for (let i = 0; i < 25; i++) {
			const f = join(dir, `Old-${i}.jsonl`);
			writeFileSync(f, '');
			utimesSync(f, i, i);
		}
		const cap = 300;
		const w = logFileWriter({ dir, base: 'Pip-stamp', capBytes: cap });
		expect(w.path).toBe(join(dir, 'Pip-stamp.jsonl'));
		const meta = { k: 'meta', v: 1, t: 5, bot: 'Pip', world: 'w', personality: 'pip', seed: 42, wallStart: 9 };
		w.write(JSON.stringify(meta));
		const sent: string[] = [];
		for (let i = 0; i < 30; i++) {
			const l = JSON.stringify({ k: 'event', t: 10 + i, kind: 'tick', data: { i } });
			sent.push(l);
			w.write(l);
		}
		const mine = readdirSync(dir).filter((f) => f.startsWith('Pip-stamp'));
		expect(mine.length).toBeGreaterThan(3);
		expect(w.path).toBe(join(dir, `Pip-stamp-${mine.length}.jsonl`));
		const got: string[] = [];
		for (let n = 1; n <= mine.length; n++) {
			const f = join(dir, n === 1 ? 'Pip-stamp.jsonl' : `Pip-stamp-${n}.jsonl`);
			expect(statSync(f).size).toBeLessThanOrEqual(cap);
			const lines = parseLog(readFileSync(f, 'utf8'));
			expect(lines[0]).toMatchObject({ ...meta, ...(n > 1 ? { part: n, prev: n === 2 ? 'Pip-stamp.jsonl' : `Pip-stamp-${n - 1}.jsonl` } : {}) });
			got.push(...readFileSync(f, 'utf8').trim().split('\n').slice(1));
		}
		expect(got).toEqual(sent);
		// Rotation ran on the roll: the 25 old files are down to what fits in the newest 20 with this session's parts.
		expect(readdirSync(dir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(20);
		expect(readdirSync(dir)).toContain(`Pip-stamp-${mine.length}.jsonl`);
	});
});
