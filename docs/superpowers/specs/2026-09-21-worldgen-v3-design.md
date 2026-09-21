# Worldgen v3 — "rich world"

Status: design, gate 1 rounds 1 and 2 repaired 2026-09-21 (§14). Branch
`worldgen`. Targets generator version 3 (`genVersion 3`, height 256); v1
and v2 worlds are untouched forever. Evidence in §12 comes from a throwaway
prototype (scratchpad `wg3/proto.ts`, not committed) that implements every
rule below, run on **100 full maps (seeds 1–100)** and, for spawn and kid
targets, the same 100 seeds. Every exact assertion in §11 is green on all
100; every statistical bound in §11 is derived from those 100 and holds on
all of them with the stated margin; each changed assertion was shown red on
a named mutant (§11, §14).

Constraints honoured: finite 512 × 512, 32 × 32 chunks, hard walls; 256
tall, `bedrock` at y = 0; `generateChunkV3(chunk, seed)` runs on the main
thread and is a pure function of `(seed, cx, cz)` — it never reads another
chunk. Frozen block catalog: every block named here exists in
`blocks.catalog.data.ts` or `blocks.base.data.ts` (60 names, none retired).
Bit-exactness across engines and devices is a requirement (the kid plays on
two machines; unvisited chunks regenerate): generation uses only `+ − × /`,
`Math.sqrt`, `Math.floor/ceil/round/min/max/abs`, `Math.imul` and integer
ops. `Math.hypot`, `sin`, `cos`, `exp`, `pow` are implementation-approximated
in ECMA-262 and are **not used** in generation (the harnesses' `Math.hypot`,
`sin`, `cos` are measurement-only). Generation time is bounded informationally
by 11.13 (cold mean ≤ 4 ms, p95 ≤ 10 ms) and in CI by work counts, not by a
wall-clock cap.

Conventions: `h` = top solid y of a column in a flat cell (§3.2); `hRaw` =
its real-valued height; "p50/p90" = percentile over the stated seed set;
**E** exact assertion, **S** statistical. Every numeric bound appears once,
in §11.

## 1. Goals and player-experience targets

| Target (what the kid gets) | Guarded by |
|---|---|
| A view from a hill: spawn at h ≥ 130 when a qualifying column exists within 128 rings of the centre (pass 1), else the first qualifying column at h ≥ 122 (passes 2–4); measured spawn h p50 131, 60/100 at ≥ 130 | 11.11 |
| Room to build: ≥ 40 % of columns within 24 dry, river-free, within ±3 of spawn height | 11.11, 11.12 |
| No ambush near spawn: single-step open-sky drop within 32 p90 ≤ 20; within 64 (coast excluded) p90 ≤ 25; no ravine channel within 64; at most 8 one-or-two-column holes ≥ 4 deep within 64 | 11.12 |
| A tree within ~10 blocks, a real cave mouth (§11.12 definition) within ~45, first ore within ~25 blocks of digging, something non-stone in the shaft wall at least every ~30 blocks | 11.12 |
| Mountains to 217–243, cliffs and overhangs on real mountains only, no floating islands | 11.4, 11.15 |
| 8 land biomes (≥ 7 on every seed), each with its own tops and trees | 11.10 |
| 16–51 % water, all at one level, scheduler idle after tick 1 | 11.4, 11.5 |
| Caves denser with depth, lava sea at the bottom, nothing drains a lake, no 30-block pits | 11.5, 11.6, 11.12 |
| Eight ore families in vanilla-shaped bands, veins continuous across chunk planes in x and z | 11.7, 11.2 |
| Generation ≈ 1.9 ms warm mean; cold and downstream numbers stated, not hidden | 11.13, §2.1 |

## 2. Pipeline

Every stage is a pure function of `(seed, cx, cz)` and the arrays produced
by earlier stages of the *same* chunk. No stage reads another `Chunk`.
Stages 5–6 replay feature **instance lists** of the 3 × 3 chunk
neighbourhood; lists are pure functions of `(seed, originChunk)` (§10) and
are memoised per seed (engine: a module-level `Map` keyed by
`seed:cx:cz:feature`, evicted with chunk unload — never cleared mid-map).

| # | Stage | Resolution | Produces | ms warm (100-seed p50, contended) |
|---|---|---|---|---|
| 1 | Column stack | 2-D, 25 × 25 columns, pad −4/+5 | `hRaw`, `h`, biome, `amp`, `ampCell`, entrance, river, ravine, `caveCeil`, `waterNear` | 0.38 |
| 2 | Lattice | 3-D, 5 × (yTop/4+1) × 5 nodes, cell 4 × 4 × 4 | `S` shape, `Dch` cheese, `Dtn` tunnels | 0.25 |
| 3 | Fill | per voxel, y < yTop | `kind`: 0 terrain-air, 1 solid, 2 cave-air, 3 water; ravines | 0.37 |
| 4 | Surface | per column, top-down | block ids | 0.20 |
| 5 | Underground features | per instance: ores, blobs, pockets, geodes from the 3 × 3 origins (36 list replays), pools own-chunk only (1) | ores, blobs, pockets, geodes, pools; moss/dripstone | 0.56 + 0.10 |
| 6 | Trees | per instance, 3 × 3 origins (9 replays) | trunks, canopies | 0.02 |

Work counters `W.nodes` (one per lattice node evaluated), `W.replays` (one
per instance-list replay) and `W.instances` (one per instance whose bounding
box meets the chunk) are incremented **at the point of evaluation** and reset
per chunk; 11.13 asserts them.

`yTop = min(252, ceil((max h over the padded columns + 28)/4)·4)`; the
chunk array is assumed zero-filled on entry (a fresh `Chunk` is); nothing is
written at or above `yTop`. Noise fields (20, §10) are built once per seed
into a module-level `Map<seed, Fields>` (0.5–2.5 ms); the 10–25 ms first
chunk of a process is V8 JIT warm-up.

**Asymmetric pad −4/+5 (PW 25).** Every column at local −1..16 has its four
lattice-cell corners (`x & ~3` … `+4`) inside the grid, so `ampCell`,
`waterNear`, `caveCeil` and the entrance flag of every own column and of
every shared lattice node (local 0 and 16) are computed from complete data.
**Invariant:** neighbouring chunks compute identical values at every shared
lattice node (`S`, `Dch`, `Dtn`, entrance flag) and identical `caveCeil` for
the shared column — 11.2 tests it across both planes.

### 2.1 Downstream budget (engine measurements, as ratios vs v2)

Same 81 chunks around spawn, real `fillChunkLights` + `computeChunkShadows`
+ `meshChunk`: mount ≈ **1.45–1.7 ×** v2, shadows ≈ **2.2–3 ×**, mesh ≈
1.3–1.6 ×, faces per chunk ≈ **3.8 ×** (≈ 2 700 mean, 4 600 max, vs ≈ 710).
Absolutes are re-measured at implementation (the gate-1 machine was on a
power-save governor). Liquid scheduler: tick 1 seeds 50–90 k water voxels
once, then 0 writes over 200 ticks. Shadows dominate and are the
performance project's (shadow ray budget, off-thread meshing, mount pacing
in `flushDirtyChunks`). Lowering `ENT_T` from 0.25 to 0.1 did **not** raise
shadow cost (measured: it fell).

