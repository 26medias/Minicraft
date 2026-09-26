/**
 * The architect's parametric voxel generators (experiment E6): each idea is a small function of a few integer
 * parameters (size, height, stripes, fins...) that returns role-coded cells; a theme turns roles into real blocks.
 * Every idea offers 3 sizes and 3 styles (preset parameter sets the model chooses among), and declares each numeric
 * parameter's range (the --llm-params proposer is clamped to it). `validateDesign` checks the bounds (≤ 12×12
 * footprint, ≤ 20 high, ≤ 400 cells), the block names, and support: every cell must reach the ground (y = 0) through
 * a chain of face-adjacent design cells; the BFS depth of that chain is the placement order (supported first).
 */
import type { Vec3 } from '../types.js';

export type DRole = 'main' | 'trim' | 'accent' | 'light' | 'glass' | 'dark';
export interface RoleCell { x: number; y: number; z: number; role: DRole }
export type Params = Record<string, number>;
export interface ParamSpec { min: number; max: number; what: string }
export interface Preset { key: string; label: string; p: Params }
export interface Idea {
	name: string; nice: string;
	params: Record<string, ParamSpec>;
	sizes: readonly [Preset, Preset, Preset];
	styles: readonly [Preset, Preset, Preset];
	/** Roles this idea always colours itself (a red mushroom cap, a yellow smiley), whatever the theme. */
	colors?: (p: Params) => Partial<Record<DRole, string>>;
	gen(p: Params): RoleCell[];
}
export interface Theme { name: string; description: string; blocks: Record<DRole, string> }
export interface DesignCell { cell: Vec3; block: string; role: DRole; depth: number }
export interface Design { idea: string; size: string; style: string; theme: string; params: Params; w: number; d: number; h: number; cells: DesignCell[] }

export const MAX_W = 12;
export const MAX_H = 20;
export const MAX_CELLS = 400;

export const THEMES: readonly Theme[] = [
	{ name: 'stone castle', description: 'grey stone bricks and cobblestone with red banners and warm lamps', blocks: { main: 'stone_bricks', trim: 'cobblestone', accent: 'red_wool', light: 'lamp', glass: 'glass', dark: 'dark_oak_planks' } },
	{ name: 'candy', description: 'pink, white and light blue, like a birthday cake, with glowing sea lanterns', blocks: { main: 'pink_concrete', trim: 'white_concrete', accent: 'light_blue_concrete', light: 'sea_lantern', glass: 'glass', dark: 'purple_concrete' } },
	{ name: 'sunny desert', description: 'sandstone with orange stripes and warm glowing froglights', blocks: { main: 'sandstone', trim: 'cut_sandstone', accent: 'orange_terracotta', light: 'ochre_froglight', glass: 'glass', dark: 'spruce_planks' } },
	{ name: 'forest', description: 'oak planks and logs with green moss and lamps', blocks: { main: 'oak_planks', trim: 'oak_log', accent: 'moss_block', light: 'lamp', glass: 'glass', dark: 'dark_oak_planks' } },
	{ name: 'ocean', description: 'prismarine and blue, with icy windows and glowing sea lanterns', blocks: { main: 'prismarine', trim: 'dark_prismarine', accent: 'light_blue_concrete', light: 'sea_lantern', glass: 'light_blue_stained_glass', dark: 'blue_concrete' } },
];

export const themeSlug = (t: Theme): string => t.name.replace(/ /g, '-');

/** A cell collector: later writes win; negative or out-of-range cells are the generator's bug (validate catches them). */
class Grid {
	readonly m = new Map<string, RoleCell>();
	put(x: number, y: number, z: number, role: DRole): void {
		this.m.set(`${x},${y},${z}`, { x, y, z, role });
	}
	del(x: number, y: number, z: number): void {
		this.m.delete(`${x},${y},${z}`);
	}
	cells(): RoleCell[] {
		return [...this.m.values()];
	}
}

/** Inside a disk of radius r around (0,0) (the + r rounds it like a Minecraft circle). */
const inDisk = (dx: number, dz: number, r: number): boolean => r >= 0 && dx * dx + dz * dz <= r * r + r;

