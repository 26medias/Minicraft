/** Multiplayer avatar colours (spec §7.3). Order is the picker's display order. */
export const SKINS = [
	{ id: 'red', color: '#E53935' },
	{ id: 'blue', color: '#1E88E5' },
	{ id: 'green', color: '#43A047' },
	{ id: 'yellow', color: '#FDD835' },
	{ id: 'purple', color: '#8E24AA' },
	{ id: 'orange', color: '#FB8C00' },
	{ id: 'pink', color: '#EC407A' },
	{ id: 'black', color: '#212121' },
] as const;

export type SkinId = (typeof SKINS)[number]['id'];

export function skinColor(id: string): string {
	return SKINS.find((s) => s.id === id)?.color ?? SKINS[0].color;
}
