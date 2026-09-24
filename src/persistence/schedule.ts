import { DURATION_CHOICES_MIN } from '../data/playtime.data';
import type { LoadedSchedule, Schedule } from '../game/schedule';

export const SCHEDULE_KEY = 'minicraft:v1:schedule';
export const PIN_KEY = 'minicraft:v1:pin';

const PIN_RE = /^\d{4}$/;

function isSchedule(v: unknown): v is Schedule {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.worldId === 'string' && o.worldId.length > 0 &&
		typeof o.seed === 'number' && Number.isFinite(o.seed) &&
		typeof o.name === 'string' &&
		typeof o.limitMin === 'number' && DURATION_CHOICES_MIN.includes(o.limitMin) &&
		typeof o.startMin === 'number' && Number.isInteger(o.startMin) && o.startMin >= 0 && o.startMin < 1440
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

/** Absent → none. Present but invalid → broken (fails closed). */
export function loadSchedule(): LoadedSchedule {
	const raw = read(SCHEDULE_KEY);
	if (raw === null) return { kind: 'none' };
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isSchedule(parsed)) return { kind: 'broken' };
		const { worldId, seed, name, limitMin, startMin } = parsed;
		return { kind: 'armed', schedule: { worldId, seed, name, limitMin, startMin } };
	} catch {
		return { kind: 'broken' };
	}
}

export function saveSchedule(s: Schedule): boolean {
	if (!isSchedule(s)) return false;
	return writeVerified(SCHEDULE_KEY, JSON.stringify(s));
}

export function clearSchedule(): boolean {
	return removeVerified(SCHEDULE_KEY);
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
