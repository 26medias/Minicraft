/**
 * The benchmark's prompts (spec §9.2), built through `src/brain2/render.ts` so a bench prompt is the text the brain
 * will send. Each case's state is the prompt-budget harness's busy state (8 players, 30 events, 20 past actions)
 * with the case's axis set, so a renderer that leaked the state would blow the 60-word budget here too.
 */
import type { Choice } from '../src/brain/brain.js';
import { PIP } from '../src/brain2/data/personalities.data.js';
import { axisLine, axisName, busyState, deltasLine, parseAxis, polesOf, relationLine } from '../src/brain2/render.js';
import { RELATION_AXES, type AxisId, type Band, type BehaviourKind, type RelationAxis, type State } from '../src/brain2/types.js';

export type Dir = 'down' | 'stay' | 'up';
export interface AppraisalCase { id: string; axis: AxisId; value: Band; lastDeltas: Array<{ amount: number; agoMs: number }>; events: string[]; expected: Dir }
export interface SocialCase { id: string; kid: string; relation: Record<RelationAxis, Band>; events: string[]; question: 'near' | 'help'; expected: 'no' | 'maybe' | 'yes' }
export interface FitCase { id: string; personality: string; emotion: string; kid: { name: string; distance: number; doing: string }; action: string; expected: 'no' | 'wait' | 'yes' }
export interface SituationalCase { id: string; scene: string; acceptable: BehaviourKind[] }

/** A Laya question or an LLM call; `text` is the whole request's prose, which the budget counts. */
export type BenchPrompt = { name: string; text: string } & ({ engine: 'laya'; state: string; q: Choice } | { engine: 'llm'; prompt: string; schema: object });

const NOW = 10_000_000;
const BAND_VALUE: Record<Band, number> = { 'very low': -0.8, 'low': -0.4, 'neutral': 0, 'high': 0.4, 'very high': 0.8 };
const DIRS: Dir[] = ['down', 'stay', 'up'];
export const KINDS: BehaviourKind[] = ['follow', 'help-build', 'build', 'mine', 'explore', 'watch', 'rest'];

const layaText = (state: string, q: Choice): string => `${state} ${q.instructions} ${Object.entries(q.options).map(([k, v]) => `${k}: ${v}`).join(' ')}`;
const laya = (name: string, state: string, q: Choice): BenchPrompt => ({ name, engine: 'laya', state, q, text: layaText(state, q) });
const llm = (name: string, prompt: string, schema: object): BenchPrompt => ({ name, engine: 'llm', prompt, schema, text: prompt });
const join = (...parts: string[]): string => parts.filter(Boolean).join(' ');

/** The busy state with the case's axis at its band and last deltas. */
export function caseState(c: AppraisalCase): State {
	const s = busyState();
	const a = { value: BAND_VALUE[c.value], band: c.value, deltas: c.lastDeltas.map((d, i) => ({ amount: d.amount, cause: '', t: NOW - d.agoMs, appraisalId: i + 1 })) };
	const p = parseAxis(c.axis);
	if (!p) throw new Error(`bench: bad axis ${c.axis}`);
	if (p.kind === 'global') s.emotions[p.axis] = a;
	else s.relations[p.player].axes[p.axis] = a;
	return s;
}

/** ' toward Noah' for a relation axis, '' for a global one. */
const toward = (axis: AxisId): string => {
	const p = parseAxis(axis);
	return p?.kind === 'rel' ? ` toward ${p.player}` : '';
};

/** The few-shot examples (spec §5.2: 4 labelled examples, one of them `stay`), taken from the bench cases. A case
 *  is never its own example: when it is one, its alternate (same class) stands in. */
export const FEWSHOT: Array<{ id: string; alt: string }> = [
	{ id: 'a02', alt: 'a38' },   // down
	{ id: 'a09', alt: 'a19' },   // stay
	{ id: 'a17', alt: 'a01' },   // up
	{ id: 'a32', alt: 'a11' },   // up, a relation axis
];

export function fewShotExamples(c: AppraisalCase, all: readonly AppraisalCase[]): AppraisalCase[] {
	const byId = new Map(all.map((x) => [x.id, x]));
	return FEWSHOT.map((f) => byId.get(f.id === c.id ? f.alt : f.id)).filter((x): x is AppraisalCase => !!x);
}

/**
 * The few-shot wording's example block: 'Examples: Noah broke a block of my house: mood down. …' It's fixed text,
 * not state, and alone it is ~38 words, so the few-shot prompt is held to 60 words **plus** this block (the 60-word
 * budget of spec §3.1 is Laya's; few-shot is an LLM-only wording).
 */
export function fewShotBlock(c: AppraisalCase, all: readonly AppraisalCase[]): string {
	return `Examples: ${fewShotExamples(c, all).map((e) => `${e.events.join(' ').replace(/\.$/, '')}: ${axisName(e.axis)} ${e.expected}.`).join(' ')}`;
}

export const THREE_WAY: Choice['options'] = { down: 'it goes down', stay: 'it stays the same', up: 'it goes up' };
export const YES_NO: Choice['options'] = { yes: 'yes', no: 'no' };

/** The LLM's direction schema, one enum per axis of the burst (here: the case's one axis). */
export const dirSchema = (axis: AxisId): object => ({ type: 'object', properties: { [axis]: { type: 'string', enum: DIRS } }, required: [axis] });

