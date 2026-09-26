/**
 * Where a flatten blast may go and what it may remove. Pure over a WorldView and a cell classifier.
 *
 * - The blast cells come from the game's own `detonate` (the SDK's blastCells), so the bot removes exactly what the
 *   kid's TNT would, never a guess.
 * - `filterBlast` is the hard safety rule: only natural cells are removed, and the whole blast is dropped when any
 *   cell it would remove is within KID_CELL_DIST of a kid's cell, within KID_POS_DIST of a kid, or touches a liquid.
 * - `evaluateArea` plans one square: its floor level L (the lowest column top), the flatten centres covering it and
 *   the hole each needs so the TNT sits on natural ground at L; it refuses squares a blast could not safely level.
 */
import { blastCells, FLATTEN_HEIGHT, tntSpec, type BlastWorld } from 'minicraft-bot';
import type { WorldView } from '../port.js';
import type { Vec3 } from '../types.js';

export const KID_CELL_DIST = 12;
export const KID_POS_DIST = 24;
/** The side of the square a landscaper levels (the task's "≥ 16 × 16 flat"). */
export const AREA = 16;
/** The deepest hole the bot digs to seat a TNT at the floor level. */
export const MAX_DIG = 8;
const FLATTEN_RADIUS = tntSpec('flatten_tnt')!.radius;
const FACES: ReadonlyArray<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const WORLD_TOP = 255;
const NOT_TERRAIN = ['_leaves', '_log'];

export type CellClass = 'natural' | 'bot' | 'kid';
export interface FilterCtx {
	world: WorldView;
	classify(x: number, y: number, z: number): CellClass;
	/** Kid-edited cells near the blast (see `kidCellsNear`). */
	kidCells: readonly Vec3[];
	/** Kid (non-bot player) positions. */
	kids: readonly Vec3[];
}

/** A WorldView as detonate reads it (the world is 256 high; outside it getBlock is air). */
export function blastWorld(world: WorldView): BlastWorld {
	return { inBounds: (_x, y) => y >= 0 && y <= WORLD_TOP, getBlock: (x, y, z) => world.getBlock(x, y, z) };
}

const d3 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * The safety filter for one blast. `remove` = the natural cells of `destroyed` (bot and kid cells are never removed;
 * the TNT's own cell is the caller's). `dropped` names the first rule broken; when set, nothing may be removed.
 */
export function filterBlast(destroyed: readonly Vec3[], c: FilterCtx): { remove: Vec3[]; dropped: string | null } {
	const remove = destroyed.filter((q) => c.classify(q.x, q.y, q.z) === 'natural');
	for (const q of remove) {
		for (const k of c.kidCells) if (d3(q, k) <= KID_CELL_DIST) return { remove: [], dropped: `within ${KID_CELL_DIST} of a kid cell` };
		for (const k of c.kids) if (d3(q, k) <= KID_POS_DIST) return { remove: [], dropped: `within ${KID_POS_DIST} of a kid` };
		for (const [dx, dy, dz] of FACES) if (c.world.isLiquid(c.world.getBlock(q.x + dx, q.y + dy, q.z + dz))) return { remove: [], dropped: 'touches liquid' };
	}
	return { remove, dropped: null };
}

/** Every kid cell (edited, classified 'kid') in the chunks within `r` (horizontal) of the box [x0, x1] × [z0, z1]. */
export function kidCellsNear(world: WorldView, classify: FilterCtx['classify'], x0: number, z0: number, x1: number, z1: number, r: number): Vec3[] {
	const out: Vec3[] = [];
	for (let cx = Math.floor((x0 - r) / 16); cx <= Math.floor((x1 + r) / 16); cx++) {
		for (let cz = Math.floor((z0 - r) / 16); cz <= Math.floor((z1 + r) / 16); cz++) {
			for (const [x, y, z] of world.editedCellsInChunk(cx, cz)) if (classify(x, y, z) === 'kid') out.push({ x, y, z });
		}
	}
	return out;
}

/** The top terrain block of a column: the highest solid that is not leaves or a log (a canopy is not ground); −1 if none. */
export function terrainTop(world: WorldView, x: number, z: number): number {
	for (let y = WORLD_TOP; y >= 0; y--) {
		const v = world.getBlock(x, y, z);
		if (!world.isSolid(v)) continue;
		const n = world.blockName(v) ?? '';
		if (NOT_TERRAIN.some((s) => n.endsWith(s))) continue;
		return y;
	}
	return -1;
}

