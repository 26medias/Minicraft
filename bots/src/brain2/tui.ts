/**
 * The live terminal view (spec §8): a pure renderer from a model to lines, and a thin driver that redraws at 4 Hz
 * and reads keys (`p` poke menu, off against a live target; `q` quit). No dependencies, no colour.
 */
import { emitKeypressEvents } from 'node:readline';
import type { LogLine } from './log.js';
import type { Scheduler } from './scheduler.js';
import type { Store } from './store.js';
import { bandsPatch } from './emotions.js';
import { lastAppraisalId } from './appraisal.js';
import { GLOBAL_AXES, RELATION_AXES, type AxisId, type AxisState, type GlobalAxis, type RelationAxis, type State, type WorldEvent } from './types.js';

export interface TuiModel {
	state: Readonly<State>; lanes: ReturnType<Scheduler['lanes']>;
	health: { laya: boolean; llm: boolean; layaMs?: number; llmMs?: number } | null;   // null until part 2: shown as 'engines: code'
	lastSelect: Extract<LogLine, { k: 'select' }> | null; calls: Array<Extract<LogLine, { k: 'call' }>>; now: number; world: string; engines: string;
}
export type Poke = { kind: 'axis'; axis: AxisId; value: number } | { kind: 'event'; event: Omit<WorldEvent, 'id' | 't' | 'salient'> };

export const BAR = 20;
/** The 1-based bar column of a value in [−1, 1] (the plan's formula). */
export const barCol = (v: number): number => Math.round(((Math.max(-1, Math.min(1, v)) + 1) / 2) * (BAR - 1)) + 1;

