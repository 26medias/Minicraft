/**
 * `--join-plan` for the builder and the architect (experiment E7): claim the foreman's next open lot that fits,
 * re-check the chosen footprint against brain2's site rules at the lot (the world may have changed since the plan),
 * build there, then mark the lot built (or dropped). The claim is renewed every minute while the build runs; a bot
 * that crashes stops renewing, and after CLAIM_MS the lot is open again.
 */
import type { Ownership } from '../brain2/ownership.js';
import { boxMeetsKids, groundTop, type Site, type SiteReject } from '../brain2/behaviours/site-search.js';
import { LIMITS } from '../brain2/data/limits.data.js';
import type { WorldView } from '../port.js';
import type { Vec3 } from '../types.js';
import { readPlan, reopenLots, updateLot, type PlanLot } from './plan-file.js';

export const RENEW_MS = 60_000;

export const fitsLot = (l: Pick<PlanLot, 'w' | 'd' | 'h'>, s: { w: number; d: number; h: number }) => s.w <= l.w && s.d <= l.d && s.h <= l.h;

/**
 * The site for a `w`×`d`×`h` build centred on the lot. The foreman already checked the lot at plan time (spawn,
 * leash, flat and natural, headroom), and its own roads and lamps now stand on the verges around it, so those rules
 * are NOT re-run here: they would fail on the foreman's own cells. Only what can change is re-checked: the builder's
 * own builds, kids standing on it, and kid cells within SITE_KID_DIST (bot cells from the shared registry are not
 * kid cells). Layer 0 is the lot's own height; the ±1 levelling cells over the footprint come back as digs/fills.
 */
export function lotSite(lot: PlanLot, s: { w: number; d: number; h: number }, ctx: {
	world: WorldView; own: Ownership; spawn: Vec3; kids: readonly Vec3[]; avoid: Array<{ min: Vec3; max: Vec3 }>;
}): Site | SiteReject {
	const x = lot.origin.x + Math.floor((lot.w - s.w) / 2), z = lot.origin.z + Math.floor((lot.d - s.d) / 2);
	const x1 = x + s.w - 1, z1 = z + s.d - 1;
	for (const b of ctx.avoid) if (x <= b.max.x && x1 >= b.min.x && z <= b.max.z && z1 >= b.min.z) return 'builds';
	if (boxMeetsKids(x - 1, x1 + 1, z - 1, z1 + 1, ctx.kids)) return 'kid-position';
	if (ctx.own.kidCellWithin(x + s.w / 2, z + s.d / 2, LIMITS.SITE_KID_DIST + Math.max(s.w, s.d) / 2)) return 'kid-cells';
	const groundY = lot.origin.y - 1;
	const digs: Vec3[] = [], fills: Vec3[] = [];
	for (let cx = x; cx <= x1; cx++) {
		for (let cz = z; cz <= z1; cz++) {
			const top = groundTop(ctx.world, cx, cz);
			if (top === groundY + 1) digs.push({ x: cx, y: top, z: cz });
			else if (top === groundY - 1) fills.push({ x: cx, y: groundY, z: cz });
		}
	}
	return { origin: { x, y: lot.origin.y, z }, groundY, digs, fills };
}

/** A kid standing on the lot is passing by: the lot goes back to open. Anything else drops it (the foreman may reopen it later). */
export const rejectStatus = (r: SiteReject): 'open' | 'dropped' => (r === 'kid-position' ? 'open' : 'dropped');

/** A dropped lot is reopened at most this many times (its dropCount stops it). */
export const MAX_DROPS = 3;
/** How often the foreman re-checks the dropped lots. */
export const REOPEN_EVERY_MS = 15 * 60_000;

/**
 * The foreman's re-check of the dropped lots: every dropped lot dropped fewer than MAX_DROPS times whose lotSite
 * (for the whole lot) passes now goes back to open. Returns the reopened ids.
 */
export function reopenDroppedLots(path: string, ctx: Parameters<typeof lotSite>[2], log: (e: Record<string, unknown>) => void, now: number): string[] {
	const p = readPlan(path);
	if (!p) return [];
	const ids: string[] = [];
	for (const l of p.lots) {
		if (l.status !== 'dropped' || (l.dropCount ?? 1) >= MAX_DROPS) continue;
		const r = lotSite(l, l, ctx);
		if (typeof r === 'string') log({ k: 'lot-still-dropped', t: now, lot: l.id, why: r, was: l.why ?? null });
		else ids.push(l.id);
	}
	const done = reopenLots(path, ids);
	for (const id of done) log({ k: 'lot-reopened', t: now, lot: id });
	return done;
}

/** Renews `bot`'s claim on `lotId` every RENEW_MS; returns the stop function. A lost claim is logged once. */
export function renewClaim(path: string, lotId: string, bot: string, clock: () => number, log: (e: Record<string, unknown>) => void): () => void {
	let lost = false;
	const t = setInterval(() => {
		try {
			if (!updateLot(path, lotId, bot, clock(), {}) && !lost) {
				lost = true;
				log({ k: 'lot-claim-lost', t: clock(), lot: lotId });
			}
		} catch (err) {
			log({ k: 'lot-error', t: clock(), lot: lotId, err: err instanceof Error ? err.message : String(err) });
		}
	}, RENEW_MS);
	return () => clearInterval(t);
}

/** Ends a lot after its build: built when done, dropped when abandoned (nothing to do while still building). */
export function endLot(path: string, lotId: string, bot: string, now: number, status: string, why: string | undefined, log: (e: Record<string, unknown>) => void): void {
	if (status === 'building') return;
	try {
		const ok = updateLot(path, lotId, bot, now, { status: status === 'done' ? 'built' : 'dropped', why });
		log({ k: 'lot-end', t: now, lot: lotId, status: status === 'done' ? 'built' : 'dropped', why, ok });
	} catch (err) {
		log({ k: 'lot-error', t: now, lot: lotId, err: err instanceof Error ? err.message : String(err) });
	}
}
