import { BLOCK_BY_NAME, BLOCKS, type BlockId } from '../data/blocks.data';

/** Plain TNT's values, read from its row so the data stays the single source (spec §6). */
export const TNT_RADIUS = BLOCK_BY_NAME['tnt'].tnt!.radius;      // 3
export const TNT_PRIME_FUSE = BLOCK_BY_NAME['tnt'].tnt!.fuse;    // 2.5 s — kid-ignited fuse
export const TNT_CHAIN_FUSE = 0.1;  // seconds — chain-reaction propagation delay, every tier

/** Radius and fuse of a TNT block, or null for anything else. "Is TNT" everywhere is `tntSpec(id) !== null`. */
export function tntSpec(id: BlockId): { radius: number; fuse: number } | null {
	return BLOCKS[id]?.tnt ?? null;
}

/** Coord-map key used by the primed-TNT registry and overlay renderer. */
export function tntKey(x: number, y: number, z: number): string {
	return `${x},${y},${z}`;
}

/** Toys spec §3.4: a Tunnel's direction, fixed when it is primed (lit: the yaw; chained: blast-shapes.chainDir). */
export type TunnelDir = 'px' | 'nx' | 'pz' | 'nz';

/** What a blast does to the world; computed by blast-shapes.detonate, applied by GameLoop.detonateAt. */
export type DetonationResult = {
	destroyed: Array<{ x: number; y: number; z: number }>;
	/** Newly primed by this blast; `radius` and `blockId` are read NOW, at priming, and never again. `dir`: chained Tunnels only. */
	primed: Array<{ x: number; y: number; z: number; radius: number; blockId: BlockId; dir?: TunnelDir }>;
};
