# Texture sources — decision and fill map (2026-09-24)

Research record only; nothing is wired into the game yet. Background and rejected options are in
`texture-replacement-research.md`.

## Decision (user, 2026-09-24)

- **Base: Pixel Perfection CE.** For the tiles it lacks, fill from **Bauniclonia and/or REFI**.
- Rejected: blockgen procedural + Retro Diffusion ("awful"), GPT Image ("bad looking"), Tiny Pixels ("looks really bad").
- Standing rule: show any new textures to the user before adopting them.

## Sources (pin these commits)

| Pack | Repo | Commit | Licence | Naming |
|---|---|---|---|---|
| Pixel Perfection CE | https://github.com/Athemis/PixelPerfectionCE | `28e38cab7c1f` | CC BY-SA 4.0 (XSSheep + community) | Minecraft names, `assets/minecraft/textures/block/` |
| REFI Textures | https://github.com/MysticTempest/REFI_Textures | `33f1f719930d` | CC BY-SA 4.0 (MysticTempest), "created from scratch" | Luanti (`default_*`, `mcl_*`), in `textures/` subfolders; skip `alternate_textures/` |
| Bauniclonia | https://codeberg.org/mirtilo/Bauniclonia | `77318ecabc04` | CC BY-SA 4.0 (Mirtilo) | Luanti (`mcl_*`) |

Name map: Mineclonia's `tools/Conversion_Table.csv` (https://codeberg.org/mineclonia/mineclonia) and VoxeLibre's
`tools/Conversion_Table.csv` translate Minecraft resource-pack paths to Luanti file names. They covered 105 of the 134
fill tiles. The other 21 that exist were matched by hand (pale oak, resin, crafter, loom, dripstone).

**Licence obligations:** a credits file naming XSSheep and the Pixel Perfection CE contributors, MysticTempest (REFI)
and Mirtilo (Bauniclonia), with the licence link. Any texture we edit or derive (tints baked in, ore composites)
stays CC BY-SA 4.0. The game code is not affected.

## Coverage

| | Count |
|---|---|
| Textures Minicraft uses | 448 |
| Taken from Pixel Perfection CE | **314** (337 present, minus 23 traced) |
| To fill | **134** (111 missing + 23 traced) |
| — clean candidate in both packs | 71 |
| — clean only in REFI | 48 |
| — both candidates flagged, review by eye | 2 |
| — no source in either pack | **13** |

**Traced-tile check:** correlation of mean-removed, alpha-weighted luminance against the Mojang tile of the same name.
Unrelated tiles stay below ~0.5, and above 0.8 is flagged. Structural blocks (log-top rings, brick grids, planks) score
0.5–0.95 in *every* pack, so a flag on those means "look at it", not "traced". The 23 Pixel Perfection CE tiles dropped
scored 0.81–0.99 and are visibly traced: glazed terracotta ×7, loom ×4, smithing table ×3, bee nest ×4,
beehive ×3, lodestone_side, tnt_bottom.

### No source in either pack (13)

`ochre/pearlescent/verdant_froglight_side/top` (6), `creaking_heart_awake`, `creaking_heart_top_awake`,
`muddy_mangrove_roots_side/top`, `suspicious_sand_0`, `suspicious_gravel_0`, `sculk_catalyst_bottom`.

Options, to decide later:
- **Derive from CC BY-SA tiles we already have.** Froglights as recoloured tiles; muddy mangrove roots as
  mangrove roots composited over mud (both in REFI); suspicious sand and gravel as the plain block; sculk catalyst
  bottom from Mineclonia's `mcl_sculk_catalyst_bottom` (same licence).
- **Retire the blocks.** These are obscure and fit the project's "lean toward removing" rule. Retiring must keep
  block ids tombstoned, never renumbered.

