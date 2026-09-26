import { describe, expect, it } from 'vitest';
import { RING, climbPath, exitOf, safeToMine, spiralStep, spiralsFor, stepAt, type Spiral, type Step } from '../../src/brain2/behaviours/spiral.js';
import type { Vec3 } from '../../src/brain2/types.js';

const Y0 = 100;
const flat = () => Y0;
const k = (c: Vec3) => `${c.x},${c.y},${c.z}`;

/** Every spiralsFor candidate × 16 target depths (1..16 below y0), on a flat surface. */
function cases(): Array<{ sp: Spiral; target: Vec3; steps: Step[]; cleared: Set<string>; name: string }> {
	const out = [];
	for (let depth = 1; depth <= 16; depth++) {
		const target = { x: 50, y: Y0 - depth, z: 50 };
		const sps = spiralsFor(target, flat);
		expect(sps, `depth ${depth}`).toHaveLength(8);
		for (const sp of sps) {
			const steps = Array.from({ length: sp.lastStep + 1 }, (_, i) => spiralStep(sp, i));
			const cleared = new Set(steps.flatMap((s) => s.clear.map(k)));
			out.push({ sp, target, steps, cleared, name: `depth ${depth} pillar ${sp.px},${sp.pz} phase ${sp.phase}` });
		}
	}
	return out;
}
const faceAdjacent = (a: Vec3, b: Vec3) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z) === 1;

