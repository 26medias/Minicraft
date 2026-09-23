# Crafting — design

Date: 2026-09-22 · Branch: `crafting` (from `main` at aa57368) · Status: rev 2 (gate-1 repairs), pre-re-gate

## 1. Intent

Noah (7) gets a reason to mine: blocks he mines are counted, and the counts
buy better pickaxes and bigger TNT from a crafting screen. It must feel like
Minecraft's crafting without a crafting table, stay readable for a child who
reads a little, and **take nothing away** from worlds he already plays.

**What the parent asked for:**
- Crafting UI, Minecraft-like, no crafting table.
- Pickaxe levels: speed bonus 15 / 50 / 75 / 100 / 200 / 500 / 1000 %, and a
  mining area that grows (1 block, a few, a lot).
- Several TNT levels with bigger blast radius.
- Per-block counts starting at 0 (start value changeable later), +1 when
  mined, −1 when placed (floor 0). A recipe needs the blocks; a block at 0
  can't be used; crafting consumes them.

**Decisions taken with the parent (brainstorm + gate 1):**
- Crafting is a **Craft tab inside the I screen** (C stays Pick Light Color).
- "Must mine to build" is a **per-world switch**, off by default and off for
  every existing world. It applies **only to blocks worldgen can produce**;
  everything else stays free to place.
- All 7 pickaxe tiers; area grows with tier. The player **switches between
  owned pickaxes** (P, or click in the I screen).
- No build protection; TNT destroys what it destroys. Mining warns by
  **highlighting the whole area** (orange when > 1 block), and a multi-block
  break never takes less than 0.4 s.
- In must-mine worlds a newly mined block **joins the hotbar** (Minecraft-like).
- Unlimited worlds may farm counts (place an ore at 0, mine it back) — this is
  also how old v1/v2 worlds (no ores or trees) reach high tiers. Accepted.
- Big-edit re-meshing is **spread over frames** (fixes today's 72 ms
  chunk-corner TNT hitch too).

**Success criteria**
1. An existing world loads and plays exactly as before (unlimited placing,
   same hotbar, TNT radius 3), with a Craft tab now available.
2. In a must-mine world, a worldgen block at count 0 cannot be placed; mining
   it makes it placeable and puts it on the hotbar.
3. He can craft a pickaxe, see it equipped, feel the speed-up, see the larger
   orange highlight, and switch back to a smaller pickaxe with P.
4. He can craft Big and Mega TNT, place them, and they blow bigger holes.
5. No frame over the 50 ms perf gate from a 5×5×5 area mine, a plain TNT at
   a chunk corner, or a Mega TNT blast (measured, §8).
6. Old saves load locally and through the cloud; new fields survive a cloud
   round-trip, an offline-then-online merge, and a save from an old cached
   bundle.

**Non-goals:** durability, tool slots, swords/other tools, 3×3 shaped grid,
unlock popups, XP, per-block "placed by player" protection, block drops that
differ from the block mined (grass gives grass), recipes for decorative blocks.

## 2. Counts

- Stored per world in `player.inventory: Record<string, number>` keyed by
  **block name**.
- A key **absent** from the map means "never touched" → `startingCount()`,
  which returns `STARTING_COUNT` from `src/data/crafting.data.ts` (value `0`).
  Every key that has ever been touched is written, **zeros included**, so a
  later non-zero start value cannot resurrect blocks he used up. The start
  value is injectable in tests (tested with 5).
- **+1** per block the player's actions remove: single mining, each block of
  an area mine, each block a TNT blast destroys (chains included).
  - Not counted: the detonating TNT's own cell, and any TNT cell primed by a
    chain (it detonates itself later — also not counted). A TNT removed by
    *mining* (single or area) is counted like any block.
  - Not counted: liquid changes (sponge→wet sponge, obsidian formation,
    spread/drain).
- **−1** (floor 0) when a block is placed.
- **Shift-replace:** −1 of the placed block, +1 of the replaced block, and it
  is refused exactly when a plain place would be refused (§3).
- Deepslate ores are separate entries; recipes accept either variant (§4).
- Every count change calls `autosave.markDirty()`.

