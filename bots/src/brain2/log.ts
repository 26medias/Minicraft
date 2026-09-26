import { appendFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Cause, Change } from './store.js';
import type { CallLine } from './scheduler.js';
import type { BehaviourKind, GlobalAxis, RelationAxis } from './types.js';

export const LOG_VERSION = 1;
/** One log file's byte cap: past it, the session continues in `<base>-<n>.jsonl` (a night logs ~11 MB an hour). */
export const LOG_CAP_BYTES = 50 * 1024 * 1024;
/** Log files kept per bot directory (rotateLogs). */
export const LOGS_KEPT = 20;
/** Everything scoreRows read (gate 2 B4): lets `replay --data` recompute every term under new EMOTIONAL/MERGE weights. */
export interface SelectInputs {
	emotions: Record<GlobalAxis, number>; relation: Record<RelationAxis, number> | null;
	current: BehaviourKind | null; startedAgoMs: number; typicalMaxMs: Record<BehaviourKind, number>;
	recency: Record<BehaviourKind, 'none' | 'recent' | 'bad' | 'resume'>; lineFresh: boolean;
	social: { near: number; help: number } | null; situational: BehaviourKind | null; masked: BehaviourKind[];
}
export type LogLine =
	// `part`/`prev`: a continuation file past the byte cap (part n ≥ 2, the file before it); otherwise the session's meta as is.
	| { k: 'meta'; v: 1; t: number; bot: string; world: string; personality: string; seed: number; wallStart: number; part?: number; prev?: string }
	| { k: 'change'; t: number; id: number; path: string; old: unknown; new: unknown; deleted?: true; cause: Cause }
	| ({ k: 'call'; t: number } & CallLine)
	| { k: 'select'; t: number; selectionId: number; trigger: string; urgent: boolean; player: string | null; inputs: SelectInputs;
		rows: Array<{ behaviour: BehaviourKind; emotional: number; social: number; situational: number; inertia: number; recency: number; bonus: number; masked: boolean; total: number }>;  // emotional/social/situational RAW (unweighted); inertia/recency/bonus MERGE-scaled; total = the weighted sum (R13)
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

export function rotateLogs(dir: string, keep = LOGS_KEPT): string[] {
	const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
	const gone = files.slice(keep).map((x) => x.f);
	for (const f of gone) unlinkSync(join(dir, f));
	return gone;
}

export interface LogFileWriter {
	write(line: string): void;
	/** The file being written now. */
	readonly path: string;
}

/**
 * Writes a session's log lines to `<dir>/<base>.jsonl`. A line that would take the file past `capBytes` starts
 * `<base>-<n>.jsonl` (n = 2, 3, …) instead, headed by the session's meta line with `part: n` and `prev` (the file
 * before), then rotateLogs keeps the newest `keep`. A file only exceeds the cap when one line alone does.
 */
export function logFileWriter(o: { dir: string; base: string; capBytes?: number; keep?: number }): LogFileWriter {
	const cap = o.capBytes ?? LOG_CAP_BYTES;
	let part = 1;
	let path = join(o.dir, `${o.base}.jsonl`);
	let bytes = 0;
	let meta: Record<string, unknown> | null = null;
	const append = (data: string) => {
		appendFileSync(path, data);
		bytes += Buffer.byteLength(data);
	};
	return {
		get path() {
			return path;
		},
		write(line: string) {
			if (meta === null && line.startsWith('{"k":"meta"')) meta = JSON.parse(line) as Record<string, unknown>;
			const data = `${line}\n`;
			if (bytes > 0 && bytes + Buffer.byteLength(data) > cap) {
				const prev = basename(path);
				part++;
				path = join(o.dir, `${o.base}-${part}.jsonl`);
				bytes = 0;
				if (meta) append(`${JSON.stringify({ ...meta, part, prev })}\n`);
				rotateLogs(o.dir, o.keep ?? LOGS_KEPT);
			}
			append(data);
		},
	};
}
