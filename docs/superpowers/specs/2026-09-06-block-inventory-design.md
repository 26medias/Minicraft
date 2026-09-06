# Block Inventory — Design

**Date:** 2026-09-06
**Status:** Revised after gate 1 (four reviewers: rigour, engine, boundary/pipeline, consumer)
**Branch:** `feat/inventory`

## Problem

The hotbar is the whole block library: 19 blocks. Noah has been asking for the
huge Minecraft library for a while. The textures are already extracted (1083
PNGs from the family's own 1.21.6 install, in `src/assets/blocks/`), but only
20 catalog rows use them.

## Goal

Press **I** to open a full-screen block inventory listing every solid cube
block that the local Minecraft 1.21.6 install has textures for: about 340
blocks. Click a block to put it in the currently selected hotbar slot. Press
**I** or **Esc** to close. The hotbar becomes a fixed 9-slot bar the kid fills
from the inventory, saved with the world.

No crafting, no item counts, no search box. Personal use only; the
Mojang-asset rule in `CLAUDE.md` stands (never commit these to a public fork).

## Non-goals, in the words the parent will use with Noah

- **Only whole cubes.** No stairs, slabs, fences, walls, doors, trapdoors,
  torches, lanterns, flowers, saplings, crops, glass panes, chests, beds,
  signs, ladders, candles, shulker boxes, rails, or buttons. The engine draws
  unit cubes and nothing else. He gets ~340 blocks and misses ~750.
- **Blocks always face the same way.** A furnace or a jack o'lantern shows its
  face on one fixed side; logs always stand upright.
- **One row per look.** Waxed copper and infested stone look exactly like the
  plain block and are not listed. Lit/open/charged variants are not listed;
  the first variant in the game's own file is the one shown (a small override
  list picks the lit redstone lamp because that is the one he wants).
- **Dev and creative-mode oddities are out:** command, structure, jigsaw and
  test blocks, barrier, light, spawners, respawn anchor, frosted ice,
  reinforced deepslate.
