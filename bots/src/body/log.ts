/**
 * The decision log (spec §6 step 5): one JSONL line per tick, plus one line per notable event (a stop
 * signal, a target switch, a fallback to scripted). Lines are written through an injected `write`, so
 * the loop never touches the filesystem (cli.ts appends to a file under `bots/.state/logs/`).
 */
import type { Candidate, Snapshot } from '../types.js';

/** One tick's decision. The keys, in this order, are the log schema. */
export interface DecisionEntry {
	/** The session seed (wander's rng). */
	seed: number;
	/** The tick index, from 0. */
	tick: number;
	/** The bot's clock at the start of the tick. */
	t: number;
	snapshot: Snapshot;
	/** The text state the brain read (`renderText`). */
	text: string;
	candidates: Candidate[];
	/** The brain that decided: its name, `scripted`, or `rule` (Fix round 2: a loop rule decided
	 *  without asking it — `reason` says which one; the real brain wasn't asked that tick). */
	brain: string;
	/** The brain's raw answer, the error it failed with, or `null` when it wasn't asked. */
	raw: unknown;
	action: Candidate;
	/** `brain`, `low-confidence`, `fallback:<err>`, `scripted`, or `rule:<name>` (e.g.
	 *  `rule:follow-floor`, `rule:help-build`). */
	reason: string;
	/** What acting did, e.g. `walk 12.5,64.0,3.0`, `placed oak_planks at 1,2,3`, `recheck-failed: …`. */
	result: string;
	/** How long the brain took (ms); 0 when it wasn't asked. */
	latency: number;
}

export const DECISION_KEYS: readonly (keyof DecisionEntry)[] = ['seed', 'tick', 't', 'snapshot', 'text', 'candidates', 'brain', 'raw', 'action', 'reason', 'result', 'latency'];

export interface Logger {
	decision(entry: DecisionEntry): void;
	event(kind: string, data?: Record<string, unknown>): void;
}

/** One decision as a JSONL line (keys in schema order, `\n`-terminated). */
export function decisionLine(entry: DecisionEntry): string {
	const ordered: Record<string, unknown> = {};
	for (const k of DECISION_KEYS) ordered[k] = entry[k] === undefined ? null : entry[k];
	return `${JSON.stringify(ordered)}\n`;
}

/** One event as a JSONL line: `{ seed, t, event, ...data }`. */
export function eventLine(seed: number, t: number, kind: string, data: Record<string, unknown> = {}): string {
	return `${JSON.stringify({ seed, t, event: kind, ...data })}\n`;
}

/** A logger that hands each line to `write`. */
export function jsonlLogger(write: (line: string) => void, seed: number, clock: () => number): Logger {
	return {
		decision: (entry) => write(decisionLine(entry)),
		event: (kind, data) => write(eventLine(seed, clock(), kind, data)),
	};
}