const pyramid: Idea = {
	name: 'pyramid', nice: 'a pyramid',
	params: { base: { min: 5, max: 11, what: 'base width in blocks (odd)' }, stripes: { min: 0, max: 2, what: '0 plain, 1 striped layers, 2 checker' }, top: { min: 0, max: 1, what: '1 = a glowing top block' } },
	sizes: [{ key: 'small', label: 'small', p: { base: 5 } }, { key: 'medium', label: 'medium', p: { base: 7 } }, { key: 'tall', label: 'big', p: { base: 9 } }],
	styles: [{ key: 'plain', label: 'plain, with a glowing top', p: { stripes: 0, top: 1 } }, { key: 'striped', label: 'striped layers', p: { stripes: 1, top: 0 } }, { key: 'checker', label: 'checkerboard, with a glowing top', p: { stripes: 2, top: 1 } }],
	gen(p) {
		const g = new Grid();
		const base = p.base % 2 === 0 ? p.base - 1 : p.base;
		for (let y = 0; y * 2 < base; y++) {
			for (let x = y; x < base - y; x++) {
				for (let z = y; z < base - y; z++) {
					const role: DRole = p.stripes === 1 ? (y % 2 ? 'trim' : 'main') : p.stripes === 2 ? ((x + y + z) % 2 ? 'trim' : 'main') : 'main';
					g.put(x, y, z, role);
				}
			}
		}
		if (p.top) g.put((base - 1) / 2, (base - 1) / 2, (base - 1) / 2, 'light');
		return g.cells();
	},
};

const lighthouse: Idea = {
	name: 'lighthouse', nice: 'a lighthouse',
	params: { radius: { min: 2, max: 3, what: 'tower radius' }, height: { min: 6, max: 16, what: 'tower height' }, stripe: { min: 0, max: 3, what: 'stripe height (0 = none)' } },
	sizes: [{ key: 'small', label: 'small', p: { radius: 2, height: 7 } }, { key: 'medium', label: 'medium', p: { radius: 2, height: 11 } }, { key: 'tall', label: 'tall', p: { radius: 3, height: 16 } }],
	styles: [{ key: 'stripes', label: 'wide red-and-white stripes', p: { stripe: 2 } }, { key: 'thin', label: 'thin stripes', p: { stripe: 1 } }, { key: 'plain', label: 'plain', p: { stripe: 0 } }],
	gen(p) {
		const g = new Grid();
		const r = p.radius, c = r, H = p.height;
		for (let y = 0; y < H; y++) {
			const role: DRole = p.stripe > 0 && Math.floor(y / p.stripe) % 2 === 1 ? 'accent' : 'trim';
			for (let dx = -r; dx <= r; dx++) {
				for (let dz = -r; dz <= r; dz++) {
					if (!inDisk(dx, dz, r) || inDisk(dx, dz, r - 1)) continue;
					if (dz === -r && dx === 0 && y < 2) continue; // the door
					g.put(c + dx, y, c + dz, role);
				}
			}
		}
		// The lamp room: a floor, glass around a light, a roof.
		for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (inDisk(dx, dz, r)) g.put(c + dx, H, c + dz, 'dark');
		const rr = Math.max(1, r - 1);
		for (let dx = -rr; dx <= rr; dx++) {
			for (let dz = -rr; dz <= rr; dz++) {
				if (!inDisk(dx, dz, rr)) continue;
				const edge = !inDisk(dx, dz, rr - 1);
				if (edge) g.put(c + dx, H + 1, c + dz, 'glass');
				g.put(c + dx, H + 2, c + dz, 'dark');
			}
		}
		g.put(c, H + 1, c, 'light');
		g.put(c, H + 3, c, 'accent');
		return g.cells();
	},
};

