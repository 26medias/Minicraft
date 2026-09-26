import { DURATION_CHOICES_MIN } from '../data/playtime.data';
import { nextStartAt, type LoadedPlan, type Plan } from '../game/plan';
import { newWorldId } from './uuid';

export const PLAN_KEY = 'minicraft:v1:plan';
export const PIN_KEY = 'minicraft:v1:pin';
/** The old daily per-world schedule (deployed before plans); migrated once into a plan. */
export const SCHEDULE_KEY = 'minicraft:v1:schedule';

const PIN_RE = /^\d{4}$/;

function isTime(v: unknown): v is number {
	return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function isPlan(v: unknown): v is Plan {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.id === 'string' && o.id !== '' &&
		(o.mode === 'solo' || o.mode === 'mp') &&
		(o.worldId === null || (typeof o.worldId === 'string' && o.worldId !== '')) &&
		(o.worldName === null || typeof o.worldName === 'string') &&
		isTime(o.startAt) && isTime(o.createdAt) &&
		typeof o.limitMin === 'number' && DURATION_CHOICES_MIN.includes(o.limitMin) &&
		typeof o.extraMin === 'number' && Number.isInteger(o.extraMin) && o.extraMin >= 0 && o.extraMin <= 24 * 60
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

/**
 * The old daily schedule becomes a solo plan on its world, at the next
 * occurrence of its start time, for its minutes. The old record is removed
 * only once the plan is written; an unreadable one is broken (fails closed).
 */
function migrate(raw: string, now: number): LoadedPlan {
	let o: Record<string, unknown> | null = null;
	try {
		o = JSON.parse(raw) as Record<string, unknown> | null;
	} catch {
		o = null;
	}
	const startMin = o?.startMin;
	const limitMin = o?.limitMin;
	if (
		!o || typeof o.worldId !== 'string' || o.worldId === '' ||
		typeof startMin !== 'number' || !Number.isInteger(startMin) || startMin < 0 || startMin >= 1440 ||
		typeof limitMin !== 'number' || !DURATION_CHOICES_MIN.includes(limitMin)
	) {
		return { kind: 'broken' };
	}
	const pad = (n: number) => String(n).padStart(2, '0');
	const plan: Plan = {
		id: newPlanId(),
		mode: 'solo',
		worldId: o.worldId,
		worldName: typeof o.name === 'string' ? o.name : null,
		startAt: nextStartAt(`${pad(Math.floor(startMin / 60))}:${pad(startMin % 60)}`, now)!,
		limitMin,
		extraMin: 0,
		createdAt: now,
	};
	if (savePlan(plan)) removeVerified(SCHEDULE_KEY);
	return { kind: 'set', plan };
}

/** Absent → none (or the old schedule, migrated). Present but invalid → broken (fails closed). */
export function loadPlan(now: number = Date.now()): LoadedPlan {
	const raw = read(PLAN_KEY);
	if (raw === null) {
		const old = read(SCHEDULE_KEY);
		return old === null ? { kind: 'none' } : migrate(old, now);
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isPlan(parsed)) return { kind: 'broken' };
		const { id, mode, worldId, worldName, startAt, limitMin, extraMin, createdAt } = parsed;
		return { kind: 'set', plan: { id, mode, worldId, worldName, startAt, limitMin, extraMin, createdAt } };
	} catch {
		return { kind: 'broken' };
	}
}

/** A fresh plan id (a new plan never inherits another plan's played time). */
export function newPlanId(): string {
	return newWorldId();
}

export function savePlan(p: Plan): boolean {
	if (!isPlan(p)) return false;
	return writeVerified(PLAN_KEY, JSON.stringify(p));
}

/** End the schedule: back to free play. Also drops the old record so it cannot come back. */
export function clearPlan(): boolean {
	return removeVerified(PLAN_KEY) && removeVerified(SCHEDULE_KEY);
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
