// Multiplayer plan task C4: MpSync — T7 (echo rule, end to end), T15 (lamp colour read at flush), T16 (extras).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { World } from '../engine/world/world';
import { AIR } from '../data/blocks.data';
import { BLOCK_BY_NAME } from '../data/blocks.data';
import { MpSync, type StorageLike } from './mp-sync';
import { colorToInt, MAX_OPS_PER_EDIT, type EditMsg, type EditOut, type Op } from './protocol';

const STONE = BLOCK_BY_NAME['stone'].id;
const DIRT = BLOCK_BY_NAME['dirt'].id;
const LAMP = BLOCK_BY_NAME['lamp'].id;

class MemStorage implements StorageLike {
	m = new Map<string, string>();
	getItem(k: string): string | null { return this.m.get(k) ?? null; }
	setItem(k: string, v: string): void { this.m.set(k, v); }
	removeItem(k: string): void { this.m.delete(k); }
}

/** A minimal lamp registry: MpSync only reads colours. */
class LightsStub {
	private c = new Map<string, string>();
	add(x: number, y: number, z: number, hex: string): void { this.c.set(`${x},${y},${z}`, hex); }
	getColor(x: number, y: number, z: number): string | null { return this.c.get(`${x},${y},${z}`) ?? null; }
}

function setup(lights: LightsStub | null = null) {
	const world = World.create(3);
	world.ensureChunk(0, 0);
	const sent: Array<{ t: string; [k: string]: unknown }> = [];
	const applied: Op[][] = [];
	const storage = new MemStorage();
	let extras: unknown = { inventory: { 1: 3 } };
	const sync = new MpSync(world, lights, (m) => sent.push(m as { t: string }), () => extras, storage, (ops) => applied.push(ops), 'world-a');
	world.onLocalWrite = (x, y, z) => sync.record(x, y, z);
	return { world, sent, applied, storage, sync, setExtras: (e: unknown) => { extras = e; } };
}

const Y = 70;

afterEach(() => { vi.useRealTimers(); });

describe('MpSync.flushFrame', () => {
	it('sends one edit per frame with the cells as they are at flush time', () => {
		const { world, sent, sync } = setup();
		world.setBlock(1, Y, 1, STONE);
		world.setBlock(1, Y, 1, DIRT);
		world.setBlock(2, Y, 1, STONE);
		sync.flushFrame();
		expect(sent).toHaveLength(1);
		const m = sent[0] as unknown as EditMsg;
		expect(m.t).toBe('edit');
		expect(m.cid).toBe(1);
		expect(m.ops).toEqual([[1, Y, 1, DIRT, 0, 0], [2, Y, 1, STONE, 0, 0]]);
		sync.flushFrame();
		expect(sent).toHaveLength(1);
	});

	it('sends the fluid meta of flowing liquid', () => {
		const { world, sent, sync } = setup();
		world.setBlockFlow(3, Y, 3, BLOCK_BY_NAME['water'].id, 2);
		sync.flushFrame();
		expect((sent[0] as unknown as EditMsg).ops[0][4]).toBe(0x82);
	});

	it(`splits a frame into messages of at most ${MAX_OPS_PER_EDIT} ops, each with its own cid`, () => {
		const { world, sent, sync } = setup();
		for (let i = 0; i < 4500; i++) world.setBlock(i % 16, 60 + Math.floor(i / 256), Math.floor(i / 16) % 16, STONE);
		sync.flushFrame();
		expect(sent.map((m) => (m as unknown as EditMsg).ops.length)).toEqual([2000, 2000, 500]);
		expect(sent.map((m) => (m as unknown as EditMsg).cid)).toEqual([1, 2, 3]);
	});
});

