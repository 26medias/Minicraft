/**
 * `--join-plan` for the builder and the architect (experiment E7): claim the foreman's next open lot that fits,
 * re-check the chosen footprint against brain2's site rules at the lot (the world may have changed since the plan),
 * build there, then mark the lot built (or dropped). The claim is renewed every minute while the build runs; a bot
 * that crashes stops renewing, and after CLAIM_MS the lot is open again.
 */
import type { Ownership } from '../brain2/ownership.js';
import { siteOrReject, type Site, type SiteReject } from '../brain2/behaviours/site-search.js';
import type { WorldView } from '../port.js';
import type { Vec3 } from '../types.js';
import { updateLot, type PlanLot } from './plan-file.js';

export const RENEW_MS = 60_000;

export const fitsLot = (l: Pick<PlanLot, 'w' | 'd' | 'h'>, s: { w: number; d: number; h: number }) => s.w <= l.w && s.d <= l.d && s.h <= l.h;

/** The site for a `w`×`d`×`h` build centred on the lot, under the site rules now; a reject reason otherwise. */
export function lotSite(lot: PlanLot, s: { w: number; d: number; h: number }, ctx: {
	world: WorldView; own: Ownership; spawn: Vec3; kids: readonly Vec3[]; avoid: Array<{ min: Vec3; max: Vec3 }>;
}): Site | SiteReject {
	const x = lot.origin.x + Math.floor((lot.w - s.w) / 2), z = lot.origin.z + Math.floor((lot.d - s.d) / 2);
	return siteOrReject(x, z, { w: s.w, d: s.d, h: s.h, anchor: { x, y: lot.origin.y, z }, avoid: ctx.avoid }, { world: ctx.world, own: ctx.own, spawn: ctx.spawn, kids: ctx.kids });
}

/** A kid standing on the lot is passing by: the lot goes back to open. Anything else drops it for good. */
export const rejectStatus = (r: SiteReject): 'open' | 'dropped' => (r === 'kid-position' ? 'open' : 'dropped');

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
