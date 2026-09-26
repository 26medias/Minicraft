import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Cause, Change } from './store.js';
import type { CallLine } from './scheduler.js';
import type { BehaviourKind, GlobalAxis, RelationAxis } from './types.js';

export const LOG_VERSION = 1;
/** Everything scoreRows read (gate 2 B4): lets `replay --data` recompute every term under new EMOTIONAL/MERGE weights. */
export interface SelectInputs {
	emotions: Record<GlobalAxis, number>; relation: Record<RelationAxis, number> | null;
	current: BehaviourKind | null; startedAgoMs: number; typicalMaxMs: Record<BehaviourKind, number>;
	recency: Record<BehaviourKind, 'none' | 'recent' | 'bad' | 'resume'>; lineFresh: boolean;
	social: { near: number; help: number } | null; situational: BehaviourKind | null; masked: BehaviourKind[];
}
export type LogLine =
	| { k: 'meta'; v: 1; t: number; bot: string; world: string; personality: string; seed: number; wallStart: number }
	| { k: 'change'; t: number; id: number; path: string; old: unknown; new: unknown; deleted?: true; cause: Cause }
	| ({ k: 'call'; t: number } & CallLine)
	| { k: 'select'; t: number; selectionId: number; trigger: string; urgent: boolean; player: string | null; inputs: SelectInputs;
		rows: Array<{ behaviour: BehaviourKind; emotional: number; social: number; situational: number; inertia: number; recency: number; bonus: number; masked: boolean; total: number }>;  // RAW terms (unweighted); total weighted
		winner: BehaviourKind | null; params: Record<string, unknown> }
	| { k: 'event'; t: number; kind: string; data?: unknown };
const KINDS = new Set(['meta', 'change', 'call', 'select', 'event']);

export class BrainLog {
	constructor(private readonly out: (line: string) => void) {}
	write(l: LogLine): void {
		this.out(JSON.stringify(l));
	}
	/** Store subscriber: logs every change (decay included; replay needs every mutation). */
	changes(cs: Change[]): void {
		for (const c of cs) {
			const line: LogLine = { k: 'change', t: c.t, id: c.id, path: c.path, old: c.old ?? null, new: c.new ?? null, cause: c.cause };
			if (c.new === undefined) line.deleted = true;
			this.write(line);
		}
	}
}

export function parseLog(text: string): LogLine[] {
	const out: LogLine[] = [];
	text.split('\n').forEach((raw, i) => {
		if (!raw.trim()) return;
		let o: { k?: string };
		try {
			o = JSON.parse(raw);
		} catch (e) {
			throw new Error(`log line ${i + 1}: ${(e as Error).message}`);
		}
		if (!o.k || !KINDS.has(o.k)) throw new Error(`log line ${i + 1}: unknown kind ${String(o.k)}`);
		out.push(o as LogLine);
	});
	return out;
}

export function rotateLogs(dir: string, keep = 20): string[] {
	const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
	const gone = files.slice(keep).map((x) => x.f);
	for (const f of gone) unlinkSync(join(dir, f));
	return gone;
}
