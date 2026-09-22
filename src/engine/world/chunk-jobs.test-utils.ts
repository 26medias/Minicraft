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