const rocket: Idea = {
	name: 'rocket', nice: 'a rocket ship',
	params: { height: { min: 6, max: 16, what: 'body height' }, fin: { min: 1, max: 3, what: 'fin length' }, finH: { min: 2, max: 4, what: 'fin height' }, window: { min: 0, max: 2, what: 'windows' } },
	sizes: [{ key: 'small', label: 'small', p: { height: 6, fin: 1 } }, { key: 'medium', label: 'medium', p: { height: 10, fin: 2 } }, { key: 'tall', label: 'tall', p: { height: 15, fin: 3 } }],
	styles: [{ key: 'big-fins', label: 'big fins and one round window', p: { finH: 4, window: 1 } }, { key: 'two-windows', label: 'short fins and two windows', p: { finH: 2, window: 2 } }, { key: 'plain', label: 'plain with medium fins', p: { finH: 3, window: 0 } }],
	gen(p) {
		const g = new Grid();
		const f = p.fin, c = 1 + f, H = p.height;
		for (let y = 0; y < H; y++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) g.put(c + dx, y, c + dz, 'trim');
		// Windows on the -z face.
		const wins = p.window === 0 ? [] : p.window === 1 ? [Math.floor(H * 0.6)] : [Math.floor(H * 0.4), Math.floor(H * 0.7)];
		for (const y of wins) g.put(c, y, c - 1, 'glass');
		// A band, the nose cone and a light at the tip.
		for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) g.put(c + dx, H - 1, c + dz, 'accent');
		g.put(c, H, c, 'accent');
		for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) g.put(c + dx, H, c + dz, 'accent');
		g.put(c, H + 1, c, 'accent');
		g.put(c, H + 2, c, 'light');
		// Four fins, from the ground up.
		for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
			for (let i = 1; i <= f; i++) {
				for (let y = 0; y < Math.min(H, p.finH + f - i); y++) g.put(c + dx * (1 + i), y, c + dz * (1 + i), 'accent');
			}
		}
		return g.cells();
	},
};

const mushroom: Idea = {
	name: 'mushroom', nice: 'a giant mushroom',
	params: { stem: { min: 2, max: 8, what: 'stem height' }, cap: { min: 3, max: 5, what: 'cap radius' }, kind: { min: 0, max: 2, what: '0 red with white spots, 1 brown, 2 glowing purple' } },
	sizes: [{ key: 'small', label: 'small', p: { stem: 3, cap: 3 } }, { key: 'medium', label: 'medium', p: { stem: 4, cap: 4 } }, { key: 'tall', label: 'tall', p: { stem: 6, cap: 5 } }],
	styles: [{ key: 'red', label: 'red with white spots', p: { kind: 0 } }, { key: 'brown', label: 'brown and cosy', p: { kind: 1 } }, { key: 'glowing', label: 'glowing purple with light spots', p: { kind: 2 } }],
	colors: (p) => (p.kind === 0 ? { main: 'red_concrete', accent: 'white_concrete', trim: 'white_concrete' }
		: p.kind === 1 ? { main: 'orange_terracotta', accent: 'white_concrete', trim: 'white_concrete' }
			: { main: 'purple_concrete', accent: 'sea_lantern', trim: 'white_concrete' }),
	gen(p) {
		const g = new Grid();
		const R = p.cap, c = R;
		for (let y = 0; y < p.stem; y++) for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) g.put(c + dx, y, c + dz, 'trim');
		// A dome: each layer one smaller; spots on the top surface.
		for (let k = 0; k <= R; k++) {
			const r = R - k, y = p.stem + k;
			for (let dx = -r; dx <= r; dx++) {
				for (let dz = -r; dz <= r; dz++) {
					if (!inDisk(dx, dz, r)) continue;
					const top = !inDisk(dx, dz, r - 1) || k === R;
					g.put(c + dx, y, c + dz, top && k > 0 && (dx * 2 + dz * 3 + 100) % 5 === 0 ? 'accent' : 'main');
				}
			}
		}
		return g.cells();
	},
};

const bridge: Idea = {
	name: 'bridge', nice: 'a bridge with railings',
	params: { span: { min: 7, max: 12, what: 'length' }, height: { min: 2, max: 5, what: 'deck height' }, arch: { min: 0, max: 1, what: '1 = an arch under the deck' }, lamps: { min: 0, max: 1, what: '1 = lamps on the ends' } },
	sizes: [{ key: 'small', label: 'short', p: { span: 7, height: 2 } }, { key: 'medium', label: 'medium', p: { span: 9, height: 3 } }, { key: 'tall', label: 'long', p: { span: 12, height: 5 } }],
	styles: [{ key: 'arched', label: 'with an arch and lamps', p: { arch: 1, lamps: 1 } }, { key: 'lamps', label: 'flat with lamps', p: { arch: 0, lamps: 1 } }, { key: 'plain', label: 'plain and flat', p: { arch: 0, lamps: 0 } }],
	gen(p) {
		const g = new Grid();
		const L = p.span, H = p.height;
		// Two pillars with steps up to the deck on the outside ends.
		for (const x0 of [0, L - 2]) for (let x = x0; x < x0 + 2; x++) for (let y = 0; y < H; y++) for (let z = 0; z < 3; z++) g.put(x, y, z, 'trim');
		for (let x = 0; x < L; x++) for (let z = 0; z < 3; z++) g.put(x, H, z, 'main');
		if (p.arch) {
			for (let x = 2; x < L - 2; x++) {
				const fromEnd = Math.min(x - 1, L - 2 - x);
				for (let y = Math.max(0, H - fromEnd); y < H; y++) if (y >= H - 2) for (const z of [0, 2]) g.put(x, y, z, 'trim');
			}
		}
		for (let x = 0; x < L; x++) {
			g.put(x, H + 1, 0, 'dark');
			g.put(x, H + 1, 2, 'dark');
		}
		if (p.lamps) for (const x of [0, L - 1]) for (const z of [0, 2]) g.put(x, H + 2, z, 'light');
		return g.cells();
	},
};

