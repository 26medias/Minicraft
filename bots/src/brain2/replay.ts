/**
 * Replay (spec §8): re-applies a session log's change lines to rebuild every state it went through (criterion 6's
 * foundation), and the per-decision check: each recorded `select` rescored under other EMOTIONAL/MERGE tables.
 *
 *   npm run bot:replay -- <log.jsonl>                    the recorded session in the terminal view
 *   npm run bot:replay -- <log.jsonl> --data <file.ts>   which recorded decisions the file's tables would flip
 *
 * Replay keys: space pauses, ←/→ step (and pause), e shows the full prompt and answer of the newest call, q quits.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emitKeypressEvents } from 'node:readline';
import { EMOTIONAL, MERGE } from './data/weights.data.js';
import { parseLog, type LogLine } from './log.js';
import { ORDER, scoreInputs, winnerOf } from './selection.js';
import type { BehaviourKind, State } from './types.js';
import { renderTui, type TuiModel } from './tui.js';

type Select = Extract<LogLine, { k: 'select' }>;
type Call = Extract<LogLine, { k: 'call' }>;
export interface ReplayFrame { t: number; state: State; lastSelect: Select | null; calls: Call[] }
export interface Overrides { EMOTIONAL?: typeof EMOTIONAL; MERGE?: typeof MERGE }
export const CHECK_TITLE = 'per-decision check (not a re-simulation)';
const CALLS_KEPT = 8;

/** The same structural-sharing set as the store's (a path through objects and arrays; undefined deletes). */
function setIn(root: unknown, path: string[], value: unknown): unknown {
	if (path.length === 0) return value;
	const [k, ...rest] = path;
	const src = (root ?? {}) as Record<string, unknown>;
	const copy: Record<string, unknown> | unknown[] = Array.isArray(src) ? [...src] : { ...src };
	const next = setIn(src[k], rest, value);
	if (next === undefined && rest.length === 0) delete (copy as Record<string, unknown>)[k];
	else (copy as Record<string, unknown>)[k] = next;
	return copy;
}

/** The initial state a log recorded (its `initial` event, written by runBrain2 before any change), or null. */
export function initialOf(lines: LogLine[]): State | null {
	const e = lines.find((l): l is Extract<LogLine, { k: 'event' }> => l.k === 'event' && l.kind === 'initial');
	return e ? ((e.data as { state: State }).state ?? null) : null;
}

/**
 * Re-applies the change lines in order from `initial`: one frame per distinct `t` (the state after every line up to
 * it). `version` is not replayed (the log records changes, not store applies): it counts the changes applied.
 */
export function framesFromLog(lines: LogLine[], initial: State): ReplayFrame[] {
	const frames: ReplayFrame[] = [];
	let state = structuredClone(initial) as State;
	let lastSelect: Select | null = null;
	let calls: Call[] = [];
	let n = 0;
	const push = (t: number) => {
		const f: ReplayFrame = { t, state: { ...state, version: n }, lastSelect, calls };
		if (frames.length && frames[frames.length - 1].t === t) frames[frames.length - 1] = f;
		else frames.push(f);
	};
	for (const l of lines) {
		if (l.k === 'change') {
			state = setIn(state, l.path.split('.'), l.deleted ? undefined : l.new) as State;
			n++;
		} else if (l.k === 'select') lastSelect = l;
		else if (l.k === 'call') calls = [...calls, l].slice(-CALLS_KEPT);
		else continue;
		push(l.t);
	}
	if (frames.length === 0) push(0);
	return frames;
}

/** The winner of a recorded row set (masked rows, and a total logged as null for −∞, never win; ties by ORDER). */
function recordedWinner(rows: Select['rows']): BehaviourKind | null {
	let best: Select['rows'][number] | null = null;
	for (const b of ORDER) {
		const r = rows.find((x) => x.behaviour === b);
		if (!r || r.masked || r.total === null || r.total === -Infinity) continue;
		if (!best || r.total > best.total) best = r;
	}
	return best?.behaviour ?? null;
}

/**
 * The per-decision check (spec §8): for each `select` line, the rows recomputed from its logged inputs under the
 * overridden tables (scoreInputs, the live path's own scoring). Only the decisions that flip are listed. `was` is
 * the recorded rows' winner (before the switch cap, which a table can't change).
 */
export function rescore(lines: LogLine[], o: Overrides): Array<{ t: number; selectionId: number; trigger: string; was: BehaviourKind | null; would: BehaviourKind | null }> {
	const tables = { EMOTIONAL: o.EMOTIONAL ?? EMOTIONAL, MERGE: o.MERGE ?? MERGE };
	const out: Array<{ t: number; selectionId: number; trigger: string; was: BehaviourKind | null; would: BehaviourKind | null }> = [];
	for (const l of lines) {
		if (l.k !== 'select') continue;
		const was = recordedWinner(l.rows);
		const would = winnerOf(scoreInputs(l.inputs, tables));
		if (was !== would) out.push({ t: l.t, selectionId: l.selectionId, trigger: l.trigger, was, would });
	}
	return out;
}

