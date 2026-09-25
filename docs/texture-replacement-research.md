# Texture replacement — model & tooling research (2026-09-24)

Goal: replace every Mojang block texture with original art so the project has no
copyright exposure (see `CLAUDE.md` § Assets). Research only — no pipeline built yet.

## The job

- `src/assets/blocks/` holds 1083 Mojang files; the catalog actually uses **448** of them
  (384 blocks). All 16×16. The other ~635 can simply be deleted.
- Roughly half the set is recolour families (wool, concrete, terracotta, glazed terracotta,
  stained glass, copper stages, wood species) and noise surfaces (stone, dirt, sand, deepslate,
  nether). Only ~30–60 tiles carry a *picture* (furnace, crafting table, TNT, bookshelf, flowers,
  saplings, doors, observer, crafter…).
- `atlas-derive.ts` already tints Mojang TNT/slime for Big/Mega TNT and the toys — those derive
  from Mojang too and must be re-pointed at the replacement sources.

## Finding 1 — minicraft-arcade is *not* a clean source (mostly)

| Where | Files | Provenance |
|---|---|---|
| `minicraft-arcade/src/assets/blocks/` | 1083 | **Byte-identical to our Mojang files** (sha256) |
| `minicraft-arcade/game/mods/core/textures/` (what it ships) | 23 | Mojang (20 identical, water/lava = frame 0, cactus ~89% identical) |
| `minicraft-arcade/tools/blockgen/out/` | 24 | **Original** — procedural, no image input, no AI pixels |

Arcade's own CLAUDE.md says `core` "ships the Minecraft-derived art" and the generated art is
"not installed yet". ⚠ So minicraft-arcade carries the same copyright issue as Minicraft.
Its item/loot sprites (commit `75bad34`, "extruded MC item sprites") are Mojang-derived too.

**The valuable part is `tools/blockgen/`** — Python + numpy + Pillow, ~430 lines:
- 7 families (grain, blades, cobbles, planks, bricks, bark, spots, + `cap`) operating on palette
  indices; each block is a `recipes.json` row (family + 5-colour palette + params) → data-driven,
  fits our "a block is a row" rule.
- **Seamless by construction** (wrapped value noise / wrapped Voronoi), deterministic per-block
  seeds, `--size 16`, `--check`, whole run ~0.1 s.
- Coverage today: 20 of our 448 (stone, cobblestone, dirt, grass, planks, oak log/leaves, sand,
  gravel, snow, obsidian, water/lava static…). Missing families: ore overlay, log rings,
  glass/frames, plants with alpha, machine faces, animated strips.
- Known weak spot (its own notes, confirmed on the contact sheet): at 16 px, the noise surfaces
  (dirt / path / sand / snow) differ only by colour. Cobbles, bricks, planks, and spots read well.

## Finding 2 — model landscape

No general diffusion model outputs a true 16×16 grid or seamless tiles. My probe
(gpt-image-1.5, one 4×4 sheet, ~$0.05) gave good, consistent *content*, but off-grid "pixels"
(~11–12 per tile), glow/gaps between cells, and a visible seam on 3×3 repeat.
It is fixable with slice → box-downscale → palette quantize → offset-blend, but it is work.

### Pixel-native services (best fit for AI tiles)

| Service | Native 16×16 | Seamless | Style lock | ~$/tile | Training data | Output terms |
|---|---|---|---|---|---|---|
| **Retro Diffusion** (API; also Replicate `rd-tile`, Scenario) | Yes (12–16 px styles) | Yes, `tile_x`/`tile_y`; `seam_tiling` repair | `input_palette`; Pro: ≤9 reference images | **$0.023** (small); Pro $0.18; free `check_cost` | **Licensed**, consenting pixel artists | "You own the images" (full ToS not rendered — verify) |
| **PixelLab** | Yes (Bitforge ≥32 px; Pro 16 px) | Tileset endpoints (Wang tiles, not self-wrap) | Forced palette, style refs | $0.007–0.095 | **Undisclosed** | You own; no training other models |

Sources: github.com/Retro-Diffusion/api-examples, astropulse.itch.io/retrodiffusion,
pixellab.ai/pixellab-api, pixellab.ai/termsofservice.

### Frontier general models (concept art, picture tiles, alpha)

| Model | $/img (1024²) | Notes |
|---|---|---|
| GPT Image 2.5 (medium) | ~$0.013 | Native transparent background (preview), reference-image edits; you own output |
| Nano Banana Pro / 2 | $0.07–0.14 | Best cross-reference consistency; no alpha (matte in post); grids uneven |
| Seedream 5.0 Lite | ~$0.035 | Up to 15 related images per call — set consistency without slicing |
| Recraft V4 | $0.04–0.10 | Custom style from refs; paid plan required to own output |
| FLUX.2 klein 4B / Qwen-Image | $0.0006–0.03 on Runware | Apache-2.0; no pixel-art evidence for FLUX.2 |