const castleGate: Idea = {
	name: 'castle-gate', nice: 'a castle gate with two towers',
	params: { gap: { min: 2, max: 6, what: 'gate opening width' }, height: { min: 5, max: 12, what: 'tower height' }, flags: { min: 0, max: 2, what: '0 plain, 1 flags on the towers, 2 lamps by the gate' } },
	sizes: [{ key: 'small', label: 'small', p: { gap: 2, height: 6 } }, { key: 'medium', label: 'medium', p: { gap: 4, height: 8 } }, { key: 'tall', label: 'big', p: { gap: 6, height: 11 } }],
	styles: [{ key: 'flags', label: 'with flags on the towers', p: { flags: 1 } }, { key: 'lamps', label: 'with lamps by the gate', p: { flags: 2 } }, { key: 'plain', label: 'plain battlements', p: { flags: 0 } }],
	gen(p) {
		const g = new Grid();
		const G = p.gap, H = p.height, W = 6 + G, gateH = Math.min(H - 2, 3 + Math.floor(G / 3));
		for (const x0 of [0, W - 3]) {
			for (let y = 0; y < H; y++) for (let x = x0; x < x0 + 3; x++) for (let z = 0; z < 3; z++) if (x !== x0 + 1 || z !== 1) g.put(x, y, z, 'main');
			// Battlements on the tower top.
			for (const [x, z] of [[x0, 0], [x0 + 2, 0], [x0, 2], [x0 + 2, 2]]) g.put(x, H, z, 'trim');
			if (p.flags === 1) {
				g.put(x0 + 1, H, 0, 'dark');
				g.put(x0 + 1, H + 1, 0, 'dark');
				g.put(x0 + 1, H + 2, 0, 'dark');
				g.put(x0 + 2, H + 2, 0, 'accent');
				g.put(x0 + 2, H + 1, 0, 'accent');
			}
		}
		// The wall over the gate.
		for (let x = 3; x < W - 3; x++) for (let y = gateH; y < H; y++) for (let z = 0; z < 3; z++) g.put(x, y, z, y === gateH ? 'trim' : 'main');
		for (let x = 3; x < W - 3; x += 2) g.put(x, H, 1, 'trim');
		if (p.flags === 2) for (const x of [2, W - 3]) g.put(x, Math.min(gateH, 2), 0, 'light');
		return g.cells();
	},
};

