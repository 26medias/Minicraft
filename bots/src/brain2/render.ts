/**
 * The shared prompt renderers (spec §4.3) and the prompt-budget harness (spec §3.1). Every model prompt, in the
 * brain and in the benchmark (`bots/bench/prompts.ts`), is built from these, so a bench prompt is the text the
 * brain sends. Models never see timestamps: only seconds, rounded to 5 s below a minute and to 30 s above.
 */
import { initialState } from './store.js';
import { PIP } from './data/personalities.data.js';
import { GLOBAL_AXES, RELATION_AXES, type ActionEntry, type AxisId, type AxisState, type Band, type BehaviourKind, type GlobalAxis, type Relation, type RelationAxis, type State, type WorldEvent, type WorldEventKind } from './types.js';

/** Seconds, rounded to 5 s below 60 s and to 30 s from 60 s up (spec §4.3). */
export function roundSeconds(ms: number): number {
	const s = ms / 1000;
	return s < 60 ? Math.round(s / 5) * 5 : Math.round(s / 30) * 30;
}

/** 'just now' under 5 s, else '<n> s ago' with rounded seconds. */
export function ago(ms: number): string {
	return ms < 5_000 ? 'just now' : `${roundSeconds(ms)} s ago`;
}

/** Whitespace-separated words, the unit of `promptBudgetWords` (spec §3.1). */
export function words(text: string): number {
	return text.split(/\s+/).filter(Boolean).length;
}

/**
 * The −1 / +1 words of every axis (spec §4.1 for the global axes; §4.2 gives grievance, −1 resentful, +1 grateful).
 * The spec names no poles for cooperation and respect: these are the renderer's, for Julien's label review.
 */
export const POLES: Record<GlobalAxis | RelationAxis, [string, string]> = {
	mood: ['unhappy', 'happy'],
	confidence: ['afraid', 'bold'],
	trust: ['suspicious', 'trusting'],
	affection: ['hostile', 'fond'],
	curiosity: ['avoidant', 'adventurous'],
	patience: ['irritable', 'tolerant'],
	outlook: ['discouraged', 'hopeful'],
	stimulation: ['bored', 'overstimulated'],
	cooperation: ['uncooperative', 'cooperative'],
	respect: ['unimpressed', 'admiring'],
	grievance: ['resentful', 'grateful'],
};

/** How a relation axis reads toward a player. Grievance runs resentful → grateful, so it reads as gratitude. */
const REL_NAME: Record<RelationAxis, (p: string) => string> = {
	affection: (p) => `affection for ${p}`,
	cooperation: (p) => `cooperation with ${p}`,
	respect: (p) => `respect for ${p}`,
	grievance: (p) => `gratitude to ${p}`,
};

/** An axis id split: a global axis, or a relation axis toward a player. null when it isn't a valid id. */
export function parseAxis(axis: string): { kind: 'global'; axis: GlobalAxis } | { kind: 'rel'; player: string; axis: RelationAxis } | null {
	if ((GLOBAL_AXES as readonly string[]).includes(axis)) return { kind: 'global', axis: axis as GlobalAxis };
	const m = /^rel\.(.+)\.([a-z]+)$/.exec(axis);
	if (!m || !(RELATION_AXES as readonly string[]).includes(m[2])) return null;
	return { kind: 'rel', player: m[1], axis: m[2] as RelationAxis };
}

function mustParse(axis: AxisId): NonNullable<ReturnType<typeof parseAxis>> {
	const p = parseAxis(axis);
	if (!p) throw new Error(`render: unknown axis ${axis}`);
	return p;
}

/** 'mood', or 'affection for Noah' / 'gratitude to Noah'. */
export function axisName(axis: AxisId): string {
	const p = mustParse(axis);
	return p.kind === 'global' ? p.axis : REL_NAME[p.axis](p.player);
}

/** The axis's [−1, +1] words. */
export function polesOf(axis: AxisId): [string, string] {
	return POLES[mustParse(axis).axis];
}

function axisState(axis: AxisId, s: Readonly<State>): AxisState {
	const p = mustParse(axis);
	if (p.kind === 'global') return s.emotions[p.axis];
	const r = s.relations[p.player];
	return r ? r.axes[p.axis] : { value: 0, band: 'neutral', deltas: [] };
}

/** 'My mood is high (the happy side).', 'My patience is neutral.' */
export function axisLine(axis: AxisId, s: Readonly<State>): string {
	const band = axisState(axis, s).band;
	const [lo, hi] = polesOf(axis);
	const side = band === 'neutral' ? '' : ` (the ${band.endsWith('low') ? lo : hi} side)`;
	return `My ${axisName(axis)} is ${band}${side}.`;
}

