/**
 * The build cap: builder, architect and helper bots stop building after `--max-builds` builds (default 12), the
 * decorator after `--max-decorations` (default 40); the village bot builds one village and stops by design. The
 * count comes from the bot's persisted records, so it holds across restarts. A capped bot stays online and only
 * wanders and looks around near its builds: no more edits, except that a --join-plan bot still claims the plan's open
 * lots (lot builds never count: the plan bounds them).
 */
export const DEFAULT_MAX_BUILDS = 12;
export const DEFAULT_MAX_DECORATIONS = 40;

type CapRecord = { status: string; placed: readonly string[]; lot?: string };

/**
 * A record counts once it put a block in the world (or finished): an attempt that placed nothing litters nothing.
 * A build on a claimed plan lot never counts: the foreman's plan bounds those.
 */
export function countsTowardCap(r: CapRecord): boolean {
	return !r.lot && (r.status === 'done' || r.placed.length > 0);
}

export function capCount(records: ReadonlyArray<CapRecord>): number {
	return records.filter(countsTowardCap).length;
}

export function capReached(records: ReadonlyArray<CapRecord>, max: number): boolean {
	return capCount(records) >= max;
}