/**
 * Every appraisal wording for one case (spec §5.2): Laya three-way; Laya binary (two calls, "more ‹hi›?" and
 * "more ‹lo›?"); the LLM batched call; the LLM few-shot call. The combinations reuse these answers.
 */
export function appraisalPrompts(c: AppraisalCase, all: readonly AppraisalCase[] = []): BenchPrompt[] {
	const s = caseState(c);
	const [lo, hi] = polesOf(c.axis);
	const name = axisName(c.axis);
	const line = axisLine(c.axis, s);
	const deltas = deltasLine(c.axis, s, NOW);
	const events = `Just now: ${c.events.join(' ')}`;
	const llmPrompt = (examples: string) => join(
		examples, events, line, deltas,
		`Does my ${name} (from ${lo} to ${hi}) go down, stay, or go up? Answer as JSON.`,
	);
	const ex = fewShotBlock(c, all);
	return [
		laya('laya-3way', join(line, `It goes from ${lo} to ${hi}.`, deltas, events), { type: 'choice', instructions: `Does my ${name} go down, stay, or go up?`, options: THREE_WAY }),
		laya('laya-hi', join(events, line, deltas), { type: 'choice', instructions: `Does this make me more ${hi}${toward(c.axis)}?`, options: YES_NO }),
		laya('laya-lo', join(events, line, deltas), { type: 'choice', instructions: `Does this make me more ${lo}${toward(c.axis)}?`, options: YES_NO }),
		llm('llm', llmPrompt(''), dirSchema(c.axis)),
		...(all.length ? [llm('llm-fewshot', llmPrompt(ex), dirSchema(c.axis))] : []),
	];
}

/**
 * Reference only, not a candidate: the gate-1 probe's exact wordings (`probe2.py` variant D, and its LLM direction
 * call). They see the event and the poles but **not** the band line or the deltas that spec §5.2 gives detect, so the
 * report can show what that line costs.
 */
export function gateReferencePrompts(c: AppraisalCase): BenchPrompt[] {
	const [lo, hi] = polesOf(c.axis);
	const ev = `Just now: ${c.events.join(' ')}`;
	const schema = { type: 'object', properties: { direction: { type: 'string', enum: DIRS } }, required: ['direction'] };
	return [
		laya('gate-laya-hi', ev, { type: 'choice', instructions: `Does this make me more ${hi}?`, options: YES_NO }),
		laya('gate-laya-lo', ev, { type: 'choice', instructions: `Does this make me more ${lo}?`, options: YES_NO }),
		llm('gate-llm', `A robot friend in a block game. ${ev}\nDoes its ${axisName(c.axis)} (from -1 ${lo} to +1 ${hi}) go down, stay, or go up? JSON.`, schema),
	];
}

const answerSchema = (options: string[]): object => ({ type: 'object', properties: { answer: { type: 'string', enum: options } }, required: ['answer'] });

/** The social question for one kid (spec §5.3): that kid's relation bands and events only, never the behaviour list. */
export function socialPrompt(c: SocialCase): BenchPrompt & { llmPrompt: string; schema: object } {
	const s = busyState();
	const r = s.relations[c.kid];
	for (const a of RELATION_AXES) r.axes[a] = { value: BAND_VALUE[c.relation[a] ?? 'neutral'], band: c.relation[a] ?? 'neutral', deltas: [] };
	const state = join(relationLine(c.kid, s), `Just now: ${c.events.join(' ')}`);
	const instructions = c.question === 'near' ? `Do I want to be near ${c.kid} right now?` : `Does ${c.kid} seem to want help?`;
	const q: Choice = { type: 'choice', instructions, options: { no: 'no', maybe: 'maybe', yes: 'yes' } };
	return { ...laya(`social-${c.question}`, state, q), llmPrompt: join('I am a robot friend in a block game.', state, instructions, 'Answer as JSON.'), schema: answerSchema(['no', 'maybe', 'yes']) };
}

/** The fit question (spec §7.1): may I do this edit now, with this kid this close? */
export function fitPrompt(c: FitCase): BenchPrompt & { llmPrompt: string; schema: object } {
	const state = `I am ${c.personality}. I feel ${c.emotion}. ${c.kid.name} is ${c.kid.distance} blocks away, ${c.kid.doing}. I want to ${c.action}.`;
	const q: Choice = { type: 'choice', instructions: 'Should I do it now?', options: { no: 'no, not now', wait: 'wait a moment', yes: 'yes, go ahead' } };
	return { ...laya('fit', state, q), llmPrompt: join('I am a robot friend in a block game.', state, 'Should I do it now: no, wait, or yes? Answer as JSON.'), schema: answerSchema(['no', 'wait', 'yes']) };
}

/** The situational pass (spec §5.3): the whole scene as prose, output `{behaviour, params, because}`. */
export function situationalPrompt(c: SituationalCase): { prompt: string; schema: object } {
	const schema = {
		type: 'object',
		properties: {
			behaviour: { type: 'string', enum: KINDS },
			params: { type: 'object', properties: { player: { type: 'string' }, template: { type: 'string' }, block: { type: 'string' } } },
			because: { type: 'string' },
		},
		required: ['behaviour', 'params', 'because'],
	};
	const prompt = join(`I am ${PIP.summary}, a robot friend in a block game. Pick what I do next.`, c.scene, `Behaviours: ${KINDS.join(', ')}.`, 'Answer as JSON with behaviour, params and because.');
	return { prompt, schema };
}
