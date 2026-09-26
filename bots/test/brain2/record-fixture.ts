/**
 * Records `test/fixtures/brain2-help.jsonl` (Task 21): runBrain2, manual and code engines only, for 5 simulated
 * minutes with the scripted kid (kid-script.ts) wandering 3 min, then laying his 2 lines of 6 next to the bot.
 * Deterministic (ManualClock, seeded rng, a fixed wall). Only the meta, event, call and select lines are kept: the
 * per-decision check reads the select lines, and the change lines would make the fixture ten times bigger.
 *
 *   cd bots && npx tsx test/brain2/record-fixture.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { worldSpawn } from 'minicraft-bot';
import { seededRng } from '../../src/bots/companion.js';
import { runBrain2 } from '../../src/brain2/brain.js';
import { ManualClock } from '../../src/brain2/clock.js';
import { PIP } from '../../src/brain2/data/personalities.data.js';
import { FAKE_GEN, FAKE_SEED, FakeBody, FakeWorld } from '../fake-port.js';
import { KidScript } from './kid-script.js';

export const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'brain2-help.jsonl');

export async function record(minutes = 5): Promise<string[]> {
	const sp = worldSpawn(FAKE_SEED, FAKE_GEN);
	const clock = new ManualClock(0);
	const world = new FakeWorld();
	const body = new FakeBody();
	body.world = world;
	body.current = { x: sp.x + 20.5, y: world.surfaceY(sp.x + 20, sp.z) + 1, z: sp.z + 0.5, yaw: 0, pitch: 0 };
	const dir = mkdtempSync(join(tmpdir(), 'brain2-fixture-'));
	const lines: string[] = [];
	try {
		const h = runBrain2({
			port: { body, world }, clock: clock.now, wall: () => 1_790_000_000_000 + clock.t, rng: seededRng(7), seed: 7, personality: PIP,
			statePaths: { brainFile: join(dir, 'brain.json'), logDir: join(dir, 'logs') },
			meta: { worldUuid: 'fixture', bot: 'Pip', target: 'test', live: false }, world: { seed: FAKE_SEED, gen: FAKE_GEN },
			engines: () => ({ laya: null, llm: null }), noEdits: false, logWrite: (l) => lines.push(l), manual: true,
		});
		const kid = new KidScript({ world, body, home: { x: sp.x + 24, z: sp.z + 4 } });
		for (let t = 0; t < minutes * 60_000; t += 100) {
			clock.advance(100);
			kid.tick(clock.t);
			await h.step();
			await new Promise((r) => setImmediate(r));
		}
		await h.stop();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	return lines.filter((l) => !l.startsWith('{"k":"change"'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const lines = await record();
	writeFileSync(FIXTURE, `${lines.join('\n')}\n`);
	console.log(`wrote ${lines.length} lines to ${FIXTURE}`);
}
