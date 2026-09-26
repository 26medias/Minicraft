/**
 * The model benchmark (spec §9.2, R15; criterion 2): `npm run bot:bench` runs every candidate engine and wording
 * on the labelled cases in `bench/cases/` against the live models (Laya with `LAYA_MODELS=english`, and Ollama),
 * and prints, per question and candidate: accuracy and recall per class as counts, a confusion matrix, every
 * missed case, and p50/p95 latency. The same report goes to `bench/results/<YYYY-MM-DD>-<model>.txt`.
 *
 * The bar (criterion 2: ≥ 80% overall, ≥ 60% recall in every class) applies to appraisal only. The always-`stay`
 * baseline must fail it: if it passes, the instrument is broken and the run exits 1. Measured, not CI.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import botsConfig from '../bots.config.js';
import type { Answer } from '../src/brain/brain.js';
import { Health } from '../src/brain2/engines/health.js';
import { Laya } from '../src/brain2/engines/laya.js';
import { Llm } from '../src/brain2/engines/llm.js';
import { TIMEOUT_MS } from '../src/brain2/experts/expert.js';
import { axisName, polesOf } from '../src/brain2/render.js';
import { KINDS, appraisalPrompts, fitPrompt, gateReferencePrompts, situationalPrompt, socialPrompt, type AppraisalCase, type BenchPrompt, type Dir, type FitCase, type SituationalCase, type SocialCase } from './prompts.js';

const benchDir = dirname(fileURLToPath(import.meta.url));
/** Generous bench timeouts: the bench measures answers; calls over the production timeouts are counted apart. */
const BENCH_TIMEOUT_MS = { laya: 10_000, llm: 60_000 };
const BAR = { accuracy: 0.8, recall: 0.6 };

// ——— scoring (pure) ———

export interface Row { id: string; expected: string; got: string; ms: number; slow: boolean; what: string }
export interface Summary {
	name: string; n: number; correct: number; classes: string[];
	recall: Record<string, [number, number]>;
	confusion: Record<string, Record<string, number>>;
	p50: number; p95: number; slow: number; errors: number; pass: boolean; misses: Row[];
	/** The confusion matrix's columns; default: the classes plus whatever was answered. */
	columns?: string[];
}