const sign = (v: number, d = 2): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`;
/** Seconds in the view: rounded as the prompts do (5 s below a minute, 30 s above). */
function ago(ms: number): string {
	const s = Math.max(0, ms / 1000);
	if (s < 60) return `${Math.round(s / 5) * 5} s ago`;
	const r = Math.round(s / 30) * 30;
	return r % 60 === 0 ? `${r / 60} min ago` : `${Math.floor(r / 60)} min 30 s ago`;
}
const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));

/** A 20-character bar: `=` up to the value, `|` at the baseline (drawn over the fill). */
export function bar(v: number, baseline: number | null): string {
	const vc = barCol(v);
	const cells: string[] = Array.from({ length: BAR }, (_, i) => (i + 1 <= vc ? '=' : ' '));
	if (baseline !== null) cells[barCol(baseline) - 1] = '|';
	return cells.join('');
}

function axisLine(label: string, a: AxisState, baseline: number | null, now: number): string {
	const d = a.deltas.at(-1);
	const last = d ? `  Δ ${sign(d.amount)} ${d.cause} ${ago(now - d.t)}` : '';
	return `${pad(label, 12)}[${bar(a.value, baseline)}] ${pad(a.band, 9)} ${sign(a.value)}${last}`;
}

function paramsText(p: Record<string, unknown>): string {
	const parts = Object.entries(p).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
	return parts.length ? `{${parts.join(', ')}}` : '';
}

/** The view's lines (spec §8), each at most `width` characters. Pure. */
export function renderTui(m: TuiModel, width: number): string[] {
	const s = m.state;
	const out: string[] = [];
	const llmQueue = m.lanes.llm.queued.length + (m.lanes.llm.running ? 1 : 0);
	const engines = m.health === null ? 'engines: code'
		: `laya ${m.health.laya ? 'ok' : 'DOWN'}${m.health.layaMs !== undefined ? ` ${m.health.layaMs} ms` : ''} · llm ${m.health.llm ? 'ok' : 'DOWN'}${m.health.llmMs !== undefined ? ` ${m.health.llmMs} ms` : ''}`;
	out.push(`${s.personality.name} — ${s.personality.summary} · world ${m.world} · ${engines} · LLM queue ${llmQueue}${s.body.editsHalted ? ` · EDITS HALTED (${s.body.editsHalted})` : ''}`);
	out.push('');
	for (const ax of GLOBAL_AXES) out.push(axisLine(ax, s.emotions[ax], s.personality.baselines[ax], m.now));
	const rels = Object.entries(s.relations);
	if (rels.length) {
		out.push('');
		for (const [name, r] of rels) {
			out.push(`${pad(name, 12)}${RELATION_AXES.map((ax: RelationAxis) => `${ax.slice(0, 5)} ${sign(r.axes[ax].value)} ${pad(r.axes[ax].band, 9)}`).join(' ')} met ${r.metSessions} · ${Math.round(r.minutesTogether)} min`);
		}
	}
	out.push('');
	const b = s.behaviour;
	if (b) {
		const res = b.lastResults.map((ok) => (ok ? 'ok' : 'x')).join(' ') || '-';
		out.push(`behaviour: ${b.kind} ${paramsText(b.params)} · ${ago(m.now - b.startedT).replace(' ago', '')} · step ${b.step}/${b.plannedEdits} planned · last ${res} · rejections ${b.rejections}${s.body.gesture ? ` · gesture ${s.body.gesture}` : ''}`);
	} else out.push(`behaviour: idle${s.body.gesture ? ` · gesture ${s.body.gesture}` : ''}`);
	out.push(`memory: ${s.memory.past.slice(0, 4).map((e) => `${e.behaviour} ${e.outcome} (${Math.round(e.lastedMs / 1000)} s)`).join(' · ') || '-'}`);
	const sel = m.lastSelect;
	if (sel) {
		out.push('');
		out.push(`select #${sel.selectionId} ${sel.trigger}${sel.urgent ? ' (urgent)' : ''}${sel.player ? ` for ${sel.player}` : ''} → ${sel.winner ?? '-'} ${ago(m.now - sel.t)}`);
		const total = (t: number | null) => (t === null || t === -Infinity ? -Infinity : t);
		const rows = [...sel.rows].sort((a, c) => total(c.total) - total(a.total));
		for (const r of rows) {
			const t = total(r.total);
			out.push(`  ${pad(r.behaviour, 11)}${r.masked || t === -Infinity ? pad('masked', 8) : pad(sign(t), 8)} emo ${sign(r.emotional)} soc ${sign(r.social)} sit ${sign(r.situational)} in ${sign(r.inertia)} rec ${sign(r.recency)} bon ${sign(r.bonus)}`);
		}
	}
	out.push('');
	const inv = Object.entries(s.inventory).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ') || 'empty';
	out.push(`inventory: ${inv}`);
	const paused = s.digs.filter((d) => d.status === 'paused');
	out.push(`paused digs: ${paused.map((d) => `${d.block} → ${d.target.x},${d.target.y},${d.target.z} (step ${d.stepsDone})`).join(' · ') || '-'}`);
	out.push('');
	out.push('expert             engine    ms    words  fallback  patch  answer');
	for (const c of m.calls.slice(-8).reverse()) {
		const ans = c.answer === undefined ? '' : JSON.stringify(c.answer);
		out.push(`${pad(c.expert, 19)}${pad(c.engine, 10)}${pad(String(c.latencyMs), 6)}${pad(String(c.promptWords ?? '-'), 7)}${pad(c.fallback ? `yes${c.reason ? ` (${c.reason})` : ''}` : 'no', 10)}${pad(String(c.patch.length), 7)}${ans}`);
	}
	return out.map((l) => (l.length > width ? l.slice(0, width) : l));
}

/**
 * Applies a poke (spec §8). An axis poke sets the value and acts as an appraisal (a delta with its own appraisal
 * id, cause kind `appraisal` by `poke`), so the gesture table and the selection trigger see it as they would a real
 * one; an event poke appends a salient event, which the appraisal expert then reads.
 */
export function applyPoke(store: Store, p: Poke, now: number): void {
	const s = store.state;
	if (p.kind === 'event') {
		const e: WorldEvent = { ...p.event, id: store.nextEventId(), t: now, salient: true };
		store.apply([{ path: ['events'], value: [...s.events, e].slice(-30) }], { kind: 'poke', by: 'tui', why: p.event.kind });
		return;
	}
	const value = Math.max(-1, Math.min(1, p.value));
	const m = /^rel\.(.+)\.([a-z]+)$/.exec(p.axis);
	const path = m ? ['relations', m[1], 'axes', m[2]] : ['emotions', p.axis];
	const a: AxisState | undefined = m ? s.relations[m[1]]?.axes[m[2] as RelationAxis] : s.emotions[p.axis as GlobalAxis];
	if (!a) return;
	const id = lastAppraisalId(s) + 1;
	const deltas = [...a.deltas, { amount: value - a.value, cause: 'poke', t: now, appraisalId: id }].slice(-10);
	const next = structuredClone(s) as State;
	if (m) next.relations[m[1]].axes[m[2] as RelationAxis] = { ...a, value, deltas };
	else next.emotions[p.axis as GlobalAxis] = { ...a, value, deltas };
	store.apply([{ path: [...path, 'value'], value }, { path: [...path, 'deltas'], value: deltas }, ...bandsPatch(next)], { kind: 'appraisal', by: 'poke', appraisalId: id, why: 'poke' });
}

