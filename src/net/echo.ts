/**
 * The echo rule (spec §6). `pending` maps a cell key ("x,y,z") to the cid of this client's latest
 * own write to that cell.
 * - A newer own write is pending (its cid is greater) → skip this echo: that write's echo follows,
 *   and is sequenced after it, so the highest-seq invariant holds and the place-then-mine flicker
 *   is gone (G1).
 * - Otherwise apply it. At the pending write's own cid, forget the cell.
 */
export function shouldApplyEcho(pending: Map<string, number>, key: string, cid: number): boolean {
	const p = pending.get(key);
	if (p !== undefined && p > cid) return false;
	if (p === cid) pending.delete(key);
	return true;
}
