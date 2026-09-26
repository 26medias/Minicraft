/**
 * The behaviour runner (spec §7): one action in flight at a time, paced by style, and every action
 * judged by safety (§7.1 tier 1), sense (tier 2) and fit (tier 3, injected) before it runs.
 */
import { CRAFTED_ONLY, WORLDGEN_BLOCKS, blockId } from 'minicraft-bot';
import { createFollowState, followTick, stopMoving, type FollowState } from '../body/act.js';
import type { StopSignal } from '../body/stop-signal.js';
import type { Body, WorldView } from '../port.js';
import type { Clock } from './clock.js';
import type { Ownership } from './ownership.js';
import type { Perceiver } from './perception.js';
import { judgeSafety, type SafetyCtx, type Tripwire } from './safety.js';
import type { Patch, Store } from './store.js';
import { styleOf, type Style } from './style.js';
import { EDIT_KINDS, type Action, type ActionEntry, type ActiveBehaviour, type BehaviourKind, type Outcome, type Vec3, type WorldEvent } from './types.js';
import { BEHAVIOURS, type Behaviour, type BehaviourCtx } from './behaviours/behaviour.js';
import { SALIENCE } from './data/salience.data.js';
import { climbPath } from './behaviours/spiral.js';
import { escapeTarget } from './behaviours/mine.js';

export type FitFn = (a: Action, ctx: BehaviourCtx) => Promise<'yes' | 'wait' | 'no'>;
export interface RunnerDeps {
	store: Store; body: Body; world: WorldView; own: Ownership; perceiver: Perceiver; tripwire: Tripwire; stop: StopSignal;
	clock: Clock; noEdits: () => boolean; fit: FitFn; log: (kind: string, data: unknown) => void; rng: () => number;
	spawn: Vec3;
	/** Tests only: replaces styleOf(state), e.g. { editGapMs: 600 } for criterion 8's fastest pacing. */
	styleOverride?: Partial<Style>;
}

const CAUSE = { kind: 'behaviour', by: 'runner' } as const;
/** Fit is asked only when a kid is this close to the action's cell (spec §7.1 tier 3). */
const FIT_RANGE = 8;
const MAX_WAITS = 3;
const MAX_REJECTIONS = 3;
const MAX_FAILURES = 3;
const PAST_KEPT = 20;
/** A climb-out walk failing this many times in a row ends the behaviour `stuck (climb)` (ruling R17). */
const MAX_CLIMB_BLOCKED = 2;

type RawEvent = Omit<WorldEvent, 'id' | 'salient' | 't'>;
interface Active {
	kind: BehaviourKind; beh: Behaviour<Record<string, unknown>, unknown>; plan: unknown; params: Record<string, unknown>; startedT: number;
	/** The newest event id when the behaviour started: a `need` event above it was written during the behaviour. */
	eventFloor: number;
}

const cellOf = (a: Action): Vec3 | null => ('cell' in a ? a.cell : null);
export function actionKey(a: Action): string {
	const o = a as { cell?: Vec3; to?: unknown; at?: Vec3; kid?: string; ms?: number };
	return a.kind + JSON.stringify(o.cell ?? o.to ?? o.at ?? o.kid ?? o.ms ?? null);
}

export class BehaviourRunner {
	private active: Active | null = null;
	private gen = 0;
	private isBusy = false;
	private waitUntil = 0;
	private lastEditT: number | null = null;
	private failures = new Map<string, number>();
	private waits = new Map<string, number>();
	private follow: FollowState = createFollowState();
	/** What the awaited body call is, so end() can cancel it. */
	private inFlight: 'walk' | 'fly' | 'mine' | null = null;
	private arrivalT = -Infinity;
	/** Ruling R17: the climb out of a dig's staircase, walked before the new behaviour's first action. */
	private climb: { digId: string; path: Array<{ x: number; z: number }>; blocked: number; fly: Vec3 | null } | null = null;
	/** Digs whose climb out failed this session: not retried, so a stuck bot can't loop on it. */
	private climbFailed = new Set<string>();

	constructor(private readonly d: RunnerDeps) {}

	get busy(): boolean {
		return this.isBusy;
	}

	/** When the last walk arrived (clock ms; −∞ before any): Expression hops right after it (spec §5.5, Task 16). */
	get lastArrivalT(): number {
		return this.arrivalT;
	}

