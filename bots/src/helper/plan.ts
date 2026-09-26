/**
 * The helper bot's pure planning (experiment E5): which kid placements mean "he is building", the palette copied from
 * his blocks, a template turned to face him, and the site rule: every column of the helper's footprint 4–8 blocks from
 * his cells (never within 3 of any kid cell), clear of his body buffer, on roughly flat ground, every cell still air.
 */
import { CRAFTED_ONLY, blockId, isLiquidId, isSolidId } from 'minicraft-bot';
import type { WorldView } from '../port.js';
import type { Vec3 } from '../types.js';
import { boxMeetsKids, groundTop } from '../brain2/behaviours/site-search.js';
import { templateOf, type Role, type Template } from '../brain2/behaviours/templates.data.js';
import type { Palette } from '../builder/palettes.data.js';

export interface KidPlacement { cell: Vec3; block: string; kid: string; t: number }

/** The model's choices (the user's wording) → a template; 'statue' picks one of the statues. */
export const HELP_CHOICES: Record<string, string> = {
	'matching-tower': 'a matching tower',
	wall: 'a wall',
	statue: 'a statue',
	'little-house': 'a little house',
};
const STATUES = ['creeper', 'person', 'heart'];

export function helpTemplate(choice: string, rng: () => number): Template {
	if (choice === 'matching-tower') return templateOf('tower', 'small');
	if (choice === 'wall') return templateOf('wall', 'small');
	if (choice === 'little-house') return templateOf('house', 'small');
	return templateOf(STATUES[Math.floor(rng() * STATUES.length) % STATUES.length], 'small');
}

/** Placements within this window count as "building now". */
export const BUILDING_WINDOW_MS = 60_000;
/** …when at least this many, each within this distance of the kid's current position. */
export const BUILDING_MIN = 3;
export const BUILDING_NEAR = 32;
/** His build: his placements within this distance of his latest one. */
export const CLUSTER_RADIUS = 16;
export const MIN_GAP = 4;
export const MAX_GAP = 8;
/** Never within this distance of any kid cell (the stricter MIN_GAP is what the search asks for). */
export const NEVER_WITHIN = 3;

/**
 * The kid who is building now, and his build (cells and blocks), or null. `placements`: the kids' placements seen this
 * session (oldest first); `kids`: where each kid stands now.
 */
export function kidBuilding(placements: readonly KidPlacement[], kids: ReadonlyArray<{ name: string; x: number; y: number; z: number }>, now: number, since = -Infinity): { kid: string; cells: KidPlacement[] } | null {
	let best: { kid: string; cells: KidPlacement[]; n: number } | null = null;
	for (const k of kids) {
		const recent = placements.filter((p) => p.kid === k.name && p.t > since && now - p.t <= BUILDING_WINDOW_MS && Math.hypot(p.cell.x + 0.5 - k.x, p.cell.z + 0.5 - k.z) <= BUILDING_NEAR);
		if (recent.length < BUILDING_MIN) continue;
		const last = recent[recent.length - 1].cell;
		const cells = placements.filter((p) => p.kid === k.name && Math.hypot(p.cell.x - last.x, p.cell.z - last.z) <= CLUSTER_RADIUS).slice(-128);
		if (!best || recent.length > best.n) best = { kid: k.name, cells, n: recent.length };
	}
	return best ? { kid: best.kid, cells: best.cells } : null;
}

/** A block the helper may copy: real, solid, not liquid, not TNT, nothing that falls, not crafted-only. */
export function copyable(name: string): boolean {
	const id = blockId(name);
	if (id === null || !isSolidId(id) || isLiquidId(id)) return false;
	if (name.includes('tnt') || name === 'sand' || name === 'red_sand' || name === 'gravel' || name.endsWith('concrete_powder')) return false;
	return !CRAFTED_ONLY.includes(name);
}

/** His palette: his blocks by count (most used first) → wall, roof, floor, accent; null when none is copyable. */
export function kidPalette(blocks: readonly string[]): Palette | null {
	const n = new Map<string, number>();
	for (const b of blocks) if (copyable(b)) n.set(b, (n.get(b) ?? 0) + 1);
	const by = [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([b]) => b);
	if (by.length === 0) return null;
	const at = (i: number) => by[i] ?? by[0];
	const blocksByRole: Record<Role, string> = { wall: at(0), roof: at(1), floor: at(2), accent: at(1) };
	return { name: `like ${by.slice(0, 3).join(', ')}`, blocks: blocksByRole };
}

/**
 * The template turned by `r` quarter turns. Its front (the door row, template z = d − 1) then faces: r0 +z, r1 −x,
 * r2 −z, r3 +x.
 */
