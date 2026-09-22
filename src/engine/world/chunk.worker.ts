// Chunk worker entry (spec §3.D): shadows + meshing of one chunk over a transferred 3×3 snapshot.
// Import closure must stay free of THREE, DOM and import.meta (Task 5 step 0 checks the built chunk).
import { Chunk } from './chunk';
import { computeChunkShadows } from './shadows';
import { meshChunk } from './mesher';
import { uvFromTable } from '../render/uv-table';
import type { JobPayload, JobReply } from './chunk-jobs';
import type { WorldHeight } from './coords';
import type { World } from './world';

let uvFor: ReturnType<typeof uvFromTable> | null = null;

export function handleMessage(data: unknown, post: (reply: JobReply, transfer: ArrayBuffer[]) => void): void {
	const m = data as { uvTable?: Float32Array } & Partial<JobPayload>;
	if (m.uvTable) {
		uvFor = uvFromTable(m.uvTable);
		return;
	}
	if (!uvFor) throw new Error('chunk.worker: job received before the uv table');
	const job = m as JobPayload;
	const height = job.height as WorldHeight;
	const grid: (Chunk | undefined)[] = new Array(9);
	for (let i = 0; i < 9; i++) {
		const b = job.blocks[i];
		if (!b) continue;
		const dx = Math.floor(i / 3) - 1, dz = (i % 3) - 1;
		// lights/sunlit slot: 0 centre, 1 +x, 2 −x, 3 +z, 4 −z, −1 diagonal (blocks only).
		const li = i === 4 ? 0 : dx === 1 && dz === 0 ? 1 : dx === -1 && dz === 0 ? 2 : dx === 0 && dz === 1 ? 3 : dx === 0 && dz === -1 ? 4 : -1;
		// Chunk.over wraps the received buffers; it allocates only what is missing (lights/sunlit of
		// the diagonals and the centre's sunlit) — never the 320 KB × 9 of `new Chunk`.
		grid[i] = Chunk.over(job.cx + dx, job.cz + dz, height, b, li >= 0 ? job.lights[li] : null, li > 0 ? job.sunlit[li - 1] : null);
	}
	const centre = grid[4]!;
	const at = (cx: number, cz: number) => {
		const dx = cx - job.cx, dz = cz - job.cz;
		return dx < -1 || dx > 1 || dz < -1 || dz > 1 ? undefined : grid[(dx + 1) * 3 + dz + 1];
	};
	// The payload IS the 3×3: a duck-typed World with the members computeChunkShadows reads.
	const world = { height, getChunk: at, chunkInWorld: () => true, ensureChunk: (cx: number, cz: number) => at(cx, cz)! } as unknown as World;
	computeChunkShadows(world, centre);
	const mesh = meshChunk(centre, { px: grid[7], nx: grid[1], pz: grid[5], nz: grid[3] }, uvFor);
	const transfer: ArrayBuffer[] = [centre.sunlit.buffer as ArrayBuffer];
	for (const m2 of [mesh.opaque, mesh.liquid, mesh.translucent]) {
		if (m2) transfer.push(m2.positions.buffer as ArrayBuffer, m2.normals.buffer as ArrayBuffer, m2.uvs.buffer as ArrayBuffer, m2.colors.buffer as ArrayBuffer, m2.indices.buffer as ArrayBuffer);
	}
	post({ id: job.id, sunlit: centre.sunlit, mesh }, transfer);
}

if (typeof self !== 'undefined' && 'postMessage' in self && typeof window === 'undefined') {
	self.onmessage = (e: MessageEvent) => handleMessage(e.data, (reply, transfer) => (self as unknown as Worker).postMessage(reply, transfer));
}
