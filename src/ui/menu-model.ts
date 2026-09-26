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
