import { WORLD_CHUNKS_Z } from '../engine/world/coords';
export { MESH_RADIUS, UNMOUNT_RADIUS, DATA_RADIUS } from '../engine/world/radii';

// 20, not the spec's first 30: 30 ms of chunk work + ~15 ms of rendering left no headroom under the 50 ms
// task line, so a first texture upload or one slow chunk tipped the initial load over (bench attribution).
export const BUDGET_STILL_MS = 20;
export const BUDGET_MOVING_MS = 6;

/** 20 ms while the initial ring is loading or the player is still; 6 ms while moving (spec §3.B). */
export function budgetFor(moving: boolean, initialLoad: boolean): number {
	return initialLoad || !moving ? BUDGET_STILL_MS : BUDGET_MOVING_MS;
}

/** Chebyshev distance in chunks from a flat chunk index to the player's chunk. */
export function chebyshev(index: number, playerCx: number, playerCz: number): number {
	const cx = Math.floor(index / WORLD_CHUNKS_Z),
		cz = index % WORLD_CHUNKS_Z;
	return Math.max(Math.abs(cx - playerCx), Math.abs(cz - playerCz));
}

/** Stable sort by Chebyshev distance; ties keep iteration (insertion) order. */
export function orderStream(stream: Iterable<number>, playerCx: number, playerCz: number): number[] {
	const items: { i: number; d: number; k: number }[] = [];
	let k = 0;
	for (const i of stream) items.push({ i, d: chebyshev(i, playerCx, playerCz), k: k++ });
	items.sort((a, b) => a.d - b.d || a.k - b.k); // explicit tie-break on insertion, not on cx/cz
	return items.map((x) => x.i);
}

export type FrameInput = {
	editLane: Set<number>;
	stream: Set<number>;
	playerCx: number;
	playerCz: number;
	moving: boolean;
	initialLoad: boolean;
};
export type FrameResult = { edits: number[]; mounts: number[]; elapsedMs: number };

/**
 * Runs the edit lane fully (budget-exempt), then, only if no edit ran, streams nearest-first while
 * now()-start < budget, min one. `mount(i)` does the work; the scheduler reads the clock around it
 * so neighbour ensureChunk inside mount() is counted. mount() may return false to say "stop
 * streaming this frame" (Task 5's worker-full signal); void/true continue.
 */
export function planFrame(
	input: FrameInput,
	now: () => number,
	mount: (index: number) => boolean | void,
): FrameResult {
	const start = now();
	const edits: number[] = [];
	for (const i of input.editLane) {
		mount(i);
		edits.push(i);
	}
	// The edit lane suppresses the stream budget this frame.
	if (edits.length > 0) return { edits, mounts: [], elapsedMs: now() - start };
	const budget = budgetFor(input.moving, input.initialLoad);
	const mounts: number[] = [];
	for (const i of orderStream(input.stream, input.playerCx, input.playerCz)) {
		// Checked before each mount; the first always runs (a cold mount overshoots the 6 ms
		// budget: that IS the winning 1-chunk/frame probe).
		if (mounts.length > 0 && now() - start >= budget) break;
		const r = mount(i);
		mounts.push(i);
		if (r === false) break; // Task 5: worker at capacity — no more 3×3 halos this frame
	}
	return { edits, mounts, elapsedMs: now() - start };
}
