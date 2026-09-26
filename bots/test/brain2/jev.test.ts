import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { worldSpawn } from 'minicraft-bot';
import type { Answer, Choice } from '../../src/brain/brain.js';
import { JEV_URL } from '../../src/builder/engines.js';
import { seededRng } from '../../src/bots/companion.js';
import { runBrain2 } from '../../src/brain2/brain.js';
import { ManualClock } from '../../src/brain2/clock.js';
import { PIP } from '../../src/brain2/data/personalities.data.js';
import { Jev } from '../../src/brain2/engines/jev.js';
import type { LayaEngine } from '../../src/brain2/experts/expert.js';
import { SITUATIONAL_WORDS, wordCount } from '../../src/brain2/experts/jev-select.js';
import { parseLog, type LogLine } from '../../src/brain2/log.js';
import { paramsBuild, paramsExplore, paramsMine, paramsPlayer } from '../../src/brain2/params.js';
import { SelectionController } from '../../src/brain2/selection.js';
import { Store, initialState } from '../../src/brain2/store.js';
import { StopSignal } from '../../src/body/stop-signal.js';
import type { KidInfo } from '../../src/types.js';
import { FAKE_GEN, FAKE_SEED, FakeBody, FakeWorld } from '../fake-port.js';

const MIN = 60_000;
const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A lone bot on a fresh fake world with `jev` as its Jev engine; runs `ms` of 100 ms beats. */
async function run(jev: LayaEngine, ms: number) {
	const clock = new ManualClock(0);
	const world = new FakeWorld();
	const body = new FakeBody();
	body.world = world;
	const sp = worldSpawn(FAKE_SEED, FAKE_GEN);
	body.current = { x: sp.x + 0.5, y: world.surfaceY(sp.x, sp.z) + 1, z: sp.z + 0.5, yaw: 0, pitch: 0 };
	const dir = mkdtempSync(join(tmpdir(), 'brain2-jev-'));
	dirs.push(dir);
	const lines: string[] = [];
	const h = runBrain2({
		port: { body, world }, clock: clock.now, wall: () => 1_790_000_000_000 + clock.t, rng: seededRng(7), seed: 7, personality: PIP,
		statePaths: { brainFile: join(dir, 'brain.json'), logDir: join(dir, 'logs') },
		meta: { worldUuid: 'w-test', bot: 'Pip', target: 'test', live: false }, world: { seed: FAKE_SEED, gen: FAKE_GEN },
		engines: () => ({ laya: null, llm: null, jev }), jev: true, noEdits: false, logWrite: (l) => lines.push(l), manual: true,
	});
	for (let t = 0; t < ms; t += 100) {
		clock.advance(100);
		await h.step();
		await new Promise((r) => setImmediate(r));
	}
	await h.stop();
	const log = parseLog(lines.join('\n'));
	return {
		selects: log.filter((l): l is Extract<LogLine, { k: 'select' }> => l.k === 'select'),
		calls: log.filter((l): l is Extract<LogLine, { k: 'call' }> => l.k === 'call' && l.expert === 'select.situational'),
	};
}

/** Prefers `explore` (then `rest`), else the first option; records every question it got. */
function fakeJev(): LayaEngine & { asked: Array<{ state: string; q: Choice }> } {
	const asked: Array<{ state: string; q: Choice }> = [];
	return {
		asked,
		healthy: () => true,
		ask: async (state, q) => {
			asked.push({ state, q });
			const keys = Object.keys(q.options);
			const pick = keys.includes('explore') ? 'explore' : keys.includes('rest') ? 'rest' : keys[0];
			const probs = Object.fromEntries(keys.map((k) => [k, k === pick ? 0.7 : 0.3 / Math.max(1, keys.length - 1)]));
			// `best` disagrees with the probabilities on purpose: the vote is the probabilities' winner.
			return { type: 'choice', best: keys.find((k) => k !== pick) ?? pick, probs, confidence: 0.7 } satisfies Answer;
		},
	};
}

