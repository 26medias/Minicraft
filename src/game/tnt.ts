import type { World } from '../engine/world/world';
import { BLOCK_BY_NAME, BLOCKS, isSolid, type BlockId } from '../data/blocks.data';

/** Plain TNT's values, read from its row so the data stays the single source (spec §6). */
export const TNT_RADIUS = BLOCK_BY_NAME['tnt'].tnt!.radius;      // 3
export const TNT_PRIME_FUSE = BLOCK_BY_NAME['tnt'].tnt!.fuse;    // 2.5 s — kid-ignited fuse
export const TNT_CHAIN_FUSE = 0.1;  // seconds — chain-reaction propagation delay, every tier

/** Radius and fuse of a TNT block, or null for anything else. "Is TNT" everywhere is `tntSpec(id) !== null`. */
export function tntSpec(id: BlockId): { radius: number; fuse: number } | null {
	return BLOCKS[id]?.tnt ?? null;
}

/** Coord-map key used by the primed-TNT registry and overlay renderer. */
export function tntKey(x: number, y: number, z: number): string {
	return `${x},${y},${z}`;
}

export type DetonationResult = {
	destroyed: Array<{ x: number; y: number; z: number }>;
	/** Newly primed by this blast; `radius` and `blockId` are read NOW, at priming, and never again. */
	primed: Array<{ x: number; y: number; z: number; radius: number; blockId: BlockId }>;
};

/**
 * Compute the intended world mutations for a TNT detonation at (ox, oy, oz) with the
 * radius fixed when that TNT was primed. Does NOT mutate the world — the caller removes
 * each destroyed coord and adds each primed coord to its registry.
 */
export function detonate(
	world: World,
	ox: number,
	oy: number,
	oz: number,
	radius: number,
	alreadyPrimed: (x: number, y: number, z: number) => boolean,
): DetonationResult {
	const destroyed: DetonationResult['destroyed'] = [];
	const primed: DetonationResult['primed'] = [];
	const radiusSq = radius * radius;

	if (world.inBounds(ox, oy, oz) && isSolid(world.getBlock(ox, oy, oz))) {
		destroyed.push({ x: ox, y: oy, z: oz });
	}

	for (let dy = -radius; dy <= radius; dy++) {
		for (let dz = -radius; dz <= radius; dz++) {
			for (let dx = -radius; dx <= radius; dx++) {
				if (dx === 0 && dy === 0 && dz === 0) continue;
				if (dx * dx + dy * dy + dz * dz > radiusSq) continue;
				const x = ox + dx;
				const y = oy + dy;
				const z = oz + dz;
				if (!world.inBounds(x, y, z)) continue;

				const id = world.getBlock(x, y, z);
				const spec = tntSpec(id);
				if (spec) {
					if (!alreadyPrimed(x, y, z)) primed.push({ x, y, z, radius: spec.radius, blockId: id });
				} else if (isSolid(id) && (BLOCKS[id]?.hardness ?? 0) > 0) {
					destroyed.push({ x, y, z });
				}
			}
		}
	}

	return { destroyed, primed };
}