describe('spiral dig geometry (spec §6.2 rev 3.3)', () => {
	it('RING is the 8 columns around the pillar, each face-adjacent to the next', () => {
		expect(new Set(RING.map(([x, z]) => `${x},${z}`)).size).toBe(8);
		for (let i = 0; i < 8; i++) {
			const [ax, az] = RING[i], [bx, bz] = RING[(i + 1) % 8];
			expect(Math.abs(ax - bx) + Math.abs(az - bz)).toBe(1);
		}
	});

	// Red on the rev 3 reversal (steps from 10 on turning the other way): a jump across the ring.
	it('consecutive steps are face-adjacent and one lower', () => {
		for (const c of cases()) {
			for (let i = 1; i < c.steps.length; i++) {
				const a = c.steps[i - 1].feet, b = c.steps[i].feet;
				expect(faceAdjacent(a, b), `${c.name} step ${i}`).toBe(true);
				expect(b.y, `${c.name} step ${i}`).toBe(a.y - 1);
			}
		}
	});

	// Red if a later step's 3-high clear reaches an earlier step's floor (the staircase loses a stair).
	it('no step clears another step\'s floor', () => {
		for (const c of cases()) for (const s of c.steps) expect(c.cleared.has(k(s.floor)), `${c.name} floor of ${s.i}`).toBe(false);
	});

	// Red on the reversal (a step lands in a column < 8 steps later and cuts the separation), or a shorter turn.
	it('4 solid cells separate a turn from the next', () => {
		for (const c of cases()) {
			for (const s of c.steps) {
				for (let d = 2; d <= 5; d++) expect(c.cleared.has(k({ ...s.feet, y: s.feet.y - d })), `${c.name} step ${s.i} −${d}`).toBe(false);
				const below = c.steps[s.i + 8];
				if (below) {
					expect(below.feet.x === s.feet.x && below.feet.z === s.feet.z, `${c.name} step ${s.i}+8 column`).toBe(true);
					expect(below.feet.y + 2, `${c.name} step ${s.i}+8 top`).toBe(s.feet.y - 6);
				}
			}
		}
	});

	// Red if a step visits the pillar column (a tunnel through it).
	it('the pillar column is never cleared', () => {
		for (const c of cases()) {
			for (const s of c.steps) for (const cell of s.clear) expect(cell.x === c.sp.px && cell.z === c.sp.pz, `${c.name} step ${s.i}`).toBe(false);
		}
	});

	// Red on the rev 3 tunnel geometry (it cut the pillar in 32 of 128 cases and floors in 28), and on
	// `want = j` (the last step in the target's own column clears the target).
	it('the target is in no step\'s clear, and the last step is face-adjacent to it at feet level', () => {
		for (const c of cases()) {
			expect(c.cleared.has(k(c.target)), c.name).toBe(false);
			const last = c.steps[c.sp.lastStep];
			expect(faceAdjacent(last.feet, c.target), c.name).toBe(true);
			expect(last.feet.y, c.name).toBe(c.target.y);
		}
	});

	// Red if safeToMine lets vein mining take a floor, the pillar or a cleared cell, or refuses a harmless neighbour.
	it('safeToMine is false for every floor, the pillar and cleared cells, and true for the target\'s other neighbours that are none of those', () => {
		for (const c of cases()) {
			const floors = new Set(c.steps.map((s) => k(s.floor)));
			for (const s of c.steps) {
				expect(safeToMine(c.sp, s.floor), c.name).toBe(false);
				for (const cell of s.clear) expect(safeToMine(c.sp, cell), c.name).toBe(false);
			}
			for (let y = c.target.y - 2; y <= Y0; y++) expect(safeToMine(c.sp, { x: c.sp.px, y, z: c.sp.pz }), `${c.name} pillar y ${y}`).toBe(false);
			expect(safeToMine(c.sp, c.target), c.name).toBe(true);
			const t = c.target;
			const nbrs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(([dx, dy, dz]) => ({ x: t.x + dx, y: t.y + dy, z: t.z + dz }));
			let free = 0;
			for (const n of nbrs) {
				const bad = floors.has(k(n)) || c.cleared.has(k(n)) || (n.x === c.sp.px && n.z === c.sp.pz);
				expect(safeToMine(c.sp, n), `${c.name} neighbour ${k(n)}`).toBe(!bad);
				if (!bad) free++;
			}
			expect(free, c.name).toBeGreaterThan(0);
		}
	});

	// A kid (jump 1.33, body 1.8) must be able to climb out. Red on 2-high steps (no headroom after the rise).
	it('a kid can climb every step', () => {
		for (const c of cases()) {
			for (let i = 1; i < c.steps.length; i++) {
				const s = c.steps[i], up = c.steps[i - 1];
				for (let h = 0; h <= 2; h++) expect(c.cleared.has(k({ ...s.feet, y: s.feet.y + h })), `${c.name} step ${i} +${h}`).toBe(true);
				expect(c.cleared.has(k({ ...s.feet, y: s.feet.y + 3 })), `${c.name} step ${i} ceiling`).toBe(false);
				for (let h = 0; h <= 2; h++) expect(c.cleared.has(k({ ...up.feet, y: up.feet.y + h })), `${c.name} step ${i - 1} +${h}`).toBe(true);
			}
		}
	});

	it('candidates are sorted shallowest first, and a target above the surface has none', () => {
		const sps = spiralsFor({ x: 10, y: 90, z: 10 }, (x) => (x < 10 ? 95 : 99));
		expect(sps.map((s) => s.lastStep)).toEqual([...sps.map((s) => s.lastStep)].sort((a, b) => a - b));
		expect(sps[0].lastStep).toBe(4);
		expect(spiralsFor({ x: 10, y: Y0, z: 10 }, flat)).toEqual([]);
	});
	// Ruling R17. Red if the climb skips a step (walkTo only climbs 1 block), walks the steps in the wrong order, or
	// exits into a column whose surface a step cleared (a hole, not natural ground) or that isn't beside step 0.
	it('climbPath: from every step, one step up per walk, then out onto the intact surface beside step 0', () => {
		for (const c of cases()) {
			const exit = exitOf(c.sp);
			expect(c.cleared.has(k({ x: exit.x, y: Y0 - 1, z: exit.z })), `${c.name} exit surface`).toBe(false);
			expect(c.cleared.has(k({ x: exit.x, y: Y0, z: exit.z })) || c.cleared.has(k({ x: exit.x, y: Y0 + 1, z: exit.z })), `${c.name} exit headroom`).toBe(false);
			expect(exit.x === c.sp.px && exit.z === c.sp.pz).toBe(false);
			for (const st of c.steps) {
				const pose = { x: st.feet.x + 0.5, y: st.feet.y, z: st.feet.z + 0.5 };
				expect(stepAt(c.sp, pose), c.name).toBe(st.i);
				const path = climbPath(c.sp, pose);
				expect(path, `${c.name} from ${st.i}`).toHaveLength(st.i + 1);
				// Feet heights along the way: each waypoint's column is face-adjacent to the last and 1 higher.
				let at: Vec3 = st.feet;
				for (let j = 0; j < path.length; j++) {
					const to = j < st.i ? c.steps[st.i - 1 - j].feet : exit;
					expect({ x: to.x + 0.5, z: to.z + 0.5 }).toEqual(path[j]);
					expect(faceAdjacent(at, to), `${c.name} from ${st.i} walk ${j}`).toBe(true);
					expect(to.y - at.y).toBe(1);
					at = to;
				}
			}
			// Not on a step: on the surface, on the pillar, one block off a step's feet height.
			const s0 = c.steps[0].feet;
			expect(climbPath(c.sp, { x: exit.x + 0.5, y: Y0, z: exit.z + 0.5 })).toEqual([]);
			expect(climbPath(c.sp, { x: c.sp.px + 0.5, y: Y0, z: c.sp.pz + 0.5 })).toEqual([]);
			expect(climbPath(c.sp, { x: s0.x + 0.5, y: s0.y + 1, z: s0.z + 0.5 })).toEqual([]);
			// brain2-productive: hovering 1 above a deeper step's feet (a blocked flight) is still on it, and climbs out.
			if (c.steps.length > 2) {
				const s2 = c.steps[2].feet;
				expect(stepAt(c.sp, { x: s2.x + 0.5, y: s2.y + 1, z: s2.z + 0.5 }), c.name).toBe(2);
				expect(climbPath(c.sp, { x: s2.x + 0.5, y: s2.y + 1, z: s2.z + 0.5 }), c.name).toHaveLength(3);
			}
			// Only the dug steps count (upTo = stepsDone).
			const last = c.steps.at(-1)!.feet;
			expect(stepAt(c.sp, { x: last.x + 0.5, y: last.y, z: last.z + 0.5 }, c.steps.length - 1)).toBe(-1);
		}
	});
});
