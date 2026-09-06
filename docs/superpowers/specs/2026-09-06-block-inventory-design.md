# Block Inventory — Design

**Date:** 2026-09-06
**Status:** Draft, awaiting gate 1
**Branch:** `feat/inventory`

## Problem

The hotbar is the whole block library: 18 blocks. Noah has been asking for the
huge Minecraft library for a while. The textures are already extracted (1083
PNGs from the family's own 1.21.6 install, in `src/assets/blocks/`), but only
19 catalog rows use them.

## Goal

Press **I** to open a full-screen block inventory listing every full-cube block
that the local Minecraft 1.21.6 install has textures for. Click a block to put
it in the currently selected hotbar slot. Press **I** or **Esc** to close. The
hotbar becomes a fixed 9-slot bar the kid fills from the inventory, saved with
the world.

No crafting, no item counts, no search box, no categories UI beyond visual
grouping. Personal use only; the Mojang-asset rule in `CLAUDE.md` stands (never
commit these to a public fork).

## Non-goals

- Non-cube blocks: stairs, slabs, fences, doors, flowers, crops, torches, rails,
  and every other model that is not a full cube. The engine renders unit cubes
  and nothing else. This excludes roughly 700 of the 1112 blockstates.
- Directional or rotated placement (logs always stand upright, furnaces always
  face one way).
- Block states (lit furnace, open barrel, waxed copper): one row per distinct
  *look*; 27 exact texture duplicates (waxed copper, infested stone) collapse
  into their base block.
- Dev/creative-only blocks: `jigsaw`, `structure_block`, `test_block`,
  `test_instance_block`, `command_block` family, `barrier`, `light`.
- Any change to the play-time limit, lighting, liquids, or TNT beyond what the
  id width forces.
- Touch / drag-and-drop. Click or tap on a tile is the whole interaction.

## The one hard decision: 16-bit block ids

Counting from the jar's `blockstates/` + `models/block/` (verified by script):

| | count |
|---|---|
| blockstates whose every variant is a cube-parent model | 379 |
| after collapsing exact texture duplicates | 352 |
| of those already in the catalog under an existing id | 15 |
| dev blocks removed | 4 |
| **new catalog rows** | **~333** |
| catalog total (20 existing + new) | **~353** |
| unique textures the atlas needs | ~430 (512 px atlas holds 625) |

Chunks store block ids in a `Uint8Array` (`src/engine/world/chunk.ts:7`), so
the catalog is capped at 256 ids today. 353 does not fit. Options:

1. **Widen to `Uint16Array`.** Touches `Chunk`, both codecs (client and cloud
   API), `RawChunk`, and tests. The RLE codec writes each run as `[value,
   varint run]` with `value` a raw byte; it becomes `[varint value, varint
   run]`. Every id in every existing save is < 128, and a varint for a value
   < 128 is the same single byte, so **existing saves decode byte-identically
   under the new codec, and re-saved worlds that only use old ids encode
   byte-identically too**. No migration, no version bump, no format flag.
2. Cap the library at ~236 blocks by curation. Rejected: the ask is "every
   block", and any cut list would be arbitrary.

Decision: option 1. Memory cost is 32 KB per loaded chunk instead of 16 KB;
~80 loaded chunks → 2.6 MB. Nothing else in the engine cares about the width:
`lights` is already `Uint16Array`, indices are numbers, `set()` between typed
arrays copies values.

**Deploy order matters.** The cloud function's `decodeChunk` must be redeployed
*before* the site: the old server would misparse a value ≥ 128 (it reads one
byte then a varint run), fail the length check, and refuse the save. The new
server reads old data identically, so deploying it first is safe. `./deploy.sh`
is pre-authorised; the site deploy is Julien's.

## User-facing behaviour

### Inventory

- **Open/close:** the `inventory` action, default `I` (rebindable in Options
  like every other key). `Esc` also closes. Opening releases pointer lock;
  closing does not re-acquire it (the kid clicks the world, as after any Esc).
- **What it shows:** a full-screen dark translucent overlay (above the HUD,
  below the colour picker and the play-time freeze) with a scrollable grid of
  64 px tiles, one per catalog block except air. Each tile shows the block's
  side face (`px`), like the hotbar does. Tiles are ordered by **group** then
  by name; a small uppercase group header (`WOOD`, `STONE`, `WOOL`, …)
  precedes each group, in the style of the menu's section headers.
- **Picking:** clicking a tile puts that block in the selected hotbar slot and
  the HUD updates at once. The inventory stays open so the kid can fill several
  slots. A strip of the 9 hotbar slots sits at the bottom of the overlay;
  clicking one selects it. Digit keys and Tab still change the selected slot
  while the inventory is open; nothing else on the keyboard does anything.
- **Label:** hovering a tile shows its name in a line above the hotbar strip
  (`Oak Planks`), and as the tile's `title`.
- **While open:** the game loop is paused the same way the play-time freeze
  pauses it (physics, mining, simulation stop; chunks keep loading). The
  world stays visible behind the overlay.

### Hotbar

- Always 9 slots. An empty slot is `AIR` (id 0), drawn as a blank cell. Placing
  with an empty slot selected does nothing.
- **Default hotbar** for a new world: the first 9 kid-mode blocks in catalog
  order (grass, dirt, stone, cobblestone, sand, oak planks, oak log, glass,
  white wool).
- **Saved per world** in the existing `PlayerSave.hotbar` / `selected` fields.
  A save whose `hotbar` is not exactly 9 entries (every save written so far
  holds the 18-entry pool) gets the default hotbar; if the previously selected
  block is in it, it stays selected. Unknown ids in a saved hotbar become `AIR`.
- **Kid mode** no longer filters anything at runtime. The inventory always
  shows the whole library (that is the request). The option's only remaining
  effect is that the default hotbar is drawn from the kid-mode rows. The
  Options label becomes `Kid mode (basic starter hotbar)`.

### Blocks

New blocks behave like existing ones: solid, mineable (hardness by group),
placeable. Emissive blocks (glowstone, sea lantern, shroomlight, froglights,
jack o'lantern, magma, crying obsidian) emit white light through the existing
`lightLevel` path (as lava does today; only the lamp is colour-pickable).
Leaves are cutout-transparent and tinted foliage green at build time, like
grass tops. Stained glass, tinted glass, and ice are translucent and render
through the existing transparent material.

## Architecture

### Catalog

`src/data/blocks.data.ts` keeps the 20 hand-written rows with their ids
frozen (world saves reference them). It now also spreads in
`src/data/blocks.catalog.data.ts`, a **generated, committed** file:

```ts
export const BLOCKS: BlockDef[] = [...BASE_BLOCKS, ...CATALOG_BLOCKS];
```

`BlockDef` gains two fields:

```ts
group: BlockGroup;        // inventory ordering
translucent: boolean;     // render in the transparent pass (stained glass, ice)
```

`BlockGroup` is a string union in `blocks.data.ts`, with a display order:

```
building, wood, stone, earth, sand, ore, metal, wool, concrete, terracotta,
glass, light, nether, end, deep, coral, other
```

Existing rows get `group` by hand and `translucent: false`.

### Generator: `scripts/gen-catalog.ts`

Reads the jar (`~/.minecraft/versions/1.21.6/1.21.6.jar`, path overridable by
`MINECRAFT_JAR`), writes `src/data/blocks.catalog.data.ts`. Rules, each a
pure function with a unit test:

1. **Full cube:** a blockstate all of whose variant models have a parent in
   `{cube_all, cube_column, cube_column_horizontal, cube_bottom_top, cube,
   cube_top, cube_directional, cube_mirrored_all, leaves, orientable,
   orientable_with_bottom, orientable_vertical}`. Multipart blockstates are
   excluded (none are full cubes).
2. **Textures:** resolved from the model's `textures` map to one of the four
   existing `BlockFaceTextures` kinds: `cube_all`/`leaves`/`cube_mirrored_all`
   → `uniform`; `cube_column*` → `columnar` (`end`, `side`); `cube_bottom_top`
   / `cube_top` / `orientable*` → `top-bottom-side` (`top`, `bottom`|`side`,
   `side`|`front`); `cube` / `cube_directional` → `six`. `orientable` blocks
   use `front` for `pz` only if the kind is `six`; otherwise they show `side`
   all round and `front` is dropped (furnace faces are a non-goal).
3. **Dedupe:** two blockstates with the same parent kind and the same resolved
   texture tuple keep the alphabetically first; the loser is listed in a
   comment. Names already present in `BASE_BLOCKS` are skipped (their existing
   id wins).
4. **Exclude:** the dev-block list above, plus any block whose resolved texture
   file is missing from `src/assets/blocks/` (logged, not fatal).
5. **Ids:** assigned in name order starting at `BASE_BLOCKS.length` (20), and
   **frozen**: the generator reads the current generated file first and keeps
   every existing name→id; new names take the next free id. Regenerating never
   renumbers.
6. **Transparency:** `sharp` reads every texture. Any alpha < 255 → `transparent:
   true`, `lightFilter: 0`. Any alpha strictly between 0 and 255 → also
   `translucent: true`. Otherwise `lightFilter: 15`.
7. **Group:** first matching rule on the name, in order: `_stained_glass`/`glass`/`ice`
   → glass; `_wool` → wool; `_concrete` → concrete; `terracotta` → terracotta;
   `_planks`/`_log`/`_wood`/`_stem`/`_hyphae`/`_leaves`/`bookshelf`/`bamboo`
   → wood; `_ore`/`raw_` → ore; `copper`/`iron_block`/`gold_block`/`diamond_block`/
   `emerald_block`/`netherite`/`lapis_block`/`redstone_block`/`coal_block`/`amethyst`
   → metal; `netherrack`/`nether_`/`soul_`/`basalt`/`blackstone`/`magma`/`shroomlight`/`warped`/`crimson`
   → nether; `end_`/`purpur`/`chorus` → end; `deepslate`/`tuff`/`sculk` → deep;
   `coral` → coral; `glowstone`/`sea_lantern`/`froglight`/`jack_o_lantern`/`lamp`
   → light; `sand`/`gravel`/`clay` → sand; `dirt`/`grass`/`mud`/`moss`/`mycelium`/
   `podzol`/`snow`/`hay`/`melon`/`pumpkin`/`sponge`/`honey`/`slime`/`dried_kelp`
   → earth; `stone`/`brick`/`andesite`/`diorite`/`granite`/`cobble`/`prismarine`/
   `quartz`/`calcite`/`dripstone`/`obsidian`/`bedrock`/`packed_mud` → stone;
   else other.
8. **Hardness by group:** wool/glass/earth/sand/wood-leaves 0.3, wood 0.8,
   concrete/terracotta 0.8, stone/deep/nether/end 1.2, metal/ore 1.5, other 0.8.
9. **Light:** `{glowstone: 15, sea_lantern: 15, shroomlight: 15,
   jack_o_lantern: 15, ochre_froglight: 15, verdant_froglight: 15,
   pearlescent_froglight: 15, magma_block: 3, crying_obsidian: 10}`; else 0.
10. **Labels:** `Title Case` of the name with underscores as spaces
    (`dark_oak_planks` → `Dark Oak Planks`), plus a small override map for
    `tnt`-style names if any arise (none expected).
11. `kidMode: false` for every generated row.

The generator is run by hand (`npm run gen-catalog`) and its output committed;
it is **not** part of `npm run build`, because the build must not depend on a
Minecraft install. A unit test asserts the committed catalog is internally
consistent (unique ids, unique names, ids ≥ 20 contiguous, every texture file
exists, every group in the union, base ids unchanged).

### Atlas builder (`scripts/build-atlas.ts`)

- **Animated textures** (PNG taller than wide: water, lava, magma, sea lantern,
  prismarine, sculk, crimson/warped stem) are **cropped to their first frame**
  instead of squashed by `resize`. This also fixes water and lava, which are
  squashed today.
- `TEXTURE_TINTS` gains the grayscale foliage masks: `oak_leaves`,
  `jungle_leaves`, `acacia_leaves`, `dark_oak_leaves`, `mangrove_leaves` →
  plains foliage `#77ab2f`; `birch_leaves` → `#80a755`; `spruce_leaves` →
  `#619961`. Cherry, azalea, flowering azalea, and pale oak leaves ship
  pre-coloured.
- Capacity check stays; ~430 tiles in a 625-tile atlas.

### Engine: 16-bit ids

- `Chunk.blocks: Uint16Array`.
- `codec.ts` (client) and `api/src/codec.ts`: `encodeChunk(blocks: Uint16Array)`
  writes `[varint value, varint run]`; `decodeChunk` returns `Uint16Array`.
  `api/src/codec.parity.test.ts` gains a case with ids 200, 255, 256, 353,
  65535 and a case proving a byte-for-byte match with the old encoding for ids
  < 128 (an encoding captured from the current code, as a literal string).
- `RawChunk.blocks: Uint16Array`; the legacy v1 reader copies its bytes into a
  `Uint16Array`.
- `api/src/handlers.ts` `validateChunks` additionally rejects any decoded value
  ≥ 65536 (impossible from a `Uint16Array` but cheap) and keeps the length
  check. It does **not** validate against the catalog: the server must keep
  accepting worlds from a newer client.
- Mesher: blocks with `translucent: true` are emitted in the liquid (transparent)
  mesh bucket with plain full-cube faces, using the same face rule as glass
  (emit against non-solid or a different transparent neighbour). Opaque bucket
  skips them.

### Player, HUD, main

- `Player.hotbar` is always length 9. `src/game/hotbar.ts` gets a pure
  `resolveHotbar(saved: BlockId[] | undefined, savedSelected: number,
  catalog: BlockDef[]): { hotbar: BlockId[]; selected: number }` implementing
  the rules under "Hotbar", with tests (18-entry legacy save → default, 9-entry
  save kept, unknown id → AIR, selected block preserved when present).
- `Hud.setHotbar` unchanged (already renders blank for a missing tile).
- `placeBlock` path in `main.ts` returns early when the selected id is `AIR`.
- `keybindings.data.ts`: `Action` gains `'inventory'`, default `KeyI`, label
  `Open Inventory`. `ACTIONS` order puts it after `pickLightColor`.
- **Pause ownership** in `main.ts`: two booleans, `frozen` (play-time) and
  `inventoryOpen`; `loop.paused = frozen || inventoryOpen` recomputed by a
  single `updatePaused()` whenever either changes. The play-time `freeze`
  callback sets `frozen = true` **and closes the inventory**; `resume` sets
  `frozen = false`. The inventory's open/close sets `inventoryOpen`.
- **Input gating** in `onKey` (replaces the current `if (down && loop.paused)
  return`): if `frozen` → ignore every keydown; else if `inventoryOpen` →
  handle only `inventory` and `slot1..9`; else handle everything. The Tab
  listener: ignored when `frozen`, allowed when `inventoryOpen`. `mousedown`:
  ignored when `loop.paused` (unchanged). `Escape` while `inventoryOpen` closes
  it (a `keydown` listener in the inventory itself, not remappable).

### `src/ui/inventory.ts` (DOM only)

```ts
export class Inventory {
	constructor(container: HTMLElement, atlas: LoadedAtlas, blocks: BlockDef[]);
	onPick: ((id: BlockId) => void) | null;          // tile clicked
	onSelectSlot: ((slot: number) => void) | null;   // hotbar strip clicked
	open(): void;
	close(): void;
	readonly isOpen: boolean;
	setHotbar(ids: BlockId[], selected: number): void; // mirrors Hud.setHotbar
}
```

Builds the grid once (≈350 tiles, `background-image` from the atlas PNG with
`background-position` from `atlas.tileRect(id, 'px')`, exactly as
`Hud.setHotbar` does). `#inventory-root` is `position: fixed; inset: 0;
z-index: 15`, `pointer-events: auto`, hidden with the `.hidden` class the
other overlays use. Grid: `display: grid; grid-template-columns:
repeat(auto-fill, 64px); gap: 6px; max-height: 70vh; overflow-y: auto`.
Group headers span all columns. Hotbar strip reuses `.hotbar-slot` styling.

### Wiring sequence

```
kid presses I
  main: inventoryOpen = true; updatePaused(); exitPointerLock; inventory.open()
kid clicks "Oak Planks"
  inventory.onPick(id) → player.hotbar[player.selected] = id;
                         hud.setHotbar(...); inventory.setHotbar(...); autosave.markDirty()
kid presses 3
  main onKey (inventoryOpen: slot keys allowed) → player.selected = 2; hud + inventory updated
kid presses I or Esc
  main: inventory.close(); inventoryOpen = false; updatePaused(); resetKeys()
play-time freeze fires while open
  freeze(): inventory.close(); inventoryOpen = false; frozen = true; updatePaused() …
```

`autosave.markDirty()` on every pick so the hotbar reaches the save; the
snapshot already includes `hotbar` and `selected`.

## Error handling

- A saved hotbar id that no longer exists in the catalog → `AIR`.
- A chunk containing an id the client does not know (a save from a newer
  build) renders as the mesher already handles unknown ids (transparent, no
  faces) rather than crashing; `BLOCKS[id]` lookups are already `?.`-guarded.
- Generator: missing jar → clear error naming `MINECRAFT_JAR`; missing texture
  → block skipped and listed at the end.
- Atlas capacity exceeded → the existing build-time error.

## Testing

Unit (vitest, node):

- `scripts/gen-catalog.test.ts`: full-cube classification, texture-kind
  mapping per parent, dedupe keeps the first name and skips base names, id
  freezing across a regeneration, group rules, transparency from alpha
  (synthetic 2×2 PNGs via `sharp`).
- `src/data/blocks.catalog.test.ts`: invariants over the committed catalog.
- `src/persistence/codec.test.ts` + `api/src/codec.parity.test.ts`: ids
  ≥ 256 round-trip; literal old-format string decodes identically; encoding of
  an all-<128 chunk equals the literal.
- `src/game/hotbar.test.ts`: `resolveHotbar` rules.
- `src/engine/world/mesher.test.ts`: a translucent block emits faces in the
  liquid bucket and none in the opaque bucket; an opaque neighbour still emits
  its face toward it.
- Existing suites updated from `Uint8Array` to `Uint16Array` where they build
  chunk fixtures (search list in the plan).

Manual, `localhost:5173` only:

- Press I: overlay with ~350 tiles, groups labelled; pointer lock released;
  WASD does nothing; world visible behind. Click a tile: it appears in the
  selected hotbar slot in both the HUD and the strip. Press 5, click another
  tile: slot 5 fills. Esc closes; I reopens; the hotbar persists after reload.
- Place ten different new blocks including glowstone (lights up), oak leaves
  (see-through, green), blue stained glass (see-through, blue), a log
  (bark sides, rings on top). Reload: all still there, same look. Save
  indicator green; if the API URL is configured, the cloud leg succeeds
  (requires the API redeployed first).
- Open a world saved before this change: hotbar shows the 9 defaults; the
  world is unchanged.
- Play-time freeze while the inventory is open: inventory closes, freeze shows.

## Files

| File | Change |
|---|---|
| `scripts/gen-catalog.ts` + test | new generator |
| `src/data/blocks.catalog.data.ts` + test | generated catalog (~333 rows) |
| `src/data/blocks.data.ts` | `group`, `translucent`, `BlockGroup`, spread catalog |
| `src/data/keybindings.data.ts` | `inventory` action |
| `scripts/build-atlas.ts` | frame crop, leaf tints |
| `src/engine/world/chunk.ts` | `Uint16Array` |
| `src/persistence/codec.ts` + test, `api/src/codec.ts` + parity test | varint value |
| `src/persistence/adapter.ts`, `localStorage.ts`, tests | `Uint16Array` |
| `api/src/handlers.ts` | value bound check |
| `src/engine/world/mesher.ts` + test | translucent bucket |
| `src/game/hotbar.ts` + test | `resolveHotbar` |
| `src/ui/inventory.ts`, `src/ui/ui.css` | overlay |
| `src/ui/options.ts` | kid-mode label |
| `src/main.ts` | pause ownership, gating, wiring, AIR guard |
| `package.json` | `gen-catalog` script |
| `docs/inventory.md`, `README.md`, `docs/specs.md`, `CLAUDE.md` | docs (hotbar-is-inventory line retired) |