- No drag-and-drop, no touch gestures beyond a tap on a tile.
- **Kid mode is removed.** Every one of today's 20 rows is already `kidMode:
  true`, so the option has done nothing for months; the inventory makes the
  "all blocks" view the default. The Options checkbox, the `kidMode` field
  on blocks and options, and the CLAUDE.md / README lines describing the
  filter are retired in this change.

## The one hard decision: 16-bit block ids

Counting from the jar's `blockstates/` and `models/block/` (verified by three
independent scripts during review):

| | count |
|---|---|
| blockstates whose every variant resolves to one full 0..16 cube element | ~399 |
| after collapsing exact texture duplicates and excluding `waxed_*` / `infested_*` | ~350 |
| already in the catalog under an existing id | 14 |
| dev / creative exclusions | ~12 |
| **new catalog rows** | **~325** |
| catalog total (20 existing + new) | **~345** |
| unique textures | ~410 |

Chunks store block ids in a `Uint8Array` (`src/engine/world/chunk.ts:7`), a
256-id cap. Options:

1. **Widen to `Uint16Array`.** Touches `Chunk`, both codecs (client and cloud
   API), `RawChunk`, fixtures. The RLE codec writes each run as `[value,
   varint run]` with `value` a raw byte; it becomes `[varint value, varint
   run]`. Every id in every existing save is < 128, and a varint for a value
   < 128 is the same single byte, so **existing saves decode byte-identically
   under the new codec, and re-saved worlds that only use old ids encode
   byte-identically too**. The rigour reviewer confirmed this on 132 fixtures
   (0 byte mismatches) and confirmed that the *old* server hard-refuses any
   chunk with an id ≥ 128 (3000/3000 randomised chunks → "wrong length" →
   400) rather than corrupting it.
2. Cap the library at ~236 blocks. Rejected: the ask is "every block".

Decision: option 1. Memory: 32 KB per loaded chunk, ~2.6 MB for the usual 80.

**Consequences, stated plainly:**

- **Deploy the API before the site.** `./deploy.sh` is pre-authorised. The
  new server reads old data identically. `/health` gains `codec: 2` and
  `deploy.sh --verify` asserts it, so a forgotten API deploy fails loudly.
- **A stale client cannot open a world that contains a new block.** Once Noah
  places a block with id ≥ 128, a browser still running the old bundle (a
  Cloudflare-cached `/minicraft/` or a second device) cannot decode that
  world. Today that surfaces as an opaque `InvalidCharacterError` because
  `parseChunkPayload` in `localStorage.ts` falls back to decoding the raw JSON
  envelope; this change tightens the fallback so the honest "Decoded chunk has
  wrong length" surfaces instead. Nothing is lost: the save is intact and
  loads on a fresh bundle. Documented in `docs/inventory.md` under deploy.

## User-facing behaviour

### Inventory

- **Open/close:** the `inventory` action, default `I` (rebindable in Options).
  `Esc` also closes. Opening releases pointer lock and clears any held
  mouse button and mining progress, exactly as the play-time freeze does.
  Closing does not re-acquire pointer lock (the kid clicks the world, as after
  any Esc; Chrome may refuse a re-lock for ~1 s after the exit, as it already
  does after the colour picker).
- **Blocked** while the colour picker is open, and the colour picker is
  blocked while the inventory is open, so at most one overlay is up and `Esc`
  is unambiguous.
- **What it shows:** a full-screen dark translucent overlay (above the HUD,
  below the colour picker and the play-time freeze) with a scrollable grid of
  **48 px** tiles (the size of the hotbar slots he already knows), 4 px gap,
  one per catalog block except air and retired rows. Each tile shows the
  block's **north face** (`nz`): identical to a side for most blocks, and the
  face for furnaces and pumpkins. Tiles are ordered by **group** then by name;
  an uppercase group header (`BASICS`, `WOOD`, `STONE`, `WOOL`, …) at ≥ 18 px,
  full opacity, precedes each group. `BASICS` (the 19 blocks he already
  knows) is first. The grid keeps its scroll position across open/close.
- **Picking:** clicking a tile puts that block in the selected hotbar slot; the
  HUD updates at once and the slot in the overlay's own 9-slot strip pulses
  (scale + brightness, ~300 ms) on **every** pick, repeats included, so he sees
  where it went. Tiles do not keep keyboard focus (Space must not re-pick).
  Within a group, BASICS keeps hand order; every other group is sorted by
  label. Clicking the dark backdrop does nothing (unlike the colour picker). The inventory stays open. Clicking a
  strip slot selects it. Digit keys and Tab still change the selected slot
  while the inventory is open; nothing else on the keyboard does anything.
- **Label:** hovering a tile brightens its border (like the colour picker) and
  shows its name in a line above the strip (`Oak Planks`); the tile's `title`
  carries the same name.
- **While open:** the game loop is paused the same way the play-time freeze
  pauses it (physics, mining, simulation stop; chunks keep loading). The
  world stays visible behind the overlay.

### Hotbar

- Always 9 slots. An empty slot is `AIR` (id 0), drawn as a blank cell. Placing
  with an empty slot selected does nothing.
- **Default hotbar** for a new world is an explicit data list
  `DEFAULT_HOTBAR` (grass, dirt, stone, cobblestone, sand, oak planks, oak
  log, glass, white wool).
- **Saved per world** in the existing `PlayerSave.hotbar` / `selected` fields.
  Resolution rules (`resolveHotbar`, pure, tested):
  - `hotbar` missing, or not exactly 9 entries (every save written so far
    holds the 19-entry pool) → `DEFAULT_HOTBAR`; if the previously selected
    block is in it, it stays selected, otherwise slot 0.
  - exactly 9 entries → kept; any id that is not a live catalog block (unknown,
    air, or retired) → `AIR`.
  - `selected` outside 0..8 → 0.
  - Noah's existing worlds therefore come up with the default hotbar once;
    the parent should warn him.

### Blocks

New blocks behave like existing ones: solid, mineable (hardness by group),
placeable. Emissive blocks (glowstone via the existing lamp row, sea lantern,
shroomlight, froglights, jack o'lantern, magma, crying obsidian, lit redstone
lamp) emit white light through the existing `lightLevel` path (as lava does).
Leaves are cutout-transparent and tinted foliage green at build time. Stained
glass, tinted glass and ice are translucent and render through a new
front-face translucent pass (honey and slime are two-element models and are
not full cubes under rule 1). Leaves keep `lightFilter: 0`: in this engine
any filter ≥ 1 costs at least 2 levels per block and disables the straight-down
skylight case, which makes the ground under a tree cave-dark; the reason is
recorded in `docs/lighting.md`.

## Architecture

### Catalog files

```
src/data/blocks.base.data.ts       # BlockDef, BlockGroup, the 20 hand rows (ids 0–19, frozen), DEFAULT_HOTBAR
src/data/blocks.catalog.data.ts    # GENERATED, committed: rows with ids ≥ 20, emitted in id order
src/data/blocks.catalog.ids.json   # GENERATED, committed: { name: id } — the frozen id map
src/data/blocks.data.ts            # composes: BLOCKS = dense(BASE_BLOCKS, CATALOG_BLOCKS); helpers unchanged
src/data/catalog-rules.ts          # pure rules (classification, textures, dedupe, groups, ids); unit-tested
scripts/gen-catalog.ts             # I/O only: jar → rules → files
```

`blocks.catalog.data.ts` imports `type { BlockDef }` only (type-only, so a
broken generated file can never take the generator down with it). The
generator imports `blocks.base.data.ts`, `catalog-rules.ts`, and the ids
JSON, never `blocks.data.ts`.

`BlockDef` changes:

```ts
group: BlockGroup;        // inventory ordering
translucent: boolean;     // render in the translucent pass
retired?: true;           // tombstone: keeps the id, hidden from the inventory
// kidMode: removed
```

`BlockGroup`, in display order:

```
basics, wood, stone, earth, sand, ore, metal, wool, concrete, terracotta,
glazed, glass, light, nether, end, deepslate, coral, utility, other
```

The 20 base rows are `basics`.

**Dense array invariant.** `BLOCKS[i].id === i` for every `i`, asserted by
test. `blocks.data.ts` builds `BLOCKS` from the two lists by id and fills any
gap with a tombstone `{ id, name: 'retired_<id>', retired: true, solid: false,
transparent: true, textures: null, … }`, so a retired id renders as nothing
instead of shifting every later lookup. Engine helpers (`isSolid`,
`faceTexture`, lighting, shadows, atlas cache) stay positional.

### Generator rules (`catalog-rules.ts`, each a pure function with a unit test)

1. **Full cube.** Walk each variant model's `parent` chain to the first model
   with `elements`; the block qualifies only if every variant reaches a model
   with exactly one element spanning `from [0,0,0]` to `to [16,16,16]`.
   Multipart blockstates are excluded. (This admits glazed terracotta, whose
   parent is a template, and needs no parent-name list.)
2. **Variant.** The variant whose key contains `axis=y` (upright logs: the
   `axis=x` model of cherry and bamboo logs carries a sideways element), else
   `facing=north` (front on north for furnaces and dispensers), else the first
   in file order; unless the block is in `LOOK_OVERRIDES` (`redstone_lamp →
   redstone_lamp_on` with `lightLevel 15`).
3. **Faces.** From that element's `faces.{north,south,east,west,up,down}.texture`,
   dereference `#var` through the merged texture map up the chain, strip the
   `minecraft:block/` prefix. Map `north→nz, south→pz, east→px, west→nx,
   up→py, down→ny`. Then derive the kind from the six names: all equal →
   `uniform`; `py === ny` and four sides equal → `columnar`; four sides equal
   → `top-bottom-side`; otherwise `six`. A face whose texture cannot be
   resolved is a generator error for that block (listed, and fatal if the
   block is in the frozen id map).
