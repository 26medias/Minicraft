/**
 * The game's own blast shapes and recipes, for bots that craft and set off toy TNT (the landscaper). Read-only: the
 * cells come from the game's `detonate` (src/game/blast-shapes.ts), the same function GameLoop.detonateAt applies, and
 * the recipes are the Craft tab's rows (src/data/recipes.data.ts). Nothing here edits a world.
 */
import { detonate, FLATTEN_HEIGHT, TUNNEL_LENGTH } from '../../../src/game/blast-shapes';
import type { TunnelDir } from '../../../src/game/tnt';
import type { World } from '../../../src/engine/world/world';
import { BLOCK_BY_NAME } from '../../../src/data/blocks.data';

export { RECIPES } from '../../../src/data/recipes.data';
export type { Ingredient, Recipe } from '../../../src/data/recipes.data';
export { FLATTEN_HEIGHT, TUNNEL_LENGTH };
export type { TunnelDir };
/** A block cell. */
export type Cell = { x: number; y: number; z: number };

/** The toy TNT a bot may set off. */
export type BlastToy = 'flatten_tnt' | 'tunnel_tnt';
/** What `detonate` reads of a world: bounds and block ids (a `BotWorld` fits). */
export type BlastWorld = { inBounds(x: number, y: number, z: number): boolean; getBlock(x: number, y: number, z: number): number };
export type TntSpec = { radius: number; fuse: number; shape: 'sphere' | 'tunnel' | 'flatten' | 'lake' | 'dome' | 'firework' };

/** A TNT block's blast radius, fuse (seconds, the kid-lit fuse) and shape; null for a block that is not TNT. */
export function tntSpec(name: string): TntSpec | null {
	const t = BLOCK_BY_NAME[name]?.tnt;
	return t ? { radius: t.radius, fuse: t.fuse, shape: t.shape ?? 'sphere' } : null;
}

/**
 * The cells a `toy` set off at `center` removes, exactly as the game computes them on `world` now: `destroyed`
 * (solid, hardness > 0, in the shape's order; the TNT's own cell first when it is solid) and `primed` (other TNT in
 * reach, which the game would prime rather than remove). `dir` is a tunnel's direction (default 'px').
 */
export function blastCells(world: BlastWorld, toy: BlastToy, center: Cell, dir: TunnelDir = 'px'): { destroyed: Cell[]; primed: Cell[] } {
	const spec = tntSpec(toy)!;
	const shape = toy === 'tunnel_tnt' ? 'tunnel' : 'flatten';
	// detonate reads only inBounds/getBlock for the removing shapes (dome and lake would read more; not offered).
	const r = detonate(world as unknown as World, center.x, center.y, center.z, () => false, spec.radius, { shape, dir });
	return { destroyed: r.destroyed.map(({ x, y, z }) => ({ x, y, z })), primed: r.primed.map(({ x, y, z }) => ({ x, y, z })) };
}
