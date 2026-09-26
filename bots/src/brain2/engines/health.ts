/**
 * Engine health (spec §3.2), polled every 10 s by the brain. An unhealthy engine means its experts run on their
 * code fallbacks.
 * - Laya: `GET /health` must be ok.
 * - Ollama: `GET /api/ps` must list the model with `size_vram ≥ size` (fully on the GPU). Partly on the CPU is too
 *   slow, so it's a failure. Absent means "load it": one `POST /api/generate {model, prompt: '', keep_alive: -1}`,
 *   and `false` until a later poll sees it loaded.
 */
import type { Clock } from '../clock.js';

interface PsEntry { name?: string; model?: string; size?: number; size_vram?: number }

export class Health {
	laya = false;
	llm = false;
	lastError: string | null = null;
	/** When the last poll finished (the brain's clock). */
	lastPollT: number | null = null;
	private readonly layaUrl: string | null;
	private readonly llmDef: { url: string; model: string } | null;
	private readonly fetchImpl: typeof fetch;
	private readonly clock: Clock;
	private loading: Promise<void> | null = null;

	constructor(o: { layaUrl: string | null; llm: { url: string; model: string } | null; fetchImpl?: typeof fetch; clock: Clock }) {
		this.layaUrl = o.layaUrl;
		this.llmDef = o.llm;
		this.fetchImpl = o.fetchImpl ?? fetch;
		this.clock = o.clock;
	}

	async poll(): Promise<void> {
		const errors: string[] = [];
		const [laya, llm] = await Promise.all([this.pollLaya(errors), this.pollLlm(errors)]);
		this.laya = laya;
		this.llm = llm;
		this.lastError = errors.length ? errors.join('; ') : null;
		this.lastPollT = this.clock();
	}

	private async pollLaya(errors: string[]): Promise<boolean> {
		if (!this.layaUrl) return false;
		try {
			const res = await this.fetchImpl(`${this.layaUrl}/health`);
			if (!res.ok) errors.push(`laya: /health ${res.status}`);
			return res.ok;
		} catch (e) {
			errors.push(`laya: ${(e as Error).message}`);
			return false;
		}
	}

	private async pollLlm(errors: string[]): Promise<boolean> {
		const def = this.llmDef;
		if (!def) return false;
		let models: PsEntry[];
		try {
			const res = await this.fetchImpl(`${def.url}/api/ps`);
			if (!res.ok) {
				errors.push(`llm: /api/ps ${res.status}`);
				return false;
			}
			models = ((await res.json()) as { models?: PsEntry[] }).models ?? [];
		} catch (e) {
			errors.push(`llm: ${(e as Error).message}`);
			return false;
		}
		const m = models.find((x) => x.name === def.model || x.model === def.model);
		if (!m) {
			errors.push(`llm: ${def.model} not loaded, loading`);
			this.load(def);
			return false;
		}
		const size = m.size ?? 0, vram = m.size_vram ?? 0;
		if (vram < size) {
			errors.push(`llm: ${def.model} size_vram ${vram} < size ${size} (partly on the CPU)`);
			return false;
		}
		return true;
	}

	/** One load at a time; the next poll confirms it. */
	private load(def: { url: string; model: string }): void {
		if (this.loading) return;
		this.loading = this.fetchImpl(`${def.url}/api/generate`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: def.model, prompt: '', keep_alive: -1 }),
		})
			.then(() => undefined, (e: unknown) => {
				this.lastError = `llm: load failed: ${(e as Error).message}`;
			})
			.finally(() => {
				this.loading = null;
			});
	}
}