All count rules live in one pure module, `src/game/inventory.ts`:
`onRemoved(inv, blockIds)`, `canPlace(inv, blockId, mustMine)`,
`onPlaced(inv, blockId)`, `onReplaced(inv, placedId, oldId)`. The place and
replace handlers in `main.ts` call a single `tryPlace(...)` function in
`src/game/place.ts` (extracted from `main.ts:476–516`) that owns the
raycast-result → refusal → world write → count update sequence, so it is
testable headless.

## 3. "Must mine to build" (per world)

- New optional top-level world field `mustMine?: boolean`. Missing = `false`.
  Fixed for the life of the world.
- New World screen: checkbox "Must mine blocks to build", unchecked. Wired
  menu checkbox → `MenuAction {type:'new', mustMine}` → `startGame` →
  `AutoSave` meta → `snapshot()`.
- **Counted blocks** = the set of block names worldgen v3 can produce
  (exported from `src/engine/world/v3/blocks.ts` `NAMES`, minus `air`,
  `water`, `lava`, `bedrock`), plus the crafted-only blocks. Computed once in
  `src/data/crafting.data.ts`.
- In a must-mine world, placing a **counted** block at count 0 does nothing
  and plays a soft "nope". Non-counted blocks (planks, glass, wool, lamps,
  liquids…) are placed freely, as today.
- **Crafted-only blocks** (Big TNT, Mega TNT) need a count to place in
  **every** world, and appear in the Blocks tab only when count > 0. Plain
  TNT: counted in must-mine worlds (it is craftable), free in unlimited ones.
- **Hotbar badges:** a slot shows its count when the block needs a count to
  place in this world (counted block in must-mine, or crafted-only anywhere).
  At 0 such a slot is greyed. Other slots show no badge.
- **Auto-hotbar (must-mine only):** when a counted block's count goes 0 → 1
  and that block is not on the hotbar, it goes into the first slot that is
  empty (AIR) or holds a block whose count is 0 and that needs a count. If
  none, nothing changes. Marks the save dirty.
- Fly (F) and swimming work as today in every world.

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
- `canCraft(recipe, inventory, tools)`: false when any ingredient's summed
  count across `anyOf` is short, or the output pickaxe is already owned.
- `craft(...)` returns new inventory and tools; takes from `anyOf` in listed
  order (plain before deepslate); never below 0; adds output count.
- Test-time validation: every ingredient name is a counted block (§3).

**Pickaxes** (independent: any tier craftable without the ones below).

| Tier | Name | Bonus | Area | Recipe |
|---|---|---|---|---|
| 0 | Hand | 0 % | 1 | (always owned) |
| 1 | Wood | +15 % | 1 | 8 logs (any worldgen `*_log`) |
| 2 | Stone | +50 % | 1 | 24 stone, 4 logs |
| 3 | Copper | +75 % | 1×1×2 (target + the block behind) | 16 copper ore, 32 stone |
| 4 | Iron | +100 % | 3×3×1 | 16 iron ore, 48 stone |
| 5 | Gold | +200 % | 3×3×2 | 16 gold ore, 8 redstone ore |
| 6 | Diamond | +500 % | 3×3×3 | 8 diamond ore, 6 lapis ore |
| 7 | Emerald | +1000 % | 5×5×5 | 3 emerald ore, 4 diamond ore, 32 deepslate |

"X ore" = `anyOf: ['x_ore', 'deepslate_x_ore']`.

**TNT:**

| Output | Recipe |
|---|---|
| 2 TNT | 5 sand, 4 coal ore |
| 1 Big TNT | 2 TNT, 4 redstone ore |
| 1 Mega TNT | 2 Big TNT, 4 lapis ore |

Measured basis (gate 1, 8 seeds): per 256-block tunnel wall, coal ~13 and
copper ~9 at y 100, iron ~15 at y 60, lapis ~2.6 at y 40–60 and ~0.3 at y 12,
diamond ~7 at y 12; emerald only in mountains y 113–176, nearest median ~52
blocks from spawn. Numbers get tuned after the first play session.

## 5. Pickaxes in play

- `player.tools: { owned: number[]; equipped: number }`. Missing =
  `{ owned: [0], equipped: 0 }`. Shape frozen now (the API ships first).
  Crafting a pickaxe adds it, equips it, and marks dirty.
- **Switching:** new action `cyclePickaxe`, default `KeyP`, rebindable;
  cycles owned tiers ascending, wrapping. Handled only when no modal (I
  screen, colour picker, play-time freeze, menu) is open — an explicit
  input-gate rule. The I screen shows owned pickaxes; clicking one equips it.
  Every equip marks dirty. Switching while mining **resets the mining timer**.