## 3. Terrain shape

### 3.1 Column fields (2-D simplex fBm; octaves halve wavelength and amplitude)

| Field | Oct. | λ | Use |
|---|---|---|---|
| `C` | 3 | 420 | base height, `+0.08` |
| `E` | 3 | 330 | mountain-ness `M` |
| `PV` | 4 | 140 | `PV = 1 − 2·|fbm|` (ridged) |
| `T` | 2 | 320 | biome |
| `HU` | 2 | 300 | biome |
| `R` | 2 | 210 | rivers |
| `D` | 3 | 26 | ±3.5 blocks detail |
| `ENT` | 1 | 90 | entrance zone where `> ENT_T = 0.1` |
| `RG` | 1 | 300 | ravine zone where `> 0.4` |
| `RAV` | 1 | 230 | ravine line |
| `RAVD` | 1 | 300 | ravine depth 40–65 |
| `PATCH` | 1 | 9 | surface patches |

`d_centre = sqrt((x−256)² + (z−256)²)`, `d_edge = min(x, z, 511−x, 511−z)`,
`smooth(t) = t²(3−2t)` on t clamped to 0..1. Before the spline:
`C += 0.45·smooth(1 − d_centre/110)` (land at the centre on every seed),
`C −= 0.8·smooth(1 − d_edge/20)` (20-block ocean ring at the wall).

### 3.2 Height, exactly in this order

```
base  = spline(C) through (-1,98) (-0.55,104) (-0.3,113) (-0.15,121) (0.1,127) (0.45,136) (1,146)   [smooth between knots]
M     = smooth((0.3 − E)/0.7) · smooth((C + 0.05)/0.35) · (1 − 0.6·smooth(1 − d_centre/128))
h     = base + M · (PV > 0 ? 92·PV : 18·PV)
T     = fbm(T) − 0.7·clamp((h − 130)/90)        // lapse on THIS h
land  = pickLand(T, HU)                          // §4, once
if land == badlands and h > 124: q = floor(h/6)·6; h = q + 6·smooth((h − q)/3 − 0.5)
rs    = clamp(1 − (h − 126)/30)                  // river strength, 0 at h ≥ 156
w     = 0.045·rs
if rs > 0 and |R| < w + 0.05 and h > 114: river = rs·(1 − smooth((|R| − w)/0.05)); h += (117 − h)·river   else river = 0
h    += 3.5·fbm(D)·(1 − river)
hRaw  = h;  h = ceil(hRaw) − 1
biome = h < 118 ? ocean : land
```

The bank fade is scaled by `rs` (round 2: without it, `w = 0` still left a
0.05-wide channel that sliced 158-high hills down to 117 — the "slope"
cliffs of 30–37 blocks found near spawn).

### 3.3 3-D shape, and why nothing floats

```
amp(x,z)      = h > 126 ? 22·smooth((M − 0.4)/0.35)·smooth((h − 126)/20) : 0     // EXACTLY 0 unless M > 0.4
S(node)       = amp·fbm3(SHAPE, x/44, y/30, z/44, 3)·smooth(1 − |hRaw − y|/40)
corners(x,z)  = (x&~3, z&~3), (+4, 0), (0, +4), (+4, +4)
flatCell(x,z) = amp == 0 at all 4 corners
ampCell(x,z)  = max amp over the 4 corners                 // bound on |trilinear(S)| in that column
dt(voxel)     = hRaw(own column) − y + (flatCell ? 0 : trilinear(S));  solid iff dt > 0
```

In a flat cell the top solid block is exactly `h`; trees and spawn use flat
cells only. Floating solids: 3–47 isolated voxels per map (11.15). No
deliberate floating islands.

## 4. Biomes

`pickLand(T, HU)`: snowy if T < −0.45; else if T < −0.15: plains if HU <
−0.25 else taiga; else if T < 0.3: plains if HU < −0.25, forest if HU <
0.35, else cherry; else badlands if HU < −0.35, desert if HU < 0.1, else
savanna. Ocean = h < 118 (`land` still selects ice and beach material). No
jitter field (round-1 K-F1).

Surface rules apply per column, top-down, to solid voxels with `depth ≤ 8`
(0 = top) and `y > hRaw − 9 − depth`; cave-air resets the depth counter only
when `y > hRaw − 9`. Precedence, first match wins:

1. **under water**: depth 0 → `sand` if h > 110 (`gravel` where PATCH > 0.35), else `clay` where PATCH > 0.2 else `gravel`; depth 1–2 → `sand`.
2. **beach** (`117 ≤ h ≤ 122`, land ≠ badlands) or **bank** (`river > 0.6`): depth 0–3 → `sand` (`gravel` if land is snowy or taiga).
3. **snow line** (`y ≥ 160 + 20·T`, or land = snowy at any y): depth 0 → `snow_block`, depth 1–2 → `dirt`.
4. **stony peak** (`amp > 8`): stone.
5. **biome**:

| Biome | depth 0 | depth 1–3 | Trees (§8) |
|---|---|---|---|
| plains | `grass_block` | `dirt` | oak 0–2 |
| forest | `grass_block` | `dirt` | oak+birch 8–12 |
| cherry | `grass_block` | `dirt` | cherry 2–4 |
| taiga | `podzol` (PATCH > 0.45) else `grass_block` | `dirt` | spruce 6–9 |
| snowy | rule 3 | | spruce 1–2 |
| savanna | `coarse_dirt` (PATCH > 0.55) else `grass_block` | `dirt` | acacia 1–2 |
| desert | `sand` (depth 0–2) | `sandstone` (depth 3–7) | none |
| badlands | `red_sand` if y ≤ 128 else band | band for y ≥ 100, depth 0–8 | none |

Terracotta band: index `y & 15` into `[terracotta, orange_terracotta,
terracotta, yellow_terracotta, terracotta, white_terracotta, red_terracotta,
terracotta, brown_terracotta, orange_terracotta, terracotta,
light_gray_terracotta, terracotta, red_terracotta, orange_terracotta,
terracotta]`. Below all rules: `stone` for y ≥ 52, `deepslate` for y < 44,
between 44 and 51 `deepslate` with probability `(52 − y)/8` from `hash(x, y,
z)`.

## 5. Water

- **Sea level 120, fixed.** Every terrain-air voxel (`dt ≤ 0`) with `y ≤ 120` is `water`; snowy land: `ice` at y = 120. No other rule places water; no water above 120.
- **Rivers:** §3.2; banks per §4 rule 2.
- **Stability:** generated water and lava never have `air` on a side or below (11.5): water sits at y ≤ 120 in terrain-air; side neighbours are terrain-air (water), solid, or cave-air, and cave-air is ≥ 6 under every nearby surface (`caveCeil`, §6). Ice is solid.
- **Pools** (own chunk, centre in local 4..11): 2 lava attempts (y 12–40) and 2 water attempts (y 40–100) per chunk; look ≤ 8 down for a cave floor; take the floor disc `r ∈ [2, 3.5)` with air above; keep voxels whose 4 sides and the voxel below are solid-or-in-disc; place if ≥ 4 survive. **Skipped when the pool centre is a ravine-core column** (its floor is forced solid; round 2 R2-B1).
- **Lava sea:** cave-air at y ≤ 10 is `lava` (`lava.lightLevel` 12). Parent decision: kept.

