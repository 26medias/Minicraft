import type { World } from '../engine/world/world';
import { AIR, BLOCKS, BLOCK_BY_NAME, isSolid, type BlockId } from '../data/blocks.data';
import type { DetonationResult, TunnelDir } from './tnt';

/**
 * Toys spec §4: pure blast shapes and the dispatch that applies the shared rules (§2). Nothing here mutates the world:
 * GameLoop.detonateAt removes `destroyed`, primes `primed`, and places `build` / `water`.
 */

export type Cell = { x: number; y: number; z: number };
export type BlastShape = 'sphere' | 'tunnel' | 'flatten' | 'lake' | 'dome' | 'firework';
export type PlayerBox = { min: [number, number, number]; max: [number, number, number] };
export type BlastOpts = { shape?: BlastShape; dir?: TunnelDir; player?: PlayerBox };
export type BlastResult = DetonationResult & { build?: { cells: Cell[]; blockId: BlockId }; water?: Cell[]; effect?: 'firework' };

/** Spec §3.4: 3 wide, 3 tall, 24 long. */
export const TUNNEL_LENGTH = 24;
/** Spec §3.6: the cylinder reaches from the TNT's y to y + 12. */
export const FLATTEN_HEIGHT = 12;
/** Spec §3.7: rim columns are round(hypot(dx, dz)) == LAKE_RING; each is scanned down LAKE_SCAN from the TNT's y; at most LAKE_MAX_LAYERS of water. */
export const LAKE_RING = 5;
export const LAKE_SCAN = 8;
export const LAKE_MAX_LAYERS = 4;
/** Player collision box (player.ts SIZE): 0.6 wide, 1.8 tall, feet at position[1]. */
const PLAYER_HALF_WIDTH = 0.3;
const PLAYER_HEIGHT = 1.8;
const GLASS = BLOCK_BY_NAME['glass'].id;

/** The player's collision box at `position` (feet centre). */
export function playerBox(position: readonly [number, number, number]): PlayerBox {
	const [x, y, z] = position;
	return { min: [x - PLAYER_HALF_WIDTH, y, z - PLAYER_HALF_WIDTH], max: [x + PLAYER_HALF_WIDTH, y + PLAYER_HEIGHT, z + PLAYER_HALF_WIDTH] };
}

/** Does block cell (x, y, z) overlap the box? Strict, as actions.ts' placement test: touching faces do not overlap. */
export function cellInBox(x: number, y: number, z: number, box: PlayerBox): boolean {
	return x < box.max[0] && x + 1 > box.min[0] && y < box.max[1] && y + 1 > box.min[1] && z < box.max[2] && z + 1 > box.min[2];
}

/** Today's sphere, in today's order (dy, then dz, then dx), without the origin. Callers filter bounds. */
export function sphereCells(ox: number, oy: number, oz: number, radius: number): Cell[] {
	const out: Cell[] = [];
	const radiusSq = radius * radius;
	for (let dy = -radius; dy <= radius; dy++) {
		for (let dz = -radius; dz <= radius; dz++) {
			for (let dx = -radius; dx <= radius; dx++) {
				if (dx === 0 && dy === 0 && dz === 0) continue;
				if (dx * dx + dy * dy + dz * dz > radiusSq) continue;
				out.push({ x: ox + dx, y: oy + dy, z: oz + dz });
			}
		}
	}
	return out;
}

/** Spec §3.4: centred on the TNT's column, floor at its y, TUNNEL_LENGTH long from its own cell along `dir`. Includes the origin. */
export function tunnelCells(ox: number, oy: number, oz: number, dir: TunnelDir): Cell[] {
	const [ax, az] = dir === 'px' ? [1, 0] : dir === 'nx' ? [-1, 0] : dir === 'pz' ? [0, 1] : [0, -1];
	const out: Cell[] = [];
	for (let l = 0; l < TUNNEL_LENGTH; l++) {
		for (let dy = 0; dy <= 2; dy++) {
			for (let w = -1; w <= 1; w++) {
				// The width runs across the length: along z for an x tunnel, along x for a z tunnel.
				out.push({ x: ox + ax * l + az * w, y: oy + dy, z: oz + az * l + ax * w });
			}
		}
	}
	return out;
}