- HUD: a pickaxe icon beside the hotbar shows the equipped tier with a small
  "P" keycap; clicking it opens the I screen. Icons are simple original pixel
  art, one per tier, drawn to atlas cells at build time.
- **Mining time** = `max(hardness(target) / (1 + bonus), area > 1 ? 0.4 : 0)`.
  Only the aimed block's hardness counts (aiming at dirt breaks a 5×5×5 of
  stone at dirt speed — accepted).
- **Area cells:** with hit-face normal `n` (one of ±x, ±y, ±z), the face-plane
  extent is centred on the target, and depth runs **away from the player**,
  i.e. from the target along `−n`, `depth` cells including the target.
  Exact cell lists are pinned by tests for each tier on the `+x` and `−y`
  faces.
- Area removal skips: air, liquids, hardness-0 blocks, out-of-bounds cells.
  TNT in the area is removed (counted), not ignited; a primed TNT in the area
  loses its fuse, as single mining does today.
- **Highlight:** one box outlining the area's full shape (including air
  cells), white when the area is 1 block, orange when larger.

## 6. TNT tiers

- Two new hand-written blocks in `src/data/blocks.extra.data.ts`:
  `big_tnt` (radius 5, fuse 4 s) and `mega_tnt` (radius 8, fuse 6 s).
  Plain `tnt` gets radius 3, fuse 2.5 s.
