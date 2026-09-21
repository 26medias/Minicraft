# Worldgen v3 — "rich world"

Status: design, gate 1 repaired 2026-09-21 (see §14). Branch `worldgen`.
Targets generator version 3 (`genVersion 3`, height 256); v1 and v2 worlds
are untouched forever. Evidence in §12 comes from a throwaway prototype (not
committed; scratchpad `wg3/proto.ts`) that implements every rule below and
was run on 12 full maps (seeds 1–12, 1024 chunks each) and on 100 seeds
(1000–1099) for the spawn and kid-distance rules.

Constraints honoured: finite 512 × 512, 32 × 32 chunks, hard walls; 256 tall,
`bedrock` at y = 0; `generateChunkV3(chunk, seed)` runs on the main thread and
is a pure function of `(seed, cx, cz)` — it never reads another chunk. Frozen
block catalog: every block named here exists in `blocks.catalog.data.ts` or
`blocks.base.data.ts` (60 names, none retired). Hard cap 3 ms / chunk
generation, target 2 ms.

Conventions used throughout: `h` = top solid y of a column in a flat cell
(§3.2); `hRaw` = the real-valued height before that rounding; "p50/p90" =
percentile over the stated seed set; **E** = exact assertion, **S** =
statistical assertion. Every numeric bound appears once, in §11; §1 states
the targets and points at the assertion that guards each.

## 1. Goals and player-experience targets

| Target (what the kid gets) | Guarded by |
|---|---|
| A view from a hill at spawn: spawn column at h ≥ 130 whenever such a column exists within 96 blocks of the centre, else ≥ 122 | 11.11 |
| Room to build: ≥ 40 % of columns within Chebyshev 24 of spawn dry, river-free and within ±3 of spawn height | 11.11, 11.12 |
| No cliff or pit ambush near spawn: open-sky single-step drop within 32 blocks p90 ≤ 20 | 11.12 |
| A tree within ~10 blocks, a cave mouth within ~50, first ore within ~30 blocks of digging | 11.12 |
| Mountains to 220–238, cliffs and overhangs on real mountains only, no floating islands | 11.4, 11.15 |
| 8 land biomes on every seed, each with its own top blocks and trees | 11.10 |
| 25–47 % water (sea, lakes, rivers), all at one level so the liquid scheduler never runs at load | 11.4, 11.5 |
| Caves everywhere below the surface, denser with depth, lava sea at the bottom, nothing drains a lake | 11.5, 11.6 |
| Eight ore families in vanilla-shaped bands, veins continuous across chunk planes | 11.7, 11.2 |
| A dig shaft that meets something new (ore, pocket, blob, cave) at least every ~40 blocks | 11.12 |
| Generation ≤ 3 ms per chunk on this machine; downstream mount cost owned by the perf project | 11.13, §2.1 |

## 2. Pipeline

Every stage is a pure function of `(seed, cx, cz)` and the arrays produced
by earlier stages of the *same* chunk. No stage reads another `Chunk`.
Stages 5–6 replay *feature instance lists* of the 3 × 3 chunk neighbourhood;
those lists are pure functions of `(seed, originChunk)` (§10) and may be
memoised.

| # | Stage | Resolution | Produces | ms (12-seed mean) |
|---|---|---|---|---|
| 1 | Column stack | 2-D, 24 × 24 columns (chunk + pad 4) | `hRaw`, `h`, biome, `amp`, `ampCell`, entrance mask, river, ravine, `caveCeil`, `waterNear` | 0.32 |
| 2 | Lattice | 3-D, 5 × (yTop/4+1) × 5 nodes, cell 4 × 4 × 4 | `S` (shape, blocks), `Dch` (cheese carve), `Dtn` (tunnel carve) | 0.21 |
| 3 | Fill | per voxel, y < yTop | `kind`: 0 terrain-air, 1 solid, 2 cave-air, 3 water; ravines | 0.34 |
| 4 | Surface | per column, top-down | block ids: biome top/filler, beaches, sea floor, snow, deepslate, lava sea, ice | 0.17 |
| 5 | Underground features | per instance, 3 × 3 origins | ores, stone blobs, pockets, geodes, pools; then moss/dripstone | 0.42 + 0.10 |
| 6 | Trees | per instance, 3 × 3 origins | trunks and canopies clipped to this chunk | 0.01 |

`yTop = min(252, ceil((max h over the padded columns + 28) / 4) · 4)`;
everything above is air and never visited. The chunk array is assumed
zero-filled on entry (a fresh `Chunk` is); the generator writes every voxel
below `yTop` and nothing at or above it. Total 1.55 ms mean (§12).

Noise fields (`createNoise2D/3D` from `simplex-noise`, 20 fields, §10) are
built once per seed and kept in a module-level `Map<seed, Fields>` in
`generation.v3.ts`. Building them costs 0.5–2.5 ms; the 10–13 ms first chunk
of a process is V8 JIT warm-up, not field construction, and cannot be
removed by caching.

### 2.1 Downstream budget (engine measurements, gate 1)

Per mounted chunk, 81 around spawn, real `fillChunkLights` +
`computeChunkShadows` + `meshChunk`: v2 mount mean 18.5 ms; v3 generation
2.1 + light 7.3–9.6 + shadows 12–20 (p95 27–37, max 95) + mesh 11 = **mean
34–41 ms, p95 53–61**. Faces per chunk 2 958 mean vs 615 on v2. Shadows
dominate: every sky-lit non-opaque voxel under the 3 × 3 max-opaque-y casts a
32-block ray, and caves, pits and overhangs multiply those voxels. Liquid
scheduler: tick 1 seeds 67–80 k water voxels (400 ms once), then the
frontier decays to zero; 200 ticks produce 0 writes.

Worldgen's share of this: the entrance-zone share (`ENT_T`, §6) and the
80–119 cave density are the only cheap levers, and both are set by play
targets (11.12), so worldgen keeps them. The rest is handed to the
performance project explicitly: shadow ray budget, meshing off-thread,
mount pacing (`flushDirtyChunks` mounts 2 chunks per frame → ~80 ms frames
while streaming v3, ~37 on v2).

## 3. Terrain shape

### 3.1 Column fields (stage 1, 2-D simplex fBm, octaves halve wavelength and amplitude)

