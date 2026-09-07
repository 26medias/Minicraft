import { phaseOf, type PlaytimeSession } from '../game/playtime';
import {
	doneForToday, formatStartTime, gateOpen, resolveWorld, sessionInForce,
	type LoadedSchedule, type Schedule,
} from '../game/schedule';
import type { WorldSummary } from '../persistence/adapter';

export type MenuInput = {
	schedule: LoadedSchedule;
	session: PlaytimeSession | null;
	/** null while the world list is still loading. */
	worlds: WorldSummary[] | null;
	offline: boolean;
	now: number;
};

export type CardModel = {
	mode: 'card';
	title: string;
	line: string;
	playEnabled: boolean;
	world: { id: string; seed: number } | null;
};

export type MenuModel = { mode: 'full' } | CardModel;

function card(title: string, line: string, playEnabled: boolean, world: CardModel['world']): CardModel {
	return { mode: 'card', title, line, playEnabled, world };
}

/** What the menu shows. Rows are checked in the spec's order; the first match wins. */
export function menuModel(i: MenuInput): MenuModel {
	if (i.schedule.kind === 'none') return { mode: 'full' };
	if (i.schedule.kind === 'broken') return card('Locked', "Something's wrong · ask a grown-up", false, null);
	const s = i.schedule.schedule;
	if (i.worlds === null) return card(s.name, 'Loading…', false, null);
	const found = resolveWorld(s, i.worlds);
	if (!found) {
		return card(s.name, i.offline ? "Can't reach cloud saves · try again later" : 'World not found · ask a grown-up', false, null);
	}
	const world = { id: found.id, seed: found.seed };
	const time = formatStartTime(s.startMin, i.now);
	if (!gateOpen(s.startMin, i.now)) return card(s.name, `Play at ${time}`, false, world);
	const live = i.session && sessionInForce(i.session, s, i.now) ? i.session : null;
	if (live && phaseOf(live, i.now) === 'playing') {
		const left = Math.max(1, Math.ceil((live.limitMs - live.playedMs) / 60_000));
		return card(s.name, `${left} minute${left === 1 ? '' : 's'} left`, true, world);
	}
	if (live) return card(s.name, `All done for today · play again at ${time} tomorrow`, false, world);
	return card(s.name, `${s.limitMin} minutes today`, true, world);
}

export type Staged = { worldId: string; limitMin: number | null; breakMin: number | null; startRaw: string };

export type SavePlan =
	| { kind: 'schedule'; schedule: Schedule; session: PlaytimeSession | null }
	| { kind: 'none'; limitMin: number | null; breakMin: number | null }
	| { kind: 'error'; message: string };

/**
 * The Save decision. In schedule mode, when today's start time has already
 * passed, Save also produces a done-for-today session so a bedtime save locks
 * tonight; the parent has Unlock for "play today".
 */
export function planSave(staged: Staged, worlds: WorldSummary[], now: number): SavePlan {
	if (staged.worldId === '') return { kind: 'none', limitMin: staged.limitMin, breakMin: staged.breakMin };
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