const treehouse: Idea = {
	name: 'treehouse', nice: 'a treehouse on a trunk, with stepping stones up',
	params: { trunk: { min: 3, max: 10, what: 'trunk height' }, deck: { min: 2, max: 3, what: 'platform half-size' }, roof: { min: 0, max: 2, what: '0 leafy roof, 1 flat roof, 2 flat roof with a lamp' } },
	sizes: [{ key: 'small', label: 'small', p: { trunk: 4, deck: 2 } }, { key: 'medium', label: 'medium', p: { trunk: 6, deck: 3 } }, { key: 'tall', label: 'tall', p: { trunk: 10, deck: 3 } }],
	styles: [{ key: 'leafy', label: 'a leafy roof', p: { roof: 0 } }, { key: 'flat', label: 'a flat wooden roof', p: { roof: 1 } }, { key: 'lamp', label: 'a flat roof with a lamp on top', p: { roof: 2 } }],
	colors: (p) => (p.roof === 0 ? { trim: 'oak_log', accent: 'oak_leaves' } : { trim: 'oak_log' }),
	gen(p) {
		const g = new Grid();
		const D = p.deck, c = D, T = p.trunk;
		for (let y = 0; y < T; y++) g.put(c, y, c, 'trim');
		// Stepping stones spiralling up the trunk (face-adjacent to it, 4 apart in each column: head room).
		const around = [[1, 0], [0, 1], [-1, 0], [0, -1]];
		for (let y = 0; y < T - 1; y++) g.put(c + around[y % 4][0], y, c + around[y % 4][1], 'dark');
		// The platform (with a hole over the last stone) and a little hut.
		const last = around[(T - 2) % 4];
		for (let dx = -D; dx <= D; dx++) for (let dz = -D; dz <= D; dz++) if (!(dx === last[0] && dz === last[1])) g.put(c + dx, T, c + dz, 'main');
		for (let y = T + 1; y <= T + 2; y++) {
			for (let dx = -1; dx <= 1; dx++) {
				for (let dz = -1; dz <= 1; dz++) {
					if (dx === 0 && dz === 0) continue;
					if (dz === 1 && dx === 0) continue; // the door
					g.put(c + dx, y, c + dz, y === T + 2 && dx === 0 ? 'glass' : 'main');
				}
			}
		}
		const rr = p.roof === 0 ? 2 : 1;
		for (let dx = -rr; dx <= rr; dx++) for (let dz = -rr; dz <= rr; dz++) if (Math.abs(dx) + Math.abs(dz) <= rr + 1) g.put(c + dx, T + 3, c + dz, p.roof === 0 ? 'accent' : 'dark');
		if (p.roof === 0) g.put(c, T + 4, c, 'accent');
		if (p.roof === 2) g.put(c, T + 4, c, 'light');
		return g.cells();
	},
};

/** The smiley's pixel map, drawn from the size: a disk face with eyes and a mouth (x across, y up). */
function smileyMap(n: number, mood: number): Array<Array<'face' | 'ink' | null>> {
	const r = (n - 1) / 2;
	const rows: Array<Array<'face' | 'ink' | null>> = [];
	for (let y = 0; y < n; y++) {
		const row: Array<'face' | 'ink' | null> = [];
		for (let x = 0; x < n; x++) {
			const dx = x - r, dy = y - r;
			row.push(dx * dx + dy * dy <= r * r + r * 0.6 ? 'face' : null);
		}
		rows.push(row);
	}
	const eyeY = Math.round(r + r * 0.35), ex = Math.max(1, Math.round(r * 0.45));
	const ink = (x: number, y: number) => {
		if (y >= 0 && y < n && x >= 0 && x < n && rows[y][x]) rows[y][x] = 'ink';
	};
	const L = Math.round(r - ex), Rx = Math.round(r + ex);
	ink(L, eyeY);
	if (mood === 1) for (const dx of [-1, 0, 1]) ink(Rx + dx, eyeY); // a wink
	else ink(Rx, eyeY);
	if (n >= 9 && mood !== 1) {
		ink(L, eyeY + 1);
		ink(Rx, eyeY + 1);
	}
	const mouthY = Math.round(r - r * 0.45);
	if (mood === 2) {
		// Surprised: a small round mouth.
		for (const [dx, dy] of [[0, 0], [1, 0], [0, -1], [1, -1]]) ink(Math.floor(r) + dx, mouthY + dy);
	} else {
		const half = Math.max(2, Math.round(r * 0.6));
		for (let dx = -half; dx <= half; dx++) {
			const x = Math.round(r + dx);
			ink(x, mouthY - (Math.abs(dx) < half ? 1 : 0));
		}
	}
	return rows;
}

const smiley: Idea = {
	name: 'smiley', nice: 'a pixel-art smiley face wall',
	params: { size: { min: 7, max: 12, what: 'face size in blocks' }, mood: { min: 0, max: 2, what: '0 happy, 1 winking, 2 surprised' } },
	sizes: [{ key: 'small', label: 'small', p: { size: 7 } }, { key: 'medium', label: 'medium', p: { size: 9 } }, { key: 'tall', label: 'big', p: { size: 12 } }],
	styles: [{ key: 'happy', label: 'a happy smile', p: { mood: 0 } }, { key: 'wink', label: 'a wink', p: { mood: 1 } }, { key: 'surprised', label: 'surprised', p: { mood: 2 } }],
	colors: () => ({ main: 'yellow_concrete', dark: 'black_concrete' }),
	gen(p) {
		const g = new Grid();
		const map = smileyMap(p.size, p.mood);
		map.forEach((row, y) => row.forEach((v, x) => {
			if (v) g.put(x, y, 0, v === 'ink' ? 'dark' : 'main');
		}));
		// A 1-block stand behind the bottom row keeps a thin wall from looking flimsy.
		for (let x = 0; x < p.size; x++) if (map[0][x]) g.put(x, 0, 1, 'trim');
		return g.cells();
	},
};

