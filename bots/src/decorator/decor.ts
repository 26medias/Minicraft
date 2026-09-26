/**
 * The decorator's candidates: small decorations around a builder bot's build (corner lights, flower patches, leaf
 * bushes, a path out of the door, a garden fence), each a short cell list with a few words for the model. Pure given
 * the world view, the ownership and the kids: every cell is air, outside every build footprint, within 4 blocks of
 * this build's footprint, standing on natural or bot ground (or on an earlier cell of the same decoration), and passes
 * the builder's checkPlace (never on or next to a kid cell, never in a kid's body buffer).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorldView } from '../port.js';
import type { Vec3 } from '../types.js';
import type { Ownership } from '../brain2/ownership.js';
import { groundTop } from '../brain2/behaviours/site-search.js';
import { templateOf } from '../brain2/behaviours/templates.data.js';
import { checkPlace, type BuilderBuild, type BuilderFile } from '../builder/builder.js';
import { cellKey } from '../builder/moves.js';
import type { StopSignal } from '../body/stop-signal.js';
import type { KidPos } from '../brain2/safety.js';

/** A decoration may reach this far (Chebyshev, in x/z) from the build's footprint. */
export const DECOR_RANGE = 4;

export type DecorKind = 'lights' | 'flowers' | 'bush' | 'path' | 'fence';
export interface DecorCell { cell: Vec3; block: string }
export interface Decoration { kind: DecorKind; description: string; cells: DecorCell[] }
export interface KnownBuild { bot: string; build: BuilderBuild }

/** Themed blocks. Real catalog names only (checked against blockNames() in the test and filtered at startup). */
export const DECOR_BLOCKS: Readonly<Record<'post' | 'light' | 'flower' | 'bush' | 'path' | 'fence', readonly string[]>> = {
	post: ['oak_log', 'spruce_log', 'birch_log', 'stripped_oak_log'],
	light: ['lamp', 'sea_lantern', 'ochre_froglight', 'pearlescent_froglight', 'jack_o_lantern', 'shroomlight'],
	flower: ['flowering_azalea_leaves', 'pink_wool', 'yellow_wool', 'red_wool', 'light_blue_wool', 'magenta_wool'],
	bush: ['oak_leaves', 'azalea_leaves', 'birch_leaves', 'cherry_leaves', 'moss_block'],
	path: ['gravel', 'cobblestone', 'mossy_cobblestone', 'moss_block'],
	fence: ['spruce_log', 'oak_log', 'stripped_spruce_log', 'mossy_cobblestone'],
};

/** Every builder record in `<stateRoot>/builder/<target>/<world>/*.json` (all bots), with the union of their owned cells. */
export function readBuilderRecords(dir: string): { builds: KnownBuild[]; owned: Record<string, number> } {
	const builds: KnownBuild[] = [];
	const owned: Record<string, number> = {};
	let names: string[] = [];
	try {
		names = readdirSync(dir).filter((f) => f.endsWith('.json'));
	} catch {
		return { builds, owned };
	}
	for (const f of names) {
		try {
			const file = JSON.parse(readFileSync(join(dir, f), 'utf8')) as BuilderFile;
			if (!file || file.v !== 1 || !Array.isArray(file.builds)) continue;
			Object.assign(owned, file.owned ?? {});
			for (const b of file.builds) if (b.status === 'done' || b.placed.length >= 8) builds.push({ bot: f.slice(0, -5), build: b });
		} catch {
			// unreadable (being written): skip this round
		}
	}
	return { builds, owned };
}

export const inFoot = (b: { origin: Vec3; w: number; d: number }, x: number, z: number, m = 0): boolean =>
	x >= b.origin.x - m && x < b.origin.x + b.w + m && z >= b.origin.z - m && z < b.origin.z + b.d + m;

/** Chebyshev x/z distance from a column to the footprint (0 inside). */
export function footDist(b: { origin: Vec3; w: number; d: number }, x: number, z: number): number {
	const dx = Math.max(b.origin.x - x, 0, x - (b.origin.x + b.w - 1));
	const dz = Math.max(b.origin.z - z, 0, z - (b.origin.z + b.d - 1));
	return Math.max(dx, dz);
}

/** The door gaps of a build, in world cells, with the outward direction. */
export function doorsOf(b: BuilderBuild): Array<{ cell: Vec3; dir: [number, number] }> {
	let gaps: Array<{ x: number; y: number; z: number }> = [];
	try {
		gaps = templateOf(b.template, b.variant).doorGaps;
	} catch {
		return [];
	}
	const out: Array<{ cell: Vec3; dir: [number, number] }> = [];
	for (const g of gaps) {
		const dir: [number, number] | null = g.x === 0 ? [-1, 0] : g.x === b.w - 1 ? [1, 0] : g.z === 0 ? [0, -1] : g.z === b.d - 1 ? [0, 1] : null;
		if (dir && !out.some((o) => o.cell.x === b.origin.x + g.x && o.cell.z === b.origin.z + g.z)) {
			out.push({ cell: { x: b.origin.x + g.x, y: b.origin.y + g.y, z: b.origin.z + g.z }, dir });
		}
	}
	return out;
}

