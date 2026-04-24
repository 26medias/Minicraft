export type BlockId = number;

export type Face = 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz';

export type BlockFaceTextures =
	| { kind: 'uniform'; all: string }
	| { kind: 'top-bottom-side'; top: string; bottom: string; side: string }
	| { kind: 'columnar'; top: string; bottom: string; sides: string }
	| { kind: 'six'; px: string; nx: string; py: string; ny: string; pz: string; nz: string };

export type BlockDef = {
	id: BlockId;
	name: string;
	label: string;
	solid: boolean;
	transparent: boolean;
	kidMode: boolean;
	// Seconds of continuous mining required to break. 0 for non-mineable (air).
	hardness: number;
	lightLevel: number;  // 0-15, emission
	lightFilter: number;  // 0-15, attenuation for light passing through
	liquid: 'none' | 'water' | 'lava';
	textures: BlockFaceTextures | null;
};

export const AIR: BlockId = 0;

export const BLOCKS: BlockDef[] = [
	{ id: 0, name: 'air', label: 'Air', solid: false, transparent: true, kidMode: true, hardness: 0,
		lightLevel: 0, lightFilter: 0, liquid: 'none',
		textures: null },
	{ id: 1, name: 'grass_block', label: 'Grass', solid: true, transparent: false, kidMode: true, hardness: 0.3,
		lightLevel: 0, lightFilter: 15, liquid: 'none',
		textures: { kind: 'top-bottom-side', top: 'grass_block_top', bottom: 'dirt', side: 'grass_block_side' } },
	{ id: 2, name: 'dirt', label: 'Dirt', solid: true, transparent: false, kidMode: true, hardness: 0.3,
		lightLevel: 0, lightFilter: 15, liquid: 'none',
		textures: { kind: 'uniform', all: 'dirt' } },
	{ id: 3, name: 'stone', label: 'Stone', solid: true, transparent: false, kidMode: true, hardness: 1.2,
		lightLevel: 0, lightFilter: 15, liquid: 'none',
		textures: { kind: 'uniform', all: 'stone' } },
	{ id: 4, name: 'cobblestone', label: 'Cobblestone', solid: true, transparent: false, kidMode: true, hardness: 1.2,
		lightLevel: 0, lightFilter: 15, liquid: 'none',
		textures: { kind: 'uniform', all: 'cobblestone' } },
	{ id: 5, name: 'sand', label: 'Sand', solid: true, transparent: false, kidMode: true, hardness: 0.3,
		lightLevel: 0, lightFilter: 15, liquid: 'none',
		textures: { kind: 'uniform', all: 'sand' } },
	{ id: 6, name: 'oak_planks', label: 'Oak Planks', solid: true, transparent: false, kidMode: true, hardness: 0.8,
		lightLevel: 0, lightFilter: 15, liquid: 'none',
		textures: { kind: 'uniform', all: 'oak_planks' } },
	{ id: 7, name: 'oak_log', label: 'Oak Log', solid: true, transparent: false, kidMode: true, hardness: 0.8,
		lightLevel: 0, lightFilter: 15, liquid: 'none',
		textures: { kind: 'columnar', top: 'oak_log_top', bottom: 'oak_log_top', sides: 'oak_log' } },
	{ id: 8, name: 'glass', label: 'Glass', solid: true, transparent: true, kidMode: true, hardness: 0.2,
		lightLevel: 0, lightFilter: 0, liquid: 'none',
		textures: { kind: 'uniform', all: 'glass' } },
	{ id: 9, name: 'white_wool', label: 'White Wool', solid: true, transparent: false, kidMode: true, hardness: 0.5,
		lightLevel: 0, lightFilter: 15, liquid: 'none',
		textures: { kind: 'uniform', all: 'white_wool' } },
	{ id: 10, name: 'red_wool', label: 'Red Wool', solid: true, transparent: false, kidMode: true, hardness: 0.5,
		lightLevel: 0, lightFilter: 15, liquid: 'none',
		textures: { kind: 'uniform', all: 'red_wool' } },
	{ id: 11, name: 'blue_wool', label: 'Blue Wool', solid: true, transparent: false, kidMode: true, hardness: 0.5,
		lightLevel: 0, lightFilter: 15, liquid: 'none',
		textures: { kind: 'uniform', all: 'blue_wool' } },
	{ id: 12, name: 'green_wool', label: 'Green Wool', solid: true, transparent: false, kidMode: true, hardness: 0.5,
		lightLevel: 0, lightFilter: 15, liquid: 'none',
		textures: { kind: 'uniform', all: 'green_wool' } },
	{ id: 13, name: 'yellow_wool', label: 'Yellow Wool', solid: true, transparent: false, kidMode: true, hardness: 0.5,
		lightLevel: 0, lightFilter: 15, liquid: 'none',
		textures: { kind: 'uniform', all: 'yellow_wool' } },
	{ id: 14, name: 'black_wool', label: 'Black Wool', solid: true, transparent: false, kidMode: true, hardness: 0.5,
		lightLevel: 0, lightFilter: 15, liquid: 'none',
		textures: { kind: 'uniform', all: 'black_wool' } },
	{ id: 15, name: 'tnt', label: 'TNT', solid: true, transparent: false, kidMode: true, hardness: 0.5,
		lightLevel: 0, lightFilter: 15, liquid: 'none',
		textures: { kind: 'top-bottom-side', top: 'tnt_top', bottom: 'tnt_bottom', side: 'tnt_side' } },
	{ id: 16, name: 'lamp', label: 'Lamp', solid: true, transparent: false, kidMode: true, hardness: 0.3,
		lightLevel: 15, lightFilter: 15, liquid: 'none',
		textures: { kind: 'uniform', all: 'glowstone' } },
	{ id: 17, name: 'water', label: 'Water', solid: false, transparent: true, kidMode: true, hardness: 0,
		lightLevel: 0, lightFilter: 2, liquid: 'water',
		textures: { kind: 'uniform', all: 'water_still' } },
	{ id: 18, name: 'lava', label: 'Lava', solid: false, transparent: true, kidMode: true, hardness: 0,
		lightLevel: 12, lightFilter: 3, liquid: 'lava',
		textures: { kind: 'uniform', all: 'lava_still' } },
	{ id: 19, name: 'obsidian', label: 'Obsidian', solid: true, transparent: false, kidMode: true, hardness: 1.2,
		lightLevel: 0, lightFilter: 15, liquid: 'none',
		textures: { kind: 'uniform', all: 'obsidian' } },
];

export const BLOCK_BY_NAME: Record<string, BlockDef> = Object.fromEntries(
	BLOCKS.map((b) => [b.name, b]),
);

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