/** The check's printed report, headed as what it is. */
export function formatCheck(lines: LogLine[], o: Overrides, source: string): string[] {
	const flips = rescore(lines, o);
	const t0 = lines.find((l) => l.k === 'meta')?.t ?? lines[0]?.t ?? 0;
	const decisions = lines.filter((l) => l.k === 'select').length;
	return [
		CHECK_TITLE,
		`tables: ${source}${o.EMOTIONAL ? ' EMOTIONAL' : ''}${o.MERGE ? ' MERGE' : ''} (missing ones keep the committed table)`,
		`${flips.length} of ${decisions} recorded decisions flip:`,
		...flips.map((f) => `  +${Math.round((f.t - t0) / 1000)} s  select #${f.selectionId} (${f.trigger}): ${f.was ?? '-'} → ${f.would ?? '-'}`),
	];
}

/** Reads a `--data` file's named exports EMOTIONAL and/or MERGE (tsx runs a .ts file). */
export async function loadOverrides(file: string): Promise<Overrides> {
	const mod = (await import(pathToFileURL(resolve(file)).href)) as Overrides;
	const o: Overrides = {};
	if (mod.EMOTIONAL) o.EMOTIONAL = { ...EMOTIONAL, ...mod.EMOTIONAL };
	if (mod.MERGE) o.MERGE = { ...MERGE, ...mod.MERGE };
	if (!o.EMOTIONAL && !o.MERGE) throw new Error(`${file} exports neither EMOTIONAL nor MERGE`);
	return o;
}

function modelOf(f: ReplayFrame, meta: Extract<LogLine, { k: 'meta' }> | undefined): TuiModel {
	return {
		state: f.state, lanes: { laya: { running: null, queued: [] }, llm: { running: null, queued: [] } }, health: null,
		lastSelect: f.lastSelect, calls: f.calls, now: f.t, world: meta?.world ?? '?', engines: 'code',
	};
}

/** The replay viewer: plays the frames at the log's pace; space pauses, ←/→ step, e shows the newest call in full. */
function view(frames: ReplayFrame[], meta: Extract<LogLine, { k: 'meta' }> | undefined): Promise<void> {
	return new Promise((done) => {
		const out = process.stdout, inp = process.stdin;
		let i = 0, paused = false, detail = false;
		let clock = frames[0].t;
		const draw = () => {
			const f = frames[i];
			const lines = renderTui(modelOf(f, meta), out.columns || 120);
			if (detail) {
				const c = f.calls.at(-1);
				lines.push('', c ? `call ${c.expert} (${c.engine}):` : 'no call yet', ...(c ? [`prompt: ${c.prompt ?? '(code: no prompt)'}`, `answer: ${JSON.stringify(c.answer ?? null)}`] : []));
			}
			lines.push('', `frame ${i + 1}/${frames.length} · +${Math.round((f.t - frames[0].t) / 1000)} s${paused ? ' · paused' : ''} · space pause · ←/→ step · e call · q quit`);
			out.write('\x1b[H\x1b[2J' + lines.join('\n'));
		};
		const timer = setInterval(() => {
			if (!paused) {
				clock += 250;
				while (i < frames.length - 1 && frames[i + 1].t <= clock) i++;
				if (i === frames.length - 1) paused = true;
			}
			draw();
		}, 250);
		const stop = () => {
			clearInterval(timer);
			inp.off('keypress', onKey);
			if (inp.isTTY) inp.setRawMode(false);
			inp.pause();
			out.write('\n');
			done();
		};
		const onKey = (_s: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
			const k = key?.name ?? '';
			if (k === 'q' || (key?.ctrl && k === 'c')) return stop();
			if (k === 'space') {
				paused = !paused;
				clock = frames[i].t;
			} else if (k === 'right' || k === 'left') {
				paused = true;
				i = Math.max(0, Math.min(frames.length - 1, i + (k === 'right' ? 1 : -1)));
				clock = frames[i].t;
			} else if (k === 'e') detail = !detail;
			draw();
		};
		emitKeypressEvents(inp);
		if (inp.isTTY) inp.setRawMode(true);
		inp.on('keypress', onKey);
		inp.resume();
		draw();
	});
}

export async function main(argv: readonly string[]): Promise<void> {
	const file = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--data');
	const di = argv.indexOf('--data');
	if (!file) throw new Error('usage: npm run bot:replay -- <log.jsonl> [--data <file.ts>]');
	// Paths are the caller's: `npm --prefix bots run` moves the cwd to bots/, and npm keeps the original in INIT_CWD.
	const here = (f: string) => resolve(process.env.INIT_CWD ?? process.cwd(), f);
	const lines = parseLog(readFileSync(here(file), 'utf8'));
	if (di >= 0) {
		const data = argv[di + 1] ? here(argv[di + 1]) : undefined;
		if (!data) throw new Error('--data needs a file');
		for (const l of formatCheck(lines, await loadOverrides(data), data)) console.log(l);
		return;
	}
	const initial = initialOf(lines);
	if (!initial) throw new Error(`${file}: no initial state (an 'initial' event) in this log`);
	const frames = framesFromLog(lines, initial);
	const meta = lines.find((l): l is Extract<LogLine, { k: 'meta' }> => l.k === 'meta');
	if (!process.stdout.isTTY || !process.stdin.isTTY) {
		const last = frames[frames.length - 1];
		for (const l of renderTui(modelOf(last, meta), 120)) console.log(l);
		console.log(`\n${frames.length} frames over ${Math.round((last.t - frames[0].t) / 1000)} s (the final one shown; run in a terminal to play it)`);
		return;
	}
	await view(frames, meta);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main(process.argv.slice(2)).catch((err: unknown) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
	});
}
