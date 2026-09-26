/**
 * The build cap: builder, architect and helper bots stop building after `--max-builds` builds (default 12), the
 * decorator after `--max-decorations` (default 40); the village bot builds one village and stops by design. The
 * count comes from the bot's persisted records, so it holds across restarts. A capped bot stays online and only
 * wanders and looks around near its builds: no more edits.
 */
export const DEFAULT_MAX_BUILDS = 12;
export const DEFAULT_MAX_DECORATIONS = 40;

/** A record counts once it put a block in the world (or finished): an attempt that placed nothing litters nothing. */
export function countsTowardCap(r: { status: string; placed: readonly string[] }): boolean {
	return r.status === 'done' || r.placed.length > 0;
}

export function capCount(records: ReadonlyArray<{ status: string; placed: readonly string[] }>): number {
	return records.filter(countsTowardCap).length;
}

export function capReached(records: ReadonlyArray<{ status: string; placed: readonly string[] }>, max: number): boolean {
	return capCount(records) >= max;
}
