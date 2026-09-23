/**
 * Crafting: constants and the save-side shapes of counts and tools (spec §2, §10).
 * Later phases add the counted-block list, pickaxe table and mining floors here.
 */

/** Count of a block whose name is absent from the inventory ("never touched"). */
export const STARTING_COUNT = 0;

/** Highest pickaxe tier the client knows (0 = hand ... 7). The API accepts up to 15. */
export const MAX_PICKAXE_TIER = 7;

/** Per-world counts keyed by block NAME. Every touched key is kept, zeros included. */
export type Inventory = Record<string, number>;

/** Owned pickaxe tiers (0 always owned) and the one in hand. */
export type PlayerTools = { owned: number[]; equipped: number };

/** Shared constant: never hand it out, copy it. */
export const DEFAULT_TOOLS: PlayerTools = { owned: [0], equipped: 0 };