4. **Exclude by name:** `command_block`, `chain_command_block`,
   `repeating_command_block`, `structure_block`, `jigsaw`, `test_block`,
   `test_instance_block`, `barrier`, `light`, `spawner`, `trial_spawner`,
   `vault`, `respawn_anchor`, `frosted_ice`, `reinforced_deepslate`, and any
   name starting `waxed_` or `infested_`.
5. **Dedupe.** Key = `(kind, six resolved names)`. The set is seeded with the
   base rows' keys, so a generated block that looks like a base row is dropped
   (glowstone → the existing lamp). Among generated blocks, the survivor is
   the **shortest name**, then alphabetical; losers are listed in a comment at
   the top of the generated file.
6. **Ids.** `GENERATED_ID_START = 20`, a constant, never `BASE_BLOCKS.length`.
   The generator loads `blocks.catalog.ids.json` (`{ ids: {name: id},
   retired: [names] }`); every existing name keeps its id; new names take
   `max(id) + 1` in name order. A name in the map that no longer resolves is a
   **hard error** naming the block, unless the run passes `--retire <name>`;
   the retirement is then **recorded in the file**, so later runs need no
   flag, and the row is emitted as a tombstone. A retired name that resolves
   again is un-retired with its old id. Ids are never reused. The generated
   file is emitted in id order and formatted through prettier by the
   generator itself, so a second run is byte-stable. Future hand-written
   blocks are added to a `HAND_ROWS` list in `catalog-rules.ts` and take ids
   from the same map.