| Field | Oct. | Wavelength | Use |
|---|---|---|---|
| `C` continentalness | 3 | 420 | base height; `+0.08` bias |
| `E` erosion | 3 | 330 | mountain-ness `M` |
| `PV` peaks-valleys | 4 | 140 | `PV = 1 − 2·|fbm|` (ridged) |
| `T` temperature | 2 | 320 | biome |
| `HU` humidity | 2 | 300 | biome |
| `R` river | 2 | 210 | channel where `|R| < w` |
| `D` detail | 3 | 26 | ±3.5 blocks |
| `ENT` entrance mask | 1 | 90 | `> ENT_T = 0.1` ⇒ tunnels may breach the surface |
| `RG` ravine gate | 1 | 300 | `> 0.4` ⇒ ravine zone |
| `RAV` ravine line | 1 | 230 | ravine where `|RAV| < w(y)` |
| `RAVD` ravine depth | 1 | 300 | depth 40–65 |
| `PATCH` | 1 | 9 | podzol / coarse dirt / gravel / clay patches |

No jitter field (gate 1 F1: it caused 2–3-block biome flicker). Spawn and
wall shaping applied to `C` before the spline:
`C += 0.45 · smooth(1 − d_centre/110)` (spawn continent: land at (256, 256)
on every seed); `C −= 0.8 · smooth(1 − d_edge/20)` (20-block ocean ring at
the wall). `smooth(t) = t²(3 − 2t)` on `t` clamped to 0..1.

### 3.2 Height, exactly in this order

```
base   = spline(C) through (-1,98) (-0.55,104) (-0.3,113) (-0.15,121) (0.1,127) (0.45,136) (1,146)  [smooth between knots]
M      = smooth((0.3 − E)/0.7) · smooth((C + 0.05)/0.35) · (1 − 0.6·smooth(1 − d_centre/128))   // mountain-ness, softened near spawn
h      = base + M · (PV > 0 ? 92·PV : 18·PV)
T      = fbm(T) − 0.7·clamp((h − 130)/90)           // lapse rate on THIS h (pre-terrace, pre-river, pre-detail)
land   = pickLand(T, HU)                             // §4, decided once
if land == badlands and h > 124: q = floor(h/6)·6; h = q + 6·smooth((h − q)/3 − 0.5)    // terraces
rivers (§5) may pull h toward 117
h     += 3.5 · fbm(D) · (1 − river)
hRaw   = h;  h = ceil(hRaw) − 1                      // top solid y in a flat cell
biome  = h < 118 ? ocean : land
```

### 3.3 3-D shape (overhangs, cliffs), and why nothing floats

```
amp(x,z)    = h > 126 ? 22 · smooth((M − 0.4)/0.35) · smooth((h − 126)/20) : 0      // blocks; EXACTLY 0 unless M > 0.4
S(node)     = amp · fbm3(SHAPE, x/44, y/30, z/44, 3 oct) · smooth(1 − |hRaw − y|/40)    // lattice; 0 when amp = 0 or |hRaw − y| ≥ 40
flatCell(x,z) = amp == 0 at the cell's 4 xz corners (x&~3, z&~3), (+4,0), (0,+4), (+4,+4)
dt(voxel)   = hRaw(own column) − y + (flatCell ? 0 : trilinear(S))                       // block units; solid iff dt > 0
ampCell(x,z) = max amp over the same 4 corners                                            // bound on |trilinear(S)| in that column
```

`hRaw` comes from the voxel's own column, so in a flat cell the top solid
block is exactly `h`; trees and the spawn rule only use flat cells (§8, §9).
The 40-block taper plus the 1 block/block vertical gradient means a detached
blob needs `fbm3 > 0.68` sustained over 4 blocks; measured floating solids
are 1–14 isolated voxels per map (11.15). Decision: no deliberate floating
islands.

## 4. Biomes

`pickLand(T, HU)`: snowy if T < −0.45; else if T < −0.15: plains if HU <
−0.25 else taiga; else if T < 0.3: plains if HU < −0.25, forest if HU < 0.35,
else cherry; else badlands if HU < −0.35, desert if HU < 0.1, else savanna.
Ocean = any column with h < 118 (its `land` value still selects ice and
beach material).

Surface rules are applied per column, top-down, to the first 9 solid voxels
under terrain-air or water (`depth` 0 = top). Cave-air resets the depth
counter only when `y > hRaw − 9` (so cave-mouth ledges get their biome top
and deep cave floors stay stone). Precedence, first match wins:

1. **under water** (water directly above): depth 0 → `sand` if h > 110 (or `gravel` where PATCH > 0.35), else `clay` where PATCH > 0.2 else `gravel`; depth 1–2 → `sand`.
2. **beach** (`117 ≤ h ≤ 122`, land ≠ badlands) or **river bank** (`river > 0.6`): depth 0–3 → `sand`, or `gravel` when land is snowy or taiga.
3. **snow line** (`y ≥ 160 + 20·T`, or land = snowy at any y): depth 0 → `snow_block`, depth 1–2 → `dirt`.
4. **stony peak** (`amp > 8`): stone (no top block).
5. **biome**:

| Biome | depth 0 | depth 1–3 | deeper | Trees (§8) |
|---|---|---|---|---|
| plains | `grass_block` | `dirt` | stone | oak 0–2 |
| forest | `grass_block` | `dirt` | stone | oak+birch 8–12 attempts |
| cherry | `grass_block` | `dirt` | stone | cherry 2–4 |
| taiga | `podzol` where PATCH > 0.45 else `grass_block` | `dirt` | stone | spruce 6–9 |
| snowy | (rule 3) | | | spruce 1–2 |
| savanna | `coarse_dirt` where PATCH > 0.55 else `grass_block` | `dirt` | stone | acacia 1–2 |
| desert | `sand` (depth 0–2) | `sandstone` (depth 3–7) | stone | none |
| badlands | `red_sand` if y ≤ 128, else band | terracotta band for y ≥ 100 | stone | none |

