import { GLOBAL_AXES, type AxisState, type Personality, type State } from './types.js';
import type { Clock } from './clock.js';
import { bandOf } from './emotions.js';

export type CauseKind = 'decay' | 'appraisal' | 'perception' | 'behaviour' | 'selection' | 'body' | 'persist' | 'poke' | 'gesture';
export interface Cause { kind: CauseKind; by: string; why?: string; appraisalId?: number }
export interface PatchOp { path: string[]; value: unknown }
export type Patch = PatchOp[];
export interface Change { id: number; path: string; old: unknown; new: unknown; cause: Cause; t: number }

function axis(value: number): AxisState {
	return { value, band: bandOf(value), deltas: [] };
}

export function initialState(p: Personality, pose: State['body']['pose']): State {
	const emotions = Object.fromEntries(GLOBAL_AXES.map((a) => [a, axis(p.baselines[a])])) as State['emotions'];
	return {
		personality: p, emotions, relations: {}, memory: { current: null, past: [] }, events: [],
		inventory: {}, builds: [], digs: [], owned: {}, explored: {},
		body: { pose, gesture: null, editsHalted: null }, behaviour: null, version: 0,
	};
}

function deepFreeze<T>(o: T): T {
	if (o && typeof o === 'object' && !Object.isFrozen(o)) {
		Object.freeze(o);
		for (const v of Object.values(o as object)) deepFreeze(v);
	}
	return o;
}

function equal(a: unknown, b: unknown): boolean {
	return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Structural-sharing set: copies only the objects along `path`. */
function setIn(root: unknown, path: string[], value: unknown): unknown {
	if (path.length === 0) return value;
	const [k, ...rest] = path;
	const src = (root ?? {}) as Record<string, unknown>;
	const copy: Record<string, unknown> | unknown[] = Array.isArray(src) ? [...src] : { ...src };
	const next = setIn((src as Record<string, unknown>)[k], rest, value);
	if (next === undefined && rest.length === 0) delete (copy as Record<string, unknown>)[k];
	else (copy as Record<string, unknown>)[k] = next;
	return copy;
}

function getIn(root: unknown, path: string[]): unknown {
	let o = root as Record<string, unknown> | undefined;
	for (const k of path) o = o?.[k] as Record<string, unknown> | undefined;
	return o;
}

/** The blackboard (spec §3): the only mutator; every write is recorded as a change event. */
export class Store {
	private s: State;
	private readonly subs = new Set<(c: Change[]) => void>();
	private changeId = 0;
	private eventId = 0;
	private appraisalId = 0;

	constructor(initial: State, private readonly clock: Clock) {
		this.s = deepFreeze(structuredClone(initial));
	}

	get state(): Readonly<State> {
		return this.s;
	}

	apply(patch: Patch, cause: Cause): Change[] {
		const out: Change[] = [];
		let next: unknown = this.s;
		const t = this.clock();
		for (const op of patch) {
			const old = getIn(next, op.path);
			if (equal(old, op.value)) continue;
			next = setIn(next, op.path, op.value);
			out.push({ id: ++this.changeId, path: op.path.join('.'), old, new: op.value, cause, t });
		}
		if (out.length === 0) return out;
		(next as State).version = this.s.version + 1;
		this.s = deepFreeze(next as State);
		for (const fn of this.subs) fn(out);
		return out;
	}

	subscribe(fn: (c: Change[]) => void): () => void {
		this.subs.add(fn);
		return () => this.subs.delete(fn);
	}

	nextEventId(): number {
		return ++this.eventId;
	}

	nextAppraisalId(): number {
		return ++this.appraisalId;
	}
}
