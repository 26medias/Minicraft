# Texture replacement: Mojang out, CC BY-SA in — design (2026-09-26)

Status: draft, pre-gate-1. Branch `textures` (worktree off `main` @ 8c7aec3).
Background: `docs/texture-replacement-research.md`. Sources and the per-tile fill map: `docs/texture-fill-map.md`.

## 1. Goal

Every image under `src/assets/blocks/` becomes free-licensed art with recorded provenance. No Mojang
pixels ship in the bundle. The game's look changes. Nothing else does: block ids, catalog rows, saves,
multiplayer protocol and gameplay stay untouched.

**Decided by the user (2026-09-24):** base pack **Pixel Perfection CE**, gaps filled from **Bauniclonia
and/or REFI**. Rejected: generated/AI art, blockgen, Tiny Pixels. Standing rule: the user sees the new
look before it merges.

## 2. Non-goals

- No new blocks, no removed blocks, no id or catalog-row changes, **no `gen-catalog` rerun**.
- No animation (the atlas stays frame 0).
- Player skins (`src/assets/skins/`, unlicensed fan skins incl. a mostly-Mojang Enderman) and
  `src/assets/menu/{background,logo}.webp` (source unknown) are **out of scope**. They are listed in
  §10 as follow-ups.
- Git history still contains the Mojang PNGs. Rewriting history is **not** part of this work (§10).

## 3. Inventory (measured, not estimated)

| Set | Count | Source |
|---|---|---|
| Textures referenced by `BLOCKS` (non-retired) | 448 | `faceTexture` names that exist as files |
| Crack overlay `destroy_stage_0..9`, loaded directly by `src/engine/render/crack-overlay.ts` | 10 | Pixel Perfection CE has all 10 |
| From Pixel Perfection CE, same name | 314 | its 337 minus 23 dropped as traced |
| Fill from Bauniclonia/REFI (`docs/texture-fill-map.md`) | 121 | 71 clean in both, 48 REFI only, 2 flagged in both |
| No source in any pack | 13 | derived, §5.3 |
| Mojang files present but unused | 625 | deleted |

The 23 dropped Pixel Perfection tiles scored ≥ 0.81 on the traced-tile metric (§6): glazed terracotta ×7,
loom ×4, smithing table ×3, bee nest ×4, beehive ×3, lodestone_side, tnt_bottom.

## 4. Design overview

1. A **data file** `src/data/texture-sources.data.ts` gives each output texture name one source:
   - `{ pack: 'ppce' | 'bauniclonia' | 'refi' | 'mineclonia', file: string }` (a pack path, frame 0), or
   - `{ derive: ... }` (§5.3), built from other entries.
   Pure data, reviewable, one row per texture. Adding or changing a tile means editing a row.
2. A **by-hand import script** `scripts/import-textures.ts` (same model as `gen-catalog`):
   - Shallow-clones each pack at the **pinned commit** into a temp dir (a local checkout can be passed instead).
   - Writes `src/assets/blocks/<name>.png` for every row: frame 0, 16×16, RGBA, alpha normalised (§5.2).
   - Deletes every other PNG in `src/assets/blocks/`.
   - Writes `src/assets/blocks/SOURCES.json` recording, per file: pack, commit, source path and sha256
     of the written PNG.
   - The PNGs are committed. The build never touches the network.
3. **`build-atlas.ts` is unchanged except `TEXTURE_TINTS`** (§5.1).
4. **Credits:** `CREDITS.md` at the repo root (authors, licence, pack URLs and commits), and a copy in the
   built bundle at `/minicraft/CREDITS.txt` so the attribution travels with the published art.
5. **Docs updated:** the CLAUDE.md Assets section, README (Textures line, licence section), `docs/specs.md`
   (the "gate the subdomain until Mojang textures are replaced" risk is resolved), `docs/inventory.md`
   (jar extraction procedure → import script), `docs/crafting.md` (Slime Pad wording), `docs/liquids.md`
   (water tint), and the comments in `atlas-derive.ts` and `build-atlas.ts`.

## 5. Rules

### 5.1 Tints
`TEXTURE_TINTS` multiplies a tile by a colour. That is right only for greyscale masks.
- Keep a tint only where the new tile is near-grey: mean channel spread < 50 over opaque pixels.
- Measured in Pixel Perfection CE: grass_block_top 28, oak/jungle/acacia/dark_oak/spruce leaves 27–41 → keep.
  **water_still 91 and birch_leaves 113 → remove their tint entries.** mangrove_leaves (fill) 33 → keep.
- A test enforces the rule both ways: every tinted texture is near-grey, and every near-grey leaf,
  grass or water texture is tinted.

### 5.2 Alpha must agree with the committed catalog
The catalog's `transparent` and `translucent` flags came from Mojang's alpha and are not regenerated.
The renderer uses `alphaTest 0.5` for opaque and cutout blocks. The import normalises each tile against
the flags of every block that uses it:
- `transparent: false` → force alpha 255. Fully transparent pixels take the colour of their nearest
  opaque neighbour.