export interface DecorCtx {
	world: WorldView; own: Ownership; kids: KidPos[]; stop: StopSignal; now: number; lastEditT: number | null; noEdits: boolean;
	/** Every known build (all bots), to keep decorations out of footprints. */
	allBuilds: readonly BuilderBuild[];
	/** Block names the catalog knows. */
	known: ReadonlySet<string>;
	rng: () => number;
}

const pick = <T>(xs: readonly T[], rng: () => number): T => xs[Math.floor(rng() * xs.length) % xs.length];

/** Is this column's cell (on top of the ground) acceptable for `b`? Returns the cell or null. */
function groundCell(b: BuilderBuild, x: number, z: number, c: DecorCtx, doorFront: ReadonlySet<string>, allowDoorFront = false): Vec3 | null {
	if (footDist(b, x, z) < 1 || footDist(b, x, z) > DECOR_RANGE) return null;
	if (c.allBuilds.some((o) => inFoot(o, x, z))) return null;
	if (!allowDoorFront && doorFront.has(`${x},${z}`)) return null;
	const g = groundTop(c.world, x, z);
	if (g < 0 || g + 1 < b.origin.y - 3 || g + 1 > b.origin.y + 2) return null;
	if (c.own.classify(x, g, z) === 'kid') return null;
	return { x, y: g + 1, z };
}

/** The safety and air check for one cell (checkPlace: only into air, kid cells and their buffer, kid body buffer). */
export function cellSafe(cell: Vec3, block: string, c: DecorCtx): boolean {
	if (!c.known.has(block)) return false;
	if (c.world.getBlock(cell.x, cell.y, cell.z) !== 0) return false;
	const v = checkPlace(cell, block, { world: c.world, own: c.own, kids: c.kids, stop: c.stop, now: c.now, lastEditT: c.lastEditT, noEdits: c.noEdits, halted: null });
	return v.ok;
}

/** Keeps only the safe cells; a cell resting on an earlier cell of the same decoration is dropped with it. */
function filterCells(cells: DecorCell[], c: DecorCtx): DecorCell[] {
	const kept = new Set<string>();
	const out: DecorCell[] = [];
	for (const d of cells) {
		if (out.some((o) => cellKey(o.cell) === cellKey(d.cell))) continue;
		const below = cellKey({ x: d.cell.x, y: d.cell.y - 1, z: d.cell.z });
		const onOwnCell = cells.some((o) => cellKey(o.cell) === below);
		if (onOwnCell && !kept.has(below)) continue;
		if (!cellSafe(d.cell, d.block, c)) continue;
		kept.add(cellKey(d.cell));
		out.push(d);
	}
	return out;
}

const NICE_BUILD: Record<string, string> = { house: 'house', tower: 'tower', wall: 'garden wall', creeper: 'creeper statue', person: 'person statue', heart: 'heart statue' };
export const niceBuild = (b: BuilderBuild): string => `${b.variant === 'small' ? 'small' : 'big'} ${NICE_BUILD[b.template] ?? b.template}`;
const words = (s: string) => s.replace(/_/g, ' ');

