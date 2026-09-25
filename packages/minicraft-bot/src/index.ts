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
export { EYE_HEIGHT, WALK_SPEED } from '../../../src/game/player-constants';
export type { VoxelHit } from '../../../src/engine/input/raycast';

/**
 * The block ids of one generated chunk (before any player edit), exactly as the game generates it:
 * 16 × height × 16, indexed `y·256 + z·16 + x` (local x, z). `gen` is the world's generator version.
 */
export function generateChunkBlocks(seed: number, gen: number, cx: number, cz: number): Uint16Array {
	const c = new Chunk(cx, cz, worldProfile(gen).height);
	generateChunk(c, seed, gen);
	return c.blocks;
}
