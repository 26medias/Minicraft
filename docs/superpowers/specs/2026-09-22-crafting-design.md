# Crafting — design

Date: 2026-09-22 · Branch: `crafting` (from `main` at aa57368) · Status: draft, pre-gate-1

## 1. Intent

Noah (7) gets a reason to mine: blocks he mines are counted, and the counts
buy better pickaxes and bigger TNT from a crafting screen. It must feel like
Minecraft's crafting without a crafting table, stay readable for a child who
reads a little, and **take nothing away** from worlds he already plays.

**What the parent asked for (verbatim scope):**
- Crafting UI, Minecraft-like, no crafting table. (Key: resolved to a *Craft
  tab inside the I screen* — C is already Pick Light Color.)
- Pickaxe levels: speed bonus 15 / 50 / 75 / 100 / 200 / 500 / 1000 %, and a
  mining area that grows (1 block, a few, a lot).
- Several TNT levels with bigger blast radius.
- Per-block counts starting at 0 (the start value must be changeable later),
  +1 when mined, −1 when placed (floor 0). A recipe needs the blocks; a block
  at 0 can't be used; crafting consumes them.

**Decisions taken during brainstorming (parent-approved):**
- "Must mine to build" is a **per-world switch**, off by default and off for
  every existing world.
- All 7 pickaxe tiers; area grows with tier.
- The player can **switch between owned pickaxes**.
- No build protection. TNT destroys what it destroys. Mining warns by
  **highlighting the whole area** that is about to break.

**Success criteria**
1. An existing world loads and plays exactly as before (unlimited placing,
   same hotbar, TNT radius 3), with a Craft tab now available.
2. In a must-mine world, a block at count 0 cannot be placed; mining it makes
   it placeable.
3. He can craft a pickaxe, see it equipped, feel the speed-up, see the larger
   highlight, and switch back to a smaller pickaxe with P.
4. He can craft Big and Mega TNT, place them, and they blow bigger holes.
5. No frame over the 50 ms perf gate from a 5×5×5 area mine or a Mega TNT
   blast (measured, §8).
6. Old saves load locally and through the cloud; new fields survive a cloud
   round-trip.

**Non-goals:** durability, tool slots, swords/other tools, 3×3 shaped grid,
recipe unlock popups, XP, per-block "placed by player" protection, block
drops that differ from the block mined (grass gives grass).

## 2. Counts

- Stored per world in `player.inventory: Record<string, number>` keyed by
  **block name** (names survive id changes; ids are frozen anyway, names read
  better in saves).
- A missing key means `STARTING_COUNT` (new constant in
  `src/data/crafting.data.ts`, value `0`). A later settings screen may expose
  it; nothing else reads a literal 0.
- Only non-zero entries are written.
- **+1** for every block removed by the player's actions: single mining, every
  block of an area mine, every block destroyed by TNT (including chain
  reactions). Not counted: liquid changes (sponge→wet sponge, obsidian
  formation, spread/drain), blocks with hardness 0 (never removed anyway),
  primed-TNT blocks consumed by their own explosion.
- **−1** (floor 0) when a block is placed. Shift-replace: −1 of the placed
  block, +1 of the replaced block.
- Deepslate ores are separate entries. Recipes accept either variant (§4).
- Crafted TNT tiers are counted blocks like any other (§6).

## 3. "Must mine to build" (per world)

- New optional world field `mustMine?: boolean`. Missing = `false`.
- New World screen gets a checkbox "Must mine blocks to build", unchecked.
  Fixed for the life of the world (no toggle later — YAGNI; revisit if asked).
- `mustMine: true`: placing a block whose count is 0 does nothing and plays a
  soft "nope" sound. Its hotbar slot is drawn greyed with a `0` badge; slots
  with a count show the number.
- `mustMine: false`: placing is unlimited as today; counts still go down with
  a floor of 0. Hotbar slots show no badges (a wall of 0s reads as "empty").
- **Crafted-only blocks** (Big TNT, Mega TNT) always need a count to place,
  in both modes, and are listed in the Blocks tab only when count > 0. Plain
  TNT stays free in unlimited worlds.

## 4. Recipes (data)

`src/data/recipes.data.ts`:

```ts
type Ingredient = { anyOf: string[]; count: number };      // block names
type Recipe = {
    id: string;
    output: { kind: 'pickaxe'; tier: PickaxeTier } | { kind: 'block'; name: string; count: number };
    needs: Ingredient[];
};
```

Resolution (`src/game/crafting.ts`, pure):
- `canCraft(recipe, inventory, tools)` — false when any ingredient's summed
  count across `anyOf` is short, or when the output pickaxe is already owned.
- `craft(...)` returns the new inventory and tools. It takes from `anyOf` in
  listed order (plain before deepslate). Counts never go below 0.
- Ingredient names are validated at test time against the catalog and against
  what worldgen v3 can produce.

**Pickaxes** (independent: any tier can be crafted without the ones below it).

