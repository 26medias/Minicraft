/**
 * The LLM (spec §3.2): Ollama's `/api/chat` with JSON-schema output. Every call is deterministic (temperature 0,
 * seed 42: at 0.2 the re-gate got 6 different answers out of 6) and keeps the model loaded (`keep_alive: -1`). The
 * 5 s timeout is the scheduler's (TIMEOUT_MS.llm). Ollama doesn't enforce numeric schema bounds, so every answer is
 * a proposal the expert's merge re-validates.
 */
import type { LlmEngine } from '../experts/expert.js';
import type { Health } from './health.js';

export class Llm implements LlmEngine {
	private readonly url: string;
	private readonly model: string;
	private readonly health: Health;
	private readonly fetchImpl: typeof fetch;

	constructor(o: { url: string; model: string; health: Health; fetchImpl?: typeof fetch }) {
		this.url = o.url;
		this.model = o.model;
		this.health = o.health;
		this.fetchImpl = o.fetchImpl ?? fetch;
	}

	healthy(): boolean {
		return this.health.llm;
	}

	async json<T>(prompt: string, schema: object, signal: AbortSignal): Promise<{ value: T; raw: string }> {
		const body = {
			model: this.model,
			messages: [{ role: 'user', content: prompt }],
			format: schema,
			stream: false,
			keep_alive: -1,
			options: { temperature: 0, seed: 42 },
		};
		const res = await this.fetchImpl(`${this.url}/api/chat`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
			signal,
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new Error(`llm: ${res.status} ${text}`);
		}
		const raw = ((await res.json()) as { message?: { content?: unknown } }).message?.content;
		if (typeof raw !== 'string') throw new Error('llm: not JSON');
		try {
			return { value: JSON.parse(raw) as T, raw };
		} catch {
			throw new Error('llm: not JSON');
		}
	}
}