Terracotta band (badlands, y ≥ 100, depth 0–8): index `y & 15` into
`[terracotta, orange_terracotta, terracotta, yellow_terracotta, terracotta, white_terracotta, red_terracotta, terracotta, brown_terracotta, orange_terracotta, terracotta, light_gray_terracotta, terracotta, red_terracotta, orange_terracotta, terracotta]`.
Below all rules: `stone` for y ≥ 52, `deepslate` for y < 44, and between
44 and 51 `deepslate` with probability `(52 − y)/8` from `hash(x, y, z)`.

## 5. Water

- **Sea level 120, fixed.** Every terrain-air voxel (`dt ≤ 0`) with `y ≤ 120` is `water`; in snowy land the y = 120 voxel is `ice`. No other rule places water. Lakes are inland depressions below 118; there are no lakes above sea level.
- **Rivers:** `w = 0.045 · clamp(1 − (h − 126)/30)` (none above h 156); for `|R| < w + 0.05` and h > 114: `river = 1 − smooth((|R| − w)/0.05)`, `h += (117 − h)·river`. Banks/channel (`river > 0.6`) get rule 2 of §4.
- **Stability:** generated water and lava never have `air` on a side or below (11.5). Water sits only at y ≤ 120 in terrain-air; a side neighbour at that y is terrain-air (water), solid, or cave-air, and cave-air is kept ≥ 6 blocks under every nearby surface by `caveCeil` (§6). Ice is solid.
- **Pools** (own chunk, centre in local 4..11): per chunk 2 lava attempts (y 12–40) and 2 water attempts (y 40–100). From the attempt point look ≤ 8 blocks down for a cave floor; take the disc of radius `r ∈ [2, 3.5)` of floor voxels with air above; keep those whose 4 side neighbours and the voxel below are solid or in the disc; place if ≥ 4 survive. Measured 280–335 pools per map.
- **Lava sea:** every cave-air voxel with y ≤ 10 is `lava` (`lava.lightLevel` 12, blocks.base.data.ts:96: it glows before the kid reaches it). Parent decision: kept, Minecraft-faithful.

## 6. Caves

Carve terms are evaluated at lattice nodes (4 × 4 × 4) as signed "blocks of
carve" and trilinearly interpolated; `deep = clamp((112 − y)/92)`; nodes
with `y > h + 4` or `y < 2` are −99. A cell whose 8 corners are all ≤ 0 is
skipped (most cells).

| Type | Node formula (positive ⇒ carve) |
|---|---|
| cheese `Dch` | `(fbm3(CHEESE, x/96, y/48, z/96, 2) − (0.58 − 0.28·deep)) · 24` |
| spaghetti | `(rs² − (S1² + S2²)) · 450`, `S1, S2` at `(x/54, y/32, z/54)`, `rs = 0.085 + 0.045·deep + boost`, `boost = 0.04·clamp(1 − (h − y)/30)` in entrance columns else 0 |
| noodle (y < 92) | `(0.0036 − (N1² + N2²)) · 1100`, fields at `(x/26, y/20, z/26)` |
| `Dtn` | max(spaghetti, noodle) |

Per column: `waterNear = min over 3 × 3 of (hRaw − ampCell) < 122`;
`caveCeil = that min − 6`; `entrance = ENT > 0.1 and not waterNear`.
Per voxel with `dt > 0`, in this order:
- cheese: cave-air if `dt > 6 and y < caveCeil − (entrance ? 18 : 0)` and `Dch > 0` — cheese never breaches; in entrance zones it stays ≥ 24 below the surface so a tunnel mouth cannot open straight into a cavern;
- tunnels: cave-air if (`dt > 6 and y < caveCeil`) or (`entrance and dt > −2`), and `Dtn > 0`;
- ravine (§6.1) may also carve.
Cave-air at y ≤ 10 becomes lava. Measured cave-air share of rock per band
and mouth statistics: 11.6, 11.12.

### 6.1 Ravines

Ravine zone: `RG > 0.4` and h > 128 and `amp < 6` and not waterNear;
`ravW = 0.035·smooth((RG − 0.4)/0.2)`, `depth = 40 + 25·smooth(RAVD)`,
`bottom = round(h − depth)`. Voxel is ravine air when `|RAV| < ravW · (0.4 +
0.6·(y − bottom)/(h − bottom))` for `bottom ≤ y < h + 60` (≈ 8 wide at the
rim, 3 at the floor). The 4 voxels `bottom − 4 ≤ y < bottom` of every
ravine-core column (`|RAV| < 0.4·ravW`) are forced solid, so caves under the
floor never merge into it (gate 1 F5). A column is "in the channel" when
`|RAV| < ravW + 0.005`; trees and spawn use that predicate.

### 6.2 Decoration (over cave-air voxels; `DECO` 3-D noise at xz/40, y/40)

- moss: `DECO > 0.45` and `56 < y < 112`: floor block → `moss_block`; 1 in 5 floor voxels also get moss on top; 1 in 3 ceiling blocks → `moss_block`;
- dripstone: `DECO < −0.45`: 1 in 7 floor voxels grow a `dripstone_block` column 1–3 tall; 1 in 9 ceiling voxels a stalactite 1–3 tall. (No `pointed_dripstone` in the catalog.)
Ratios use `hash(x, y, z)` on world coordinates.

## 7. Ores and underground variety

All underground features are **instance lists** (§10): `oresOf`,
`blobsOf`, `pocketsOf`, `geodesOf`, `poolsOf(seed, cx, cz)`. Veins are
random walks of `size` steps driven by the instance's own sub-stream: write
the current voxel, with p 0.5 also one diagonal neighbour, move one block on
a random axis, then clamp y into `[y0, y1]` (exact band). Only `stone` and
`deepslate` are replaced; in deepslate the `deepslate_*_ore` row is used. No
exposure culling (glints in cave walls are the point). Origin y is drawn
from a triangular distribution `tri(y0, peak, y1)`.

