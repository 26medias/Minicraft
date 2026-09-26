/**
 * --llm-params (experiment E6 stretch): Ollama (llama3.2:3b, JSON schema, temperature 0) proposes an idea's numeric
 * parameters instead of the size choice. The answer is clamped into each range; the caller validates the design and
 * falls back to the chosen preset when anything fails.
 */
import type { Idea } from './designs.js';

type Fetch = typeof fetch;

export interface ParamProposer { readonly name: string; propose(idea: Idea, context: string): Promise<Record<string, unknown>> }

export function ollamaProposer(url: string, model: string, fetchImpl: Fetch = fetch, timeoutMs = 8000): ParamProposer {
	return {
		name: `ollama:${model}`,
		async propose(idea, context) {
			const properties = Object.fromEntries(Object.entries(idea.params).map(([k, s]) => [k, { type: 'integer', minimum: s.min, maximum: s.max, description: s.what }]));
			const ranges = Object.entries(idea.params).map(([k, s]) => `${k}: ${s.what}, ${s.min} to ${s.max}`).join('; ');
			const prompt = `${context}\nI will build ${idea.nice}. Choose the numbers for it (${ranges}). Make it fun for a 7-year-old. Answer with JSON only.`;
			const res = await fetchImpl(`${url}/api/generate`, {
				method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
				body: JSON.stringify({ model, prompt, stream: false, format: { type: 'object', properties, required: Object.keys(properties) }, options: { temperature: 0, seed: 42 }, keep_alive: -1 }),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const j = (await res.json()) as { response?: string };
			const v = JSON.parse(j.response ?? '') as unknown;
			if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not a JSON object');
			return v as Record<string, unknown>;
		},
	};
}

