/**
 * The builder's choice engines: Laya (local SystemOne, /v1/systemone) and Jev (hosted SystemOne, api.typesafe.ai).
 * Both speak the same wire shape (`buildRequest`/`mapResponse` from brain/systemone.ts); Jev adds `model` and a Bearer
 * key. The key is read at runtime from the repo's .env and never logged or printed.
 */
import { buildRequest, mapResponse } from '../brain/systemone.js';

export interface ChoiceAnswer { choice: string; probs: Record<string, number> }
export interface ChoiceEngine {
	readonly name: string;
	choose(state: string, instructions: string, options: Record<string, string>): Promise<ChoiceAnswer>;
}

type Fetch = typeof fetch;

async function post(fetchImpl: Fetch, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number, options: Record<string, string>): Promise<ChoiceAnswer> {
	const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const a = mapResponse((await res.json()) as Parameters<typeof mapResponse>[0], Object.keys(options));
	if (!Object.hasOwn(options, a.best)) throw new Error(`answer "${a.best}" is not an offered option`);
	return { choice: a.best, probs: a.probs };
}

/** Laya at `url` (e.g. http://127.0.0.1:8000), 400 ms by default. */
export function layaEngine(url: string, fetchImpl: Fetch = fetch, timeoutMs = 400): ChoiceEngine {
	return {
		name: 'laya',
		choose: (state, instructions, options) => post(fetchImpl, `${url}/v1/systemone`, {}, buildRequest(state, { type: 'choice', instructions, options }), timeoutMs, options),
	};
}

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';

/** The Jev request body: the SystemOne shape plus `model`. */
export function jevBody(state: string, instructions: string, options: Record<string, string>): Record<string, unknown> {
	return { model: JEV_MODEL, ...buildRequest(state, { type: 'choice', instructions, options }) };
}

/** Jev (hosted), 3 s by default. `key` is never part of an error message. */
export function jevEngine(key: string, fetchImpl: Fetch = fetch, timeoutMs = 3000): ChoiceEngine {
	return {
		name: 'jev',
		choose: (state, instructions, options) => post(fetchImpl, JEV_URL, { Authorization: `Bearer ${key}` }, jevBody(state, instructions, options), timeoutMs, options),
	};
}

/** The JEV_API_KEY value of a .env file's text, cleaned (quotes, whitespace, \r and stray characters), or null. */
export function parseJevKey(envText: string | null): string | null {
	if (!envText) return null;
	for (const line of envText.split('\n')) {
		const m = /^\s*JEV_API_KEY\s*=([\s\S]*)$/.exec(line);
		if (!m) continue;
		const v = m[1].replace(/[^A-Za-z0-9_\-.]/g, '');
		return v || null;
	}
	return null;
}