7. **Transparency.** After cropping animated strips to frame 0, `sharp` scans
   each face texture. Any alpha < 255 → `transparent: true, lightFilter: 0`;
   any alpha strictly between 0 and 255 → also `translucent: true`; otherwise
   `lightFilter: 15`.
8. **Group.** First matching token in this order: `glazed` (glazed_terracotta)
   → glazed; `stained_glass`/`glass`/`ice` → glass; `_wool` → wool;
   `_concrete` → concrete; `terracotta` → terracotta; `coral` → coral;
   `glowstone`/`sea_lantern`/`froglight`/`jack_o_lantern`/`redstone_lamp`
   → light; `deepslate`/`tuff`/`sculk` → deepslate; `end_`/`purpur`/`chorus`
   → end; `netherrack`/`nether_`/`soul_`/`basalt`/`blackstone`/`magma`/`shroomlight`/
   `warped`/`crimson`/`ancient_debris` → nether; `_ore`/`raw_` → ore;
   `copper`/`iron_block`/`gold_block`/`diamond_block`/`emerald_block`/`netherite`/
   `lapis_block`/`redstone_block`/`coal_block`/`amethyst` → metal;
   `_planks`/`_log`/`_wood`/`_stem`/`_hyphae`/`_leaves`/`bookshelf`/`bamboo`
   → wood; `furnace`/`smoker`/`_table`/`loom`/`barrel`/`jukebox`/`note_block`/
   `target`/`bone_block`/`beehive`/`bee_nest`/`dispenser`/`dropper`/`observer`/
   `composter`/`lodestone`/`crafter` → utility; `stone`/`brick`/`andesite`/
   `diorite`/`granite`/`cobble`/`prismarine`/`quartz`/`calcite`/`dripstone`/
   `obsidian`/`bedrock`/`packed_mud`/`resin` → stone; `sand`/`gravel`/`clay`
   → sand; `dirt`/`grass`/`mud`/`moss`/`mycelium`/`podzol`/`snow`/`hay`/`melon`/
   `pumpkin`/`sponge`/`honey`/`slime`/`dried_kelp` → earth; else other. The
   boundary reviewer ran an earlier order over the real names; this order puts
   `sandstone`, `mossy_cobblestone`, `packed_mud`, `resin_bricks` under stone,
   `ancient_debris` under nether, and leaves fewer than ten names in other.
9. **Hardness by group:** wool/glass/glazed/earth/sand/coral 0.3, leaves 0.3,
   wood/concrete/terracotta/utility/light/other 0.8,
   stone/deepslate/nether/end 1.2, metal/ore 1.5.
10. **Light:** `{sea_lantern: 15, shroomlight: 15, jack_o_lantern: 15,
    ochre_froglight: 15, verdant_froglight: 15, pearlescent_froglight: 15,
    magma_block: 3, crying_obsidian: 10, redstone_lamp: 15}`; else 0.
11. **Labels:** Title Case of the name with underscores as spaces.

`npm run gen-catalog` runs the generator by hand (`MINECRAFT_JAR` overrides
the default path). It is **not** part of `npm run build`. It ends by
printing counts (qualified, deduped, excluded, new, retired) and the list of
any unresolved blocks.

### Atlas builder (`scripts/build-atlas.ts`)

- **1024 px atlas, 32 px cells** (16 px tile + 8 px edge-replicated padding),
  1024 cells. Power-of-two cell alignment keeps mip levels 1–3 inside a
  tile's own padding; the current 20 px cells bleed neighbouring tiles from
  mip 3 up, which with ~410 tiles and cutout leaves scattered through the
  grid would show as colour fringes and alpha holes at distance.
