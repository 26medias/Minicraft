import type { World } from '../engine/world/world';
import { BLOCK_BY_NAME, isSolid } from '../data/blocks.data';
import { inBounds } from '../engine/world/coords';

export const TNT_RADIUS = 3;
export const TNT_PRIME_FUSE = 2.5;  // seconds — kid-ignited fuse
export const TNT_CHAIN_FUSE = 0.1;  // seconds — chain-reaction propagation delay

const TNT_RADIUS_SQ = TNT_RADIUS * TNT_RADIUS;

/** Coord-map key used by the primed-TNT registry and overlay renderer. */
export function tntKey(x: number, y: number, z: number): string {
	return `${x},${y},${z}`;
}

export type DetonationResult = {
	destroyed: Array<[number, number, number]>;
	primed: Array<[number, number, number]>;
};

/**
 * Compute the intended world mutations for a TNT detonation at (ox, oy, oz).
 * Does NOT mutate the world — the caller applies setBlock on each destroyed
 * coord and adds each primed coord to its registry.
 */
export function detonate(
	world: World,
	ox: number,
	oy: number,
	oz: number,
	alreadyPrimed: (x: number, y: number, z: number) => boolean,
): DetonationResult {
	const tntId = BLOCK_BY_NAME['tnt'].id;
	const destroyed: Array<[number, number, number]> = [];
	const primed: Array<[number, number, number]> = [];

	if (inBounds(ox, oy, oz) && isSolid(world.getBlock(ox, oy, oz))) {
		destroyed.push([ox, oy, oz]);
	}

	for (let dy = -TNT_RADIUS; dy <= TNT_RADIUS; dy++) {
		for (let dx = -TNT_RADIUS; dx <= TNT_RADIUS; dx++) {
			for (let dz = -TNT_RADIUS; dz <= TNT_RADIUS; dz++) {
				if (dx === 0 && dy === 0 && dz === 0) continue;
				if (dx * dx + dy * dy + dz * dz > TNT_RADIUS_SQ) continue;
				const x = ox + dx;
				const y = oy + dy;
				const z = oz + dz;
				if (!inBounds(x, y, z)) continue;

				const id = world.getBlock(x, y, z);
				if (id === tntId) {
					if (!alreadyPrimed(x, y, z)) primed.push([x, y, z]);
				} else if (isSolid(id)) {
					destroyed.push([x, y, z]);
				}
			}
		}
	}

	return { destroyed, primed };
}