| Ore | y0–peak–y1 | attempts/chunk | steps | Gate | Vanilla (1.21) |
|---|---|---|---|---|---|
| coal | 60–128–200 | 24 | 6–14 | — | 0..192 ×20 size 17 + 136..320 ×30 |
| iron | 16–60–112 | 12 | 4–9 | — | −24..56 peak 16 ×10 |
| iron (mountain) | 140–185–230 | 24 | 4–9 | origin chunk `chunkMaxH ≥ 165` | 80..384 peak 232 ×90 |
| copper | 50–92–130 | 10 | 5–10 | — | −16..112 peak 48 ×16 |
| gold | 6–30–70 | 5 | 4–8 | — | −64..32 peak −16 ×4 |
| gold (badlands) | 40–80–120 | 20 | 3–6 | origin chunk centre column is badlands land, and the origin column is badlands with h > 120 | 32..256 ×50 in badlands |
| lapis | 12–40–76 | 4 | 3–7 | — | −32..32 peak 0 ×2 |
| redstone | 4–12–40 | 8 | 4–8 | — | −64..15 ×4; −96..−32 ×8 |
| diamond | 4–8–36 | 4 | 2–5 | — | −144..16 peak −64 ×7 |
| diamond (large) | 4–10–30 | 1 | 5–8 | p 1/8 | size 12 at 1/9 |
| emerald | 100–180–220 | 20 | 1–3 | origin chunk `chunkMaxH ≥ 165` | mountains ×100 size 3 |

`chunkMaxH(seed, cx, cz)` = max `h` over the 16 columns `(cx·16 + 4i + 2,
cz·16 + 4j + 2)`, `i, j ∈ 0..3` — the origin chunk's own columns, whoever
replays it. Gate 165 (was 150) keeps emerald out of spawn hills (11.12).

Stone blobs (ellipsoids `rx = rz = r`, `ry = 0.7·r`; a rim voxel with `0.7 ≤
d ≤ 1` is skipped when `hash % 3 == 0`; replace stone/deepslate only):
`granite`, `diorite`, `andesite` 5 attempts each, y 40–120, r 2.5–5;
`tuff` 3 attempts, y 4–60, r 3–6; `calcite` 1 attempt, y 60–130, r 2–4.
Pockets (`ry = 0.6·r`): `gravel` 7 attempts y 20–115 r 2–4; `dirt` 8
attempts y 60–118 r 2–3.5; `clay` 1 attempt y 30–110 r 2–3.

Geodes: 1 in 24 chunks, centre y 24–60, radius `r ∈ [4, 6.5)`, per-voxel
radial jitter `+0.6·(hash % 100)/100`. Shells: `smooth_basalt` for `r < d ≤
r + 0.8`, `calcite` for `r − 1 < d ≤ r`, amethyst layer for `r − 2 < d ≤ r −
1` (`budding_amethyst` where `hash % 6 == 0` **and** some face neighbour
lies in the calcite or amethyst layer, otherwise `amethyst_block`), air
inside. Geodes overwrite anything.

## 8. Surface decoration

`treesOf(seed, cx, cz)`: species set from the biome of the chunk's centre
column (x 8, z 8); `n` attempts per the §4 table; each draws `(lx, lz)`,
species, trunk height and two reals from the chunk's TREE stream; dropped
if within Chebyshev 2 of an earlier tree of the same chunk, or if its column
has h < 121, is a beach (§4 rule 2), has `river > 0.2`, is in a ravine
channel, has a biome different from the chunk centre, is at or above the
snow line `160 + 20·T`, or is not a flat cell. The base voxel at `h` is
replaced by `dirt` unless it is `dirt`, `grass_block`, `podzol`,
`coarse_dirt` or `snow_block`; trunk logs overwrite anything; leaves only
replace air.

Canopies (`top = h + trunk`):
- **oak** (`oak_log`/`oak_leaves`, trunk 4–6) and **birch** (`birch_log`/`birch_leaves`, 5–7): layers `top−3`, `top−2` radius 2 with each corner kept when `hash % 2 == 1`, `top−1` and `top` radius 1 without corners, `top+1` the 5-voxel plus.
- **spruce** (`spruce_log`/`spruce_leaves`, 6–10): one leaf at `top+1`; rings of radius 1, 2, 1, 2 … from `top` down to `h+3`, radius-2 rings without corners.
- **acacia** (`acacia_log`/`acacia_leaves`, 5–6): the trunk shifts one block sideways at `top−1` (axis from real 1, sign from real 2); 5 × 5 canopy at `top` minus corners and a plus at `top+1`. The bent log has nothing under it by design (11.9 exempts it).
- **cherry** (`cherry_log`/`cherry_leaves`, 4–5): discs radius 3 at `top−1` and `top`, radius 2 at `top+1`, one leaf at `top+2`.

Padded origins: a chunk draws `treesOf` for the 9 chunks around it and
clips. Max reach is 3 (cherry) + 1 (acacia bend) < 16.

Snow: `snow_block` tops (no thin layer block exists). Beaches per §4.
Bushes and mossy cobblestone: dropped.

## 9. Spawn rule

`spawnV3(seed) → (x, z)`, computed once at world creation and stored in the
world meta (engine hand-off: `World.create` for genVersion ≥ 3 calls it and
`main.ts` uses the stored column; `findSafeSpawn` then finds `h + 1` on that
column with its existing scan). Walk square rings `r = 0..96` around (256,
256), ring by ring, `dz` outer, `dx` inner; four passes in order:

| pass | min h | gentle 65 × 65 | mouth within 48 | min buildable |
|---|---|---|---|---|
| 1 | 130 | yes | yes | 40 % |
| 2 | 122 | yes | yes | 40 % |
| 3 | 122 | no | no | 40 % |
| 4 | 122 | no | no | 0 |

A column is accepted when all of: `river = 0`, not in a ravine zone
(`ravW = 0`), land ≠ snowy, h < snow line, not a beach, `|h − h(±2, 0)| ≤ 2`
and `|h − h(0, ±2)| ≤ 2` and the same for the 4 diagonals at ±1, flat cell,
no tree instance of the 3 × 3 chunks with base within Chebyshev 7,
**tunnelFree** (no tunnel node > 0 at the cell's 4 corners for y nodes from
`(h − 16) & ~3` to `h + 4`, entrance boost assumed), no ravine-channel column
within Chebyshev 32, **buildable** ≥ min (fraction of the 49 × 49 columns
with h ≥ 121, `river = 0`, `|h − h_spawn| ≤ 3`); when *gentle*: every column
within Chebyshev 32 has `amp ≤ 6` and differs from its +x and +z neighbour
by ≤ 10; when *mouth*: some lattice corner column within Chebyshev 48 is an
entrance column with a tunnel node > 0 at y ∈ {h−8, h−4, h} (a cave mouth
is likely nearby). Pass 4 always succeeds in practice (100/100 seeds found
a column in passes 1–3). Cost: p50 76 ms, p90 330 ms, max 3.2 s over 100
seeds — paid once per world, which is why the result is stored.