- **Animated strips** (PNG taller than wide) are cropped to frame 0 instead of
  squashed. This also fixes today's water and lava, which are a resized smear
  of every frame.
- `TEXTURE_TINTS` gains the grayscale foliage masks: `oak_leaves`,
  `jungle_leaves`, `acacia_leaves`, `dark_oak_leaves`, `mangrove_leaves` →
  `#77ab2f`; `birch_leaves` → `#80a755`; `spruce_leaves` → `#619961`.
- The HUD and inventory read `size`/`tileSize` from `atlas.json`, so no UI
  code changes for the new size.

### Engine: 16-bit ids and the translucent pass

- `Chunk.blocks: Uint16Array`; `RawChunk.blocks: Uint16Array`; the legacy v1
  reader copies bytes into a `Uint16Array`.
- Both codecs (`src/persistence/codec.ts`, `api/src/codec.ts`) write
  `[varint value, varint run]` and decode into `Uint16Array`. Hardening in
  both `decodeChunk`s, applied to the varint **before** the typed-array store
  (a bound checked after the store is masked away and can never fire):
  `value > 0xffff → throw`; `oi + run > BLOCKS_PER_CHUNK → throw` before the
  fill (a crafted run of 0x0ffffff0 otherwise burns 240 ms per chunk on the
  function); `readVarInt` caps `shift` at 28 and throws past it.
- `api/src/handlers.ts` keeps its checks unchanged (the length check is now
  redundant but harmless). It does not validate ids against the catalog.
- `api/src/handlers.ts` `/health` returns `{ ok: true, codec: 2 }`;
  `deploy.sh --verify` asserts `codec == 2`.
- `localStorage.ts` `parseChunkPayload`: the bare-base64 legacy fallback runs
  only when `JSON.parse` failed, so a decode error inside a JSON payload
  propagates as itself.
- **Translucent pass.** `ChunkMeshResult` gains a third bucket
  `translucent`; the renderer gets a third material (same atlas,
  `transparent: true`, `FrontSide`, `depthWrite: true`, `alphaTest: 0.01`)
  and a third mesh map; liquid meshes get `renderOrder = 1` so glass (which
  writes depth) draws before water. The mesher routes `def.translucent` blocks there with
  full-cube faces under the same `shouldEmitFace` rule glass uses; the opaque
  bucket skips them. Reusing the liquid material was rejected: its
  `DoubleSide` + `depthWrite: false` draws the far inner faces of a glass cube
  through the near one (0.40 alpha becomes ~0.64 with ghosted seams; the
  engine reviewer reproduced it headless).

### Player, HUD, main

- `src/game/hotbar.ts`: `resolveHotbar(saved, savedSelected, blocks)` per the
  rules above; `DEFAULT_HOTBAR` in `blocks.base.data.ts`.
- `Hud.setHotbar` unchanged except the icon face becomes `nz` to match the
  inventory tiles.
- `main.ts` right-click path returns early when the selected id is `AIR`.
- `keybindings.data.ts`: `Action` gains `'inventory'`, default `KeyI`, label
  `Open Inventory`, after `pickLightColor`. `Options.kidMode` removed;
  `loadOptions` ignores a stored `kidMode`.
- `ColorPicker` gains `readonly isOpen`.
- **Pause ownership**, hoisted above the play-time block so it exists whether
  or not a limit is set: `let frozen = false, inventoryOpen = false;
  const updatePaused = () => { loop.paused = frozen || inventoryOpen; };
  const resetKeys = …`. The play-time `freeze` sets `frozen = true`, closes
  the inventory (`inventoryOpen = false`), then `updatePaused()`; `resume`
  sets `frozen = false` and `updatePaused()`.
