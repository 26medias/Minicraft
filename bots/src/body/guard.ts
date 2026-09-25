/**
 * The kid buffer and body box (spec §6 ruling, plan "Kid buffer"): where the bot must never edit.
 *
 * - **Buffer:** every column a kid's body box (x ± 0.3, z ± 0.3) overlaps, widened by 1 in each
 *   direction (Chebyshev ≤ 1), at every height.
 * - **Body box:** the kid's box from the feet to 1.8 above, above and below included.
 *
 * Both are checked against **every** kid (non-bot player with a pose), not only the target. The body
 * box's columns always lie inside the buffer, so on its own it only matters where the buffer is
 * absent; it is still checked separately as the last line of defence (the SDK's own `place` refusal
 * is the same box).
 */
import type { Vec3 } from '../types.js';

/** The kid's half-width (x ± 0.3, z ± 0.3), as the SDK's body box. */
export const KID_HALF_WIDTH = 0.3;
/** The kid's height from the feet, as the SDK's body box. */
export const KID_HEIGHT = 1.8;
/** How far (in columns, Chebyshev) the buffer widens the columns the kid's box overlaps. */
export const KID_BUFFER_RADIUS = 1;

/** A column key, `"x,z"`, for the floored column. */
export function columnKey(x: number, z: number): string {
	return `${Math.floor(x)},${Math.floor(z)}`;
}

/** The columns (floored) that the interval [c − half, c + half] overlaps with positive width. */
function overlappedRange(c: number, half: number): [number, number] {
	const lo = c - half, hi = c + half;
	// Touching a column's face (hi exactly on an integer) is not overlapping it.
	return [Math.floor(lo), Math.ceil(hi) - 1];
}

/** The columns a kid's box (x ± 0.3, z ± 0.3) overlaps, as `[x0, x1, z0, z1]` (inclusive). */
export function boxColumns(kid: Vec3): [number, number, number, number] {
	const [x0, x1] = overlappedRange(kid.x, KID_HALF_WIDTH);
	const [z0, z1] = overlappedRange(kid.z, KID_HALF_WIDTH);
	return [x0, x1, z0, z1];
}

/** The buffer: the set of column keys excluded from any bot edit, for every kid given. */
export function kidBuffer(kids: readonly Vec3[]): Set<string> {
	const out = new Set<string>();
	for (const kid of kids) {
		const [x0, x1, z0, z1] = boxColumns(kid);
		for (let x = x0 - KID_BUFFER_RADIUS; x <= x1 + KID_BUFFER_RADIUS; x++) {
			for (let z = z0 - KID_BUFFER_RADIUS; z <= z1 + KID_BUFFER_RADIUS; z++) out.add(`${x},${z}`);
		}
	}
	return out;
}

/** True when the (floored) cell overlaps any kid's body box: x ± 0.3, z ± 0.3, feet to feet + 1.8. */
export function inBodyBox(cell: Vec3, kids: readonly Vec3[]): boolean {
	const cx = Math.floor(cell.x), cy = Math.floor(cell.y), cz = Math.floor(cell.z);
	for (const kid of kids) {
		const overlapX = cx < kid.x + KID_HALF_WIDTH && cx + 1 > kid.x - KID_HALF_WIDTH;
		const overlapZ = cz < kid.z + KID_HALF_WIDTH && cz + 1 > kid.z - KID_HALF_WIDTH;
		const overlapY = cy < kid.y + KID_HEIGHT && cy + 1 > kid.y;
		if (overlapX && overlapZ && overlapY) return true;
	}
	return false;
}

/** True when a bot edit at `cell` is forbidden by any kid: inside a buffer column or a body box. */
export function forbiddenByKids(cell: Vec3, kids: readonly Vec3[]): boolean {
	return kidBuffer(kids).has(columnKey(cell.x, cell.z)) || inBodyBox(cell, kids);
}
