import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { worldSpawn } from 'minicraft-bot';
import { seededRng } from '../../src/bots/companion.js';
import { runBrain2 } from '../../src/brain2/brain.js';
import { ManualClock } from '../../src/brain2/clock.js';
import { EMOTIONAL, MERGE } from '../../src/brain2/data/weights.data.js';
import { PIP } from '../../src/brain2/data/personalities.data.js';
import { parseLog } from '../../src/brain2/log.js';
import { CHECK_TITLE, formatCheck, framesFromLog, initialOf, loadOverrides, rescore } from '../../src/brain2/replay.js';
import { FAKE_GEN, FAKE_SEED, FakeBody, FakeWorld } from '../fake-port.js';
import { KidScript } from './kid-script.js';
import { FIXTURE } from './record-fixture.js';

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), 'brain2-replay-'));
	dirs.push(d);
	return d;
};

describe('framesFromLog (spec §8, criterion 6)', () => {
	// Red if any mutation isn't logged (e.g. the brain file's load applied before the log subscribes): the replayed
	// state then misses it.
	it('re-applying a session log reproduces the final store state exactly', async () => {
		const sp = worldSpawn(FAKE_SEED, FAKE_GEN);
		const clock = new ManualClock(0);
		const world = new FakeWorld();
		const body = new FakeBody();
		body.world = world;
		body.current = { x: sp.x + 20.5, y: world.surfaceY(sp.x + 20, sp.z) + 1, z: sp.z + 0.5, yaw: 0, pitch: 0 };
		const dir = tmp();
		const brainFile = join(dir, 'brain.json');
		mkdirSync(dir, { recursive: true });
		// A loaded file too: its patch must be in the log.
		writeFileSync(brainFile, JSON.stringify({ schemaVersion: 1, worldUuid: 'w', bot: 'Pip', lastAlive: 0, relations: {}, inventory: { stone: 30, dirt: 10 }, builds: [], digs: [], owned: {}, explored: ['1,1'] }));
		const lines: string[] = [];
		const h = runBrain2({
			port: { body, world }, clock: clock.now, wall: () => 1_790_000_000_000 + clock.t, rng: seededRng(3), seed: 3, personality: PIP,
			statePaths: { brainFile, logDir: join(dir, 'logs') }, meta: { worldUuid: 'w', bot: 'Pip', target: 'test', live: false },
			world: { seed: FAKE_SEED, gen: FAKE_GEN }, engines: () => ({ laya: null, llm: null }), noEdits: false, logWrite: (l) => lines.push(l), manual: true,
		});
		const kid = new KidScript({ world, body, home: { x: sp.x + 24, z: sp.z + 4 } });
		for (let t = 0; t < 6 * 60_000; t += 100) {
			clock.advance(100);
			kid.tick(clock.t);
			await h.step();
			await new Promise((r) => setImmediate(r));
		}
		await h.stop();
		const log = parseLog(lines.join('\n'));
		const initial = initialOf(log);
		expect(initial).not.toBeNull();
		const frames = framesFromLog(log, initial!);
		expect(frames.length).toBeGreaterThan(100);
		// `version` counts store applies, which the log doesn't record: it is not replayed.
		const replayed = { ...frames.at(-1)!.state, version: 0 };
		const live = { ...h.store.state, version: 0 };
		expect(JSON.parse(JSON.stringify(replayed))).toEqual(JSON.parse(JSON.stringify(live)));
		expect(live.inventory.stone).toBeDefined();
	}, 60_000);
});

describe('rescore: the per-decision check (spec §8)', () => {
	const lines = parseLog(readFileSync(FIXTURE, 'utf8'));
	const selects = lines.filter((l) => l.k === 'select') as Array<Extract<(typeof lines)[number], { k: 'select' }>>;

	it('the committed tables flip nothing', () => {
		expect(rescore(lines, {})).toEqual([]);
	});

	// Red if the bonus is taken from the line's recorded row instead of recomputed under the new MERGE.
	it('MERGE.lineBonus 0 flips the recorded help-build decisions, and only those', () => {
		const flips = rescore(lines, { MERGE: { ...MERGE, lineBonus: 0 } });
		const helpBuild = selects.filter((s) => s.winner === 'help-build').map((s) => s.selectionId);
		expect(helpBuild.length).toBeGreaterThan(0);
		expect(flips.map((f) => f.selectionId)).toEqual(helpBuild);
		expect(flips.every((f) => f.was === 'help-build' && f.would !== 'help-build')).toBe(true);
	});

	// Red if the emotional term is taken from the line instead of recomputed from `inputs`.
	it('explore.w.curiosity 2 flips at least one decision to explore', () => {
		const E = { ...EMOTIONAL, explore: { ...EMOTIONAL.explore, w: { ...EMOTIONAL.explore.w, curiosity: 2 } } };
		const flips = rescore(lines, { EMOTIONAL: E });
		expect(flips.some((f) => f.would === 'explore')).toBe(true);
	});

	// Red if the report isn't labelled as what it is.
	it('the output is labelled per-decision check (not a re-simulation), and --data reads a .ts file\'s tables', async () => {
		const dir = tmp();
		const data = join(dir, 'weights.ts');
		writeFileSync(data, `export const MERGE = { lineBonus: 0 };\n`);
		const o = await loadOverrides(data);
		expect(o.MERGE).toEqual({ ...MERGE, lineBonus: 0 });
		expect(o.EMOTIONAL).toBeUndefined();
		const out = formatCheck(lines, o, data);
		expect(out[0]).toBe('per-decision check (not a re-simulation)');
		expect(CHECK_TITLE).toBe(out[0]);
		expect(out.join('\n')).toMatch(/help-build → /);
	});
});
