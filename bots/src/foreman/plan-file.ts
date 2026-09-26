/**
 * The foreman's shared plan (experiment E7): `<stateRoot>/shared/<target>/<world>/plan.json`, one neighbourhood per
 * world. It lists the lots (origin, footprint, height limit, status open → claimed → built, or dropped when a lot
 * turned out unusable) and the road and lamp cells the foreman builds itself. Builder and architect bots started with
 * `--join-plan` claim the next open lot: first come, first served, no negotiation. A claim not renewed for CLAIM_MS
 * (a crashed bot) expires and the lot is open again.
 *
 * Every read-modify-write runs under a lock: a directory beside the file, made with mkdir (atomic on one machine);
 * a lock older than LOCK_STALE_MS (a process killed inside the critical section) is broken. Writes are atomic (a
 * temp file, then rename), so a reader never sees a torn file.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Vec3 } from '../types.js';

export const CLAIM_MS = 15 * 60_000;
export const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5000;

export type LotStatus = 'open' | 'claimed' | 'built' | 'dropped';
export interface PlanLot {
	id: string;
	/** The lot's (0,0,0): its north-west corner at ground + 1. */
	origin: Vec3; w: number; d: number;
	/** The tallest build the lot has headroom for. */
	h: number;
	status: LotStatus; claimedBy?: string; claimedAt?: number;
	/** Set by the bot that claimed it: what it builds there, and the build record's id. */
	design?: string; buildId?: string; builtAt?: number; why?: string;
	/** How many times the lot was dropped; the foreman stops reopening it at join.ts's MAX_DROPS. */
	dropCount?: number;
}
export interface PlanCell { cell: Vec3; block: string }
export interface NeighbourhoodPlan {
	v: 1; id: string; foreman: string; t: number;
	/** The anchor the search started from, the grid (cols × rows) and its north-west corner. */
	anchor: Vec3; corner: { x: number; z: number }; cols: number; rows: number;
	lots: PlanLot[];
	roads: PlanCell[]; lamps: PlanCell[];
}

export function planFilePath(stateRoot: string, target: string, world: string): string {
	return join(stateRoot, 'shared', target, world, 'plan.json');
}

export function readPlan(path: string): NeighbourhoodPlan | null {
	try {
		const p = JSON.parse(readFileSync(path, 'utf8')) as NeighbourhoodPlan;
		if (p && p.v === 1 && Array.isArray(p.lots)) return p;
	} catch {
		// missing or unreadable
	}
	return null;
}

function writePlan(path: string, p: NeighbourhoodPlan): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	writeFileSync(tmp, JSON.stringify(p));
	renameSync(tmp, path);
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Runs `fn` holding the plan's lock (a mkdir'd directory beside it); throws when the lock cannot be had in 5 s. */
export function withPlanLock<T>(path: string, fn: () => T): T {
	const lock = `${path}.lock`;
	mkdirSync(dirname(path), { recursive: true });
	const t0 = Date.now();
	for (;;) {
		try {
			mkdirSync(lock);
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
			try {
				if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
					rmSync(lock, { recursive: true, force: true });
					continue;
				}
			} catch {
				continue; // released meanwhile
			}
			if (Date.now() - t0 > LOCK_WAIT_MS) throw new Error(`plan lock busy: ${lock}`);
			sleepSync(5 + Math.floor(Math.random() * 20));
		}
	}
	try {
		return fn();
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}

/** Writes `p` unless a plan exists already; returns the plan on disk afterwards (the existing one wins). */
export function createPlan(path: string, p: NeighbourhoodPlan): NeighbourhoodPlan {
	return withPlanLock(path, () => {
		const cur = readPlan(path);
		if (cur) return cur;
		writePlan(path, p);
		return p;
	});
}

/** Whether a lot can be claimed now: open, or claimed with a claim older than `claimMs`. */
export function claimable(l: PlanLot, now: number, claimMs = CLAIM_MS): boolean {
	return l.status === 'open' || (l.status === 'claimed' && now - (l.claimedAt ?? 0) > claimMs);
}

