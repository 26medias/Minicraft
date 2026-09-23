// Crafting spec §7 / §11: the bulk lane, spread re-meshing and neighbourhood freshness, driven through the loop.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { makeLoop } from './test-loop';
import { AIR, BLOCKS, BLOCK_BY_NAME, isLiquid, isSolid } from '../data/blocks.data';
import { chunkIndex, indexOf } from '../engine/world/coords';
import { ChunkJobs } from '../engine/world/chunk-jobs';
import { manualWorkerFactory } from '../engine/world/chunk-jobs.test-utils';
import { meshChunk } from '../engine/world/mesher';
import { buildUvTable, type AtlasJson } from '../engine/render/uv-table';
import { spawnV3 } from '../engine/world/v3/spawn';
import { TNT_PRIME_FUSE } from './tnt';
import type { GameLoop } from './loop';

// Counts every meshChunk call. The manual worker's handleMessage meshes through the same module, but only inside
// deliver(), never inside a tick, so the count taken around one tick is the main thread's.
const mesh = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../engine/world/mesher', async (importOriginal) => {
	const m = await importOriginal<typeof import('../engine/world/mesher')>();
	return { ...m, meshChunk: (...a: Parameters<typeof m.meshChunk>) => { mesh.calls++; return m.meshChunk(...a); } };
});

if (!existsSync('public/atlas.json')) throw new Error('public/atlas.json missing: run npm run build-atlas (it is gitignored)');
const table = buildUvTable(JSON.parse(readFileSync('public/atlas.json', 'utf8')) as AtlasJson);
function fnvBytes(a: ArrayBufferView): number {
	const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
	let h = 2166136261 >>> 0;
	for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619) >>> 0; }
	return h;
}
const removable = (id: number) => isSolid(id) && (BLOCKS[id]?.hardness ?? 0) > 0;
type Manual = ReturnType<typeof manualWorkerFactory>;
type Harness = ReturnType<typeof makeLoop>;

