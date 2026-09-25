/**
 * Valid multiplayer skin ids. `bots/` may not import the game's `src/` (see
 * test/boundary.test.ts), so these are hard-coded here rather than imported.
 *
 * Source of truth: src/data/skins.data.ts (`SKINS[].id`), in repo order. Kept from drifting by
 * bots/test/skins.test.ts, which reads that file as text (not an import) and asserts these ids match.
 */
export const SKIN_IDS = ['milo', 'chip', 'crazy-fan-girl', 'jj', 'mikey', 'enderman'] as const;

export type SkinId = (typeof SKIN_IDS)[number];
