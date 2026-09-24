import type { World } from '../engine/world/world';
import { spawnV3 } from '../engine/world/v3/spawn';
import { AIR, isLiquid, isSolid } from '../data/blocks.data';
import type { Spawn } from '../net/protocol';
import { findSafeSpawn } from './player';

export type MpSpawn = { pos: [number, number, number]; yaw: number; pitch: number };

/** Straight ahead first, then fanning out (spec §7.2: "then fan out ±60°"). */
const NEAR_ANGLES = [0, 30, -30, 60, -60].map((d) => (d * Math.PI) / 180);
const NEAR_MIN = 3;
const NEAR_MAX = 6;
/** The ground is searched this far above and below the target's feet (gate-2 C7 (E)). */
const NEAR_DY = 4;

/** The camera's yaw that looks from (fromX, fromZ) toward (toX, toZ); forward is (-sin yaw, -cos yaw). */
function yawToward(fromX: number, fromZ: number, toX: number, toZ: number): number {
	return Math.atan2(-(toX - fromX), -(toZ - fromZ));
}

/**
 * Resolves `welcome.spawn` into a position (spec §7.2). The server picks only the mode; the client
 * computes the spot from the seed and the terrain it has.
 */
export function resolveMpSpawn(world: World, seed: number, spawn: Spawn): MpSpawn {
	if (spawn.mode === 'first') {
		const s = spawnV3(seed);
		return { pos: findSafeSpawn(world, [s.x + 0.5, world.height - 1, s.z + 0.5]), yaw: 0, pitch: 0 };
	}
	if (spawn.mode === 'return') {
		return { pos: findSafeSpawn(world, [spawn.x, spawn.y, spawn.z]), yaw: spawn.yaw, pitch: spawn.pitch };
	}
	return resolveNear(world, spawn);
}

function resolveNear(world: World, t: Spawn): MpSpawn {
	const feetY = Math.floor(t.y);
	const tried = new Set<number>();
	for (const a of NEAR_ANGLES) {
		// The target's facing turned by a; forward at yaw is (-sin yaw, -cos yaw).
		const dirX = -Math.sin(t.yaw + a), dirZ = -Math.cos(t.yaw + a);
		for (let d = NEAR_MIN; d <= NEAR_MAX; d++) {
			const bx = Math.floor(t.x + dirX * d), bz = Math.floor(t.z + dirZ * d);
			const key = bx * 4096 + bz;
			if (tried.has(key)) continue;
			tried.add(key);
			const cx = bx + 0.5, cz = bz + 0.5;
			// Snapping to the column centre can move the spot by up to 0.71 blocks; keep it 3–6 away.
			const dist = Math.hypot(cx - t.x, cz - t.z);
			if (dist < NEAR_MIN || dist > NEAR_MAX) continue;
			if (!world.inBounds(bx, 0, bz)) continue;
			const g = groundAt(world, bx, bz, feetY);
			if (g === null) continue;
			return { pos: [cx, g + 1, cz], yaw: yawToward(cx, cz, t.x, t.z), pitch: 0 };
		}
	}
	return { pos: [t.x, t.y, t.z], yaw: t.yaw, pitch: 0 };
}

/**
 * The standable ground in one column: scanning y from feetY + 4 down to feetY − 4, the first solid,
 * non-liquid block with two air cells above it (dry: water above is not air).
 */
function groundAt(world: World, x: number, z: number, feetY: number): number | null {
	for (let y = feetY + NEAR_DY; y >= feetY - NEAR_DY; y--) {
		if (!world.inBounds(x, y, z)) continue;
		const g = world.getBlock(x, y, z);
		if (!isSolid(g) || isLiquid(g)) continue;
		if (world.getBlock(x, y + 1, z) === AIR && world.getBlock(x, y + 2, z) === AIR) return y;
	}
	return null;
}