/** The axis's last 2 deltas as directions (spec §5.2), e.g. 'Before this it went up 30 s ago, down just now.'; '' when none. Causes are not rendered: they can name other players. */
export function deltasLine(axis: AxisId, s: Readonly<State>, now: number): string {
	const last = axisState(axis, s).deltas.slice(-2);
	if (last.length === 0) return '';
	return `Before this it went ${last.map((d) => `${d.amount > 0 ? 'up' : 'down'} ${ago(now - d.t)}`).join(', ')}.`;
}

/** 'How I feel about Noah: affection high, cooperation neutral, respect neutral, gratitude very low.' */
export function relationLine(player: string, s: Readonly<State>): string {
	const r = s.relations[player];
	const band = (a: RelationAxis): Band => (r ? r.axes[a].band : 'neutral');
	return `How I feel about ${player}: affection ${band('affection')}, cooperation ${band('cooperation')}, respect ${band('respect')}, gratitude ${band('grievance')}.`;
}

const blockWords = (b: string | undefined): string => (b ? b.replace(/_/g, ' ') : 'a block');

/** Which of my builds holds this cell, for 'a block of my tower'. */
function buildName(ev: WorldEvent, s?: Readonly<State>): string {
	const c = ev.cell;
	const b = c && s ? s.builds.find((x) => x.cells.some((k) => k.cell.x === c.x && k.cell.y === c.y && k.cell.z === c.z)) : undefined;
	return b ? b.template : 'build';
}

const OUTCOME: Record<string, string> = {
	done: 'I finished what I was doing', failed: 'What I was doing failed', interrupted: 'I was interrupted',
	abandoned: 'I gave up what I was doing', paused: 'I paused my dig',
};

const SENTENCE: Record<WorldEventKind, (ev: WorldEvent, s?: Readonly<State>) => string> = {
	'placed': (e) => `${e.player ?? 'Someone'} placed ${blockWords(e.block)}`,
	'broke': (e) => `${e.player ?? 'Someone'} broke ${blockWords(e.block)}`,
	'player-near': (e) => `${e.player} came near me`,
	'player-arrived': (e) => `${e.player} arrived`,
	'player-gone': (e) => `${e.player} left`,
	'broke-my-block': (e, s) => `${e.player ?? 'Someone'} broke a block of my ${buildName(e, s)}`,
	'added-to-my-build': (e, s) => `${e.player ?? 'Someone'} added a block to my ${buildName(e, s)}`,
	'line-started': (e) => `${e.player} started a line of ${blockWords(e.block)}`,
	'looking-at-me': (e) => `${e.player} looked at me`,
	'following-me': (e) => `${e.player} followed me`,
	'found': (e) => `I found ${blockWords(e.block)}`,
	'need': (e) => `I need ${blockWords(e.block ?? e.detail)}`,
	'stuck': () => 'I got stuck',
	'hazard': () => 'I ran into danger',
	'outcome': (e) => OUTCOME[e.detail ?? ''] ?? 'What I was doing ended',
};

/**
 * One event as a short sentence with a rounded 'ago': 'Noah broke a block of my tower 5 s ago.' Pass the state to
 * name the build a cell belongs to; without it, it's 'my build'.
 */
export function eventSentence(ev: WorldEvent, now: number, s?: Readonly<State>): string {
	return `${SENTENCE[ev.kind](ev, s)} ${ago(now - ev.t)}.`;
}

const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);

/** 'Build tower', 'Follow Noah', 'Mine iron ore', 'Explore'. */
function actionLabel(behaviour: BehaviourKind, params: Record<string, unknown>): string {
	const arg = [params.template, params.kid, params.block].find((v): v is string => typeof v === 'string');
	return arg ? `${cap(behaviour)} ${blockWords(arg)}` : cap(behaviour);
}

/** How many past actions the memory line shows, newest first. */
const MEMORY_PAST = 3;

/**
 * The memory line (spec §4.3): 'Now: Explore, started 10 s ago. Before: Build tower 90 s (done). Follow Noah 40 s
 * (interrupted: Noah flew away).' Newest first; `done` omits its why.
 */
export function memoryLine(s: Readonly<State>, now: number): string {
	const cur = s.memory.current;
	const head = cur ? `Now: ${actionLabel(cur.behaviour, cur.params)}, started ${ago(now - cur.startedT)}.` : 'Now: nothing yet.';
	const past = s.memory.past.slice(0, MEMORY_PAST).map((e: ActionEntry) => {
		const why = e.outcome !== 'done' && e.why ? `: ${e.why}` : '';
		return `${actionLabel(e.behaviour, e.params)} ${roundSeconds(e.lastedMs)} s (${e.outcome}${why}).`;
	});
	return past.length ? `${head} Before: ${past.join(' ')}` : head;
}