export function rotate(t: Template, r: 0 | 1 | 2 | 3): Template {
	const map = (x: number, z: number): [number, number] =>
		r === 0 ? [x, z] : r === 1 ? [t.d - 1 - z, x] : r === 2 ? [t.w - 1 - x, t.d - 1 - z] : [z, t.w - 1 - x];
	const odd = r % 2 === 1;
	return {
		...t, w: odd ? t.d : t.w, d: odd ? t.w : t.d,
		cells: t.cells.map((c) => {
			const [x, z] = map(c.x, c.z);
			return { ...c, x, z };
		}),
		doorGaps: t.doorGaps.map((c) => {
			const [x, z] = map(c.x, c.z);
			return { ...c, x, z };
		}),
	};
}

/** The quarter turn whose front faces from `from` toward `to`. */
export function facing(from: { x: number; z: number }, to: { x: number; z: number }): 0 | 1 | 2 | 3 {
	const dx = to.x - from.x, dz = to.z - from.z;
	if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 3 : 1;
	return dz >= 0 ? 0 : 2;
}

export interface HelperSite { origin: Vec3; rot: 0 | 1 | 2 | 3; template: Template; minGap: number }
export interface SiteInput {
	world: WorldView; template: Template; kidCells: readonly Vec3[];
	/** Any kid cell (not only this build's) within r of column (x, z): Ownership.kidCellWithin. */
	kidCellWithin: (x: number, z: number, r: number) => boolean;
	kids: readonly Vec3[];
	/** Boxes to keep clear of (the helper's earlier builds), inclusive. */
	avoid?: ReadonlyArray<{ min: Vec3; max: Vec3 }>;
}

/** The smallest horizontal distance from column (x, z) to any of the cells. */
const gapTo = (x: number, z: number, cells: readonly Vec3[]) => cells.reduce((m, c) => Math.min(m, Math.hypot(c.x - x, c.z - z)), Infinity);

/**
 * The best site: every footprint column ≥ MIN_GAP from his cells (and no kid cell at all within NEVER_WITHIN), the
 * nearest column ≤ MAX_GAP, facing his build, out of his body buffer, ground within 1, every cell air. Prefers a gap of
 * 5, then the site nearest his build. Null when none.
 */
export function helperSite(q: SiteInput): HelperSite | null {
	if (q.kidCells.length === 0) return null;
	const xs = q.kidCells.map((c) => c.x), zs = q.kidCells.map((c) => c.z);
	const centre = { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2 };
	let best: (HelperSite & { score: number }) | null = null;
	const reach = MAX_GAP + 12;
	for (const r of [0, 1, 2, 3] as const) {
		const t = rotate(q.template, r);
		for (let ox = Math.min(...xs) - reach; ox <= Math.max(...xs) + reach; ox++) {
			for (let oz = Math.min(...zs) - reach; oz <= Math.max(...zs) + reach; oz++) {
				const fc = { x: ox + t.w / 2, z: oz + t.d / 2 };
				if (facing(fc, centre) !== r) continue;
				let min = Infinity;
				for (let x = ox; x < ox + t.w && min >= MIN_GAP; x++) for (let z = oz; z < oz + t.d; z++) min = Math.min(min, gapTo(x, z, q.kidCells));
				if (min < MIN_GAP || min > MAX_GAP) continue;
				const score = Math.abs(min - 5) + 0.1 * Math.hypot(fc.x - centre.x, fc.z - centre.z);
				if (best && score >= best.score) continue;
				if (boxMeetsKids(ox, ox + t.w - 1, oz, oz + t.d - 1, q.kids)) continue;
				if (q.avoid?.some((b) => ox <= b.max.x + 1 && ox + t.w - 1 >= b.min.x - 1 && oz <= b.max.z + 1 && oz + t.d - 1 >= b.min.z - 1)) continue;
				let clear = true;
				// The builder's move loop abandons a build with a kid cell within max(w, d)/2 + 1 of its centre.
				if (q.kidCellWithin(fc.x, fc.z, Math.max(t.w, t.d) / 2 + 1)) continue;
				let lo = Infinity, hi = -Infinity;
				for (let x = ox; x < ox + t.w && clear; x++) {
					for (let z = oz; z < oz + t.d && clear; z++) {
						if (q.kidCellWithin(x, z, MIN_GAP - 0.5)) clear = false;
						const g = groundTop(q.world, x, z);
						if (g < 0) clear = false;
						lo = Math.min(lo, g);
						hi = Math.max(hi, g);
					}
				}
				if (!clear || hi - lo > 1) continue;
				const origin = { x: ox, y: hi + 1, z: oz };
				if (t.cells.some((c) => q.world.getBlock(origin.x + c.x, origin.y + c.y, origin.z + c.z) !== 0)) continue;
				best = { origin, rot: r, template: t, minGap: min, score };
			}
		}
	}
	if (!best) return null;
	return { origin: best.origin, rot: best.rot, template: best.template, minGap: best.minGap };
}
