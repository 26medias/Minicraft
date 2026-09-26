import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { worldSpawn } from 'minicraft-bot';
import { seededRng } from '../../src/bots/companion.js';
import { runBrain2 } from '../../src/brain2/brain.js';
import { ManualClock } from '../../src/brain2/clock.js';
import { PIP } from '../../src/brain2/data/personalities.data.js';
import type { WhenMode } from '../../src/shared/when.js';
import { FAKE_GEN, FAKE_SEED, FakeBody, FakeWorld, player } from '../fake-port.js';

const SPAWN = worldSpawn(FAKE_SEED, FAKE_GEN);

function rig(when: WhenMode) {
	const clock = new ManualClock(0);
	const world = new FakeWorld();
	const body = new FakeBody();
	body.world = world;
	body.current = { x: SPAWN.x + 0.5, y: world.surfaceY(SPAWN.x, SPAWN.z) + 1, z: SPAWN.z + 0.5, yaw: 0, pitch: 0 };
	const dir = mkdtempSync(join(tmpdir(), 'brain2-when-'));
	let engineCalls = 0;
	const lines: string[] = [];
	const h = runBrain2({
		port: { body, world }, clock: clock.now, wall: () => 1_790_000_000_000 + clock.t, rng: seededRng(7), seed: 7, personality: PIP,
		statePaths: { brainFile: join(dir, 'brain.json'), logDir: join(dir, 'logs') },
		meta: { worldUuid: 'w-test', bot: 'Pip', target: 'test', live: false }, world: { seed: FAKE_SEED, gen: FAKE_GEN },
		engines: () => {
			engineCalls++;
			return { laya: null, llm: null };
		},
		noEdits: false, logWrite: (l) => lines.push(l), manual: true, when,
	});
	const run = async (ms: number) => {
		for (let t = 0; t < ms; t += 100) {
			clock.advance(100);
			await h.step();
			await new Promise((r) => setImmediate(r));
		}
	};
	const edits = () => body.calls.filter((c) => ['place', 'break', 'mine'].includes(c.fn)).length;
	return { h, body, run, edits, lines, engineCalls: () => engineCalls };
}

describe('brain2 --when players', () => {
	// Red if the paused brain still runs its scheduler (every expert job reads engines()) or its runner.
	it('no player online: no engine call, no edit, no move; a kid joins → it resumes', async () => {
		const r = rig('players');
		await r.run(60_000);
		expect(r.engineCalls()).toBe(0);
		expect(r.edits()).toBe(0);
		expect(r.body.calls.filter((c) => c.fn === 'walkTo' || c.fn === 'flyTo')).toHaveLength(0);
		expect(r.lines.some((l) => l.includes('"kind":"paused"'))).toBe(true);
		const p = r.body.pose();
		r.body.list = [player({ id: 7, name: 'Noah', x: p.x + 4, y: p.y, z: p.z })];
		await r.run(10_000);
		expect(r.lines.some((l) => l.includes('"kind":"resumed"'))).toBe(true);
		expect(r.engineCalls()).toBeGreaterThan(0);
		// the control: the same brain with --when always runs its experts from the start
		const a = rig('always');
		await a.run(2000);
		expect(a.engineCalls()).toBeGreaterThan(0);
		await r.h.stop();
		await a.h.stop();
	}, 60_000);
});
