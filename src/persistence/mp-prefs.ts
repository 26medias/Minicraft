import { SKINS, type SkinId } from '../data/skins.data';
import { newWorldId } from './uuid';

export const MP_KEY = 'minicraft:v1:mp';

/**
 * What the Multiplayer screens remember (spec §8.2): the name, the skin and the
 * selected world. `bid` identifies this browser to the server, so a reconnect
 * from the same browser takes over its old connection while the same name from
 * another browser is refused (4009).
 */
export type MpPrefs = { name: string | null; skin: SkinId | null; worldId: string | null; bid: string };

function isSkin(v: unknown): v is SkinId {
	return typeof v === 'string' && SKINS.some((s) => s.id === v);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** The remembered prefs. The `bid` is created (`crypto.randomUUID`) and stored on first load. */
export function loadMpPrefs(): MpPrefs {
	let parsed: Record<string, unknown> | null = null;
	try {
		const raw = localStorage.getItem(MP_KEY);
		const v: unknown = raw ? JSON.parse(raw) : null;
		if (typeof v === 'object' && v !== null) parsed = v as Record<string, unknown>;
	} catch {
		parsed = null;
	}
	const prefs: MpPrefs = {
		name: str(parsed?.name),
		skin: isSkin(parsed?.skin) ? parsed.skin : null,
		worldId: str(parsed?.worldId),
		bid: str(parsed?.bid) ?? newWorldId(),
	};
	if (prefs.bid !== parsed?.bid) saveMpPrefs(prefs);
	return prefs;
}

/** Storage errors (quota, private mode) are swallowed: remembering is a convenience. */
export function saveMpPrefs(p: MpPrefs): void {
	try {
		localStorage.setItem(MP_KEY, JSON.stringify({ name: p.name, skin: p.skin, worldId: p.worldId, bid: p.bid }));
	} catch {
		// Nothing useful to do.
	}
}
