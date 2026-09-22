import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { World } from './world';
import { computeChunkShadows, ensureShadowNeighbourhood } from './shadows';
import { meshChunk, type ChunkMeshResult } from './mesher';
import { ChunkJobs, snapshotFor } from './chunk-jobs';
import { inlineWorkerFactory } from './chunk-jobs.test-utils';
import { buildUvTable, uvFromTable, type AtlasJson } from '../render/uv-table';
import { spawnV3 } from './v3/spawn';

if (!existsSync('public/atlas.json')) throw new Error('public/atlas.json missing: run npm run build-atlas (it is gitignored)');
const atlas = JSON.parse(readFileSync('public/atlas.json', 'utf8')) as AtlasJson;
const table = buildUvTable(atlas);
const uvFor = uvFromTable(table);
function fnvBytes(a: ArrayBufferView): number {
	const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
	let h = 2166136261 >>> 0;
	for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619) >>> 0; }
	return h;
}
const meshHash = (m: ChunkMeshResult) =>
	[m.opaque, m.liquid, m.translucent].map((x) => (x ? [fnvBytes(x.positions), fnvBytes(x.colors), fnvBytes(x.uvs), fnvBytes(x.indices)] : null));

function world12() {
	const w = World.create(3);
	const s = spawnV3(3);
	const pcx = Math.floor(s.x / 16), pcz = Math.floor(s.z / 16);
	const picks: [number, number][] = [];
	for (let dx = -2; dx <= 2; dx++) {
		for (let dz = -2; dz <= 2; dz++) {
			w.ensureChunk(pcx + dx, pcz + dz);
			if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1 && picks.length < 12) picks.push([pcx + dx, pcz + dz]);
		}
	}
	for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) w.getChunk(pcx + dx, pcz + dz)!.shadowsDirty = true;
	return { w, picks };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('ChunkJobs (spec §6.3)', () => {
	it('worker output is byte-identical to the synchronous path for 9 chunks (mutant: omit sunlit×4 → 0/9)', { timeout: 30_000 }, async () => {
		const { w, picks } = world12();
		// sync reference
		const ref = new Map<string, { s: number; m: unknown }>();
		for (const [cx, cz] of picks) ensureShadowNeighbourhood(w, w.getChunk(cx, cz)!);
		for (const c of w.allChunks()) computeChunkShadows(w, c);
		for (const [cx, cz] of picks) {
			const c = w.getChunk(cx, cz)!;
			ref.set(`${cx},${cz}`, { s: fnvBytes(c.sunlit), m: meshHash(meshChunk(c, w.neighbors(c), uvFor)) });
		}
		const jobs = new ChunkJobs(inlineWorkerFactory(), table, 2);
		let ok = 0;
		jobs.onReply = (job, sunlit, mesh) => {
			const r = ref.get(`${job.cx},${job.cz}`)!;
			if (fnvBytes(sunlit) === r.s && JSON.stringify(meshHash(mesh)) === JSON.stringify(r.m)) ok++;
		};
		for (const [cx, cz] of picks) {
			while (!jobs.post(w, w.getChunk(cx, cz)!)) await flush();
		}
		while (jobs.inFlight() > 0) await flush();
		expect(ok).toBe(picks.length);
	});

	it("the sender's snapshot buffers are detached after post (mutant: stub calls the function directly → not detached)", () => {
		const { w, picks } = world12();
		const c = w.getChunk(...picks[0])!;
		const { payload, transfer } = snapshotFor(w, c);
		const clone = structuredClone(payload, { transfer });
		expect(payload.blocks[4]!.byteLength).toBe(0);
		expect(clone.blocks[4]!.byteLength).toBe(c.blocks.byteLength);
		expect(c.blocks.byteLength).toBeGreaterThan(0); // the World's own arrays are untouched
	});

	it('a stale reply (rev moved or chunk replaced) is dropped and re-dirties; a fresh reply is applied (mutants: drop all replies; drop without re-dirty)', async () => {
		const { w, picks } = world12();
		const c = w.getChunk(...picks[0])!;
		const jobs = new ChunkJobs(inlineWorkerFactory(), table, 2);
		const applied: number[] = [], dropped: number[] = [];
		jobs.onReply = (j) => applied.push(j.id);
		jobs.onDropped = (j) => dropped.push(j.id);
		jobs.post(w, c);
		c.rev++; // stale by rev
		while (jobs.inFlight() > 0) await flush();
		expect(dropped.length).toBe(1);
		expect(applied.length).toBe(0);
		jobs.post(w, c); // fresh
		while (jobs.inFlight() > 0) await flush();
		expect(applied.length).toBe(1);
		jobs.post(w, c);
		w.dropChunk(c.cx, c.cz);
		w.ensureChunk(c.cx, c.cz); // stale by identity
		while (jobs.inFlight() > 0) await flush();
		expect(dropped.length).toBe(2);
	});

	it('at most 2 jobs in flight', () => {
		const { w, picks } = world12();
		const jobs = new ChunkJobs(inlineWorkerFactory(), table, 2);
		expect(jobs.post(w, w.getChunk(...picks[0])!)).toBe(true);
		expect(jobs.post(w, w.getChunk(...picks[1])!)).toBe(true);
		expect(jobs.post(w, w.getChunk(...picks[2])!)).toBe(false);
	});
});
