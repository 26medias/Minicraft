/**
 * The answer cache (criterion 3): model answers keyed by sha256(engine | prompt | criteria-or-schema). In
 * `replay-or-live` a hit never calls the engine and a miss calls it live and records the answer, so personality
 * differences still reach the prompts. In `live` every call goes to the engine and is recorded. The file is
 * committed; `save()` writes it atomically with sorted keys, so re-recording gives small diffs.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Answer, Choice } from '../../brain/brain.js';
import type { Engines, LayaEngine, LlmEngine } from '../experts/expert.js';

interface CacheFile { version: 1; entries: Record<string, unknown> }

export function cacheKey(engine: 'laya' | 'llm', prompt: string, spec: unknown): string {
	return createHash('sha256').update(`${engine}|${prompt}|${JSON.stringify(spec)}`).digest('hex');
}

export class AnswerCache {
	private readonly path: string;
	private readonly entries: Map<string, unknown>;
	private hits = 0;
	private misses = 0;

	constructor(path: string) {
		this.path = path;
		this.entries = new Map();
		if (existsSync(path)) {
			const f = JSON.parse(readFileSync(path, 'utf8')) as CacheFile;
			for (const [k, v] of Object.entries(f.entries ?? {})) this.entries.set(k, v);
		}
	}

	wrap(e: Engines, mode: 'live' | 'replay-or-live'): Engines {
		const through = async <T>(key: string, live: () => Promise<T>): Promise<T> => {
			if (mode === 'replay-or-live' && this.entries.has(key)) {
				this.hits++;
				return structuredClone(this.entries.get(key)) as T;
			}
			this.misses++;
			const v = await live();
			this.entries.set(key, structuredClone(v));
			return v;
		};
		const laya: LayaEngine | null = e.laya
			? {
				healthy: () => e.laya!.healthy(),
				ask: (state: string, q: Choice, signal: AbortSignal): Promise<Answer> =>
					through(cacheKey('laya', `${state}\n${q.instructions}`, q.options), () => e.laya!.ask(state, q, signal)),
			}
			: null;
		const llm: LlmEngine | null = e.llm
			? {
				healthy: () => e.llm!.healthy(),
				json: <T>(prompt: string, schema: object, signal: AbortSignal): Promise<{ value: T; raw: string }> =>
					through(cacheKey('llm', prompt, schema), () => e.llm!.json<T>(prompt, schema, signal)),
			}
			: null;
		return { laya, llm };
	}

	stats(): { hits: number; misses: number } {
		return { hits: this.hits, misses: this.misses };
	}

	save(): void {
		const entries = Object.fromEntries([...this.entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
		const body: CacheFile = { version: 1, entries };
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(body, null, '\t')}\n`);
		renameSync(tmp, this.path);
	}
}
