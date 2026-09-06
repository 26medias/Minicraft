import { type BlockDef, type BlockFaceTextures, type BlockGroup, GENERATED_ID_START } from './blocks.base.data';

export type ModelJson = {
	parent?: string;
	textures?: Record<string, string>;
	elements?: Array<{ from: number[]; to: number[]; faces: Record<string, { texture: string }> }>;
};
export type BlockstateJson = {
	variants?: Record<string, { model: string } | { model: string }[]>;
	multipart?: unknown;
};
export type Models = Record<string, ModelJson>;
export type SixFaces = { px: string; nx: string; py: string; ny: string; pz: string; nz: string };

export function modelKey(ref: string): string {
	return ref.replace(/^minecraft:/, '').replace(/^block\//, '');
}

/** The model and its ancestors, nearest first. */
function chain(models: Models, model: string): ModelJson[] {
	const out: ModelJson[] = [];
	let cur: string | undefined = model;
	const seen = new Set<string>();
	while (cur && !seen.has(cur)) {
		seen.add(cur);
		const m: ModelJson | undefined = models[cur];
		if (!m) break;
		out.push(m);
		cur = m.parent ? modelKey(m.parent) : undefined;
	}
	return out;
}

function isUnit(v: number[], expect: number): boolean {
	return v.length === 3 && v.every((n) => n === expect);
}

/** True when the nearest ancestor with elements has exactly one 0..16 cube. */
export function isFullCube(models: Models, model: string): boolean {
	const withElements = chain(models, model).find((m) => m.elements);
	if (!withElements || !withElements.elements) return false;
	const els = withElements.elements;
	return els.length === 1 && isUnit(els[0].from, 0) && isUnit(els[0].to, 16);
}

/**
 * The variant that gives the block its "resting" look: upright for logs
 * (axis=y; the axis=x model of cherry/bamboo logs carries a sideways element),
 * front on north for furnaces and dispensers, else the first in file order.
 */
export function firstVariantModel(bs: BlockstateJson): string | null {
	if (!bs.variants) return null;
	const keys = Object.keys(bs.variants);
	if (keys.length === 0) return null;
	const pick =
		keys.find((k) => k.split(',').includes('axis=y')) ??
		keys.find((k) => k.split(',').includes('facing=north')) ??
		keys[0];
	const entry = bs.variants[pick];
	const v = Array.isArray(entry) ? entry[0] : entry;
	return v ? modelKey(v.model) : null;
}

const FACE_MAP: Record<string, keyof SixFaces> = { north: 'nz', south: 'pz', east: 'px', west: 'nx', up: 'py', down: 'ny' };

export function resolveFaces(models: Models, model: string): SixFaces {
	const ch = chain(models, model);
	const withElements = ch.find((m) => m.elements);
	if (!withElements?.elements?.[0]) throw new Error(`unresolved faces for ${model}: no elements`);
	// Nearest definition wins.
	const vars: Record<string, string> = {};
	for (let i = ch.length - 1; i >= 0; i--) Object.assign(vars, ch[i].textures ?? {});
	const deref = (ref: string, face: string): string => {
		let cur = ref;
		for (let hops = 0; hops < 16; hops++) {
			if (!cur.startsWith('#')) return modelKey(cur);
			const next = vars[cur.slice(1)];
			if (next === undefined) throw new Error(`unresolved face ${face} (${ref}) for ${model}`);
			cur = next;
		}
		throw new Error(`unresolved face ${face} for ${model}: reference loop`);
	};
	const out: Partial<SixFaces> = {};
	for (const [mcFace, ours] of Object.entries(FACE_MAP)) {
		const f = withElements.elements[0].faces[mcFace];
		if (!f) throw new Error(`unresolved face ${mcFace} for ${model}: missing`);
		out[ours] = deref(f.texture, mcFace);
	}
	return out as SixFaces;
}

export function facesToTextures(f: SixFaces): BlockFaceTextures {
	const sides = [f.px, f.nx, f.pz, f.nz];
	const sidesEqual = sides.every((s) => s === f.px);
	if (sidesEqual && f.py === f.px && f.ny === f.px) return { kind: 'uniform', all: f.px };
	if (sidesEqual && f.py === f.ny) return { kind: 'columnar', top: f.py, bottom: f.ny, sides: f.px };
	if (sidesEqual) return { kind: 'top-bottom-side', top: f.py, bottom: f.ny, side: f.px };
	return { kind: 'six', px: f.px, nx: f.nx, py: f.py, ny: f.ny, pz: f.pz, nz: f.nz };
}

export function textureNames(t: BlockFaceTextures): string[] {
	switch (t.kind) {
		case 'uniform': return [t.all];
		case 'top-bottom-side': return [t.top, t.bottom, t.side];
		case 'columnar': return [t.top, t.bottom, t.sides];
		case 'six': return [t.px, t.nx, t.py, t.ny, t.pz, t.nz];
	}
}

export function dedupeKey(t: BlockFaceTextures): string {
	return `${t.kind}:${textureNames(t).join(',')}`;
}

const EXCLUDED_NAMES = new Set([
	'command_block', 'chain_command_block', 'repeating_command_block', 'structure_block', 'jigsaw',
	'test_block', 'test_instance_block', 'barrier', 'light', 'spawner', 'trial_spawner', 'vault',
	'respawn_anchor', 'frosted_ice', 'reinforced_deepslate',
]);
const EXCLUDED_PREFIXES = ['waxed_', 'infested_'];

export function isExcluded(name: string): boolean {
	return EXCLUDED_NAMES.has(name) || EXCLUDED_PREFIXES.some((p) => name.startsWith(p));
}

/** Block name → model to use instead of the first variant. */
export const LOOK_OVERRIDES: Record<string, string> = { redstone_lamp: 'redstone_lamp_on' };

export const LIGHT_LEVELS: Record<string, number> = {
	sea_lantern: 15, shroomlight: 15, jack_o_lantern: 15, ochre_froglight: 15, verdant_froglight: 15,
	pearlescent_froglight: 15, magma_block: 3, crying_obsidian: 10, redstone_lamp: 15,
};

// Order matters: first matching token wins.
const GROUP_RULES: Array<[BlockGroup, string[]]> = [
	['glazed', ['glazed']],
	['glass', ['stained_glass', 'glass', 'ice']],
	['wool', ['_wool']],
	['concrete', ['_concrete']],
	['terracotta', ['terracotta']],
	['coral', ['coral']],
	['light', ['glowstone', 'sea_lantern', 'froglight', 'jack_o_lantern', 'redstone_lamp']],
	['deepslate', ['deepslate', 'tuff', 'sculk']],
	['end', ['end_', 'purpur', 'chorus']],
	['nether', ['netherrack', 'nether_', 'soul_', 'basalt', 'blackstone', 'magma', 'shroomlight', 'warped', 'crimson', 'ancient_debris']],
	['ore', ['_ore', 'raw_']],
	['metal', ['copper', 'iron_block', 'gold_block', 'diamond_block', 'emerald_block', 'netherite', 'lapis_block', 'redstone_block', 'coal_block', 'amethyst']],
	['wood', ['_planks', '_log', '_wood', '_stem', '_hyphae', '_leaves', 'bookshelf', 'bamboo']],
	['utility', ['furnace', 'smoker', '_table', 'loom', 'barrel', 'jukebox', 'note_block', 'target', 'bone_block', 'beehive', 'bee_nest', 'dispenser', 'dropper', 'observer', 'composter', 'lodestone', 'crafter']],
	['stone', ['stone', 'brick', 'andesite', 'diorite', 'granite', 'cobble', 'prismarine', 'quartz', 'calcite', 'dripstone', 'obsidian', 'bedrock', 'packed_mud', 'resin']],
	['sand', ['sand', 'gravel', 'clay']],
	['earth', ['dirt', 'grass', 'mud', 'moss', 'mycelium', 'podzol', 'snow', 'hay', 'melon', 'pumpkin', 'sponge', 'honey', 'slime', 'dried_kelp']],
];

export function groupOf(name: string): BlockGroup {
	for (const [group, tokens] of GROUP_RULES) if (tokens.some((t) => name.includes(t))) return group;
	return 'other';
}

const HARDNESS: Record<BlockGroup, number> = {
	basics: 0.8, wool: 0.3, glass: 0.3, glazed: 0.3, earth: 0.3, sand: 0.3, coral: 0.3,
	wood: 0.8, concrete: 0.8, terracotta: 0.8, utility: 0.8, light: 0.8, other: 0.8,
	stone: 1.2, deepslate: 1.2, nether: 1.2, end: 1.2, metal: 1.5, ore: 1.5,
};
export function hardnessFor(group: BlockGroup): number {
	return HARDNESS[group];
}

export function labelFor(name: string): string {
	return name.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export function classifyAlpha(alpha: ArrayLike<number>): { transparent: boolean; translucent: boolean } {
	let transparent = false, translucent = false;
	for (let i = 0; i < alpha.length; i++) {
		const a = alpha[i];
		if (a < 255) transparent = true;
		if (a > 0 && a < 255) translucent = true;
	}
	return { transparent, translucent };
}

export type Candidate = { name: string; textures: BlockFaceTextures };

export function selectCandidates(
	blockstates: Record<string, BlockstateJson>,
	models: Models,
	base: BlockDef[],
): { candidates: Candidate[]; dropped: { name: string; reason: string }[] } {
	const dropped: { name: string; reason: string }[] = [];
	const baseNames = new Set(base.map((b) => b.name));
	const seen = new Map<string, string>();
	for (const b of base) if (b.textures) seen.set(dedupeKey(b.textures), b.name);

	const resolved: Candidate[] = [];
	for (const name of Object.keys(blockstates).sort()) {
		if (baseNames.has(name)) { dropped.push({ name, reason: 'already a base block' }); continue; }
		if (isExcluded(name)) { dropped.push({ name, reason: 'excluded by name' }); continue; }
		const model = LOOK_OVERRIDES[name] ?? firstVariantModel(blockstates[name]);
		if (!model) { dropped.push({ name, reason: 'multipart or no variants (not a full cube)' }); continue; }
		const bs = blockstates[name];
		const allModels = Object.values(bs.variants ?? {}).flatMap((v) => (Array.isArray(v) ? v : [v])).map((v) => modelKey(v.model));
		if (!allModels.every((m) => isFullCube(models, m))) { dropped.push({ name, reason: 'not a full cube' }); continue; }
		try {
			resolved.push({ name, textures: facesToTextures(resolveFaces(models, model)) });
		} catch (e) {
			dropped.push({ name, reason: String((e as Error).message) });
		}
	}
	// Shortest name wins, then alphabetical.
	resolved.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
	const candidates: Candidate[] = [];
	for (const c of resolved) {
		const key = dedupeKey(c.textures);
		const winner = seen.get(key);
		if (winner) { dropped.push({ name: c.name, reason: `duplicate of ${winner}` }); continue; }
		seen.set(key, c.name);
		candidates.push(c);
	}
	candidates.sort((a, b) => a.name.localeCompare(b.name));
	return { candidates, dropped };
}

/** The committed blocks.catalog.ids.json: frozen name→id plus which names are tombstoned. */
export type IdMap = { ids: Record<string, number>; retired: string[] };

export function assignIds(existing: IdMap, names: string[], retire: string[]): IdMap {
	const ids: Record<string, number> = { ...existing.ids };
	const present = new Set(names);
	const retired = new Set(existing.retired.filter((n) => !present.has(n)));
	for (const n of retire) retired.add(n);
	for (const name of Object.keys(existing.ids)) {
		if (!present.has(name) && !retired.has(name)) {
			throw new Error(`frozen block "${name}" (id ${existing.ids[name]}) no longer resolves; pass --retire ${name} to tombstone it`);
		}
	}
	let next = Math.max(GENERATED_ID_START - 1, ...Object.values(ids)) + 1;
	for (const name of [...names].sort()) {
		if (ids[name] === undefined) ids[name] = next++;
	}
	return { ids, retired: [...retired].sort() };
}

export function makeRows(
	candidates: Candidate[],
	map: IdMap,
	alphaOf: (texture: string) => { transparent: boolean; translucent: boolean },
): BlockDef[] {
	const byName = new Map(candidates.map((c) => [c.name, c]));
	const rows: BlockDef[] = [];
	for (const [name, id] of Object.entries(map.ids).sort((a, b) => a[1] - b[1])) {
		const c = byName.get(name);
		if (!c) {
			rows.push({
				id, name: `retired_${id}`, label: `Retired ${id}`, solid: false, transparent: true,
				translucent: false, hardness: 0, lightLevel: 0, lightFilter: 0, liquid: 'none',
				textures: null, group: 'other', retired: true,
			});
			continue;
		}
		let transparent = false, translucent = false;
		for (const t of textureNames(c.textures)) {
			const a = alphaOf(t);
			transparent ||= a.transparent;
			translucent ||= a.translucent;
		}
		const group = groupOf(name);
		rows.push({
			id, name, label: labelFor(name), solid: true, transparent, translucent,
			hardness: hardnessFor(group), lightLevel: LIGHT_LEVELS[name] ?? 0,
			lightFilter: transparent ? 0 : 15, liquid: 'none', textures: c.textures, group,
		});
	}
	return rows;
}
