// TEST ONLY — never imported by chunk-jobs.ts (that would bundle the worker into the main chunk).
// Runs the worker module's handler in-process; every message crosses a structuredClone with the
// transfer list, so the sender's buffers detach exactly as they would with a real Worker.
import type { WorkerFactory, WorkerLike } from './chunk-jobs';
import { handleMessage } from './chunk.worker';

export function inlineWorkerFactory(): WorkerFactory {
	return () => {
		const w: WorkerLike = {
			onmessage: null,
			postMessage(msg: unknown, transfer: Transferable[] = []) {
				const data = structuredClone(msg, { transfer });
				queueMicrotask(() => handleMessage(data, (reply, t) => w.onmessage?.({ data: structuredClone(reply, { transfer: t }) })));
			},
			terminate() {
				w.onmessage = null;
			},
		};
		return w;
	};
}
/**
 * A worker that HOLDS every job until the test calls `deliver`, then replies in post order (a real Worker is FIFO)
 * through the real `handleMessage`, over the snapshot taken at post time. `posted` lists every job ever posted.
 * Used to put a job in flight, change the world, and only then let the reply land.
 */
export function manualWorkerFactory(): {
	factory: WorkerFactory;
	posted: Array<{ cx: number; cz: number }>;
	queued: () => number;
	deliver: (n?: number) => number;
} {
	const queue: unknown[] = [];
	const posted: Array<{ cx: number; cz: number }> = [];
	let worker: WorkerLike | null = null;
	const factory: WorkerFactory = () => {
		const w: WorkerLike = {
			onmessage: null,
			postMessage(msg: unknown, transfer: Transferable[] = []) {
				const data = structuredClone(msg, { transfer }) as { uvTable?: unknown; cx?: number; cz?: number };
				if (data.uvTable) {
					handleMessage(data, () => {});
					return;
				}
				posted.push({ cx: data.cx!, cz: data.cz! });
				queue.push(data);
			},
			terminate() {
				w.onmessage = null;
			},
		};
		worker = w;
		return w;
	};
	const deliver = (n = Infinity): number => {
		let k = 0;
		while (k < n && queue.length > 0) {
			const data = queue.shift();
			handleMessage(data, (reply, t) => worker?.onmessage?.({ data: structuredClone(reply, { transfer: t }) }));
			k++;
		}
		return k;
	};
	return { factory, posted, queued: () => queue.length, deliver };
}
