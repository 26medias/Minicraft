import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blockNames } from 'minicraft-bot';
import { runBuilder } from '../../src/builder/builder.js';
import type { ChoiceEngine } from '../../src/builder/engines.js';
import { PresenceGate } from '../../src/shared/when.js';
import { FakeBody, FakeWorld, player } from '../fake-port.js';

describe('--when players', () => {
	it('the gate: paused with no player, resumed only after a 5 s debounce; bots don\'t count', () => {
		let t = 0;
		let list: Array<{ bot: boolean }> = [{ bot: true }];
		const logs: string[] = [];
		const g = new PresenceGate({ mode: 'players', players: () => list, clock: () => t, log: (e) => logs.push(String(e.k)) });
		expect(g.paused()).toBe(true);
		list = [{ bot: true }, { bot: false }];
		t = 4999;
		expect(g.paused()).toBe(true); // the debounce starts at the first call that sees him
		t = 4999 + 5000;
		expect(g.paused()).toBe(false);
		expect(logs).toEqual(['paused', 'resumed']);
		expect(new PresenceGate({ mode: 'always', players: () => [], clock: () => 0, log: () => undefined }).paused()).toBe(false);
	});

	// Red if the builder asks its model or places a block while no player is online.
	it('the builder, paused (no player online): no model call, no edit; a kid joins → it resumes', async () => {
		const world = new FakeWorld();
		const body = new FakeBody();
		body.world = world;
		body.current = { x: 100.5, y: world.surfaceY(100, 100) + 1, z: 100.5, yaw: 0, pitch: 0 };
		body.placeImpl = async (x, y, z, name) => {
			world.set(x, y, z, name);
			return true;
		};
		let asks = 0;
		const engine: ChoiceEngine = {
			name: 'spy',
			choose: async (_s, _i, options) => {
				asks++;
				return { choice: Object.keys(options)[0], probs: {} };
			},
		};
		const logs: Array<Record<string, unknown>> = [];
		const start = Date.now(); // the bot's clock runs 20× fast: the 5 s debounce passes in 0.25 s
		const h = runBuilder({
			name: 'Milo', body, world, spawn: { x: 400, y: world.surfaceY(400, 400) + 1, z: 400 }, primary: engine, noEdits: false, when: 'players',
			clock: () => 1e12 + (Date.now() - start) * 20, statePath: join(mkdtempSync(join(tmpdir(), 'when-')), 'b.json'), log: (e) => logs.push(e), rng: () => 0.3,
			paceMs: 0, restMs: 1e9, known: new Set(blockNames()),
		});
		await new Promise((r) => setTimeout(r, 2500));
		expect(logs.some((e) => e.k === 'paused')).toBe(true);
		expect(asks).toBe(0);
		expect(body.calls.filter((c) => ['place', 'break', 'mine'].includes(c.fn))).toHaveLength(0);
		// A kid joins: after the debounce the builder asks its model again (the paused silence was the gate's doing).
		body.list = [player({ id: 7, name: 'Noah', x: 110.5, y: world.surfaceY(110, 110) + 1, z: 110.5 })];
		const t0 = Date.now();
		while (asks === 0 && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 50));
		await h.stop();
		expect(logs.some((e) => e.k === 'resumed')).toBe(true);
		expect(asks).toBeGreaterThan(0);
	}, 30_000);
});