## 6. Caves

Carve terms at lattice nodes (4 × 4 × 4), trilinearly interpolated; `deep =
clamp((112 − y)/92)`; nodes with `y > h + 4` or `y < 2` are −99; cells with
all 8 corners ≤ 0 are skipped.

| Type | Node formula (positive ⇒ carve) |
|---|---|
| cheese `Dch` | `(fbm3(CHEESE, x/96, y/48, z/96, 2) − (0.58 − 0.28·deep))·24` |
| spaghetti | `(rs² − (S1² + S2²))·450`, fields at `(x/54, y/32, z/54)`, `rs = 0.085 + 0.045·deep + boost`, `boost = 0.09·clamp(1 − (h − y)/30)` in entrance columns else 0 |
| noodle (y < 92) | `(0.0036 − (N1² + N2²))·1100`, fields at `(x/26, y/20, z/26)` |
| `Dtn` | max(spaghetti, noodle) |

Per column: `waterNear = min over 3 × 3 of (hRaw − ampCell) < 122`,
`caveCeil = that min − 6`, `entrance = ENT > 0.1 and not waterNear`. Per
voxel with `dt > 0`, in order:
1. deep cheese: cave-air if `dt > 6 and y < caveCeil − (entrance ? 18 : 0)` and `Dch > 0`;
2. shallow cheese pit (entrance columns only): cave-air if `y ≥ hRaw − 14 and dt > −2` and `Dch > 0` — the band `hRaw − 24 .. hRaw − 14` stays solid, so a breaching cavern has its floor ≥ h − 14 (round 2 kid item: real cave mouths without 30-block pits);
3. tunnels: cave-air if (`dt > 6 and y < caveCeil`) or (`entrance and dt > −2`), and `Dtn > 0`;
4. ravine (§6.1).
Cave-air at y ≤ 10 becomes lava.

### 6.1 Ravines — one zone predicate, three derived ones

`RG_T = 0.4 − 0.05·smooth((d_centre − 128)/48)` (0.4 within 128 of the
centre, 0.35 from 176 outward — round 3: every world should get a real
ravine); `ravW(column) = RG > RG_T and h > 128 and amp < 6 ? 0.035·smooth((RG
− RG_T)/0.2)·smooth((d_centre − 128)/48) : 0` — **the zone is `ravW > 0`**;
it is 0 within 128 blocks of the centre and ramps in to 176 (spawn's 64-block
ravine-free rule, round 2). `depth = 40 + 25·smooth(RAVD)`, `bottom =
round(h − depth)`. Derived: *carving column* = zone and not waterNear;
*channel column* = carving and `|RAV| < ravW + 0.005` (trees, spawn);
*core column* = carving and `|RAV| < 0.4·ravW` (floor, pools, 11.15).
Voxel is ravine air in a carving column when `|RAV| < ravW·(0.4 + 0.6·(y −
bottom)/(h − bottom))` for `bottom ≤ y < h + 60`; the 4 voxels `bottom − 4 ≤
y < bottom` of every core column are forced solid.

### 6.2 Decoration (cave-air voxels with `y < caveCeil` only; `DECO` 3-D noise at xz/40, y/40)

