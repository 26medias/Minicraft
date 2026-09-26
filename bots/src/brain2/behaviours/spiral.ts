/**
 * The spiral dig geometry (spec §6.2, rev 3.3): a 3×3 spiral around a never-broken pillar, 8 steps per turn,
 * 3-high steps, and no tunnel. The pillar is placed so that the target's column is a ring column, and the phase
 * so that the last step is face-adjacent to the target at the target's height.
 */
import type { Vec3 } from '../types.js';

/** The 8 ring columns around the pillar, in walking order (each face-adjacent to the next). */
export const RING: ReadonlyArray<[number, number]> = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
/** y0: surface feet level at the pillar. */
export interface Spiral { px: number; pz: number; y0: number; phase: number; lastStep: number }
export interface Step { i: number; feet: Vec3; clear: Vec3[]; floor: Vec3 }

/** Step i: column RING[(i + phase) % 8] around (px, pz), feet at y0 − 1 − i, clearing feet.y..feet.y+2. */
export function spiralStep(sp: Spiral, i: number): Step {
	const [dx, dz] = RING[(i + sp.phase) % 8];
	const feet = { x: sp.px + dx, y: sp.y0 - 1 - i, z: sp.pz + dz };
	return { i, feet, clear: [0, 1, 2].map((h) => ({ x: feet.x, y: feet.y + h, z: feet.z })), floor: { x: feet.x, y: feet.y - 1, z: feet.z } };
}

/** The spirals that reach `target` with no tunnel: for each ring index j with target column = pillar + RING[j], the phase that puts the last step at ring index j − 1 (face-adjacent to j) with feet.y = target.y. Up to 8 candidates, shallowest dig (fewest steps) first. */
export function spiralsFor(target: Vec3, y0At: (x: number, z: number) => number): Spiral[] {
	const out: Spiral[] = [];
	for (let j = 0; j < 8; j++) {
		const [dx, dz] = RING[j];
		const px = target.x - dx, pz = target.z - dz;
		const y0 = y0At(px, pz);
		const lastStep = y0 - 1 - target.y;             // feet.y = target.y
		if (lastStep < 0) continue;
		const want = (j + 7) % 8;                          // ring index j − 1
		const phase = (((want - lastStep) % 8) + 8) % 8;
		out.push({ px, pz, y0, phase, lastStep });
	}
	return out.sort((a, b) => a.lastStep - b.lastStep);
}

/** True when mining `cell` can't break the staircase: not a floor of any step 0..lastStep, not the pillar column, not in any step's clear set. */
export function safeToMine(sp: Spiral, cell: Vec3): boolean {
	if (cell.x === sp.px && cell.z === sp.pz) return false;
	for (let i = 0; i <= sp.lastStep; i++) {
		const st = spiralStep(sp, i);
		const hit = (c: Vec3) => c.x === cell.x && c.y === cell.y && c.z === cell.z;
		if (hit(st.floor) || st.clear.some(hit)) return false;
	}
	return true;
}
