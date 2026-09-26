/**
 * Jev (experiment E2, "Enderman 2"): the hosted SystemOne (api.typesafe.ai) behind brain2's `LayaEngine` contract,
 * so the choice experts can ask it the same `Choice` questions they would ask Laya. The wire shape is the builder's
 * (`jevBody`: SystemOne + `model`), the key a Bearer header. The key is never logged or part of an error message.
 * Its own 3 s timeout, or the caller's signal, whichever comes first.
 */
import type { Answer, Choice } from '../../brain/brain.js';
import { mapResponse } from '../../brain/systemone.js';
import { JEV_URL, jevBody } from '../../builder/engines.js';
import type { LayaEngine } from '../experts/expert.js';

export const JEV_TIMEOUT_MS = 3000;

export class Jev implements LayaEngine {
	private readonly key: string;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;

	constructor(o: { key: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
		this.key = o.key;
		this.fetchImpl = o.fetchImpl ?? fetch;
		this.timeoutMs = o.timeoutMs ?? JEV_TIMEOUT_MS;
	}

	/** No health endpoint: a key is all it needs; a failed call falls back per call. */
	healthy(): boolean {
		return true;
	}

	async ask(state: string, q: Choice, signal: AbortSignal): Promise<Answer> {
		const res = await this.fetchImpl(JEV_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/json', Authorization: `Bearer ${this.key}` },
			body: JSON.stringify(jevBody(state, q.instructions, q.options)),
			signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
		});
		if (!res.ok) throw new Error(`jev: HTTP ${res.status}`);
		const a = mapResponse((await res.json()) as Parameters<typeof mapResponse>[0], Object.keys(q.options));
		if (!Object.hasOwn(q.options, a.best)) throw new Error(`jev: answer "${a.best}" is not an offered option`);
		return a;
	}
}
