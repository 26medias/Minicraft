/**
 * The Laya/CLM `/v1/systemone` adapter (spec §5, §12a; Task 6). Both servers speak (or approximate)
 * the same wire protocol: `{state, questions}` in, `{answers: {next: {choice, probabilities, ...}}}`
 * out. This maps `Brain`'s plain `Choice`/`Answer` onto that wire shape and back:
 *
 * - The wire's `choice` question needs `criteria` (a name → description map), not `options` — Laya
 *   returns `422` for `options` (see `~/Projects/AI/BRAINS.md`). `Choice.options` is renamed to
 *   `criteria` verbatim; nothing else changes.
 * - Only `response.answers.next` is read; `usage` and `routing` are ignored.
 * - `probs` is `answers.next.probabilities`, restricted to the offered options (a missing option is
 *   0) and renormalised to sum to 1 over those options.
 * - `confidence` is **max(p)** over that restricted, renormalised `probs` — never `answers.next`'s own
 *   `confidence` field, which is Laya's entropy-based, uncalibrated number (spec §12a: "Laya's
 *   calibrated `confidence` is not used"). `answer_confidence` happens to equal max(p) in practice,
 *   but this is computed from `probs`, not read off that field, so the mapping stays correct even if a
 *   server's `answer_confidence` and its probabilities ever disagree.
 */
import type { Answer, Brain, Choice } from './brain.js';

export interface SystemOneBrainOptions {
	/** The `Brain.name` this adapter reports (`laya` or `clm`). */
	name: string;
	/** `http://host:port`, no trailing slash. */
	url: string;
	/** The health path, e.g. `/health`. */
	healthPath: string;
	/** Injectable for tests (a `node:http` fake); defaults to the global `fetch`. */
	fetchImpl?: typeof fetch;
}

interface SystemOneRequest {
	state: string;
	questions: {
		next: { type: 'choice'; instructions: string; criteria: Record<string, string> };
	};
}

interface SystemOneChoiceAnswer {
	type?: string;
	choice: string;
	probabilities?: Record<string, number>;
	/** Laya's own calibrated field (entropy-based). Never used for `Answer.confidence`. */
	confidence?: number;
	answer_confidence?: number;
	action?: unknown;
}

interface SystemOneResponse {
	model?: string;
	answers: { next?: SystemOneChoiceAnswer };
	usage?: unknown;
	routing?: unknown;
}

/** The wire request `SystemOneBrain.ask` sends: `Choice.options` renamed to `criteria` verbatim. */
export function buildRequest(state: string, question: Choice): SystemOneRequest {
	return {
		state,
		questions: {
			next: {
				type: 'choice',
				instructions: question.instructions,
				criteria: { ...question.options },
			},
		},
	};
}

/** Maps `answers.next` onto `Answer` (spec §12a): `probs` over the offered options only, a missing
 *  one counts as 0, renormalised to sum to 1; `confidence` = max(p) over that. */
export function mapResponse(resp: SystemOneResponse, offered: readonly string[]): Answer {
	const next = resp.answers?.next;
	if (!next || typeof next.choice !== 'string') {
		throw new Error(`systemone: malformed response, answers.next missing or has no choice: ${JSON.stringify(resp)}`);
	}
	const raw = next.probabilities ?? {};
	let sum = 0;
	const restricted: Record<string, number> = {};
	for (const c of offered) {
		const p = raw[c];
		const v = typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : 0;
		restricted[c] = v;
		sum += v;
	}
	const probs: Record<string, number> = {};
	let confidence = 0;
	for (const c of offered) {
		const p = sum > 0 ? restricted[c] / sum : 0;
		probs[c] = p;
		if (p > confidence) confidence = p;
	}
	return { type: 'choice', best: next.choice, probs, confidence };
}

/** The Laya/CLM adapter (Task 6): `Brain` over the real `/v1/systemone` wire format. */
export class SystemOneBrain implements Brain {
	readonly name: string;
	private readonly url: string;
	private readonly healthPath: string;
	private readonly fetchImpl: typeof fetch;

	constructor(opts: SystemOneBrainOptions) {
		this.name = opts.name;
		this.url = opts.url;
		this.healthPath = opts.healthPath;
		this.fetchImpl = opts.fetchImpl ?? fetch;
	}

	async health(): Promise<boolean> {
		try {
			const res = await this.fetchImpl(`${this.url}${this.healthPath}`);
			return res.ok;
		} catch {
			return false;
		}
	}

	async ask(state: string, question: Choice, signal: AbortSignal): Promise<Answer> {
		const body = buildRequest(state, question);
		const res = await this.fetchImpl(`${this.url}/v1/systemone`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
			signal,
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new Error(`systemone: ${res.status} ${text}`);
		}
		const json = (await res.json()) as SystemOneResponse;
		return mapResponse(json, Object.keys(question.options));
	}
}
