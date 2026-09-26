import { describe, expect, it } from 'vitest';
import { Ownership, key } from '../../src/brain2/ownership.js';
import { FakeWorld, id } from '../fake-port.js';
import { seededRng } from '../../src/bots/companion.js';
import type { EditEvent } from '../../src/types.js';

const YOU = 99, KID = 7;
function kidEdit(x: number, y: number, z: number, oldId: number, newId: number): EditEvent {
	return { by: KID, byName: 'Noah', byBot: false, opCount: 1, cells: [{ x, y, z, oldId, newId }] };
}
function setup() {
	const w = new FakeWorld();
	let owned: Record<string, number> = {};
	const o = new Ownership(w, () => owned);
	const own = (x: number, y: number, z: number, name: string) => {
		w.set(x, y, z, name);
		const op = o.ownWrite(x, y, z, id(name));
		owned = { ...owned, [op.path[1]]: op.value as number };
	};
	const drop = (patch: { path: string[] }[]) => {
		for (const p of patch) {
			const rest = { ...owned };
			delete rest[p.path[1]];
			owned = rest;
		}
	};
	return { w, o, own, drop, get owned() { return owned; } };
}

describe('Ownership (spec §4.5)', () => {
	it('an untouched cell is natural, a bot write is bot, a kid write is kid', () => {
		const t = setup();
		expect(t.o.classify(3, 60, 3)).toBe('natural');
		t.own(4, 60, 4, 'stone');
		expect(t.o.classify(4, 60, 4)).toBe('bot');
		t.w.set(5, 60, 5, 'dirt');
		expect(t.o.classify(5, 60, 5)).toBe('kid');
	});
	// Red if a foreign edit doesn't drop ownership (rev 1's defect): the kid's block would read as the bot's.
	it('a kid overwriting a bot cell makes it kid', () => {
		const t = setup();
		t.own(4, 60, 4, 'stone');
		t.w.set(4, 60, 4, 'dirt');
		t.drop(t.o.onEdit(kidEdit(4, 60, 4, id('stone'), id('dirt')), YOU));
		expect(t.o.classify(4, 60, 4)).toBe('kid');
	});
	// Review Focus 2. Red if only an id mismatch drops ownership: a same-id re-place by a kid stays "bot".
	it('same-id foreign write', () => {
		const t = setup();
		t.own(4, 60, 4, 'stone');
		t.drop(t.o.onEdit(kidEdit(4, 60, 4, id('stone'), id('stone')), YOU));
		expect(t.o.classify(4, 60, 4)).toBe('kid');
	});
	// Review Focus 1. Red if reset() is a no-op (gate 2: the old version of this test passed on a no-op, because
	// classify compares the current block anyway). The kid index is the state reset must clear: a kid cell made
	// while offline must show up in kidCellWithin after the reconnect.
	it('rebuilds after reset', () => {
		const t = setup();
		t.own(4, 60, 4, 'stone');
		expect(t.o.classify(4, 60, 4)).toBe('bot');
		expect(t.o.kidCellWithin(4, 4, 6)).toBe(false); // builds and caches chunk (0,0)'s kid set: empty
		t.o.reset();
		t.w.set(6, 60, 4, 'dirt'); // a kid placed this while the bot was offline: no EditEvent was ever seen
		t.w.set(4, 60, 4, 'dirt'); // and overwrote the bot's cell
		expect(t.o.kidCellWithin(4, 4, 6)).toBe(true);
		expect(t.o.classify(4, 60, 4)).toBe('kid');
		t.drop(t.o.drainPending());
		expect(key(4, 60, 4) in t.owned).toBe(false);
	});
	// Red if the buffer counts bot cells (rev 1 M4): the bot could never place its second block.
	it('bot cells have no buffer; kid cells do', () => {
		const t = setup();
		t.own(10, 60, 10, 'stone');
		expect(t.o.kidNeighbour(11, 60, 10, 1)).toBe(false);
		t.w.set(20, 60, 20, 'dirt');
		expect(t.o.kidNeighbour(21, 61, 21, 1)).toBe(true);
		expect(t.o.kidNeighbour(22, 60, 20, 1)).toBe(false);
	});
	it('the 2-block breaking buffer counts only kid air', () => {
		const t = setup();
		t.w.set(30, 60, 30, 0); // a kid dug here
		expect(t.o.kidNeighbour(32, 60, 30, 2, true)).toBe(true);
		t.w.set(40, 60, 40, 'dirt'); // a kid placed here (solid)
		expect(t.o.kidNeighbour(42, 60, 40, 2, true)).toBe(false);
	});
	// Red if the index ignores foreign edits after it was built: a later kid build nearby is missed.
	it('kidCellWithin sees cells added after the index was built', () => {
		const t = setup();
		expect(t.o.kidCellWithin(100, 100, 12)).toBe(false);
		t.w.set(108, 60, 100, 'dirt');
		t.o.onEdit(kidEdit(108, 60, 100, 0, id('dirt')), YOU);
		expect(t.o.kidCellWithin(100, 100, 12)).toBe(true);
		expect(t.o.kidCellWithin(100, 100, 7)).toBe(false);
	});
	// Red on an id-only rule while the store lags: the foreign edit is seen, but the deletion isn't applied yet.
	it('same-id foreign write counts as kid before the store applies the deletion', () => {
		const t = setup();
		t.own(4, 60, 4, 'stone');
		t.o.onEdit(kidEdit(4, 60, 4, id('stone'), id('stone')), YOU); // no drop(): the owned map still has the cell
		expect(t.o.classify(4, 60, 4)).toBe('kid');
	});
	// Property: after any random sequence of own writes and kid writes (same id or not), a cell is `bot` only if
	// the bot wrote it last and it still holds that id. Red if foreign edits don't drop ownership.
	it('property: bot ⇔ last writer was the bot and the id still matches', () => {
		const rng = seededRng(42);
		const t = setup();
		const last = new Map<string, 'bot' | 'kid'>();
		const blocks = ['stone', 'dirt', 'cobblestone'];
		for (let i = 0; i < 2000; i++) {
			const x = 50 + Math.floor(rng() * 4), z = 50 + Math.floor(rng() * 4), y = 60;
			const b = blocks[Math.floor(rng() * blocks.length)];
			const k = key(x, y, z);
			if (rng() < 0.5) {
				t.own(x, y, z, b);
				last.set(k, 'bot');
			} else {
				const old = t.w.getBlock(x, y, z);
				t.w.set(x, y, z, b);
				t.drop(t.o.onEdit(kidEdit(x, y, z, old, id(b)), YOU));
				last.set(k, 'kid');
			}
			for (const [kk, who] of last) {
				const [cx, cy, cz] = kk.split(',').map(Number);
				expect(t.o.classify(cx, cy, cz)).toBe(who === 'bot' ? 'bot' : 'kid');
			}
		}
	});
});
