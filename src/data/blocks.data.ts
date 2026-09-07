import { BASE_BLOCKS, type BlockDef, type BlockId, type Face } from './blocks.base.data';
import { CATALOG_BLOCKS } from './blocks.catalog.data';

export * from './blocks.base.data';

/** A retired id keeps its slot so every later BLOCKS[id] lookup stays aligned. */
function tombstone(id: BlockId): BlockDef {
	return {
		id, name: `retired_${id}`, label: `Retired ${id}`, solid: false, transparent: true,
		translucent: false, hardness: 0, lightLevel: 0, lightFilter: 0, liquid: 'none',
		textures: null, group: 'other', retired: true,
	};
}

function dense(rows: BlockDef[]): BlockDef[] {
	const max = rows.reduce((m, r) => Math.max(m, r.id), 0);
	const out: BlockDef[] = [];
	for (let i = 0; i <= max; i++) out.push(tombstone(i));
	for (const r of rows) {
		if (!out[r.id].retired) throw new Error(`Duplicate block id ${r.id} (${out[r.id].name}, ${r.name})`);
		out[r.id] = r;
	}
	return out;
}

export const BLOCKS: BlockDef[] = dense([...BASE_BLOCKS, ...CATALOG_BLOCKS]);

export const BLOCK_BY_NAME: Record<string, BlockDef> = Object.fromEntries(
	BLOCKS.filter((b) => !b.retired).map((b) => [b.name, b]),
);

export function isTranslucent(id: BlockId): boolean {
	return BLOCKS[id]?.translucent ?? false;
}

export function isSolid(id: BlockId): boolean {
	return BLOCKS[id]?.solid ?? false;
}

export function isTransparent(id: BlockId): boolean {
	// Unknown ids default to transparent so the mesher emits the face toward them
	// (making corruption visible instead of hiding it). Kept inverted from isSolid's default on purpose.
	return BLOCKS[id]?.transparent ?? true;
}

export function faceTexture(id: BlockId, face: Face): string | null {
	const def = BLOCKS[id];
	if (!def || !def.textures) return null;
	const t = def.textures;
	switch (t.kind) {
		case 'uniform':
			return t.all;
		case 'top-bottom-side':
			if (face === 'py') return t.top;
			if (face === 'ny') return t.bottom;
			return t.side;
		case 'columnar':
			if (face === 'py') return t.top;
			if (face === 'ny') return t.bottom;
			return t.sides;
		case 'six':
			return t[face];
	}
}

export function isLiquid(id: BlockId): boolean {
	return BLOCKS[id]?.liquid !== 'none' && BLOCKS[id] !== undefined;
}

// WATER and LAVA are declared here (resolved once their rows are added in Task 2) so
// that external callers can import stable symbol names.
export const WATER: BlockId = 17;
export const LAVA: BlockId = 18;
export const OBSIDIAN: BlockId = 19;

// Sponge ids come from the generated catalog; resolve by name so renumbering the
// hand-written base never touches them.
export const SPONGE: BlockId = BLOCK_BY_NAME['sponge'].id;
export const WET_SPONGE: BlockId = BLOCK_BY_NAME['wet_sponge'].id;
