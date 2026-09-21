# Worldgen v3 — "rich world"

Status: design, 2026-09-21. Branch `worldgen`. Targets generator version 3
(`genVersion 3`, height 256); v1 and v2 worlds are untouched forever.
Evidence in §12 comes from a throwaway prototype (not committed) that
implements every rule below and was run on seeds 1, 2, 3 (1024 chunks each)
and on 100 seeds for the spawn rule.

Constraints honoured: finite 512 × 512, 32 × 32 chunks, hard walls; 256 tall,
`bedrock` at y = 0; `generateChunkV3(chunk, seed)` runs on the main thread and
is a pure function of `(seed, cx, cz)` — it never reads another chunk. Frozen
block catalog: every block named here exists in `blocks.catalog.data.ts` or
`blocks.base.data.ts`. Hard cap 3 ms / chunk, target 2 ms.

## 1. Goals and player-experience targets

All measured from the spawn column, unless stated. "p50/p90" are over 100
seeds (§12).

| Target | Value | Measured (prototype) |
|---|---|---|
| Sea level | fixed **y = 120** | — |
| Surface height (land + sea floor), full map | min ≥ 50, median 122–132, p90 160–176, max 205–240 | min 54–68, median 123–129, p90 163–173, max 222–238 |
| Water columns (ocean + lakes + rivers) | 20–40 % of map | 27–37 % |
| River-channel columns | 4–8 % of map | 5.0–6.6 % |
| Flat-ish land (|Δh| ≤ 2 over ±2 blocks) | ≥ 50 % of land | 54–58 % |
| Distinct biomes per seed | all 8 land biomes present | 8/8 on 3 seeds |
| Biome changes walking one 512-block row through spawn | 8–25 | 15–21 |
| Nearest tree from spawn | p50 ≤ 12, p90 ≤ 32, max ≤ 64 | p50 6, p90 18, max 48 |
| Nearest cave mouth (open pit ≥ 4 deep) from spawn | p50 ≤ 30, p90 ≤ 64 | p50 22, p90 47 |
| First ore inside a 3 × 3 shaft dug straight down from spawn | p50 ≤ 30 blocks, p90 ≤ 64 | p50 20, p90 58 |
| Nearest different biome from spawn | p90 ≤ 40 | p90 14 |
| Spawn column | never water, cave, tree, ravine, cliff, snow; flat ±2 | 0 failures / 100 seeds |
| Ore voxels per chunk (world average, §7) | coal ≈ 110, iron ≈ 85, copper ≈ 70, redstone ≈ 40, gold ≈ 27, lapis ≈ 19, diamond ≈ 13, emerald ≈ 6 (mountain-only) | table in §12 |
| Cave air fraction of rock by y band | 1–23: 14–20 %, 24–47: 13–19 %, 48–79: 8–12 %, 80–119: 4–7 % | 17.8 / 16.0 / 10.3 / 4.2 (seed 1) |
| Unstable water (air beside or below a generated water/lava voxel) | exactly 0 | 0 on 3 seeds |
| Trees cut at chunk borders (leaf with no log within 3) | exactly 0 | 0 on 3 seeds |
| Generation time | mean ≤ 2 ms, p95 ≤ 3 ms per chunk (Node/V8, this machine) | mean 1.45–1.60, p95 1.75–2.29 |

## 2. Pipeline

Every stage is a pure function of `(seed, cx, cz)` and the arrays produced by
earlier stages of the *same* chunk. No stage reads another `Chunk`. Stages 5–6
read *neighbouring chunks' feature lists*, which are recomputed from the seed
(padded-origin scheme, §10), not read from memory.

| # | Stage | Resolution | What it produces | Cost (ms, measured) |
|---|---|---|---|---|
| 1 | Column stack | 2-D, 20 × 20 columns (chunk + 2 pad) | height `hRaw`, biome, shape amplitude `amp`, entrance mask, river weight, ravine width, `caveCeil`, `waterNear` | 0.30 |
| 2 | Lattice | 3-D, 5 × (yTop/4+1) × 5 nodes, cell 4 × 4 × 4 | `S` (3-D shape term, blocks), `Dc` (cave carve, blocks) | 0.24 |
| 3 | Fill | per voxel, y < yTop | `kind`: 0 terrain-air, 1 solid, 2 cave-air, 3 water; ravines | 0.4–1.0 |
| 4 | Surface | per column top-down sweep | block ids: biome top/filler, beaches, sea floor, snow, deepslate, lava sea, ice | 0.31 |
| 5 | Underground features | per feature, 3 × 3 chunk origins | ores, stone blobs, gravel/clay/dirt pockets, geodes, pools; then moss/dripstone | 0.39 + 0.19 |
| 6 | Trees | per feature, 3 × 3 chunk origins | trunks and canopies clipped to this chunk | 0.08 |

`yTop = min(252, ceil((maxH_padded + 28) / 4) · 4)`; everything above is air
and never visited. Sum 1.9–2.5 ms in mountain/cave-dense regions, 1.5 ms mean
over a full map (§12). Stage 3 is the only stage whose cost varies with
content (cave-dense chunks interpolate `Dc` in more cells).

Per-seed noise objects (`createNoise2D/3D` from `simplex-noise`, 19 fields)
are built once per seed and cached; building them costs ~10 ms and is what
makes the first chunk of a run 13–18 ms in §12. The engine must construct them
at `World.create`/load, not per chunk.

