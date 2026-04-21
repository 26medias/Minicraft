import type { World } from '../engine/world/world';
import type { VoxelHit } from '../engine/input/raycast';
import type { BlockId } from '../data/blocks.data';
import { AIR, isSolid } from '../data/blocks.data';

const FACE_NORMAL: Record<string, [number, number, number]> = {
	px: [1, 0, 0],
	nx: [-1, 0, 0],
	py: [0, 1, 0],
	ny: [0, -1, 0],
	pz: [0, 0, 1],
	nz: [0, 0, -1],
};

export function mineBlock(world: World, hit: VoxelHit): BlockId | null {
	const existing = world.getBlock(hit.x, hit.y, hit.z);
	if (!isSolid(existing)) return null;
	world.setBlock(hit.x, hit.y, hit.z, AIR);
	return existing;
}

export function placeBlock(
	world: World,
	hit: VoxelHit,
	block: BlockId,
	playerAabb: { position: [number, number, number]; size: [number, number, number] },
): boolean {
	const [nx, ny, nz] = FACE_NORMAL[hit.face];
	const tx = hit.x + nx;
	const ty = hit.y + ny;
	const tz = hit.z + nz;

	if (isSolid(world.getBlock(tx, ty, tz))) return false;
	if (intersectsAabb(tx, ty, tz, playerAabb)) return false;

	world.setBlock(tx, ty, tz, block);
	return true;
}

function intersectsAabb(
	bx: number,
	by: number,
	bz: number,
	aabb: { position: [number, number, number]; size: [number, number, number] },
): boolean {
	const [px, py, pz] = aabb.position;
	const [sx, sy, sz] = aabb.size;
	const minX = px - sx / 2,
		maxX = px + sx / 2;
	const minY = py,
		maxY = py + sy;
	const minZ = pz - sz / 2,
		maxZ = pz + sz / 2;
	return bx < maxX && bx + 1 > minX && by < maxY && by + 1 > minY && bz < maxZ && bz + 1 > minZ;
}
