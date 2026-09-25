import type { Answer, Brain, Choice } from './brain.js';
import type { Candidate, Snapshot } from '../types.js';
import { MOVING_SPEED_THRESHOLD } from '../types.js';

/** §12b engine re-gate: `follow` is also wanted when the kid is more than this far above or below
 *  the bot — the stairs case (the bot sat at a step's base, close horizontally but 6 below). */
const VERTICAL_FOLLOW_THRESHOLD = 1.5;

/** A deterministic `Answer`: probability 1 for `winner`, 0 for every other offered candidate, so
 *  `confidence` (max(p) over the offered options) is always 1 — spec §6's task brief: "confidence
 *  is 1 for the chosen option." */
function decisive(offered: readonly Candidate[], winner: Candidate): Answer {
	const probs: Record<string, number> = {};
	for (const c of offered) probs[c] = c === winner ? 1 : 0;
	return { type: 'choice', best: winner, probs, confidence: 1 };
}

/**
 * The scripted brain's rule table (spec §6 "Scripted brain", updated by §12b's vertical
 * condition):
 *
 *   follow      if the target kid is > `followDist + 1` away horizontally, OR |dy| > 1.5,
 *               OR moving;
 *   else help_build  if offered;
 *   else watch.
 *
 * It chooses only among the `candidates` actually offered this tick — a condition holding true
 * never picks an action that wasn't offered. With no target kid, or none of `follow`/`help_build`/
 * `watch` offered or applicable, it falls through to `wander`, then `idle` — both always safe when
 * offered (spec §6's candidate table: `idle` is "always" available), so `scriptedDecide` never has
 * to invent an action outside `candidates`.
 */
export function scriptedDecide(snapshot: Snapshot, candidates: readonly Candidate[]): Answer {
	const offered = new Set(candidates);
	const target = snapshot.target;

	if (target && offered.has('follow')) {
		const dx = target.pose.x - snapshot.bot.pose.x;
		const dz = target.pose.z - snapshot.bot.pose.z;
		const horizontalDist = Math.hypot(dx, dz);
		const dy = Math.abs(target.pose.y - snapshot.bot.pose.y);
		const moving = target.speedLast0_3s >= MOVING_SPEED_THRESHOLD;
		const wantFollow = horizontalDist > snapshot.followDist + 1 || dy > VERTICAL_FOLLOW_THRESHOLD || moving;
		if (wantFollow) return decisive(candidates, 'follow');
	}

	if (offered.has('help_build')) return decisive(candidates, 'help_build');
	if (offered.has('watch')) return decisive(candidates, 'watch');
	if (offered.has('wander')) return decisive(candidates, 'wander');
	if (offered.has('idle')) return decisive(candidates, 'idle');

	// Defensive only: candidates() (Task 3) always offers at least `idle`, so this never runs in
	// practice, but scriptedDecide must not throw on an unexpected empty list.
	return decisive(candidates, candidates[0] ?? 'idle');
}

/**
 * The deterministic fallback and baseline brain (spec §5, §6). Its `health` is always true — it has
 * no external process to be down.
 *
 * It needs the structured `Snapshot` to decide (kid distance, height, speed), which the plain
 * `Brain.ask(state, question, signal)` signature doesn't carry — `state` is text and `question` is
 * just candidate names and descriptions. The caller (the companion loop, Task 4) supplies the
 * current tick's snapshot via `getSnapshot`, called once per `ask`. This keeps `Brain` itself
 * exactly as spec §5 defines it (shared with the real Laya/CLM adapters), while still letting the
 * scripted brain be used uniformly through that interface, both as `--brain scripted` and as the
 * object the loop calls on a real brain's timeout or failure.
 */
export class ScriptedBrain implements Brain {
	readonly name = 'scripted';

	constructor(private readonly getSnapshot: () => Snapshot) {}

	async health(): Promise<boolean> {
		return true;
	}

	async ask(_state: string, question: Choice, _signal: AbortSignal): Promise<Answer> {
		const offered = Object.keys(question.options) as Candidate[];
		return scriptedDecide(this.getSnapshot(), offered);
	}
}