## 10. Determinism and PRNG

- **Noise fields:** `createNoise2D(alea(\`minicraft:v3:${seed}:${name}\`))` for the 2-D names `C E PV T HU R D ENT RAV RG RAVD PATCH` and `createNoise3D` for `SHAPE CHEESE S1 S2 N1 N2 DECO`; the name is exactly the field's table key. Renaming a field is a generator-version change.
- **Feature streams:** `streamSeed(seed, cx, cz, feature)` = murmur3 `fmix32` applied four times: `h = fmix(seed ^ 0x3a5f0d1b); h = fmix(h ^ imul(cx, 0x9e3779b1)); h = fmix(h ^ imul(cz, 0x85ebca77)); h = fmix(h ^ imul(feature, 0xc2b2ae3d))`; the chunk stream is `mulberry32(h)`. Feature ids: TREE 1, ORE 2, BLOB 3, POCKET 4, GEODE 5, POOL 6. Instance `i` of a list gets `subSeed = fmix(h ^ imul(i + 1, 0x9e3779b1))`, and every random decision inside the instance (vein walk) comes from `mulberry32(subSeed)`. The chunk stream is consumed only while *listing* (position, y, size, chance draw for every attempt, whether or not the attempt is kept), so a list is identical whoever computes it, and an instance's walk is identical whoever replays it. `hash(x, y, z)` (white noise for blob rims, geode jitter, canopy corners, deepslate blend) is `fmix(fmix(imul(x, 73856093) ^ imul(y, 19349663)) ^ imul(z, 83492791))` on **world** coordinates.
- Why numeric streams: a chunk lists 9 × 5 = 45 feature streams; alea's string seeding costs ~2 µs and an allocation each versus ~20 ns for the hash. specs.md §4 must be amended to "all generation randomness comes from the seeded `alea` noise fields or the v3 hash streams; `Math.random` stays banned" (decision for the owner).
- **Replay equivalence (the real invariant):** for every chunk B and every neighbour A, the instance list A uses for B's features is `oresOf(seed, B)` itself, and mountain/badlands gates read B's own columns (`chunkMaxH`, centre column). Tests 11.2 make this observable at the voxel level (ore continuity and density across chunk planes), because "A generated alone equals A generated after B" is true of any pure generator and catches nothing.
- **Reference hash — bootstrap procedure, not a value:** (1) implement `generateChunkV3` so that 11.1–11.16 are green; (2) run the vitest suite twice in separate processes and once in the browser build, hashing `blocks` of chunks (16,16), (0,0), (31,31) and the spawn chunk of seed 12345 with SHA-256; (3) only when the three hashes agree, commit them as constants with the commit message naming the prototype commit and this spec's section; (4) from then on any change to a constant in this document is `genVersion 4`. Until step 3 the hash test is skipped with a reason, never made to pass by recording whatever comes out.

## 11. Tests (the instrument)

"Map" = all 1024 chunks of one seed; statistical bounds are from the 12
seeds 1–12 (§12) with the margin stated; kid targets from 100 seeds. Every
bound lives here only.

