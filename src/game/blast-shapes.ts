import type { World } from '../engine/world/world';
import { BLOCKS, isSolid, type BlockId } from '../data/blocks.data';
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
 * - chain: a TNT-kind cell in a removing shape is primed (unless already primed) with its own radius, never removed.
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
	return { destroyed, primed };
}
