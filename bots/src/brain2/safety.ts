import { forbiddenByKids } from '../body/guard.js';
import type { StopSignal } from '../body/stop-signal.js';
import type { WorldView } from '../port.js';
import type { Ownership } from './ownership.js';
import { EDIT_KINDS, type Action, type Vec3 } from './types.js';
import { LIMITS } from './data/limits.data.js';

export interface KidPos { name: string; x: number; y: number; z: number }
export interface SafetyCtx {
	world: WorldView; own: Ownership; kids: KidPos[]; stop: StopSignal; now: number; lastEditT: number | null;
	noEdits: boolean; inventory: Readonly<Record<string, number>>; halted: string | null;
	helpBuild: boolean; planOwns: (a: Action) => boolean;
	/** The builder bot (unlimited blocks): free places allowed outside Help-build. Default false. */
	allowFree?: boolean;
}
export type Verdict = { ok: true } | { ok: false; tier: 'safety'; reason: string; planVeto: boolean };
const no = (reason: string, planVeto = false): Verdict => ({ ok: false, tier: 'safety', reason, planVeto });
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;

/** The hard veto (spec §7.1). Nothing overrides it. */
export function judgeSafety(a: Action, c: SafetyCtx): Verdict {
	if (!EDIT_KINDS.has(a.kind)) return { ok: true };
	const { x, y, z } = (a as { cell: Vec3 }).cell;
	if (c.halted) return no(`edits halted: ${c.halted}`);
	if (c.noEdits) return no('--no-edits');
	if (c.lastEditT !== null && c.now - c.lastEditT < LIMITS.EDIT_GAP_MIN_MS) return no('edit gap');
	if (!c.planOwns(a)) return no('not in the plan', true);
	if (forbiddenByKids({ x, y, z }, c.kids)) return no('kid body buffer');
	for (const k of c.kids) {
		if (c.stop.activeFor(k.name, c.now) && Math.hypot(x - k.x, z - k.z) <= LIMITS.STOP_RADIUS) return no(`stop signal: ${k.name}`);
	}
	const cls = c.own.classify(x, y, z);
	if (a.kind === 'place') {
		if (c.world.getBlock(x, y, z) !== 0) return no('cell not air');
		if (!c.helpBuild && (cls === 'kid' || c.own.kidNeighbour(x, y, z, 1))) return no('kid cell buffer');
		if (!(a as { free?: boolean }).free && (c.inventory[(a as { block: string }).block] ?? 0) <= 0) return no('nothing to place');
		if ((a as { free?: boolean }).free && !c.helpBuild && !c.allowFree) return no('free blocks are Help-build only');
	} else {
		if (cls === 'kid' || c.own.kidNeighbour(x, y, z, 1) || c.own.kidNeighbour(x, y, z, 2, true)) return no('kid cell buffer');
		for (const [dx, dy, dz] of FACES) if (c.world.isLiquid(c.world.getBlock(x + dx, y + dy, z + dz))) return no('touches liquid');
	}
	return { ok: true };
}

/** The runaway tripwire (spec §7.2): halts all edits for the session. */
export class Tripwire {
	private times: number[] = [];
	private cellTimes = new Map<string, number[]>();
	/** Infinity until the first resetPlan: a stray veto before any plan must not halt the session. */
	private planned = Infinity;
	private count = 0;
	private reason: string | null = null;
	constructor(private readonly gapMs = LIMITS.EDIT_GAP_MIN_MS) {}
	get halted(): string | null {
		return this.reason;
	}
	resetPlan(plannedEdits: number): void {
		this.planned = plannedEdits;
		this.count = 0;
	}
	recordEdit(cell: Vec3, now: number): void {
		this.times.push(now);
		while (this.times.length && this.times[0] <= now - 60_000) this.times.shift();
		if (this.times.length > (60_000 / this.gapMs) * LIMITS.TRIP_RATE_FACTOR) this.trip(`rate: ${this.times.length} edits in 60 s`);
		const k = `${cell.x},${cell.y},${cell.z}`;
		const ts = (this.cellTimes.get(k) ?? []).filter((t) => t > now - LIMITS.TRIP_CHURN_WINDOW_MS);
		ts.push(now);
		this.cellTimes.set(k, ts);
		if (ts.length >= LIMITS.TRIP_CHURN) this.trip(`churn: ${k} edited ${ts.length}× in 10 min`);
		this.count++;
		this.checkOverrun();
	}
	/**
	 * A batched edit of `cells` (a pickaxe's area break): one edit for the rate, churn per cell, and the cells are added
	 * to the plan as they are counted, so legitimate area mining never trips the overrun.
	 */
	recordBatch(cells: readonly Vec3[], now: number): void {
		if (cells.length === 0) return;
		this.planned += cells.length;
		this.recordEdit(cells[0], now);
		this.count += cells.length - 1;
		for (const c of cells.slice(1)) {
			const k = `${c.x},${c.y},${c.z}`;
			const ts = (this.cellTimes.get(k) ?? []).filter((t) => t > now - LIMITS.TRIP_CHURN_WINDOW_MS);
			ts.push(now);
			this.cellTimes.set(k, ts);
			if (ts.length >= LIMITS.TRIP_CHURN) this.trip(`churn: ${k} edited ${ts.length}× in 10 min`);
		}
		this.checkOverrun();
	}
	recordPlanVeto(): void {
		this.count++;
		this.checkOverrun();
	}
	private checkOverrun(): void {
		if (this.count > this.planned * LIMITS.TRIP_OVERRUN) this.trip(`overrun: ${this.count} > ${this.planned} planned`);
	}
	private trip(why: string): void {
		this.reason ??= why;
	}
}