/** Spec §3.6: dx² + dz² ≤ radius², y from the TNT's y to y + FLATTEN_HEIGHT. Includes the origin. */
export function flattenCells(ox: number, oy: number, oz: number, radius: number): Cell[] {
	const out: Cell[] = [];
	const radiusSq = radius * radius;
	for (let dy = 0; dy <= FLATTEN_HEIGHT; dy++) {
		for (let dz = -radius; dz <= radius; dz++) {
			for (let dx = -radius; dx <= radius; dx++) {
				if (dx * dx + dz * dz <= radiusSq) out.push({ x: ox + dx, y: oy + dy, z: oz + dz });
			}
		}
	}
	return out;
}

/**
 * Spec §3.5: the AIR cells of the shell (radius − 0.5)² < d² ≤ (radius + 0.5)², minus any cell the player's box overlaps.
 * Never a solid block or a liquid, and never the origin.
 */
export function domeCells(world: World, ox: number, oy: number, oz: number, radius: number, player?: PlayerBox): Cell[] {
	const lo = (radius - 0.5) ** 2, hi = (radius + 0.5) ** 2, r = Math.ceil(radius + 0.5);
	const out: Cell[] = [];
	for (let dy = -r; dy <= r; dy++) {
		for (let dz = -r; dz <= r; dz++) {
			for (let dx = -r; dx <= r; dx++) {
				const d2 = dx * dx + dy * dy + dz * dz;
				if (d2 <= lo || d2 > hi) continue;
				const x = ox + dx, y = oy + dy, z = oz + dz;
				if (!world.inBounds(x, y, z) || world.getBlock(x, y, z) !== AIR) continue;
				if (player && cellInBox(x, y, z, player)) continue;
				out.push({ x, y, z });
			}
		}
	}
	return out;
}

/**
 * Spec §3.7, the water of a Lake TNT whose crater is `destroyed` (read on the world BEFORE the blast is applied).
 * - rimY = min over ring columns of the highest solid block in [oy − LAKE_SCAN, oy], minus 1. No ring column with a
 *   solid block (floating ground): no water.
 * - Candidates: destroyed cells with rimY − LAKE_MAX_LAYERS < y ≤ rimY.
 * - Erode to stability: drop a candidate whose cell below or any horizontal neighbour is neither a candidate nor solid
 *   after the blast (a destroyed cell is air). So water never touches an open side or an open floor.
 * Returned in `destroyed` order.
 */
export function lakeWater(world: World, ox: number, oy: number, oz: number, destroyed: readonly Cell[]): Cell[] {
	let rimTop = Infinity;
	for (let dz = -LAKE_RING; dz <= LAKE_RING; dz++) {
		for (let dx = -LAKE_RING; dx <= LAKE_RING; dx++) {
			if (Math.round(Math.hypot(dx, dz)) !== LAKE_RING) continue;
			for (let y = oy; y >= oy - LAKE_SCAN; y--) {
				if (!world.inBounds(ox + dx, y, oz + dz)) break;
				if (isSolid(world.getBlock(ox + dx, y, oz + dz))) {
					rimTop = Math.min(rimTop, y);
					break;
				}
			}
		}
	}
	if (rimTop === Infinity) return [];
	const rimY = rimTop - 1;
	const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
	const gone = new Set(destroyed.map((c) => key(c.x, c.y, c.z)));
	const cand = new Map<string, Cell>();
	for (const c of destroyed) if (c.y <= rimY && c.y > rimY - LAKE_MAX_LAYERS) cand.set(key(c.x, c.y, c.z), c);
	const holds = (x: number, y: number, z: number): boolean => {
		const k = key(x, y, z);
		if (cand.has(k)) return true;
		return world.inBounds(x, y, z) && !gone.has(k) && isSolid(world.getBlock(x, y, z));
	};
	for (let changed = true; changed;) {
		changed = false;
		for (const [k, { x, y, z }] of cand) {
			if (holds(x, y - 1, z) && holds(x + 1, y, z) && holds(x - 1, y, z) && holds(x, y, z + 1) && holds(x, y, z - 1)) continue;
			cand.delete(k);
			changed = true;
		}
	}
	return destroyed.filter((c) => cand.has(key(c.x, c.y, c.z)));
}

