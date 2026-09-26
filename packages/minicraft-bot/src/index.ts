/**
 * minicraft-bot: write bots that join a Minicraft multiplayer world (Node ≥ 22). Built from the game's
 * own world, net and worldgen modules (`npm run build:bot` in the Minicraft repo). See README.md.
 */
import { Chunk } from '../../../src/engine/world/chunk';
import { generateChunk, worldProfile } from '../../../src/engine/world/generation';

export { BotClient } from './bot-client';
export type { BotClientOptions, BotEvents, BotPlayer, ConnectOptions, ConnectResult, JournalEntry, PoseInput, WalkResult, WebSocketCtor } from './bot-client';
export { BotWorld, blockId, blockName, blockNames, raycastVoxel } from './bot-world';
export type { BlockChangeListener, Pose, Vec3 } from './bot-world';
export { BlockedError, NotConnectedError, OutdatedClientError, ReplacedError, ServerRefusedError } from './errors';
export { CLIENT_VERSION, POS_EVERY_MS } from '../../../src/net/protocol';
export type { EditOut, FxMsg, LeavingMsg, Spawn, WorldListing } from '../../../src/net/protocol';
export { EYE_HEIGHT, FLY_SPEED, WALK_SPEED } from '../../../src/game/player-constants';
/** The catalog's solidity rules, as pure functions of a block id (the same ones `BotWorld.isSolid` / `isLiquid` use). */
export { isLiquid as isLiquidId, isSolid as isSolidId } from '../../../src/data/blocks.data';
export type { VoxelHit } from '../../../src/engine/input/raycast';
/** Blocks the world generator places (a bot can mine only these) and blocks only crafting makes (never mined, never held by a bot). */
export { WORLDGEN_BLOCKS, CRAFTED_ONLY } from '../../../src/data/crafting.data';
/** Toy TNT: the game's blast cells for flatten/tunnel TNT, TNT specs (radius, fuse) and the crafting recipes. Read-only. */
export { blastCells, tntSpec, RECIPES, FLATTEN_HEIGHT, TUNNEL_LENGTH } from './blast';
export type { BlastToy, BlastWorld, Cell, Ingredient, Recipe, TntSpec, TunnelDir } from './blast';
import { spawnV3 } from '../../../src/engine/world/v3/spawn';
/** The world's generated spawn column, the point "first" joins spawn at (the game uses spawnV3 on every gen). brain2 spec §6. */
export function worldSpawn(seed: number, _gen: number): { x: number; z: number } {
	// The game's resolveMpSpawn uses spawnV3 for 'first' joins on every gen (mp-spawn.ts:27); so does this.
	const s = spawnV3(seed);
	return { x: s.x, z: s.z };
}

/**
 * The block ids of one generated chunk (before any player edit), exactly as the game generates it:
 * 16 × height × 16, indexed `y·256 + z·16 + x` (local x, z). `gen` is the world's generator version.
 */
export function generateChunkBlocks(seed: number, gen: number, cx: number, cz: number): Uint16Array {
	const c = new Chunk(cx, cz, worldProfile(gen).height);
	generateChunk(c, seed, gen);
	return c.blocks;
}
