/**
 * The landscaper's area search, sliced so it never starves the bot's socket: candidate squares on an 8-block grid,
 * ring by ring (SEARCH_RADII), each planned by evaluateAreaSteps a few columns or one blast at a time, yielding to the
 * event loop whenever a slice has used its budget (Slicer). Column tops come from a ColumnTops cache shared across
 * searches; kid cells are gathered per candidate (only the chunks around that square, cached per chunk for the search),
 * never for the whole search box: a wide box holds thousands of kid cells, and filtering every blast against all of
 * them made one candidate cost hundreds of milliseconds.
 */
import type { WorldView } from '../port.js';
import type { Vec3 } from '../types.js';
import { Slicer, drive } from '../shared/slice.js';
import { ColumnTops, evaluateAreaSteps, KID_CELL_DIST, scoreArea, type AreaPlan, type CellClass } from './blast-plan.js';

/** Candidate squares: centres on an 8-block grid, within each radius of the anchor in turn (the search widens only when a ring finds nothing). */
export const SEARCH_RADII = [32, 64, 96, 128];
/** No candidate square's centre is nearer world spawn than this. */
export const SPAWN_CLEAR = 16;
/** Kid cells within this of a candidate square are its filter's (a blast reaches 6 past its centre, plus KID_CELL_DIST). */
const KID_MARGIN = KID_CELL_DIST + 8;

export interface AreaSearchCtx {
	world: WorldView;
	classify(x: number, y: number, z: number): CellClass;
	tops: ColumnTops;
	spawn: Vec3;
	kids: readonly Vec3[];
	/** Squares not to overlap (active areas, recently tried ones). */
	busy: ReadonlyArray<{ x0: number; z0: number; size: number }>;
	skipSpot?: (x: number, y: number, z: number) => boolean;
	alive: () => boolean;
	slicer?: Slicer;
	radii?: readonly number[];
}
export interface AreaSearchResult { found: AreaPlan[]; radius: number; rejections: Record<string, number>; candidates: number }

/** The candidate squares of side `size` around `a`, best first: the nearest ring that has any. `req`: a board request's side (see landscaper). */
export async function searchAreas(c: AreaSearchCtx, a: { x: number; z: number }, size: number, req?: number): Promise<AreaSearchResult> {
	const slicer = c.slicer ?? new Slicer();
	const kidChunks = new Map<string, Vec3[]>();
	const kidChunk = (cx: number, cz: number): Vec3[] => {
		const k = `${cx},${cz}`;
		let v = kidChunks.get(k);
		if (!v) {
			v = [];
			for (const [x, y, z] of c.world.editedCellsInChunk(cx, cz)) if (c.classify(x, y, z) === 'kid') v.push({ x, y, z });
			kidChunks.set(k, v);
		}
		return v;
	};
	const kidCellsFor = (x0: number, z0: number): Vec3[] => {
		const out: Vec3[] = [];
		for (let cx = Math.floor((x0 - KID_MARGIN) / 16); cx <= Math.floor((x0 + size + KID_MARGIN) / 16); cx++) {
			for (let cz = Math.floor((z0 - KID_MARGIN) / 16); cz <= Math.floor((z0 + size + KID_MARGIN) / 16); cz++) out.push(...kidChunk(cx, cz));
		}
		return out;
	};
	const tops = (x: number, z: number) => c.tops.get(x, z);
	const out: AreaPlan[] = [];
	const rejections: Record<string, number> = {};
	let inner = -1, radius = 0, n = 0;
	for (const R of c.radii ?? SEARCH_RADII) {
		radius = R;
		for (let dx = -R; dx <= R; dx += 8) {
			for (let dz = -R; dz <= R; dz += 8) {
				if (!c.alive()) return { found: [], radius, rejections, candidates: n };
				const d = Math.hypot(dx, dz);
				if (d > R || d <= inner) continue;
				const cx = Math.floor(a.x) + dx, cz = Math.floor(a.z) + dz;
				const x0 = cx - Math.floor(size / 2), z0 = cz - Math.floor(size / 2);
				const nearSpawn = req
					? Math.hypot(Math.max(x0 - c.spawn.x, 0, c.spawn.x - (x0 + size - 1)), Math.max(z0 - c.spawn.z, 0, c.spawn.z - (z0 + size - 1))) < SPAWN_CLEAR
					: Math.hypot(cx - c.spawn.x, cz - c.spawn.z) < SPAWN_CLEAR;
				if (nearSpawn) {
					rejections['near spawn'] = (rejections['near spawn'] ?? 0) + 1;
					continue;
				}
				if (c.busy.some((b) => x0 < b.x0 + b.size + 4 && x0 + size + 4 > b.x0 && z0 < b.z0 + b.size + 4 && z0 + size + 4 > b.z0)) continue;
				n++;
				const kidCells = kidCellsFor(x0, z0);
				await slicer.due();
				const r = await drive(evaluateAreaSteps(c.world, x0, z0, size, { classify: c.classify, kidCells, kids: c.kids, tops }, c.skipSpot, req), slicer, c.alive);
				if (r === null) return { found: [], radius, rejections, candidates: n };
				if (typeof r === 'string') rejections[r] = (rejections[r] ?? 0) + 1;
				else out.push(r);
				await slicer.due();
			}
		}
		inner = R;
		if (out.length) break;
	}
	out.sort((p, q) => scoreArea(q, a) - scoreArea(p, a));
	return { found: out, radius, rejections, candidates: n };
}
