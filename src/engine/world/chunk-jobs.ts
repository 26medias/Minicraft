// Main-thread side of the chunk worker (spec §3.D). Never imports the worker module or the
// test-only inline factory: the worker is constructed through `WorkerFactory` so vitest (node,
// no `Worker` global) injects an in-process stub and Vite bundles the worker as its own chunk.
import type { Chunk } from './chunk';
import type { World } from './world';
import type { ChunkMeshResult } from './mesher';

export type WorkerLike = {
	postMessage(msg: unknown, transfer?: Transferable[]): void;
	onmessage: ((e: { data: unknown }) => void) | null;
	terminate(): void;
};
export type WorkerFactory = () => WorkerLike;
/** One chunk of the copied 3×3 as it was at post time; `chunk` undefined = nothing there (world edge). */
export type JobSlot = { chunk: Chunk | undefined; rev: number };
/** `slots`: the 3×3 in grid order (dx+1)*3+(dz+1), centre = slots[4] = { chunk, rev }. */
export type ChunkJob = { id: number; cx: number; cz: number; chunk: Chunk; rev: number; slots: JobSlot[] };
/** blocks: the 3×3 in grid order (dx+1)*3+(dz+1); lights: [centre, +x, −x, +z, −z]; sunlit: [+x, −x, +z, −z]. */
export type JobPayload = {
	id: number;
	cx: number;
	cz: number;
	height: number;
	blocks: (Uint16Array | null)[];
	lights: (Uint16Array | null)[];
	sunlit: (Uint8Array | null)[];
};
export type JobReply = { id: number; sunlit: Uint8Array; mesh: ChunkMeshResult };

/**
 * Copy-then-transfer snapshot of the 3×3: `slice()` copies of blocks×9, lights×5 and the axis
 * neighbours' sunlit×4 (the mesher samples them at border corners — without them 0/12 chunks
 * matched, E-B1). The World's own arrays are never detached; the copies' buffers go in `transfer`.
 */
export function snapshotFor(world: World, chunk: Chunk): { payload: JobPayload; transfer: ArrayBuffer[]; slots: JobSlot[] } {
	const blocks: (Uint16Array | null)[] = [];
	const lights: (Uint16Array | null)[] = [];
	const sunlit: (Uint8Array | null)[] = [];
	const transfer: ArrayBuffer[] = [];
	const slots: JobSlot[] = [];
	for (let dx = -1; dx <= 1; dx++) {
		for (let dz = -1; dz <= 1; dz++) {
			const n = world.getChunk(chunk.cx + dx, chunk.cz + dz);
			slots.push({ chunk: n, rev: n ? n.rev : 0 });
			const b = n ? n.blocks.slice() : null;
			blocks.push(b);
			if (b) transfer.push(b.buffer as ArrayBuffer);
		}
	}
	const axis = [
		chunk,
		world.getChunk(chunk.cx + 1, chunk.cz),
		world.getChunk(chunk.cx - 1, chunk.cz),
		world.getChunk(chunk.cx, chunk.cz + 1),
		world.getChunk(chunk.cx, chunk.cz - 1),
	];
	for (let i = 0; i < axis.length; i++) {
		const n = axis[i];
		const l = n ? n.lights.slice() : null;
		lights.push(l);
		if (l) transfer.push(l.buffer as ArrayBuffer);
		if (i === 0) continue; // the centre's sunlit is the worker's output, not an input
		const s = n ? n.sunlit.slice() : null;
		sunlit.push(s);
		if (s) transfer.push(s.buffer as ArrayBuffer);
	}
	return { payload: { id: 0, cx: chunk.cx, cz: chunk.cz, height: chunk.height, blocks, lights, sunlit }, transfer, slots };
}

type PendingJob = ChunkJob & { world: World };

/**
 * Crafting spec §7, neighbourhood freshness: the worker meshed a copy of all 9 chunks, so the reply is valid only if every
 * slot still holds the SAME object at the SAME rev. Identity catches a neighbour evicted and regenerated at a low rev; the
 * neighbours' revs catch a border edit that left the centre's rev alone (a face missing across the border otherwise).
 */
function neighbourhoodFresh(job: PendingJob): boolean {
	let k = 0;
	for (let dx = -1; dx <= 1; dx++) {
		for (let dz = -1; dz <= 1; dz++, k++) {
			const slot = job.slots[k];
			const now = job.world.getChunk(job.cx + dx, job.cz + dz);
			if (now !== slot.chunk) return false;
			if (now && now.rev !== slot.rev) return false;
		}
	}
	return true;
}

export class ChunkJobs {
	private readonly worker: WorkerLike;
	private readonly pending = new Map<number, PendingJob>();
	private nextId = 1;
	/** Called only when all 9 slots of the job's 3×3 hold the same chunk objects at the same revs (neighbourhoodFresh). */
	onReply: ((job: ChunkJob, sunlit: Uint8Array, mesh: ChunkMeshResult) => void) | null = null;
	/** Stale reply (a rev moved or a chunk was replaced anywhere in the 3×3): the loop re-dirties the chunk. */
	onDropped: ((job: ChunkJob) => void) | null = null;

	constructor(factory: WorkerFactory, uvTable: Float32Array, private readonly maxInFlight = 2) {
		this.worker = factory();
		this.worker.postMessage({ uvTable });
		this.worker.onmessage = (e) => this.handle(e.data as JobReply);
	}

	/** false at capacity (the caller keeps the chunk dirty and stops streaming this frame). */
	post(world: World, chunk: Chunk): boolean {
		if (this.pending.size >= this.maxInFlight) return false;
		const id = this.nextId++;
		const { payload, transfer, slots } = snapshotFor(world, chunk);
		payload.id = id;
		this.pending.set(id, { id, cx: chunk.cx, cz: chunk.cz, chunk, rev: chunk.rev, slots, world });
		this.worker.postMessage(payload, transfer);
		return true;
	}

	inFlight(): number {
		return this.pending.size;
	}

	terminate(): void {
		this.pending.clear();
		this.worker.terminate();
	}

	private handle(reply: JobReply): void {
		const job = this.pending.get(reply.id);
		if (!job) return;
		this.pending.delete(reply.id); // before the callbacks: a re-dirty in onDropped may post again
		if (neighbourhoodFresh(job)) this.onReply?.(job, reply.sunlit, reply.mesh);
		else this.onDropped?.(job);
	}
}