| Tier | Name | Bonus | Area | Recipe |
|---|---|---|---|---|
| 0 | Hand | 0 % | 1 | (always owned) |
| 1 | Wood | +15 % | 1 | 8 logs (any `*_log` worldgen makes) |
| 2 | Stone | +50 % | 1 | 24 stone, 4 logs |
| 3 | Copper | +75 % | 1×2 (target + the block behind it) | 16 copper ore, 32 stone |
| 4 | Iron | +100 % | 3×3 on the hit face | 16 iron ore, 48 stone |
| 5 | Gold | +200 % | 3×3 face, 2 deep | 16 gold ore, 8 redstone ore |
| 6 | Diamond | +500 % | 3×3×3 | 8 diamond ore, 16 lapis ore |
| 7 | Emerald | +1000 % | 5×5×5 | 8 emerald ore, 4 diamond ore, 32 deepslate |

"X ore" means `anyOf: ['x_ore', 'deepslate_x_ore']`. Obsidian was dropped
from Emerald (worldgen never makes it).

**TNT** (§6):

| Output | Recipe |
|---|---|
| 1 TNT | 5 sand, 4 coal ore |
| 1 Big TNT | 4 TNT, 4 redstone ore |
| 1 Mega TNT | 4 Big TNT, 8 lapis ore |

Numbers are a first cut; the kid-lens gate and a play session tune them.

## 5. Pickaxes in play

- `player.tools: { owned: PickaxeTier[]; equipped: PickaxeTier }`. Missing =
  `{ owned: [0], equipped: 0 }`. Crafting a pickaxe adds it and equips it.
- **Switching:** new action `cyclePickaxe`, default **KeyP**, rebindable,
  cycles through owned tiers ascending, wrapping. Passes the input gate when
  no modal is open. The I screen shows owned pickaxes as a row; clicking one
  equips it.
- HUD: a pickaxe icon beside the hotbar shows the equipped tier. Pickaxe icons
  are original simple pixel art tinted per tier (no Mojang item textures
  exist in `src/assets/blocks/`), drawn at atlas-build time.
- **Mining time** = `hardness / (1 + bonus)` of the targeted block.
- **Area** is laid out relative to the hit face normal: the face-plane extent
  is centred on the target; depth runs away from the player (into the wall).
  Blocks in the area are removed together when the target's timer completes.
  Skipped: air, liquids, hardness-0 blocks, and cells out of world bounds.
  A primed or unprimed TNT in the area is removed (not ignited), as single
  mining does today.
