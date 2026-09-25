import { BLOCKS, isSolid, type Face } from '../data/blocks.data';
import { AREA_FLOOR_ARMED, AREA_FLOOR_HELD, PICKAXES, type PickaxeDef, type PickaxeTier, type PlayerTools } from '../data/crafting.data';

/** Pickaxe rules (spec §5). Pure. */

export type Cell = { x: number; y: number; z: number };
export type Vec3 = [number, number, number];
export type AreaBounds = { min: Vec3; max: Vec3 };

const NORMAL: Readonly<Record<Face, Vec3>> = {
	px: [1, 0, 0], nx: [-1, 0, 0], py: [0, 1, 0], ny: [0, -1, 0], pz: [0, 0, 1], nz: [0, 0, -1],
};
/** [normal axis, first face-plane axis, second face-plane axis]. */
const AXES: Readonly<Record<Face, [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2]>> = {
	px: [0, 1, 2], nx: [0, 1, 2], py: [1, 0, 2], ny: [1, 0, 2], pz: [2, 0, 1], nz: [2, 0, 1],
};
const FACES: readonly Face[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

/** True for exactly the six face strings — validates a face string that crossed the network. */
export function isFace(s: string | undefined): s is Face {
	return s !== undefined && (FACES as readonly string[]).includes(s);
}

/** An unknown tier (a newer save on an older bundle) mines like the hand. */
function def(tier: number): PickaxeDef {
	return PICKAXES[tier] ?? PICKAXES[0];
}

/**
 * removeBlocks' rule for one cell, by block id alone: −1 (out of bounds, or — for a multiplayer
 * receiver — a chunk not loaded) is never removable, and neither is air or hardness 0 (bedrock).
 * Shared by loop.ts's `removableCells` (the local highlight/mining) and crack.ts's `RemoteMining`
 * (a friend's area cracks, read through the receiver's own world), so the rule lives in one place.
 */
export function isRemovableId(id: number): boolean {
	return id >= 0 && isSolid(id) && (BLOCKS[id]?.hardness ?? 0) > 0;
}

/** The cells of `cells` that removeBlocks would actually remove, reading each one through `getBlock`. */
export function removableCellsBy(getBlock: (x: number, y: number, z: number) => number, cells: ReadonlyArray<Cell>): Cell[] {
	return cells.filter((c) => isRemovableId(getBlock(c.x, c.y, c.z)));
}

/**
 * Every cell of the area, air included (the caller's removeBlocks skips what cannot go). The w × h
 * face plane is centred on the target; depth runs from the target along −normal, away from the
 * player, `d` cells including the target. Order: depth layer, then first plane axis, then second.
 */
export function areaCells(target: Cell, face: Face, tier: PickaxeTier): Cell[] {
	const { w, h, d } = def(tier).area;
	const n = NORMAL[face];
	const [, u, v] = AXES[face];
	const out: Cell[] = [];
	for (let k = 0; k < d; k++) for (let i = -((w - 1) >> 1); i <= w >> 1; i++) for (let j = -((h - 1) >> 1); j <= h >> 1; j++) {
		const p: Vec3 = [target.x - n[0] * k, target.y - n[1] * k, target.z - n[2] * k];
		p[u] += i;
		p[v] += j;
		out.push({ x: p[0], y: p[1], z: p[2] });
	}
	return out;
}

/** Inclusive integer corners of areaCells' shape (the highlight box). */
export function areaBounds(target: Cell, face: Face, tier: PickaxeTier): AreaBounds {
	const { w, h, d } = def(tier).area;
	const n = NORMAL[face];
	const [a, u, v] = AXES[face];
	const t: Vec3 = [target.x, target.y, target.z];
	const min: Vec3 = [...t], max: Vec3 = [...t];
	min[u] -= (w - 1) >> 1; max[u] += w >> 1;
	min[v] -= (h - 1) >> 1; max[v] += h >> 1;
	const far = t[a] - n[a] * (d - 1);
	min[a] = Math.min(t[a], far);
	max[a] = Math.max(t[a], far);
	return { min, max };
}

/** Spec §5 "multi-block tier": the tier's area is larger than one cell, whatever the aimed spot holds. */
export function isMultiBlock(tier: PickaxeTier): boolean {
	const { w, h, d } = def(tier).area;
	return w * h * d > 1;
}

/**
 * Held-floor zone of a previous area break: its box grown by one layer further along −normal, so
 * the next swing into the same tunnel is "inside the previous area" (spec §5, §8 held swings along
 * a tunnel), and an aim that slides sideways or skips a layer is not.
 */
export function inHeldZone(prev: AreaBounds & { face: Face }, p: Cell): boolean {
	const n = NORMAL[prev.face];
	const min: Vec3 = [...prev.min], max: Vec3 = [...prev.max];
	for (let i = 0; i < 3; i++) {
		if (n[i] > 0) min[i] -= 1;
		else if (n[i] < 0) max[i] += 1;
	}
	return p.x >= min[0] && p.x <= max[0] && p.y >= min[1] && p.y <= max[1] && p.z >= min[2] && p.z <= max[2];
}

/**
 * Seconds to break the aimed block: hardness / (1 + bonus). A multi-block tier is raised to at
 * least 0.4 s ('armed') or 0.25 s ('held'); single-cell tiers never get a floor.
 */
export function miningDuration(hardness: number, tier: PickaxeTier, floor: 'armed' | 'held' | 'none'): number {
	const base = hardness / (1 + def(tier).bonus);
	if (floor === 'none' || !isMultiBlock(tier)) return base;
	return Math.max(base, floor === 'armed' ? AREA_FLOOR_ARMED : AREA_FLOOR_HELD);
}

/** P: the next owned tier above the equipped one, wrapping to the lowest. */
export function nextOwnedTier(tools: PlayerTools): number {
	const owned = [...new Set(tools.owned)].filter((t) => PICKAXES[t] !== undefined).sort((a, b) => a - b);
	if (owned.length === 0) return 0;
	return owned.find((t) => t > tools.equipped) ?? owned[0];
}