1. **E** `worldProfile(3) = {height: 256}`, `NEWEST_GEN_VERSION === 3`, `generateChunk(c, seed, 3)` throws on a 64-high chunk; `generation.test.ts`'s current `expect(NEWEST_GEN_VERSION).toBe(2)` and `expect(() => worldProfile(3)).toThrow` are replaced; the dispatcher gets an explicit v3 branch. v1 and v2 reference hashes unchanged. v3 hash per the §10 bootstrap.
2. **E replay:** for 20 random chunks B, `oresOf/blobsOf/pocketsOf/geodesOf/treesOf(seed, B)` computed in a fresh process equal the lists computed after generating B's 8 neighbours (deep equality, incl. `sub`). **S seam (map):** ore voxels per solid voxel by local x (16 bins): every bin within ±0.15 points of the mean of bins 7–8 (measured max deviation 0.04–0.09); same-ore +x continuity at local x = 15 within ±3 points of that at x = 7 (measured 32.6–33.9 vs 33.7–35.0; the pre-repair build gave 4.8 vs 34.8).
3. **E** every column: `bedrock` at y 0 only; nothing at y ≥ 253.
4. **S heights (map):** min ≥ 50, median 118–134, p90 150–180, max 210–240; water columns 22–50 %; flat-ish land (|Δh| ≤ 2 over ±2) ≥ 44 %; river-channel columns 4–12 %. Measured: min 62–88, median 120–131, p90 152–176, max 222–238, water 25.5–46.5, flat 47.0–64.1, river 5.1–11.2. Red on: PV amplitude 92 → 12; spline flattened; C bias removed.
5. **E water (map, across chunk planes):** no `water`/`lava` voxel with `air` on any of its 4 sides or below; no water above y 120; `ice` only at y 120 in snowy land. Red on: `caveCeil` measured vertically only (pre-repair: 4–12 voxels per map).
6. **S caves (map):** cave-or-lava share of rock per band y 1–23: 13–21 %, 24–47: 11–19 %, 48–79: 7–12 %, 80–119: 3–6 %, ≥ 120: ≤ 3 %. Measured 14.9–18.8 / 13.0–16.9 / 8.5–10.4 / 3.7–5.0 / 1.0–2.1. **E:** no cave-air at y ≤ 10 (it is lava). **E ceiling (observable, map):** for every air voxel below a column's terrain top in a column that is non-entrance, non-ravine and whose 3 × 3 are all flat cells: every non-entrance non-ravine column of that 3 × 3 has its highest solid ≥ 6 above the voxel (1.3–2.1 M voxels checked per map, 0 violations; red at 1 voxel on the pre-`ampCell` rule).
7. **E ores:** every ore voxel is inside `[y0, y1]` of a row of its family (walks are clamped); `deepslate_*_ore` only below y 52 and plain `*_ore` only at or above y 44; every ore voxel replaced stone or deepslate. **S (map, voxels per chunk):** coal 90–140, iron 75–100, copper 65–78, gold 27–34, lapis 18–21, redstone 40–48, diamond 13–16, emerald 2–8. Measured: 97.6–131.5, 80.1–91.7, 69.1–73.0, 28.7–31.7, 19.5–19.9, 43.1–45.4, 14.1–15.0, 2.3–7.3. Red on: coal band shifted +8 (exact clause).
8. **S blobs (map, % of non-air voxels):** granite, diorite, andesite each 1.5–2.4; tuff 1.5–2.4; calcite 0.15–0.3; gravel 1.0–1.8; clay 0.08–0.16; amethyst 2 500–8 500 voxels; geodes 20–60 per map. Measured 1.80–2.01 / 1.83–2.01 / 0.20–0.22 / 1.21–1.56 / 0.10–0.13 / 3 396–7 319 / 25–55. **E:** no `tuff` at y ≥ 66; every `budding_amethyst` has an `amethyst_block`, `calcite` or `smooth_basalt` face neighbour.
9. **E trees (map):** for every instance of `treesOf` on every chunk, every log of its template is present in the world and every leaf of its template is a non-air block (occlusion by terrain or another tree allowed) — this is the border-truncation test; the base voxel of every instance is `dirt`, `grass_block`, `podzol`, `coarse_dirt` or `snow_block` (the acacia bend is not a base). **S:** forest-centre chunks average ≥ 2.5 trees (measured 2.8–3.6; attempts survive beaches, ravines, biome edges, snow line and non-flat cells at ~35 %); desert and badlands chunks 0.
10. **E surface (map, land columns whose terrain top equals `h`, outside ravine zones):** beach columns top `sand` or `gravel`; columns at/above the snow line or in snowy land top `snow_block`; desert columns (not stony, not beach) top `sand`; ocean-floor columns top `sand`, `gravel` or `clay`; every terracotta voxel matches the `y & 15` band and lies in badlands land. **S:** all 8 land biomes present on every seed (12/12); biome changes along the 512-block row through spawn 5–30 (measured 6–26); runs shorter than 6 blocks on that row ≤ 6 (measured 0–5).
11. **E spawn (100 seeds):** top block at exactly `h`, solid, not liquid/snow/ice; air at `h+1`, `h+2`; h ≥ 122; no log or leaf within Chebyshev 3 and 12 blocks up; passes 1–3 succeed (pass 4 never used); column buildable ≥ 40 % by the §9 definition. Measured 0 failures, buildable p50 47.6 %.
12. **S kid targets (100 seeds, voxel-level, search radius 96, censored at 999):** buildable within 24 (dry, river-free, |top − spawn top| ≤ 3) p50 ≥ 40 % (measured 45.4); open-sky single-step drop within 32 (trees excluded) p90 ≤ 20 (17); nearest tree p50 ≤ 14, p90 ≤ 32 (9.8 / 27); nearest cave mouth (terrain top < h − 3, air above) p50 ≤ 50, p90 ≤ 96 (42 / 69); first ore in a 3 × 3 shaft p50 ≤ 30, p90 ≤ 80 (25 / 67); longest stretch of a 3 × 3 shaft that is only stone/deepslate p50 ≤ 30, p90 ≤ 45 (23 / 37 — the kid-lens ask of p90 ≤ 30 needs ~2× more blobs and was not taken); emerald voxels within 32 of spawn p50 = 0 (0); biome runs shorter than 6 along 4 × 64 walks p90 ≤ 5 (4). Runtime ≈ 15 s in vitest; state it in the test name.
13. **S time (reference machine, after one warm-up chunk):** 81 chunks around spawn mean ≤ 2.0 ms and p95 ≤ 3.0 ms (measured over 12 seeds: mean 1.37–1.70, p95 1.75–2.54); full-map mean ≤ 2.0 (1.44–1.81). Not a CI gate: a GC pause can fail any max bound. Red on the per-voxel-noise variant (5–7 ms).
14. **E pools (map):** every `poolsOf` instance that placed liquid is enclosed (covered by 5), and ≥ 200 pools placed per map (measured 280–335).
15. **E/S shape (map):** isolated floating solid voxels (6 air neighbours, not leaves) ≤ 30 per map (1–14); ravine-core columns have floor ≥ `bottom − 1` (0 violations) and rim-to-floor depth ≤ 70 (max 41–63); at least 5 ravine-core columns per map (5–479; seed 8 has almost no ravine zone).
16. **S decoration (map):** moss 15 k–30 k voxels, dripstone 12 k–24 k (measured 18.6–25.1 k / 16.2–19.4 k); lava 280 k–460 k (320–419 k).

## 12. Evidence appendix (repaired prototype; Node 24, this machine)

Solo timing, 12 seeds × 1023 chunks (first chunk excluded): mean 1.55 ms,
p95 2.33, p99 3.00, max 9.96 (GC). Per seed p95 2.09–3.23 (seed 1 carries
JIT warm-up of its first ~100 chunks). 81 around spawn: mean 1.37–1.70, p95
1.75–2.54, max 1.96–4.04. Stage split (12-seed mean): cols 0.32, lattice
0.21, fill 0.34, surface 0.17, features 0.42, deco 0.10, trees 0.01.
`spawnV3`: 11–296 ms on seeds 1–12; p50 76, p90 329, max 3 214 ms on
100 seeds.

12-seed map statistics (min / p50 / max):

