/** Shared with the bot SDK (packages/minicraft-bot): the same walk speed and eye height as the player. */
export const WALK_SPEED = 5; // blocks/sec
export const EYE_HEIGHT = 1.6;
/** The fly speed tier a player starts with (flying speed = WALK_SPEED × tier). */
export const FLY_TIER_DEFAULT = 2;
/** Flying speed at the default tier (10 blocks/sec); the bot SDK's `flyTo` flies at it. */
export const FLY_SPEED = WALK_SPEED * FLY_TIER_DEFAULT;