	/** Starts a behaviour: sets state.behaviour and memory.current, calls plan(), resets the tripwire budget. */
	start(kind: BehaviourKind, params: Record<string, unknown>): void {
		if (this.active) this.end('interrupted', `switched to ${kind}`);
		const beh = BEHAVIOURS[kind];
		if (!beh) throw new Error(`no behaviour ${kind}`);
		const now = this.d.clock();
		this.gen++;
		this.waitUntil = 0;
		this.failures.clear();
		this.waits.clear();
		this.follow = createFollowState();
		const eventFloor = this.d.store.state.events.reduce((m, e) => Math.max(m, e.id), 0);
		this.active = { kind, beh, plan: null, params, startedT: now, eventFloor };
		const b: ActiveBehaviour = { kind, params, startedT: now, step: 0, rejections: 0, failures: 0, plannedEdits: 0, progress: '', lastResults: [] };
		// memory.current is an in-progress entry: if the bot dies, it reads as interrupted (outcome/why/endedT are placeholders).
		const current: ActionEntry & { startedT: number } = { behaviour: kind, params, lastedMs: 0, outcome: 'interrupted', why: 'in progress', endedT: now, startedT: now };
		this.apply([{ path: ['behaviour'], value: b }, { path: ['memory', 'current'], value: current }]);
		const ctx = this.ctx();
		const plan = beh.plan(params, ctx);
		if (plan && typeof plan === 'object' && 'failed' in plan) {
			this.end('failed', String((plan as { failed: string }).failed)); // rule 10: no stuck event
			return;
		}
		this.active.plan = plan;
		if (beh.planPatch) this.apply(beh.planPatch(plan, ctx));
		this.resetPlan();
		this.climb = this.climbFor(beh, plan, ctx.pose);
	}

	/** Ends the current behaviour with an outcome: moves memory.current to memory.past (keep 20), writes an `outcome` event, cancels motion. */
	end(outcome: Outcome, why: string): void {
		const a = this.active;
		if (!a) return;
		const body = this.d.body;
		if (this.follow.move.inFlight) stopMoving(this.follow, body);
		else if (this.inFlight === 'walk' || this.inFlight === 'fly') body.move(body.pose());
		if (this.inFlight === 'mine') body.stopMining();
		this.gen++;                                           // rule 6: a result arriving later is discarded
		this.climb = null;
		if (a.plan !== null && a.beh.endPatch) {
			// Guarded: end() also runs from tick()'s catch, so a throw here would escape tick() as an unhandled rejection.
			try {
				this.apply(a.beh.endPatch(a.plan, outcome, why, this.ctx()));   // rule 9b
			} catch (err) {
				this.d.log('error', { error: `endPatch: ${err instanceof Error ? err.message : String(err)}` });
			}
		}
		const now = this.d.clock();
		const s = this.d.store.state;
		const entry: ActionEntry = { behaviour: a.kind, params: a.params, lastedMs: now - a.startedT, outcome, why, endedT: now };
		this.active = null;
		this.apply([
			{ path: ['memory', 'past'], value: [entry, ...s.memory.past].slice(0, PAST_KEPT) },
			{ path: ['memory', 'current'], value: null },
			{ path: ['behaviour'], value: null },
		]);
		this.apply(this.eventPatch({ kind: 'outcome', detail: outcome, player: typeof a.params.kid === 'string' ? a.params.kid : undefined }));
	}