## 3. Terrain shape

### 3.1 Column fields (stage 1, per column, 2-D simplex fBm)

| Field | Octaves | Wavelength | Range | Drives |
|---|---|---|---|---|
| `C` continentalness | 3 | 420 | −1..1, +0.08 bias | base height, ocean/land |
| `E` erosion | 3 | 330 | −1 rugged .. 1 flat | mountain-ness `M` |
| `PV` peaks-valleys | 4 | 140 | ridged: `PV = 1 − 2·|fbm|` | ridges and valleys inside mountains |
| `T` temperature | 2 | 320 | + 0.04 · `JIT` | biome |
| `HU` humidity | 2 | 300 | + 0.04 · `JIT` | biome |
| `R` river | 2 | 210 | channel where `|R| < w` | rivers |
| `D` detail | 3 | 26 | ±3.5 blocks | small bumps |
| `ENT` entrance mask | 1 | 90 | > 0.25 ⇒ caves may breach the surface | cave mouths |
| `RG` ravine gate | 1 | 300 | > 0.4 ⇒ ravine zone | ravines |
| `JIT` jitter | 1 | 14 | ±0.04 | fuzzy biome borders |
| `PATCH` | 1 | 9 | patches of podzol / coarse dirt / gravel | surface variety |

Spawn and wall shaping, applied to `C` before the spline:
`C += 0.45 · smooth(1 − d_centre/110)` (spawn continent, guarantees land at
(256, 256)); `C −= 0.8 · smooth(1 − d_edge/20)` (a 20-block ocean ring at the
hard wall, so the wall reads as the sea's edge instead of a sliced mountain).

### 3.2 Height spline

```
base(C)  = spline C→y through (-1,98) (-0.55,104) (-0.3,113) (-0.15,121) (0.1,127) (0.45,136) (1,146)   [smoothstep between knots]
M        = smooth((0.3 − E) / 0.7) · smooth((C + 0.05) / 0.35)          // mountain-ness 0..1
h        = base + M · (PV > 0 ? 92·PV : 18·PV)                            // ridges up to +92, valleys down to −18
badlands terraces (biome == badlands, h > 124): h = q + 6·smooth(2(h−q)/6 − 0.5), q = floor(h/6)·6
rivers (§5)
h       += 3.5 · D · (1 − river)
hRaw     = h;  h = ceil(hRaw) − 1                                          // h = top solid y of a pure-2-D column, exactly
```

Vanilla reference: base −64..320 with sea at 63 and peaks to ~256 via a
similar C/E/PV spline. Ours compresses to 98..238 around sea 120 because the
column is 256 tall and the kid needs the 0..120 band for digging.

### 3.3 3-D shape (overhangs, cliffs) without floating islands

```
amp(x,z) = h > 126 ? 22 · smooth((M − 0.3)/0.4) · smooth((h − 126)/20) : 0     // blocks; EXACTLY 0 on hills and lowlands
S(node)  = amp · fbm3(SHAPE, x/44, y/30, z/44, 3 oct) · smooth(1 − |hRaw − y| / 40)   // lattice, 0 when amp = 0 or |hRaw − y| ≥ 40
dt(voxel) = hRaw(column) − y + trilinear(S)                                   // block units; solid iff dt > 0
```

`hRaw` is taken from the voxel's own column, not interpolated, so a column
whose lattice cell has `amp = 0` at all four xz corners has its top solid
block at exactly `h`. That is what makes trees and the spawn rule exact (§8,
§9). The 40-block taper keeps `S` from producing solid far above the surface;
with amplitude 22 and the vertical gradient of 1 block/block, a detached blob
needs `fbm3 > 0.68` sustained over ≥ 4 blocks, which simplex fBm essentially
never does. Decision: **no deliberate floating islands**. Measured: 0–40
floating solid voxels in a 96 × 96 × 256 box around each seed's highest peak,
out of 1.2–1.5 M solid (≤ 0.004 %), and 1–17 isolated single voxels per full
map. Overhangs and vertical cliff faces occur wherever `amp > 8` (mountains).

Height distribution targets: see §1. Peaks: 222 / 234 / 238 on the three
seeds; the spline caps at 146 + 92 = 238.

## 4. Biomes

Selection per column from `(T, HU, h)` with `T` lapse-corrected:
`T −= 0.7 · clamp((h − 130) / 90, 0, 1)` (peaks go cold).

| Biome | Condition | Top / filler (depth 0 / 1–3) | Trees (§8) | Extras |
|---|---|---|---|---|
| ocean | h < 118 | sea-floor rule (§5) | none | — |
| snowy | T < −0.45 | `snow_block` / `dirt` × 3 | spruce 1–2 | water top at y 120 = `ice`; beaches are `gravel` |
| taiga | −0.45 ≤ T < −0.15, HU > −0.3 | `grass_block` or `podzol` (PATCH > 0.45) / `dirt` × 3 | spruce 5–7 | gravel beaches |
| plains | −0.45 ≤ T < 0.3, HU low | `grass_block` / `dirt` × 3 | oak 0–2 | — |
| forest | −0.15 ≤ T < 0.3, −0.2 ≤ HU < 0.35 | `grass_block` / `dirt` × 3 | oak + birch 6–9 | — |
| cherry | −0.15 ≤ T < 0.3, HU ≥ 0.35 | `grass_block` / `dirt` × 3 | cherry 2–4 | — |
| badlands | T ≥ 0.3, HU < −0.35 | `red_sand` top at y ≤ 128, else terracotta bands / bands | none | terraces; bonus gold |
| desert | T ≥ 0.3, −0.35 ≤ HU < 0.1 | `sand` × 3 / `sandstone` × 5 | none | — |
| savanna | T ≥ 0.3, HU ≥ 0.1 | `grass_block` or `coarse_dirt` (PATCH > 0.55) / `dirt` × 3 | acacia 1–2 | — |

Terracotta bands (badlands, y ≥ 100, depth 0–8): index `y & 15` into
`[terracotta, orange_terracotta, terracotta, yellow_terracotta, terracotta, white_terracotta, red_terracotta, terracotta, brown_terracotta, orange_terracotta, terracotta, light_gray_terracotta, terracotta, red_terracotta, orange_terracotta, terracotta]` — bands are by absolute y, as in vanilla, so they line up across terraces.

Altitude rules (override biome, any land column):
- stony peaks: `amp > 8` ⇒ top block is bare `stone` (no grass on cliff faces);
- snow line: `y ≥ 160 + 20·T` (≈ 146 warm, 174 cold; snowy biome: always) ⇒ top `snow_block`, filler `dirt` × 2.

Beaches: any non-badlands column with `117 ≤ h ≤ 122` gets `sand` (snowy /
taiga: `gravel`) to depth 4. Sea floor (water above): `h > 110` ⇒ `sand`
(`gravel` where PATCH > 0.35), else `clay` (PATCH > 0.2) or `gravel`; depth
1–2 `sand`.

Borders: biome choice is a hard argmax, blurred by `JIT` (±0.04 at wavelength
14) so edges wander over ~6 blocks instead of following an iso-line. No
cross-biome height blending is needed because height does not depend on
biome except badlands terraces, which are smoothstepped.

## 5. Water

- **Sea level 120, fixed.** Every terrain-air voxel (`dt ≤ 0`) with `y ≤ 120` is `water` (snowy biome: `ice` at y = 120). Nothing else places water above y 120, and there is **no water above sea level anywhere** (exact test, §11). Lakes are simply inland depressions of the C-spline below 118; mountain lakes are out of scope (§13).
- **Rivers:** `w = 0.045 · clamp(1 − (h − 126)/30)` (rivers vanish above y 156); `river = 1 − smooth((|R| − w)/0.05)` for `|R| < w + 0.05`, `h ← h + (117 − h)·river` (channel bottom y 117, 3 deep, banks fade over ~5 blocks). Bank/channel columns (`river > 0.6`) get `sand` (cold biomes `gravel`) to depth 4.
- **Stability with the liquid scheduler** (docs/liquids.md: a source spreads 4 hops sideways into air and falls without limit): generated water must have no `air` on its 4 sides or below. Proof: water sits only at `y ≤ 120` in terrain-air; a side neighbour at the same y is terrain-air (⇒ water), solid, or cave-air — and cave-air is forbidden within 6 blocks of any terrain-air/water surface of its 3 × 3 column neighbourhood (`caveCeil`, §6). Below is terrain-air (water) or solid. Ice at y 120 is solid. Measured: **0** violations per full map on 3 seeds.
- **Underground pools** (own-chunk, interior 4..11 so all neighbours are known): per chunk 2 lava attempts (y 12–40) and 2 water attempts (y 40–100). Each looks down ≤ 8 blocks for a cave floor, takes a disc r 2–3.5 of floor voxels that have air above, and keeps only those whose 4 side neighbours and the block below are solid-or-in-disc; needs ≥ 4 survivors. The liquid replaces the floor block, so it is enclosed on 5 sides. Same rule for lava.
- **Lava sea:** every cave-air voxel with `y ≤ 10` is `lava` (vanilla: lava level −54, 10 above bedrock). Sideways neighbours are lava or solid; below is lava, solid or bedrock. `lava.lightLevel` is 12 (blocks.base.data.ts:96), so the kid sees the glow through a cave opening from ~12 blocks away before reaching it.
- Water never touches caves: enforced by `caveCeil`, not by post-hoc patching.

## 6. Caves

All cave terms are evaluated at lattice nodes (4 × 4 × 4) as signed "blocks
of carve" and trilinearly interpolated; a voxel is cave-air when the
interpolated `Dc > 0` (vanilla samples the same way at 4 × 8 × 4; we use 4 in
y so spaghetti floors are not stair-stepped). `deep = clamp((112 − y)/92)`.

| Type | Fields | Formula (positive ⇒ carve) | Where |
|---|---|---|---|
| cheese (caverns) | `CHEESE` 2 oct, xz/96, y/48 | `(n − (0.58 − 0.28·deep)) · 24` | y 2 .. h+4 |
| spaghetti (tunnels) | `S1`, `S2` xz/54, y/32 | `(r² − (s1² + s2²)) · 450`, `r = 0.085 + 0.045·deep` (≈ 3–5 wide) | y 2 .. h+4 |
| noodle (thin) | `N1`, `N2` xz/26, y/20 | `(0.0036 − (n1² + n2²)) · 1100` (≈ 1–2 wide) | y < 92 |
| ravine | `RAV` 2-D, wavelength 230; gate `RG > 0.4`, land `h > 128`, `amp < 6`, `!waterNear` | air where `|RAV| < w(y)`, `w = ravW · (0.4 + 0.6·(y − bottom)/(h − bottom))`, `ravW = 0.035·smooth((RG − 0.4)/0.2)` (≈ 8 wide at the top, 3 at the bottom); `bottom = h − (40 + 25·smooth(RG'))` | y bottom .. h+60 |

`Dc = max(cheese, spaghetti, noodle)`. Per-cell skip: if none of a cell's 8
corners has `Dc > 0` the cell is not interpolated (that is most cells; it is
what keeps stage 3 under 1 ms).

Placement rules (per column, from stage 1):
- `caveCeil = min over 3 × 3 columns of (hRaw − amp) − 6`; `waterNear = that min < 122`.
- entrance zone: `ENT > 0.25 && !waterNear`.
- outside entrance zones a voxel is cave-air only if `dt > 6` **and** `y < caveCeil` (≥ 6 blocks of rock to every nearby surface — vertical and horizontal — so no water ever sees cave air and no random pinholes);
- inside entrance zones: cave-air if `dt > −2` (caves break the surface; open pits and cliff-side mouths).
- lava below y 11 (§5). No cave carve at y < 2.

Depth profile (measured, fraction of rock that is cave or lava): y 1–23:
17.8 %, 24–47: 16.0 %, 48–79: 10.3 %, 80–119: 4.2 %, ≥ 120: 1.7 %. Vanilla
1.18 is ≈ 12–15 % around y −40 and ≈ 4 % near the surface; we run slightly
denser below 48 on purpose (the kid digs from 120, and the first 70 blocks
are already the shallow band).

Decoration (stage 5, over cave-air voxels, `DECO` 3-D noise xz/40 y/40):
- moss: where `DECO > 0.45` and `56 < y < 112` (lush zones ~10 % of caves): floor block → `moss_block`; 1 in 5 floor voxels also get a moss block on top; 1 in 3 ceiling blocks → `moss_block`.
- dripstone: where `DECO < −0.45`: 1 in 7 floor voxels grow a `dripstone_block` stalagmite 1–3 tall; 1 in 9 ceiling voxels a stalactite 1–3 tall. (Catalog has no `pointed_dripstone`; `dripstone_block` columns read as stalagmites at this scale.)
Measured 25 k moss and 19–22 k dripstone voxels per map.

Minimum ceiling below the surface: 6 blocks outside entrance zones (exact by
construction); entrance zones are ~44 % of land (`ENT > 0.25`).

## 7. Ores and underground variety

Deepslate: `stone → deepslate` for `y < 44`; for `44 ≤ y < 52` per-voxel
probability `(52 − y)/8` (hash of world coords). Vanilla: −64..8 with an
8-block blend at 0..8; ours puts the switch 72 blocks below the surface so
the kid meets it after a real dig. Ore placed into deepslate uses the
`deepslate_*_ore` row.

Veins are random walks: `size` steps, each writes the current voxel and, with
p 0.5, one diagonal neighbour, then moves 1 block in a random axis. Only
`stone`/`deepslate` are replaced (never air, water, dirt, other ore), so
veins are exposed on cave walls exactly as often as caves cut them — no
extra "exposure" rule; vanilla's diamond 50 %-discard-if-exposed is dropped
on purpose (glints in walls are the point). `y` is drawn from a triangular
distribution `tri(y0, peak, y1)`.

| Ore | y0–peak–y1 | attempts/chunk | vein steps | Vanilla (1.21) | Measured voxels/chunk (band split in §12) |
|---|---|---|---|---|---|
| coal | 60–128–200 | 24 | 6–14 | 0..192 uniform ×20 size 17 + 136..320 ×30 | 106–123 |
| iron | 16–60–112 | 12 | 4–9 | −24..56 peak 16 ×10 size 9 | 82–87 |
| iron (mountain) | 140–185–230, only if max h in chunk ≥ 150 | 24 | 4–9 | 80..384 peak 232 ×90 | (included above; 7–11 above 120) |
| copper | 50–92–130 | 10 | 5–10 | −16..112 peak 48 ×16 size 10 | 69–71 |
| gold | 6–30–70 | 5 | 4–8 | −64..32 peak −16 ×4 size 9; badlands 32..256 ×50 | 27 |
| gold (badlands bonus) | 40–80–120, columns in badlands only | 20 | 3–6 | see above | not in §12 (badlands 0.6–3.3 % of map) |
| lapis | 12–40–76 | 4 | 3–7 | −32..32 peak 0 ×2 size 7 (+ buried) | 18–19 |
| redstone | 4–12–40 | 8 | 4–8 | −64..15 ×4 size 8; −96..−32 peak −64 ×8 | 40–41 |
| diamond | 4–8–36 | 4 | 2–5 | −144..16 peak −64 ×7 size 4 | 13–14 total |
| diamond (large) | 4–10–30, p 1/8 | 1 | 5–8 | size 12 at 1/9 | " |
| emerald | 100–180–220, only if max h in chunk ≥ 150 | 20 | 1–3 | mountains only ×100 size 3 | 4.6–6.9 world avg (≈ 25 in a mountain chunk) |

Stone blobs (ellipsoids, `ry = 0.7·r`, 1 in 3 rim voxels skipped for a rough
edge; replace stone/deepslate only): `granite`, `diorite`, `andesite` 3
attempts each, y 40–120, r 3–5.5; `tuff` 3 attempts y 4–60 r 3–6; `calcite`
1 attempt y 60–130 r 2–4. Measured ≈ 0.8 % of all blocks each for the three
igneous ones, tuff 0.9 % — a different stone about every 12 blocks of tunnel.
Vanilla: 2 × size-64 blobs per stone type per chunk in 0..128, tuff 0..16.

Pockets (`ry = 0.6·r`): `gravel` 3 attempts y 20–115 r 2–4; `dirt` 4
attempts y 60–118 r 2–3.5; `clay` 1 attempt y 30–110 r 2–3.

Amethyst geodes: 1 in 24 chunks (vanilla 1/24), centre y 24–60, radius
4–6.5, per-voxel jitter 0..0.6 on the radius. Shells from outside in:
`smooth_basalt` (r..r+0.8), `calcite` (r−1..r), `amethyst_block` with 1 in 6
`budding_amethyst` (r−2..r−1), hollow air inside. Geodes overwrite anything
(so they can cut a cave). Measured 6–7 k amethyst voxels per map (≈ 43
geodes).

All of the above use the padded-origin scheme: the chunk replays the feature
streams of itself and its 8 neighbours and writes only voxels inside
`0..15`; features whose bounding box misses the chunk are skipped after
consuming their random draws (§10).

"Feel" targets per 16-column shaft (kid digging a 3 × 3 hole from 120 to
bedrock): at least one ore by 30 blocks on half of seeds (measured p50 20),
a stone-type change every ≤ 15 blocks, a cave crossing at least once in
0..48 for > 90 % of shafts (cave fraction 16–18 % there).

## 8. Surface decoration

Trees are per-chunk feature lists (`treesOf(seed, cx, cz)`): the chunk's
species set comes from the biome of its centre column (x 8, z 8); count `n`
per the biome table (§4); each tree draws `(lx, lz)`, species, height, two
extra reals from the stream, and is dropped if within Chebyshev 2 of an
earlier tree, or if its column has `h < 121`, `river > 0.2`, a different
biome than the chunk centre, `h ≥ snow line`, or is not in a **flat cell**
(`amp = 0` at all 4 xz corners of its 4 × 4 lattice cell, so its ground is
exactly `h`). The trunk base writes `dirt` at `h` if that voxel is air or
water (a cave mouth under a tree gets a dirt plug rather than a floating
tree), trunk logs overwrite anything, leaves only replace air.

Canopies (explicit voxel rules; `top = h + trunk`):
- **oak** (`oak_log`, `oak_leaves`, trunk 4–6) and **birch** (`birch_log`, `birch_leaves`, trunk 5–7): layers `top−3, top−2` radius 2 with each corner kept by a coin flip, `top−1` radius 1 without corners, `top` radius 1, plus `top+1` a plus-shape of 5. Vanilla oak canopy.
- **spruce** (`spruce_log`, `spruce_leaves`, trunk 6–10): one leaf at `top+1`, then rings of radius 1, 2, 1, 2 … downwards to `h+3`, radius-2 rings without corners.
- **acacia** (`acacia_log`, `acacia_leaves`, trunk 5–6): trunk bends one block sideways at `top−1` (direction from the two extra reals), flat 5 × 5 canopy at `top` minus corners and a plus-shape at `top+1`.
- **cherry** (`cherry_log`, `cherry_leaves`, trunk 4–5): discs radius 3 at `top−1` and `top`, radius 2 at `top+1`, one leaf at `top+2`.

Padded origins: chunk `(cx, cz)` draws `treesOf` for all 9 chunks in its
3 × 3 neighbourhood and clips. Max canopy reach is 3 (cherry) plus the acacia
bend 1, both < 16, so one ring of neighbours suffices. Measured: 0 leaves
without a log within 3 blocks over 59–76 k leaves per map.

Snow: `snow_block` as the top block above the snow line and in the snowy
biome (there is no thin snow layer in the catalog). Beaches per §4. Bushes
and mossy cobblestone: dropped — the prototype's forests read as full at
6–9 trees per chunk without them (§13).

## 9. Spawn rule

`spawnColumnV3(seed) → (x, z)`: walk square rings `r = 0..96` around (256,
256) (ring order, then dz then dx — deterministic) and return the first column
with: `h ≥ 122`, `river = 0`, `ravW = 0`, `ENT ≤ 0.25` (no cave mouth), biome
≠ snowy, flat cell (`amp = 0` at the 4 cell corners ⇒ surface exactly `h`),
`|h − h(±2, 0)| ≤ 2` and `|h − h(0, ±2)| ≤ 2`, and no tree of the 3 × 3
surrounding chunks with base within Chebyshev 3. Fallback (256, 256) — never
hit in 100 seeds because the spawn-continent term forces land there. The
player then stands at `(x + 0.5, h + 1, z + 0.5)`; the engine's
`findSafeSpawn` column scan is a no-op on that column. Measured: 0 failures
in 100 seeds, offset from centre p50 21, p90 55, max 83.

Engine hand-off (not worldgen code): `World.create` / `startGame` must ask
`generation.ts` for the spawn column when `genVersion ≥ 3` instead of using
(256, 256) — one new exported function, one call site in `main.ts`.

## 10. Determinism and PRNG

- **Noise fields:** `createNoise2D(alea(\`minicraft:v3:${seed}:${field}\`))`, one per field name, cached per seed. Field names are the table keys in §3.1 and §6; renaming a field is a generator-version change.
- **Feature streams:** numeric, not alea. `streamSeed(seed, cx, cz, feature)` = murmur3 fmix32 applied four times: `h = fmix(seed ^ 0x3a5f0d1b); h = fmix(h ^ imul(cx, 0x9e3779b1)); h = fmix(h ^ imul(cz, 0x85ebca77)); h = fmix(h ^ imul(feature, 0xc2b2ae3d))`, then `mulberry32(h)` yields the stream. Feature ids: TREE 1, ORE 2, BLOB 3, POCKET 4, GEODE 5, POOL 6. Why numeric: a chunk replays 9 neighbours × 5 streams = 45 stream initialisations; alea's string seeding costs ~2 µs and an allocation each (≈ 0.1 ms/chunk) versus ~20 ns for the hash, and the string form would be built 45 times. specs.md §4's "all randomness flows through alea" must be amended to "through the seeded alea noise fields or the v3 hash streams; `Math.random` stays banned" — flagged as a decision.
- **Order independence:** a feature with origin in chunk B is drawn from `streamSeed(seed, B, feature)` by every chunk that can be touched by it, in the same order, and each writes only its own voxels. Features consume a fixed number of draws whether or not they intersect the current chunk (skipped veins burn `4·size` draws). Nothing reads `World`. Invariant: `generateChunkV3(A)` is byte-identical whether or not B was generated first, in any order, in any session — tested by generating A alone and A after its 8 neighbours and comparing `blocks`.
- **Reference hash:** SHA-256 over `blocks` of chunks (16,16), (0,0), (31,31) and the spawn chunk for seed 12345, recorded once; the test never re-records. Any change to a constant in this document changes the hash and therefore requires `genVersion 4`.

## 11. Tests (the instrument)

E = exact, S = statistical with the stated tolerance. "Map" = all 1024 chunks
of one seed, "3 seeds" = 1, 2, 3 (≈ 5 s in vitest per seed).

1. E — reference hash for seed 12345 (§10); dispatcher `generateChunk(c, seed, 3)` requires height 256; `worldProfile(3) = {height: 256}`; v1 and v2 hashes unchanged.
2. E — order independence: chunk (16,16) generated cold equals the same chunk generated after all 8 neighbours; also equals after generating in reverse order.
3. E — every column has `bedrock` at y 0 and nothing but bedrock at y 0; no block at y ≥ 253.
4. S — height histogram over a map: min ≥ 50, median in 118–134, p90 in 150–185, max in 200–240; water columns 18–42 %; flat-ish land ≥ 48 %. (Goes red on a flattened spline or a missing PV term.)
5. E — no water at y > 120; no `water`/`lava` voxel with `air` on any of its 4 sides or below (checked across chunk borders on a whole map); no `ice` except at y 120 in snowy columns. (Goes red if `caveCeil` is dropped or measured only vertically — that exact bug was caught in the prototype, 4–12 voxels per map.)
6. S — cave air fraction of rock per band on a map: 1–23 in 13–22 %, 24–47 in 12–20 %, 48–79 in 7–13 %, 80–119 in 3–8 %. E — no cave-air voxel at `y ≥ caveCeil` outside entrance zones; no cave-air at y ≤ 10 (it must be lava).
7. S — ore voxels per chunk on a map, tolerance ±30 % of the §7 measured column, and E — zero ore outside its band (`y0..y1`), zero `*_ore` on deepslate rows above y 52 and zero plain `*_ore` below y 44; every ore voxel replaced stone or deepslate (never sits in air/water/dirt).
8. S — stone blobs: granite, diorite, andesite each 0.5–1.2 % of non-air blocks; tuff 0.5–1.3 %, all tuff below y 66; amethyst 3–12 k voxels per map, every `budding_amethyst` has an `amethyst_block` neighbour.
9. E — trees: every leaf has a log within Chebyshev 3; every log column stands on `dirt`/`grass_block`/`podzol`/`coarse_dirt`/log; S — forest chunks (centre biome forest) have 4–10 trunk bases each, desert/badlands chunks 0.
10. S — biomes: all 8 land biomes present on each of 3 seeds; biome changes along the spawn row 8–30; E — badlands terracotta index equals `y & 15` for every terracotta voxel; E — snowy top block is `snow_block` or `ice`, desert top block is `sand` at every land column of that biome (beach/rocky/snow-line overrides excluded).
11. E — spawn over 100 seeds (1000..1099): returned column has solid non-liquid top at exactly `h`, air at `h+1` and `h+2`, `h ≥ 121`, no log/leaf within Chebyshev 3, |Δh| ≤ 2 at ±2 in x and z; S — offset from centre p90 ≤ 64.
12. S — kid targets over 100 seeds: nearest tree p50 ≤ 12 / p90 ≤ 32; nearest cave mouth p50 ≤ 30 / p90 ≤ 64; first ore in a 3 × 3 shaft p50 ≤ 30 / p90 ≤ 64.
13. S — time: 81 chunks around spawn (after one warm-up chunk and after noise-field construction), mean ≤ 2.0 ms, max ≤ 3.5 ms, on the reference machine; fails on the per-voxel-noise variant (5–7 ms measured today).
14. E — pools: every generated `water`/`lava` voxel at y > 10 that is not in a sea/river/lake column has 4 solid-or-same-liquid sides and a solid block below (subset of 5 but scoped to feature pools so the failure names the stage).

Statistical tests fix the seed, so they are deterministic; the tolerance
exists so a legitimate constant tweak under a new `genVersion` does not need
the whole suite rewritten.

## 12. Evidence appendix (prototype, seeds 1 / 2 / 3, Node 24 on this machine)

Generation time per chunk (1024 chunks per seed; the max is the first chunk,
which builds the 19 noise fields):

```
seed 1: mean 1.60 ms  p50 1.40  p95 2.29  max 18.8 | 81 around spawn: mean 1.59 max 2.15
seed 2: mean 1.56 ms  p50 1.42  p95 1.89  max 15.6 | 81 around spawn: mean 1.48 max 1.86
seed 3: mean 1.45 ms  p50 1.43  p95 1.75  max 4.6  | 81 around spawn: mean 1.51 max 1.97
stage split (100 chunks, cave-dense region): cols 0.30 lattice 0.24 fill 0.96 surface 0.31 features 0.39 deco 0.19 trees 0.08
```

Surface (top of terrain, water excluded) and biomes:

```
seed 1: min 68 p10 110 median 123 p90 163 max 222; water columns 36.8%; flat-ish land 58.0%; river columns 6.6%
        histogram (bin:%): 96:4.6 104:9.2 112:22.3 120:26.0 128:13.7 136:6.4 144:3.7 152:2.8 160:3.0 168:2.7 176:1.7 184:1.5 192:1.1 200:0.7 208:0.4 216:0.1
        biomes: ocean 32.0 snowy 17.4 taiga 14.9 forest 12.2 plains 8.2 savanna 5.9 cherry 5.5 desert 3.4 badlands 0.6; biome changes on spawn row 15
seed 2: min 54 p10 111 median 129 p90 173 max 234; water 27.9%; flat 54.1%; river 5.0%
        histogram: 96:3.5 104:7.9 112:16.3 120:19.6 128:11.5 136:14.1 144:5.6 152:5.2 160:4.2 168:2.7 176:2.6 184:2.0 192:2.1 200:1.2 208:0.6 216:0.4 224:0.2
        biomes: ocean 24.7 forest 21.3 plains 17.4 taiga 13.3 snowy 7.4 cherry 6.8 badlands 3.3 savanna 3.1 desert 2.7; changes 21
seed 3: min 65 p10 111 median 127 p90 171 max 238; water 27.3%; flat 54.7%; river 6.2%
        histogram: 96:3.9 104:6.5 112:16.6 120:24.8 128:12.0 136:9.8 144:5.3 152:4.9 160:4.4 168:3.5 176:2.7 184:1.7 192:1.1 200:1.0 208:1.0 216:0.6 224:0.2
        biomes: ocean 22.4 taiga 19.9 forest 17.1 plains 16.2 snowy 13.9 cherry 4.2 desert 3.7 savanna 1.6 badlands 1.0; changes 21
```

Ore voxels per chunk by y band (seed 1; seeds 2 and 3 within ±3 % except
coal/iron which rise with more mountain area: coal 123, iron 86):

```
            1-23   24-47   48-79  80-119   120+   total  exposed-to-air
coal         0.0     0.0     9.3    67.0   29.1   105.5   2%
iron         0.9    15.1    42.0    16.8    7.2    81.9   4%
copper       0.0     0.0    18.3    49.9    1.2    69.4   2%
gold         5.1    16.7     5.5     0.0    0.0    27.3   5%
lapis        1.3    10.5     6.5     0.0    0.0    18.4   5%
redstone    29.6    11.8     0.0     0.0    0.0    41.4   5%
diamond     11.1     2.3     0.0     0.0    0.0    13.5   4%
emerald      0.0     0.0     0.0     0.5    4.1     4.6   4%
```

Cave air fraction of rock: seed 1 — 1–23: 17.8 %, 24–47: 16.0 %, 48–79:
10.3 %, 80–119: 4.2 %, 120+: 1.7 %; seed 2 — 18.4 / 18.1 / 10.4 / 4.9 / 2.2;
seed 3 — 18.1 / 16.8 / 9.2 / 5.5 / 2.0.

Water/feature integrity (per map): water voxels with air beside or below:
**0 / 0 / 0**; water above y 120: 0; lava voxels 373 k / 375 k / 411 k; moss
24.6 k / 26.2 k / 24.7 k; dripstone 18.9 k / 21.9 k / 21.3 k; amethyst
7.1 k / 6.2 k / 7.2 k; isolated single floating solids 8 / 1 / 17; floating
solids in the 96 × 96 box around the peak 0 / 10 / 40 of 1.2–1.5 M.

Trees: 961 / 1188 / 1115 per map (0.94–1.16 per chunk, 364–378 chunks with
trees); leaves 59 k / 76 k / 73 k; **0** leaves without a log within 3 on
every seed.

Spawn (3 seeds): seed 1 (280, 162, 260) forest, offset 24, tree 7, cave
mouth 15, first ore at 50, other biome at 5; seed 2 (237, 146, 284) forest,
offset 34, tree 5, mouth 31, ore 5, biome 8; seed 3 (256, 139, 256) forest,
offset 0, tree 4, mouth 13, ore 46, biome 1.

Spawn over 100 seeds (1000–1099): failures **0**; offset p50 21 p90 55 max
83; first ore in a 3 × 3 shaft p50 20 p90 58 (one seed reached the lava sea
with none — statistical, hence the p90 bound); nearest tree p50 6 p90 18 max
48; nearest cave mouth p50 22 p90 47 (one seed none within 48); nearest
other biome p50 5 p90 14; spawn biomes taiga 37, forest 23, plains 21,
desert 12, cherry 4, savanna 3.

Misses and adjustments, stated: (a) first prototype had 51 % ocean — the
edge ring was cut from 40 to 20 blocks and the spline lifted; (b) 4–12
water voxels per map were adjacent to cave air because the 6-block margin
was only vertical — replaced by `caveCeil` over the 3 × 3 neighbourhood
(§6); (c) trees and spawn were off by up to 2 blocks because the 2-D height
was interpolated through the lattice — the design now takes `hRaw` from the
voxel's own column and interpolates only the shape term (§3.3); (d) 23 %
of spawns landed under a tree — the spawn rule now excludes tree columns
(§9); (e) surface rules bled under cave floors (dirt/sand 2 blocks under any
cave) — surface rules now apply only within 9 blocks of `hRaw` (§4); (f)
the cave-mouth target was set from the measurement (p50 22) rather than the
initial guess of 15; the entrance threshold was lowered 0.3 → 0.25.

Cross-section through spawn, seed 3 (z = 256, x 224..287, y in 4-row bands,
most notable block of the 4 shown; `.` stone `:` deepslate `#` bedrock `~`
water `L` lava `g` grass `d` dirt `s` sand `T` terracotta/tuff `v` gravel
`c` coal `I` iron `u` copper `$` diamond `R` redstone `G/D/N`
granite/diorite/andesite `m` moss `i` dripstone `|` log `%` leaves):

```
148 |                                                           %%%  |
144 |                                                   |            |
140 |                                                   |            |
136 |           %%%%%            g                                 g.|
132 |         .....................................               ...|
128 |        g........................                               |
124 |        ........................                                |
120 |~~~~~~ ccc...c..cc.............                                 |
116 |~~~~~~s......c.................                                 |
112 |ssssssG.c.c........................d                            |
108 |...   ....................NNNNNN .....uuu                    ..G|
104 |....mm...... .NNNNNN......u...........uu.......NNNNNNNNN........|
100 |..............NNNNNN...uu....................NNNNN.............u|
 96 |......................uu...Iccc.........d....NNNNN......cc......|
 92 |....DDD......................................I..................|
 88 |..........uu............i...............u..................c....|
 84 |...      .u.....................D.D.............................|
 80 |G...    ...............  .....DDDDDDDD............c.............|
 76 |...............  ....... .........................c.............|
 72 |NNNNucc......... ........................... ...................|
 68 |.NN.....................................vvvvv...................|
 64 |..cccc.........   ..........II..................................|
 60 |................ ..............................ccccc........D.DD|
 56 |..LL....T.TTTTT.II...........L.    ..........GGGGG.............I|
 52 |vv..............I..vvvvv........ .............GGGG.......TTT   I|
 48 |.:GGGGGG..::.:....:.:...::...:::::::.::..::...:..::.:..::.:.....|
 44 |vNNNNN::TTTTTTTTTT:::::::::::::::::::::::::::::::::::::::::DDD::|
 40 |::::::::::TTTTTTT                          :::::::II:::::::::TTT|
 36 |::::::::::                                      ::::::::::::::::|
 32 |:II:::::::                                      ::::::GG::::::::|
 28 |:I::::::::::                   G              ::::::::GG::::::::|
 24 |  ::::::::::::::::TTRT::::::::::$$TTT::::$::::::::I:::::::::::::|
 20 | ::::           R::::::::::::::    :::$$:::::::::::::::::::::  i|
 16 |::::::      :::::::::::::::::::: :::::::GGG                     |
 12 |::$$:::   :::::::::::::::::::::::R:::::                         |
  8 |L:::::: L :::::LL:::::R:::::::LLLLLL:LLLLLLLLLLLLLLLLLLLLLLLLLLL|
  4 |LLLLLL::::::::::LLLLLLLLLLLLL::LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL|
  0 |################################################################|
```

The spawn column is at x 256 (centre), grass at y 139 on the hill top
left; a lake at y 116–120 to the west; a cave breaks through under x 262 at
y 128–132; a large cheese cavern spans y 20–44 under the middle; the lava
sea fills the cavern floor at y ≤ 10. Seed 1's section (mountain at spawn,
snow at y 164–172, emerald at 148, iron seams at 152–160) and seed 2's (a
geode at x 249–256 y 40–48, ravine-free forest) are in the prototype output
and read the same way.

## 13. Out of scope / later

- Mountain lakes and any water above y 120 (would need a per-lake enclosure check; every other water rule is "≤ 120", which keeps test 5 exact).
- Swamp / mangrove / mud biome: with all water at sea level a swamp is just a wet plain; revisit with lakes.
- Bushes, mossy cobblestone patches, fallen logs, large oaks, dark oak, jungle: none needed to hit the tree targets.
- Aquifers (vanilla's per-region water tables) — replaced by enclosed pools.
- Ore veins as vanilla 1.18 "large ore veins" (copper/iron sheets): dropped, the per-chunk counts already exceed vanilla's per-block density.
- Villages, structures, loot, mobs — CLAUDE.md non-goals.
- Worker-thread generation, chunk eviction, greedy meshing — performance project.
- Engine hand-offs, not worldgen: spawn column lookup (§9); noise-field cache keyed by seed (§2); `NEWEST_GEN_VERSION = 3` and `worldProfile(3)`; specs.md §4 wording on PRNGs (§10).