/** Up to `max` candidate decorations for `b` (kinds not yet used on it first), each with ≥ 2 safe cells. */
export function candidateDecorations(b: BuilderBuild, c: DecorCtx, used: readonly DecorKind[] = [], max = 3): Decoration[] {
	const blocks = (k: keyof typeof DECOR_BLOCKS): string[] => DECOR_BLOCKS[k].filter((n) => c.known.has(n));
	const doors = doorsOf(b);
	const doorFront = new Set<string>();
	for (const d of doors) for (let i = 1; i <= 2; i++) doorFront.add(`${d.cell.x + d.dir[0] * i},${d.cell.z + d.dir[1] * i}`);
	const x0 = b.origin.x, z0 = b.origin.z, x1 = b.origin.x + b.w - 1, z1 = b.origin.z + b.d - 1;
	const all: Decoration[] = [];

	// Lights: a post with a light on top, on each outside corner.
	const post = blocks('post'), light = blocks('light');
	if (post.length && light.length) {
		const pb = pick(post, c.rng), lb = pick(light, c.rng);
		const cells: DecorCell[] = [];
		for (const [x, z] of [[x0 - 1, z0 - 1], [x1 + 1, z0 - 1], [x0 - 1, z1 + 1], [x1 + 1, z1 + 1]]) {
			const g = groundCell(b, x, z, c, doorFront);
			if (g) cells.push({ cell: g, block: pb }, { cell: { ...g, y: g.y + 1 }, block: lb });
		}
		all.push({ kind: 'lights', cells, description: `glowing ${words(lb)} lamps on ${words(pb)} posts at the corners` });
	}

	// The sides, each as a list of columns at distance `dist`, and which side has a door.
	const side = (s: number, dist: number): Array<[number, number]> => {
		const out: Array<[number, number]> = [];
		if (s === 0) for (let x = x0; x <= x1; x++) out.push([x, z0 - dist]);
		if (s === 1) for (let x = x0; x <= x1; x++) out.push([x, z1 + dist]);
		if (s === 2) for (let z = z0; z <= z1; z++) out.push([x0 - dist, z]);
		if (s === 3) for (let z = z0; z <= z1; z++) out.push([x1 + dist, z]);
		return out;
	};
	const doorSide = (s: number) => doors.some((d) => (s === 0 && d.dir[1] === -1) || (s === 1 && d.dir[1] === 1) || (s === 2 && d.dir[0] === -1) || (s === 3 && d.dir[0] === 1));
	const sides = [0, 1, 2, 3].sort(() => c.rng() - 0.5);
	const quiet = sides.filter((s) => !doorSide(s));

	// Flowers: a small patch 2 out from a side.
	const flower = blocks('flower');
	if (flower.length) {
		const s = quiet[0] ?? sides[0];
		const cols = side(s, 2);
		const mid = Math.floor(cols.length / 2);
		const fa = pick(flower, c.rng), fb = pick(flower, c.rng);
		const cells = cols.slice(Math.max(0, mid - 2), mid + 2).map(([x, z], i) => ({ x, z, block: i % 2 ? fa : fb }))
			.map((q) => ({ g: groundCell(b, q.x, q.z, c, doorFront), block: q.block }))
			.filter((q): q is { g: Vec3; block: string } => q.g !== null).map((q) => ({ cell: q.g, block: q.block }));
		all.push({ kind: 'flowers', cells, description: `a flower patch of ${words(fa)} and ${words(fb)} beside the ${niceBuild(b)}` });
	}

	// Bush: an L of leaves 2 out from another side, one on top.
	const bush = blocks('bush');
	if (bush.length) {
		const s = quiet[1] ?? sides[1];
		const cols = side(s, 2);
		const bb = pick(bush, c.rng);
		const a = cols[0];
		const cells: DecorCell[] = [];
		if (a) {
			const out = s === 0 ? [0, -1] : s === 1 ? [0, 1] : s === 2 ? [-1, 0] : [1, 0];
			for (const [x, z] of [a, cols[1] ?? a, [a[0] + out[0], a[1] + out[1]]] as Array<[number, number]>) {
				const g = groundCell(b, x, z, c, doorFront);
				if (g) cells.push({ cell: g, block: bb });
			}
			if (cells[0]) cells.push({ cell: { ...cells[0].cell, y: cells[0].cell.y + 1 }, block: bb });
		}
		all.push({ kind: 'bush', cells, description: `a round ${words(bb)} bush near a corner` });
	}

	// Path: from the door gap straight out, 4 blocks.
	const path = blocks('path');
	if (path.length && doors.length) {
		const d = doors[0];
		const pb = pick(path, c.rng);
		const cells: DecorCell[] = [];
		for (let i = 1; i <= DECOR_RANGE; i++) {
			const g = groundCell(b, d.cell.x + d.dir[0] * i, d.cell.z + d.dir[1] * i, c, doorFront, true);
			if (g) cells.push({ cell: g, block: pb });
		}
		all.push({ kind: 'path', cells, description: `a ${words(pb)} path leading out from the door` });
	}

	// Fence: a garden fence line 3 out along a quiet side, with flowers inside it.
	const fence = blocks('fence');
	if (fence.length) {
		const s = quiet[2] ?? quiet[0] ?? sides[2];
		const fb = pick(fence, c.rng);
		const cells: DecorCell[] = [];
		for (const [x, z] of side(s, 3)) {
			const g = groundCell(b, x, z, c, doorFront);
			if (g) cells.push({ cell: g, block: fb });
		}
		if (flower.length) {
			const fl = pick(flower, c.rng);
			for (const [x, z] of side(s, 2).filter((_, i) => i % 2 === 1)) {
				const g = groundCell(b, x, z, c, doorFront);
				if (g) cells.push({ cell: g, block: fl });
			}
		}
		all.push({ kind: 'fence', cells, description: `a little garden with a ${words(fb)} fence` });
	}

	const safe = all.map((d) => ({ ...d, cells: filterCells(d.cells, c) })).filter((d) => d.cells.length >= 2);
	const fresh = safe.filter((d) => !used.includes(d.kind));
	const rest = safe.filter((d) => used.includes(d.kind));
	return [...fresh.sort(() => c.rng() - 0.5), ...rest].slice(0, max).map((d) => ({ ...d, description: `${d.description} (${d.cells.length} blocks)` }));
}