	/** Called every 100 ms (not awaited). At most one action in flight; honours pacing and gestures. */
	async tick(): Promise<void> {
		if (this.isBusy || !this.active) return;
		const s = this.d.store.state;
		if (s.body.gesture) return;
		let ctx = this.ctx();
		if (this.waitUntil > ctx.now) return;
		this.isBusy = true;                                   // rule 0: set before any await
		try {
			if (this.climb) return await this.climbTick(ctx);
			const act = this.active;
			const beh = act.beh;
			const n = beh.next(act.plan, ctx);
			this.maybeRecompute();
			if (n === 'done' || n === 'paused') return this.end(n, n);
			if ('failed' in n) return this.failed(n.failed);
			const a = n;
			if (EDIT_KINDS.has(a.kind) && this.lastEditT !== null && ctx.now - this.lastEditT < ctx.style.editGapMs) return;
			const v = judgeSafety(a, this.safetyCtx(ctx));
			if (!v.ok) return this.reject(v.reason, v.planVeto);
			const k = actionKey(a);
			if ((this.failures.get(k) ?? 0) >= MAX_FAILURES) return this.reject('same action failed 3 times', false);
			const gen = this.gen;                             // rule 9c: captured before any await
			if (this.needsFit(a, ctx)) {
				const f = await this.d.fit(a, ctx);
				if (this.gen !== gen) return;                 // ended or switched while fit was pending
				if (this.d.store.state.body.gesture) return;  // a gesture started mid-fit: don't act mid-gesture
				if (f === 'no') return this.reject('fit: no', false);
				if (f === 'wait' && (this.waits.get(k) ?? 0) < MAX_WAITS) {
					this.waits.set(k, (this.waits.get(k) ?? 0) + 1);
					this.waitUntil = this.d.clock() + 2000 + Math.floor(this.d.rng() * 2000);
					return;
				}
				ctx = this.ctx();                              // fresh: kids, pose, clock
				const again = judgeSafety(a, this.safetyCtx(ctx));   // a kid may have moved in meanwhile
				if (!again.ok) return this.reject(again.reason, again.planVeto);
			}
			await this.execute(a, ctx, gen);
		} catch (err) {
			// An exception here would otherwise escape this un-awaited tick() as an unhandled rejection (Node 22
			// crashes on those): end the behaviour instead.
			const message = err instanceof Error ? err.message : String(err);
			this.d.log('error', { error: message });
			if (this.active) this.end('failed', `error: ${message}`);
		} finally {
			this.isBusy = false;
		}
	}

	// ── internals ──

	/**
	 * Ruling R17: when a behaviour starts with the bot down on a dig's step (and it isn't the dig that behaviour
	 * carries on, `inDig`), the climb out: the dug steps back up, one walk each, then the exit beside the pillar.
	 */
	private climbFor(beh: Behaviour<Record<string, unknown>, unknown>, plan: unknown, pose: Vec3): BehaviourRunner['climb'] {
		const own = beh.inDig?.(plan) ?? null;
		for (const d of this.d.store.state.digs) {
			if (d.status === 'reverted' || d.id === own || this.climbFailed.has(d.id) || !d.spiral) continue;
			const path = climbPath(d.spiral, pose, d.stepsDone);
			if (path.length === 0) continue;
			this.d.log('climb', { dig: d.id, walks: path.length });
			return { digId: d.id, path, blocked: 0, fly: null };
		}
		return null;
	}

	/**
	 * One climb walk per tick; a cancelled walk is reissued. Blocked twice in a row → ruling R19's escape flight to
	 * the surface just outside the pillar area; only if that is blocked too (or no column qualifies) → the dig
	 * dropped, `stuck (climb)`.
	 */
	private async climbTick(ctx: BehaviourCtx): Promise<void> {
		const c = this.climb!, gen = this.gen, body = this.d.body;
		let r: 'arrived' | 'cancelled' | 'failed' = 'failed';
		this.inFlight = c.fly ? 'fly' : 'walk';
		try {
			r = c.fly ? await body.flyTo(c.fly) : await body.walkTo(c.path[0], { speed: ctx.style.walkSpeed });
		} catch {
			r = 'failed';                                     // BlockedError or a lost connection
		} finally {
			this.inFlight = null;
		}
		if (this.gen !== gen || this.climb !== c || r === 'cancelled') return;
		if (r === 'arrived') {
			if (!c.fly) this.arrivalT = this.d.clock();
			c.path.shift();
			c.blocked = 0;
			if (c.fly || c.path.length === 0) {
				this.climb = null;
				this.d.log('climb', { dig: c.digId, out: true, ...(c.fly ? { flew: c.fly } : {}) });
			}
			return;
		}
		if (!c.fly) {
			if (++c.blocked < MAX_CLIMB_BLOCKED) return;
			const sp = this.d.store.state.digs.find((d) => d.id === c.digId)?.spiral;
			c.fly = sp ? escapeTarget(sp, this.d.world, this.d.own) : null;
			if (c.fly) {
				this.d.log('climb', { dig: c.digId, fly: c.fly });
				return;
			}
		}
		this.climb = null;
		this.climbFailed.add(c.digId);
		this.apply([{ path: ['digs'], value: this.d.store.state.digs.map((d) => (d.id === c.digId ? { ...d, status: 'dropped' as const } : d)) }]);
		this.failed('stuck (climb)');
	}

