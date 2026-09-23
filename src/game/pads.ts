import { BLOCKS, type BlockId } from '../data/blocks.data';

/**
 * Slime and Launch pads (toys spec §3.1–3.2). Pure: Player.update calls these; nothing here reads keys or
 * moves the player. GRAVITY and JUMP_SPEED moved here from player.ts so this module is a leaf (player.ts
 * imports them back): a two-way import would read them before they are initialised.
 */

/** Blocks/s², the walking player's gravity. */
export const GRAVITY = 24;
/** Blocks/s, the initial upward speed of a plain jump. */
export const JUMP_SPEED = 8;
/** A landing slower than this (blocks/s, downwards) ends the bouncing. */
export const MIN_BOUNCE_VY = 3;
/** The fastest jump-held bounce: an 8-block rise. */
export const CAP_VY = Math.sqrt(2 * GRAVITY * 8);
/** A Launch Pad's throw: a 25-block rise (the simulated apex at 1/60 s is 25.3, player.test.ts). */
export const LAUNCH_VY = Math.sqrt(2 * GRAVITY * 25);
/** Share of the landing speed a slime bounce gives back with no key held. */
const SLIME_KEEP = 0.8;
/** Added to each jump-held bounce: he grows his bounces like on a trampoline. */
const JUMP_BOOST = 2;

export type PadKind = 'slime' | 'launch';

/**
 * The upward speed a pad gives (0 = none). `landingVy` is his vertical speed as he touched down (negative).
 * Sneak wins over everything. Launch ignores the landing; slime needs a real landing and then keeps 0.8 of it,
 * or with jump held grows it by 2 up to CAP_VY.
 */
export function padResponse(landingVy: number, pad: PadKind, jump: boolean, sneak: boolean): number {
	if (sneak) return 0;
	if (pad === 'launch') return LAUNCH_VY;
	if (landingVy >= -MIN_BOUNCE_VY) return 0;
	if (jump) return Math.min(Math.max(-landingVy, JUMP_SPEED) + JUMP_BOOST, CAP_VY);
	return -landingVy * SLIME_KEEP;
}

type BlockReader = { getBlock(x: number, y: number, z: number): BlockId };

/** The block one below the centre of his feet, even when his 0.6-wide box straddles two blocks. */
export function blockUnderFeet(world: BlockReader, pos: readonly [number, number, number]): BlockId {
	return world.getBlock(Math.floor(pos[0]), Math.floor(pos[1]) - 1, Math.floor(pos[2]));
}

/** The pad kind under his feet, or null. */
export function padUnderFeet(world: BlockReader, pos: readonly [number, number, number]): PadKind | null {
	return BLOCKS[blockUnderFeet(world, pos)]?.pad ?? null;
}
