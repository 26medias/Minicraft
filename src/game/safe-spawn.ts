/**
 * Spawn safety (extracted from player.ts, unchanged): three-free, so the bot SDK can bundle it with
 * mp-spawn.ts. player.ts re-exports everything here.
 */
import type { World } from '../engine/world/world';

/**
 * Vertical bounds scale with the world: the void floor is fixed (Noah likes to
 * drop into it), the ceiling sits 56 blocks above the top of the column so a
 * 64-high world keeps today's 120. Before these existed one world was saved at
 * y = -193917 and loaded as an empty blue screen.
 */
export const VOID_FLOOR_Y = -24;
export function skyCeilingY(height: number): number {
	return height + 56;
}

const WORLD_MIN_XZ = 0.5;
const WORLD_MAX_XZ = 511.5;

function clamp(v: number, lo: number, hi: number): number {
	if (!Number.isFinite(v)) return (lo + hi) / 2;
	return Math.min(hi, Math.max(lo, v));
}

/** Brings a saved spawn back into the world, repairing already-broken saves. */
export function sanitizeSpawn(pos: [number, number, number], height = 64): [number, number, number] {
	return [
		clamp(pos[0], WORLD_MIN_XZ, WORLD_MAX_XZ),
		clamp(pos[1], VOID_FLOOR_Y, skyCeilingY(height)),
		clamp(pos[2], WORLD_MIN_XZ, WORLD_MAX_XZ),
	];
}

/**
 * Places the player on solid ground near their saved position. A saved position
 * with nothing under it means an immediate fall — which is how Noah's world came
 * to be saved at y = -193917 and load as an empty sky.
 */
export function findSafeSpawn(
	world: World,
	desired: [number, number, number],
): [number, number, number] {
	const top = world.height - 1;
	const [dx, dy, dz] = sanitizeSpawn(desired, world.height);

	const groundAt = (x: number, z: number, from: number): number | null => {
		const bx = Math.floor(x);
		const bz = Math.floor(z);
		const start = Math.min(Math.max(Math.floor(from), 0), top);
		for (let y = start; y >= 0; y--) {
			if (world.getBlock(bx, y, bz) !== 0) return y + 1;
		}
		// Nothing below the saved height — try from the top of the column.
		for (let y = top; y > start; y--) {
			if (world.getBlock(bx, y, bz) !== 0) return y + 1;
		}
		return null;
	};

	const here = groundAt(dx, dz, dy);
	if (here !== null) return [dx, here, dz];

	// Spiral outwards for the nearest column that has any ground at all.
	for (let r = 1; r <= 48; r++) {
		for (let ox = -r; ox <= r; ox++) {
			for (let oz = -r; oz <= r; oz++) {
				if (Math.max(Math.abs(ox), Math.abs(oz)) !== r) continue;
				const nx = Math.floor(dx) + ox;
				const nz = Math.floor(dz) + oz;
				if (nx < 0 || nx > 511 || nz < 0 || nz > 511) continue;
				const g = groundAt(nx + 0.5, nz + 0.5, top);
				if (g !== null) return [nx + 0.5, g, nz + 0.5];
			}
		}
	}
	return [dx, Math.max(dy, world.height / 2), dz];
}