export const IDEAS: readonly Idea[] = [castleGate, lighthouse, pyramid, bridge, mushroom, rocket, treehouse, smiley];
export const ideaOf = (name: string): Idea | undefined => IDEAS.find((i) => i.name === name);

/** The parameters of a size + style (the idea's own defaults under them: every param gets a value). */
export function presetParams(idea: Idea, size: Preset, style: Preset): Params {
	const p: Params = {};
	for (const [k, s] of Object.entries(idea.params)) p[k] = s.min;
	return { ...p, ...idea.styles[0].p, ...idea.sizes[0].p, ...style.p, ...size.p };
}

/** Clamps proposed values into each param's range (integers); unknown keys dropped, missing keys from `base`. */
export function clampParams(idea: Idea, proposed: Record<string, unknown>, base: Params): Params {
	const out: Params = { ...base };
	for (const [k, s] of Object.entries(idea.params)) {
		const v = Number(proposed[k]);
		if (Number.isFinite(v)) out[k] = Math.min(s.max, Math.max(s.min, Math.round(v)));
	}
	return out;
}

export interface Validation { ok: boolean; errors: string[]; design?: Design }

/**
 * Generates and validates one design: bounds, names, and support. Each cell's depth = the BFS distance (over face
 * adjacency within the design) from a ground cell (y = 0); a cell no chain reaches is floating (an error). Cells come
 * out sorted by depth, then y: placing in that order, every cell has a placed neighbour (or the ground) first.
 */
export function makeDesign(idea: Idea, theme: Theme, sizeKey: string, styleKey: string, params: Params, known: ReadonlySet<string>): Validation {
	const errors: string[] = [];
	const raw = idea.gen(params);
	const blocks = { ...theme.blocks, ...(idea.colors?.(params) ?? {}) };
	if (raw.length === 0) errors.push('empty design');
	if (raw.length > MAX_CELLS) errors.push(`${raw.length} cells > ${MAX_CELLS}`);
	let w = 0, d = 0, h = 0;
	for (const c of raw) {
		if (c.x < 0 || c.z < 0 || c.y < 0) errors.push(`negative cell ${c.x},${c.y},${c.z}`);
		w = Math.max(w, c.x + 1);
		d = Math.max(d, c.z + 1);
		h = Math.max(h, c.y + 1);
	}
	if (w > MAX_W || d > MAX_W) errors.push(`footprint ${w}×${d} > ${MAX_W}×${MAX_W}`);
	if (h > MAX_H) errors.push(`height ${h} > ${MAX_H}`);
	for (const r of new Set(raw.map((c) => c.role))) if (!known.has(blocks[r])) errors.push(`unknown block ${blocks[r]} (${r})`);
	const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
	const depth = new Map<string, number>();
	const at = new Map(raw.map((c) => [key(c.x, c.y, c.z), c]));
	let frontier = raw.filter((c) => c.y === 0);
	for (const c of frontier) depth.set(key(c.x, c.y, c.z), 0);
	for (let dd = 1; frontier.length; dd++) {
		const next: RoleCell[] = [];
		for (const c of frontier) {
			for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
				const k = key(c.x + dx, c.y + dy, c.z + dz);
				const n = at.get(k);
				if (n && !depth.has(k)) {
					depth.set(k, dd);
					next.push(n);
				}
			}
		}
		frontier = next;
	}
	const floating = raw.filter((c) => !depth.has(key(c.x, c.y, c.z)));
	if (floating.length) errors.push(`${floating.length} floating cells (e.g. ${floating[0].x},${floating[0].y},${floating[0].z})`);
	if (errors.length) return { ok: false, errors };
	const cells: DesignCell[] = raw
		.map((c) => ({ cell: { x: c.x, y: c.y, z: c.z }, block: blocks[c.role], role: c.role, depth: depth.get(key(c.x, c.y, c.z))! }))
		.sort((a, b) => a.depth - b.depth || a.cell.y - b.cell.y);
	return { ok: true, errors, design: { idea: idea.name, size: sizeKey, style: styleKey, theme: theme.name, params, w, d, h, cells } };
}
