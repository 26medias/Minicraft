import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blockId } from 'minicraft-bot';
import { boardPath, fireworkTurn, list, sight } from '../../src/board/board.js';
import { FIREWORK_SETTLE_MS, markerAt, MarkerWatcher } from '../../src/board/markers.js';
import { FakeBody, FakeWorld } from '../fake-port.js';

const RED = blockId('red_wool')!, BLUE = blockId('blue_wool')!, GREEN = blockId('green_wool')!, WHITE = blockId('white_wool')!;
const X = 100, Z = 100, Y = 150;

function stack(w: FakeWorld, ids: number[], y0 = Y): void {
	ids.forEach((id, i) => w.set(X, y0 + i, Z, id));
}
const isKid = (w: FakeWorld) => (x: number, y: number, z: number) => w.isEdited(x, y, z);

describe('markerAt', () => {
	it('exactly 3 of one marker wool, all kid cells: flatten / house / garden, from any cell of the stack', () => {
		for (const [id, kind] of [[RED, 'flatten'], [BLUE, 'house'], [GREEN, 'garden']] as const) {
			const w = new FakeWorld();
			stack(w, [id, id, id]);
			for (const y of [Y, Y + 1, Y + 2]) expect(markerAt(w, isKid(w), X, y, Z)).toMatchObject({ kind, base: { x: X, y: Y, z: Z }, top: { x: X, y: Y + 2, z: Z } });
		}
	});

	it('not a marker: 2 or 4 high, mixed colours, white wool, or natural cells', () => {
		const two = new FakeWorld();
		stack(two, [RED, RED]);
		expect(markerAt(two, isKid(two), X, Y, Z)).toBeNull();
		const four = new FakeWorld();
		stack(four, [RED, RED, RED, RED]);
		expect(markerAt(four, isKid(four), X, Y + 1, Z)).toBeNull();
		const mixed = new FakeWorld();
		stack(mixed, [RED, BLUE, RED]);
		expect(markerAt(mixed, isKid(mixed), X, Y, Z)).toBeNull();
		const white = new FakeWorld();
		stack(white, [WHITE, WHITE, WHITE]);
		expect(markerAt(white, isKid(white), X, Y, Z)).toBeNull();
		const nat = new FakeWorld();
		for (let i = 0; i < 3; i++) nat.setNatural(X, Y + i, Z, RED);
		expect(markerAt(nat, isKid(nat), X, Y, Z)).toBeNull();
		// A 3-stack beside a different colour below is still a marker.
		const onBlue = new FakeWorld();
		stack(onBlue, [BLUE, RED, RED, RED], Y - 1);
		expect(markerAt(onBlue, isKid(onBlue), X, Y, Z)?.kind).toBe('flatten');
	});
});

describe('MarkerWatcher', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('a kid stacking 3 red wool: one board post, once; the nearest watcher fires the firework', async () => {
		const path = boardPath(mkdtempSync(join(tmpdir(), 'markers-')), 'local', 'w');
		const w = new FakeWorld();
		const body = new FakeBody();
		body.current = { x: X + 5, y: Y, z: Z, yaw: 0, pitch: 0 };
		const logs: Array<Record<string, unknown>> = [];
		const watcher = new MarkerWatcher({ name: 'Dozer', body, world: w, boardPath: path, isKid: isKid(w), log: (e) => logs.push(e) });
		for (let i = 0; i < 3; i++) {
			w.set(X, Y + i, Z, RED);
			body.emitEdit({ by: 2, byName: 'Noah', byBot: false, opCount: 1, cells: [{ x: X, y: Y + i, z: Z, oldId: 0, newId: RED }] });
		}
		// A bot's wool never counts; a re-send of the same marker is not posted again.
		body.emitEdit({ by: 7, byName: 'Robo', byBot: true, opCount: 1, cells: [{ x: X, y: Y + 2, z: Z, oldId: 0, newId: RED }] });
		expect(watcher.scan({ x: X, z: Z }, 16)).toBe(0);
		const posts = list(path, { type: 'kid-marker' });
		expect(posts).toHaveLength(1);
		expect(posts[0]).toMatchObject({ marker: 'flatten', requester: 'Noah', center: { x: X, y: Y, z: Z }, status: 'open' });
		// Another bot farther away saw it too.
		sight(path, posts[0].id, 'Far', 50);
		await vi.advanceTimersByTimeAsync(FIREWORK_SETTLE_MS + 10);
		const fw = body.calls.filter((c) => c.fn === 'fx').map((c) => c.args[0] as { kind: string; y: number });
		expect(fw).toEqual([{ kind: 'firework', x: X, y: Y + 5, z: Z }]);
		expect(fireworkTurn(path, posts[0].id, 'Far')).toBe(false);
		watcher.stop();
	});

	it('a scan at start finds a marker placed while the bot was away', () => {
		const path = boardPath(mkdtempSync(join(tmpdir(), 'markers-')), 'local', 'w');
		const w = new FakeWorld();
		stack(w, [GREEN, GREEN, GREEN]);
		const body = new FakeBody();
		const watcher = new MarkerWatcher({ name: 'Dozer', body, world: w, boardPath: path, isKid: isKid(w), log: () => undefined });
		expect(watcher.scan({ x: X, z: Z }, 32)).toBe(1);
		expect(list(path)[0]).toMatchObject({ marker: 'garden' });
		watcher.stop();
	});
});
