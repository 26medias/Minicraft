// Task 4 (protocol/bot SDK plan): applyRemoteOp/applyRemoteOps is the per-cell core of
// GameLoop.drainRemote, pulled out so the bot SDK can share the exact remote-edit write path.
import { describe, it, expect } from 'vitest';
import { World } from './world';
import { ChunkOverlay } from './overlay';
import { AIR, BLOCK_BY_NAME } from '../../data/blocks.data';
import { worldToChunk, indexOf } from './coords';
import type { Op } from '../../net/protocol';
import { applyRemoteOp, applyRemoteOps } from './apply-remote';

const SEED = 3;
const STONE = BLOCK_BY_NAME['stone'].id;

describe('applyRemoteOp', () => {
	it('out of bounds: skipped ({ applied: false, oldId: null }), nothing loaded or written', () => {
		const w = World.create(SEED);
		const before = w.chunkCount;
		const r = applyRemoteOp(w, [-1, 40, 0, STONE, 0, 0]);
		expect(r).toEqual({ applied: false, oldId: null });
		expect(w.chunkCount).toBe(before);
	});

	it('an unloaded chunk: { applied: false, oldId: null }, never loaded (never ensureChunk)', () => {
		const w = World.create(SEED);
		const before = w.chunkCount;
		const r = applyRemoteOp(w, [16 * 7 + 1, 40, 16 * 7 + 1, STONE, 0, 0]);
		expect(r).toEqual({ applied: false, oldId: null });
		expect(w.chunkCount).toBe(before);
		expect(w.getChunk(7, 7)).toBeUndefined();
	});

	it('same id and fluid on a loaded chunk: not applied, oldId is the current (unchanged) id', () => {
		const w = World.create(SEED);
		const c = w.ensureChunk(2, 2);
		const x = 16 * 2 + 3, y = 40, z = 16 * 2 + 3;
		const cur = c.get(3, y, 3);
		const fluid = c.fluidMeta.get(indexOf(3, y, 3)) ?? 0;
		const r = applyRemoteOp(w, [x, y, z, cur, fluid, 0]);
		expect(r).toEqual({ applied: false, oldId: cur });
		expect(c.get(3, y, 3)).toBe(cur);
	});

	it('a changed id: writeRemote runs (the block changes), applied is its return value, oldId is the previous id', () => {
		const w = World.create(SEED);
		const c = w.ensureChunk(2, 2);
		const x = 16 * 2, y = 40, z = 16 * 2;
		const cur = c.get(0, y, 0);
		const next = cur === STONE ? AIR : STONE;
		const r = applyRemoteOp(w, [x, y, z, next, 0, 0]);
		expect(r).toEqual({ applied: true, oldId: cur });
		expect(c.get(0, y, 0)).toBe(next);
		expect(c.modified).toBe(true);
	});

	it('a fluid-only change on a loaded chunk: applied true, oldId the previous (same) block id', () => {
		const w = World.create(SEED);
		const c = w.ensureChunk(2, 2);
		const x = 16 * 2 + 4, y = 40, z = 16 * 2 + 4;
		// Force a known block so the fluid-meta write is unambiguous.
		w.writeRemote(x, y, z, STONE, 0);
		const r = applyRemoteOp(w, [x, y, z, STONE, 0x82, 0]);
		expect(r).toEqual({ applied: true, oldId: STONE });
		expect(c.fluidMeta.get(indexOf(4, y, 4))).toBe(0x82);
	});
});

describe('applyRemoteOps', () => {
	it('updates the overlay for every op, loaded chunk or not — even out of bounds', () => {
		const w = World.create(SEED);
		w.ensureChunk(2, 2);
		const overlay = new ChunkOverlay();
		const ops: Op[] = [
			[-1, 40, 0, STONE, 0, 0], // out of bounds
			[16 * 7 + 1, 40, 16 * 7 + 1, STONE, 0, 5], // unloaded chunk
			[16 * 2 + 1, 40, 16 * 2 + 1, STONE, 0, 0], // loaded chunk
		];
		applyRemoteOps(w, overlay, ops);
		expect(overlay.get(-1, 40, 0)).toEqual([STONE, 0, 0]);
		expect(overlay.get(16 * 7 + 1, 40, 16 * 7 + 1)).toEqual([STONE, 0, 5]);
		expect(overlay.get(16 * 2 + 1, 40, 16 * 2 + 1)).toEqual([STONE, 0, 0]);
		expect(w.getChunk(7, 7)).toBeUndefined();
	});

	it('calls onApplied once per op with (op, result), in order', () => {
		const w = World.create(SEED);
		w.ensureChunk(2, 2);
		const overlay = new ChunkOverlay();
		const ops: Op[] = [
			[16 * 7 + 1, 40, 16 * 7 + 1, STONE, 0, 0], // unloaded -> not applied, oldId null
			[16 * 2, 40, 16 * 2, STONE, 0, 0], // loaded, may or may not change
		];
		const seen: Array<{ op: Op; applied: boolean; oldId: number | null }> = [];
		applyRemoteOps(w, overlay, ops, (op, r) => seen.push({ op, applied: r.applied, oldId: r.oldId }));
		expect(seen.length).toBe(2);
		expect(seen[0]).toEqual({ op: ops[0], applied: false, oldId: null });
		expect(seen[1].op).toBe(ops[1]);
	});

	it('parity: the same op sequence gives the same blocks as the reduced client pattern (overlay.set then writeRemote — src/game/mp-liquid.test.ts Client.receive, echo not applicable since by differs)', () => {
		const preload: Array<[number, number]> = [[2, 2], [2, 3], [3, 2]];
		const wRef = World.create(SEED), wSub = World.create(SEED);
		const ovRef = new ChunkOverlay(), ovSub = new ChunkOverlay();
		for (const [cx, cz] of preload) { wRef.ensureChunk(cx, cz); wSub.ensureChunk(cx, cz); }

		const ops: Op[] = [];
		for (let i = 0; i < 40; i++) {
			const x = 16 * 2 + (i % 16), y = 30 + (i % 10), z = 16 * 2 + ((i * 3) % 16);
			ops.push([x, y, z, i % 2 === 0 ? STONE : AIR, 0, 0]);
		}
		// A cell in an unloaded chunk, and a repeat of an already-applied cell (a genuine no-op the second time).
		ops.push([16 * 10 + 1, 40, 16 * 10 + 1, STONE, 0, 0]);
		ops.push([ops[0][0], ops[0][1], ops[0][2], ops[0][3], 0, 0]);

		// Reduced client: MpSync.onEdit + GameLoop.enqueueRemote/drainRemote, reduced to the world.
		for (const op of ops) {
			const [x, y, z, id, fluid, color] = op;
			ovRef.set(x, y, z, id, fluid, color);
			wRef.writeRemote(x, y, z, id, fluid);
		}

		applyRemoteOps(wSub, ovSub, ops);

		for (const [x, y, z] of [[16 * 2, 30, 16 * 2], [16 * 2 + 1, 31, 16 * 2 + 3], [16 * 10 + 1, 40, 16 * 10 + 1]]) {
			expect(wSub.getBlock(x, y, z)).toBe(wRef.getBlock(x, y, z));
		}
		for (const op of ops) {
			const [x, y, z] = op;
			expect(ovSub.get(x, y, z)).toEqual(ovRef.get(x, y, z));
			const { cx, cz } = worldToChunk(x, z);
			if (wRef.getChunk(cx, cz)) expect(wSub.getBlock(x, y, z)).toBe(wRef.getBlock(x, y, z));
			else expect(wSub.getChunk(cx, cz)).toBeUndefined();
		}
	});
});