export interface BlastSpot {
	/** The TNT cell: the column (x, z), at the floor level + 1. */
	tnt: Vec3;
	/** The cells to dig first, top-down, so the TNT cell is air on natural ground (empty when it already is). */
	dig: Vec3[];
}
export interface AreaPlan {
	x0: number; z0: number; size: number;
	/** The floor level: every column of the square ends with its top at L. */
	L: number;
	spots: BlastSpot[];
	/** Natural cells the blasts would remove (on the world as it is now; overlaps counted once). */
	removes: number;
	/** The terrain range (max − min top) over the square. */
	range: number;
	digs: number;
}

/** The flatten centres covering a square of side `size` at (x0, z0): a grid, spaced so each cell is within the radius. */
export function spotColumns(x0: number, z0: number, size: number, radius = FLATTEN_RADIUS): Array<{ x: number; z: number }> {
	const step = Math.max(1, Math.floor(radius * Math.SQRT2) - 0); // radius 6 → 8: an 8 × 8 tile's corners are within 6 of its centre
	const n = Math.ceil(size / step);
	const out: Array<{ x: number; z: number }> = [];
	for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out.push({ x: x0 + Math.min(i * step + Math.floor(step / 2), size - 1), z: z0 + Math.min(j * step + Math.floor(step / 2), size - 1) });
	return out;
}

/**
 * Plans levelling the square [x0, x0 + size) × [z0, z0 + size): L = the lowest terrain top in it, one flatten TNT per
 * spotColumns centre at L + 1. Refused (a string) when: a column has no ground, the range is past what one blast
 * removes, a centre's hole would be deeper than MAX_DIG, or any blast breaks filterBlast (or would leave a bot cell).
 */
export function evaluateArea(world: WorldView, x0: number, z0: number, size: number, f: Omit<FilterCtx, 'world'>): AreaPlan | string {
	let lo = Infinity, hi = -Infinity;
	for (let x = x0; x < x0 + size; x++) {
		for (let z = z0; z < z0 + size; z++) {
			const t = terrainTop(world, x, z);
			if (t < 0) return 'no ground';
			lo = Math.min(lo, t);
			hi = Math.max(hi, t);
			if (world.isLiquid(world.getBlock(x, t + 1, z))) return 'water';
		}
	}
	const L = lo;
	if (hi - L > FLATTEN_HEIGHT + 1) return 'too steep';
	const spots: BlastSpot[] = [];
	const seen = new Set<string>();
	let digs = 0;
	const bw = blastWorld(world);
	for (const c of spotColumns(x0, z0, size)) {
		const top = terrainTop(world, c.x, c.z);
		if (top - L > MAX_DIG) return 'hole too deep';
		const dig: Vec3[] = [];
		for (let y = top; y >= L + 1; y--) if (world.getBlock(c.x, y, c.z) !== 0) dig.push({ x: c.x, y, z: c.z });
		// The TNT sits on the floor: natural, solid.
		if (!world.isSolid(world.getBlock(c.x, L, c.z)) || f.classify(c.x, L, c.z) !== 'natural') return 'no natural floor';
		for (const q of dig) if (f.classify(q.x, q.y, q.z) !== 'natural') return 'hole not natural';
		digs += dig.length;
		const tnt = { x: c.x, y: L + 1, z: c.z };
		const { destroyed } = blastCells(bw, 'flatten_tnt', tnt);
		if (destroyed.some((q) => f.classify(q.x, q.y, q.z) !== 'natural' && !(q.x === tnt.x && q.y === tnt.y && q.z === tnt.z))) return 'a bot or kid cell in the blast';
		const r = filterBlast(destroyed, { ...f, world });
		if (r.dropped) return r.dropped;
		for (const q of r.remove) seen.add(`${q.x},${q.y},${q.z}`);
		spots.push({ tnt, dig });
	}
	return { x0, z0, size, L, spots, removes: seen.size, range: hi - lo, digs };
}

/** How good a plan is: hilly but not a mountain, little digging, close to the anchor. Higher is better. */
export function scoreArea(p: AreaPlan, anchor: { x: number; z: number }): number {
	const d = Math.hypot(p.x0 + p.size / 2 - anchor.x, p.z0 + p.size / 2 - anchor.z);
	return Math.min(p.range, 6) * 10 - p.removes / 100 - p.digs * 2 - d / 4;
}
