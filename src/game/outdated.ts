/**
 * Outdated-client handling (spec §5, gate-2 §12a): a stale bundle gets one guarded automatic
 * reload; a second one within the window falls back to the click screen, so a storage failure or a
 * server stuck below the minimum can never loop.
 */
import type { StorageLike } from '../net/mp-sync';

/** sessionStorage key: when the last automatic reload was written. */
export const AUTO_RELOAD_KEY = 'minicraft:v1:autoReloadAt';
/** The loop guard: a marker inside this window blocks a second automatic reload. */
export const AUTO_RELOAD_WINDOW_MS = 300_000;
/** How long the "Updating Minicraft…" screen stays up before the reload. */
export const UPDATING_SCREEN_MS = 2_000;

/**
 * Spec §5 decision table. Pure: no storage, no clock, no URL. `canWrite` is the caller's own
 * verdict on whether the marker can be persisted at all — when it can't, `auto` would loop forever,
 * so the table forces `click` regardless of the marker.
 */
export function outdatedAction(nowMs: number, markerRaw: string | null, canWrite: boolean): 'auto' | 'click' {
	if (!canWrite) return 'click';
	if (markerRaw === null) return 'auto';
	const at = Number(markerRaw);
	if (!Number.isFinite(at)) return 'auto';
	if (at > nowMs) return 'click';
	return nowMs - at >= AUTO_RELOAD_WINDOW_MS ? 'auto' : 'click';
}

/**
 * The browser-side wrapper: reads the marker (a throwing read → `click`), applies a storage-free
 * backstop (a `v=` already in the URL, younger than the window, forces `click` — this covers
 * storage that reads back in-process but doesn't survive the navigation itself), decides via
 * {@link outdatedAction}, and on `auto` writes the marker and reads it back: a throwing write or a
 * value that doesn't match also falls back to `click`.
 */
export function decideOutdated(storage: StorageLike, now: number): 'auto' | 'click' {
	let raw: string | null;
	try {
		raw = storage.getItem(AUTO_RELOAD_KEY);
	} catch {
		return 'click';
	}
	try {
		const v = new URLSearchParams(location.search).get('v');
		if (v !== null) {
			const at = Number(v);
			if (Number.isFinite(at) && now - at < AUTO_RELOAD_WINDOW_MS) return 'click';
		}
	} catch {
		// No URL to check (e.g. no `location` global): nothing to back-stop against.
	}
	const action = outdatedAction(now, raw, true);
	if (action !== 'auto') return action;
	const marker = String(now);
	try {
		storage.setItem(AUTO_RELOAD_KEY, marker);
		if (storage.getItem(AUTO_RELOAD_KEY) !== marker) return 'click';
	} catch {
		return 'click';
	}
	return 'auto';
}

/** Adds or replaces the URL's `v` query param with `now`, keeping every other param untouched. */
export function withVersionMarker(href: string, now: number): string {
	const u = new URL(href);
	u.searchParams.set('v', String(now));
	return u.toString();
}