	private apply(p: Patch): void {
		if (p.length) this.d.store.apply(p, CAUSE);
	}

	private eventPatch(ev: RawEvent): Patch {
		const e: WorldEvent = { ...ev, t: this.d.clock(), id: this.d.store.nextEventId(), salient: SALIENCE.ALWAYS.includes(ev.kind) };
		return [{ path: ['events'], value: [...this.d.store.state.events, e].slice(-SALIENCE.KEEP_MAX) }];
	}

	private ctx(): BehaviourCtx {
		const state = this.d.store.state;
		const now = this.d.clock();
		return {
			state, world: this.d.world, own: this.d.own, kids: this.d.perceiver.kids(), now,
			style: { ...styleOf(state), ...this.d.styleOverride }, pose: this.d.body.pose(), mustMine: this.d.world.mustMine,
			rng: this.d.rng, spawn: this.d.spawn,
			stopActive: (kid) => this.d.stop.activeFor(kid, now),
			event: (ev) => this.eventPatch(ev),
		};
	}

	private safetyCtx(ctx: BehaviourCtx): SafetyCtx {
		const act = this.active!;
		return {
			world: this.d.world, own: this.d.own, kids: ctx.kids.map((k) => ({ name: k.name, x: k.pose.x, y: k.pose.y, z: k.pose.z })),
			stop: this.d.stop, now: ctx.now, lastEditT: this.lastEditT, noEdits: this.d.noEdits(), inventory: ctx.state.inventory,
			halted: this.d.tripwire.halted ?? ctx.state.body.editsHalted, helpBuild: act.kind === 'help-build',
			planOwns: (a) => act.beh.owns(act.plan, a),
		};
	}

	private needsFit(a: Action, ctx: BehaviourCtx): boolean {
		const c = cellOf(a);
		if (!c) return false;
		return ctx.kids.some((k) => Math.hypot(k.pose.x - (c.x + 0.5), k.pose.y - (c.y + 0.5), k.pose.z - (c.z + 0.5)) <= FIT_RANGE);
	}

	private patchBehaviour(fields: Partial<ActiveBehaviour>): void {
		const b = this.d.store.state.behaviour;
		if (!b) return;
		this.apply(Object.entries(fields).map(([k, v]) => ({ path: ['behaviour', k], value: v })));
	}

	private resetPlan(): void {
		const a = this.active;
		if (!a) return;
		const n = a.beh.plannedEdits(a.plan);
		this.d.tripwire.resetPlan(n);
		this.patchBehaviour({ plannedEdits: n });
	}

	/** Rule 5: recompute the tripwire budget when the behaviour says so. */
	private maybeRecompute(): void {
		const a = this.active;
		if (a && a.beh.recompute?.(a.plan)) this.resetPlan();
	}

	/** Rule 7: a halted tripwire is written to state at once. */
	private checkHalt(): void {
		const h = this.d.tripwire.halted;
		if (h && this.d.store.state.body.editsHalted !== h) this.apply([{ path: ['body', 'editsHalted'], value: h }]);
	}

	/**
	 * A behaviour's own {failed}: `stuck…` and `hazard…` reasons also write that event (rule 9), and `need <block>`
	 * writes a `need` event unless the behaviour already wrote one for that block (Task 12b).
	 */
	private failed(why: string): void {
		if (why.startsWith('stuck')) this.apply(this.eventPatch({ kind: 'stuck', detail: why }));
		else if (why.startsWith('hazard')) this.apply(this.eventPatch({ kind: 'hazard', detail: why }));
		const need = /^need (\S+)$/.exec(why);
		const act = this.active;
		if (need && act && !this.d.store.state.events.some((e) => e.kind === 'need' && e.block === need[1] && e.id > act.eventFloor)) {
			this.apply(this.eventPatch({ kind: 'need', block: need[1], detail: need[1] }));
		}
		this.end('failed', why);
	}

