/**
 * The behaviour contract (spec §6) and the registry the runner reads. A behaviour is a planner plus a
 * step function: it proposes one action per tick, and the runner judges and executes it (spec §7).
 */
import type { WorldView } from '../../port.js';
import type { KidInfo, Pose } from '../../types.js';
import type { Ownership } from '../ownership.js';
import type { Patch } from '../store.js';
import type { Style } from '../style.js';
import type { Action, BehaviourKind, Outcome, State, Vec3, WorldEvent } from '../types.js';
import { build } from './build.js';
import { FOLLOW } from './follow.js';
import { HELP_BUILD } from './help-build.js';
import { mine } from './mine.js';
import { REST } from './rest.js';
import { WATCH } from './watch.js';

export interface BehaviourCtx {
	state: Readonly<State>; world: WorldView; own: Ownership; kids: KidInfo[]; now: number; style: Style;
	pose: Pose; mustMine: boolean; rng: () => number;
	/** World spawn: SDK worldSpawn(seed, gen) with y from groundY. Spec §6 (rev 3.3). */
	spawn: Vec3;
	/** Whether a stop signal is active for that kid now (spec §7.1: no Help-build for him). */
	stopActive: (kid: string) => boolean;
	/** A patch that appends one world event (id and salience assigned), for planPatch/onResult/endPatch. */
	event: (ev: Omit<WorldEvent, 'id' | 'salient' | 't'>) => Patch;
}
export type Next = Action | 'done' | 'paused' | { failed: string };
export interface Behaviour<P = Record<string, unknown>, PL = unknown> {
	kind: BehaviourKind;
	typicalMs: [number, number];
	/** Synchronous: long searches are Plans that advance in next(). {failed} → the runner ends the behaviour failed at once. */
	plan(params: P, ctx: BehaviourCtx): PL | { failed: string };
	/** Store writes the plan needs at once (e.g. Build records its site and cells), applied right after plan(). */
	planPatch?(plan: PL, ctx: BehaviourCtx): Patch;
	next(plan: PL, ctx: BehaviourCtx): Next;
	plannedEdits(plan: PL): number;
	owns(plan: PL, a: Action): boolean;
	/**
	 * Bookkeeping after an executed action (e.g. Mine updates its dig). The runner calls it for **every** executed
	 * action, `wait` included (Build records its site through the first `wait` after the site is chosen). Returned
	 * patch applied with cause {kind:'behaviour'}.
	 */
	onResult?(plan: PL, a: Action, ok: boolean, ctx: BehaviourCtx): Patch;
	/** Whether the result means plannedEdits must be recomputed (Help-build line extension, Build replan). */
	recompute?(plan: PL): boolean;
	/** Store writes when the behaviour ends, whatever the outcome: e.g. Build marks its build `done`, Mine marks its dig `paused`/`dropped`. The runner applies it in end(). */
	endPatch?(plan: PL, outcome: Outcome, why: string, ctx: BehaviourCtx): Patch;
}

/** The registry, filled per task. Tests may swap an entry and restore it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const BEHAVIOURS: Partial<Record<BehaviourKind, Behaviour<any, any>>> = {
	follow: FOLLOW,
	'help-build': HELP_BUILD,
	build,
	mine,
	watch: WATCH,
	rest: REST,
};