describe('experiment E2: Jev decides selection', () => {
	it('the Jev engine: request shape and headers; the key is never in an error', async () => {
		const seen: Array<{ url: string; init: RequestInit }> = [];
		const ok = (async (url: string, init: RequestInit) => {
			seen.push({ url, init });
			return new Response(JSON.stringify({ answers: { next: { type: 'choice', choice: 'b', probabilities: { a: 0.25, b: 0.75 } } } }), { status: 200 });
		}) as unknown as typeof fetch;
		const a = await new Jev({ key: 'SECRET-KEY', fetchImpl: ok }).ask('state text', { type: 'choice', instructions: 'pick', options: { a: 'first', b: 'second' } }, new AbortController().signal);
		expect(a).toMatchObject({ best: 'b', probs: { a: 0.25, b: 0.75 } });
		expect(seen[0].url).toBe(JEV_URL);
		expect((seen[0].init.headers as Record<string, string>).Authorization).toBe('Bearer SECRET-KEY');
		expect(seen[0].init.signal).toBeInstanceOf(AbortSignal);
		expect(JSON.parse(seen[0].init.body as string)).toEqual({
			model: 'jev-latest', state: 'state text', questions: { next: { type: 'choice', instructions: 'pick', criteria: { a: 'first', b: 'second' } } },
		});
		const bad = (async () => new Response('denied', { status: 401 })) as unknown as typeof fetch;
		const err = await new Jev({ key: 'SECRET-KEY', fetchImpl: bad }).ask('s', { type: 'choice', instructions: 'i', options: { a: 'x' } }, new AbortController().signal).catch((e: Error) => e.message);
		expect(err).toBe('jev: HTTP 401');
	});

	// Red if the situational expert stays on its code rule ('none'), or takes Jev's `best` over the probabilities.
	it('the situational vote is the winner of Jev\'s probabilities, and shows in the select lines', async () => {
		const jev = fakeJev();
		const { selects, calls } = await run(jev, 3 * MIN);
		expect(selects.length).toBeGreaterThan(0);
		const voted = selects.filter((s) => s.inputs.situational !== null);
		expect(voted.length, JSON.stringify(selects.map((s) => s.inputs.situational))).toBe(selects.length);
		for (const s of voted) expect(s.rows.find((r) => r.behaviour === s.inputs.situational)!.situational).toBe(1);
		expect(voted.some((s) => s.inputs.situational === 'explore')).toBe(true);
		const sit = jev.asked.filter((a) => a.q.instructions === 'What should I do next?');
		expect(sit.length).toBe(selects.length);
		for (const a of sit) expect(wordCount(a.state)).toBeLessThanOrEqual(SITUATIONAL_WORDS);
		expect(sit[0].state).toMatch(/^I am Pip, /);
		expect(calls.every((c) => c.engine === 'jev' && !c.fallback && typeof c.prompt === 'string')).toBe(true);
		// Social: no kid near, so no questions (the code rule's empty answer).
		expect(jev.asked.every((a) => a.q.instructions === 'What should I do next?')).toBe(true);
	}, 60_000);

	// Red if a failed Jev call leaves the selection unanswered (nothing ever starts) instead of falling back to 'none'.
	it('a failing Jev falls back to no situational vote, and the bot still selects', async () => {
		const down: LayaEngine = { healthy: () => true, ask: async () => { throw new Error('jev: HTTP 500'); } };
		const { selects, calls } = await run(down, 2 * MIN);
		expect(selects.length).toBeGreaterThan(0);
		expect(selects.every((s) => s.inputs.situational === null)).toBe(true);
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every((c) => c.fallback && c.reason === 'error: jev: HTTP 500')).toBe(true);
	}, 60_000);

	// Red if social ignores Jev (the code rule gives near 0.5 / help 0 here) or asks more than two questions per kid.
	it('social: two yes/no questions per kid, p(yes) as near and help', async () => {
		const clock = new ManualClock(0);
		const store = new Store(initialState(PIP, { x: 0, y: 200, z: 0, yaw: 0, pitch: 0 }), clock.now);
		const kid: KidInfo = {
			name: 'Noah', id: 7, pose: { x: 3, y: 200, z: 0, yaw: 0, pitch: 0 }, velocity: { x: 0, y: 0, z: 0 }, speedLast0_3s: 0, speedLast1s: 0,
			flying: false, inLiquid: false, lookTarget: null, lookBlock: null, lookDistance: null, lookHeldMs: 0, miningCell: null, placements: [], idleSinceMs: null,
		};
		const ctl = new SelectionController({
			store, clock: clock.now, kidsNow: () => [kid], stop: new StopSignal(600_000), noEdits: () => false, runner: { start: () => {}, end: () => {} }, log: () => {},
			params: { player: paramsPlayer, explore: paramsExplore, mine: paramsMine, build: paramsBuild }, jev: true,
		});
		store.apply([{ path: ['selection'], value: { id: 1, t: 0, trigger: 'start', urgent: false, social: null, situational: null, done: false } }], { kind: 'selection', by: 'test' });
		const asked: string[] = [];
		const jev: LayaEngine = { healthy: () => true, ask: async (state, q) => {
			asked.push(q.instructions);
			expect(wordCount(state)).toBeLessThanOrEqual(60);
			return { type: 'choice', best: 'yes', probs: /near/.test(q.instructions) ? { yes: 0.9, no: 0.1 } : { yes: 0.2, no: 0.8 }, confidence: 0.9 };
		} };
		const sl = ctl.social.reads(store.state, { changes: [], events: [] });
		expect(ctl.social.fallback(sl).social.Noah).toEqual({ near: 0.5, help: 0 });
		const records: unknown[] = [];
		const p = await ctl.social.run(sl, { signal: new AbortController().signal, engines: { laya: null, llm: null, jev }, record: (r) => records.push(r) });
		expect(p.social).toEqual({ Noah: { near: 0.9, help: 0.2 } });
		expect(asked).toEqual(['Do I want to be near Noah right now?', 'Does Noah want my help building right now?']);
		expect(records.length).toBe(1);
	});
});
