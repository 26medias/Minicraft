/**
 * Experiment E2 ("Enderman 2"): the prompts of selection's two model experts when Jev decides. Pure text from
 * state: the situational question gets one whole-state summary (≤ 80 words) and the unmasked behaviours as options;
 * social asks two yes/no questions per kid (≤ 60 words of state each).
 */
import type { KidInfo } from '../../types.js';
import type { Answer } from '../../brain/brain.js';
import type { BehaviourKind, State } from '../types.js';

export const SITUATIONAL_WORDS = 80;
export const SOCIAL_WORDS = 60;
export const SITUATIONAL_QUESTION = 'What should I do next?';
const ACTIVITY_MS = 10_000;

export const wordCount = (t: string): number => t.split(/\s+/).filter(Boolean).length;
/** The first `max` words of `t`. */
export function clip(t: string, max: number): string {
	const w = t.split(/\s+/).filter(Boolean);
	return w.length <= max ? w.join(' ') : w.slice(0, max).join(' ');
}

/** What the kid is doing, from his latest salient event, else how he moves. */
export function kidActivity(s: Readonly<State>, k: KidInfo, now: number): string {
	const e = [...s.events].reverse().find((ev) => ev.player === k.name && now - ev.t <= ACTIVITY_MS);
	switch (e?.kind) {
		case 'placed': return 'placing blocks';
		case 'broke': return 'breaking blocks';
		case 'broke-my-block': return 'breaking my blocks';
		case 'added-to-my-build': return 'adding to my build';
		case 'line-started': return 'starting a line of blocks';
		case 'looking-at-me': return 'looking at me';
		case 'following-me': return 'following me';
		default: return k.speedLast1s > 1 ? 'walking around' : 'standing still';
	}
}

function kidsLine(s: Readonly<State>, kids: KidInfo[], now: number): string {
	if (kids.length === 0) return 'Nobody is near.';
	const p = s.body.pose;
	return `Near me: ${kids.map((k) => `${k.name} ${Math.round(Math.hypot(k.pose.x - p.x, k.pose.z - p.z))} blocks away, ${kidActivity(s, k, now)}`).join('; ')}.`;
}

function inventoryLine(s: Readonly<State>): string {
	const items = Object.entries(s.inventory).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
	const total = items.reduce((n, [, v]) => n + v, 0);
	if (total === 0) return 'I carry nothing.';
	return `I carry ${total} blocks, mostly ${items.slice(0, 3).map(([b, n]) => `${n} ${b.replace(/_/g, ' ')}`).join(', ')}.`;
}

function memoryLine(s: Readonly<State>): string {
	const cur = s.behaviour ? `I am doing ${s.behaviour.kind}.` : 'I am doing nothing.';
	const last = s.memory.past[0];
	return last ? `${cur} Before, I did ${last.behaviour} for ${Math.round(last.lastedMs / 1000)} s (${last.outcome}).` : cur;
}

/** The situational state summary (≤ 80 words). */
export function situationalState(s: Readonly<State>, kids: KidInfo[], now: number): string {
	const e = s.emotions;
	return clip([
		`I am ${s.personality.name}, ${s.personality.summary}.`,
		`Mood ${e.mood.band}, curiosity ${e.curiosity.band}, stimulation ${e.stimulation.band}.`,
		kidsLine(s, kids, now),
		inventoryLine(s),
		memoryLine(s),
	].join(' '), SITUATIONAL_WORDS);
}

/** One short description per behaviour, the situational question's options. */
export function behaviourOptions(kinds: BehaviourKind[], player: string | null): Record<string, string> {
	const kid = player ?? 'the kid';
	const d: Record<BehaviourKind, string> = {
		follow: `follow ${kid} around`,
		'help-build': `help ${kid} build the line he started`,
		build: 'build something of my own',
		mine: 'dig down for blocks',
		explore: 'go exploring',
		watch: `stay near ${kid} and watch`,
		rest: 'sit down and rest',
	};
	return Object.fromEntries(kinds.map((k) => [k, d[k]]));
}

/** The winner of an answer's probabilities (ties and all-zero: Jev's own choice). */
export function winnerOfProbs(a: Answer): string {
	let best = a.best, p = a.probs[a.best] ?? 0;
	for (const [k, v] of Object.entries(a.probs)) {
		if (v > p) {
			best = k;
			p = v;
		}
	}
	return best;
}

/** The social state for one kid (≤ 60 words). */
export function socialState(s: Readonly<State>, k: KidInfo, now: number): string {
	const e = s.emotions;
	const r = s.relations[k.name];
	const rel = r ? `With ${k.name}: affection ${r.axes.affection.band}, cooperation ${r.axes.cooperation.band}, grievance ${r.axes.grievance.band}.` : `I have not met ${k.name} before.`;
	const p = s.body.pose;
	return clip([
		`I am ${s.personality.name}, ${s.personality.summary}.`,
		`Mood ${e.mood.band}, trust ${e.trust.band}.`,
		rel,
		`${k.name} is ${Math.round(Math.hypot(k.pose.x - p.x, k.pose.z - p.z))} blocks away, ${kidActivity(s, k, now)}.`,
		s.behaviour ? `I am doing ${s.behaviour.kind}.` : 'I am doing nothing.',
	].join(' '), SOCIAL_WORDS);
}

export const nearQuestion = (kid: string): string => `Do I want to be near ${kid} right now?`;
export const helpQuestion = (kid: string): string => `Does ${kid} want my help building right now?`;
export const YES_NO = { yes: 'yes', no: 'no' };