- **Highlight:** the existing target-face highlight grows to outline the
  whole area (a single box over the area's bounds, not per-block outlines).
  It shows the full area shape even over air cells, so what he sees is the
  shape, and only solid blocks inside it break.
- Area removal may place the player's own position inside the area; after
  removal nothing needs to happen (removal cannot trap him).

## 6. TNT tiers

- Two new hand-written blocks: `big_tnt` (radius 5, fuse 4 s) and `mega_tnt`
  (radius 8, fuse 6 s). Plain `tnt` stays radius 3, fuse 2.5 s.
- `BlockDef` gains optional `tnt?: { radius: number; fuse: number }`;
  `detonate()` reads radius from the detonating block, and ignite reads the
  fuse. "Is TNT" becomes `def.tnt !== undefined` everywhere `tntId` is
  compared today.
- Chain reactions: any TNT tier in a blast is primed with the chain fuse
  (0.1 s) and explodes with *its own* radius. No protection.
- **Ids:** a third hand-written range starting at **1000**, in a new
  `src/data/blocks.extra.data.ts`, recorded in `blocks.catalog.ids.json` so
  `gen-catalog` never reuses them. `dense()` fills the gap with tombstones.
  The 16-bit chunk format already holds them; the API codec 2 accepts ids ≥
  128 (verify in gate 1).
- **Textures:** generated at atlas-build time by tinting the three TNT
  textures (Big = orange, Mega = purple) into new atlas cells. No new files
  in `src/assets/blocks/`.
- Super TNT (radius 12) is **not** in scope; it may be added only if §8's
  bench shows headroom.

## 7. Batched block removal (prerequisite)

Today `detonateAt` relights once per destroyed block (~123 floods at radius
3). A Mega blast is ~2,145 blocks; a 5×5×5 area is 125.

New `GameLoop.removeBlocks(cells, cause)`:
1. For each cell: `clearBlockEffects` (fuses, lamp lights, particles — capped
   particle count per batch).
2. Write AIR for all cells.
3. One light update over the union bounding box (plus the light spread
   margin), not one per block.
4. Mark each affected chunk (and edge neighbours) for re-mesh once; wake
   liquids adjacent to the hole as the single-block path does.
5. Return `{ removed: Array<{x,y,z,blockId}> }`; the caller adds counts.

TNT detonation and area mining both use it. Single-block mining keeps its
existing path (unchanged behaviour, unchanged perf).

Equivalence requirement: after `removeBlocks`, the world's block and light
arrays equal those produced by the old per-block path on the same input
(test with a fixed seed, several shapes, at chunk edges, near lamps).

## 8. Perf gate

`npm run perf:bench` gets three rows, each run interior and at a chunk edge:
- area mine 5×5×5 (Emerald), repeated 10 times along a tunnel;
- one Mega TNT blast;
- a chain of 4 Mega TNT.

Pass = no frame over the existing 50 ms gate. Fallbacks, in order: cap
Emerald to one area break per 0.25 s; spread the remesh of a big blast over
frames (already happens via the worker); reduce Mega's radius to 7, then 6.
Results recorded in `docs/performance.md`.

## 9. UI — the I screen

- Two tabs at the top: **Blocks** (today's grid) and **Craft**. Tab state is
  remembered for the session. I still opens/closes; Esc closes.
- **Blocks tab:** each tile shows its count in the corner when > 0 (all
  worlds). In must-mine worlds tiles at 0 are dimmed but still assignable to
  the hotbar. A pickaxe row above the grid shows owned pickaxes; click to
  equip; the equipped one is framed.
- **Craft tab:** one card per recipe, all visible, no scrolling at the game's
  minimum supported window (9 pickaxe/TNT cards → 3×3 of cards). Each card:
  output picture and name; ingredient icons each with `have / need`, red when
  short; one big green button with the output picture, disabled when short or
  owned; owned pickaxes show "Owned".
- After crafting: a short sound and a sparkle on the card. A crafted TNT goes
  into the selected hotbar slot; a crafted pickaxe is equipped.
- Input gate: unchanged except the new `cyclePickaxe` action, which is
  blocked while any modal is open.

## 10. Saves and API — never break saves

New optional fields: `player.inventory?`, `player.tools?`, `WorldSave.mustMine?`.

- Client: `adapter.ts` types, snapshot in `autosave.ts`/`main.ts`,
  load-time defaulting beside `resolveHotbar` (unknown block names dropped,
  negative/non-integer counts dropped, unknown tiers dropped, `equipped` not
  owned → highest owned).
- `cloud.ts` wire field list includes the new fields.
- API `api/src/schema.ts`: `player.inventory` / `player.tools` as `.optional()`
  on the player object (v2 and v3), `mustMine` as `.optional()` on both
  top-levels (v3 is `.strict()` — the new key must be declared). Old payloads
  without them must still validate. API tests extended.
- **Deploy order:** `./deploy.sh`, `./deploy.sh --verify`, then the site by
  hand with cache-control, then a hard refresh on Noah's laptop. A stale
  bundle shows Big/Mega TNT as invisible until refreshed (known, as with
  earlier catalog updates).
- Two machines crafting on the same world: last writer wins, as for the rest
  of the save.

## 11. Testing

Every new test is run against the pre-change build and must fail there (or
not compile) before it counts.

- Unit (vitest): count rules (mine, place, replace, floor 0, starting
  default); recipe resolution (either ore variant, short by one, count 0,
  consume order, owned pickaxe refused); mining time per tier; area cells per
  tier × 6 faces, bedrock/air/liquid skipped, bounds; TNT radius and fuse per
  tier, chain uses each block's own radius; `removeBlocks` equivalence with
  the per-block path; save defaulting (old save, junk fields); recipe names
  exist in catalog and worldgen v3.
- API: schema accepts old v2/v3 payloads, accepts and round-trips the new
  fields, v3 strict still rejects unknown keys.
- Loop (`test-loop.ts`): equip Diamond, mine, 27 blocks gone and counted;
  must-mine world refuses placing at 0; TNT blast adds counts.
- Browser smoke with Playwright at `localhost:5173`, **save API routes
  blocked**: new must-mine world → I → Craft → craft Wood pickaxe with seeded
  counts → P switches → mine shows the larger highlight at Iron.
- Perf bench rows (§8).

## 12. Docs

New `docs/crafting.md` (player-facing rules + how to add a recipe);
`docs/inventory.md` (tabs, counts); `docs/persistence.md` (new fields, deploy
order); CLAUDE.md "no crafting table UI; recipes resolve from inventory"
becomes "crafting is a tab in the inventory screen; recipes are data in
`src/data/recipes.data.ts`".

## 13. Open questions for the parent

1. **Old worlds have no ores or trees.** Worlds made by worldgen v1/v2 contain
   only grass, dirt, sand, stone and water. In a must-mine sense they can
   craft the Stone pickaxe at most. *Proposed:* accept — see Q2, which makes
   every unlimited world able to craft anything.
2. **Unlimited worlds make counts farmable.** Place a diamond ore from the
   Blocks tab (count stays 0), mine it, +1. *Proposed:* accept. Unlimited
   is creative mode; crafting there is a toy, and must-mine worlds are
   where crafting is earned. The alternative (count only blocks the world
   generated) needs a per-block placed flag — rejected as a save-format
   change.
3. Recipe numbers are a first cut; tune after the first play session.

## 14. Sequencing

1. Batched `removeBlocks` + equivalence tests; move TNT onto it (no behaviour
   change). Bench.
2. Counts + save fields + API schema (API deployable on its own).
3. Tools, mining time, area mining, highlight, P.
4. TNT tiers (blocks ≥ 1000, textures, radius/fuse per block). Bench.
5. I-screen tabs, Craft tab, badges, must-mine switch.
6. Browser smoke, docs, CLAUDE.md.