/** The busy state's players (spec §3.1: 8 players). */
export const BUSY_NAMES: readonly string[] = ['Noah', 'Mia', 'Leo', 'Ava', 'Sam', 'Zoe', 'Max', 'Ivy'];

const BUSY_NOW = 10_000_000;
const BANDS: Band[] = ['very low', 'low', 'neutral', 'high', 'very high'];
const BAND_VALUE: Record<Band, number> = { 'very low': -0.8, 'low': -0.4, 'neutral': 0, 'high': 0.4, 'very high': 0.8 };

/**
 * The prompt-budget harness's deliberately busy state (spec §3.1): 8 players with full relations (every axis with
 * deltas), 30 events, 20 past actions, a current behaviour, builds and an inventory. A renderer that leaks any of
 * it blows the 60-word budget or names another player.
 */
export function busyState(): State {
	const s = structuredClone(initialState(PIP, { x: 0, y: 70, z: 0, yaw: 0, pitch: 0 })) as State;
	const delta = (i: number) => ({ amount: i % 2 ? 0.2 : -0.1, cause: `broke-my-block by ${BUSY_NAMES[i % 8]}`, t: BUSY_NOW - 5_000 * (i + 1), appraisalId: i + 1 });
	GLOBAL_AXES.forEach((a, i) => {
		const band = BANDS[i % 5];
		s.emotions[a] = { value: BAND_VALUE[band], band, deltas: [delta(i), delta(i + 1), delta(i + 2)] };
	});
	BUSY_NAMES.forEach((n, i) => {
		const axes = Object.fromEntries(RELATION_AXES.map((a, j) => {
			const band = BANDS[(i + j) % 5];
			return [a, { value: BAND_VALUE[band], band, deltas: [delta(i + j), delta(i + j + 1)] }];
		})) as Relation['axes'];
		s.relations[n] = { axes, metSessions: 3 + i, minutesTogether: 10 * i, lastSeenT: BUSY_NOW - 1_000 * i };
	});
	const kinds: WorldEventKind[] = ['placed', 'broke', 'broke-my-block', 'added-to-my-build', 'line-started', 'looking-at-me', 'following-me', 'player-arrived', 'player-gone', 'player-near'];
	s.events = Array.from({ length: 30 }, (_, i) => ({
		id: i + 1, kind: kinds[i % kinds.length], t: BUSY_NOW - 2_000 * (30 - i), player: BUSY_NAMES[i % 8],
		cell: { x: i, y: 71, z: -i }, block: i % 2 ? 'oak_planks' : 'stone', salient: i % 3 === 0,
	}));
	const behaviours: BehaviourKind[] = ['follow', 'help-build', 'build', 'mine', 'explore', 'watch', 'rest'];
	const outcomes: ActionEntry['outcome'][] = ['done', 'interrupted', 'failed', 'abandoned', 'paused'];
	s.memory.past = Array.from({ length: 20 }, (_, i) => ({
		behaviour: behaviours[i % 7], params: { kid: BUSY_NAMES[i % 8], template: 'house', block: 'iron_ore' },
		lastedMs: 20_000 + 7_000 * i, outcome: outcomes[i % 5], why: `${BUSY_NAMES[(i + 3) % 8]} walked away`, endedT: BUSY_NOW - 60_000 * (i + 1),
	}));
	s.memory.current = { behaviour: 'help-build', params: { kid: 'Mia' }, lastedMs: 0, outcome: 'done', why: '', endedT: 0, startedT: BUSY_NOW - 45_000 };
	s.inventory = { stone: 60, dirt: 20, oak_planks: 12, iron_ore: 3 };
	s.builds = [{ id: 'b1', template: 'tower', variant: 'small', origin: { x: 20, y: 70, z: 20 }, cells: [{ cell: { x: 2, y: 71, z: -2 }, block: 'stone' }], status: 'done' }];
	return s;
}

/**
 * The prompt-budget assertion (spec §3.1): the whole request is at most `budget` whitespace words and names no
 * player outside `allowedNames` (checked against `allNames`). Throws with the counts.
 */
export function assertBudget(prompt: string, budget: number, allowedNames: string[], allNames: readonly string[]): void {
	const n = words(prompt);
	const leaked = allNames.filter((name) => !allowedNames.includes(name) && new RegExp(`\\b${name}\\b`).test(prompt));
	if (n > budget || leaked.length) {
		throw new Error(`prompt budget: ${n} words (budget ${budget}); names not allowed: ${leaked.length ? leaked.join(', ') : 'none'}`);
	}
}
