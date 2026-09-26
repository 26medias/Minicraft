import { DURATION_CHOICES_MIN } from '../data/playtime.data';
import { dayKey, type LoadedRules, type Rules, type Today } from '../game/rules';
import { loadOptions } from './options';

export const RULES_KEY = 'minicraft:v1:rules';
export const TODAY_KEY = 'minicraft:v1:today';
export const PIN_KEY = 'minicraft:v1:pin';
/** The old per-world schedule; read only to migrate it into rules. */
export const SCHEDULE_KEY = 'minicraft:v1:schedule';

const PIN_RE = /^\d{4}$/;

function isStartMin(v: unknown): v is number {
	return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1440;
}

function isRules(v: unknown): v is Rules {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		(o.startMin === null || isStartMin(o.startMin)) &&
		(o.dailyMin === null || (typeof o.dailyMin === 'number' && DURATION_CHOICES_MIN.includes(o.dailyMin)))
	);
}

function read(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

/** Write, then read back; a parental control must not report success it cannot prove. */
function writeVerified(key: string, value: string): boolean {
	try {
		localStorage.setItem(key, value);
		return localStorage.getItem(key) === value;
	} catch {
		return false;
	}
}

function removeVerified(key: string): boolean {
	try {
		localStorage.removeItem(key);
		return localStorage.getItem(key) === null;
	} catch {
		return false;
	}
}

function fromRules(r: Rules): LoadedRules {
	return r.startMin === null && r.dailyMin === null ? { kind: 'none' } : { kind: 'set', rules: r };
}

/**
 * Before rules existed a parent had a schedule (one world, a start time, minutes
 * per day) or a maximum per sitting. The schedule becomes the same start time
 * and minutes per day; the maximum becomes minutes per day. A broken schedule
 * stays broken (fails closed).
 */
function migrate(): LoadedRules {
	const raw = read(SCHEDULE_KEY);
	if (raw !== null) {
		try {
			const o = JSON.parse(raw) as Record<string, unknown> | null;
			if (o && isStartMin(o.startMin) && typeof o.limitMin === 'number' && DURATION_CHOICES_MIN.includes(o.limitMin)) {
				return { kind: 'set', rules: { startMin: o.startMin, dailyMin: o.limitMin } };
			}
		} catch {
			// Falls through to broken.
		}
		return { kind: 'broken' };
	}
	let max: number | null = null;
	try {
		max = loadOptions().maxDurationMin;
	} catch {
		max = null;
	}
	return fromRules({ startMin: null, dailyMin: max });
}

/** Absent → migrated from the old records. Present but invalid → broken (fails closed). */
export function loadRules(): LoadedRules {
	const raw = read(RULES_KEY);
	if (raw === null) return migrate();
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRules(parsed)) return { kind: 'broken' };
		return fromRules({ startMin: parsed.startMin, dailyMin: parsed.dailyMin });
	} catch {
		return { kind: 'broken' };
	}
}

/** Always writes the record, even "no rules", so the old records are never migrated again. */
export function saveRules(r: Rules): boolean {
	if (!isRules(r)) return false;
	return writeVerified(RULES_KEY, JSON.stringify({ startMin: r.startMin, dailyMin: r.dailyMin }));
}

/** Today's extras, or null (absent, unreadable, or dated another day: extras never carry over). */
export function loadToday(now: number): Today | null {
	const raw = read(TODAY_KEY);
	if (raw === null) return null;
	try {
		const o = JSON.parse(raw) as Record<string, unknown> | null;
		if (!o || o.day !== dayKey(now)) return null;
		if (typeof o.extraMin !== 'number' || !Number.isInteger(o.extraMin) || o.extraMin < 0 || o.extraMin > 24 * 60) return null;
		if (typeof o.unlimited !== 'boolean') return null;
		return { day: o.day, extraMin: o.extraMin, unlimited: o.unlimited };
	} catch {
		return null;
	}
}

export function saveToday(t: Today): boolean {
	return writeVerified(TODAY_KEY, JSON.stringify(t));
}

export function clearToday(): boolean {
	return removeVerified(TODAY_KEY);
}

export function loadPin(): string | null {
	const raw = read(PIN_KEY);
	return raw !== null && PIN_RE.test(raw) ? raw : null;
}

export function savePin(pin: string): boolean {
	if (!PIN_RE.test(pin)) return false;
	return writeVerified(PIN_KEY, pin);
}

export function clearPin(): boolean {
	return removeVerified(PIN_KEY);
}
