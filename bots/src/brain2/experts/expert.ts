import type { Answer, Choice } from '../../brain/brain.js';
import type { Cause, Change, Patch } from '../store.js';
import type { State, WorldEvent } from '../types.js';

export type EngineChoice = 'code' | 'laya' | 'llm' | 'both-agree' | 'llm-dir-laya-stay';
export interface Signal { changes: Change[]; events: WorldEvent[] } // accumulated since the expert last fired
export type Trigger =
	| { kind: 'every'; ms: number }
	| { kind: 'on'; match: (s: Signal) => boolean }
	| { kind: 'debounce'; match: (s: Signal) => boolean; quietMs: number; maxWaitMs: number };
export const every = (ms: number): Trigger => ({ kind: 'every', ms });
export const on = (match: (s: Signal) => boolean): Trigger => ({ kind: 'on', match });
export const debounce = (match: (s: Signal) => boolean, o: { quietMs: number; maxWaitMs: number }): Trigger => ({ kind: 'debounce', match, ...o });
export interface LayaEngine { healthy(): boolean; ask(state: string, q: Choice, signal: AbortSignal): Promise<Answer> }
export interface LlmEngine { healthy(): boolean; json<T>(prompt: string, schema: object, signal: AbortSignal): Promise<{ value: T; raw: string }> }
export interface Engines { laya: LayaEngine | null; llm: LlmEngine | null }
export interface CallRecord { prompt?: string; promptWords?: number; answer?: unknown; selectionId?: number } // selectionId: criterion 6 links calls to the select line
export interface RunCtx { signal: AbortSignal; engines: Engines; record(r: CallRecord): void }
export type Lane = 'code' | 'laya' | 'llm';
export interface Expert<S = unknown, P = unknown> {
	name: string;
	layer: 0 | 1 | 2 | 3 | 4 | 5;
	trigger: Trigger;
	engine: EngineChoice;
	/** Lane priority: Laya lane fit 3 > social 2 > appraisal 1; LLM lane selection 3 > params 2 > appraisal 1 > other 0. */
	priority: number;
	reads(s: Readonly<State>, sig: Signal): S;
	materialKey(slice: S): string;
	run(slice: S, ctx: RunCtx): Promise<P>;
	/** Pure code. null means invalid (a failure → fallback). */
	merge(p: P, s: Readonly<State>): { patch: Patch; cause: Cause } | null;
	fallback(slice: S): P;
	promptBudgetWords?: number;
}
export function laneOf(e: EngineChoice): Lane {
	return e === 'code' ? 'code' : e === 'laya' ? 'laya' : 'llm';
}
export const TIMEOUT_MS: Record<Lane, number> = { code: 0, laya: 400, llm: 5000 };
