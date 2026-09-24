import { phaseOf, type PlaytimeSession } from '../game/playtime';
import {
	doneForToday, formatStartTime, gateOpen, resolveWorld, sessionInForce,
	type LoadedSchedule, type Schedule,
} from '../game/schedule';
import type { WorldSummary } from '../persistence/adapter';
import type { MenuState } from '../persistence/menu-state';
import { clampDuration } from '../game/session-policy';
import type { SkinId } from '../data/skins.data';

/**
 * What the menu asks main.ts to do. `duration` is the kid's chosen play time
 * in minutes (null = No limit); main.ts applies it (an in-force session wins).
 */
export type MenuAction =
	| { type: 'new'; id: string; seed: number; name: string; mustMine: boolean; duration: number | null }
	| { type: 'continue'; id: string; seed: number; name: string; duration: number | null }
	| { type: 'mp'; world: string; name: string; skin: SkinId; duration: number | null }
	| { type: 'options' };

export type MenuInput = {
	schedule: LoadedSchedule;
	session: PlaytimeSession | null;
	/** null while the world list is still loading. */
	worlds: WorldSummary[] | null;
	offline: boolean;
	now: number;
	/** One-shot text under the title (e.g. why Continue refused); null when there is nothing to say. */
	notice: string | null;
};

export type CardModel = {
	mode: 'card';
	title: string;
	line: string;
	playEnabled: boolean;
	world: { id: string; seed: number; name: string } | null;
	notice: string | null;
};

export type MenuModel = { mode: 'full'; notice: string | null } | CardModel;

function card(notice: string | null, title: string, line: string, playEnabled: boolean, world: CardModel['world']): CardModel {
	return { mode: 'card', title, line, playEnabled, world, notice };
}

/** What the menu shows. Rows are checked in the spec's order; the first match wins. */
export function menuModel(i: MenuInput): MenuModel {
	if (i.schedule.kind === 'none') return { mode: 'full', notice: i.notice };
	if (i.schedule.kind === 'broken') return card(i.notice, 'Locked', "Something's wrong · ask a parent", false, null);
	const s = i.schedule.schedule;
	if (i.worlds === null) return card(i.notice, s.name, 'Loading…', false, null);
	const found = resolveWorld(s, i.worlds);
	if (!found) {
		return card(i.notice, s.name, i.offline ? "Can't reach cloud saves · try again later" : 'World not found · ask a parent', false, null);
	}
	const world = { id: found.id, seed: found.seed, name: found.name };
	const time = formatStartTime(s.startMin, i.now);
	if (!gateOpen(s.startMin, i.now)) return card(i.notice, s.name, `Play at ${time}`, false, world);
	const live = i.session && sessionInForce(i.session, s, i.now) ? i.session : null;
	if (live && phaseOf(live, i.now) === 'playing') {
		const left = Math.max(1, Math.ceil((live.limitMs - live.playedMs) / 60_000));
		return card(i.notice, s.name, `${left} minute${left === 1 ? '' : 's'} left`, true, world);
	}
	if (live) return card(i.notice, s.name, `All done for today · play again at ${time} tomorrow`, false, world);
	return card(i.notice, s.name, `${s.limitMin} minutes today`, true, world);
}

/** `limitMin`: the schedule's duration, or with no schedule the parent's maximum (null = No limit). */
export type Staged = { worldId: string; limitMin: number | null; startRaw: string };

export type SavePlan =
	| { kind: 'schedule'; schedule: Schedule; session: PlaytimeSession | null }
	| { kind: 'none'; limitMin: number | null }
	| { kind: 'error'; message: string };

/**
 * The Save decision. In schedule mode, when today's start time has already
 * passed, Save also produces a done-for-today session so a bedtime save locks
 * tonight; the parent has Unlock for "play today".
 */
export function planSave(staged: Staged, worlds: WorldSummary[], now: number): SavePlan {
	if (staged.worldId === '') return { kind: 'none', limitMin: staged.limitMin };
	const w = worlds.find((x) => x.id === staged.worldId);
	if (!w) return { kind: 'error', message: 'Pick a world' };
	if (staged.limitMin === null) return { kind: 'error', message: 'Pick a play time' };
	const m = /^(\d{2}):(\d{2})$/.exec(staged.startRaw);
	if (!m) return { kind: 'error', message: 'Pick a start time' };
	const startMin = Number(m[1]) * 60 + Number(m[2]);
	const schedule: Schedule = { worldId: w.id, seed: w.seed, name: w.name, limitMin: staged.limitMin, startMin };
	const session = gateOpen(startMin, now) ? doneForToday(staged.limitMin, now) : null;
	return { kind: 'schedule', schedule, session };
}

/** The New World form, read. `mustMine` is the "Must mine blocks to build" checkbox (spec §3), unchecked by default. */
export function newWorldFields(form: { nameRaw: string; seedRaw: string; mustMine: boolean }): { name: string; seed: number; mustMine: boolean } {
	return {
		name: form.nameRaw.trim() || 'My World',
		seed: Number(form.seedRaw) || 0,
		mustMine: form.mustMine === true,
	};
}

/** A world made by Create on the Single Player screen: listed and selectable, but not saved until Play. */
export type CreatedWorld = { id: string; seed: number; name: string; mustMine: boolean };

export type SingleRow = {
	id: string;
	seed: number;
	name: string;
	/** Where it lives: the cloud, this device, or not yet anywhere (just created). */
	badge: 'cloud' | 'device' | 'new';
	degraded: boolean;
};

export type SingleInput = {
	worlds: WorldSummary[];
	created: CreatedWorld | null;
	state: MenuState;
	/** The parent's maximum, null = No limit. */
	max: number | null;
};

export type SingleModel = { worlds: SingleRow[]; selectedId: string | null; duration: number | null; max: number | null };

/**
 * The Single Player screen (spec §8.1): cloud and device worlds merged into
 * one list, most recently played first, with a just-created world on top and
 * selected. Otherwise the remembered world is selected if it is still listed,
 * else the first row.
 */
export function singleModel(i: SingleInput): SingleModel {
	const saved = [...i.worlds]
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.map((w): SingleRow => ({
			id: w.id, seed: w.seed, name: w.name,
			badge: w.origin === 'cloud' ? 'cloud' : 'device',
			degraded: w.degraded === true,
		}));
	const rows = i.created
		? [{ id: i.created.id, seed: i.created.seed, name: i.created.name, badge: 'new' as const, degraded: false }, ...saved.filter((r) => r.id !== i.created!.id)]
		: saved;
	let selectedId: string | null = null;
	if (i.created) selectedId = i.created.id;
	else if (i.state.selectedId !== null && rows.some((r) => r.id === i.state.selectedId)) selectedId = i.state.selectedId;
	else selectedId = rows[0]?.id ?? null;
	return { worlds: rows, selectedId, duration: clampDuration(i.state.duration, i.max), max: i.max };
}