describe('T7: echo rule end to end (spec §6)', () => {
	function run() {
		const s = setup();
		const { world, sync, applied } = s;
		const you = 7;
		// Place, flush (cid 1); mine, flush (cid 2).
		world.setBlock(5, Y, 5, STONE);
		sync.flushFrame();
		world.setBlock(5, Y, 5, AIR);
		sync.flushFrame();
		const echo1: EditOut = { t: 'edit', seq: 1, by: you, cid: 1, ops: [[5, Y, 5, STONE, 0, 0]] };
		const foreign: EditOut = { t: 'edit', seq: 2, by: 9, ops: [[5, Y, 5, DIRT, 0, 0]] };
		const echo2: EditOut = { t: 'edit', seq: 3, by: you, cid: 2, ops: [[5, Y, 5, AIR, 0, 0]] };
		for (const m of [echo1, foreign, echo2]) sync.onEdit(m, you);
		// The final value is the last op applied to the cell (what the loop's drain would leave).
		let final: number | null = null;
		for (const ops of applied) for (const op of ops) if (op[0] === 5 && op[1] === Y && op[2] === 5) final = op[3];
		return { applied, final };
	}

	it('never applies the stale stone echo (no flicker)', () => {
		const { applied } = run();
		const stone = applied.flat().filter((op) => op[3] === STONE);
		expect(stone).toEqual([]);
	});

	it('ends at the highest-seq op (the author\'s mine) despite a foreign op in between', () => {
		const { final } = run();
		expect(final).toBe(AIR);
	});

	it('applies foreign ops, and own echoes when nothing newer is pending', () => {
		const { world, sync, applied } = setup();
		world.setBlock(6, Y, 6, STONE);
		sync.flushFrame();
		sync.onEdit({ t: 'edit', seq: 1, by: 2, ops: [[9, Y, 9, DIRT, 0, 0]] }, 1);
		sync.onEdit({ t: 'edit', seq: 2, by: 1, cid: 1, ops: [[6, Y, 6, STONE, 0, 0]] }, 1);
		expect(applied).toEqual([[[9, Y, 9, DIRT, 0, 0]], [[6, Y, 6, STONE, 0, 0]]]);
	});

	it('does not call apply for a batch whose ops were all skipped', () => {
		const { world, sync, applied } = setup();
		world.setBlock(6, Y, 6, STONE);
		sync.flushFrame();
		world.setBlock(6, Y, 6, AIR);
		sync.flushFrame();
		sync.onEdit({ t: 'edit', seq: 1, by: 1, cid: 1, ops: [[6, Y, 6, STONE, 0, 0]] }, 1);
		expect(applied).toEqual([]);
	});
});

describe('T15: lamp colour is read at flush, not in the hook (spec §7.1)', () => {
	it('placeBlock ordering (setBlock, then lights.add) still sends the colour', () => {
		const lights = new LightsStub();
		const { world, sent, sync } = setup(lights);
		world.setBlock(4, Y, 4, LAMP);
		lights.add(4, Y, 4, '#FF8A99');
		sync.flushFrame();
		const op = (sent[0] as unknown as EditMsg).ops[0];
		expect(op[3]).toBe(LAMP);
		expect(op[5]).toBe(colorToInt('#FF8A99'));
	});

	it('a cell with no lamp colour sends 0', () => {
		const { world, sent, sync } = setup(new LightsStub());
		world.setBlock(4, Y, 4, STONE);
		sync.flushFrame();
		expect((sent[0] as unknown as EditMsg).ops[0][5]).toBe(0);
	});
});

describe('T16: extras (spec §7.1)', () => {
	it('markDirty sends one extras message 5 s later, however often it is called', () => {
		vi.useFakeTimers();
		const { sent, sync, setExtras } = setup();
		sync.markDirty();
		vi.advanceTimersByTime(2000);
		setExtras({ inventory: { 1: 4 } });
		sync.markDirty();
		vi.advanceTimersByTime(2999);
		expect(sent).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(sent).toEqual([{ t: 'extras', data: { inventory: { 1: 4 } } }]);
		vi.advanceTimersByTime(10_000);
		expect(sent).toHaveLength(1);
	});

	it('markDirty mirrors the extras to storage on every call', () => {
		const { storage, sync, setExtras } = setup();
		sync.markDirty();
		setExtras({ inventory: { 2: 1 } });
		sync.markDirty();
		expect(MpSync.readStash(storage, 'world-a')).toEqual({ inventory: { 2: 1 } });
		expect(MpSync.readStash(storage, 'world-b')).toBeNull();
	});

	it('flush sends extras now and cancels the pending debounce', async () => {
		vi.useFakeTimers();
		const { sent, sync } = setup();
		sync.markDirty();
		await sync.flush();
		expect(sent).toEqual([{ t: 'extras', data: { inventory: { 1: 3 } } }]);
		vi.advanceTimersByTime(10_000);
		expect(sent).toHaveLength(1);
	});

	it('a new MpSync re-sends the stash after welcome, then clears it', () => {
		const a = setup();
		a.sync.markDirty();
		const world = World.create(3);
		const sent: unknown[] = [];
		const b = new MpSync(world, null, (m) => sent.push(m), () => ({ inventory: {} }), a.storage, () => {}, 'world-a');
		b.resendStashed();
		expect(sent).toEqual([{ t: 'extras', data: { inventory: { 1: 3 } } }]);
		expect(a.storage.getItem('mp:extras')).toBeNull();
		b.resendStashed();
		expect(sent).toHaveLength(1);
	});

	it('a stash from another world is dropped, never sent', () => {
		const a = setup();
		a.sync.markDirty();
		const sent: unknown[] = [];
		const b = new MpSync(World.create(3), null, (m) => sent.push(m), () => ({}), a.storage, () => {}, 'world-b');
		b.resendStashed();
		expect(sent).toEqual([]);
		expect(a.storage.getItem('mp:extras')).toBeNull();
	});
});