/** Spec §3.4, chained: the dominant horizontal axis of (TNT − blast origin). A tie goes to x; straight above or below is 'px'. */
export function chainDir(dx: number, dz: number): TunnelDir {
	if (dx === 0 && dz === 0) return 'px';
	if (Math.abs(dx) >= Math.abs(dz)) return dx > 0 ? 'px' : 'nx';
	return dz > 0 ? 'pz' : 'nz';
}

/** Spec §3.4, lit: the player's yaw snapped to ±x or ±z. Forward is FpCamera.getForward: (−sin yaw, 0, −cos yaw). */
export function yawDir(yaw: number): TunnelDir {
	const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
	if (Math.abs(fx) >= Math.abs(fz)) return fx > 0 ? 'px' : 'nx';
	return fz > 0 ? 'pz' : 'nz';
}

/**
 * Spec §4 dispatch. `radius` is the one fixed when the TNT was primed. The shared rules (§2) live here, not in the shapes:
 * - origin: the detonating TNT's own cell is removed first when solid, and never goes through the chain rule;
 * - chain: a TNT-kind cell in a removing shape (sphere, tunnel, flatten, lake) is primed (unless already primed) with its own radius, never removed.
 *   A chained Tunnel also gets `dir` from chainDir(TNT − origin).
 * Everything else solid with hardness > 0 is removed, in the shape's cell order.
 */
export function detonate(
	world: World,
	ox: number,
	oy: number,
	oz: number,
	alreadyPrimed: (x: number, y: number, z: number) => boolean,
	radius: number,
	opts: BlastOpts = {},
): BlastResult {
	const shape = opts.shape ?? 'sphere';
	const destroyed: BlastResult['destroyed'] = [];
	const primed: BlastResult['primed'] = [];
	if (world.inBounds(ox, oy, oz) && isSolid(world.getBlock(ox, oy, oz))) destroyed.push({ x: ox, y: oy, z: oz });
	// Dome and firework remove nothing but their own cell and prime nothing (spec §2).
	if (shape === 'firework') return { destroyed, primed, effect: 'firework' };
	if (shape === 'dome') return { destroyed, primed, build: { cells: domeCells(world, ox, oy, oz, radius, opts.player), blockId: GLASS } };

	const cells = shape === 'tunnel' ? tunnelCells(ox, oy, oz, opts.dir ?? 'px')
		: shape === 'flatten' ? flattenCells(ox, oy, oz, radius)
		: sphereCells(ox, oy, oz, radius);
	for (const { x, y, z } of cells) {
		if (x === ox && y === oy && z === oz) continue;
		if (!world.inBounds(x, y, z)) continue;
		const id = world.getBlock(x, y, z);
		const spec = BLOCKS[id]?.tnt;
		if (spec) {
			if (alreadyPrimed(x, y, z)) continue;
			const p: BlastResult['primed'][number] = { x, y, z, radius: spec.radius, blockId: id };
			if (spec.shape === 'tunnel') p.dir = chainDir(x - ox, z - oz);
			primed.push(p);
		} else if (isSolid(id) && (BLOCKS[id]?.hardness ?? 0) > 0) {
			destroyed.push({ x, y, z });
		}
	}
	// Lake: the crater is today's sphere at the lake's radius; the water is computed from it.
	if (shape === 'lake') return { destroyed, primed, water: lakeWater(world, ox, oy, oz, destroyed) };
	return { destroyed, primed };
}