- `BlockDef` gains optional `tnt?: { radius: number; fuse: number }`.
  "Is TNT" becomes `def.tnt !== undefined` at every current `tntId`
  comparison: `actions.ts:61` (ignite), `tnt.ts:32` and `tnt.ts:51` (prime in
  blast), and the particle colour at `loop.ts:475` (use the detonating
  block's id). Radius and fuse are stored in the primed-TNT entry **at
  priming**; the chain fuse stays 0.1 s; a chained TNT explodes with its own
  radius.
- **Ids: `EXTRA_ID_START = 1000`.** Extra ids are **not** in
  `blocks.catalog.ids.json`. `assignIds` asserts every generated id is
  `< EXTRA_ID_START`; a test asserts no collision between catalog and extra
  ids. `dense()` fills the gap with tombstones (tables sized by
  `BLOCKS.length` grow to ~1002 entries; harmless).
- **Textures:** `build-atlas` gains a derived-texture map (name → source +
  transform). Big/Mega tiles are the three TNT faces converted to greyscale,
  then tinted (Big = orange, Mega = purple). Checked visually in the bench
  screenshot.
- Super TNT (radius 12) is out of scope.

## 7. Batched removal and spread re-meshing

Measured today (gate 1, dev box): TNT light work is small (1.7 ms at r3,
12 ms at r8); the cost is **synchronous edit-lane re-meshing** (21 ms for one
chunk, 72 ms for a chunk-corner r3 blast, 86 ms for r8 across 5 chunks).

**`GameLoop.removeBlocks(cells, cause)`**, used by TNT and area mining:
1. For each cell in order: `clearBlockEffects` (primed fuse, lamp light,
   particles — particles capped at 16 per batch), then `world.setBlock(AIR)`
   (never `chunk.set`: `setBlock` wakes liquids and sets `modified`), then the
   existing exact per-block light update. Light stays per block because it is
   exact and cheap; a bbox relight is wrong for sunlight columns (measured:
   405 voxels changed below a bbox margin).
2. Collect the affected chunk indices (each cell's chunk plus edge
   neighbours) and mark each dirty once.
3. Return `removed: Array<{x,y,z,blockId}>`; the caller applies counts.

**Spread re-meshing.** Big edits must not be re-meshed synchronously all in
one frame:
- An edit touching **one** chunk keeps today's path (sync, immediate).
- An edit touching **several** chunks: the chunk containing the edit's anchor
  (the aimed block, or the TNT origin) is re-meshed synchronously this frame;
  the others go to a new **bulk lane**, drained ahead of streaming, through
  the worker when available, otherwise sync at most one per frame.
- A chunk already in flight to the worker when it is edited again must not
  mount the stale reply (re-post, or discard the reply by edit generation).
- Visual cost accepted: a far edge of a big hole may appear 1–3 frames late.

## 8. Perf gate

Bench runs **first** (§14 step 1), against today's path, to record the
baseline. Rows, each run interior and at a chunk corner, each asserting the
expected cells were actually removed:
- plain TNT r3;
- area mine 5×5×5, 10 swings along a tunnel;
- one Mega TNT;
- a chain of 4 Mega TNT (report each detonation frame).

Pass = no frame over 50 ms. Light work is also reported per row (must stay
under 15 ms). Fallbacks in order: reduce Mega's radius to 7, then 6.
Results recorded in `docs/performance.md`. The dev box is faster than
Noah's laptop — keep a 20 % margin.

## 9. UI — the I screen

- Two tabs at the top: **Blocks** (today's grid) and **Craft**. The tab is
  remembered for the session. I opens/closes; Esc closes.
- **Blocks tab:** each tile shows its count when > 0. In must-mine worlds,
  counted tiles at 0 are dimmed but still assignable. A pickaxe row above the
  grid shows owned pickaxes; click to equip; the equipped one is framed.
- **Craft tab:** 10 cards (7 pickaxes + 3 TNT), all visible without
  scrolling at 1280×720. Each card: output picture and name; ingredient icons
  with `have / need` and a fill bar, red when short; one big green button with
  the output picture, disabled when short. Owned pickaxes show a check mark
  instead of the button.
- **After crafting:** a short sound and a sparkle on the card. Crafted TNT
  goes to the hotbar slot already holding that block, else the first empty
  slot, else the selected slot. A crafted pickaxe is equipped.

## 10. Saves and API — never break saves

New fields: `player.inventory`, `player.tools`, top-level `mustMine`. The new
client **always writes all three** (`{}` / default tools / `false` included).

Client, every place that must carry them:
- `adapter.ts` types; `main.ts` player snapshot (today a fixed field list,
  `main.ts:353`); `autosave.ts` meta + `snapshot()`.
- `localStorage.ts saveLocalSync` meta field list (drops `mustMine` today).
- `cloud.ts`: `Wire` type, `saveWorld` body, `decode()`.
- Load-time defaulting beside `resolveHotbar`: unknown block names, negative
  or non-integer counts, unknown tiers dropped; `equipped` not owned → highest
  owned; `0` always owned.
- `dual.ts sameContent` also compares `mustMine` and canonical JSON of
  `player.inventory` and `player.tools`; a difference is a divergence
  (forks, per dual.ts rule 2) — offline crafting is never silently dropped.

API (`api/src/schema.ts`, handlers):
- v2 and v3 `player`: `inventory` (record of string → int ≥ 0, ≤ 2000 keys)
  and `tools` (`owned`: int 0–15 array, `equipped`: int 0–15), both
  `.optional()`. Loose bounds so a later tier needs no API redeploy.
- v3 top level: `mustMine: z.boolean().optional()`. v2 top level too, for
  symmetry (new worlds are always v3); the "v2 frozen" comments are updated
  to say additive optional fields are allowed.
- **Old-client guard:** when a save arrives **without** `player.inventory`,
  `player.tools` or `mustMine`, and the stored object has them, the handler
  keeps the stored values (the `If-Match` path already reads the stored
  object). A stale cached bundle therefore cannot wipe counts, tools or the
  mode.

**Deploy order:** `./deploy.sh`, `./deploy.sh --verify`; then the site by hand
with cache-control, with `atlas.json`/atlas image uploaded **before or with**
the bundle (a new bundle with a stale atlas fails to start: `Atlas missing
tile`); then purge Cloudflare's `/minicraft/` cache; then hard-refresh on
Noah's laptop.

Two machines crafting on the same world at once: the merge forks (above);
no automatic count merge.

## 11. Testing

Every test names the wrong implementation it catches. Tests of new modules
that merely fail to compile on the old build do not count as "red on the old
build" — the named wrong implementation is what they must catch.

**Unit (vitest)**
- `inventory.ts`: +1/−1, floor 0, replace (both sides), must-mine refusal for
  place *and* replace, non-counted blocks always placeable, crafted-only
  blocks refused at 0 in unlimited worlds; `startingCount` injected as 5
  (catches a hard-coded 0) and a touched-to-0 key stays 0 after save/load.
- Auto-hotbar: 0→1 fills an empty slot; fills a 0-count slot; never replaces
  a slot with count > 0 or a free block; no-op when full; unlimited worlds
  no-op.
- `crafting.ts`: either ore variant; short by one refused; plain consumed
  before deepslate; owned pickaxe refused; outputs added; never negative.
- Mining time per tier incl. the 0.4 s floor (catches a floor applied to
  single-block mining).
- Area cells: exact lists per tier for `+x` and `−y` hits (catches depth
  running toward the player); bedrock/air/liquid/out-of-bounds skipped.
- TNT: radius and fuse per tier; radius fixed at priming; a chain explodes
  each TNT with its own radius; a lone TNT blast in air adds **0** TNT to
  counts; a chain of two adds 0 (catches counting `detonate()`'s own cell).
- `removeBlocks` equivalence with the old per-block path, compared over
  **every loaded chunk** (not a bbox): blocks, light, `modified`, liquid
  frontier, and the set of chunks marked dirty. Fixtures: interior,
  chunk corner, a lamp in a neighbour chunk shining into the hole (catches
  whole-chunk relight dropping cross-chunk light), a blast opening the roof of
  a ≥ 30-deep sealed shaft (catches bbox relight), a lamp inside the blast.
- Spread re-meshing: a multi-chunk edit mounts the anchor chunk the same frame
  and the rest within N frames; a stale worker reply after a second edit is
  not mounted.
- `assignIds` refuses an id ≥ 1000; catalog/extra ids don't collide.
- Save defaulting: old save without fields; junk counts/tiers; equipped not
  owned.
- `dual.ts`: same chunks, different inventory → fork (catches chunks-only
  `sameContent`).
- `input-gate`: `cyclePickaxe` blocked with the picker, the I screen and
  freeze open.
- Options: a saved options object without `cyclePickaxe` gets `KeyP`; a
  saved binding already on `KeyP` keeps it and `cyclePickaxe` is left
  unbound (older binding wins).

**API**
- Save through the handler with `inventory`, `tools`, `mustMine`, read back,
  assert **equality** of stored values (a separate probe shows the current
  schema strips them, proving the test can go red).
- Old v2/v3 payloads without the fields still accepted.
- Old-client guard: a save without the fields over a stored object that has
  them keeps the stored values.
- v3 top level still rejects unknown keys.

**Loop (`test-loop.ts`)**
- Equip Diamond, mine a stone wall: the exact 27 cells are AIR and counted.
- `tryPlace` in a must-mine world at count 0 refuses; after mining one,
  succeeds; count back to 0.
- Crafting then snapshot: snapshot contains the tool (catches missing
  `markDirty`).
- P mid-mine resets the timer; area highlight stub receives the area bounds.

**Browser smoke (Playwright, `localhost:5173`, save-API routes blocked)**
New must-mine world → mine → block appears on hotbar → I → Craft → craft Wood
pickaxe with seeded counts → P switches → orange highlight at Iron.
Screenshots of Big/Mega TNT tiles.

**Perf bench rows (§8).**

## 12. Docs

New `docs/crafting.md` (rules, how to add a recipe); `docs/inventory.md`
(tabs, counts, badges); `docs/persistence.md` (new fields, old-client guard,
deploy order incl. atlas and cache purge); `docs/performance.md` (bench rows,
bulk lane); CLAUDE.md "no crafting table UI; recipes resolve from inventory"
→ "crafting is a tab in the inventory screen; recipes are data in
`src/data/recipes.data.ts`".

## 13. Sequencing

1. Perf bench rows against today's path (baseline). `removeBlocks` +
   equivalence tests; move TNT onto it (no behaviour change). Spread
   re-meshing + bulk lane. Bench again.
2. Save fields end to end + API schema + old-client guard + `dual.ts`
   compare. **API deployable alone** (old client unaffected).
3. Counts: `inventory.ts`, `place.ts` extraction, mine/area/TNT/place hooks,
   `markDirty`. (No UI yet; counts invisible.)
4. Tools: mining time, area cells, highlight, `cyclePickaxe`, HUD icon.
5. TNT tiers: extra ids, derived textures, radius/fuse per block, crafted-only
   placement rule. Bench.
6. I-screen tabs, Craft tab, badges, must-mine checkbox, auto-hotbar.
7. Browser smoke, docs, CLAUDE.md.