/**
 * Claims a lot for `bot`: the lot it already holds (a restart resumes it), else the first claimable one, else null
 * (no plan, or every lot is taken). `fits` narrows the lots this bot can build on.
 */
export function claimLot(path: string, bot: string, now: number, fits: (l: PlanLot) => boolean = () => true, claimMs = CLAIM_MS): PlanLot | null {
	return withPlanLock(path, () => {
		const p = readPlan(path);
		if (!p) return null;
		let lot = p.lots.find((l) => l.status === 'claimed' && l.claimedBy === bot) ?? null;
		lot ??= p.lots.find((l) => claimable(l, now, claimMs) && fits(l)) ?? null;
		if (!lot) return null;
		lot.status = 'claimed';
		lot.claimedBy = bot;
		lot.claimedAt = now;
		writePlan(path, p);
		return lot;
	});
}

/**
 * Updates `bot`'s lot `lotId`: renews the claim (and records `design`/`buildId`), or ends it (built, dropped, or back
 * to open). False when the lot is no longer this bot's (its claim expired and another bot took it).
 */
export function updateLot(path: string, lotId: string, bot: string, now: number, u: { status?: 'claimed' | 'built' | 'dropped' | 'open'; design?: string; buildId?: string; why?: string }): boolean {
	return withPlanLock(path, () => {
		const p = readPlan(path);
		const lot = p?.lots.find((l) => l.id === lotId);
		if (!p || !lot || lot.status !== 'claimed' || lot.claimedBy !== bot) return false;
		if (u.design !== undefined) lot.design = u.design;
		if (u.buildId !== undefined) lot.buildId = u.buildId;
		if (u.why !== undefined) lot.why = u.why;
		const status = u.status ?? 'claimed';
		lot.status = status;
		if (status === 'claimed') lot.claimedAt = now;
		else if (status === 'built') lot.builtAt = now;
		else if (status === 'dropped') lot.dropCount = (lot.dropCount ?? 0) + 1;
		else if (status === 'open') {
			delete lot.claimedBy;
			delete lot.claimedAt;
		}
		writePlan(path, p);
		return true;
	});
}

/** Puts the dropped lots `ids` back to open (claim cleared, dropCount kept); returns the ids actually reopened. */
export function reopenLots(path: string, ids: readonly string[]): string[] {
	if (ids.length === 0) return [];
	return withPlanLock(path, () => {
		const p = readPlan(path);
		if (!p) return [];
		const out: string[] = [];
		for (const l of p.lots) {
			if (!ids.includes(l.id) || l.status !== 'dropped') continue;
			l.status = 'open';
			delete l.claimedBy;
			delete l.claimedAt;
			delete l.why;
			out.push(l.id);
		}
		if (out.length) writePlan(path, p);
		return out;
	});
}

/** The plan's lots as avoid boxes (full lot height), for bots searching their own sites. */
export function planAvoidBoxes(path: string | undefined): Array<{ min: Vec3; max: Vec3 }> {
	const p = path ? readPlan(path) : null;
	if (!p) return [];
	const xs = [...p.lots.map((l) => l.origin.x), ...p.roads.map((c) => c.cell.x)];
	const zs = [...p.lots.map((l) => l.origin.z), ...p.roads.map((c) => c.cell.z)];
	const x1 = Math.max(...p.lots.map((l) => l.origin.x + l.w - 1), ...xs), z1 = Math.max(...p.lots.map((l) => l.origin.z + l.d - 1), ...zs);
	const y = Math.min(...p.lots.map((l) => l.origin.y));
	// The whole neighbourhood (lots and roads) as one box: nobody else builds in it.
	return [{ min: { x: Math.min(...xs), y, z: Math.min(...zs) }, max: { x: x1, y: y + Math.max(...p.lots.map((l) => l.h)), z: z1 } }];
}
