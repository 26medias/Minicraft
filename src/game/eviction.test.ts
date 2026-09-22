import { describe, it, expect } from 'vitest';
import { World } from '../engine/world/world';
import { UNMOUNT_RADIUS, DATA_RADIUS } from './chunk-scheduler';
import { FOG_FAR, FOG_NEAR } from '../engine/render/renderer';
import { applySave } from './apply-save';
import { BLOCK_BY_NAME } from '../data/blocks.data';
import { indexOf, blocksPerChunk } from '../engine/world/coords';
// makeLoop lives in src/game/test-loop.ts since Task 4 (renderer stub has unmountChunk and meshes())
import { makeLoop } from './test-loop';
import { LiquidScheduler, UNKNOWN_BLOCK } from './liquid-scheduler';

const water = BLOCK_BY_NAME['water'].id;
function fnv(a: ArrayLike<number>) { let h = 2166136261 >>> 0; for (let i = 0; i < a.length; i++) { h ^= a[i]; h = Math.imul(h, 16777619) >>> 0; } return h; }

describe('eviction (spec §3.E, §6.4)', () => {
	it('drops the unmodified chunk and keeps the modified one at the same distance beyond DATA_RADIUS (mutant: no-op evictor)', () => {
		const { world, player, tick } = makeLoop();
		player.position = [16 * 16 + 8, 60, 16 * 16 + 8];
		const far = DATA_RADIUS + 1;
		const a = world.ensureChunk(16 + far, 16), b = world.ensureChunk(16, 16 + far);
		b.modified = true;
		tick(1 / 60);
		expect(world.getChunk(16 + far, 16)).toBeUndefined();
		expect(world.getChunk(16, 16 + far)).toBe(b);
		expect(a.modified).toBe(false);
	});

	it('re-entry regenerates byte-identical blocks (mutant: different seed)', () => {
		const w = World.create(3);
		const h = fnv(w.ensureChunk(10, 10).blocks);
		w.dropChunk(10, 10);
		expect(fnv(w.ensureChunk(10, 10).blocks)).toBe(h);
	});

	it('an evicted index leaves mountedChunks and a re-entered chunk is re-meshed (mutant: leave the entry)', { timeout: 60_000 }, () => {
		const { loop, player, tick, mounts } = makeLoop();
		player.position = [16 * 16 + 8, 60, 16 * 16 + 8];
		for (let k = 0; k < 400; k++) tick(1 / 60);             // fill the mesh ring
		const before = mounts();
		player.position = [(16 + UNMOUNT_RADIUS + 3) * 16 + 8, 60, 16 * 16 + 8]; // walk away past the unmount ring
		for (let k = 0; k < 400; k++) tick(1 / 60);
		player.position = [16 * 16 + 8, 60, 16 * 16 + 8];       // come back
		for (let k = 0; k < 400; k++) tick(1 / 60);
		expect(mounts()).toBeGreaterThan(before);                // the origin chunk was mounted again
		expect(loop.stats.mounted).toBeLessThanOrEqual((2 * UNMOUNT_RADIUS + 1) ** 2);
	});

	it('fog far is the formula MESH_RADIUS*16-8 = 88 and near is 40, a 48-block fade (parent play-test: the 8-block band looked like a wall appearing)', () => {
		expect(FOG_FAR).toBe(6 * 16 - 8); expect(FOG_NEAR).toBe(40);
	});

	it('hasLiquid is recomputed by applySave for a chunk with placed water (mutant: flag only from generation)', () => {
		const blocks = new Uint16Array(blocksPerChunk(256)); blocks[indexOf(3, 130, 3)] = water;
		const w2 = World.create(3);
		// A NATURALLY DRY chunk (generation sets hasLiquid = false there), so only applySave's recompute can make it true.
		let cx = 12, cz = 12;
		while (w2.ensureChunk(cx, cz).hasLiquid) { cx++; if (cx > 20) { cx = 12; cz++; } }
		expect(w2.getChunk(cx, cz)!.hasLiquid).toBe(false);
		applySave(w2, { version: 3, id: '11111111-1111-4111-8111-111111111111', seed: 3, name: 'x', createdAt: 0, updatedAt: 0, height: 256, genVersion: 3, player: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hotbar: [], selected: 0 }, chunks: [{ cx, cz, blocks }] } as never);
		expect(w2.getChunk(cx, cz)!.hasLiquid).toBe(true);
	});
});

describe('liquid scheduler reads and the data ring (spec §3.E)', () => {
	it('a read outside the ring never creates a chunk; inside it still does (mutant: plain World.getBlock)', () => {
		const w = new World(1);
		w.ensureChunk(16, 16);
		const s = new LiquidScheduler(w, () => {}, () => {}, (x, z) => Math.max(Math.abs((x >> 4) - 16), Math.abs((z >> 4) - 16)) <= 1);
		const read = (s as unknown as { read(x: number, y: number, z: number): number }).read.bind(s);
		const before = w.chunkCount;
		expect(read(16 * 30 + 3, 10, 16 * 30 + 3)).toBe(UNKNOWN_BLOCK); // 14 chunks away, dropped/never generated
		expect(w.chunkCount).toBe(before);
		expect(s.outsideRingMisses).toBe(1);
		const m = w.ensureChunk(30, 30); m.modified = true;                 // a retained modified chunk beyond the ring reads for real
		expect(read(16 * 30 + 3, 10, 16 * 30 + 3)).toBe(m.get(3, 10, 3));
		read(16 * 17 + 3, 10, 16 * 17 + 3);                                  // ring 1: ensureChunk as before
		expect(w.getChunk(17, 17)).toBeDefined();
	});
});
