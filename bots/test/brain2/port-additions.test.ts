import { describe, expect, it } from 'vitest';
import { WORLDGEN_BLOCKS, CRAFTED_ONLY, BotClient, NotConnectedError } from 'minicraft-bot';
import { FakeBody, FakeWorld } from '../fake-port.js';

describe('Port additions (brain2 Task 1)', () => {
	// Red if FakeWorld.isEdited ignores set(): every brain2 ownership test depends on it.
	it('FakeWorld tracks edits like the SDK', () => {
		const w = new FakeWorld();
		expect(w.isEdited(5, 60, 5)).toBe(false);
		w.set(5, 60, 5, 'stone');
		expect(w.isEdited(5, 60, 5)).toBe(true);
		expect(w.editedCellsInChunk(0, 0)).toEqual([[5, 60, 5]]);
	});
	// Red if FakeBody.break doesn't write the world: Mine tests would see stone forever.
	it('FakeBody.break and mine write air and are recorded', async () => {
		const w = new FakeWorld();
		const b = new FakeBody();
		b.world = w;
		w.set(6, 60, 6, 'stone');
		expect(await b.break(6, 60, 6)).toBe(true);
		expect(w.getBlock(6, 60, 6)).toBe(0);
		expect(b.calls.at(-1)).toMatchObject({ fn: 'break', args: [6, 60, 6] });
		w.set(7, 60, 7, 'stone');
		expect(await b.mine(7, 60, 7)).toBe(true);
		expect(w.getBlock(7, 60, 7)).toBe(0);
	});
	it('block lists come from the SDK', () => {
		expect(WORLDGEN_BLOCKS).toContain('stone');
		expect(CRAFTED_ONLY).toContain('big_tnt');
	});

	// The exact failure realPort's stopMining must guard against (gate 2 fix round 1): mine() throws
	// synchronously (assertConnected), not via a rejection, when the client is idle/connecting/closed.
	// realPort itself can only be built from an already-connected client (its `world` getter throws
	// otherwise), so this pins the precondition against the real SDK; realPort's own try/catch around
	// this call is covered by reading bots/src/port.ts's stopMining (self-review) and, once it exists,
	// the e2e suite (Task 7), which is the only place a real client can be driven through a disconnect.
	it('a disconnected client\'s mine() throws synchronously, not a rejection', () => {
		const client = new BotClient({ url: 'http://127.0.0.1:1', token: 'x' });
		expect(() => client.mine(0, -10, 0)).toThrow(NotConnectedError);
	});
});
