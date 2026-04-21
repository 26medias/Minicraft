import type { World } from '../world/world';
import { isSolid } from '../../data/blocks.data';

export type MoveResult = {
	position: [number, number, number];
	vx: number;
	vy: number;
	vz: number;
	grounded: boolean;
};

const EPS = 1e-4;

export function moveWithCollisions(
	world: World,
	position: [number, number, number],
	size: [number, number, number],
	velocity: [number, number, number],
): MoveResult {
	const [sx, sy, sz] = size;
	let [px, py, pz] = position;
	let [vx, vy, vz] = velocity;
	let grounded = false;

	// X axis
	px = resolveAxis(world, px, py, pz, sx, sy, sz, vx, 'x');
	if (collidesAABB(world, px, py, pz, sx, sy, sz)) {
		px -= vx;
		vx = 0;
	}

	// Z axis
	pz = resolveAxis(world, px, py, pz, sx, sy, sz, vz, 'z');
	if (collidesAABB(world, px, py, pz, sx, sy, sz)) {
		pz -= vz;
		vz = 0;
	}

	// Y axis
	const newY = py + vy;
	if (collidesAABB(world, px, newY, pz, sx, sy, sz)) {
		if (vy < 0) {
			grounded = true;
			py = Math.floor(py) + EPS;
		} else {
			py = Math.floor(newY + sy) - sy - EPS;
		}
		vy = 0;
	} else {
		py = newY;
	}

	return { position: [px, py, pz], vx, vy, vz, grounded };
}

function resolveAxis(
	world: World,
	px: number,
	py: number,
	pz: number,
	sx: number,
	sy: number,
	sz: number,
	delta: number,
	axis: 'x' | 'z',
): number {
	if (axis === 'x') {
		const newX = px + delta;
		if (collidesAABB(world, newX, py, pz, sx, sy, sz)) {
			// snap to edge
			return delta > 0
				? Math.floor(newX + sx / 2) - sx / 2 - EPS
				: Math.ceil(newX - sx / 2) + sx / 2 + EPS;
		}
		return newX;
	} else {
		const newZ = pz + delta;
		if (collidesAABB(world, px, py, newZ, sx, sy, sz)) {
			return delta > 0
				? Math.floor(newZ + sz / 2) - sz / 2 - EPS
				: Math.ceil(newZ - sz / 2) + sz / 2 + EPS;
		}
		return newZ;
	}
}

function collidesAABB(
	world: World,
	px: number,
	py: number,
	pz: number,
	sx: number,
	sy: number,
	sz: number,
): boolean {
	const minX = Math.floor(px - sx / 2);
	const maxX = Math.floor(px + sx / 2);
	const minY = Math.floor(py);
	const maxY = Math.floor(py + sy);
	const minZ = Math.floor(pz - sz / 2);
	const maxZ = Math.floor(pz + sz / 2);
	for (let y = minY; y <= maxY; y++) {
		for (let z = minZ; z <= maxZ; z++) {
			for (let x = minX; x <= maxX; x++) {
				if (isSolid(world.getBlock(x, y, z))) return true;
			}
		}
	}
	return false;
}