- **Input gating** is a pure function `shouldHandleKey(down, action, {frozen,
  inventoryOpen, pickerOpen})` in `src/game/input-gate.ts`, unit-tested;
  `onKey` calls it. The table:
  - keyup for `forward/back/left/right/jump` is processed in every state, so
    `keys` stays truthful (a W held across an `I` press must not stick);
  - keydown: if `frozen` → ignored; else if `inventoryOpen` → only `inventory`
    and `slot1..9`; else if `colorPicker.isOpen` → `inventory` ignored (the
    rest is already the picker's business); else everything.
  - The Tab listener: ignored when `frozen`, allowed when `inventoryOpen`.
  - `mousedown`: ignored when `loop.paused` (unchanged).
  - `Escape` while `inventoryOpen` closes it (a listener inside the inventory).
- `autosave.markDirty()` on every pick; the snapshot already carries `hotbar`
  and `selected`.

### `src/ui/inventory.ts` (DOM only)

```ts
export class Inventory {
	constructor(container: HTMLElement, atlas: LoadedAtlas, blocks: BlockDef[]);
	onPick: ((id: BlockId) => void) | null;
	onSelectSlot: ((slot: number) => void) | null;
	onClose: (() => void) | null;                    // Esc
	open(): void;
	close(): void;
	readonly isOpen: boolean;
	setHotbar(ids: BlockId[], selected: number, flashSlot?: number): void; // mirrors Hud.setHotbar; pulses flashSlot
}
```

Builds the grid once from `blocks.filter(b => b.id !== AIR && !b.retired)`,
tiles as `background-image` from the atlas PNG positioned by
`atlas.tileRect(id, 'nz')`, exactly as `Hud.setHotbar` does. `#inventory-root`
is `position: fixed; inset: 0; z-index: 15`, hidden with the shared `.hidden`
class. Grid: `display: grid; grid-template-columns: repeat(auto-fill, 48px);
gap: 4px; max-height: 72vh; overflow-y: auto`; headers span all columns.

### Wiring sequence

```
kid presses I (picker closed, not frozen)
  main: inventoryOpen = true; updatePaused(); loop.setLeftMouseDown(false);
        hud.setMiningProgress(0); exitPointerLock (if held); inventory.open()
kid clicks "Oak Planks"
  inventory.onPick(id) → player.hotbar[player.selected] = id;
                         hud.setHotbar(...); inventory.setHotbar(...); autosave.markDirty()
kid presses 3
  main onKey (inventoryOpen: slot keys allowed) → player.selected = 2; hud + inventory updated
kid presses I or Esc
  main: inventory.close(); inventoryOpen = false; updatePaused(); resetKeys()
play-time freeze fires while open
  freeze(): inventory.close(); inventoryOpen = false; frozen = true; updatePaused(); …
```

## Error handling

- Saved hotbar id that is unknown, air, or retired → `AIR` (see Hotbar).
- A chunk with an id ≥ `BLOCKS.length` (a save from a newer build): the mesher
  and lighting already treat unknown ids as non-solid/transparent via
  `BLOCKS[id]?.`; the engine reviewer is asked at gate 2 to confirm the
  shadows and liquid paths do the same, since a corrupt payload can now carry
  65535.
- Generator: missing jar → error naming `MINECRAFT_JAR`; unresolved texture on
  a frozen name → hard error (see rule 6); on a new name → skipped and listed.
- Atlas capacity exceeded → the existing build-time error.

## Testing

Unit (vitest, node; `vitest.config.ts` include unchanged because the pure
rules live under `src/`):

- `src/data/catalog-rules.test.ts`: full-cube walk (cube_all, template
  chain, a stairs model rejected, multipart rejected); face resolution with
  `#` indirection (`orientable` bottom→`#top`, `cube_column` `#end`,
  glazed `#pattern`), kind derivation for all four kinds, an unresolvable
  face; exclusion list; dedupe seeded with base keys, shortest-name survivor;
  id freezing (existing kept, new appended, missing name → error, `--retire`
  → tombstone, never reused); every group rule against a fixed list of ~40
  real names with expected groups; hardness/light/label maps. Synthetic
  models as inline JSON; alpha classification with 2×2 PNGs via `sharp`.
- `src/data/blocks.catalog.test.ts`: over the committed files — `BLOCKS[i].id
  === i` for all i; unique names; base ids 0–19 unchanged (snapshot of
  name→id); ids JSON matches the generated rows; every referenced texture
  exists in `src/assets/blocks/`; every group is in the union; `DEFAULT_HOTBAR`
  names all exist; a snapshot of ten known name→id pairs.
- `src/persistence/codec.test.ts` and `api/src/codec.parity.test.ts`
  (**named checklist item**: `api/` tests are type-checked by nothing, so
  the fixtures must be changed to `Uint16Array` and the high-id case added
  by hand): ids 200, 255, 256, 353, 65535 round-trip; a legacy chunk with
  one id 256 round-trips; the **inflated RLE byte stream** of an all-<128
  chunk equals a literal byte list captured from the current code (asserting
  on the deflate output would couple the test to `pako`); `decodeChunk` of a
  captured legacy base64 string equals the expected blocks; over-length run,
  value > 0xffff, and a 5-byte varint each throw.
- `src/persistence/localStorage.test.ts`: a JSON payload whose chunk fails to
  decode rejects with the decode error, not `InvalidCharacterError`.
- `src/game/hotbar.test.ts`: every `resolveHotbar` rule.
- `src/engine/world/mesher.test.ts`: a translucent block emits in the
  translucent bucket only; its opaque neighbour still emits a face toward it;
  two adjacent identical stained glass blocks emit no shared face.
- Fixture churn from `Uint8Array` → `Uint16Array`: `cloud.test.ts:144`,
  `dual.test.ts` (5 sites), `localStorage.test.ts`, `codec.test.ts`,
  `generation.test.ts:91` (`hashBytes` signature), `api/src/testFixtures.ts`.
  All fail loudly (vitest distinguishes typed-array constructors).

Manual, `localhost:5173` only, with the API redeployed first:

- Press I: overlay, `BASICS` first, ~340 tiles; pointer lock released; W does
  nothing; world visible. Click a tile: slot fills in HUD and strip, strip
  slot flashes. Press 5, click another: slot 5 fills. Esc closes; I reopens at
  the same scroll position. Reload: hotbar persists.
- Place: glowstone-lamp (lights), oak leaves (see-through, green), blue
  stained glass (see-through, blue, no double-dark inner faces when two are
  stacked), oak log (bark, rings), jack o'lantern (face visible, lights),
  cyan glazed terracotta (pattern), red concrete. Reload: same look. Save
  indicator green, cloud leg ok.
- Open a world saved before this change: default hotbar; world unchanged.
- Press C, then I: nothing opens; close the picker, I works. Play-time freeze
  while open: inventory closes, freeze shows.
- `./deploy.sh --verify` prints `codec: 2`.

## Files

| File | Change |
|---|---|
| `src/data/blocks.base.data.ts` | new: types, 20 base rows, `DEFAULT_HOTBAR`, `GENERATED_ID_START` |
| `src/data/catalog-rules.ts` + test | new: pure generator rules |
| `src/data/blocks.catalog.data.ts`, `blocks.catalog.ids.json` + test | generated, committed |
| `src/data/blocks.data.ts` | composes dense `BLOCKS`; helpers unchanged |
| `scripts/gen-catalog.ts` | new: jar I/O, `--retire` |
| `scripts/build-atlas.ts` | 1024/32/8, frame crop, leaf tints |
| `src/data/keybindings.data.ts` | `inventory` action; `kidMode` removed |
| `src/persistence/options.ts` + test, `src/ui/options.ts` | kid mode removed |
| `src/engine/world/chunk.ts` | `Uint16Array` |
| `src/persistence/codec.ts` + test, `api/src/codec.ts` + parity test | varint value, hardening |
| `src/persistence/adapter.ts`, `localStorage.ts` + test, `cloud.test.ts`, `dual.test.ts` | `Uint16Array`, fallback fix |
| `api/src/handlers.ts`, `api/src/testFixtures.ts`, `deploy.sh` | `codec: 2`, verify |
| `src/engine/world/mesher.ts` + test, `src/engine/render/renderer.ts` | translucent bucket + material |
| `src/engine/world/generation.test.ts` | `hashBytes` signature |
| `src/game/hotbar.ts` + test | `resolveHotbar` |
| `src/ui/inventory.ts`, `src/ui/ui.css`, `src/ui/color-picker.ts` | overlay, `isOpen` |
| `src/main.ts` | pause ownership, gating, wiring, AIR guard |
| `package.json` | `gen-catalog` script |
| `docs/inventory.md`, `docs/lighting.md`, `README.md`, `docs/specs.md`, `CLAUDE.md` | docs; kid-mode and hotbar-is-inventory lines retired; regen + deploy recipe |