```
surface   min 62/76/88  p10 107/111/114  median 120/125/131  p90 152/160/176  max 222/232/238
water columns %  25.5 / 34.3 / 46.5      flat-ish land %  47.0 / 60.8 / 64.1      river columns %  5.1 / 8.1 / 11.2
biomes % ocean 21.8/29.3/40.6 forest 11.0/18.8/23.8 taiga 9.8/14.0/19.0 plains 8.4/12.5/15.4 snowy 2.6/11.4/18.4
         cherry 1.3/5.9/9.9 savanna 0.8/5.3/9.4 desert 2.7/4.4/7.5 badlands 0.6/1.8/3.0; distinct land biomes 8/8/8
biome changes on the spawn row 6/15/26; runs < 6 blocks 0/2/5
cave share of rock  1-23 14.9/16.8/18.8  24-47 13.0/14.8/16.9  48-79 8.5/9.6/10.4  80-119 3.7/4.4/5.0  120+ 1.0/1.4/2.1
ore per chunk  coal 97.6/110.9/131.5  iron 80.1/84.1/91.7  copper 69.1/72.0/73.0  gold 28.7/29.8/31.7
               lapis 19.5/19.8/19.9  redstone 43.1/44.2/45.4  diamond 14.1/14.4/15.0  emerald 2.3/3.5/7.3
ore by band (p50, per chunk): coal 48-79 9.5, 80-119 70.5, 120+ 31.4 | iron 24-47 16.7, 48-79 43.3, 80-119 16.9, 120+ 6.0
               copper 48-79 19.7, 80-119 50.8 | gold 1-23 5.5, 24-47 17.3, 48-79 6.5 | lapis 24-47 11.2, 48-79 7.3
               redstone 1-23 32.0, 24-47 12.2 | diamond 1-23 11.8, 24-47 2.6 | emerald 120+ 3.2
seam: ore density by local x — x=0 1.21, x=15 1.23, interior 1.26 (max deviation 0.06)
      same-ore +x continuity at x=15: 33.2 %, at x=7: 34.0 %
% of non-air: stone 52.2, deepslate 30.0, dirt 2.4, granite 1.96, diorite 1.93, tuff 1.94, andesite 1.87, gravel 1.43, lava 1.15, water 2.14, sand 0.71, calcite 0.21
counts per map: moss 18.6k/22.3k/25.1k  dripstone 16.2k/18.8k/19.4k  amethyst 3.4k/5.1k/7.3k  geodes 25/42/55  pools 280/315/335
                lava 320k/371k/419k  floaters 1/7/14  ravine-core columns 5/277/479  ravine depth p50 41-53 max 41-63
trees per map 838/1219/1493; forest-centre chunks mean 2.8/3.4/3.6, max 9-10
exact assertions (27 checks × 12 maps): all 0 — bedrock, water/lava enclosure, water ≤ 120, ice, cave ≤ 10 is lava,
   ceiling (1.3-2.1 M voxels/map), ore bands, deepslate variants, tuff height, budding neighbours, tree bases,
   tree completeness (logs and leaves of every instance), desert/badlands treeless, beach/snow/desert/sea-floor tops,
   terracotta index and biome, ravine floor
```

100-seed spawn and kid targets (p10 / p50 / p90 / max):

```
spawn strict failures 0; spawn h 123/131/142/159; offset from centre 28/56/98/125; buildable (column rule) 40.2/47.6/73.6/95.3
buildable within 24 (voxels) % 36.7/45.4/70.6/80.2      open-sky drop within 32  3/9/17/40
nearest tree 8.1/9.8/27.0/74        nearest cave mouth 21.5/42.0/69.0/999 (1 seed none within 96)
first ore in 3x3 shaft 7/25/67/999 (1 seed hit the lava sea first)      boring stretch 14/23/37/52
emerald within 32: 0/0/37/240        nearest other biome 1/6/20/33       biome runs < 6 per 4x64 walks 0/2/4/7
spawn biomes: plains 28, taiga 20, desert 20, forest 12, savanna 8, badlands 8, cherry 4
```

Cross-section through spawn, seed 3 (spawn (247, 133, 249); z = 249, x
215..278, y in 4-row bands, most notable block of the 4 shown; `.` stone
`:` deepslate `#` bedrock `~` water `L` lava `g` grass `d` dirt `s` sand `T`
terracotta/tuff `v` gravel `c` coal `I` iron `u` copper `$` diamond `R`
redstone `G/D/N` granite/diorite/andesite `i` dripstone `|` log `%` leaves):

```
140 |                                       %%%     %|%%%%%          |
136 |                                                |               |
132 |  gggg......dd             ..gg........................... .....|
128 |........cccc...           ...............c                 .....|
124 |................         .................                 .....|
120 |..............cc.~~~~~~~ .c................                .....|
116 |.     c.DDDDDD...s~~~~~~.....................              .u...|
112 |.......vvvvvv......NNN........................                  |
108 |    .......u.............................      i                |
104 |........NNNN.....u...DDDDDD.....................ddddddu..NNNNNNN|
100 |NN.................uu.......NNNNNN...........vvvvv..........vvvv|
 96 |.....uudvdvd..................................................I.|
 92 |....II.....................NNNuu..u...GGG.......ddd..III........|
 88 |.....................GGGGGGGGGuuu.........c.....cccc.II.........|
 84 |......DdDDDD...................D.D.D......uu......cc............|
 80 |.......GGGGv.....................DDD............................|
 76 |......................................uuu.......................|
 72 |.................................................ccc...c.III....|
 68 |...........................................................III..|
 64 |......................................uu.................II.....|
 60 |DDDDD ..............NNNNN.............uu...vvvv..vvv............|
 56 |.I........II........NNNNN................TTTTTTT.II.T........u..|
 52 |......II.......................................DDD............  |
 48 |::..::::.::GGGGGG.::.:..:.:::::..::...:.:....:DDDD::..:.:..:::.:|
 44 |TTTTTTTTTTT:::::::::::::::::::::::::::::::::::::::::::::L:G:::::|
 40 |::TGTT:TT::::::::::::::::::::TTTTTTTTT::::::::::::::::::::::::::|
 36 |L::::::::::::::::::::::::     I                 ::::::::::::::::|
 32 |:::::::::::::::::::::::::                    :::::::::::::::::::|
 28 |::::::::::::::G:::::::::::::::::::::::::T:::::I:I:::::::::::::TT|
 24 |::::::::::::::::      ::::::::::::::::::::::::::::::::::::::::::|
 20 |              :$:::::::::::::$::::::::::::::::::::::::::::::::::|
 16 |R          :T::::::::::::::::::::::::::::::::::::::::::::       |
 12 |:::::::TTTTTTTT:::::::::::::::::::::::::::::::::                |
  8 |LL::::::::::::::::::::::::::::::::::::::::::LLLLLLLLLLLLLLLLLLLL|
  4 |LLLLLLLLLLLLLLL::::::::::L:::::::::LLLL::::LLLLLLLLLLLLLLLLLLLLL|
  0 |################################################################|
```

