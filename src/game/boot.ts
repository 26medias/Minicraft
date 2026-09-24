/**
 * The page's boot decision (plan I1, gate-2 + re-gate amendments). main.ts calls
 * {@link boot} first, before anything reads the stored play session: it applies
 * the refresh rule ({@link bootSession}) and says whether this load is a
 * multiplayer reconnect (`mp:autojoin`) or an ordinary menu start.
 */
import { SKINS, type SkinId } from '../data/skins.data';
import type { StorageLike } from '../net/mp-sync';
import { clearSession, loadSession } from '../persistence/playtime';
import { loadPin, loadSchedule } from '../persistence/schedule';
import { MP_PRESELECT_KEY } from '../ui/menu';
import { bootSession } from './boot-session';

/** sessionStorage: set while the goal of the next reload is to rejoin this world (spec §7.1, §7.5). */
export const AUTOJOIN_KEY = 'mp:autojoin';

export type AutojoinArgs = { world: string; name: string; skin: SkinId; duration: number | null };

export type BootResult = { kind: 'menu' } | { kind: 'autojoin'; args: AutojoinArgs };

export type BootDeps = {
	/** `VITE_MINICRAFT_MP_URL`, or null when the site has no multiplayer server. */
	mpUrl: string | null;
	/** sessionStorage. */
	storage: StorageLike;
};

function get(s: StorageLike, k: string): string | null {
	try {
		return s.getItem(k);
	} catch {
		return null;
	}
}

function remove(s: StorageLike, k: string): void {
	try {
		s.removeItem(k);
	} catch {
		// Storage unavailable: nothing was stored either.
	}
}

function set(s: StorageLike, k: string, v: string): void {
	try {
		s.setItem(k, v);
	} catch {
		// Quota or private mode: the reload then lands on the menu, which is safe.
	}
}

/** The stored args, or null when missing or malformed. */
export function parseAutojoin(raw: string | null): AutojoinArgs | null {
	if (raw === null) return null;
	try {
		const v = JSON.parse(raw) as Partial<AutojoinArgs> | null;
		if (!v || typeof v.world !== 'string' || v.world === '' || typeof v.name !== 'string' || v.name === '') return null;
		const skin = SKINS.some((s) => s.id === v.skin) ? (v.skin as SkinId) : SKINS[0].id;
		const duration = typeof v.duration === 'number' && Number.isFinite(v.duration) ? v.duration : null;
		return { world: v.world, name: v.name, skin, duration };
	} catch {
		return null;
	}
}

export function boot(deps: BootDeps): BootResult {
	const raw = get(deps.storage, AUTOJOIN_KEY);
	let args = parseAutojoin(raw);
	// Re-gate I1: the flag never leaks. No server to rejoin, or a broken flag: clear it, and the
	// session gets no reconnect exemption.
	if (raw !== null && (args === null || !deps.mpUrl)) {
		remove(deps.storage, AUTOJOIN_KEY);
		args = null;
	}
	bootSession({ pin: loadPin(), schedule: loadSchedule(), autojoin: args !== null }, loadSession, clearSession);
	return args ? { kind: 'autojoin', args } : { kind: 'menu' };
}

export function setAutojoin(storage: StorageLike, args: AutojoinArgs): void {
	set(storage, AUTOJOIN_KEY, JSON.stringify(args));
}

export function clearAutojoin(storage: StorageLike): void {
	remove(storage, AUTOJOIN_KEY);
}

/** Starting any solo game clears the flag (re-gate I1): a later reload must not rejoin multiplayer. */
export function beginSolo(storage: StorageLike): void {
	clearAutojoin(storage);
}

/**
 * The rejoin did not get a `welcome` (gate-2 K1, re-gate I1): the args become the Multiplayer
 * screen's one-shot preselect and the flag is cleared, so the kid lands on the sleeping screen with
 * the same world selected and no reload loop.
 */
export function failRejoin(storage: StorageLike, args: AutojoinArgs): void {
	set(storage, MP_PRESELECT_KEY, JSON.stringify(args));
	clearAutojoin(storage);
}