- moss: `DECO > 0.45` and `56 < y < 112`: floor → `moss_block`; 1 in 5 floor voxels also get moss on top; 1 in 3 ceiling blocks → `moss_block`;
- dripstone: `DECO < −0.45`: 1 in 7 floor voxels grow a `dripstone_block` column 1–3 tall; 1 in 9 ceiling voxels a stalactite 1–3 tall.
The `y < caveCeil` limit (round 2) keeps stalagmites off surfaces (seed 73
had one as a mountain column's top).

## 7. Ores and underground variety

Instance lists (§10): `oresOf`, `blobsOf`, `pocketsOf`, `geodesOf`,
`poolsOf(seed, cx, cz)`. A vein is a random walk of `size` steps from the
instance's sub-stream: write the current voxel, with p 0.5 also one
diagonal neighbour `(+0|1, 0, +0|1)`, move one block on a random axis, clamp
y into `[y0, y1]`. **Reach invariant:** `size ≤ 14` steps of 1 block plus a
1-block diagonal ⇒ every voxel of a vein is within 15 blocks of its origin
< 16, so the 3 × 3 replay is sufficient; a chunk skips an instance whose
bounding box misses it. Only `stone`/`deepslate` are replaced;
`deepslate_*_ore` in deepslate; no exposure culling. Origin y from
`tri(y0, peak, y1)`.

| Ore | y0–peak–y1 | attempts | steps | Gate |
|---|---|---|---|---|
| coal | 60–128–200 | 24 | 6–14 | — |
| iron | 16–60–112 | 12 | 4–9 | — |
| iron (mountain) | 140–185–230 | 24 | 4–9 | origin `chunkMaxH ≥ 165` |
| copper | 50–92–130 | 10 | 5–10 | — |
| gold | 6–30–70 | 5 | 4–8 | — |
| gold (badlands) | 40–80–120 | 20 | 3–6 | origin chunk centre column is badlands land, and the origin column is badlands land with h > 120 |
| lapis | 12–40–76 | 4 | 3–7 | — |
| redstone | 4–12–40 | 8 | 4–8 | — |
| diamond | 4–8–36 | 4 | 2–5 | — |
| diamond (large) | 4–10–30 | 1 | 5–8 | p 1/8 |
| emerald | 100–180–220 | 20 | 1–3 | origin `chunkMaxH ≥ 165` |

`chunkMaxH(seed, cx, cz)` = max `h` over `(cx·16 + 4i + 2, cz·16 + 4j + 2)`,
`i, j ∈ 0..3` — the origin chunk's own columns, whoever replays it.

Blobs (ellipsoids `rx = rz = r`, `ry = 0.7·r`; rim voxels with `0.7 ≤ d ≤ 1`
skipped when `hash % 3 == 0`; replace stone/deepslate): `granite`,
`diorite`, `andesite` 5 attempts each, y 10–120, r 2.5–5; `tuff` 8 attempts,
y 4–48, r 3–6; `calcite` 2 attempts, y 60–130, r 2–4. Pockets (`ry =
0.6·r`): `gravel` 9 attempts y 6–115 r 2–4; `dirt` 10 attempts y 60–118 r
2–3.5; `clay` 1 attempt y 30–110 r 2–3.

Geodes: 1 in 24 chunks, centre y 24–60, `r ∈ [4, 6.5)`, per-voxel radial
jitter `+0.6·(hash % 100)/100` with `d = sqrt(dx² + dy² + dz²) + jitter`.
Shells: `smooth_basalt` for `r < d ≤ r + 0.8`, `calcite` for `r − 1 < d ≤
r`, amethyst layer for `r − 2 < d ≤ r − 1`, air inside. In the amethyst
layer a voxel is `budding_amethyst` iff `hash % 6 == 0` **and** at least one
face neighbour lies in the calcite layer or in the amethyst layer *without
itself qualifying as budding* (i.e. its own `hash % 6 ≠ 0`); otherwise
`amethyst_block`. Geodes overwrite anything.

## 8. Surface decoration

`treesOf(seed, cx, cz)`: species set from the biome of the chunk centre
column (x 8, z 8); `n` attempts per §4; each attempt draws `(lx, lz)`,
species, trunk height and two reals from the TREE stream; dropped if within
Chebyshev 2 of an earlier tree of the same chunk, or if its column has h <
121, is a beach, has `river > 0.2`, is a ravine channel column, has a biome
different from the chunk centre, is at or above the snow line `160 + 20·T`,
is not a flat cell, or is an entrance column (`ENT > 0.1`) that fails
`tunnelFree` (§9) — no tree over a cave mouth (round 2: seed 7 had a plug on
air). The base voxel at `h` becomes `dirt` unless it is `dirt`,
`grass_block`, `podzol`, `coarse_dirt` or `snow_block`; logs overwrite
anything; leaves replace air only.

Canopies (`top = h + trunk`), with the hand-derived voxel counts 11.9 asserts:
- **oak**/**birch** (trunk 4–6 / 5–7): layers `top−3`, `top−2` radius 2 with each corner kept when `hash % 2 == 1`; `top−1`, `top` radius 1 without corners; `top+1` the 5-voxel plus. Leaves 53–61, bbox ±2, y `top−3..top+1`.
- **spruce** (6–10): one leaf at `top+1`; rings radius 1, 2, 1, 2… from `top` down to `h+3` (radius-2 rings without corners). With `L = trunk − 2` layers: leaves `8·ceil(L/2) + 20·floor(L/2) + 1`, bbox ±2, y `h+3..top+1`.
- **acacia** (5–6): trunk shifts one block sideways at `top−1` (axis from real 1, sign from real 2), so two logs are off the base column; 5 × 5 minus corners at `top` (20, the centre is log) and a plus at `top+1`: leaves 25, bbox ±3 about the base, y `top..top+1`.
- **cherry** (4–5): discs `dx² + dz² ≤ 10` at `top−1` and `top` (36 each, centre is log), `≤ 5` at `top+1` (20), one leaf at `top+2`: leaves 93, bbox ±3, y `top−1..top+2`.

Max reach 3 + 1 < 16: one ring of neighbours suffices.

## 9. Spawn rule

`spawnV3(seed) → {x, z}` is computed **in memory** at world creation by
`main.ts`'s new-world branch only (`World.create` is untouched): it shows
"Building your world…", yields one frame (`await` a `requestAnimationFrame`)
so the message paints, calls `spawnV3`, and passes `[x + 0.5, height − 1, z +
0.5]` to `findSafeSpawn`, whose column scan lands on `h + 1`. No meta field,
no schema change; continues use the persisted player position. Worst
observed cost ≈ 2 s on fresh seeds. Search is **work-bounded**, never
time-bounded: rings `r = 0..128` around (256, 256), ring by ring (`dz`
outer, `dx` inner), four passes:

| pass | min h | gentle | mouth | min buildable |
|---|---|---|---|---|
| 1 | 130 | yes | yes | 40 % |
| 2 | 122 | yes | yes | 40 % |
| 3 | 122 | no | no | 40 % |
| 4 | 122 | no | no | 0 |

A column qualifies when, in this order (cheap first): `river = 0`, `ravW =
0`, land ≠ snowy, h < snow line, not a beach; `|h − h(±2,0)| ≤ 2`, `|h −
h(0,±2)| ≤ 2`, same at the 4 diagonals ±1; flat cell; no tree instance of
the 3 × 3 chunks with base within Chebyshev 7; **tunnelFree** (no tunnel or
cheese node > 0 at the cell's 4 corners for y nodes `(h−16)&~3 .. h+4`,
entrance boost assumed); **buildable** ≥ min (fraction of the 49 × 49
columns with h ≥ 121, `river = 0`, `|h − h_spawn| ≤ 3`); **no ravine channel
column within Chebyshev 64**; then if *gentle*: every column within 64 has
`amp ≤ 6` and every column within 32 differs from its +x/+z neighbour by ≤
10 — tested **before** *mouth*: some lattice-corner column within Chebyshev
40 is an entrance column with a tunnel or cheese node > 0 at y ∈ {h−8, h−4,
h}. Column, ravine-channel and mouth-corner predicates are memoised for the
search. Measured on 100 seeds: pass 4 never used, p50 0.20–0.25 s, p90 0.85–1.16 s,
max 1.5–1.7 s (≈ 2 s worst seen on fresh seeds); work p50 70 k, max 121 k
column evaluations. Rings ≤ 128 is the bound.

## 10. Determinism and PRNG

- **Noise fields:** `createNoise2D(alea(\`minicraft:v3:${seed}:${name}\`))` for `C E PV T HU R D ENT RAV RG RAVD PATCH`; `createNoise3D` for `SHAPE CHEESE S1 S2 N1 N2 DECO`. Renaming a field is a generator-version change.
- **Feature streams:** `streamSeed(seed, cx, cz, feature)` = murmur3 `fmix32` four times: `h = fmix(seed ^ 0x3a5f0d1b); h = fmix(h ^ imul(cx, 0x9e3779b1)); h = fmix(h ^ imul(cz, 0x85ebca77)); h = fmix(h ^ imul(feature, 0xc2b2ae3d))`; chunk stream `mulberry32(h)`. Feature ids TREE 1, ORE 2, BLOB 3, POCKET 4, GEODE 5, POOL 6. **Instance index = attempt index** `i` (counted over every attempt of the list, kept or not); its sub-stream is `mulberry32(fmix(h ^ imul(i + 1, 0x9e3779b1)))`. The chunk stream is consumed only while listing (position, y, size, chance draw of every attempt); a vein's walk uses only its sub-stream. `hash(x, y, z) = fmix(fmix(imul(x, 73856093) ^ imul(y, 19349663)) ^ imul(z, 83492791))` on world coordinates.
- Why numeric streams: 45 stream initialisations per chunk; alea string seeding ≈ 2 µs + allocation each vs ≈ 20 ns. specs.md §4 is to be amended: "generation randomness comes from the seeded `alea` noise fields or the v3 hash streams; `Math.random` stays banned".
- **Replay equivalence:** every chunk that touches feature F of origin chunk B computes `xOf(seed, B)` and B's own gates (`chunkMaxH`, centre column). Tested at the voxel level in x and z (11.2); "A alone == A after B" is a property of any pure generator and is not a test.
- **Reference hash bootstrap (executable):** (1) implement until 11.1–11.16 are green; (2) `generation.test.ts` hashes `blocks` of chunks **(0,0), (16,16), (31,31), (5,27)** of seed 12345 — fixed chunks, never the spawn chunk (spawn constants may be tuned without a version bump) — with the repo's existing **FNV-1a-32** `hashBytes`, which XORs each **Uint16 element** of `blocks` (not bytes) in index order — the prototype hashes the identical element sequence; (3) run the vitest suite twice in separate processes; only when both agree commit the four values as constants, the commit message naming this section; (4) the prototype is **not** committed: at bootstrap time its four FNV-1a-32 values are written into this section and the implementation's values are cross-checked against them — **if implementation and prototype disagree, the implementation is wrong until proven otherwise**; (5) thereafter any constant change is `genVersion 4`. No browser leg (no runner exists). Until step 3 the test is skipped with a reason.

## 11. Tests (the instrument)

"Map" = all 1024 chunks of one seed. **CI runs the fixed seeds 1, 2, 3, 5,
8, 13, 21, 34** for map-level tests (≈ 8 × 6 s) and seeds 1–100 for the
spawn/kid suite on demand (≈ 15 min, not per-commit). **Margin rule:** every
statistical bound is derived from the 100-seed run (seeds 1–100) as *mean ±
4 sd* for count statistics and as the *observed range widened by 25 % of its
width on each side* for fractions and heights, rounded outward; bounds are
therefore properties, not memorised values, and hold on all 100 seeds by
construction (measured range in parentheses). The mutant that turns an
assertion red is named where the assertion changed in gate 1.

1. **E** `worldProfile(3) = {height: 256}`, `NEWEST_GEN_VERSION === 3`; `generation.test.ts`'s `expect(NEWEST_GEN_VERSION).toBe(2)` / `worldProfile(3).toThrow` are replaced; explicit v3 dispatcher branch; v1/v2 hashes unchanged; v3 hash per §10 bootstrap.
2. **E shared nodes:** for 12 chunks per seed — always (30,30), (30,5), (5,30) so the chunk-31 planes are covered, plus 9 random — generate the chunk, its +x and +z neighbours, and compare `S`, `Dch`, `Dtn` on the shared node planes, the entrance flag and **`caveCeil`** on the shared columns: 0 mismatches (15 500–18 600 comparisons per seed). Mutant `pad4` (symmetric pad): 264 mismatches on seed 1, plus 363 unstable water voxels and 1 955 ceiling violations. **S seam (map), x and z:** ore voxels per solid voxel by local x and by local z (16 bins each): every bin within ±0.15 points of the mean of bins 7–8 (max deviation 0.03–0.11 / 0.02–0.09); same-ore +x continuity at local x 15 and +z at local z 15 within ±3 points of the interior value (border 32.3–34.2 / 32.0–33.9 vs interior 33.5–35.4 / 33.0–35.0). Mutant `noz` (±z origins dropped): +z continuity 0.38 %, z-bin deviation 0.45; the x clauses stay green — hence both axes.
3. **E** every column: `bedrock` at y 0 only; nothing at y ≥ 253.
4. **S heights (map, range ± 25 %):** min ≥ 55 (62–90), median 115–139 (119–135), p90 132–202 (144–190), max 210–250 (217–243); water columns 8–60 % (16.3–51.0); flat-ish land ≥ 35 % (42.0–69.5); river columns 2–12.5 % (3.6–10.4). Red on PV amplitude 92 → 12, flattened spline, or C bias removed (round 1).
5. **E water (map, across planes):** no `water`/`lava` voxel with `air` on a side or below; no water above y 120; `ice` only at y 120 in snowy land. Red on vertical-only margin (round 1) and on `pad4` (363).
6. **S caves (map, range ± 25 %):** cave-or-lava share of rock, y 1–23: 12–22 % (13.6–20.2), 24–47: 11–19 % (12.6–17.5), 48–79: 6.9–12.5 % (7.8–11.6), 80–119: 2.9–5.8 % (3.4–5.3), ≥ 120: ≤ 4 % (1.4–3.5). **E** no cave-air at y ≤ 10. **E ceiling, two clauses (map):** (a) for every air voxel below the terrain top in a non-entrance, non-ravine column whose 3 × 3 are all flat cells, every non-entrance non-ravine column of the 3 × 3 has its highest solid ≥ 6 above it (1.2–2.2 M voxels per map); (b) for every `kind = 2` voxel in a non-entrance non-ravine column that is *not* in such a flat neighbourhood (i.e. `amp > 0` around), the same distance clause (0.17–0.79 M per map). Both 0 on 100 seeds. Mutant `noceil` (gate `y < caveCeil` removed): 7 477 / 2 128.
7. **E ores:** the test transcribes the §7 band table **by hand** — coal 60..200; iron 16..112 or 140..230; copper 50..130; gold 6..70 or 40..120; lapis 12..76; redstone 4..40; diamond 4..36 or 4..30; emerald 100..220 — and every ore voxel lies in a band of its family; `deepslate_*_ore` only below y 52, plain `*_ore` only at or above 44; every ore voxel replaced stone or deepslate. Mutant `coalshift` (60–128–200 → 68–136–208): 11 out-of-band on seed 1 (an imported table stays green). **S per chunk (map, mean ± 4 sd):** coal 78–158 (96.9–138.8), iron 71–104 (79.8–96.7), copper 67–77 (68.8–74.7), gold 25–34.5 (27.9–32.8), lapis 18.6–20.5 (19.0–20.2), redstone 40–46.5 (41.1–45.1), diamond 13.1–15.2 (13.4–14.7), emerald 0–12 (1.6–8.7). **S per band (voxels per chunk, mean ± 4 sd):** coal 48–79: 8.2–10.6, 80–119: 59.5–81.5, 120+: 5.9–69.5; iron 1–23: 0.6–1.3, 24–47: 14.7–17.7, 48–79: 41.2–45.7, 80–119: 15.5–18.7, 120+: 0–25.7; copper 48–79: 18–21, 80–119: 46.9–55.3, 120+: 0.5–2.4; gold 1–23: 4.6–6.2, 24–47: 15.7–18.2, 48–79: 4.3–8.7, 80–119: 0–3.0, 120+: 0–0.05 (the badlands row's y1 = 120 lies on the bucket edge); lapis 1–23: 0.9–1.8, 24–47: 9.9–12.0, 48–79: 6.6–7.9; redstone 1–23: 28.6–34.3, 24–47: 10.6–13.2; diamond 1–23: 10.6–12.8, 24–47: 2.0–2.9; emerald 80–119: 0–0.9, 120+: 0–11; **exactly 0 in every band cell disjoint from the family's y-range** (coal 1–47, copper 1–47, lapis 80+, redstone 48+, diamond 48+, emerald 1–79).
8. **S blobs (map, % of non-air, range ± 25 %):** granite 1.7–2.1, diorite 1.7–2.05, andesite 1.7–2.0 (1.74–2.05); tuff 4.1–5.05 (4.24–4.88); calcite 0.34–0.44; gravel 1.3–1.96; clay 0.07–0.18; dirt 2.2–3.25; amethyst 1 750–9 150 voxels and geodes 16–69 per map (mean ± 4 sd; 25–57). **E:** no `tuff` at y ≥ 66; every `budding_amethyst` has an `amethyst_block`, `calcite` or `smooth_basalt` face neighbour.
9. **E trees (map):** every log of every `treesOf` instance is present and every leaf voxel is non-air (template completeness; mutant "tree origins of the 8 neighbour chunks dropped", i.e. stage 6 replays only `treesOf(seed, cx, cz)`: the rigour reviewer's build gives 4 missing logs / 5 220 missing leaves / 301 incomplete trees on seed 1, mine 8 / 6 799 / 397 — red either way); base voxel is `dirt`, `grass_block`, `podzol`, `coarse_dirt` or `snow_block` (the acacia's two bent logs are not bases); **canopy shape** per species with the §8 hand numbers: log count = trunk height (acacia: exactly 2 logs off the base column), leaf count in range, bbox and y range exact. Mutant `nobend`: 20 acacias red on seed 1. **S:** forest-centre chunks average ≥ 0.4 trees (mean − 4 sd; 1.28–3.75); desert and badlands chunks 0.
10. **E surface (map; land columns whose terrain top equals `h`, outside ravine zones):** beach tops `sand`/`gravel`; snow-line and snowy tops `snow_block`; desert (not stony, not beach) `sand`; ocean-floor `sand`/`gravel`/`clay`; every terracotta voxel matches the `y & 15` band and is in badlands land. Mutants: `nodecoceil` (stalagmites without the `caveCeil` limit) → 1 red on seed 73; `treetunnel` (trees over tunnel mouths) → 2 red on seed 7. **S:** ≥ 7 land biomes per seed (7–8; 99/100 have 8); biome changes on the spawn row 4–27 (mean ± 4 sd; 9–22); runs < 6 blocks on it ≤ 8 (mean 1.8 + 4 sd; 0–5).
11. **E spawn (100 seeds):** top block at exactly `h`, solid, not liquid/snow/ice; air at `h+1`, `h+2`; h ≥ 122; no log/leaf within Chebyshev 3 and 12 up; column buildable ≥ 40 %; pass 4 never used. 0 failures; spawn h p50 131 (60 seeds ≥ 130).
12. **S kid targets (100 seeds, voxel-level, trees excluded from "terrain top", search radius 96, censored at 999):** buildable within 24 (dry, river-free, |top − spawn top| ≤ 3) p50 ≥ 40 % (48.2; p10 37); open-sky single-step drop within 32 p90 ≤ 20 (16); worst step within 64 excluding coast (low side ≤ 120) p90 ≤ 25 (19); no ravine channel column within 64 on 100/100; 1–2-column holes ≥ 4 deep within 64 ≤ 8 (max 3); pockmarked land within 64 ≤ 10 % (max 6.4); nearest trunk (a log within 12 of the top) p50 ≤ 14, p90 ≤ 32 (10.6 / 22.2); **cave mouth** = column c whose terrain top is < h − 3 with air above, with ≥ 6 such open columns in the 9 × 9 around c, an 8-neighbour that is not open and whose top is ≤ 5 above c's floor, and air reachable from c's floor (6-connected, within Chebyshev 8) at a voxel ≥ 8 below its own column's h with solid somewhere above it: nearest p50 ≤ 50, p90 ≤ 90 (42 / 87); first ore in a 3 × 3 shaft p50 ≤ 30, p90 ≤ 80 (21 / 57; censored — lava sea reached first — on 1/100 seeds, counted as 999); longest run of 3 × 3 shaft layers that are only stone/deepslate, **the stone→deepslate transition at y 44–52 counting as a new block type**, p90 ≤ 32 (31 — the ask was 30; see §12) and, over the CI seeds, max ≤ 45 (40); emerald voxels within 32 p50 = 0 (0); biome runs < 6 along 4 × 64 walks p90 ≤ 5 (3). Runtime ≈ 15 min; on demand.
13. **Time, informational (not CI):** cold — fresh memo, `spawnV3` first, then the 81 chunks around spawn — mean ≤ 4 ms, p95 ≤ 10 ms (this run: mean 1.49–3.31, p95 2.06–7.27, max 3.1–10.4 on seeds 1, 3, 7, 12, 21, 34, 55, 89); warm full map (100 seeds, 4 processes contending) mean 1.64–2.27, p95 2.34–4.38. **CI work-bound (E, machine-independent, from the §2 counters incremented at the point of evaluation):** lattice nodes per chunk ≤ 1 600 (= 5 × 5 × 64 with yTop clamped to 252; measured max 1 575–1 600); instance-list replays per interior chunk **== 46** (36 for ores/blobs/pockets/geodes × 9 origins + 1 pools own-chunk + 9 trees; edge chunks fewer) — 0 deviations on the CI seeds; feature instances drawn per chunk ≤ 580 (per-seed max: mean 547 + 4 sd 8.2 over seeds 1–100; observed 523–569). An extra lattice pass or a dropped origin changes a counter and goes red.
14. **E pools (map):** every placed pool voxel has 4 solid-or-liquid sides and a solid below (subset of 5, scoped); pools placed per map 224–383 (mean ± 4 sd; 259–358). Mutant `poolrav` (pools allowed in ravine cores): 4 ravine-floor violations on seed 14.
15. **E/S shape (map):** isolated floating solids ≤ 46 (mean + 4 sd; 3–47 before the RG change); every ravine-core column's floor ≥ `bottom − 1` (0); rim-to-floor depth ≤ 70 where present (41–66); **at least one ravine with ≥ 40 8-connected channel columns per map on the CI seeds** (measured 1–5 such ravines, largest 92–599 columns, on all 8 CI seeds; of the fresh seeds 101–106, five pass and seed 101 does not — 37 channel columns, largest 12 — see §12).
16. **S decoration (map, mean ± 4 sd):** moss 16.4 k–29.4 k (18.6 k–27.7 k), dripstone 13.6 k–21.1 k (15.1 k–20.1 k), lava 200 k–499 k (257 k–450 k).

## 12. Evidence appendix (repaired prototype, seeds 1–100; Node 24, this machine)

Exact: **30 assertion counters, all 0 on all 100 maps** (2, 3, 5, 6, 7, 8,
9, 10, 14, 15 above). Mutants: see §11.

Map statistics, min / p10 / p50 / p90 / max:

```
surface min 62/66/76/88/90   p10 104/105/110/113/116   median 119/122/127/131/135   p90 144/154/168/181/190   max 217/228/235/239/243
water columns % 16.3/21.4/30.3/40.4/51.0   flat-ish land % 42.0/47.5/53.7/61.6/69.5   river columns % 3.6/5.1/6.5/8.3/10.4
land biomes present 7/8/8/8/8   biome changes on spawn row 9/11/16/19/22   runs < 6 on it 0/0/2/4/5
cave share of rock  1-23 13.6/14.8/16.4/18.5/20.2   24-47 12.6/13.7/15.1/16.9/17.5   48-79 7.8/8.6/9.6/10.8/11.6   80-119 3.4/3.8/4.3/4.8/5.3   120+ 1.4/1.6/2.0/2.4/3.5
ore per chunk  coal 96.9/105.4/118.4/131.2/138.8   iron 79.8/82.6/87.1/93.1/96.7   copper 68.8/70.4/72.1/73.7/74.7   gold 27.9/28.4/29.2/31.4/32.8
               lapis 19.0/19.3/19.6/19.9/20.2   redstone 41.1/42.3/43.3/44.4/45.1   diamond 13.4/13.8/14.2/14.5/14.7   emerald 1.6/2.9/5.1/7.3/8.7
seam  ore density by local x: x=0 1.17-1.26, x=15 1.21-1.28, interior 1.23-1.31, max |dev| 0.03-0.11;  by local z: 1.16-1.26 / 1.19-1.28 / dev 0.02-0.09
      same-ore continuity +x at x=15 32.3-34.2 % vs interior 33.5-35.4;  +z at z=15 32.0-33.9 % vs interior 33.0-35.0
% of non-air  stone 50.3-57.3  deepslate 23.4-26.6  dirt 2.4-3.1  granite 1.79-2.05  diorite 1.77-1.97  andesite 1.74-1.91  tuff 4.24-4.88  gravel 1.42-1.85  calcite 0.36-0.42  lava 0.79-1.40  water 0.85-3.93
counts per map  moss 18.6k/20.9k/22.9k/25.0k/27.7k   dripstone 15.1k/16.3k/17.3k/18.6k/20.1k   amethyst 2.9k/4.3k/5.6k/6.6k/7.8k   geodes 25/34/42/51/57
                pools 259/280/302/331/358   lava 257k/301k/347k/407k/450k   floaters 3/11/19/28/47   ravine cores 5/29/148/296/535 (RG 0.4)   ravine depth max 41/41/56/65/66
ravines after the round-3 RG ramp (CI seeds 1,2,3,5,8,13,21,34): ravine-core columns 26..536 per map, depth p50 41-50 max 41-65; ravines with >= 40 channel columns: 1/4/4/2/4/4/3/3, largest 92/599/188/272/320/365/524/268
  before the change 6 of 106 seeds (6, 24, 26, 55, 57, 101) had none; after it, of 101-106: 1/3/2/1/3/0 (seed 101 still none, 37 channel columns)
work counters (CI seeds): lattice nodes max 1575-1600, replays == 46 on every interior chunk, instances per chunk max 528-553; per-seed instance max over seeds 1-100: 523-569, mean 547, sd 8.2
trees per map 422/610/833/1159/1391;  forest-centre chunk mean 1.28/1.73/2.47/2.97/3.75
shared lattice nodes checked per seed 13.6k-18.4k, mismatches 0;  ceiling voxels checked per map 1.2-2.2M (flat) + 0.17-0.79M (amp), violations 0
warm timing per chunk (100 maps, 4 processes contending): mean 1.64/1.73/1.87/2.05/2.27  p95 2.34/2.54/2.83/3.29/4.38
stage split (p50): cols 0.38  lattice 0.25  fill 0.37  surface 0.20  features 0.56  deco 0.10  trees 0.02
```

Cold timing (fresh process per seed, spawn first, 81 chunks around spawn):

```
seed 1: spawn 409 ms (52.6k columns) | mean 3.31 p95 7.27 max 10.39      seed 21: spawn 174 ms (81.4k) | 1.86 / 2.35 / 3.08
seed 3: spawn 198 ms (34.6k)         | 1.84 / 2.88 / 4.02                  seed 34: spawn 439 ms (70.0k) | 1.68 / 2.35 / 4.95
seed 7: spawn 13 ms (16.6k)          | 1.66 / 2.22 / 3.67                  seed 55: spawn 163 ms (71.1k) | 1.59 / 2.42 / 4.02
seed 12: spawn 594 ms (39.1k)        | 1.85 / 3.53 / 3.88                  seed 89: spawn 12 ms (16.6k)  | 1.49 / 2.06 / 3.97
```

Spawn and kid targets, 100 seeds (p10 / p50 / p90 / max):

```
strict failures 0; pass 4 never used; spawn h 123/131/142/163; offset 10/54/140/159; buildable (column rule) 40.6/49.8/72.5/100
spawnV3 cost 16/250/1162/1713 ms; work 16.6k/70.0k/98.9k/120.9k column evaluations
buildable within 24 (voxels) 37.1/48.2/67.0/81.9 %;  drop within 32  3/9/16/28;  worst step within 64 (no coast) 8/11/19/24
nearest ravine channel: none within 64 on 100/100;  small holes within 64  0/0/2/3;  pockmarked land within 64  0.1/0.6/2.8/6.4 %
nearest trunk 8.1/10.6/22.2/94;  nearest cave mouth 13.9/42.0/86.7/110;  first ore in 3x3 shaft 4/21/57/(one seed: lava first)
boring stretch (stone/deepslate-only layers) 13/19/31/50;  emerald within 32  0/0/22/322;  biome short runs per 4x64 walks 0/1/3/4
spawn biomes: plains 35, taiga 22, desert 12, savanna 10, cherry 8, forest 8, badlands 5
```

Misses, stated: boring-stretch p90 is 31 against the asked 30 (with the
deepslate transition counted: p50 18, p90 31, max 40) after tuff 8 attempts
in y 4–48, gravel from y 6, igneous blobs from y 10 and dirt 10 attempts —
bound set to 32 rather than another density step (tuff is already 4.5 % of
blocks). One seed (69) has only 7 land biomes. Seed 101 has no ≥ 40-column
ravine even at RG 0.35 (its `RG` field never exceeds 0.35 on high ground);
lowering RG further would widen ravine zones on every world, so it is left
for the owner. Spawn cost p90 0.85–1.2 s, max 1.5–1.7 s, ≈ 2 s worst seen,
paid once at "New world" behind the menu message. The 100-seed kid numbers
predate the RG ramp; the 8 CI seeds re-measured after it: no ravine channel
within 64 on 8/8, drop within 32 max 19, step within 64 max 20, boredom max
40.

Cross-section through spawn, seed 3 (round-1 prototype; the terrain rules
that shape it are unchanged in round 2 except the river bank fade; z = 249,
x 215..278, y in 4-row bands; `.` stone `:` deepslate `#` bedrock `~` water
`L` lava `g` grass `d` dirt `s` sand `T` terracotta/tuff `v` gravel `c` coal
`I` iron `u` copper `$` diamond `R` redstone `G/D/N` granite/diorite/andesite
`i` dripstone `|` log `%` leaves):

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

## 13. Out of scope / later

- Lakes above sea level, swamp/mangrove, bushes, mossy cobblestone, fallen logs, large oak, dark oak, jungle, aquifers, vanilla "large ore veins"; villages/structures/loot/mobs (non-goals).
- Shadows, meshing, mount pacing, chunk eviction: performance project (§2.1 ratios as input).
- Engine hand-offs: `NEWEST_GEN_VERSION = 3`, `worldProfile(3)`, explicit dispatcher branch; noise-field and instance-list caches; `spawnV3` called from `main.ts`'s new-world branch only, after "Building your world…" and one `requestAnimationFrame` yield (§9); specs.md §4 PRNG wording.

## 14. Gate 1 changes

### Round 1 (summary; details in the round-1 commit 505aaca)

Instance lists with per-instance sub-streams and origin-chunk gates (R-B1/E-B1); hash bootstrap instead of a value (R-B2); tree base rules (R-B3); spawn canopy/snow exclusions (R-B4); blob bounds and budding (R-B5); ore band clamp (R-B6); bounds stated once (R-N2/3/4/10); template-completeness test (R-N6); observable ceiling test that found the `ampCell` defect (E-B2); hill spawn with buildable ≥ 40 %, cheese never breaching, ravine floors, emerald gate 165, biome flicker fix (K-B1/B2/F1/F4/F5); lava kept (K-B3).

### Round 2 (finding → action → evidence)

| Finding | Action | Evidence |
|---|---|---|
| R2-B1 bounds fitted to 12 seeds; pool/ravine-floor contradiction | Every map bound derived from seeds 1–100, holds on all; CI seeds 1,2,3,5,8,13,21,34 named; pools skip ravine cores | §11 ranges; `poolrav` mutant 4 red on seed 14; 0 on 100 |
| R2-B2 band clause tautology | Hand-transcribed table in the test + per-band count bounds | `coalshift` mutant: 11 out-of-band (imported table green) |
| R2-B3 seam clauses x only | Mirrored in z | `noz` mutant: +z continuity 0.38 %, z deviation 0.45 |
| R2-B4 geode wording | "neighbour not itself budding" written into §7 | 0 orphans on 100 |
| R2-B5 `ampCell` truncated at pad 4; chunks disagreed on shared nodes | Pad −4/+5 (PW 25); invariant stated; cross-plane node test; ceiling clause (b) for `amp > 0` neighbourhoods | 0 mismatches on 100 seeds; `pad4` mutant 264 mismatches + water/ceiling reds |
| R2-B6 / NEW-B1 spawn in meta unimplementable | In-memory hand-off via `World.create`/`main.ts`; no schema change | §9 |
| R2-B7 hash bootstrap not executable; `Math.hypot` | FNV-1a-32 on fixed chunks (0,0),(16,16),(31,31),(5,27) seed 12345; two-process agreement; no browser leg; "implementation is wrong until proven otherwise"; `Math.sqrt` everywhere; approximated Math functions listed as unused | §10, §0 |
| R2-B8 / NEW-B1 spawn cost | Work-bounded rings ≤ 128 × 4 passes; memoised ravine and mouth predicates; gentle before mouth; cost stated; menu message hand-off | p50 0.25 s, p90 1.16 s, max 1.71 s; pass 4 never used |
| N1 canopy shapes unasserted | Hand-written counts/bbox per species in §8 and 11.9 | `nobend` mutant 20 red; 0 on 100 |
| N2 vacuous E clause | Deleted; replay equivalence stated as a design property, tested via seams | §10, 11.2 |
| N3 ceiling clause excluded `amp > 0` | Clause (b) added using `kind` | 0 / 0.17–0.79 M per map; `noceil` 2 128 red |
| N4 timing on warm memo | Cold protocol, informational bounds mean ≤ 4 / p95 ≤ 10, CI work-bound | §11.13, §12 |
| N5–N11 | Ravine cores reported not bounded; §1 spawn claim reworded; badlands depth 0–8; one ravine-zone predicate with three derived; instance index = attempt index; vein reach < 16 stated; kid.ts nearest-trunk fixed | §6.1, §7, §10, 11.12 |
| Engine N2 stale §2.1 | Ratios vs v2, absolutes re-measured at implementation, ENT_T claim corrected | §2.1 |
| Engine N3 memo eviction | Never cleared mid-map; engine keys per seed and evicts with unload | §2 |
| Kid 1 ravines 32–64 from spawn | Ravine zones suppressed within 128 of the centre; channel exclusion 64; test | none within 64 on 100/100; step within 64 (no coast) p90 19 |
| Kid 2 mouth metric counted dimples | Real-mouth definition in 11.12; entrance boost 0.09; shallow cheese pits (floor ≥ h − 14); mouth predicate radius 40 | p50 42 / p90 87 (asked ≤ 50 / ≤ 90); drop within 32 p90 16 |
| Kid 3 mid-shaft boredom | tuff 8 attempts y 4–48, gravel from y 6, igneous from y 10, dirt 10 | p90 31 (asked 30) — bound 32, stated in §12 |
| Kid 5 small holes | Test added | max 3 (bound 8) |
| Housekeeping | `git status` clean; nothing in `src/` | verified before commit |
| Round-2 defects the new tests found | Dripstone at a mountain column top (seed 73): decoration limited to `y < caveCeil`; tree plug on air over a tunnel mouth (seed 7): trees skip entrance columns failing `tunnelFree`; river channel slicing high hills: bank fade scaled by river strength | `nodecoceil` 1 red, `treetunnel` 2 red; 0 on 100 |

### Round 3 (instrument, bounds, wording; one rule change)

| Finding | Action | Evidence |
|---|---|---|
| R3-B1 §11.7 missing overlap cells, catch-all wording | iron 1–23, copper 120+, gold 120+ added; "0 in every band cell disjoint from the family's y-range" | 11.7 |
| R3-B2 / E-B1 work-bound | Counters at the point of evaluation: nodes ≤ 1 600, replays == 46 on interior chunks, instances ≤ 580 (mean + 4 sd over seeds 1–100); §2 row 5 says pools are own-chunk | CI seeds: nodes max 1 575–1 600, 0 replay deviations, instances max 528–553 |
| R3-B3 margin rule | Stated in §11; all count bounds re-derived as mean ± 4 sd, fractions/heights as range ± 25 % (short runs ≤ 8, geodes 16–69, changes on row 4–27, water 8–60 %, flat ≥ 35 %, …) | §11 |
| Kid: every world gets a ravine | RG threshold ramps 0.4 → 0.35 from 128 to 176 of the centre (§6.1); bound "≥ 1 ravine with ≥ 40 channel columns" on CI seeds | 8/8 CI seeds pass (1–5 ravines); of 101–106 seed 101 still fails — stated in §12 |
| Kid: boredom metric | Deepslate transition counts as a new type; p90 ≤ 32 kept, max ≤ 45 over CI seeds | p50 18 / p90 31 / max 40 (100 seeds); CI max 40 |
| E-N1–N4 hand-off | `main.ts` new-world branch only; rAF yield after the menu message; rings ≤ 128; ≈ 2 s worst | §9, §13 |
| R3-N1 tree-origin mutant | Construction stated; reviewer's 4 / 5 220 / 301 quoted beside mine | 11.9 |
| R3-N3 | `caveCeil` added to the cross-plane comparison; (30,30), (30,5), (5,30) always included | 11.2: 0 mismatches |
| R3-N4 | §0 "hard cap 3 ms" replaced by the 11.13 reference | §0 |
| R3-N5 | `hashBytes` XORs Uint16 elements; prototype not committed, its values recorded in §10 at bootstrap | §10 |
| R3-N6/N7/N8 | kid.ts `Math.hypot`/`sin`/`cos` noted as measurement-only; "p50 ≥ 40 % (p10 37)"; first-ore censoring 1/100 stated | §0, 11.12 |
| Kid: badlands spawns, trees skipping entrance columns | No change | — |