	private reject(reason: string, planVeto: boolean): void {
		if (planVeto) {
			this.d.tripwire.recordPlanVeto();
			this.checkHalt();
		}
		const n = (this.d.store.state.behaviour?.rejections ?? 0) + 1;
		this.patchBehaviour({ rejections: n });
		this.d.log('reject', { reason, planVeto, rejections: n });
		if (n >= MAX_REJECTIONS) {
			this.apply(this.eventPatch({ kind: 'stuck', detail: reason }));   // rule 9, Review Focus 5
			this.end('failed', reason);
		}
	}

	private async execute(a: Action, ctx: BehaviourCtx, gen: number): Promise<void> {
		const body = this.d.body, world = this.d.world;
		const cell = cellOf(a);
		const before = cell ? world.getBlock(cell.x, cell.y, cell.z) : 0;
		let ok = false;
		let cancelled = false;
		try {
			switch (a.kind) {
				case 'place':
					ok = await body.place(a.cell.x, a.cell.y, a.cell.z, a.block);
					break;
				case 'break':
					ok = await body.break(a.cell.x, a.cell.y, a.cell.z);
					break;
				case 'mine':
					this.inFlight = 'mine';
					ok = await body.mine(a.cell.x, a.cell.y, a.cell.z);
					break;
				case 'walk': {
					this.inFlight = 'walk';
					const r = await body.walkTo(a.to, { speed: ctx.style.walkSpeed });
					cancelled = r === 'cancelled';
					ok = r === 'arrived';
					if (ok) this.arrivalT = this.d.clock();
					break;
				}
				case 'fly': {
					this.inFlight = 'fly';
					const r = await body.flyTo(a.to);
					cancelled = r === 'cancelled';
					ok = r === 'arrived';
					break;
				}
				case 'look':
					body.lookAt(a.at.x, a.at.y, a.at.z);
					ok = true;
					break;
				case 'wait':
					this.waitUntil = ctx.now + a.ms;
					ok = true;
					break;
				case 'follow-tick': {
					const kid = ctx.kids.find((k) => k.name === a.kid);
					if (kid) followTick(this.follow, body, world, { kid, kids: ctx.kids.map((k) => k.pose), followDist: ctx.style.distance, now: ctx.now });
					ok = kid !== undefined;
					break;
				}
			}
		} catch {
			ok = false;                                       // BlockedError or a lost connection: a failure of this action
		} finally {
			this.inFlight = null;
		}
		if (this.gen !== gen) {
			if (ok && cell) this.d.log('late-edit', { action: a });   // rule 6: discarded, no inventory or owned write
			return;
		}
		if (cancelled) return;                                // rule 8: reissued on a later tick, not a failure
		const now = this.d.clock();
		const patch: Patch = [];
		if (ok && cell) {
			const s = this.d.store.state;
			const inv = { ...s.inventory };
			if (a.kind === 'place') {
				patch.push(this.d.own.ownWrite(cell.x, cell.y, cell.z, blockId(a.block) ?? world.getBlock(cell.x, cell.y, cell.z)));
				if (!a.free) inv[a.block] = Math.max(0, (inv[a.block] ?? 0) - 1);
			} else {
				patch.push(this.d.own.ownWrite(cell.x, cell.y, cell.z, 0));
				const name = world.blockName(before);
				if (name && WORLDGEN_BLOCKS.includes(name) && !world.isLiquid(before) && !CRAFTED_ONLY.includes(name)) inv[name] = (inv[name] ?? 0) + 1;
			}
			patch.push({ path: ['inventory'], value: inv });
			this.d.tripwire.recordEdit(cell, now);
			this.lastEditT = now;
		}
		const k = actionKey(a);
		const b = this.d.store.state.behaviour!;
		const fields: Partial<ActiveBehaviour> = { step: b.step + 1, lastResults: [...b.lastResults, ok].slice(-3) };
		if (ok) fields.rejections = 0;
		else {
			this.failures.set(k, (this.failures.get(k) ?? 0) + 1);
			fields.failures = b.failures + 1;
		}
		if (a.kind !== 'follow-tick' || !ok) {
			patch.push(...Object.entries(fields).map(([f, v]) => ({ path: ['behaviour', f], value: v })));
		}
		this.apply(patch);
		this.checkHalt();
		const act = this.active!;
		// Called for every executed action, `wait` included (Build records its site through a wait's onResult).
		if (act.beh.onResult) this.apply(act.beh.onResult(act.plan, a, ok, this.ctx()));
		this.maybeRecompute();
	}
}
