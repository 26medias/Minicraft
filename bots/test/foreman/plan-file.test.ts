import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLAIM_MS, claimLot, createPlan, readPlan, updateLot, type NeighbourhoodPlan } from '../../src/foreman/plan-file.js';
import { gridLots, lampCols, LOT, roadCols } from '../../src/foreman/layout.js';

const BOTS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function plan(n: number): NeighbourhoodPlan {
	return {
		v: 1, id: 'p1', foreman: 'Boss', t: 0, anchor: { x: 0, y: 0, z: 0 }, corner: { x: 0, z: 0 }, cols: n, rows: 1,
		lots: Array.from({ length: n }, (_, i) => ({ id: `lot-${i + 1}`, origin: { x: i * 11, y: 70, z: 0 }, w: 7, d: 7, h: 16, status: 'open' as const })),
		roads: [], lamps: [],
	};
}
const fresh = (n: number) => {
	const path = join(mkdtempSync(join(tmpdir(), 'plan-')), 'plan.json');
	createPlan(path, plan(n));
	return path;
};

describe('foreman plan: claims', () => {
	it('two bots get different lots; a bot asking again gets its own lot back; no lot left → null', () => {
		const path = fresh(2);
		const a = claimLot(path, 'A', 1000)!;
		const b = claimLot(path, 'B', 1001)!;
		expect(a.id).not.toBe(b.id);
		expect(claimLot(path, 'A', 1002)!.id).toBe(a.id);
		expect(claimLot(path, 'C', 1003)).toBeNull();
		expect(readPlan(path)!.lots.map((l) => l.claimedBy)).toEqual(['A', 'B']);
	});

	it('a claim not renewed for 15 min expires; a renewed one does not; the old owner cannot end a lost lot', () => {
		const path = fresh(1);
		const t0 = 1_000_000;
		expect(claimLot(path, 'A', t0)!.id).toBe('lot-1');
		expect(claimLot(path, 'B', t0 + CLAIM_MS)).toBeNull();
		expect(updateLot(path, 'lot-1', 'A', t0 + CLAIM_MS - 1, {})).toBe(true); // renewed
		expect(claimLot(path, 'B', t0 + 2 * CLAIM_MS - 2)).toBeNull();
		expect(claimLot(path, 'B', t0 + 2 * CLAIM_MS + 1)!.id).toBe('lot-1'); // A crashed: expired
		expect(updateLot(path, 'lot-1', 'A', t0 + 2 * CLAIM_MS + 2, { status: 'built' })).toBe(false);
		expect(updateLot(path, 'lot-1', 'B', t0 + 2 * CLAIM_MS + 3, { status: 'built' })).toBe(true);
		expect(readPlan(path)!.lots[0]).toMatchObject({ status: 'built', claimedBy: 'B' });
		expect(claimLot(path, 'C', t0 + 10 * CLAIM_MS)).toBeNull(); // built lots never expire
	});

	it('an existing plan wins over a second one', () => {
		const path = fresh(3);
		const other = { ...plan(5), id: 'p2' };
		expect(createPlan(path, other).id).toBe('p1');
	});

	it('eight processes racing on one plan: every lot claimed exactly once', async () => {
		const n = 300;
		const path = fresh(n);
		const runs = Array.from({ length: 8 }, (_, i) => new Promise<string[]>((res, rej) => {
			const p = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/claim-child.ts', path, `bot${i}`], { cwd: BOTS });
			let out = '';
			let err = '';
			p.stdout.on('data', (d) => (out += d));
			p.stderr.on('data', (d) => (err += d));
			p.on('close', (code) => (code === 0 ? res(JSON.parse(out) as string[]) : rej(new Error(`child ${i}: ${code} ${err}`))));
		}));
		const t0 = Date.now();
		while (Date.now() - t0 < 40_000 && !Array.from({ length: 8 }, (_, i) => existsSync(`${path}.ready-bot${i}`)).every(Boolean)) await new Promise((r) => setTimeout(r, 50));
		writeFileSync(`${path}.go`, '');
		const got = await Promise.all(runs);
		const all = got.flat();
		expect(all.filter((x) => x.startsWith('LOST'))).toEqual([]);
		expect(all.length).toBe(n);
		expect(new Set(all).size).toBe(n);
		expect(got.filter((g) => g.length > 0).length).toBeGreaterThan(1); // they really raced
		const final = JSON.parse(readFileSync(path, 'utf8')) as NeighbourhoodPlan;
		expect(final.lots.every((l) => l.status === 'built')).toBe(true);
	}, 60_000);
});

describe('foreman layout', () => {
	it('roads and lamps never fall on a lot, lamps never on a road; 6–10 lots', () => {
		for (const cols of [3, 4, 5]) {
			const corner = { x: 100, z: 200 };
			const lots = gridLots(corner, cols);
			expect(lots.length).toBe(cols * 2);
			const onLot = (c: { x: number; z: number }) => lots.some((l) => c.x >= l.x && c.x < l.x + LOT && c.z >= l.z && c.z < l.z + LOT);
			const roads = roadCols(corner, cols);
			expect(roads.filter(onLot)).toEqual([]);
			const lamps = lampCols(corner, cols);
			expect(lamps.filter(onLot)).toEqual([]);
			expect(lamps.filter((l) => roads.some((r) => r.x === l.x && r.z === l.z))).toEqual([]);
			// Every lot touches the road grid within 2 columns (a verge between).
			for (const l of lots) expect(roads.some((r) => r.x >= l.x - 2 && r.x < l.x + LOT + 2 && r.z >= l.z - 2 && r.z < l.z + LOT + 2)).toBe(true);
		}
	});
});