A lake at y 116–120 left of spawn, a tunnel entrance at x ≈ 231 y 108–116
under the hill, a cheese cavern at y 20–36 with a lone iron glint on its
wall, the lava sea filling its floor at y ≤ 8, and the 6-block terracotta
terrace bands at y 40–44 (a tuff blob reads the same in this legend).

Misses, stated: the kid-lens "boring stretch p90 ≤ 30" was not reached (37)
and the target was set to 45 rather than doubling blob density; one seed in
100 has no cave mouth within 96 (spawn prefers flat land, mouths sit on
slopes — pass 1–2 now require a likely mouth within 48, which lifted p50
from 58 to 42); `spawnV3` can take 3 s on a bad seed, hence "compute once,
store in meta".

## 13. Out of scope / later

- Lakes above sea level, swamp/mangrove, bushes, mossy cobblestone, fallen logs, large oak, dark oak, jungle, aquifers, vanilla "large ore veins", villages/structures/loot/mobs (non-goals).
- Shadows, meshing, mount pacing and chunk eviction: performance project, with the §2.1 numbers as its input.
- Engine hand-offs, not worldgen: `NEWEST_GEN_VERSION = 3`, `worldProfile(3)`, explicit dispatcher branch; noise-field cache; `spawnV3` at world creation + spawn column in world meta; specs.md §4 PRNG wording.

## 14. Gate 1 changes

Rigour (R), engine (E), kid (K); parent decisions from `decisions.md`.

| Finding | Action |
|---|---|
| R-B1 / E-B1 padded-origin replay broken (vein draws vary; `colMax` ignored the origin) | Accepted. Every feature is an instance list with a per-instance sub-stream (§10); mountain gate = origin chunk's `chunkMaxH`; test 11.2 replaced by replay equality + voxel seam tests. Measured continuity 33.2 % at x = 15 vs 34.0 % interior (was 4.8 vs 34.8). |
| R-B2 / U10 reference hash | Accepted: bootstrap procedure in §10, no value recorded. |
| R-B3 / E-B2 tree bases on sand/gravel/snow/air | Accepted: trees skip beaches and river banks; `snow_block` allowed; acacia bend exempt; 0 bad bases on 12 maps. |
| R-B4 spawn under canopies, on snow | Accepted: canopy exclusion radius 7, snow-line and snowy checks; 0/100 strict failures. |
| R-B5 blob bounds (denominator), budding orphans | Accepted: bounds re-derived on 12 seeds as % of non-air; budding placed only with a calcite/amethyst face neighbour (exact by construction). |
| R-B6 ore outside band | Accepted: walks clamp y into the band; exact clause green. |
| R-N1 snowy top under cave mouths | Accepted: surface tests apply to columns whose terrain top equals h, outside ravine zones. |
| R-N2/N3/N4/N10 bounds from 3 seeds, duplicated, contradicting | Accepted: every bound stated once in §11 from 12 seeds; snowy filler dirt × 2, plains threshold −0.25, lapse on pre-terrace h, precedence list, "within 9 of hRaw" rule, deepslate 44–52, badlands gold implemented — all in §4/§7. |
| R-N6 leaf/log tautology | Accepted: template-completeness test (11.9), red on the truncated-canopy mutant by construction (missing leaves count). |
| R-N7 / E-B2 timing bound | Accepted: p95 bound, not CI-gating; spawn cost stated and moved to creation time. |
| R-N9 genVersion contract tests | Accepted (11.1). |
| R-N11 rules without assertions | Accepted: 11.14–11.16 and additions to 11.4/11.8/11.10 cover ravines, floaters, rivers, pockets, calcite, pools, moss/dripstone, beaches, sea floor, snow line, gold bonus; acacia bend covered by 11.9's template check. |
| U1–U9, U11 | U1 field names fixed (`HU`, `SHAPE`, `DECO`, `RAVD`); U2 jitter removed; U3 `RAVD` defined; U4 lapse/biome order fixed in §3.2; U5 −0.25; U6 precedence list; U7 in §4; U8 radii and mouth definition in 11.12; U9 zero-filled array stated in §2; U11 tolerances kept only as cross-seed bounds — the v3 hash is the exact guard. |
| E-B2 ceiling test tautology | Accepted: observable ceiling test (11.6); it found a real 1-voxel defect (column `amp` vs cell-corner `amp`) fixed by `ampCell` (§3.3, §6). |
| E-N3 downstream mount cost | Accepted as a budget row (§2.1); worldgen keeps `ENT_T` and cave density for play reasons; rest handed to perf. |
| E-N6 `hashv` on local coords | Accepted: world coordinates everywhere. |
| E-N8 first-chunk wording | Accepted (§2). |
| K-B1 spawn on the roughest land | Accepted per parent: M softened by 0.6 within 128 of the centre; hill preferred (h ≥ 130 pass first); buildable ≥ 40 % required. Measured buildable p50 45 % (was 23), spawn h p50 131. |
| K-B2 cliffs and 50–70-block pits near spawn | Accepted: cheese never breaches and stays ≥ 24 below the surface in entrance zones; tunnels alone breach; gentle 65 × 65 (`amp ≤ 6`, |Δh| ≤ 10) and no ravine channel within 32. Drop p90 17 (was 52; parent's bound 20). |
| K-B3 lava plunge | Rejected per parent: lava sea stays. |
| K-F1 biome flicker | Accepted: lapse on pre-detail h, jitter removed; short runs per 4 × 64 walks p90 4. |
| K-F2 boring shafts | Partly: 5 blobs per igneous type (r 2.5–5), gravel 7, dirt 8; test added; p90 37 against the asked 30 — not pushed further (see §12 misses). |
| K-F4 emerald under spawn | Accepted: mountain gate 165; emerald within 32 of spawn p50 0. |
| K-F5 ravine floor | Accepted: 4-block solid floor, depth ≤ 63 measured. |
| Owner: entrance share | `ENT_T` lowered 0.25 → 0.1 to keep cave mouths findable after cheese stopped breaching (mouth p50 42); the shadow cost of that is in §2.1. |
