import type { PlaytimeSession } from '../game/playtime';
import type { Options } from '../data/keybindings.data';
import { loadOptions, saveOptions } from './options';

export const PLAYTIME_KEY = 'minicraft:v1:playtime';

function isFiniteNumber(v: unknown): v is number {
	return typeof v === 'number' && Number.isFinite(v);
}

/** Any `breakMs` is accepted (break time was removed); loadSession coerces it to null. */
function isSession(v: unknown): v is PlaytimeSession {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		isFiniteNumber(o.limitMs) &&
		o.limitMs > 0 &&
		isFiniteNumber(o.playedMs) &&
		o.playedMs >= 0 &&
		(o.frozenAt === null || isFiniteNumber(o.frozenAt)) &&
		(o.startedAt === undefined || isFiniteNumber(o.startedAt)) &&
		isFiniteNumber(o.updatedAt)
	);
}

/** null for a missing key, unparseable JSON, or a wrong-shaped record. */
export function loadSession(): PlaytimeSession | null {
	let raw: string | null;
	try {
		raw = localStorage.getItem(PLAYTIME_KEY);
	} catch {
		return null;
	}
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isSession(parsed)) return null;
		const { limitMs, playedMs, frozenAt, updatedAt, startedAt } =
			parsed as PlaytimeSession & { startedAt?: number };
		return {
			limitMs,
			// An old record's numeric break is dropped: a freeze now lasts until a
			// new session per the refresh rule (spec §8.1), or a Parents reset.
			breakMs: null,
			playedMs,
			frozenAt,
			updatedAt,
			startedAt: isFiniteNumber(startedAt) ? startedAt : updatedAt,
		};
	} catch {
		return null;
	}
}

/** Storage errors (quota, private mode) are swallowed: the in-memory timer still enforces the limit. */
export function saveSession(s: PlaytimeSession): void {
	try {
		localStorage.setItem(PLAYTIME_KEY, JSON.stringify(s));
	} catch {
		// Nothing useful to do; the timer keeps running in memory.
	}
}

export function clearSession(): void {
	try {
		localStorage.removeItem(PLAYTIME_KEY);
	} catch {
		// Same as above.
	}
}

/**
 * Parents screen: save the maximum play duration (null = No limit) and drop
 * any stored session, so "the parent changed something" always unlocks.
 */
export function applyMaxDuration(max: number | null): Options {
	const opts = loadOptions();
	opts.maxDurationMin = max;
	saveOptions(opts);
	clearSession();
	return opts;
}
