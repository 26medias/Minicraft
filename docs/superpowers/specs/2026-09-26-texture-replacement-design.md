# Texture replacement: Mojang out, CC BY-SA in — design (rev 2, 2026-09-26)

Status: **rev 2, gate-1 findings incorporated** (rigour, engine, boundary, player lenses). Branch `textures`
(worktree off `main` @ 8c7aec3). Background: `docs/texture-replacement-research.md`. Candidate map:
`docs/texture-fill-map.md` (historical; after this change `src/data/texture-sources.data.ts` is the truth).

## 1. Goal and scope

Every block texture under `src/assets/blocks/` becomes free-licensed art with recorded provenance. The
game's block look changes. Nothing else does: block ids, catalog rows and flags, saves, the multiplayer
protocol and gameplay stay untouched.

Scope is **block textures and the crack overlay only**. "No Mojang pixels" is a claim about `src/assets/blocks/`,
not the whole bundle (§10 lists the skins and menu art).

**User decisions:**
- 2026-09-24: base pack **Pixel Perfection CE**, gaps from **Bauniclonia and/or REFI**. AI/generated art,
  blockgen and Tiny Pixels rejected.
- 2026-09-26: **the GitHub repo stays public**, and history is not rewritten. Old commits keep serving the Mojang
  files. The new tree carries a licence notice (§4.5).
- 2026-09-26: **TNT side is Pixel Perfection's bomb crate** (`tnt_side2`), not the X.
- Standing rule: the user approves the look before merge (§8).

## 2. Non-goals

- No new or removed blocks, no id or catalog-row changes, **no `gen-catalog` rerun**.
- No animation (the atlas stays frame 0, as today).
- Skins, menu art, old bundles on the bucket, git history: §10.

## 3. Inventory (re-derived by the rigour reviewer)

| Set | Count |
|---|---|
| Textures referenced by non-retired `BLOCKS` | 448 |
| Crack overlay `destroy_stage_0..9` (loaded by `crack-overlay.ts`; Pixel Perfection CE has all 10) | 10 |
| Pixel Perfection CE, same name, kept | 314 (337 − 23 traced) |
| Fill from Bauniclonia/REFI | 121 |
| Derived (§5.4) | 13 + `copper_ore` |
| Mojang files deleted (unused) | 625 |

None of the 314 kept Pixel Perfection tiles scores above 0.8 on the trace metric (§6), and the highest pixel
identity is 0.39. Several rows move off Pixel Perfection for **looks** (§5.5), not provenance.

## 4. Design

### 4.1 Source data — `src/data/texture-sources.data.ts`
One typed row per output PNG, **including the 10 crack stages**:
```ts
type Pack = 'ppce' | 'bauniclonia' | 'refi' | 'mineclonia';
type TextureSource =
  | { pack: Pack; file: string; grey?: true; alpha?: 'keep' }  // file = pack-relative path, frame 0
  | { over: string; pack: Pack; file: string }                   // overlay composited on another output row
  | { derive: 'tint'; from: string; tint: Rgb; targetLum?: number };
export const PACKS: Record<Pack, { repo: string; commit: string; licence: string; authors: string }>;
```
- `grey: true` desaturates before writing, for masks that the atlas tints (birch fallback).
- `alpha: 'keep'` skips normalisation (liquids, crack stages).
- Pinned commits: PP CE `28e38cab7c1f`, REFI `33f1f719930d`, Bauniclonia `77318ecabc04`,
  **Mineclonia `c1898e3951de`** (4th source: `sculk_catalyst_bottom`, the suspicious overlay).

### 4.2 Import script — `scripts/import-textures.ts` (by hand, like `gen-catalog`)
- Obtains each pack at its pinned commit: a shallow fetch into a temp dir, or `--packs-dir <dir>` to reuse local
  checkouts (no network).
- Writes every row as a 16×16 RGBA PNG (frame 0) to `src/assets/blocks/`, applying §5.
- Deletes every other `*.png` there.
- Writes `src/assets/blocks/SOURCES.json` with pack, commit, source path and the sha256 of the written file.
- **Refuses** (exits non-zero) when a row feeding an opaque block (`transparent: false`) has more than 5% of pixels
  with alpha < 255 and no `over`. This catches overlay-style sources such as `copper_ore`.
