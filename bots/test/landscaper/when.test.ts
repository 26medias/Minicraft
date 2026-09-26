import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runLandscaper } from '../../src/landscaper/landscaper.js';
import { FakeBody, FakeWorld } from '../fake-port.js';

describe('landscaper --when players', () => {
	it('with nobody online: paused, no model call, no edit, no fx', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'land-when-'));
		const body = new FakeBody();
		const logs: Array<Record<string, unknown>> = [];
		let asked = 0;
		const engine = { name: 'laya', choose: async () => { asked++; return { choice: 'area-1', probs: {} }; } };
		const h = runLandscaper({
			name: 'Dozer', body, world: new FakeWorld(), spawn: { x: 256, y: 0, z: 256 }, primary: engine, noEdits: false,
			statePath: join(dir, 's.json'), boardPath: join(dir, 'board.json'), log: (e) => logs.push(e), rng: () => 0.5, when: 'players',
			breakMany: async () => [],
		});
		await new Promise((r) => setTimeout(r, 400));
		await h.stop();
		expect(logs.some((l) => l.k === 'paused')).toBe(true);
		expect(logs.some((l) => l.k === 'area-search')).toBe(false);
		expect(asked).toBe(0);
		expect(body.calls.filter((c) => ['mine', 'place', 'break', 'fx', 'walkTo', 'flyTo'].includes(c.fn))).toEqual([]);
	});
});
