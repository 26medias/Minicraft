/**
 * The brain interface (spec §5): a pluggable decision-maker over one fixed multiple-choice
 * question, `next`. `state` is the deterministic text built from a `Snapshot` (`perceive.ts`'s
 * `renderText`, Task 3); `question` lists this tick's feasible candidates, keyed by name, each with
 * a human description as its value — Laya's real wire format uses `criteria`, not `options`, for
 * this same map (`systemone.ts`, Task 6, maps between the two). `scripted.ts` (this task) and
 * `systemone.ts` (Task 6) both implement this same interface, so the loop (Task 4) can call any
 * brain — the real one, or the fallback — the same way.
 */
export type Choice = { type: 'choice'; instructions: string; options: Record<string, string> };

/**
 * `probs` covers the offered options only; an option missing from `probs` counts as 0 (spec §5).
 * `confidence` is **max(p)** over those offered options — Laya's `answer_confidence`, never its own
 * calibrated `confidence` field (spec §12a: "Laya's calibrated `confidence` is not used").
 */
export type Answer = { type: 'choice'; best: string; probs: Record<string, number>; confidence: number };

export interface Brain {
	name: string;
	health(): Promise<boolean>;
	ask(state: string, question: Choice, signal: AbortSignal): Promise<Answer>;
}
