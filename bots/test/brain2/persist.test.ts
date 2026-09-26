import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { BrainSaver, SCHEMA_VERSION, brainFilePath, loadBrainFile, loadedPatch, reconcileRevert } from '../../src/brain2/persist.js';
import { initialState } from '../../src/brain2/store.js';
import { PIP } from '../../src/brain2/data/personalities.data.js';

const META = { worldUuid: 'w-1', bot: 'Pip' };
const pose = { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 };
function tmpPath() {
	const root = mkdtempSync(join(tmpdir(), 'brain2-'));
	return brainFilePath(root, 'local', META.worldUuid, META.bot);
}
function write(path: string, obj: unknown) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof obj === 'string' ? obj : JSON.stringify(obj));
}
const MIN = 60_000;
/** A complete body, so each rejection row fails on its own check, not the shape check (re-gate 2). */
const FULL = { relations: {}, inventory: {}, builds: [], digs: [], owned: {}, explored: [], lastAlive: 0 };

describe('brain file (spec §4.6)', () => {
	it('round-trips relations, inventory, builds, digs, owned, explored', () => {
		const p = tmpPath();
		const st = { ...initialState(PIP, pose), inventory: { stone: 4 }, owned: { '1,2,3': 1 }, explored: { '0,0': true as const } };
		const wall = 1_000_000;
		const s = new BrainSaver(p, META, () => wall);
		s.markDirty();
		s.flush(st);
		const { file } = loadBrainFile(p, META, wall + 1000);
		expect(file?.inventory).toEqual({ stone: 4 });
		expect(file?.explored).toEqual(['0,0']);
		expect(file?.owned).toEqual({ '1,2,3': 1 });
	});
	// Review Focus 3. Red if any of these crash or load: another world's file, garbage, a future schema.
	it.each([
		['another world', { ...FULL, schemaVersion: SCHEMA_VERSION, worldUuid: 'other', bot: 'Pip' }],
		['truncated JSON', '{"schemaVersion": 1, "worl'],
		['future schema', { ...FULL, schemaVersion: SCHEMA_VERSION + 1, worldUuid: 'w-1', bot: 'Pip' }],
		['JSON null', 'null'],
		['right header, missing fields', { schemaVersion: SCHEMA_VERSION, worldUuid: 'w-1', bot: 'Pip' }],
	])('%s → renamed .bad-<ts>, starts fresh', (_n, content) => {
		const p = tmpPath();
		write(p, content);
		const r = loadBrainFile(p, META, 5_000);
		expect(r.file).toBeNull();
		expect(readdirSync(dirname(p)).some((f) => f.startsWith('Pip.json.bad-'))).toBe(true);
	});
	it('a missing file is a fresh start, not an error', () => {
		expect(loadBrainFile(tmpPath(), META, 0)).toEqual({ file: null, note: 'none' });
	});
	// Red if halving ignores lastAlive (a crash-restart would wipe feelings), or if it never halves.
	it('halves relations only when lastAlive is more than 30 min old', () => {
		const rel = { Noah: { axes: { affection: { value: 0.8, band: 'very high' as const, deltas: [] }, cooperation: { value: 0, band: 'neutral' as const, deltas: [] }, respect: { value: 0, band: 'neutral' as const, deltas: [] }, grievance: { value: -0.6, band: 'very low' as const, deltas: [] } }, metSessions: 2, minutesTogether: 10, lastSeenT: 0 } };
		const base = { schemaVersion: SCHEMA_VERSION, ...META, relations: rel, inventory: {}, builds: [], digs: [], owned: {}, explored: [] };
		const fresh = loadedPatch({ ...base, lastAlive: 100 * MIN }, 100 * MIN + 10 * MIN);
		const aff = (p: ReturnType<typeof loadedPatch>) => (p.find((o) => o.path[0] === 'relations')!.value as typeof rel).Noah.axes.affection.value;
		expect(aff(fresh)).toBe(0.8);
		const old = loadedPatch({ ...base, lastAlive: 100 * MIN }, 100 * MIN + 31 * MIN);
		expect(aff(old)).toBeCloseTo(0.4);
	});
	// Red if lastAlive is written only on exit (a crash leaves it stale, and the next start wrongly halves).
	it('tick refreshes lastAlive every 5 s even when nothing else changed', () => {
		const p = tmpPath();
		let wall = 0;
		const s = new BrainSaver(p, META, () => wall);
		const st = initialState(PIP, pose);
		s.markDirty();
		s.tick(st);
		wall = 6_000;
		s.tick(st);
		expect(JSON.parse(readFileSync(p, 'utf8')).lastAlive).toBe(6_000);
	});
	it('writes atomically (no .tmp left behind)', () => {
		const p = tmpPath();
		const s = new BrainSaver(p, META, () => 0);
		s.markDirty();
		s.flush(initialState(PIP, pose));
		expect(readdirSync(dirname(p)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
	});
});

describe('revert reconciliation (spec §4.6)', () => {
	const nameOf = (i: number) => ({ 0: 'air', 1: 'stone', 3: 'dirt' } as Record<number, string>)[i] ?? null;
	// Red if revert leaves inventory as-is (rev 1 M5: duplication, or placed blocks never returned).
	it('returns placed blocks, removes re-placed mined blocks (never below 0), drops owned, marks builds and digs reverted', () => {
		const st = {
			...initialState(PIP, pose),
			inventory: { stone: 1, dirt: 0 },
			owned: { '1,60,1': 1, '2,60,2': 0 },
			builds: [{ id: 'b1', template: 'tower', variant: 'small' as const, origin: { x: 1, y: 60, z: 1 }, cells: [{ cell: { x: 1, y: 60, z: 1 }, block: 'stone' }], status: 'done' as const }],
			digs: [{ id: 'd1', block: 'dirt', entrance: { x: 2, y: 61, z: 2 }, target: { x: 2, y: 50, z: 2 }, stepsDone: 1, cells: ['2,60,2'], status: 'paused' as const }],
		};
		const reverted = [
			{ x: 1, y: 60, z: 1, oldId: 0, newId: 1, t: 1 }, // the bot placed stone → revert removes it → stone back to inventory
			{ x: 2, y: 60, z: 2, oldId: 3, newId: 0, t: 2 }, // the bot mined dirt → revert puts it back → dirt −1, floored at 0
		];
		const p = reconcileRevert(st, reverted, nameOf);
		const get = (path: string) => p.find((o) => o.path.join('.') === path)?.value;
		expect(get('inventory.stone')).toBe(2);
		expect(get('inventory.dirt') ?? st.inventory.dirt).toBe(0); // no op is emitted when the floored value is unchanged
		expect(get('owned.1,60,1')).toBeUndefined();
		expect(p.some((o) => o.path.join('.') === 'owned.1,60,1')).toBe(true);
		expect((get('builds') as { status: string }[])[0].status).toBe('reverted');
		expect((get('digs') as { status: string }[])[0].status).toBe('reverted');
	});
});