- `--sheet <name...>` renders `old | current | every pack candidate` for the named rows into a PNG, so a tile can
  be swapped without a dev server. Candidates come from the Mineclonia/VoxeLibre `Conversion_Table.csv` name map.
- PNGs and `SOURCES.json` are committed. The build never touches the network.

### 4.3 Atlas build — `scripts/build-atlas.ts`
- `TEXTURE_TINTS` changes per §5.2.
- Derived game tiles (`greyTint`) change per §5.6.
- The file-reading code is unchanged.

### 4.4 Credits — `public/CREDITS.txt`, and `CREDITS.md` at the repo root (same text)
- **Where it goes:** Vite copies `public/` into `dist/`. `public/atlas.*` stays git-ignored, and `CREDITS.txt` is
  tracked. The deploy notes (`docs/persistence.md`, the deploy memory) gain "upload `CREDITS.txt`".
- **Visible link:** the pause menu gets a small "Texture credits" link to `CREDITS.txt`, so attribution can be
  reached from inside the game.
- **Content:**
  - each pack with its authors (XSSheep and the Pixel Perfection CE contributors; MysticTempest; Mirtilo;
    Mineclonia contributors and Nova Wostra (Pixel Perfection Legacy)), its URL and pinned commit, and its licence
    with URI (CC BY-SA 4.0; Mineclonia's non-PP files are BY-SA 3.0, which is adapted under 4.0);
  - the warranty disclaimer;
  - **a modification notice**: tiles were cropped to frame 0, alpha-normalised, some desaturated, tinted,
    composited or recoloured (the list is generated from the data rows).

### 4.5 Licence notice in the repo
- `src/assets/blocks/LICENSE.md` states that the PNGs in that folder are adaptations under CC BY-SA 4.0, see
  `CREDITS.md`.
- The README licence section says the same.
- `public/atlas.png` is a **collection** of those tiles. Share-alike attaches to the tiles, not to the atlas
  arrangement or the game code, and the notice says so.

### 4.6 Docs updated
- The CLAUDE.md Assets section.
- README: the Textures line, the tree comment and the licence section.
- `docs/specs.md`: the Mojang risk is resolved for blocks, not for skins.
- `docs/inventory.md`: the new add-a-block procedure — data row → `import-textures` → `gen-catalog` (which now
  reads the new art's alpha).
- `docs/crafting.md` (Slime Pad wording), `docs/liquids.md` (water is no longer tinted).
- The "Mojang" comments in `atlas-derive.ts` and `build-atlas.ts`.

## 5. Rules

### 5.1 Alpha, measured against what each tile is for
The catalog's `transparent` and `translucent` flags are **not** a faithful description of pixels. On `main` today,
water, lava and `slime_pad` already disagree with their tiles. The rule is per row:
- **Liquids** (any block with `liquid !== 'none'`) and **crack stages**: `alpha: 'keep'`, as drawn. Water keeps
  Pixel Perfection's 185; lava is opaque.
- **Opaque blocks** (`transparent: false`): alpha forced to 255. Transparent pixels (≤ 5%, guarded by the §4.2
  refusal) take their nearest opaque neighbour's colour. This fixes `slime_pad` (PP alpha 140), which also stops
  its faded inventory icon.
- **Cutout** (`transparent && !translucent`: leaves, grates, bars, flowers): alpha snapped to 0/255 at 128.
- **Translucent** (stained glass, ice, tinted glass): kept, with at least one partial-alpha pixel required.
- A texture shared by blocks with different flags: the importer fails loudly. None exist today.

**Test (`texture-alpha.test.ts`):**
- For every non-retired, non-liquid block, `classifyAlpha` over its face files matches its flags.
- Crack stages and liquids are skipped by name.
- `DERIVED_TEXTURES` entries (no file) are checked through their source row.

### 5.2 Tints: only grey masks get tinted
- **Metric:** mean HSV saturation over pixels with alpha > 0. The masks measure 0.19–0.23 (oak, jungle, mangrove,
  grass top); pre-coloured tiles measure 0.32 and up.
- **Rule:** a texture may be in `TEXTURE_TINTS` only if its saturation is < 0.27.
- **Expected result:**
  - keep grass_block_top, oak, jungle and mangrove leaves;
  - **remove** water_still (PP teal), dark_oak and spruce leaves (already green; tinting makes them near-black),
    and acacia (olive, sat 0.35; confirmed at the look review);
  - birch: take Bauniclonia's `mcl_core_leaves_birch`, a pale mask, and **keep** the birch tint. PP's birch is
    autumn orange, which the kid would read as wrong.

**Test (`texture-tints.test.ts`):**
- (a) Every tinted texture has saturation < 0.27.
- (b) Every `*_leaves` and `grass_block_top` texture with saturation < 0.27 is tinted, **or** is on
  `UNTINTED_GREY = ['pale_oak_leaves']` (grey by design).
- (c) After tinting, every leaves texture has mean saturation > 0.25 and mean luminance > 40, so it is neither
  grey nor near-black foliage.

### 5.3 Ores must stay findable
Every `*_ore` texture must have at least 12 pixels at CIE-Lab ΔE > 25 from its host stone's mean colour. The host
is stone, deepslate or netherrack, by name.
- Bauniclonia's `deepslate_coal_ore` has 0 such pixels, so that row takes **REFI**.
- **Test:** `texture-ores.test.ts`.

### 5.4 Overlays and derivations (14 rows)

| Texture | Row |
|---|---|
| `copper_ore` | `over: 'stone'`, Bauniclonia `mcl_copper_ore` (it is a Luanti overlay: 73 transparent pixels) |
| `muddy_mangrove_roots_side/top` | `over: 'mud'`, **Bauniclonia** `mcl_mangrove_roots_side/top` (brown; REFI's are dark green) |
| `suspicious_sand_0`, `suspicious_gravel_0` | `over: 'sand'/'gravel'`, Mineclonia `mcl_sus_nodes_suspicious_overlay`, overlay alpha ×3 (at its drawn max of 48 it is invisible) |
| `sculk_catalyst_bottom` | Mineclonia `mcl_sculk_catalyst_bottom` (trace score 0.48) |
| `ochre/verdant/pearlescent_froglight_side` (top = the same tile) | `derive: 'tint'` from `shroomlight`, saturated tints `#f2c14e` / `#7fd36b` / `#e4a6e8`, target luminance 150 (§5.6) |
| `creaking_heart_awake`, `…_top_awake` | `derive: 'tint'` from `pale_oak_log` / `pale_oak_log_top`, darkened. Accepted as a plain dark log (the eye is lost). |

**Test:** every derived tile keeps a luminance standard deviation above 8, so no tile collapses to a flat swatch.

### 5.5 Fill choice and look swaps
**Default:**
- When both fill candidates are clean (trace score ≤ 0.8), take Bauniclonia: its palette sits closer to Pixel
  Perfection.
- Otherwise take the clean one.
- When both are flagged (`cherry_log_top`, `pale_oak_log_top`), take the lower score, and the audit records a
  verdict (both are Mineclonia-lineage ring tiles).

**Rows moved off Pixel Perfection for looks (player review):**

| Texture | New source | Reason |
|---|---|---|
| `iron_block` | REFI `default_steel_block` | PP's is black, ΔE 6 from `coal_block` |
| `clay` | Bauniclonia `default_clay` | PP's is brick-red, ΔE 8 from `bricks` |
| `deepslate_coal_ore` | REFI | §5.3 |
| `birch_leaves` | Bauniclonia mask | §5.2 |
| `tnt_side` | PP `tnt_side2` (bomb, user choice) | — |
| `tnt_top` | PP `tnt_top2` | matches the bomb crate |
| `tnt_bottom` | PP `tnt_top1` | PP `tnt_bottom` is traced; Bauniclonia's reads as brick; REFI's breaks the TNT hue test (0.2°) |

The TNT tiles are finalised against the §5.6 tests and the look review.

### 5.6 Derived game tiles: gain from luminance, not a constant
`greyTint` uses `TINT_GAIN = 1.8`, tuned for Mojang TNT at luminance ~100. On the new art it fails the existing
hue tests (Big TNT bottom 199.5 ≤ 200, tunnel top 183) and flattens the froglights (shroomlight luminance 198
clips 100%).
- **Change:** the gain per source is `targetLum / meanLum(source)`, with `targetLum` defaulting to today's
  effective 180.
- **New test:** at most 10% of a derived tile's pixels clip (any channel at 255), and its luminance standard
  deviation stays above 8.
- The existing hue tests stay unchanged and must pass.

### 5.7 Known look differences, recorded for the user
- Spruce and dark oak planks are close (ΔE 6), and so are oak and jungle (7).
- Glass is a window with a wooden cross.
- Concrete shares wool's texture.
- Stone, sand and gravel are warmer.

These are shown at the look review, and each is a one-row swap.

## 6. Provenance checks

**In `npm test`** (the repo has no CI, so this runs locally):
- The set of `*.png` files in `src/assets/blocks/` equals the `texture-sources` rows, and each sha256 matches
  `SOURCES.json`.
- **No shipped tile equals Mojang:** `src/data/mojang-tile-hashes.json` holds sha256 hashes of Mojang's decoded
  16×16 RGBA frame-0 tiles. These are hashes, not pixels. No shipped tile's decoded hash may match one.
- **The 23 traced names** may never have `pack: 'ppce'`.

**Pre-merge gate, run by hand:**
1. `scripts/audit-textures.ts` reads the local Minecraft jar and reports every shipped tile's trace score
   (correlation of mean-removed, alpha-weighted luminance; unrelated tiles stay below ~0.5). Every tile above 0.8
   needs a written verdict in the merge note. Tiles that are ≥ 95% pixel-identical must be 0.
2. **Re-import reproducibility:** run `import-textures` from the pinned commits into a clean tree, then check that
   `git diff --exit-code src/assets/blocks` passes. Only this proves the files came from the packs, since the
   set/hash test cannot.

## 7. Existing tests

- `atlas-derive.test.ts`: the hue tests are unchanged and must pass after §5.6. A failure is fixed through the
  source choice or the gain model, not by weakening the assertion.
- `blocks.catalog.test.ts:38`: every catalog texture exists. Still holds.
- `packages/minicraft-bot/test/guard.test.ts:36`: `stone.png` still exists.

## 8. Look approval before merge (concrete)

1. **Old-vs-new sheet of all 458 tiles:** published as a **private** artifact, since it contains Mojang tiles for
   reference.
2. **In-game screenshots** at `localhost:5173`:
   - Playwright headless, with the production save API blocked as in the existing smokes;
   - never the production site, never a headed browser;
   - saved to `scratchpad/look/`;
   - scenes: spawn area, grassland, a birch forest, a deepslate mine face with ores, clay by water, a house of
     planks, glass, furnace and crafting table, a glass wall, a TNT and toys row, a wall of all 16 wools, and the
     14 derived tiles in the inventory.
3. **Recording approval:** the user's approval, and any row swaps, go in the merge commit message.
4. **Ordering:** the `lighting-look` worktree also changes the look. This texture look is approved first on
   `main`'s lighting; lighting approves on top of it.

## 9. Risks

- **Taste:** mitigated by §8, with one-row swaps and `--sheet`.
- **Mixed-pack clashes:** mitigated by the Bauniclonia-first rule and §5.5.
- **Alpha snapping at 128** may open holes in some cutout tile. §8 is the check; no automated test catches it.
- **Rollback** is re-uploading the previous bundle, which restores Mojang art. That is acceptable (user-owned
  deploy).

## 10. Follow-ups (not in this change)

- **Skins** (`src/assets/skins/`, fan skins, including a mostly-Mojang Enderman) and the menu art
  (`src/assets/menu/*.webp`, source unknown).
- **Old bundles on `gs://noah.leap-forward.ca`:** they still contain Mojang pixels (the crack stages are inlined
  into old `index-*.js` files). Deleting old `assets/*` is the user's call.
- **Git history:** the public repo keeps the Mojang PNGs in history (user decision 2026-09-26: leave it).
