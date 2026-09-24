import type { MpWorldRow } from '../net/mp-api';

/** The name rule, as on the server (`server/internal/proto/validate.go`, spec §5). */
const NAME_RULE = /^[\p{L}\p{N} ]{1,16}$/u;

export const NAME_ERROR = 'Only letters, numbers and spaces';

/**
 * The name as the server will see it (trimmed, NFC), or null when it fails the
 * rule. The server is the authority; this is for UX only.
 */
export function validName(raw: string): string | null {
	const n = raw.trim().normalize('NFC');
	return NAME_RULE.test(n) ? n : null;
}

/** The line under the name field, or null when the name is fine. */
export function nameError(raw: string): string | null {
	if (raw.trim() === '') return 'Type your name';
	return validName(raw) === null ? NAME_ERROR : null;
}

/** Shown on screen 1 after a 4009 reload. */
export function nameTakenText(name: string): string {
	return `Someone called ${name} is already playing. Pick another name.`;
}

/** Busiest first, then newest (the server's own order, re-applied so a stale refresh cannot reorder). */
export function sortRows(rows: MpWorldRow[]): MpWorldRow[] {
	return [...rows].sort((a, b) => b.online.length - a.online.length || b.createdAt - a.createdAt);
}

/**
 * Which world starts selected (spec §8.2): the remembered world if it has
 * players; otherwise the busiest world if any has players; otherwise the
 * remembered world if it still exists; otherwise the first row.
 */
export function preselect(rows: MpWorldRow[], rememberedId: string | null): string | null {
	const remembered = rows.find((r) => r.uuid === rememberedId) ?? null;
	if (remembered && remembered.online.length > 0) return remembered.uuid;
	let busiest: MpWorldRow | null = null;
	for (const r of rows) if (r.online.length > 0 && (!busiest || r.online.length > busiest.online.length)) busiest = r;
	if (busiest) return busiest.uuid;
	if (remembered) return remembered.uuid;
	return rows[0]?.uuid ?? null;
}
