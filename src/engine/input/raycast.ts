import type { World } from '../world/world';
import { isSolid, type Face } from '../../data/blocks.data';

export type VoxelHit = { x: number; y: number; z: number; face: Face; distance: number };

export function raycastVoxel(
	world: World,
	origin: [number, number, number],
	dir: [number, number, number],
	maxDistance: number,
): VoxelHit | null {
	const [ox, oy, oz] = origin;
	const [dx, dy, dz] = dir;
	const len = Math.hypot(dx, dy, dz);
	if (len === 0) return null;
	const rx = dx / len,
		ry = dy / len,
		rz = dz / len;

	let x = Math.floor(ox);
	let y = Math.floor(oy);
	let z = Math.floor(oz);

	const stepX = rx > 0 ? 1 : rx < 0 ? -1 : 0;
	const stepY = ry > 0 ? 1 : ry < 0 ? -1 : 0;
	const stepZ = rz > 0 ? 1 : rz < 0 ? -1 : 0;

	const tDeltaX = stepX !== 0 ? Math.abs(1 / rx) : Infinity;
	const tDeltaY = stepY !== 0 ? Math.abs(1 / ry) : Infinity;
	const tDeltaZ = stepZ !== 0 ? Math.abs(1 / rz) : Infinity;

	const voxBoundaryX = stepX > 0 ? x + 1 : x;
	const voxBoundaryY = stepY > 0 ? y + 1 : y;
	const voxBoundaryZ = stepZ > 0 ? z + 1 : z;

	let tMaxX = stepX !== 0 ? (voxBoundaryX - ox) / rx : Infinity;
	let tMaxY = stepY !== 0 ? (voxBoundaryY - oy) / ry : Infinity;
	let tMaxZ = stepZ !== 0 ? (voxBoundaryZ - oz) / rz : Infinity;

	let face: Face = 'py';
	let t = 0;

	while (t <= maxDistance) {
		if (isSolid(world.getBlock(x, y, z))) {
			return { x, y, z, face, distance: t };
		}
		if (tMaxX < tMaxY && tMaxX < tMaxZ) {
			t = tMaxX;
			x += stepX;
			tMaxX += tDeltaX;
			face = stepX > 0 ? 'nx' : 'px';
		} else if (tMaxY < tMaxZ) {
			t = tMaxY;
			y += stepY;
			tMaxY += tDeltaY;
			face = stepY > 0 ? 'ny' : 'py';
		} else {
			t = tMaxZ;
			z += stepZ;
			tMaxZ += tDeltaZ;
			face = stepZ > 0 ? 'nz' : 'pz';
		}
	}
	return null;
}
