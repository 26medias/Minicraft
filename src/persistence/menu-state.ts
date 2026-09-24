import { DURATION_CHOICES_MIN } from '../data/playtime.data';
import { clampDuration, defaultDuration } from '../game/session-policy';

export const MENU_KEY = 'minicraft:v1:menu';

/** What the Single Player screen remembers (spec §8.1): the selected world and the duration. */
export type MenuState = { selectedId: string | null; duration: number | null };

/**
 * The remembered menu state, fitted to the parent's maximum `max` (null = No
 * limit). A stored duration (a list member, or null for No limit) is clamped
 * to the maximum; with none stored, the default is No limit under No limit
 * and 30 min (clamped) otherwise (spec §8).
 */
export function loadMenuState(max: number | null): MenuState {
	let parsed: Record<string, unknown> | null = null;
	try {
		const raw = localStorage.getItem(MENU_KEY);
		const v: unknown = raw ? JSON.parse(raw) : null;
		if (typeof v === 'object' && v !== null) parsed = v as Record<string, unknown>;
	} catch {
		parsed = null;
	}
	const selectedId = typeof parsed?.selectedId === 'string' && parsed.selectedId !== '' ? parsed.selectedId : null;
	const d = parsed?.duration;
	const stored = d === null || (typeof d === 'number' && DURATION_CHOICES_MIN.includes(d));
	const duration = stored ? clampDuration(d as number | null, max) : defaultDuration(max);
	return { selectedId, duration };
}

/** Storage errors (quota, private mode) are swallowed: remembering is a convenience. */
export function saveMenuState(s: MenuState): void {
	try {
		localStorage.setItem(MENU_KEY, JSON.stringify({ selectedId: s.selectedId, duration: s.duration }));
	} catch {
		// Nothing useful to do.
	}
}
