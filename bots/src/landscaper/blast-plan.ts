/**
 * Where a flatten blast may go and what it may remove. Pure over a WorldView and a cell classifier.
 *
 * - The blast cells come from the game's own `detonate` (the SDK's blastCells), so the bot removes exactly what the
 *   kid's TNT would, never a guess.
 * - `filterBlast` is the hard safety rule: only natural cells are removed, and the whole blast is dropped when any
 *   cell it would remove is within KID_CELL_DIST of a kid's cell, within KID_POS_DIST of a kid, or touches a liquid.
 * - `evaluateArea` plans one square: its floor level L (the lowest top, or a terrace floor on a hill), the flatten
 *   centres covering it (stacked in layers on a hill) and the hole each needs so the TNT sits on natural ground; it
 *   refuses squares the blasts could not safely level.
 */
import { blastCells, FLATTEN_HEIGHT, tntSpec, type BlastWorld } from 'minicraft-bot';
import type { WorldView } from '../port.js';
import type { Vec3 } from '../types.js';

export const KID_CELL_DIST = 12;
export const KID_POS_DIST = 24;
/** The side of the square a landscaper levels (the task's "≥ 16 × 16 flat"). */
export const AREA = 16;
/** The deepest hole the bot digs to seat a TNT at its layer's floor (a lower layer's hole goes down one blast height). */
export const MAX_DIG = FLATTEN_HEIGHT + 1;
const FLATTEN_RADIUS = tntSpec('flatten_tnt')!.radius;
const FACES: ReadonlyArray<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const WORLD_TOP = 255;
const NOT_TERRAIN = ['_leaves', '_log'];
/** An area is worth levelling only when its filtered blasts remove at least this many cells above the floor. */
export const MIN_AREA_REMOVE = 40;
/** A blast is worth a TNT only when its filtered cells number at least this many. */
export const MIN_SPOT_REMOVE = 15;
/** An area is already flat when this share of its columns is within ±1 of the most common height. */
export const FLAT_SHARE = 0.8;
/** Ice and water are not flattened: an area whose surface is more than this share ice/water is skipped. */
export const MAX_ICE_SHARE = 0.2;
const isIce = (n: string) => n === 'ice' || n.endsWith('_ice');

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
	/** The TNT cell: the column (x, z), at its layer's floor + 1. */
	tnt: Vec3;
	/** The cells to dig first, top-down, so the TNT cell is air on natural ground (as planned: after the layers above). */
	dig: Vec3[];
	/** The cells its filtered blast removes (on the world as planned). */
	removes?: number;
	/** Its layer: 0 blasts at the floor L, k at L + k × FLATTEN_HEIGHT (spots are ordered top layer first). */
	layer?: number;
}
export interface AreaPlan {
	x0: number; z0: number; size: number;
	/** The floor level: every column at or above it ends with its top at L (lower columns are left as they are). */
	L: number;
	/** How many stacked blast layers the plan uses (1 = one TNT per centre, as before terracing). */
	layers?: number;
	spots: BlastSpot[];
	/** Natural cells the blasts would remove (on the world as it is now; overlaps counted once). */
	removes: number;
	/** The same count, by the exact per-cell filter the blast uses, above the floor L (== removes; named for the log). */
	removableFiltered: number;
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

/** The most blast layers stacked on one spot: an area may rise at most MAX_LAYERS × FLATTEN_HEIGHT above its floor. */
export const MAX_LAYERS = 3;
/** The flat footprint a terrace must leave at its floor: a contiguous square of this side (or the whole area, if smaller). */
export const MIN_FOOTPRINT = 12;
/** The percentile of the surface heights a terrace's floor is cut at (when one blast layer cannot level the whole square). */
export const FLOOR_PERCENTILE = 0.3;

/** The key a tried blast spot is remembered by (its TNT cell: layers share a column). */
export const spotKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

/**
 * Plans levelling the square [x0, x0 + size) × [z0, z0 + size). The floor L is the lowest top when one blast layer
 * levels it all (the whole square ends flat); else a terrace: L = the FLOOR_PERCENTILE surface height (then the 15th
 * percentile, then the lowest), with up to MAX_LAYERS stacked blasts per centre, top layer first (TNT at
 * L + 1 + k × FLATTEN_HEIGHT), and the columns below L left as they are. Refused (a string) when: a column has no
 * ground, water lies on it, more than MAX_ICE_SHARE of its surface is ice, it is already flat (FLAT_SHARE of it within
 * ±1), it rises more than MAX_LAYERS × FLATTEN_HEIGHT above every floor ('too steep'), any blast breaks filterBlast (or
 * would leave a bot cell), a hole is not natural, the filtered blasts remove fewer than MIN_AREA_REMOVE cells, or the
 * planned result leaves no MIN_FOOTPRINT square flat at L. A centre whose filtered blast removes fewer than
 * MIN_SPOT_REMOVE cells, whose hole would be deeper than MAX_DIG, whose column is below the layer, or that `skipSpot`
 * rules out (tried before), gets no TNT on that layer. `footprint` (default MIN_FOOTPRINT) is the side of the flat
 * square the plan must leave at L: a board request passes its whole size, so the square ends flat at L all over.
 */
export function evaluateArea(world: WorldView, x0: number, z0: number, size: number, f: Omit<FilterCtx, 'world'>, skipSpot?: (x: number, y: number, z: number) => boolean, footprint = Math.min(MIN_FOOTPRINT, size)): AreaPlan | string {
	let lo = Infinity, hi = -Infinity, ice = 0;
	const tops = new Map<number, number>();
	const all: number[] = [];
	for (let x = x0; x < x0 + size; x++) {
		for (let z = z0; z < z0 + size; z++) {
			const t = terrainTop(world, x, z);
			if (t < 0) return 'no ground';
			lo = Math.min(lo, t);
			hi = Math.max(hi, t);
			all.push(t);
			tops.set(t, (tops.get(t) ?? 0) + 1);
			if (world.isLiquid(world.getBlock(x, t + 1, z))) return 'water';
			if (isIce(world.blockName(world.getBlock(x, t, z)) ?? '')) ice++;
		}
	}
	const cols = size * size;
	if (ice > MAX_ICE_SHARE * cols) return 'ice';
	let flat = 0;
	for (const h of tops.keys()) flat = Math.max(flat, (tops.get(h - 1) ?? 0) + (tops.get(h) ?? 0) + (tops.get(h + 1) ?? 0));
	if (flat >= FLAT_SHARE * cols) return 'already flat';
	all.sort((a, b) => a - b);
	const pct = (p: number) => all[Math.min(all.length - 1, Math.floor(p * all.length))];
	// One layer levels the whole square: the floor is its lowest top (as before terracing). Else terrace floors, highest first.
	const floors = hi - lo <= FLATTEN_HEIGHT + 1 ? [lo] : [...new Set([pct(FLOOR_PERCENTILE), pct(0.15), lo])].filter((L) => hi - L <= MAX_LAYERS * FLATTEN_HEIGHT);
	if (floors.length === 0) return 'too steep';
	let last = 'too little to remove';
	for (const L of floors) {
		const r = planAt(world, x0, z0, size, L, hi, f, skipSpot, footprint);
		if (typeof r !== 'string') return { ...r, range: hi - lo };
		last = r;
		// A safety refusal holds at every floor.
		if (!(r === 'too little to remove' || r === 'no flat footprint')) return r;
	}
	return last;
}

/** The plan at one floor L (see evaluateArea), simulated top layer first on an overlay of the world. */
function planAt(world: WorldView, x0: number, z0: number, size: number, L: number, hi: number, f: Omit<FilterCtx, 'world'>, skipSpot: ((x: number, y: number, z: number) => boolean) | undefined, footprint: number): Omit<AreaPlan, 'range'> | string {
	const gone = new Set<string>();
	const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
	const ov = {
		getBlock: (x: number, y: number, z: number) => (gone.has(key(x, y, z)) ? 0 : world.getBlock(x, y, z)),
		isSolid: (v: number) => world.isSolid(v),
		isLiquid: (v: number) => world.isLiquid(v),
		blockName: (v: number) => world.blockName(v),
	} as unknown as WorldView;
	const bw = blastWorld(ov);
	const layers = Math.max(1, Math.ceil((hi - L - 1) / FLATTEN_HEIGHT));
	const spots: BlastSpot[] = [];
	const seen = new Set<string>();
	let digs = 0;
	for (let k = layers - 1; k >= 0; k--) {
		const base = L + k * FLATTEN_HEIGHT;
		for (const c of spotColumns(x0, z0, size)) {
			if (skipSpot?.(c.x, base + 1, c.z)) continue;
			const top = terrainTop(ov, c.x, c.z);
			if (top < base || top - base > MAX_DIG) continue;
			const dig: Vec3[] = [];
			for (let y = top; y >= base + 1; y--) if (ov.getBlock(c.x, y, c.z) !== 0) dig.push({ x: c.x, y, z: c.z });
			// The TNT sits on the layer's floor: natural, solid.
			if (!ov.isSolid(ov.getBlock(c.x, base, c.z)) || f.classify(c.x, base, c.z) !== 'natural') {
				if (k === 0) return 'no natural floor';
				continue;
			}
			for (const q of dig) if (f.classify(q.x, q.y, q.z) !== 'natural') return 'hole not natural';
			for (const q of dig) gone.add(key(q.x, q.y, q.z));
			const tnt = { x: c.x, y: base + 1, z: c.z };
			const { destroyed } = blastCells(bw, 'flatten_tnt', tnt);
			const undo = () => { for (const q of dig) gone.delete(key(q.x, q.y, q.z)); };
			if (destroyed.some((q) => f.classify(q.x, q.y, q.z) !== 'natural' && !(q.x === tnt.x && q.y === tnt.y && q.z === tnt.z))) return 'a bot or kid cell in the blast';
			const r = filterBlast(destroyed, { ...f, world: ov });
			if (r.dropped) return r.dropped;
			const above = r.remove.filter((q) => q.y > base);
			if (above.length < MIN_SPOT_REMOVE) {
				undo();
				continue;
			}
			digs += dig.length;
			for (const q of above) {
				gone.add(key(q.x, q.y, q.z));
				if (q.y > L) seen.add(key(q.x, q.y, q.z));
			}
			spots.push({ tnt, dig, removes: above.length, layer: k });
		}
	}
	if (seen.size < MIN_AREA_REMOVE) return 'too little to remove';
	if (!hasFlatSquare(ov, x0, z0, size, L, Math.min(footprint, size))) return 'no flat footprint';
	return { x0, z0, size, L, layers: Math.max(1, ...spots.map((s) => (s.layer ?? 0) + 1)), spots, removes: seen.size, removableFiltered: seen.size, digs };
}

/** Whether a contiguous `side` × `side` square of columns in the area has its top exactly at L (after the plan). */
function hasFlatSquare(ov: WorldView, x0: number, z0: number, size: number, L: number, side: number): boolean {
	// 2D prefix sums of "column top == L".
	const n = size + 1;
	const ps = new Array<number>(n * n).fill(0);
	for (let i = 1; i <= size; i++) for (let j = 1; j <= size; j++) {
		const ok = terrainTop(ov, x0 + i - 1, z0 + j - 1) === L ? 1 : 0;
		ps[i * n + j] = ok + ps[(i - 1) * n + j] + ps[i * n + j - 1] - ps[(i - 1) * n + j - 1];
	}
	for (let i = side; i <= size; i++) for (let j = side; j <= size; j++) {
		if (ps[i * n + j] - ps[(i - side) * n + j] - ps[i * n + j - side] + ps[(i - side) * n + j - side] === side * side) return true;
	}
	return false;
}

/** How good a plan is: hilly but not a mountain, little digging, close to the anchor. Higher is better. */
export function scoreArea(p: AreaPlan, anchor: { x: number; z: number }): number {
	const d = Math.hypot(p.x0 + p.size / 2 - anchor.x, p.z0 + p.size / 2 - anchor.z);
	return Math.min(p.range, 6) * 10 - p.removes / 100 - p.digs * 2 - d / 4 - ((p.layers ?? 1) - 1) * 15;
}
