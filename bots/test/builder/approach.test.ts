import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BlockedError, blockNames } from 'minicraft-bot';
import { approach, eyeDist, PLACE_MAX, runBuilder } from '../../src/builder/builder.js';
import { FakeBody, FakeWorld } from '../fake-port.js';

const blocked = (p: { x: number; y: number; z: number }) =>
	new BlockedError({ x: p.x, y: p.y, z: p.z, yaw: 0, pitch: 0 }, 'wall', 'flyTo' as never);

function stuckBody(world: FakeWorld) {
	const body = new FakeBody();
	body.world = world;
	const x = 100.5, z = 100.5;
	const y = world.surfaceY(100, 100) + 1;
	body.current = { x, y, z, yaw: 0, pitch: 0 };
	return body;
}

describe('builder approach (unstick)', () => {
	it('walks to a stand spot beside the cell (the shared navigator), no flight needed on open ground', async () => {
		const world = new FakeWorld();
		const body = stuckBody(world);
		const oy = world.surfaceY(125, 100) + 1;
		const b = { origin: { x: 125, y: oy, z: 100 }, w: 5, d: 5 };
		const cell = { x: 125, y: oy, z: 102 };
		const ok = await approach(body, world, b, cell);
		expect(ok).toBe(true);
		expect(eyeDist(body.pose(), cell)).toBeLessThanOrEqual(PLACE_MAX);
		expect(body.calls[0]).toMatchObject({ fn: 'walkTo', args: [{ x: 123.8, z: 102.5 }, undefined] });
		expect(body.calls.some((c) => c.fn === 'flyTo')).toBe(false);
	});

	it('a blocked walk and a blocked column flight: flies high (up, across, down) and arrives within reach', async () => {
		const world = new FakeWorld();
		const body = stuckBody(world);
		const start = body.pose();
		body.walkImpl = async () => {
			throw blocked(body.pose());
		};
		// Rejects any flight that changes x/z while still at the start altitude (the tree trunk); the rest resolve.
		body.flyImpl = async (t) => {
			const p = body.pose();
			if (Math.abs(p.y - start.y) < 1 && (t.x !== p.x || t.z !== p.z)) throw blocked(p);
			return 'arrived';
		};
		const oy = world.surfaceY(125, 100) + 1;
		const b = { origin: { x: 125, y: oy, z: 100 }, w: 5, d: 5 };
		const cell = { x: 125, y: oy, z: 102 };
		const logs: Array<Record<string, unknown>> = [];
		const ok = await approach(body, world, b, cell, (e) => logs.push(e));
		expect(ok).toBe(true);
		expect(eyeDist(body.pose(), cell)).toBeLessThanOrEqual(PLACE_MAX);
		expect(logs.some((e) => e.k === 'fly-high')).toBe(true);
		const flights = body.calls.filter((c) => c.fn === 'flyTo').map((c) => c.args[0] as { x: number; y: number; z: number });
		// after the refused column flight: straight up from where it was stuck
		const up = flights.find((f) => f.y > start.y + 1)!;
		expect(up.x).toBe(start.x);
		expect(up.z).toBe(start.z);
	});

	it('every flight blocked: approach fails, and the builder never places from out of reach, then abandons', async () => {
		const world = new FakeWorld();
		const body = stuckBody(world);
		body.flyImpl = async () => {
			throw blocked(body.pose());
		};
		body.walkImpl = async () => {
			throw blocked(body.pose());
		};
		let placed = 0;
		body.placeImpl = async () => {
			placed++;
			return true;
		};
		const logs: Array<Record<string, unknown>> = [];
		const dir = mkdtempSync(join(tmpdir(), 'builder-'));
		// Spawn 25 blocks away from the stuck bot, so every site is out of reach.
		const h = runBuilder({
			name: 'Milo', body, world, spawn: { x: 125, y: world.surfaceY(125, 125) + 1, z: 125 }, primary: null, noEdits: false,
			statePath: join(dir, 'b.json'), log: (e) => logs.push(e), rng: () => 0.3, paceMs: 0, restMs: 10, known: new Set(blockNames()),
		});
		const t0 = Date.now();
		while (h.stats.buildsAbandoned < 1 && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 20));
		await h.stop();
		expect(h.stats.buildsAbandoned).toBeGreaterThanOrEqual(1);
		expect(placed).toBe(0);
		expect(logs.some((e) => e.k === 'build-end' && e.why === 'cannot reach the site')).toBe(true);
	}, 30_000);

	it('builds within reach, then rests visibly (looks and hops near the build)', async () => {
		const world = new FakeWorld();
		const body = stuckBody(world);
		body.placeImpl = async (x, y, z, name) => {
			world.set(x, y, z, name);
			return true;
		};
		const logs: Array<Record<string, unknown>> = [];
		const dir = mkdtempSync(join(tmpdir(), 'builder-'));
		let t = 1e12;
		const h = runBuilder({
			name: 'Milo', body, world, spawn: { x: 125, y: world.surfaceY(125, 125) + 1, z: 125 }, primary: null, noEdits: false,
			clock: () => (t += 1000), // every clock read is a second later: the edit gap never holds the build up
			statePath: join(dir, 'b.json'), log: (e) => logs.push(e), rng: () => 0.7, paceMs: 0, restMs: 1e9, known: new Set(blockNames()),
		});
		const t0 = Date.now();
		while (h.stats.buildsDone < 1 && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 20));
		expect(h.stats.buildsDone).toBe(1);
		const n = body.calls.length;
		await new Promise((r) => setTimeout(r, 6000));
		const idle = body.calls.slice(n).map((c) => c.fn);
		await h.stop();
		expect(idle).toContain('lookAt');
				expect(idle.some((f) => f === 'walkTo' || f === 'flyTo')).toBe(true); // a hop, through the navigator
		// every placement happened with the eye within reach
		for (const e of logs.filter((l) => l.k === 'place')) expect(e.ok).toBe(true);
	}, 40_000);
});