const POKE_VALUES = [-0.8, -0.4, 0, 0.4, 0.8];
type RawEvent = Omit<WorldEvent, 'id' | 't' | 'salient'>;
const POKE_EVENTS: Array<{ key: string; label: string; event: (kid: string | undefined) => RawEvent }> = [
	{ key: 'a', label: 'player-arrived', event: (kid) => ({ kind: 'player-arrived', player: kid ?? 'Noah' }) },
	{ key: 'b', label: 'broke-my-block', event: (kid) => ({ kind: 'broke-my-block', player: kid ?? 'Noah' }) },
	{ key: 'f', label: 'found', event: () => ({ kind: 'found', block: 'diamond_ore' }) },
	{ key: 'o', label: 'outcome done', event: () => ({ kind: 'outcome', detail: 'done' }) },
];

/** The poke menu's text for the footer. */
function menuText(stage: 'axis' | { axis: GlobalAxis } | null, note: string, canPoke: boolean): string {
	if (stage === 'axis') return `poke: axis ${GLOBAL_AXES.map((a, i) => `${i + 1}=${a}`).join(' ')}; event ${POKE_EVENTS.map((e) => `${e.key}=${e.label}`).join(' ')}; esc cancels`;
	if (stage) return `poke ${stage.axis}: ${POKE_VALUES.map((v, i) => `${i + 1}=${sign(v, 1)}`).join(' ')}; esc cancels`;
	return `${canPoke ? 'p poke' : 'poke off (live target)'} · q quit${note ? ` · ${note}` : ''}`;
}

/**
 * The terminal driver: clears and redraws at 4 Hz, reads keys in raw mode. `poke` absent (a live target) turns the
 * poke menu off. Returns the stop function (restores the terminal).
 */
export function startTui(d: { model: () => TuiModel; poke?: (p: Poke) => void; quit?: () => void; out?: NodeJS.WriteStream; inp?: NodeJS.ReadStream; kid?: () => string | undefined }): () => void {
	const out = d.out ?? process.stdout;
	const inp = d.inp ?? process.stdin;
	let stage: 'axis' | { axis: GlobalAxis } | null = null;
	let note = '';
	const draw = () => {
		const lines = renderTui(d.model(), out.columns || 120);
		lines.push('', menuText(stage, note, !!d.poke));
		out.write('\x1b[H\x1b[2J' + lines.join('\n'));
	};
	const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
		const k = key?.name ?? str ?? '';
		if (key?.ctrl && k === 'c') return d.quit?.();
		if (stage === null) {
			if (k === 'q') return d.quit?.();
			if (k === 'p') {
				if (d.poke) stage = 'axis';
				else note = 'poke refused: live target';
			}
		} else if (k === 'escape') stage = null;
		else if (stage === 'axis') {
			const n = Number(str);
			const ev = POKE_EVENTS.find((e) => e.key === str);
			if (n >= 1 && n <= GLOBAL_AXES.length) stage = { axis: GLOBAL_AXES[n - 1] };
			else if (ev && d.poke) {
				d.poke({ kind: 'event', event: ev.event(d.kid?.()) });
				note = `poked ${ev.label}`;
				stage = null;
			}
		} else {
			const n = Number(str);
			if (n >= 1 && n <= POKE_VALUES.length && d.poke) {
				d.poke({ kind: 'axis', axis: stage.axis, value: POKE_VALUES[n - 1] });
				note = `poked ${stage.axis} ${sign(POKE_VALUES[n - 1], 1)}`;
				stage = null;
			}
		}
		draw();
	};
	emitKeypressEvents(inp);
	if (inp.isTTY) inp.setRawMode(true);
	inp.on('keypress', onKey);
	inp.resume();
	draw();
	const timer = setInterval(draw, 250);
	return () => {
		clearInterval(timer);
		inp.off('keypress', onKey);
		if (inp.isTTY) inp.setRawMode(false);
		inp.pause();
		out.write('\n');
	};
}