- `transparent: true, translucent: false` (cutout: leaves, grates, bars, flowers) → alpha snapped to 0/255
  at 128.
- `translucent: true` (stained glass, ice, tinted glass) → alpha kept as drawn. A test requires at
  least one partial-alpha pixel, so `classifyAlpha` still says translucent.
- Hand-written base blocks (glass, water, lava) follow their own flags the same way.

Test: for every non-retired block, `classifyAlpha` over its new face textures matches its committed flags.

### 5.3 The 13 with no source: derived, not retired
Retiring blocks would touch the catalog and players' inventories, so derive them from tiles we already import:

| Texture | Derivation |
|---|---|
| `muddy_mangrove_roots_side/top` | REFI `mcl_mangrove_roots_side/top` composited over the imported `mud` |
| `suspicious_sand_0`, `suspicious_gravel_0` | Mineclonia `mcl_sus_nodes_suspicious_overlay` over the imported `sand` / `gravel` |
| `sculk_catalyst_bottom` | Mineclonia `mcl_sculk_catalyst_bottom` (CC BY-SA 4.0, Pixel Perfection lineage) |
| `ochre/verdant/pearlescent_froglight_side/top` | The imported `shroomlight` greyed and tinted (existing `greyTint`); side and top share one tile |
| `creaking_heart_awake`, `creaking_heart_top_awake` | The imported `pale_oak_log` / `pale_oak_log_top` darkened (a tint), no new drawing |

Derived tiles are CC BY-SA too, since they are edits of CC BY-SA tiles. The user reviews them in §8.

### 5.4 Fill choice
Where both packs have a clean candidate (71 tiles), take **Bauniclonia**: its palette sits closer to Pixel
Perfection. Otherwise take the clean one. For the 2 flagged in both (`cherry_log_top`, `pale_oak_log_top`),
take the lower-scoring one and flag it for the user's eye. Every choice is a data row the user can flip.

### 5.5 Derived game tiles
`DERIVED_TEXTURES` (Big/Mega TNT, the toys, the Launch Pad) keep deriving from `tnt_*` and `slime_block`,
which are now the new art. `TINT_GAIN = 1.8` assumes TNT's mean luminance is about 100. The new TNT's
luminance is measured, and `TINT_GAIN` is re-derived if the hue tests or the look demand it.

## 6. Provenance checks

- **Traced-tile metric:** correlation of mean-removed, alpha-weighted luminance against the Mojang tile of
  the same name. Unrelated tiles stay below ~0.5, and above 0.8 is flagged.
- A by-hand script `scripts/audit-textures.ts` reads the Minecraft jar when present and reports:
  - the number of shipped tiles that are ≥ 95% pixel-identical to Mojang (**must be 0**);
  - every tile scoring > 0.8, each with a reviewed verdict recorded in `docs/texture-fill-map.md`.
  The jar is not in CI, so this is a pre-merge gate run by hand, with its output pasted into the PR / merge note.
- **CI test (no jar needed):** the set of files in `src/assets/blocks/` equals the keys of
  `texture-sources.data.ts` plus the 10 crack stages. So no unlisted file (e.g. a stray Mojang PNG) can
  exist, and every file's sha256 matches `SOURCES.json`.

## 7. Tests that must hold or change

- `atlas-derive.test.ts`: the TNT/toy/launch-pad hue assertions must pass on the new art. If one fails,
  fix it by retuning a tint in data, not by weakening the assertion.
- `blocks.catalog.test.ts:38`: every catalog texture exists. Still true.
- `packages/minicraft-bot/test/guard.test.ts:36` uses `stone.png`. Still exists.
- New: the tint rule (§5.1), the alpha agreement (§5.2) and the provenance set/hash (§6).

## 8. Verification before merge

1. `npm test`, `tsc -b`, `npm run build` green.
2. `scripts/audit-textures.ts` run with the jar: 0 identical, every flag reviewed.
3. **In-game look** at `localhost:5173`, with Playwright headless and the production save API blocked (as
   the existing smokes do). Screenshots of:
   - the spawn area;
   - a mine face with ores;
   - a house of planks, glass, furnace and crafting table;
   - leaves against the sky;
   - the 13 derived tiles in the inventory;
   - TNT variants.
   The user approves the look **before** merge.
4. Seam check: no new visible seams at block joins in the screenshots.

## 9. Risks

- **Taste:** the user called Pixel Perfection "decent". The in-game look may still disappoint. Mitigation: §8.3
  before merge; data rows make per-tile swaps cheap.
- **Mixed-pack style clashes** (REFI's bright bamboo, olive bee nest). Mitigation: Bauniclonia-first rule,
  user review.
- **Alpha normalisation** may cut holes or fill edges oddly on a few tiles. Mitigation: the tests catch the
  flag mismatch; the user checks the look.
- **Transparent CREDITS path under Cloudflare's cache**: a new static file, no cache headers needed.

## 10. Follow-ups (not in this change)

- Player skins and menu art provenance.
- History: the Mojang PNGs remain in git history, and `main` is pushed to GitHub. If the repo is or becomes
  public, a history rewrite is a separate, destructive decision for the user.
