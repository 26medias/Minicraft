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

/**
 * The dug step (0 … `upTo` − 1) whose feet cell the pose stands on, or −1 (ruling R17). Every step's feet are below
 * y0, so a hit means the bot is down in the staircase.
 */
export function stepAt(sp: Spiral, pose: { x: number; y: number; z: number }, upTo = sp.lastStep + 1): number {
	const fx = Math.floor(pose.x), fz = Math.floor(pose.z);
	for (let i = 0; i < Math.min(upTo, sp.lastStep + 1); i++) {
		const f = spiralStep(sp, i).feet;
		if (f.x === fx && f.z === fz && Math.abs(pose.y - f.y) < 0.5) return i;
	}
	return -1;
}

/**
 * The exit onto natural ground beside the pillar: the ring column before step 0, at the surface (feet y0). It is
 * face-adjacent to step 0 and one block up, and no step clears its surface block (only steps 0–2 reach the surface
 * layer, in other columns); the pillar area was checked natural with headroom at plan time.
 */
export function exitOf(sp: Spiral): Vec3 {
	const [dx, dz] = RING[(sp.phase + 7) % 8];
	return { x: sp.px + dx, y: sp.y0, z: sp.pz + dz };
}

/**
 * The climb out of the staircase (ruling R17): from step k (the pose's step, see `stepAt`), the column centres of
 * steps k − 1 … 0 in order (one walk each: walkTo is 2D and only climbs 1 block), then the exit column. [] when
 * the pose is on none of the dug steps.
 */
export function climbPath(sp: Spiral, pose: { x: number; y: number; z: number }, upTo = sp.lastStep + 1): Array<{ x: number; z: number }> {
	const k = stepAt(sp, pose, upTo);
	if (k < 0) return [];
	const out: Array<{ x: number; z: number }> = [];
	for (let i = k - 1; i >= 0; i--) {
		const f = spiralStep(sp, i).feet;
		out.push({ x: f.x + 0.5, z: f.z + 0.5 });
	}
	const e = exitOf(sp);
	out.push({ x: e.x + 0.5, z: e.z + 0.5 });
	return out;
}
