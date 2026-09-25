/**
 * Multiplayer characters (spec docs/superpowers/specs/2026-09-24-player-skins-design.md §3).
 * Order is the picker's display order; the first row is the default for unknown ids.
 * `color` is hand-picked (minimap dot, name-label border, toasts), never computed from the skin.
 * `slim` = 3-px arms (Alex model).
 */
export const SKINS = [
	{ id: 'milo', name: 'Milo', file: 'milo.png', slim: true, color: '#29C5E6' },
	{ id: 'chip', name: 'Chip', file: 'chip.png', slim: true, color: '#FF8A1F' },
	{ id: 'crazy-fan-girl', name: 'Crazy Fan Girl', file: 'crazy-fan-girl.png', slim: false, color: '#FF3FA4' },
	{ id: 'jj', name: 'JJ', file: 'jj.png', slim: false, color: '#D8261C' },
	{ id: 'mikey', name: 'Mikey', file: 'mikey.png', slim: false, color: '#7ED321' },
	{ id: 'enderman', name: 'Enderman', file: 'enderman.png', slim: false, color: '#CC00FA' },
] as const;

export type SkinRow = (typeof SKINS)[number];
export type SkinId = SkinRow['id'];

/** The row for `id`; anything unknown (old colour ids, "") is the first row. */
export function skinOf(id: string): SkinRow {
	return SKINS.find((s) => s.id === id) ?? SKINS[0];
}

export function skinColor(id: string): string {
	return skinOf(id).color;
}