function pct(sorted: number[], p: number): number {
	if (!sorted.length) return 0;
	return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

/** `ok(row)` decides a hit (appraisal/social/fit: got === expected; situational: got in the acceptable set). */
export function summarize(name: string, classes: string[], rows: Row[], ok: (r: Row) => boolean = (r) => r.got === r.expected, columns?: string[]): Summary {
	const recall: Record<string, [number, number]> = Object.fromEntries(classes.map((c) => [c, [0, 0]]));
	const confusion: Record<string, Record<string, number>> = {};
	let correct = 0;
	for (const r of rows) {
		const hit = ok(r);
		if (hit) correct++;
		const rc = recall[r.expected] ?? (recall[r.expected] = [0, 0]);
		rc[1]++;
		if (hit) rc[0]++;
		(confusion[r.expected] ??= {})[r.got] = (confusion[r.expected]?.[r.got] ?? 0) + 1;
	}
	const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
	const n = rows.length;
	const pass = n > 0 && correct / n >= BAR.accuracy && Object.values(recall).every(([h, t]) => t > 0 && h / t >= BAR.recall);
	return {
		name, n, correct, classes, recall, confusion, p50: pct(ms, 0.5), p95: pct(ms, 0.95),
		slow: rows.filter((r) => r.slow).length, errors: rows.filter((r) => r.got === 'error' || r.got === 'invalid').length,
		pass, misses: rows.filter((r) => !ok(r)), columns,
	};
}

const frac = (h: number, t: number): string => `${h}/${t} (${t ? Math.round((100 * h) / t) : 0}%)`;

export function formatSummary(s: Summary, withBar: boolean): string[] {
	const out: string[] = [];
	const verdict = withBar ? (s.pass ? '  PASS' : '  FAIL') : '';
	out.push(`${s.name}: accuracy ${frac(s.correct, s.n)}${verdict}`);
	out.push(`  recall: ${Object.entries(s.recall).map(([c, [h, t]]) => `${c} ${frac(h, t)}`).join(', ')}`);
	out.push(`  latency: p50 ${Math.round(s.p50)} ms, p95 ${Math.round(s.p95)} ms; over the production timeout: ${s.slow}/${s.n}; errors or invalid: ${s.errors}`);
	const gots = s.columns ?? [...new Set([...s.classes, ...Object.values(s.confusion).flatMap((r) => Object.keys(r))])];
	const w = Math.max(8, ...gots.map((g) => g.length + 1));
	const lw = Math.max(12, ...Object.keys(s.recall).map((e) => e.length + 1));
	out.push(`  confusion (rows expected, columns got):`);
	out.push(`    ${''.padEnd(lw)}${gots.map((g) => g.padStart(w)).join('')}`);
	for (const e of Object.keys(s.recall)) out.push(`    ${e.padEnd(lw)}${gots.map((g) => String(s.confusion[e]?.[g] ?? 0).padStart(w)).join('')}`);
	if (s.misses.length) {
		out.push(`  missed (${s.misses.length}):`);
		for (const m of s.misses) out.push(`    ${m.id}  ${m.what}  expected ${m.expected}, got ${m.got}`);
	}
	return out;
}

// ——— decisions (the brain's rules, spec §5.2, §7.1) ———

/** Three-way: max(p) < 0.5 counts as stay. */
export const threeWay = (a: Answer): Dir => (a.confidence < 0.5 ? 'stay' : (a.best as Dir));
/** Binary: up if yes(hi) ≥ 0.5 and yes(lo) < 0.5, down in the mirror case, stay otherwise. */
export function binary(hi: Answer, lo: Answer): Dir {
	const yh = hi.probs.yes ?? 0, yl = lo.probs.yes ?? 0;
	if (yh >= 0.5 && yl < 0.5) return 'up';
	if (yl >= 0.5 && yh < 0.5) return 'down';
	return 'stay';
}
/** Fit: no only when p(no) ≥ 0.6; otherwise the higher of wait and yes. */
export const fitDecision = (a: Answer): string => ((a.probs.no ?? 0) >= 0.6 ? 'no' : (a.probs.wait ?? 0) >= (a.probs.yes ?? 0) ? 'wait' : 'yes');

// ——— the run ———

interface Call<T> { v: T | null; ms: number; err?: string }

async function timed<T>(f: () => Promise<T>): Promise<Call<T>> {
	const t0 = performance.now();
	try {
		const v = await f();
		return { v, ms: performance.now() - t0 };
	} catch (e) {
		return { v: null, ms: performance.now() - t0, err: (e as Error).message };
	}
}

function readCases<T>(file: string): T[] {
	return JSON.parse(readFileSync(join(benchDir, 'cases', file), 'utf8')) as T[];
}

/** 'mood [unhappy → happy]', 'rel.Noah.grievance (gratitude to Noah) [resentful → grateful]'. */
function axisWithPoles(axis: AppraisalCase['axis']): string {
	const [lo, hi] = polesOf(axis);
	const name = axisName(axis);
	return `${axis}${name !== axis ? ` (${name})` : ''} [${lo} → ${hi}]`;
}

async function main(argv: string[]): Promise<number> {
	const modelArg = argv.indexOf('--model');
	const llmDef = botsConfig.llm;
	const model = modelArg >= 0 ? argv[modelArg + 1] : llmDef.model;
	const layaUrl = botsConfig.brains.laya.url;
	const health = new Health({ layaUrl, llm: { url: llmDef.url, model }, clock: () => performance.now() });
	const laya = new Laya({ url: layaUrl, timeoutMs: BENCH_TIMEOUT_MS.laya, health });
	const llm = new Llm({ url: llmDef.url, model, health });
	const lines: string[] = [];
	const say = (l = ''): void => {
		lines.push(l);
		console.log(l);
	};

	// Health: Laya up, the model fully on the GPU (a missing model is loaded by the poll).
	for (let i = 0; i < 45 && !(health.laya && health.llm); i++) {
		await health.poll();
		if (!(health.laya && health.llm)) await new Promise((r) => setTimeout(r, 2_000));
	}
	if (!health.laya || !health.llm) {
		console.error(`bench: engines not healthy (laya ${health.laya}, llm ${health.llm}): ${health.lastError}`);
		return 2;
	}
	const layaHealth = await (await fetch(`${layaUrl}/health`)).json().catch(() => ({}));
	await laya.warmUp();
	await timed(() => llm.json('Say ok.', { type: 'object', properties: { ok: { type: 'boolean' } } }, AbortSignal.timeout(BENCH_TIMEOUT_MS.llm)));

	const date = new Date().toLocaleDateString('sv-SE');
	say(`brain2 model benchmark (spec §9.2) — ${date}`);
	say(`LLM: ${model} at ${llmDef.url} (temperature 0, seed 42, keep_alive -1). Laya: ${layaUrl}, loaded ${JSON.stringify((layaHealth as { loaded?: unknown }).loaded ?? '?')}.`);
	say(`Production timeouts: Laya ${TIMEOUT_MS.laya} ms, LLM ${TIMEOUT_MS.llm} ms (the bench waits longer and counts calls over them).`);
	say(`The bar (criterion 2): accuracy ≥ ${BAR.accuracy * 100}% and recall ≥ ${BAR.recall * 100}% in every class, appraisal only.`);
	say('');

	const askLaya = (p: BenchPrompt): Promise<Call<Answer>> => (p.engine === 'laya' ? timed(() => laya.ask(p.state, p.q, AbortSignal.timeout(BENCH_TIMEOUT_MS.laya))) : Promise.reject(new Error('not laya')));
	const askLlm = <T>(prompt: string, schema: object): Promise<Call<{ value: T; raw: string }>> => timed(() => llm.json<T>(prompt, schema, AbortSignal.timeout(BENCH_TIMEOUT_MS.llm)));
	const slowLaya = (...c: Array<Call<unknown>>): boolean => c.some((x) => x.ms > TIMEOUT_MS.laya);
	const slowLlm = (c: Call<unknown>): boolean => c.ms > TIMEOUT_MS.llm;

	// ——— appraisal ———
	const cases = readCases<AppraisalCase>('appraisal.json');
	const cands: Record<string, Row[]> = { 'laya-3way': [], 'laya-binary': [], 'llm-batched': [], 'llm-fewshot': [], 'llm-dir-laya-stay': [], 'both-agree': [], 'always-stay': [] };
	const grid: string[] = [];
	/** Reference rows (gate-1 wordings, no band line): not candidates, never the best, no bar verdict. */
	const refs: Record<string, Row[]> = { 'ref:gate-laya-binary': [], 'ref:gate-llm': [] };
	for (const c of cases) {
		const ps = appraisalPrompts(c, cases);
		const byName = (n: string) => ps.find((p) => p.name === n)!;
		const three = await askLaya(byName('laya-3way'));
		const hi = await askLaya(byName('laya-hi'));
		const lo = await askLaya(byName('laya-lo'));
		const llmP = byName('llm'), fewP = byName('llm-fewshot');
		if (llmP.engine !== 'llm' || fewP.engine !== 'llm') throw new Error('bench: prompt kinds');
		const one = await askLlm<Record<string, string>>(llmP.prompt, llmP.schema);
		const few = await askLlm<Record<string, string>>(fewP.prompt, fewP.schema);
		const dirOf = (x: Call<{ value: Record<string, string> }>): string => (x.v ? (['down', 'stay', 'up'].includes(x.v.value[c.axis]) ? x.v.value[c.axis] : 'invalid') : 'error');
		const d3 = three.v ? threeWay(three.v) : 'error';
		const dB = hi.v && lo.v ? binary(hi.v, lo.v) : 'error';
		const dL = dirOf(one), dF = dirOf(few);
		const what = `${axisWithPoles(c.axis)}  "${c.events.join(' ')}"`;
		const row = (got: string, ms: number, slow: boolean): Row => ({ id: c.id, expected: c.expected, got, ms, slow, what });
		cands['laya-3way'].push(row(d3, three.ms, slowLaya(three)));
		cands['laya-binary'].push(row(dB, hi.ms + lo.ms, slowLaya(hi, lo)));
		cands['llm-batched'].push(row(dL, one.ms, slowLlm(one)));
		cands['llm-fewshot'].push(row(dF, few.ms, slowLlm(few)));
		const moved = dB === 'up' || dB === 'down';
		cands['llm-dir-laya-stay'].push(row(dB === 'error' ? 'error' : moved ? dL : 'stay', hi.ms + lo.ms + (moved ? one.ms : 0), slowLaya(hi, lo) || (moved && slowLlm(one))));
		cands['both-agree'].push(row(dB === 'error' || dL === 'error' ? 'error' : dB === dL ? dB : 'stay', hi.ms + lo.ms + one.ms, slowLaya(hi, lo) || slowLlm(one)));
		cands['always-stay'].push(row('stay', 0, false));
		const [gHi, gLo, gL] = gateReferencePrompts(c);
		const rh = await askLaya(gHi), rl = await askLaya(gLo);
		const rg = gL.engine === 'llm' ? await askLlm<{ direction: string }>(gL.prompt, gL.schema) : null;
		refs['ref:gate-laya-binary'].push(row(rh.v && rl.v ? binary(rh.v, rl.v) : 'error', rh.ms + rl.ms, slowLaya(rh, rl)));
		refs['ref:gate-llm'].push(row(rg?.v ? (['down', 'stay', 'up'].includes(rg.v.value.direction) ? rg.v.value.direction : 'invalid') : 'error', rg?.ms ?? 0, !!rg && slowLlm(rg)));
		const p = (a: Call<Answer>, k: string): string => (a.v ? (a.v.probs[k] ?? 0).toFixed(2) : 'err');
		grid.push(`  ${c.id}  ${c.expected.padEnd(5)} | 3way ${d3.padEnd(5)} (${three.v ? `${three.v.best} ${three.v.confidence.toFixed(2)}` : three.err}) | binary ${dB.padEnd(5)} (yes hi ${p(hi, 'yes')}, yes lo ${p(lo, 'yes')}) | llm ${dL.padEnd(5)} | fewshot ${dF.padEnd(5)} | ${axisWithPoles(c.axis)}  "${c.events.join(' ')}"`);
		process.stderr.write('.');
	}
	process.stderr.write('\n');

	say('═══ APPRAISAL DIRECTION (appraise.detect), 63 cases, 21 per class — the bar applies ═══');
	const sums = Object.entries(cands).map(([name, rows]) => summarize(name, ['down', 'stay', 'up'], rows));
	say('');
	say('  candidate            accuracy        down          stay          up            p50 ms  p95 ms  bar');
	for (const s of sums) {
		const r = (k: string) => frac(s.recall[k][0], s.recall[k][1]).padEnd(14);
		say(`  ${s.name.padEnd(20)} ${frac(s.correct, s.n).padEnd(15)} ${r('down')}${r('stay')}${r('up')}${String(Math.round(s.p50)).padStart(6)}  ${String(Math.round(s.p95)).padStart(6)}  ${s.pass ? 'PASS' : 'FAIL'}`);
	}
	const refSums = Object.entries(refs).map(([name, rows]) => summarize(name, ['down', 'stay', 'up'], rows));
	say('  reference only, not candidates — the gate-1 probe\'s wordings, which omit the band line spec §5.2 gives detect:');
	for (const s of refSums) {
		const r = (k: string) => frac(s.recall[k][0], s.recall[k][1]).padEnd(14);
		say(`  ${s.name.padEnd(20)} ${frac(s.correct, s.n).padEnd(15)} ${r('down')}${r('stay')}${r('up')}${String(Math.round(s.p50)).padStart(6)}  ${String(Math.round(s.p95)).padStart(6)}  ${s.pass ? '(would pass)' : '(would fail)'}`);
	}
	say('');
	for (const s of [...sums, ...refSums]) {
		for (const l of formatSummary(s, !s.name.startsWith('ref:'))) say(l);
		say('');
	}
	say('Per case (expected | each wording\'s answer):');
	for (const g of grid) say(g);
	say('');

	// ——— social ———
	const social = readCases<SocialCase>('social.json');
	const soc: Record<string, Row[]> = { laya: [], llm: [] };
	for (const c of social) {
		const p = socialPrompt(c);
		const a = await askLaya(p);
		const b = await askLlm<{ answer: string }>(p.llmPrompt, p.schema);
		const what = `${c.question}: ${c.relation ? Object.entries(c.relation).filter(([, v]) => v !== 'neutral').map(([k, v]) => `${k} ${v}`).join(', ') || 'all neutral' : ''}; "${c.events.join(' ')}"`;
		soc.laya.push({ id: c.id, expected: c.expected, got: a.v ? a.v.best : 'error', ms: a.ms, slow: slowLaya(a), what });
		soc.llm.push({ id: c.id, expected: c.expected, got: b.v ? String(b.v.value.answer) : 'error', ms: b.ms, slow: slowLlm(b), what });
	}
	say('═══ SOCIAL (select.social: near / help), 10 cases — too few for the bar (2–4 per class), numbers only ═══');
	for (const [name, rows] of Object.entries(soc)) {
		for (const l of formatSummary(summarize(name, ['no', 'maybe', 'yes'], rows), false)) say(l);
		say('');
	}

	// ——— fit ———
	const fit = readCases<FitCase>('fit.json');
	const fr: Record<string, Row[]> = { laya: [], llm: [] };
	for (const c of fit) {
		const p = fitPrompt(c);
		const a = await askLaya(p);
		const b = await askLlm<{ answer: string }>(p.llmPrompt, p.schema);
		const what = `${c.kid.name} ${c.kid.distance} blocks, ${c.kid.doing}; "${c.action}"`;
		fr.laya.push({ id: c.id, expected: c.expected, got: a.v ? fitDecision(a.v) : 'error', ms: a.ms, slow: slowLaya(a), what: `${what} (p no ${a.v ? (a.v.probs.no ?? 0).toFixed(2) : '?'})` });
		fr.llm.push({ id: c.id, expected: c.expected, got: b.v ? String(b.v.value.answer) : 'error', ms: b.ms, slow: slowLlm(b), what });
	}
	say('═══ FIT (the judge\'s third tier), 8 cases — too few for the bar (2–3 per class), numbers only ═══');
	for (const [name, rows] of Object.entries(fr)) {
		for (const l of formatSummary(summarize(name, ['no', 'wait', 'yes'], rows), false)) say(l);
		say('');
	}

	// ——— situational ———
	const sit = readCases<SituationalCase>('situational.json');
	const sr: Row[] = [];
	for (const c of sit) {
		const p = situationalPrompt(c);
		const b = await askLlm<{ behaviour: string; because?: string }>(p.prompt, p.schema);
		sr.push({ id: c.id, expected: c.acceptable.join('|'), got: b.v ? String(b.v.value.behaviour) : 'error', ms: b.ms, slow: slowLlm(b), what: `"${c.scene}"${b.v?.value.because ? ` because: ${b.v.value.because}` : ''}` });
	}
	say('═══ SITUATIONAL (select.situational), 8 cases — a hit is any acceptable behaviour; too few for the bar ═══');
	const ss = summarize('llm', [...new Set(sr.map((r) => r.expected))], sr, (r) => r.expected.split('|').includes(r.got), [...KINDS, ...new Set(sr.map((r) => r.got).filter((g) => !KINDS.includes(g as never)))]);
	for (const l of formatSummary(ss, false)) say(l);
	say('');

	// ——— the instrument check ———
	const stay = sums.find((s) => s.name === 'always-stay')!;
	const best = sums.filter((s) => s.name !== 'always-stay').sort((a, b) => b.correct - a.correct)[0];
	say(`Best appraisal candidate: ${best.name}, ${frac(best.correct, best.n)}, ${best.pass ? 'PASSES' : 'FAILS'} the bar.`);
	say(`Passing appraisal candidates: ${sums.filter((s) => s.pass && s.name !== 'always-stay').map((s) => s.name).join(', ') || 'none'}.`);
	say(`always-stay baseline: ${stay.pass ? 'PASSES — the instrument is broken' : 'FAIL (as it must)'}.`);

	const out = join(benchDir, 'results', `${date}-${model.replace(/[^A-Za-z0-9._-]/g, '-')}.txt`);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, `${lines.join('\n')}\n`);
	console.log(`\nwrote ${out}`);
	return stay.pass ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code;
		})
		.catch((err: unknown) => {
			console.error(err instanceof Error ? err.stack : String(err));
			process.exitCode = 1;
		});
}
