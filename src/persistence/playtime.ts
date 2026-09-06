import type { PlaytimeSession } from '../game/playtime';
import type { Options } from '../data/keybindings.data';
import { loadOptions, saveOptions } from './options';

export const PLAYTIME_KEY = 'minicraft:v1:playtime';

function isFiniteNumber(v: unknown): v is number {
	return typeof v === 'number' && Number.isFinite(v);
}

function isSession(v: unknown): v is PlaytimeSession {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		isFiniteNumber(o.limitMs) &&
		o.limitMs > 0 &&
		(o.breakMs === null || (isFiniteNumber(o.breakMs) && o.breakMs > 0)) &&
		isFiniteNumber(o.playedMs) &&
		o.playedMs >= 0 &&
		(o.frozenAt === null || isFiniteNumber(o.frozenAt)) &&
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
		const { limitMs, breakMs, playedMs, frozenAt, updatedAt } = parsed;
		return { limitMs, breakMs, playedMs, frozenAt, updatedAt };
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
 * Menu helper: patch the play-time options, persist them, and drop any stored
 * session. Both dropdowns and both buttons on the menu go through here or
 * through clearSession(), so "the parent changed something" always unlocks.
 */
export function applyPlaytimeSetting(
	patch: Partial<Pick<Options, 'playLimitMin' | 'playBreakMin'>>,
): Options {
	const opts = loadOptions();
	if ('playLimitMin' in patch) opts.playLimitMin = patch.playLimitMin ?? null;
	if ('playBreakMin' in patch) opts.playBreakMin = patch.playBreakMin ?? null;
	saveOptions(opts);
	clearSession();
	return opts;
}