### Open weights (local GPU or Runware by Civitai AIR)

- **SD-πXL** (MIT): palette-constrained, target-resolution output. Best fit on paper; local only.
- Z-Image-Turbo + tarn59 pixel LoRA (Apache-2.0, `civitai:1770073@2454660`).
- Pixel Art XL (nerijs, SDXL). Seamless via ComfyUI circular-padding nodes (spinagon, OliverCrosby).
- Post-processing: unfake.js, proper-pixel-art, Astropulse/pixeldetector (all MIT).
- ⛔ **Avoid — trained on Mojang textures:** Civitai 607046, 55824, 57507 ("Minecraft … Texture/Block
  Generator"). Output from these defeats the purpose.

## Recommendation

**Procedural first, AI for the pictures.**

1. **Adopt `blockgen` as the backbone** (~75–85% of the 448). Copy it in (or port to a node script,
   ~1 day), rename outputs to our names, and add families: ore overlay (specks on a stone base),
   log rings, glass frame, recolour sets (wool/concrete/terracotta/glass/copper = 1 recipe × N
   palettes). Cost $0, seamless and consistent by construction, and legally trivial.
2. **Retro Diffusion API for picture tiles** (~30–60 tiles: machines, TNT, bookshelf, flowers,
   saplings, doors, glazed terracotta patterns). Text prompts only, `input_palette` = a palette
   exported from blockgen so both halves share colours, `tile_x/tile_y` on. ~4 candidates each
   → **~$5–15**. Even a full 448×4 run would be ~$41.
3. **GPT Image 2.5 as fallback** for transparent sprites/concepts, downscaled through the same
   quantize step (~$0.013/img, key already configured).
4. Hand-fix the last 10%. A 16×16 tile is 256 pixels.

Total realistic cash cost: **under $25.** Most of the effort is writing recipes and new families, not generation.

### Guard-rails (whichever tool)

- **Never feed a Mojang texture as input** (img2img, tile_variation, style reference). At 16×16, a
  restyle preserves composition, which makes it a derivative work. Seed only from our own tiles.
- **Similarity gate:** before accepting a tile, compare it to the Mojang tile of the same name
  (pixel-match % / perceptual hash) and reject near-copies. Retro Diffusion's `mc_texture` style
  aims at the Minecraft *look*; iconic blocks (ores, crafting table, TNT) can land too close by accident.
- Re-point `atlas-derive.ts` derived textures (TNT/slime tints) at the new sources.
- Keep the kid's worlds untouched: textures are render-only, block ids don't change.

## Next steps / decisions

- `RETRO_API_KEY` and `RUNWARE_API_KEY` are in `.env` (gitignored) and both verified. The
  content-gen-mcp server still holds an old, invalid Runware key.
- Suggested ~$5 bake-off before committing: the same 20 picture tiles through Retro Diffusion vs
  GPT Image 2.5 (+ PixelLab if keyed), all snapped to the blockgen palette.

## Update: the answer is a free hand-drawn pack, not a generator

**User verdict (2026-09-24, from the side-by-side scenes):**
- blockgen surfaces + Retro Diffusion picture tiles: **"awful, no way we use that"**. Rejected.
- GPT Image set: **"bad looking"**. Rejected.
- Pixel Perfection CE: **"not bad, decent option"**. Current lead.
- Standing instruction: use free textures where they exist, and show them before adopting.

Seen side by side in a scene (comparison artifact), blockgen, GPT Image and SDXL all read as
"crappy copies" next to Mojang (user verdict). The causes: per-pixel noise instead of designed 2–3 px
clusters, over-saturated colour, no consistent light direction, visible boxes at tile joins.

**Pixel Perfection CE** (github.com/Athemis/PixelPerfectionCE, original by Hugh "XSSheep" Rutland,
**CC BY-SA 4.0**) is a hand-drawn 16×16 Minecraft-style pack using Minecraft's own file names.
- Covers **337 of our 448** textures, name for name.
- **0 of the 337** is ≥95% pixel-identical to Mojang; none is even 60% identical. Its
  `content_with_issues.md` tracks accidental Mojang copies, and the only entry is a banner, which we don't use.
- Grass top, leaves and water are greyscale like Mojang's, so our existing `TEXTURE_TINTS` apply.
- Obligations: credit XSSheep and contributors; our edited or derived textures stay CC BY-SA 4.0.
  The code is unaffected.
- **Missing 111** (post-1.16 blocks): deepslate family and its ores, copper family, tuff, cherry, mangrove,
  bamboo, pale oak, sculk, froglights, raw metal blocks, moss, mud, calcite, dripstone, amethyst, crafter,
  resin. Next candidates: VoxeLibre / Mineclonia (both are built on Pixel Perfection, CC BY-SA 4.0, and
  add many of these); Pixel Perfection recolours; the ore overlay.

**⚠ Traced-tile audit (brightness-pattern correlation > 0.8 against Mojang; unrelated tiles do that ~1.5% of the time):**
Pixel Perfection CE has **23 likely-traced tiles** among our 337. They are glazed terracotta ×7 (green, light blue, red,
lime, pink, purple, yellow), loom ×4, smithing table ×3, bee nest ×4, beehive ×3, lodestone_side and tnt_bottom.
Drop them and fill from another pack. The identical-pixel check alone missed them, so every pack must get the
correlation check too. Planks, bricks, glass and log rings score 0.5–0.9 in every pack because of their shared structure.

**More candidates found (all on the comparison artifact):**
- **REFI** (Luanti, MysticTempest, CC BY-SA 4.0, "created from scratch"): ~4,500 files, covers all the
  newer families (deepslate, copper, cherry, mangrove, bamboo, tuff, sculk). Closest to the Mojang look. Uses Luanti
  names, so it needs a name map. Correlation audit done on 24 mapped tiles only; audit the full set before adoption.
- **Bauniclonia** (Luanti, CC BY-SA 4.0): brighter, work in progress (no water, tuff, sculk, amethyst).
- **Tiny Pixels** (Modrinth resource pack, CC BY-NC 4.0 label added by the current maintainer, no licence file):
  412/448, 0 traced. Chunky 8×8 bevelled style; the grid on stone and dirt is visible by design.
- Pastelcraft (MIT label, 1.12-era, no newer blocks), Yaysa 8x (CC BY), Soartex Grove (64x, NC-SA),
  CrayonCraft (scanned crayon) were also checked. Rejected as vanilla-derived despite open labels: M16x, Multipixel,
  Duzi Craft, Shadows Pixels Reforged, Clean Pack, 8x8-textures, Potato Craft, Mojang's own relabelled "concept" packs.
- **Paid (≤$20): nothing useful.** The largest is ~120 fantasy textures; nothing is Minecraft-complete.
  Free packs beat all of them.

**Ore overlay (user idea), prototyped:** lift Pixel Perfection's iron ore off its stone tile to get a
transparent mask, turn it grey, tint it per ore with a 3-stop ramp, and paste it on any base. Works on
stone, andesite, granite and netherrack. It would generate the deepslate and nether ores for free. One
shape for every ore loses character; plan for 2–3 shapes.

## Probe results (2026-09-24, ~$0.47 spent)

Same prompts, no Mojang input anywhere; the Mojang tile appears in the comparison only as a copy check.

| Candidate | Result |
|---|---|
| **Retro Diffusion `rd_mini__mc_texture`** (16×16 native, $0.023/img) | Crisp true-grid pixel art, no cleanup needed. **Furnace: 4/4 usable**, all visibly different designs from Mojang's. **Crafting table: 1/4 on-prompt** (tools), two came back as plain planks. **Poppy + `remove_bg`: 1/4 good**, one empty, one lost its background removal. → budget ~4 candidates per picture tile; the hit rate is roughly 50%. |
| Retro Diffusion `rd_pro__default` @16 ($0.18) | Good furnace, but with stray white corner pixels. Not 8× better than mini for tiles. |
| Runware SDXL + Pixel Art XL LoRA, 1024 → 16 box-downscale (~$0.0026/img) | Muddy after downscale, weak shapes. **Not recommended.** |
| gpt-image-1.5 4×4 sheet → slice → 16 px (~$0.05/sheet) | Good content and colours; needs the cleanup pass; seams on repeat. |
| Runware Z-Image + tarn59 pixel LoRA | LoRA not available on Runware (`invalidLoraModel`). |

⚠ **Similarity-gate lesson:** a naive "% of pixels within ΔRGB 30 of the Mojang tile" scores 20–36% for
*any* grey-stone tile (shared palette, not shared design). An RD furnace with an entirely different
layout scored 36%. The copy check has to compare structure (edges/dark-light layout, e.g. a
perceptual hash on luminance), not raw colour. Otherwise it flags innocent tiles and misses recoloured copies.

Runware also offers **Z-Image style-LoRA training** (`runware:z-image@style-lora-training`). One
option is to train a style on our own blockgen output. Not explored.

Retro Diffusion balance after the probe: **$0.04**. Top up before any real run.

Artifacts (scratchpad, not committed): gpt-image probe + 16 px slice + 3×3 tiling test;
blockgen 16/32 px contact sheet.
