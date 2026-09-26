/**
 * The builder's moves: which template cells can be placed next (supported, still air), described in a few words
 * for the model, and the heuristic fallback (lowest layer, then nearest).
 */
import type { Role, Template } from '../brain2/behaviours/templates.data.js';
import type { WorldView } from '../port.js';
import type { Vec3 } from '../types.js';
import type { Palette } from './palettes.data.js';

export interface PlanCell { cell: Vec3; block: string; role: Role; layer: number }
export const cellKey = (c: Vec3): string => `${c.x},${c.y},${c.z}`;

/** Every template cell in the world, bottom-up, with its block from the palette. */
export function planCells(t: Template, origin: Vec3, palette: Palette): PlanCell[] {
	return t.cells
		.map((c) => ({ cell: { x: origin.x + c.x, y: origin.y + c.y, z: origin.z + c.z }, block: palette.blocks[c.role], role: c.role, layer: c.y }))
		.sort((a, b) => a.layer - b.layer);
}

const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;

/** Supported: the block below is solid, or a face neighbour is solid (placed build cells are solid too). */
export function supported(world: WorldView, c: Vec3): boolean {
	return FACES.some(([dx, dy, dz]) => world.isSolid(world.getBlock(c.x + dx, c.y + dy, c.z + dz)));
}

/**
 * Up to `max` candidate moves: cells not yet done, still air and supported, from the lowest layer that has any,
 * nearest to `from` first. `done` = keys placed or given up on.
 */
export function candidateMoves(plan: readonly PlanCell[], done: ReadonlySet<string>, world: WorldView, from: Vec3, max = 3): PlanCell[] {
	const open = plan.filter((p) => !done.has(cellKey(p.cell)) && world.getBlock(p.cell.x, p.cell.y, p.cell.z) === 0 && supported(world, p.cell));
	if (open.length === 0) return [];
	const low = Math.min(...open.map((p) => p.layer));
	const d = (p: PlanCell) => Math.hypot(p.cell.x + 0.5 - from.x, p.cell.y + 0.5 - from.y, p.cell.z + 0.5 - from.z);
	return open.filter((p) => p.layer === low).sort((a, b) => d(a) - d(b)).slice(0, max);
}

/** The heuristic pick: the candidates are already lowest-then-nearest. */
export function heuristicPick(moves: readonly PlanCell[]): PlanCell | null {
	return moves[0] ?? null;
}

const LEVEL = ['ground level', 'second row', 'third row'];

/** A few words for the model: "wall block, ground level, 3 blocks away". */
export function describeMove(m: PlanCell, from: Vec3): string {
	const dist = Math.round(Math.hypot(m.cell.x + 0.5 - from.x, m.cell.z + 0.5 - from.z));
	const level = LEVEL[m.layer] ?? `row ${m.layer + 1}`;
	return `${m.role} block (${m.block.replace(/_/g, ' ')}), ${level}, ${dist} block${dist === 1 ? '' : 's'} away`;
}