/** Seed-3 loop through a manual worker, streamed until nothing is queued or in flight (every reply delivered each tick). */
function seededManual(): { h: Harness; mw: Manual; jobs: ChunkJobs; pcx: number; pcz: number } {
	const mw = manualWorkerFactory();
	const jobs = new ChunkJobs(mw.factory, table, 2);
	const h = makeLoop({ seed: 3, jobs });
	const s = spawnV3(3);
	h.player.position = [s.x + 0.5, s.h + 2, s.z + 0.5];
	drainManual(h, mw);
	return { h, mw, jobs, pcx: Math.floor(s.x / 16), pcz: Math.floor(s.z / 16) };
}
/** A cell whose 6 neighbours and itself are removable solids with no light at all: an edit there changes no light. */
function darkCell(h: Harness, x: number, z0: number, z1: number): { x: number; y: number; z: number } {
	for (let y = 10; y < 90; y++) for (let z = z0; z <= z1; z++) {
		const around = [[0, 0, 0], [-1, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
		const ok = around.every(([dx, dy, dz]) => {
			const wx = x + dx, wy = y + dy, wz = z + dz;
			const c = h.world.getChunk(Math.floor(wx / 16), Math.floor(wz / 16))!;
			return removable(h.world.getBlock(wx, wy, wz)) && c.lights[indexOf(wx & 15, wy, wz & 15)] === 0;
		});
		if (ok) return { x, y, z };
	}
	throw new Error('no dark cell found');
}
function drainManual(h: Harness, mw: Manual, maxTicks = 800): void {
	for (let k = 0; k < maxTicks; k++) {
		h.tick(1 / 60);
		mw.deliver();
		if (k > 5 && h.loop.stats.streamQueue === 0 && h.loop.stats.editQueue === 0 && h.loop.stats.workerInFlight === 0) return;
	}
	throw new Error(`did not drain in ${maxTicks} ticks`);
}

describe('neighbourhood freshness through the loop (crafting spec §7)', () => {
	it('gate 1 repro: B in flight, a dark border edit in neighbour A (B\'s rev unchanged), B\'s reply is dropped and B re-meshed (catches today\'s own-rev check: the stale mesh mounts over the edit and the hole persists)', () => {
		const { h, mw, jobs, pcx, pcz } = seededManual();
		const { world, loop } = h;
		// A is +x of B, so B is not one of A's south-east shadow chunks (those get a rev bump from applyLightUpdate).
		const B = world.getChunk(pcx, pcz)!;
		const { x, y, z } = darkCell(h, (pcx + 1) * 16, pcz * 16 + 2, pcz * 16 + 13); // A's west border, lx = 0
		loop.markChunkDirty(B.cx, B.cz); // stream lane → mountStream posts B
		h.tick(1 / 60);
		expect(mw.queued()).toBe(1);
		const revB = B.rev;
		// Today's single-block mining path, verbatim (loop.ts updateMining).
		world.setBlock(x, y, z, AIR);
		loop.markChunkDirtyAround(x, z);
		loop.applyLightUpdate(x, y, z);
		expect(B.rev).toBe(revB); // precondition: in the dark, B's own rev does not move
		h.tick(1 / 60); // edit lane meshes A and B synchronously, with the new face
		const dropped: number[] = [];
		const orig = jobs.onDropped;
		jobs.onDropped = (j) => { dropped.push(chunkIndex(j.cx, j.cz)); orig?.(j); };
		mw.deliver(); // B's reply, meshed from the snapshot taken BEFORE the edit
		drainManual(h, mw);
		const want = meshChunk(B, world.neighbors(B), () => [0, 0, 1, 1]);
		expect(fnvBytes(h.meshes().get(chunkIndex(B.cx, B.cz))!.opaque.positions)).toBe(fnvBytes(want.opaque.positions));
		expect(dropped).toContain(chunkIndex(B.cx, B.cz));
	}, 60_000);
});
type Lanes = { editLane: Set<number>; bulkLane?: Set<number>; shadowOnly: Set<number> };
const lanes = (loop: GameLoop) => loop as unknown as Lanes;
const TNT = BLOCK_BY_NAME['tnt'].id;
/** A real TNT at the corner of chunks (21..22, 12..13) (lx = lz = 0 of chunk (22, 13)), two below the surface. */
function cornerBlast(h: Harness): { anchor: number; others: number[] } {
	const x = 22 * 16, z = 13 * 16;
	let y = h.world.height - 1;
	while (y > 0 && !isSolid(h.world.getBlock(x, y, z))) y--;
	y -= 2;
	h.world.setBlock(x, y, z, TNT);
	const L = lanes(h.loop);
	L.editLane.clear(); L.bulkLane?.clear(); L.shadowOnly.clear();
	expect(h.loop.ignite({ x, y, z, face: 'py', distance: 1 })).toBe(true);
	h.loop.simulate(TNT_PRIME_FUSE + 0.1);
	expect(h.world.getBlock(x, y, z)).toBe(AIR);
	const anchor = chunkIndex(22, 13);
	const others = [...new Set([...L.editLane, ...(L.bulkLane ?? [])])].filter((i) => i !== anchor);
	for (const i of [chunkIndex(21, 12), chunkIndex(21, 13), chunkIndex(22, 12)]) expect(others).toContain(i);
	return { anchor, others };
}
/** Indices whose mounted mesh object changed across `fn` (the renderer stub stores the last mesh per index). */
function mountedDuring(h: Harness, fn: () => void): number[] {
	const before = new Map(h.meshes());
	fn();
	return [...h.meshes()].filter(([i, m]) => before.get(i) !== m).map(([i]) => i).sort((a, b) => a - b);
}

describe('spread re-meshing (crafting spec §7)', () => {
	it('lane assignment: after a chunk-corner TNT blast only the anchor chunk is in the edit lane; the other touched chunks are in the bulk lane, and none of them is flagged shadow-only (catches routing through applyLightUpdate, which puts every touched chunk in the edit lane — today\'s build)', () => {
		const { h } = seededManual();
		const { anchor, others } = cornerBlast(h);
		const L = lanes(h.loop);
		expect([...L.editLane]).toEqual([anchor]);
		for (const i of others) {
			expect(L.bulkLane!.has(i)).toBe(true);
			expect(L.shadowOnly.has(i)).toBe(false);
		}
	}, 60_000);

	it('the edit frame meshes the anchor only: one meshChunk call on the main thread, one mount, the rest posted (catches "everything in the edit lane", today\'s build: 4 synchronous meshes in one frame)', () => {
		const { h, mw } = seededManual();
		const { anchor, others } = cornerBlast(h);
		const calls = mesh.calls;
		const mounted = mountedDuring(h, () => h.tick(1 / 60));
		expect(mesh.calls - calls).toBe(1);
		expect(mounted).toEqual([anchor]);
		expect(mw.queued()).toBe(2); // the worker's two slots took the nearest bulk chunks
		for (const i of others) expect(mounted).not.toContain(i);
		drainManual(h, mw);
		for (const i of others) expect(lanes(h.loop).bulkLane!.has(i)).toBe(false);
	}, 60_000);

	it('without a worker, at most one bulk chunk is meshed per frame, and all of them within bulk-count + 1 frames (catches draining the bulk lane synchronously in one frame)', () => {
		const h = makeLoop({ seed: 3 });
		const s = spawnV3(3);
		h.player.position = [s.x + 0.5, s.h + 2, s.z + 0.5];
		for (let k = 0; k < 800 && !(k > 5 && h.loop.stats.streamQueue === 0 && h.loop.stats.editQueue === 0); k++) h.tick(1 / 60);
		const { anchor, others } = cornerBlast(h);
		const seen = new Set<number>();
		for (let frame = 0; frame <= others.length + 1; frame++) {
			const mounted = mountedDuring(h, () => h.tick(1 / 60));
			if (frame === 0) expect(mounted).toContain(anchor);
			const bulkNow = mounted.filter((i) => others.includes(i));
			expect(bulkNow.length).toBeLessThanOrEqual(1);
			for (const i of bulkNow) seen.add(i);
		}
		expect([...seen].sort((a, b) => a - b)).toEqual([...others].sort((a, b) => a - b));
	}, 120_000);

	it('single-block mining at lx = 15 still mounts both chunks in the frame the block breaks (catches the bulk lane leaking into single edits)', () => {
		const mw = manualWorkerFactory();
		const h = makeLoop({ jobs: new ChunkJobs(mw.factory, table, 2) });
		// makeLoop() clears chunk (16,16); x = 271 is its lx = 15, so (17,16) must re-mesh too. Yaw 0 looks −z.
		h.player.flying = true;
		h.player.position = [271.5, 40, 270.5];
		h.world.setBlock(271, 41, 267, BLOCK_BY_NAME['stone'].id);
		h.loop.setLeftMouseDown(true);
		let mounted: number[] = [];
		for (let k = 0; k < 200 && h.world.getBlock(271, 41, 267) !== AIR; k++) mounted = mountedDuring(h, () => h.tick(0.05));
		expect(h.world.getBlock(271, 41, 267)).toBe(AIR);
		expect(mounted).toContain(chunkIndex(16, 16));
		expect(mounted).toContain(chunkIndex(17, 16));
	}, 60_000);
});
describe('no drop cascade (crafting spec §7)', () => {
	it('a full 3×3 blast through a 2-slot worker replying in order makes at most bulk-count + 1 posts of bulk chunks (catches onJobReply bumping every mounted neighbour\'s rev: each landing reply drops the other in-flight bulk job)', () => {
		const { h, mw } = seededManual();
		const L = lanes(h.loop);
		// A 24 × 5 × 24 slab underground around chunk (21, 12), at the first depth where every chunk of its 3×3 loses
		// blocks and no liquid touches it (seed 3 has a cavern under (22, 13) at y 38–46; lava flowing into the hole
		// would put chunks in the edit lane through the liquid scheduler and hide the cascade).
		const slab = (y0: number, pad: number) => {
			const out: Array<{ x: number; y: number; z: number }> = [];
			for (let x = 21 * 16 - 4 - pad; x < 22 * 16 + 4 + pad; x++) for (let z = 12 * 16 - 4 - pad; z < 13 * 16 + 4 + pad; z++) for (let y = y0 - pad; y < y0 + 5 + pad; y++) out.push({ x, y, z });
			return out;
		};
		let y0 = 8;
		for (; y0 < 100; y0++) {
			if (slab(y0, 1).some((c) => isLiquid(h.world.getBlock(c.x, c.y, c.z)))) continue;
			const hit = new Set(slab(y0, 0).filter((c) => removable(h.world.getBlock(c.x, c.y, c.z))).map((c) => chunkIndex(Math.floor(c.x / 16), Math.floor(c.z / 16))));
			if (hit.size === 9) break;
		}
		expect(y0).toBeLessThan(100);
		const cells = slab(y0, 0);
		L.editLane.clear(); L.bulkLane!.clear(); L.shadowOnly.clear();
		const { removed } = h.loop.removeBlocks(cells, { x: 21 * 16 + 8, y: y0 + 1, z: 12 * 16 + 8 });
		expect(removed.length).toBeGreaterThan(500);
		const bulk = [...L.bulkLane!];
		for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (dx || dz) expect(bulk).toContain(chunkIndex(21 + dx, 12 + dz));
		const from = mw.posted.length;
		let frames = 0;
		for (; frames < 60 && L.bulkLane!.size > 0; frames++) {
			h.tick(1 / 60);
			mw.deliver(); // the worker answers both slots, oldest first
		}
		expect(L.bulkLane!.size).toBe(0);
		expect(L.editLane.size).toBe(0);
		const posts = mw.posted.slice(from).filter((p) => bulk.includes(chunkIndex(p.cx, p.cz))).length;
		expect(posts).toBeLessThanOrEqual(bulk.length + 1);
	}, 60_000);
});
