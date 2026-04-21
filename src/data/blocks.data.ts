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
	textures: BlockFaceTextures | null;
};

export const AIR: BlockId = 0;

export const BLOCKS: BlockDef[] = [
	{ id: 0, name: 'air', label: 'Air', solid: false, transparent: true, kidMode: true, hardness: 0, textures: null },
	{ id: 1, name: 'grass_block', label: 'Grass', solid: true, transparent: false, kidMode: true, hardness: 0.3,
		textures: { kind: 'top-bottom-side', top: 'grass_block_top', bottom: 'dirt', side: 'grass_block_side' } },
	{ id: 2, name: 'dirt', label: 'Dirt', solid: true, transparent: false, kidMode: true, hardness: 0.3,
		textures: { kind: 'uniform', all: 'dirt' } },
	{ id: 3, name: 'stone', label: 'Stone', solid: true, transparent: false, kidMode: true, hardness: 1.2,
		textures: { kind: 'uniform', all: 'stone' } },
	{ id: 4, name: 'cobblestone', label: 'Cobblestone', solid: true, transparent: false, kidMode: true, hardness: 1.2,
		textures: { kind: 'uniform', all: 'cobblestone' } },
	{ id: 5, name: 'sand', label: 'Sand', solid: true, transparent: false, kidMode: true, hardness: 0.3,
		textures: { kind: 'uniform', all: 'sand' } },
	{ id: 6, name: 'oak_planks', label: 'Oak Planks', solid: true, transparent: false, kidMode: true, hardness: 0.8,
		textures: { kind: 'uniform', all: 'oak_planks' } },
	{ id: 7, name: 'oak_log', label: 'Oak Log', solid: true, transparent: false, kidMode: true, hardness: 0.8,
		textures: { kind: 'columnar', top: 'oak_log_top', bottom: 'oak_log_top', sides: 'oak_log' } },
	{ id: 8, name: 'glass', label: 'Glass', solid: true, transparent: true, kidMode: true, hardness: 0.2,
		textures: { kind: 'uniform', all: 'glass' } },
	{ id: 9, name: 'white_wool', label: 'White Wool', solid: true, transparent: false, kidMode: true, hardness: 0.5,
		textures: { kind: 'uniform', all: 'white_wool' } },
	{ id: 10, name: 'red_wool', label: 'Red Wool', solid: true, transparent: false, kidMode: true, hardness: 0.5,
		textures: { kind: 'uniform', all: 'red_wool' } },
	{ id: 11, name: 'blue_wool', label: 'Blue Wool', solid: true, transparent: false, kidMode: true, hardness: 0.5,
		textures: { kind: 'uniform', all: 'blue_wool' } },
	{ id: 12, name: 'green_wool', label: 'Green Wool', solid: true, transparent: false, kidMode: true, hardness: 0.5,
		textures: { kind: 'uniform', all: 'green_wool' } },
	{ id: 13, name: 'yellow_wool', label: 'Yellow Wool', solid: true, transparent: false, kidMode: true, hardness: 0.5,
		textures: { kind: 'uniform', all: 'yellow_wool' } },
	{ id: 14, name: 'black_wool', label: 'Black Wool', solid: true, transparent: false, kidMode: true, hardness: 0.5,
		textures: { kind: 'uniform', all: 'black_wool' } },
	{ id: 15, name: 'tnt', label: 'TNT', solid: true, transparent: false, kidMode: true, hardness: 0.5,
		textures: { kind: 'top-bottom-side', top: 'tnt_top', bottom: 'tnt_bottom', side: 'tnt_side' } },
	{ id: 16, name: 'lamp', label: 'Lamp', solid: true, transparent: false, kidMode: true, hardness: 0.3,
		textures: { kind: 'uniform', all: 'glowstone' } },
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