### Other notes
- REFI `sculk` is a 16×48 animated strip. Take frame 0, or support animation.
- Grass tops and leaves in all three packs are tinted in game, so keep `TEXTURE_TINTS` in `scripts/build-atlas.ts`
  (Bauniclonia's leaves carry a faint colour but still need the tint). REFI's `default_grass_side` is a transparent
  fringe that must be composited over its dirt.
- Style: REFI's bamboo is bright green and its bee nest olive. Where both candidates are clean, Bauniclonia sits
  closer to Pixel Perfection's palette. The user chooses per family from the artifact's "Fill set" section.
- `atlas-derive.ts` tints (Big/Mega TNT, toys, launch pad) must be re-pointed at the new TNT and slime tiles.
- Ore overlay (user idea, prototyped on the artifact): one mask from Pixel Perfection iron ore, tinted per ore.
  Useful if deepslate or nether ore variants are ever missing. Today every ore we use has a source.

Visual review: comparison artifact (private; contains Mojang tiles, do not share)
https://claude.ai/artifact/V1uksV9qwbBKz23poRqAy5, section "Fill set".

## Fill map (134 tiles)

⚠ = traced-tile score above 0.8 (see above). "either" = both candidates clean.

| Minecraft name | Why | Bauniclonia | REFI | Clean choice |
|---|---|---|---|---|
| `amethyst_block` | missing in PP | — | `mcl_amethyst_amethyst_block` | REFI |
| `azalea_leaves` | missing in PP | `mcl_lush_caves_azalea_leaves` | `mcl_lush_caves_azalea_leaves` | either |
| `bamboo_block` | missing in PP | `mcl_bamboo_bamboo_block` | `mcl_bamboo_bamboo_block` | either |
| `bamboo_block_top` | missing in PP | `mcl_bamboo_bamboo_bottom` ⚠ 0.95 | `mcl_bamboo_bamboo_bottom` | REFI |
| `bamboo_mosaic` | missing in PP | `mcl_bamboo_bamboo_plank_mosaic` | `mcl_bamboo_bamboo_plank_mosaic` | either |
| `bamboo_planks` | missing in PP | `mcl_bamboo_bamboo_plank` | `mcl_bamboo_bamboo_plank` | either |
| `bee_nest_bottom` | traced in PP | `mcl_beehives_bee_nest_bottom` | `mcl_beehives_bee_nest_bottom` | either |
| `bee_nest_front` | traced in PP | `mcl_beehives_bee_nest_front` | `mcl_beehives_bee_nest_front` | either |
| `bee_nest_side` | traced in PP | `mcl_beehives_bee_nest_side` | `mcl_beehives_bee_nest_side` | either |
| `bee_nest_top` | traced in PP | `mcl_beehives_bee_nest_top` | `mcl_beehives_bee_nest_top` | either |
| `beehive_end` | traced in PP | `mcl_beehives_beehive_end` | `mcl_beehives_beehive_end` | either |
| `beehive_front` | traced in PP | `mcl_beehives_beehive_front` | `mcl_beehives_beehive_front` | either |
| `beehive_side` | traced in PP | `mcl_beehives_beehive_side` | `mcl_beehives_beehive_side` | either |
| `budding_amethyst` | missing in PP | — | `mcl_amethyst_budding_amethyst` | REFI |
| `calcite` | missing in PP | — | `mcl_amethyst_calcite_block` | REFI |
| `cherry_leaves` | missing in PP | `mcl_cherry_blossom_leaves` | `mcl_cherry_blossom_leaves` | either |
| `cherry_log` | missing in PP | `mcl_cherry_blossom_log` | `mcl_cherry_blossom_log` | either |
| `cherry_log_top` | missing in PP | `mcl_cherry_blossom_log_top` ⚠ 0.86 | `mcl_cherry_blossom_log_top` ⚠ 0.94 | review (both flagged) |
| `cherry_planks` | missing in PP | `mcl_cherry_blossom_planks` | `mcl_cherry_blossom_planks` | either |
| `chiseled_copper` | missing in PP | `mcl_copper_block_chiseled` | `mcl_copper_block_chiseled` | either |
| `chiseled_deepslate` | missing in PP | — | `mcl_deepslate_chiseled` | REFI |
| `chiseled_resin_bricks` | missing in PP | `mcl_pale_oak_chiseled_resin_bricks` | `mcl_pale_oak_chiseled_resin_bricks` | either |
| `chiseled_tuff` | missing in PP | — | `mcl_deepslate_tuff_chiseled` | REFI |
| `chiseled_tuff_bricks` | missing in PP | — | `mcl_deepslate_tuff_chiseled_bricks` | REFI |
| `chiseled_tuff_bricks_top` | missing in PP | — | `mcl_deepslate_tuff_chiseled_bricks_top` | REFI |
| `chiseled_tuff_top` | missing in PP | — | `mcl_deepslate_tuff_chiseled_top` | REFI |
| `cobbled_deepslate` | missing in PP | `mcl_deepslate_cobbled` | `mcl_deepslate_cobbled` | either |
| `copper_block` | missing in PP | `mcl_copper_block` | `mcl_copper_block` | either |
| `copper_bulb` | missing in PP | `mcl_copper_block_bulb_off` | `mcl_copper_block_bulb_off` | either |
| `copper_grate` | missing in PP | `mcl_copper_block_grate` | `mcl_copper_block_grate` | either |
| `copper_ore` | missing in PP | `mcl_copper_ore` | `mcl_copper_ore` | either |
| `cracked_deepslate_bricks` | missing in PP | — | `mcl_deepslate_bricks_cracked` | REFI |
| `cracked_deepslate_tiles` | missing in PP | — | `mcl_deepslate_tiles_cracked` | REFI |
| `crafter_bottom` | missing in PP | — | `mcl_crafter_bottom` | REFI |
| `crafter_east` | missing in PP | — | `mcl_crafter_side` | REFI |
| `crafter_north` | missing in PP | — | `mcl_crafter_front_off` | REFI |
| `crafter_south` | missing in PP | — | `mcl_crafter_back` | REFI |
| `crafter_top` | missing in PP | — | `mcl_crafter_top_off` | REFI |
| `crafter_west` | missing in PP | — | `mcl_crafter_side` | REFI |
| `creaking_heart_awake` | missing in PP | — | — | **no source** |
| `creaking_heart_top_awake` | missing in PP | — | — | **no source** |
| `cut_copper` | missing in PP | `mcl_copper_block_cut` | `mcl_copper_block_cut` | either |
| `deepslate` | missing in PP | `mcl_deepslate` | `mcl_deepslate` | either |
| `deepslate_bricks` | missing in PP | — | `mcl_deepslate_bricks` | REFI |
| `deepslate_coal_ore` | missing in PP | `mcl_deepslate_coal_ore` | `mcl_deepslate_coal_ore` | either |
| `deepslate_copper_ore` | missing in PP | `mcl_deepslate_copper_ore` | `mcl_deepslate_copper_ore` | either |
| `deepslate_diamond_ore` | missing in PP | `mcl_deepslate_diamond_ore` | `mcl_deepslate_diamond_ore` | either |
| `deepslate_emerald_ore` | missing in PP | `mcl_deepslate_emerald_ore` | `mcl_deepslate_emerald_ore` | either |
| `deepslate_gold_ore` | missing in PP | `mcl_deepslate_gold_ore` | `mcl_deepslate_gold_ore` | either |
| `deepslate_iron_ore` | missing in PP | `mcl_deepslate_iron_ore` | `mcl_deepslate_iron_ore` | either |
| `deepslate_lapis_ore` | missing in PP | `mcl_deepslate_lapis_ore` | `mcl_deepslate_lapis_ore` | either |
| `deepslate_redstone_ore` | missing in PP | `mcl_deepslate_redstone_ore` | `mcl_deepslate_redstone_ore` | either |
| `deepslate_tiles` | missing in PP | — | `mcl_deepslate_tiles` | REFI |
| `deepslate_top` | missing in PP | `mcl_deepslate_top` | `mcl_deepslate_top` | either |
| `dripstone_block` | missing in PP | — | `dripstone_block` | REFI |
| `exposed_chiseled_copper` | missing in PP | `mcl_copper_exposed_chiseled` | `mcl_copper_exposed_chiseled` | either |
| `exposed_copper` | missing in PP | `mcl_copper_exposed` | `mcl_copper_exposed` | either |
| `exposed_copper_bulb` | missing in PP | `mcl_copper_exposed_bulb_off` | `mcl_copper_exposed_bulb_off` | either |
| `exposed_copper_grate` | missing in PP | `mcl_copper_exposed_grate` | `mcl_copper_exposed_grate` | either |
| `exposed_cut_copper` | missing in PP | `mcl_copper_exposed_cut` | `mcl_copper_exposed_cut` | either |
| `flowering_azalea_leaves` | missing in PP | `mcl_lush_caves_azalea_leaves_flowering` | `mcl_lush_caves_azalea_leaves_flowering` | either |
| `green_glazed_terracotta` | traced in PP | — | `mcl_colorblocks_glazed_terracotta_green` | REFI |
| `light_blue_glazed_terracotta` | traced in PP | — | `mcl_colorblocks_glazed_terracotta_light_blue` | REFI |
| `lime_glazed_terracotta` | traced in PP | — | `mcl_colorblocks_glazed_terracotta_lime` | REFI |
| `lodestone_side` | traced in PP | — | `lodestone_side4` | REFI |
| `loom_bottom` | traced in PP | — | `mcl_loom_bottom` | REFI |
| `loom_front` | traced in PP | — | `mcl_loom_front` | REFI |
| `loom_side` | traced in PP | — | `mcl_loom_left` | REFI |
| `loom_top` | traced in PP | — | `mcl_loom_top` | REFI |
| `mangrove_leaves` | missing in PP | `mcl_mangrove_leaves` | `mcl_mangrove_leaves` | either |
| `mangrove_log` | missing in PP | `mcl_mangrove_log` | `mcl_mangrove_log` | either |
| `mangrove_log_top` | missing in PP | `mcl_mangrove_log_top` | `mcl_mangrove_log_top` | either |
| `mangrove_planks` | missing in PP | `mcl_mangrove_fence` | `mcl_mangrove_planks` | either |
| `moss_block` | missing in PP | `mcl_lush_caves_moss` | `mcl_lush_caves_moss_block` | either |
| `mud` | missing in PP | `mcl_mud` | `mcl_mud` | either |
| `mud_bricks` | missing in PP | `mcl_mud_bricks` | `mcl_mud_bricks` | either |
| `muddy_mangrove_roots_side` | missing in PP | — | — | **no source** |
| `muddy_mangrove_roots_top` | missing in PP | — | — | **no source** |
| `ochre_froglight_side` | missing in PP | — | — | **no source** |
| `ochre_froglight_top` | missing in PP | — | — | **no source** |
| `oxidized_chiseled_copper` | missing in PP | `mcl_copper_oxidized_chiseled` | `mcl_copper_oxidized_chiseled` | either |
| `oxidized_copper` | missing in PP | `mcl_copper_oxidized` | `mcl_copper_oxidized` | either |
| `oxidized_copper_bulb` | missing in PP | `mcl_copper_oxidized_bulb_off` | `mcl_copper_oxidized_bulb_off` | either |
| `oxidized_copper_grate` | missing in PP | `mcl_copper_oxidized_grate` | `mcl_copper_oxidized_grate` | either |
| `oxidized_cut_copper` | missing in PP | `mcl_copper_oxidized_cut` ⚠ 0.86 | `mcl_copper_oxidized_cut` | REFI |
| `packed_mud` | missing in PP | `mcl_mud_packed_mud` | `mcl_mud_packed_mud` | either |
| `pale_moss_block` | missing in PP | `mcl_pale_oak_moss` | `mcl_pale_oak_moss` | either |
| `pale_oak_leaves` | missing in PP | `mcl_pale_oak_leaves` | `mcl_pale_oak_leaves` | either |
| `pale_oak_log` | missing in PP | `mcl_pale_oak_log` | `mcl_pale_oak_log` | either |
| `pale_oak_log_top` | missing in PP | `mcl_pale_oak_log_top` ⚠ 0.87 | `mcl_pale_oak_log_top` ⚠ 0.93 | review (both flagged) |
| `pale_oak_planks` | missing in PP | `mcl_pale_oak_planks` | `mcl_pale_oak_planks` | either |
| `pearlescent_froglight_side` | missing in PP | — | — | **no source** |
| `pearlescent_froglight_top` | missing in PP | — | — | **no source** |
| `pink_glazed_terracotta` | traced in PP | — | `mcl_colorblocks_glazed_terracotta_pink` | REFI |
| `polished_deepslate` | missing in PP | — | `mcl_deepslate_polished` | REFI |
| `polished_tuff` | missing in PP | — | `mcl_deepslate_tuff_polished` | REFI |
| `purple_glazed_terracotta` | traced in PP | — | `mcl_colorblocks_glazed_terracotta_purple` | REFI |
| `raw_copper_block` | missing in PP | `mcl_copper_block_raw` | `mcl_copper_block_raw` | either |
| `raw_gold_block` | missing in PP | `mcl_raw_ores_raw_gold_block` | `mcl_raw_ores_raw_gold_block` | either |
| `raw_iron_block` | missing in PP | `mcl_raw_ores_raw_iron_block` | `mcl_raw_ores_raw_iron_block` | either |
| `red_glazed_terracotta` | traced in PP | — | `mcl_colorblocks_glazed_terracotta_red` | REFI |
| `resin_block` | missing in PP | `mcl_pale_oak_resin_block` | `mcl_pale_oak_resin_block` | either |
| `resin_bricks` | missing in PP | `mcl_pale_oak_resin_brick_block` ⚠ 0.83 | `mcl_pale_oak_resin_brick_block` | REFI |
| `rooted_dirt` | missing in PP | `mcl_lush_caves_rooted_dirt` | `mcl_lush_caves_rooted_dirt` | either |
| `sculk` | missing in PP | — | `mcl_sculk_sculk` (16×48, animated/strip) | REFI |
| `sculk_catalyst_bottom` | missing in PP | — | — | **no source** |
| `sculk_catalyst_side` | missing in PP | — | `mcl_sculk_catalyst_side` | REFI |
| `sculk_catalyst_top` | missing in PP | — | `mcl_sculk_catalyst_top` | REFI |
| `smithing_table_bottom` | traced in PP | — | `mcl_smithing_table_bottom` | REFI |
| `smithing_table_front` | traced in PP | — | `mcl_smithing_table_front` | REFI |
| `smithing_table_side` | traced in PP | — | `mcl_smithing_table_side` | REFI |
| `smooth_basalt` | missing in PP | — | `mcl_blackstone_basalt_smooth` | REFI |
| `stripped_bamboo_block` | missing in PP | `mcl_bamboo_bamboo_block_stripped` | `mcl_bamboo_bamboo_block_stripped` | either |
| `stripped_bamboo_block_top` | missing in PP | `mcl_bamboo_bamboo_bottom_stripped` ⚠ 0.94 | `mcl_bamboo_bamboo_bottom_stripped` | REFI |
| `stripped_cherry_log` | missing in PP | `mcl_cherry_blossom_log_stripped` | `mcl_cherry_blossom_log_stripped` | either |
| `stripped_cherry_log_top` | missing in PP | `mcl_cherry_blossom_log_top_stripped` | `mcl_cherry_blossom_log_top_stripped` | either |
| `stripped_mangrove_log` | missing in PP | `mcl_stripped_mangrove_log_side` | `mcl_stripped_mangrove_log_side` | either |
| `stripped_mangrove_log_top` | missing in PP | `mcl_stripped_mangrove_log_top` | `mcl_stripped_mangrove_log_top` | either |
| `stripped_pale_oak_log` | missing in PP | `mcl_stripped_pale_oak_log_side` | `mcl_stripped_pale_oak_log_side` | either |
| `stripped_pale_oak_log_top` | missing in PP | `mcl_stripped_pale_oak_log_top` | `mcl_stripped_pale_oak_log_top` | either |
| `suspicious_gravel_0` | missing in PP | — | — | **no source** |
| `suspicious_sand_0` | missing in PP | — | — | **no source** |
| `tinted_glass` | missing in PP | — | `mcl_amethyst_tinted_glass` | REFI |
| `tnt_bottom` | traced in PP | `default_tnt_bottom` | `default_tnt_bottom` | either |
| `tuff` | missing in PP | — | `mcl_deepslate_tuff` | REFI |
| `tuff_bricks` | missing in PP | — | `mcl_deepslate_tuff_bricks` | REFI |
| `verdant_froglight_side` | missing in PP | — | — | **no source** |
| `verdant_froglight_top` | missing in PP | — | — | **no source** |
| `weathered_chiseled_copper` | missing in PP | `mcl_copper_weathered_chiseled` | `mcl_copper_weathered_chiseled` | either |
| `weathered_copper` | missing in PP | `mcl_copper_weathered` | `mcl_copper_weathered` | either |
| `weathered_copper_bulb` | missing in PP | `mcl_copper_weathered_bulb_off` | `mcl_copper_weathered_bulb_off` | either |
| `weathered_copper_grate` | missing in PP | `mcl_copper_weathered_grate` | `mcl_copper_weathered_grate` | either |
| `weathered_cut_copper` | missing in PP | `mcl_copper_weathered_cut` ⚠ 0.82 | `mcl_copper_weathered_cut` | REFI |
| `yellow_glazed_terracotta` | traced in PP | — | `mcl_colorblocks_glazed_terracotta_yellow` | REFI |
