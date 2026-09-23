// Crafting spec §7 / §11: the bulk lane, spread re-meshing and neighbourhood freshness, driven through the loop.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { makeLoop } from './test-loop';
import { AIR, BLOCKS, isSolid } from '../data/blocks.data';
import { chunkIndex, indexOf } from '../engine/world/coords';
import { ChunkJobs } from '../engine/world/chunk-jobs';
import { manualWorkerFactory } from '../engine/world/chunk-jobs.test-utils';
import { meshChunk } from '../engine/world/mesher';
import { buildUvTable, type AtlasJson } from '../engine/render/uv-table';
import { spawnV3 } from '../engine/world/v3/spawn';

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
