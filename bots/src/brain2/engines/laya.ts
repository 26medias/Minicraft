/**
 * Laya (spec §3.2): today's systemone adapter, unchanged, behind the `LayaEngine` contract. `choice` questions,
 * answer = max(p), timeout 400 ms, one warm-up call at startup (the first call measured 277 ms). Laya must run with
 * `LAYA_MODELS=english` (`brains-cli.ts` refuses otherwise).
 */
import type { Answer, Choice } from '../../brain/brain.js';
import { SystemOneBrain } from '../../brain/systemone.js';
import type { LayaEngine } from '../experts/expert.js';
import type { Health } from './health.js';

const WARM_UP: Choice = { type: 'choice', instructions: 'Am I ready?', options: { yes: 'yes', no: 'no' } };

export class Laya implements LayaEngine {
	private readonly brain: SystemOneBrain;
	private readonly timeoutMs: number;
	private readonly health: Health;

	constructor(o: { url: string; timeoutMs: number; health: Health; fetchImpl?: typeof fetch }) {
		this.brain = new SystemOneBrain({ name: 'laya', url: o.url, healthPath: '/health', fetchImpl: o.fetchImpl });
		this.timeoutMs = o.timeoutMs;
		this.health = o.health;
	}

	healthy(): boolean {
		return this.health.laya;
	}

	/** The caller's signal, or Laya's own timeout, whichever comes first. */
	ask(state: string, q: Choice, signal: AbortSignal): Promise<Answer> {
		return this.brain.ask(state, q, AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]));
	}

	/** One throwaway call so the first real question isn't the slow one. A failure is not fatal. */
	async warmUp(): Promise<void> {
		try {
			await this.brain.ask('I just started.', WARM_UP, AbortSignal.timeout(Math.max(this.timeoutMs, 5_000)));
		} catch {
			// Laya down at startup: health says so, and the experts fall back.
		}
	}
}
