# World creation from a seed

This is the rebuild reference for Minicraft's terrain generator: seed in, blocks out. It gives every constant, formula, draw order and numeric rule, so an engineer can reimplement the generator in any language without reading `src/`, and the result matches the shipped game block for block. `docs/worldgen.md` covers the rest: the operations view (versions, instruments, costs, rules that came from play-testing). `docs/superpowers/specs/2026-09-21-worldgen-v3-design.md` gives the design rationale and evidence. This doc says **what** the code computes. It does not say why.

**What "rebuilt" means.** A saved world stores only its seed, its generator version and the chunks the player changed. Every other chunk is regenerated from the seed each time it loads, on every machine. A rebuild is correct only if it is **bit-identical**. §12 gives the acceptance test: six reference hashes and eleven coverage hashes, each covering at least one rule the others miss, plus layer-by-layer test vectors so a divergence can be found. Output that is only "close" means the player's saved worlds come back different.

Contents: 1 World shape · 2 Seed and lifecycle · 3 Numeric rules · 4 Random and noise primitives · 5 Generators v1 and v2 · 6 v3 columns · 7 v3 chunk pipeline · 8 v3 underground features · 9 v3 trees · 10 v3 spawn · 11 Block ids · 12 Verification · 13 Pitfalls

---

## 1. World shape

- The world is finite: **32 × 32 chunks** of **16 × 16** columns, so world x and z run 0..511. Height is **256** for generator v2 and v3 and **64** for v1. y runs 0..height−1, and y = 0 is the bottom.
- A chunk `(cx, cz)` covers world x `cx·16 .. cx·16+15` and world z `cz·16 .. cz·16+15`. The local coordinates are `lx = x − cx·16` and `lz = z − cz·16`.
- Chunk storage is a `Uint16Array` of block ids with length `16·height·16`, indexed as **`y·256 + lz·16 + lx`**: y is the slowest axis and x the fastest. It starts all zeros (air). The generator writes into it in place.
- The generator may evaluate columns outside 0..511 (padding at the map edge, see §7.1). The formulas work at any coordinate. Features are only *placed* from origin chunks inside the map (§8, §9).

## 2. Seed and lifecycle

**Where the seed comes from.** The New World form has a numeric input that defaults to `Math.floor(Math.random() * 1_000_000)`. The value is read as `Number(raw) || 0`, so an empty or non-numeric entry gives seed 0. In practice seeds are non-negative integers, but nothing stops a negative, fractional or huge number from getting through. §3 describes how such seeds behave. For multiplayer, the server's world record supplies the seed and the generator version, and every client generates locally.

**What is stored.** The world record keeps `seed`, `genVersion` and `height`. The generator version is fixed when the world is created and never changes afterwards. A new world uses the newest version (`NEWEST_GEN_VERSION = 3`, height 256). Older saves keep generating with their own version forever.

**Dispatch.** `generateChunk(chunk, seed, genVersion)`:

```
height = {1: 64, 2: 256, 3: 256}[genVersion]    // genVersion defaults to 1 when omitted; any other version → RangeError
if chunk.height != height → RangeError
v1 | v2 | v3 generator writes chunk.blocks
chunk.hasLiquid = any block is water or lava     // gates the liquid simulation; not part of the block output
```

**When chunks are generated.** Generation is lazy. `World.ensureChunk(cx, cz)` generates a chunk the first time anything touches it. In multiplayer it then applies the server's edit overlay. After that it computes lighting. Nothing depends on the order chunks are generated in, because every chunk is a pure function of `(seed, cx, cz)` (§7).

**Spawn.** When a new **v3** world is created in solo, and when a player first joins a multiplayer world (`resolveMpSpawn`), the game shows "Building your world…", waits two animation frames, and runs `spawnV3(seed)` once (§10). The player is placed at `[x + 0.5, height − 1, z + 0.5]`. `findSafeSpawn` then drops the player to one block above the first non-air block in that column. No spawn is saved in the world record. A reloaded world uses the player position from the save. The code's fallback position (`[256.5, height − 1, 256.5]`, dropped the same way) is used only when no saved position exists. New worlds are always v3, so in practice v1 and v2 worlds always load a saved position.

## 3. Numeric rules a port must reproduce

The generator runs in JavaScript. Any port has to copy JavaScript's number semantics exactly. Most bit-exactness bugs come from this section.

- **Every number is an IEEE-754 double** unless this doc says it is float32. Evaluate each expression **in the order and grouping written here**. Do not fold constants: `h − SEA − 6` means `(h − 120) − 6`, not `h − 126`. Do not let a compiler fuse multiply-adds (FMA contraction), and do not use extended precision.
- **Float32 storage (important).** Five arrays hold **float32** values. Each value is rounded to float32 when stored and widened back to a double when read: the lattice arrays `S`, `Dch`, `Dtn` and the per-column `ampCell` and `caveCeil` (§7). The standalone helpers `ampCellOf` and `waterNear` in §6.2 use **doubles**. The two versions really can disagree near a threshold, and the code relies on each version in a specific place.
- **Allowed math.** Only `+ − × /`, `sqrt`, `floor`, `ceil`, `round`, `min`, `max`, `abs` and integer operations are used. There is no `sin`, `exp`, `pow` or `hypot`. Those are not correctly rounded in JavaScript, so their results can differ between engines.
- **`Math.round(x)`** rounds halves **up** (−2.5 → −2), unlike C's `round`. It is almost `floor(x + 0.5)`, except that `0.49999999999999994` gives 0. Every value this generator rounds is positive (≥ 4), so `floor(x + 0.5)` and round-half-away-from-zero both give the same result here.
- **`v | 0`** is ToInt32: truncate toward zero, then wrap modulo 2³² into the signed range. `(rng() * 16) | 0` is just truncation of a non-negative value.
- **`>>> 0`** is ToUint32. `Math.imul(a, b)` is the low 32 bits of the signed 32 × 32 product. The hash functions below return values in `[0, 2³²)`, so `%` on them is non-negative.
- **`x & ~3`** floors to a multiple of 4 in two's complement: −1 → −4, −4 → −4, 5 → 4.
- **`Math.min` / `Math.max`** return NaN if any argument is NaN (see §7.1: that case is never read).
- **Seed stringification.** Noise fields are seeded by the *string* `` `minicraft:v3:${seed}:${name}` ``, which uses JavaScript's Number-to-String. Integers print plainly (`12345`, `-7`). Otherwise you get `1.5`, `1e+21` and so on. Hash streams use `seed | 0` (ToInt32). A seed of 2³² + 5 therefore gives different noise fields from seed 5 but the same hash streams. This is deterministic, so leave it as it is.

## 4. Random and noise primitives

### 4.1 Alea (npm `alea` 1.0.1; seeds every noise field)

```
Mash():                                 // stateful
    n = 0xefc8249d
    mash(data):
        data = String(data)
        for each UTF-16 code unit ch of data:
            n += ch
            h = 0.02519603282416938 * n
            n = h >>> 0;  h -= n;  h *= n
            n = h >>> 0;  h -= n
            n += h * 0x100000000
        return (n >>> 0) * 2.3283064365386963e-10

alea(arg):                               // exactly one argument everywhere in this code
    mash = Mash()
    s0 = mash(' '); s1 = mash(' '); s2 = mash(' '); c = 1
    s0 -= mash(arg); if s0 < 0: s0 += 1
    s1 -= mash(arg); if s1 < 0: s1 += 1
    s2 -= mash(arg); if s2 < 0: s2 += 1
    next():
        t = 2091639 * s0 + c * 2.3283064365386963e-10
        s0 = s1; s1 = s2
        c = t | 0
        s2 = t - c
        return s2
```

`n` is a double throughout. The `>>> 0` wraps it to uint32.

### 4.2 Simplex noise (npm `simplex-noise` 4.0.3)

This is Gustavson's simplex noise with Eastman's optimisations. The details below are the ones a textbook version gets wrong.

**Permutation table** (built once per noise object from its Alea stream):

```
p = Uint8Array(512); p[i] = i for i < 256
for i in 0 .. 254:                       // note: 255 swaps, not 256
    r = i + ~~(random() * (256 − i))     // ~~ = ToInt32 truncation
    swap p[i], p[r]
p[i] = p[i − 256] for i in 256 .. 511
```

**2-D** `noise2D(x, y)`. The gradient table `grad2` has 12 (x, y) pairs:
`(1,1) (−1,1) (1,−1) (−1,−1) (1,0) (−1,0) (1,0) (−1,0) (0,1) (0,−1) (0,1) (0,−1)`. The gradient for hash value `v` is `grad2[v % 12]`.

```
F2 = 0.5 * (sqrt(3) − 1);  G2 = (3 − sqrt(3)) / 6
s = (x + y) * F2;  i = floor(x + s) | 0;  j = floor(y + s) | 0
t = (i + j) * G2;  x0 = x − (i − t);  y0 = y − (j − t)
(i1, j1) = x0 > y0 ? (1, 0) : (0, 1)
x1 = x0 − i1 + G2;        y1 = y0 − j1 + G2
x2 = x0 − 1 + 2 * G2;     y2 = y0 − 1 + 2 * G2
ii = i & 255;  jj = j & 255
corner k with offsets (a, b) and hash index gi:
    t_k = 0.5 − xk² − yk²;  if t_k >= 0: t_k *= t_k; n_k = t_k * t_k * (gx * xk + gy * yk) else n_k = 0
    gi0 = ii + p[jj];  gi1 = ii + i1 + p[jj + j1];  gi2 = ii + 1 + p[jj + 1]
    (gx, gy) = grad2[p[gi] % 12]
return 70 * (n0 + n1 + n2)
```

**3-D** `noise3D(x, y, z)`. The gradient table `grad3` has 12 (x, y, z) triples:
`(1,1,0) (−1,1,0) (1,−1,0) (−1,−1,0) (1,0,1) (−1,0,1) (1,0,−1) (−1,0,−1) (0,1,1) (0,−1,1) (0,1,−1) (0,−1,−1)`.

```
F3 = 1/3;  G3 = 1/6
s = (x + y + z) * F3;  i, j, k = floor(x + s)|0, floor(y + s)|0, floor(z + s)|0
t = (i + j + k) * G3;  x0 = x − (i − t);  y0 = y − (j − t);  z0 = z − (k − t)
simplex corner order:
    x0 >= y0:  y0 >= z0 → (1,0,0),(1,1,0)   | x0 >= z0 → (1,0,0),(1,0,1)   | else → (0,0,1),(1,0,1)
    x0 <  y0:  y0 <  z0 → (0,0,1),(0,1,1)   | x0 <  z0 → (0,1,0),(0,1,1)   | else → (0,1,0),(1,1,0)
corner 1 = x0 − i1 + G3 …;  corner 2 = x0 − i2 + 2 * G3 …;  corner 3 = x0 − 1 + 3 * G3 …
ii, jj, kk = i & 255, j & 255, k & 255
gi0 = ii + p[jj + p[kk]];  gi1 = ii + i1 + p[jj + j1 + p[kk + k1]]
gi2 = ii + i2 + p[jj + j2 + p[kk + k2]];  gi3 = ii + 1 + p[jj + 1 + p[kk + 1]]
t_c = 0.6 − xc² − yc² − zc²;  if t_c < 0: n_c = 0 else t_c *= t_c; n_c = t_c * t_c * dot(grad3[p[gi] % 12], (xc, yc, zc))
return 32 * (n0 + n1 + n2 + n3)
```

Note that the 2-D test is `t >= 0` while the 3-D test is `t < 0 → 0`. Both mean the same thing. Keep the gradient-index expression `p[gi] % 12` exactly as written.

### 4.3 Octave sums and shaping helpers

```
fbm2(n, x, z, oct):  a = 1, s = 0, norm = 0
    repeat oct: s += a * n(x, z); norm += a; x *= 2; z *= 2; a *= 0.5
    return s / norm
fbm3(n, x, y, z, oct): same shape, with y doubled too
clamp(v, a, b) = v < a ? a : v > b ? b : v
smooth(t) = t' = clamp(t, 0, 1); t' * t' * (3 − 2 * t')
spline(x, pts):   // pts sorted by x
    x <= pts[0].x → pts[0].y
    first i >= 1 with x <= pts[i].x: t = (x − pts[i−1].x) / (pts[i].x − pts[i−1].x)
                                     return pts[i−1].y + (pts[i].y − pts[i−1].y) * smooth(t)
    otherwise pts[last].y
```

### 4.4 Integer hash streams (v3 features, trees and per-voxel white noise)

```
mix32(h):                           // murmur3 fmix32
    h ^= h >>> 16; h = imul(h, 0x85ebca6b); h ^= h >>> 13; h = imul(h, 0xc2b2ae35); h ^= h >>> 16
    return h >>> 0
streamSeed(seed, cx, cz, feature):
    h = mix32((seed | 0) ^ 0x3a5f0d1b)
    h = mix32(h ^ imul(cx | 0, 0x9e3779b1))
    h = mix32(h ^ imul(cz | 0, 0x85ebca77))
    h = mix32(h ^ imul(feature | 0, 0xc2b2ae3d))
    return h
subSeed(base, i) = mix32(base ^ imul(i + 1, 0x9e3779b1))
mulberry32(a):  next():
    a = (a + 0x6d2b79f5) | 0
    t = imul(a ^ (a >>> 15), 1 | a)
    t = (t + imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
hashv(x, y, z) = mix32(mix32(imul(x, 73856093) ^ imul(y, 19349663)) ^ imul(z, 83492791))   // uint32, world coords
feature ids F: TREE 1, ORE 2, BLOB 3, POCKET 4, GEODE 5, POOL 6
```

`hashv` takes world coordinates, so a voxel gets the same value whichever chunk evaluates it.

## 5. Generators v1 and v2 (frozen)

Both generators use one 2-D noise, `createNoise2D(alea('minicraft:' + seed))`. It is created per chunk but is the same for every chunk. They have no caves and no features.

```
per column (wx, wz):
    n = noise(wx / 64, wz / 64)                   // world coords × 1/64 (code: wx * (1/64))
    h = floor(MIN_H + (n * 0.5 + 0.5) * (MAX_H − MIN_H))
    for y in Y0 .. h:  y == h → (h < SEA ? sand : grass_block);  y >= h − 3 → dirt;  else stone
    if h < SEA: water for y in h+1 .. SEA
v1: height 64,  MIN_H 24,  MAX_H 34,  SEA 28,  Y0 = 0, no bedrock
v2: height 256, MIN_H 114, MAX_H 130, SEA 120, Y0 = 1, bedrock at y = 0
```

The code computes the scale as `wx * NOISE_SCALE` with `NOISE_SCALE = 1 / 64`. Multiplying by 1/64 is exact, so it gives the same result as dividing by 64.

## 6. v3 — the column model

### 6.1 Constants and noise fields

```
SEA = 120   ENT_T = 0.1   MOUNTAIN_GATE = 165
DEEPSLATE_Y = 48   DEEP_BLEND = 4   LAVA_Y = 10   SURF_MARGIN = 6   RAVINE_FLOOR = 4
PIT_CAP = 24   lattice step LAT = 4   chunk height H = 256
BIOME ids: ocean 0, plains 1, forest 2, cherry 3, taiga 4, snowy 5, desert 6, savanna 7, badlands 8
```

The generator has 19 noise fields. Each is its own simplex object seeded with `alea('minicraft:v3:' + seed + ':' + NAME)`.

| Field | Dim | Used for | Sampled as |
|---|---|---|---|
| C | 2 | continentalness | `fbm2(C, wx/420, wz/420, 3)` |
| E | 2 | erosion | `fbm2(E, wx/330, wz/330, 3)` |
| PV | 2 | peaks/valleys | `fbm2(PV, wx/140, wz/140, 4)` |
| T | 2 | temperature | `fbm2(T, wx/320, wz/320, 2)` |
| HU | 2 | humidity | `fbm2(HU, wx/300, wz/300, 2)` |
| R | 2 | rivers | `fbm2(R, wx/210, wz/210, 2)` |
| D | 2 | surface detail | `fbm2(D, wx/26, wz/26, 3)` |
| ENT | 2 | cave-entrance zones | `ENT(wx/90, wz/90)` (one octave) |
| RAV | 2 | ravine channel | `RAV(wx/230, wz/230)` |
| RG | 2 | ravine gate | `RG(wx/300, wz/300)` |
| RAVD | 2 | ravine depth | `RAVD(wx/300, wz/300)` |
| PATCH | 2 | surface patches | `PATCH(wx/9, wz/9)` |
| SHAPE | 3 | 3-D mountain shaping | `fbm3(SHAPE, wx/44, y/30, wz/44, 3)` |
| CHEESE | 3 | cheese caves | `fbm3(CHEESE, wx/96, y/48, wz/96, 2)` |
| S1, S2 | 3 | spaghetti tunnels | `S1(wx/54, y/32, wz/54)` |
| N1, N2 | 3 | noodle tunnels | `N1(wx/26, y/20, wz/26)` |
| DECO | 3 | cave decoration | `DECO(wx/40, y/40, wz/40)` |

The field names are part of the seed string, so they are frozen. The runtime builds all 19 objects once per seed and caches them. The cache has no effect on output.

### 6.2 `column(seed, wx, wz)`

This is a pure function. Evaluate it exactly in this order:

```
dC    = sqrt((wx − 256) * (wx − 256) + (wz − 256) * (wz − 256))
dEdge = min(wx, wz, 511 − wx, 511 − wz)
C  = fbm2(C, wx/420, wz/420, 3) + 0.08
C += 0.45 * smooth(1 − dC / 110)                       // spawn continent
C −= 0.8  * smooth(1 − dEdge / 20)                     // ocean ring at the map wall
C  = clamp(C, −1, 1)
E  = fbm2(E, wx/330, wz/330, 3)
PV = 1 − abs(fbm2(PV, wx/140, wz/140, 4)) * 2
base = spline(C, [(−1,98), (−0.55,104), (−0.3,113), (−0.15,121), (0.1,127), (0.45,136), (1,146)])
M  = smooth((0.3 − E) / 0.7) * smooth((C + 0.05) / 0.35) * (1 − 0.6 * smooth(1 − dC / 128))
h  = base + M * (PV > 0 ? PV * 92 : PV * 18)
T0 = fbm2(T, wx/320, wz/320, 2)
Hu = fbm2(HU, wx/300, wz/300, 2)
T  = T0 − clamp((h − 130) / 90, 0, 1) * 0.7            // altitude lapse, on this pre-river h
land = pickLand(T, Hu)
if land == badlands and h > SEA + 4:                    // terraces
    q = floor(h / 6) * 6;  h = q + 6 * smooth((h − q) / 3 − 0.5)
r  = fbm2(R, wx/210, wz/210, 2)
rs = clamp(1 − (h − SEA − 6) / 30, 0, 1)
rw = 0.045 * rs
river = 0
if rs > 0 and abs(r) < rw + 0.05 and h > SEA − 6:
    river = rs * (1 − smooth((abs(r) − rw) / 0.05));  h += (SEA − 3 − h) * river
h += fbm2(D, wx/26, wz/26, 3) * 3.5 * (1 − river)
hRaw = h
h = ceil(hRaw) − 1                                      // integer: y of the top solid block of an unshaped column
biome = h < SEA − 2 ? ocean : land
amp = h > SEA + 6 ? 22 * smooth((M − 0.4) / 0.35) * smooth((h − SEA − 6) / 20) : 0
ent = ENT(wx/90, wz/90)
rg  = RG(wx/300, wz/300)
rgT = 0.4 − 0.05 * smooth((dC − 128) / 48)
ravW = (rg > rgT and h > SEA + 8 and amp < 6) ? 0.035 * smooth((rg − rgT) / 0.2) * smooth((dC − 128) / 48) : 0
ravDepth = 40 + 25 * smooth(RAVD(wx/300, wz/300))
return { h, hRaw, biome, land, amp, ent, river, T, Hu, ravW, ravDepth, M }
```

```
pickLand(T, Hu):
    T < −0.45 → snowy
    T < −0.15 → Hu < −0.25 ? plains : taiga
    T <  0.3  → Hu < −0.25 ? plains : Hu < 0.35 ? forest : cherry
    Hu < −0.35 → badlands;  Hu < 0.1 → desert;  else savanna
```

**Column helpers.** These are shared by trees and spawn and use **double** precision:

```
snowLine(c)  = c.T >= 0 ? 160 + 20 * c.T : max(122, 160 + 78 * c.T)
isBeach(c)   = c.h >= SEA − 3 and c.h <= SEA + 2 and c.land != badlands
ampCellOf(wx, wz) = max(amp of column at (x0,z0), (x0+4,z0), (x0,z0+4), (x0+4,z0+4)),  x0 = wx & ~3, z0 = wz & ~3
flatCell(wx, wz)  = ampCellOf(wx, wz) == 0
waterNear(wx, wz) = (min over the 3×3 columns q around (wx, wz) of q.hRaw − ampCellOf(q)) < SEA + 2
inRavineChannel(wx, wz) = c.ravW > 0 and abs(RAV(wx/230, wz/230)) < c.ravW + 0.005 and not waterNear(wx, wz)
chunkMaxH(cx, cz) = max(0, max over i, j in 0..3 of column(cx*16 + 4i + 2, cz*16 + 4j + 2).h)
cheeseDensity(wx, y, wz):
    deep = clamp((112 − y) / 92, 0, 1)
    return (fbm3(CHEESE, wx/96, y/48, wz/96, 2) − (0.58 − 0.28 * deep)) * 24
tunnelDensity(wx, y, wz, h, boost):
    deep = clamp((112 − y) / 92, 0, 1)
    s1 = S1(wx/54, y/32, wz/54);  s2 = S2(wx/54, y/32, wz/54)
    rs = 0.085 + 0.045 * deep + (boost ? 0.09 * clamp(1 − (h − y) / 30, 0, 1) : 0)
    t = (rs * rs − (s1 * s1 + s2 * s2)) * 450
    if y < 92:  n1 = N1(wx/26, y/20, wz/26);  n2 = N2(wx/26, y/20, wz/26);  t = max(t, (0.0036 − (n1 * n1 + n2 * n2)) * 1100)
    return t
tunnelFree(wx, wz, h):   // true if no cave node sits under this cell's surface
    x0 = wx & ~3, z0 = wz & ~3
    for each corner (x0,z0), (x0+4,z0), (x0,z0+4), (x0+4,z0+4):
        for y = (h − 16) & ~3; y <= h + 4; y += 4:
            if tunnelDensity(corner, y, h, boost = true) > 0 or cheeseDensity(corner, y) > 0: return false
    return true
```

## 7. v3 — the chunk pipeline

`generateChunkV3(chunk, seed)` fills one 16 × 256 × 16 chunk. Each stage reads only the seed, the chunk coordinates and arrays that earlier stages built **for this chunk**. No stage reads another chunk's blocks. As a result, a chunk regenerated in any order on any machine comes out identical.

Notation: `bx = cx*16`, `bz = cz*16`. `col(lx, lz)` is the column at world `(bx + lx, bz + lz)`, defined for local −4..20.

### 7.1 Padded columns, `ampCell`, `wn`, `caveCeil`, `yTop`

```
PAD = 4, PAD_HI = 5, PW = 25               // columns for local −4 .. 20 (asymmetric on purpose)
cols[pz][px] = column(bx + px − 4, bz + pz − 4)  for px, pz in 0..24
maxH = max(0, all cols.h)

ampCell[p] (float32), for every padded column p at world (wx, wz):
    corners at world ((wx & ~3), (wz & ~3)) + {0, 4}²; if any corner falls outside the padded grid → NaN
    else f32(max(amp of the four corner columns))
    (NaN occurs only where local x or z is 20. Nothing reads it.)

for pz, px in 1..23 (local −3..19):
    m = 999
    for each of the 3×3 neighbours k:  m = min(m, cols[k].hRaw − ampCell[k])   // double − f32→double
    wn[p]       = m < SEA + 2 ? 1 : 0          // "water near": suppresses entrances and ravines at water
    caveCeil[p] = f32(m − SURF_MARGIN)          // cave air stays below this
    (Cells with local x or z = 19 can pick up that NaN. Nothing reads them: `wn` is read at local 0..16 and `caveCeil` at 0..15.)

yTop = min(H − 4, ceil((maxH + 28) / 4) * 4)    // multiple of 4, at most 252; nothing at or above yTop is touched by stages 2–4
```

A correct port only needs `ampCell` for local −1..17 (the 3×3 neighbourhoods) and `wn`/`caveCeil` for local 0..16. The NaN cases do not have to be reproduced.

### 7.2 Lattice (3-D density nodes every 4 blocks)

```
NX = 5 (local x, z = 0, 4, 8, 12, 16);   NY = yTop / 4 + 1 (y = 0, 4, …, yTop)
node index k = (iy * NX + iz) * NX + ix
entAt(ix, iz) = col(4ix, 4iz).ent > ENT_T and wn(4ix, 4iz) == 0

for iz, ix in 0..4:   c = col(4ix, 4iz);  wx = bx + 4ix;  wz = bz + 4iz;  boost = entAt(ix, iz)
    for iy in 0..NY−1:  y = 4iy;  d = c.hRaw − y
        S[k]   = f32( c.amp > 0 and abs(d) < 40 ? c.amp * fbm3(SHAPE, wx/44, y/30, wz/44, 3) * smooth(1 − abs(d) / 40) : 0 )
        if y > c.h + 4 or y < 2:  Dch[k] = Dtn[k] = −99
        else: Dch[k] = f32(cheeseDensity(wx, y, wz));  Dtn[k] = f32(tunnelDensity(wx, y, wz, c.h, boost))
```

Nodes at local 0 and local 16 lie on the chunk boundary, and the neighbouring chunk computes them as well. Both chunks get identical values because the padding covers the corner columns both sides need.

**Cell flags** (a cell is the cube whose lowest corner is node k, for iy < NY − 1 and ix, iz < 4):
`cellCh[k] = 1` if any of the cell's 8 corner nodes has `Dch > 0`, and `cellTn[k]` is the same test on `Dtn`. The 8 corners are `k, k+1, k+NX, k+NX+1`, plus the same four offsets from `k + NX²`.

**Trilinear interpolation** `tri8(A, k0, k1, fx, fy, fz)`, where `k1 = k0 + NX²`. Follow this operation order exactly:

```
a00 = A[k0]    + (A[k0+1]    − A[k0])    * fx;   a01 = A[k0+NX] + (A[k0+NX+1] − A[k0+NX]) * fx
a10 = A[k1]    + (A[k1+1]    − A[k1])    * fx;   a11 = A[k1+NX] + (A[k1+NX+1] − A[k1+NX]) * fx
a0 = a00 + (a01 − a00) * fz;   a1 = a10 + (a11 − a10) * fz;   return a0 + (a1 − a0) * fy
```

### 7.3 Fill: a `kind` per voxel

`kind` takes four values: 0 terrain-air, 1 solid, 2 cave-air, 3 water. Only y < yTop is computed, and everything above stays 0.

```
for lz, lx in 0..15:   c = col(lx, lz);  wx = bx + lx;  wz = bz + lz
    ent  = c.ent > ENT_T and wn(lx, lz) == 0
    ceil = caveCeil(lx, lz)                                  // float32 value
    rav  = (c.ravW > 0 and wn(lx, lz) == 0) ? abs(RAV(wx/230, wz/230)) : 9
    ravBottom = round(c.h − c.ravDepth);   inRavine = rav < c.ravW * 0.4
    ix = lx >> 2;  iz = lz >> 2;  fx = (lx & 3) / 4;  fz = (lz & 3) / 4
    flat = col(4ix, 4iz).amp == 0 and col(4ix+4, 4iz).amp == 0 and col(4ix, 4iz+4).amp == 0 and col(4ix+4, 4iz+4).amp == 0
    for y in 0 .. yTop−1:
        iy = y >> 2;  fy = (y & 3) / 4;  k0 = (iy * NX + iz) * NX + ix;  k1 = k0 + NX²
        dt = flat ? c.hRaw − y : c.hRaw − y + tri8(S, k0, k1, fx, fy, fz)     // (hRaw − y) first, then + S
        if dt <= 0:  kind = y <= SEA ? 3 : 0
        else:
            kind = 1
            deepEnough = dt > SURF_MARGIN and y < ceil
            if y >= 2 and not (inRavine and y >= ravBottom − RAVINE_FLOOR and y < ravBottom):     // ravine floor stays solid
                if deepEnough and (not ent or y < ceil − 18) and cellCh[k0] and tri8(Dch, k0, k1, fx, fy, fz) > 0:   kind = 2   // deep cheese
                elif ent and y >= c.hRaw − 14 and dt > −2 and cellCh[k0] and tri8(Dch, k0, k1, fx, fy, fz) > 0:     kind = 2   // shallow cheese pit
                elif (deepEnough or (ent and dt > −2)) and cellTn[k0] and tri8(Dtn, k0, k1, fx, fy, fz) > 0:        kind = 2   // tunnels (may break the surface in entrance zones)
            if kind == 1 and rav < 9 and y >= ravBottom and y < c.h + 60:
                w = c.ravW * (0.4 + 0.6 * clamp((y − ravBottom) / (c.h − ravBottom), 0, 1))
                if rav < w: kind = 2                                                              // ravine
```

**Open-sky pit cap.** This pass skips columns where `c.ravW > 0 and wn == 0`, which are the ravine-carving columns. In every other column:

```
floor = c.h − PIT_CAP
for y = yTop − 1 down to 1:
    if kind is 1 or 3: break
    if kind == 2 and y <= floor: kind = 1       // a vertical shaft open to the sky is plugged below h − 24
```

### 7.4 Surface: `kind` to block ids

The surface rules apply in this order of precedence: underwater, then beach/bank, then snow line, then stony peak, then biome.

```
for lz, lx in 0..15:   c = col(lx, lz);  wx = bx + lx;  wz = bz + lz
    patch = PATCH(wx/9, wz/9);  beach = isBeach(c)
    sl = c.land == snowy ? −999 : snowLine(c);  rocky = c.amp > 8
    depth = 99;  prevAir = true
    for y = yTop − 1 down to 0:   i = y*256 + lz*16 + lx
        if y == 0:        block = bedrock; continue
        kind 0:           block = air;  prevAir = true;  depth = 99; continue
        kind 3:           block = (y == SEA and c.land == snowy) ? ice : water;  prevAir = true;  depth = 99; continue
        kind 2:           block = y <= LAVA_Y ? lava : air;  prevAir = (y > c.hRaw − 9);  depth = 99; continue
        // solid
        depth = prevAir ? 0 : depth + 1;  prevAir = false
        id = stone
        if y < DEEPSLATE_Y − DEEP_BLEND: id = deepslate                                   // y < 44
        elif y < DEEPSLATE_Y + DEEP_BLEND and (hashv(wx, y, wz) & 255) / 256 < (DEEPSLATE_Y + DEEP_BLEND − y) / (2 * DEEP_BLEND): id = deepslate
        if depth <= 8 and y > c.hRaw − 9 − depth:
            if kind[i + 256] == 3:          // water directly above
                id = depth == 0 ? (c.h > SEA − 10 ? (patch > 0.35 ? gravel : sand) : (patch > 0.2 ? clay : gravel))
                   : depth < 3 ? sand : id
            elif beach or c.river > 0.6:
                id = depth < 4 ? ((c.land == snowy or c.land == taiga) ? gravel : sand) : id
            elif y >= sl:
                id = depth == 0 ? snow_block : depth < 3 ? dirt : id
            elif rocky:  (keep id)
            else by c.land:
                desert:   depth < 3 ? sand : depth < 8 ? sandstone : id
                badlands: (depth == 0 and y <= SEA + 8) ? red_sand : y >= 100 ? TERRA[y & 15] : id
                taiga:    depth == 0 ? (patch > 0.45 ? podzol : grass_block) : depth < 4 ? dirt : id
                savanna:  depth == 0 ? (patch > 0.55 ? coarse_dirt : grass_block) : depth < 4 ? dirt : id
                other:    depth == 0 ? grass_block : depth < 4 ? dirt : id
        block = id
```

Everything at y ≥ yTop stays air (0).

`TERRA[y & 15]` (badlands band), indexed 0..15:
`terracotta, orange, terracotta, yellow, terracotta, white, red, terracotta, brown, orange, terracotta, light_gray, terracotta, red, orange, terracotta`. Every colour here except plain `terracotta` is `<colour>_terracotta`.

Two details are easy to miss. First, cave-air sets `prevAir` only when it is within 9 blocks of `hRaw`. Solid rock under a deep cave ceiling therefore gets `depth = 100` and no surface layers, while the floor of a shallow cave does get grass and dirt. Second, `kind[i + 256]` reads the kind array, not the block array.

### 7.5 Stages 5 and 6

After the surface pass come the underground features (§8) and then the trees (§9). Both write through `put`:

```
put(x, y, z, f):   // world coordinates
    lx = x − bx;  lz = z − bz
    if lx, lz not in 0..15 or y < 1 or y > 254: return
    i = y*256 + lz*16 + lx;  v = f(blocks[i]);  if v >= 0: blocks[i] = v   // f sees the current id; −1 = leave it
```

## 8. v3 — underground features (stage 5)

Features are generated **per origin chunk** as instance lists, which are pure functions of `(seed, origin cx, cz)`. Each chunk then replays the lists of its 3 × 3 neighbourhood and writes only the voxels inside itself. That is why veins and blobs cross chunk borders seamlessly.

### 8.1 Tables

Ores (the order is significant because it drives the stream):

| # | ore | y0 | peak | y1 | attempts | size s0..s1 | gate |
|---|---|---|---|---|---|---|---|
| 1 | coal | 60 | 128 | 200 | 24 | 6..14 | |
| 2 | iron | 16 | 60 | 112 | 12 | 4..9 | |
| 3 | iron | 140 | 185 | 230 | 24 | 4..9 | mountain |
| 4 | copper | 50 | 92 | 130 | 10 | 5..10 | |
| 5 | gold | 6 | 30 | 70 | 5 | 4..8 | |
| 6 | gold | 40 | 80 | 120 | 20 | 3..6 | badlands |
| 7 | lapis | 12 | 40 | 76 | 4 | 3..7 | |
| 8 | redstone | 4 | 12 | 40 | 8 | 4..8 | |
| 9 | diamond | 4 | 8 | 36 | 4 | 2..5 | |
| 10 | diamond | 4 | 10 | 30 | 1 | 5..8 | chance 0.125 |
| 11 | emerald | 100 | 180 | 220 | 20 | 1..3 | mountain |

Stone blobs (`BLOBS`, feature 3) and pockets (`POCKETS`, feature 4). The columns are `id, attempts, y0, y1, r0, r1, ry`:

```
BLOBS:   granite 5, 10, 120, 2.5, 5, 0.7 | diorite 5, 10, 120, 2.5, 5, 0.7 | andesite 5, 10, 120, 2.5, 5, 0.7
         tuff 8, 4, 48, 3, 6, 0.7 | calcite 2, 60, 130, 2, 4, 0.7
POCKETS: gravel 9, 6, 115, 2, 4, 0.6 | dirt 10, 60, 118, 2, 3.5, 0.6 | clay 1, 30, 110, 2, 3, 0.6
```

### 8.2 Instance lists (the draw order is the contract)

```
tri(rng, a, peak, b):                  // one draw
    u = rng();  fc = (peak − a) / (b − a)
    u < fc ? a + sqrt(u * (b − a) * (peak − a)) : b − sqrt((1 − u) * (b − a) * (b − peak))

oresOf(cx, cz):
    base = streamSeed(seed, cx, cz, ORE);  rng = mulberry32(base);  i = 0
    mountain = (lazily) chunkMaxH(cx, cz) >= MOUNTAIN_GATE
    badlandsChunk = (lazily) column(cx*16 + 8, cz*16 + 8).land == badlands
    for each ore row o, for a in 0 .. o.attempts−1:
        x = cx*16 + (rng()*16 | 0);  z = cz*16 + (rng()*16 | 0)       // x drawn before z
        y = round(tri(rng, o.y0, o.peak, o.y1))
        size = o.s0 + (rng() * (o.s1 − o.s0 + 1) | 0)
        chanceDraw = o has chance ? rng() : 0                        // drawn before any rejection
        idx = i++                                                    // index = attempt index, kept or not
        if o.mountain and not mountain: skip
        if o.badlands: if not badlandsChunk: skip;  c = column(x, z);  if c.land != badlands or c.h <= SEA: skip
        if o has chance and chanceDraw > o.chance: skip
        emit { x, y, z, size, ore: o, sub: subSeed(base, idx) }

blobList(cx, cz, feature, table):      // BLOBS with feature 3, POCKETS with feature 4
    rng = mulberry32(streamSeed(seed, cx, cz, feature))
    for each row, for each attempt:
        x = cx*16 + (rng()*16 | 0);  z = cz*16 + (rng()*16 | 0);  y = y0 + (rng() * (y1 − y0) | 0)
        emit { x, y, z, r: r0 + rng() * (r1 − r0), id, ry }                     // x, z, y, then r

geodesOf(cx, cz):
    rng = mulberry32(streamSeed(seed, cx, cz, GEODE))
    if rng() >= 1/24: none
    else one: x = cx*16 + (rng()*16|0), z = cz*16 + (rng()*16|0), y = 24 + (rng()*36|0), r = 4 + rng()*2.5

poolsOf(cx, cz):                        // own chunk only
    rng = mulberry32(streamSeed(seed, cx, cz, POOL))
    for a in 0..3:  lava = a < 2
        x = cx*16 + 4 + (rng()*8|0);  z = cz*16 + 4 + (rng()*8|0)
        y = lava ? 12 + (rng()*28|0) : 40 + (rng()*60|0)
        emit { x, y, z, r: 2 + rng()*1.5, liquid: lava ? lava : water }
```

Every attempt draws its random numbers **before** any rejection test. Rejecting an attempt therefore never shifts the numbers any later attempt receives.

### 8.3 Writers

```
vein(o, f):                             // random walk from o's own sub-stream
    rng = mulberry32(o.sub);  (x, y, z) = (o.x, o.y, o.z)
    repeat o.size:
        put(x, y, z, f)
        if rng() < 0.5:  put(x + (rng() < 0.5 ? 1 : 0), y, z + (rng() < 0.5 ? 1 : 0), f)   // x draw, then z draw
        d = rng()*6 | 0:  0 x++, 1 x−−, 2 z++, 3 z−−, 4 y++, 5 y−−
        y = clamp(y, o.ore.y0, o.ore.y1)
  ore setter: at is stone → ore id;  at is deepslate → deepslate variant;  otherwise leave (−1)

ellipsoid(b, f):   rx = rz = b.r,  ry = b.r * b.ry
    for dz = −ceil(rz) .. dz <= rz;  dy = −ceil(ry) .. dy <= ry;  dx = −ceil(rx) .. dx <= rx:   // dz outer, dx inner
        d = (dx*dx)/(rx*rx) + (dy*dy)/(ry*ry) + (dz*dz)/(rz*rz)          // summed left to right
        if d <= 1 and (d < 0.7 or hashv(b.x+dx, b.y+dy, b.z+dz) % 3 != 0): put(b.x+dx, b.y+dy, b.z+dz, f)
  blob and pocket setter: at is stone or deepslate → b.id, otherwise leave

geode(g):   r = g.r;  R = ceil(r) + 1
    dist(x, y, z) = sqrt((x−g.x)² + (y−g.y)² + (z−g.z)²) + (hashv(x, y, z) % 100) / 100 * 0.6
    for dz, dy, dx in −R..R (dz outer):  (x, y, z) = g + d;  d = dist(x, y, z)
        d > r + 0.8 → skip
        d > r       → smooth_basalt
        d > r − 1   → calcite
        d > r − 2   → ok = some face neighbour n (±x, ±y, ±z) has dn = dist(n) with r − 2 < dn <= r
                          and not (r − 2 < dn <= r − 1 and hashv(n) % 6 == 0)
                      budding_amethyst if hashv(x, y, z) % 6 == 0 and ok, else amethyst_block
        else        → air
        put(x, y, z, always that value)     // geodes overwrite anything

pool(p):   // reads and writes blocks directly, always inside this chunk; "liquid" = water or lava
    fy = −1
    for yy = p.y; yy > p.y − 8 and yy > 1; yy−−:
        if block(p.x, yy, p.z) == air and block(p.x, yy−1, p.z) is neither air nor liquid: fy = yy − 1; break
    if fy < 1: not placed
    cand = (x, z) for dz, dx in −3..3 (dz outer) with dx² + dz² <= r²,
           block(x, fy, z) neither air nor liquid, and block(x, fy+1, z) == air
    ok = cand whose 4 horizontal neighbours at fy and the block below (fy − 1) are all neither air nor liquid
    if |ok| < 4: not placed;  else every ok voxel at fy becomes p.liquid
```

### 8.4 Stage 5 order

```
for ncz = cz−1 .. cz+1, for ncx = cx−1 .. cx+1 (ncz outer), skipping origins outside 0..31:
    for o in oresOf(ncx, ncz):      vein(o, ore setter)          (the code skips instances whose box misses this chunk;
                                                                  so do ellipsoid and geode; none of the skips changes the output)
    for b in blobsOf(ncx, ncz):     ellipsoid(b, blob setter)
    for b in pocketsOf(ncx, ncz):   ellipsoid(b, blob setter)
    for g in geodesOf(ncx, ncz):    geode(g)
for p in poolsOf(cx, cz):
    pc = col(p.x − bx, p.z − bz)
    if pc.ravW > 0 and wn(p) == 0 and abs(RAV(p.x/230, p.z/230)) < 0.4 * pc.ravW: skip    // never in a ravine core
    pool(p)
cave decoration (below)
```

The four feature types are **interleaved per origin chunk**. Order matters: a geode from origin A overwrites ore that origin A placed earlier, and origin B's ore sees origin A's geode.

**Cave decoration** runs last and reads the blocks as they are at that moment:

```
for lz, lx in 0..15;  ceilD = caveCeil(lx, lz)
    for y = 2; y < yTop and y < ceilD; y++:   i = y*256 + lz*16 + lx
        if kind[i] != 2 or blocks[i] != air: continue
        below = blocks[i − 256];  above = blocks[i + 256]            // both read before any write below
        if below is stone|deepslate and kind[i − 256] == 1:
            dn = DECO(wx/40, y/40, wz/40)
            if dn > 0.45 and 56 < y < 112:
                blocks[i − 256] = moss_block;  if hashv(wx, y, wz) % 5 == 0 and y + 1 < yTop: blocks[i] = moss_block
            elif dn < −0.45 and hashv(wx, y, wz) % 7 == 0:          // stalagmite, grows up through air
                hgt = 1 + hashv(wx, y + 1, wz) % 3;  for k in 0..hgt−1 while blocks[i + 256k] == air: blocks[i + 256k] = dripstone_block
        if above is stone|deepslate and kind[i + 256] == 1:
            dn = DECO(wx/40, y/40, wz/40)
            if dn < −0.45 and hashv(wx, y, wz) % 9 == 0:            // stalactite, grows down through air
                hgt = 1 + hashv(wx, y − 1, wz) % 3;  for k in 0..hgt−1 while blocks[i − 256k] == air: blocks[i − 256k] = dripstone_block
            elif dn > 0.45 and 56 < y < 112 and hashv(wx, y, wz) % 3 == 0: blocks[i + 256] = moss_block
```

The loop runs y upward, so a voxel changed at a lower y is seen at the next y. Stalagmites fill voxels that later iterations then skip.

## 9. v3 — trees (stage 6)

```
TREES by biome:  plains 0..2 [oak] | forest 8..12 [oak, oak, birch] | cherry 2..4 [cherry]
                 taiga 6..9 [spruce] | snowy 1..2 [spruce] | savanna 1..2 [acacia]      (ocean, desert, badlands: none)
trunk height hh: oak 4..6, birch 5..7, spruce 6..10, acacia 5..6, cherry 4..5
GROUND_OK = { dirt, grass_block, podzol, coarse_dirt, snow_block }

treesOf(cx, cz):
    rt = mulberry32(streamSeed(seed, cx, cz, TREE))
    cc = column(cx*16 + 8, cz*16 + 8);  spec = TREES[cc.biome];  if none: []
    n = spec.n0 + (rt() * (spec.n1 − spec.n0 + 1) | 0)
    for a in 0..n−1:
        lx = rt()*16|0;  lz = rt()*16|0;  sp = spec.species[rt() * len | 0];  hh = sp.h0 + (rt() * (sp.h1 − sp.h0 + 1) | 0)
        r1 = rt();  r2 = rt()                                        // all six draws happen before any rejection
        x = cx*16 + lx;  z = cz*16 + lz
        reject if an already-accepted tree has |t.x − x| < 3 and |t.z − z| < 3
        c = column(x, z)
        reject if c.h < SEA + 1 or isBeach(c) or c.river > 0.2 or inRavineChannel(x, z)
                  or c.biome != cc.biome or c.h >= snowLine(c) or not flatCell(x, z)
        reject if c.ent > ENT_T and not tunnelFree(x, z, c.h)
        accept { x, z, h: c.h, hh, r1, r2, sp }
```

Templates. `top = t.h + hh`. **log** writes unconditionally, **leaf** writes only onto air, and **plug** writes dirt at `(x, h, z)` unless the block there is already in GROUND_OK:

```
oak, birch (blob canopy):
    plug; logs y = h+1 .. top
    for dy = −3 .. 0:  y = top + dy;  r = dy >= −1 ? 1 : 2
        for dz, dx in −r..r (dz outer):  skip (0,0) when dy < 0
            corner = |dx| == r and |dz| == r;  skip a corner if r == 1 or hashv(x+dx, y, z+dz) % 2 == 0
            leaf
    leaf at top+1 on (0,0), (1,0), (−1,0), (0,1), (0,−1)
spruce:
    plug; logs h+1 .. top; leaf (x, top+1, z)
    r = 1;  for y = top down to h+3:
        for dz, dx in −r..r (dz outer): skip (0,0); if r == 2 also skip |dx| == 2 and |dz| == 2; leaf     // filled square, not an outline
        r = (r == 1 ? 2 : 1)
acacia:
    plug; dir = r1 < 0.5 ? x-axis : z-axis;  sgn = r2 < 0.5 ? +1 : −1
    for y = h+1 .. top:  if y == top − 1: step one block along dir·sgn;  log at the current (x, z)
    canopy at y = top around the shifted (x, z): dz, dx in −2..2 (dz outer), skip |dx| == 2 and |dz| == 2, leaf
    leaf at top+1 on shifted (x, z) + (0,0), (1,0), (−1,0), (0,1), (0,−1)
cherry:
    plug; logs h+1 .. top
    for dy = −1 .. 1:  y = top + dy;  r = dy == 1 ? 2 : 3
        for dz, dx in −r..r:  keep if dx² + dz² <= r² + 1, skipping (0,0) when dy == 1;  leaf
    leaf (x, top+2, z)
```

**Stage 6** replays `treesOf` for the 3 × 3 origins (ncz outer, ncx inner, only origins inside 0..31) and draws every tree through `put`. `put` clips each voxel to this chunk. Trees draw in list order, so a later tree's logs overwrite an earlier tree's leaves.

## 10. v3 — spawn search

`spawnV3(seed)` is not part of chunk generation. It is a pure function of the seed, run once when a world is created. It searches square rings around the map centre (256, 256), trying four passes of decreasing strictness:

```
PASSES = [ (minH 130, gentle, minBuild 0.4), (122, gentle, 0.4), (122, not gentle, 0.4), (122, not gentle, 0) ]
for each pass, for r = 0 .. 128, for dz = −r..r, for dx = −r..r (dz outer), only where max(|dx|, |dz|) == r:
    (x, z) = (256 + dx, 256 + dz);  if ok(x, z, pass) returns b: return (x, z, column(x, z).h)
fallback (never observed): (256, 256)

ok(x, z, minH, gentle, minBuild):        c = column(x, z)
    reject c.h < minH, c.river > 0, c.ravW > 0, c.land == snowy, c.h >= snowLine(c), isBeach(c)
    reject if any of the 8 probes (±2,0) (0,±2) (1,1) (−1,−1) (1,−1) (−1,1) has |h − c.h| > 2
    reject if not flatCell(x, z), or canopyNear, or not tunnelFree(x, z, c.h)
    b = buildable(x, z, c.h);  reject b < minBuild
    reject if any in-map column within ±64 (square) has ravW > 0 and is a ravine channel   [channel uses double waterNear]
    if not gentle: accept b
    for dz, dx in −64..64 (dz outer; not clipped to the map):  q = column(x+dx, z+dz)
        reject if q.amp > 6
        reject if max(|dx|, |dz|) <= 32 and (|q.h − column(x+dx+1, z+dz).h| > 10 or |q.h − column(x+dx, z+dz+1).h| > 10)
        // every column in the window is compared with ITS OWN +x and +z neighbours, not with the spawn column
    reject if not mouthNear(x, z);  accept b

canopyNear(x, z) = some tree of treesOf over the 3×3 chunks around (x>>4, z>>4) (origins outside 0..31 have no trees) has |t.x − x| <= 7 and |t.z − z| <= 7
buildable(x, z, h) = count over the 49×49 square (±24) of columns with h' >= SEA + 1, river == 0 and |h' − h| <= 3, divided by 2401
mouthNear(x, z)    = some lattice corner (cx, cz), both stepping by 4 from (x − 40) & ~3 and (z − 40) & ~3 up to x + 40 and z + 40,
                     inside 0..511, where mouthCorner holds
mouthCorner(cx, cz): q = column(cx, cz);  q.h > SEA and q.ent > ENT_T and not waterNear(cx, cz)
                     and for some y in (q.h − 8, q.h − 4, q.h): tunnelDensity(cx, y & ~3, cz, q.h, true) > 0 or cheeseDensity(cx, y & ~3, cz) > 0
```

## 11. Block ids

v3 writes these catalog ids. They are frozen: `blocks.base.data.ts` ids 0–19 plus the generated catalog. The reference hashes depend on them.

```
air 0  grass_block 1  dirt 2  stone 3  sand 5  oak_log 7  water 17  lava 18  acacia_leaves 20  acacia_log 21
amethyst_block 24  andesite 26  bedrock 33  birch_leaves 36  birch_log 37  brown_terracotta 61  budding_amethyst 64
calcite 65  cherry_leaves 68  cherry_log 69  clay 83  coal_ore 85  coarse_dirt 86  copper_ore 91  deepslate 124
deepslate_coal_ore 126  deepslate_copper_ore 127  deepslate_diamond_ore 128  deepslate_emerald_ore 129
deepslate_gold_ore 130  deepslate_iron_ore 131  deepslate_lapis_ore 132  deepslate_redstone_ore 133
diamond_ore 136  diorite 137  dripstone_block 140  emerald_ore 143  gold_ore 157  granite 158  gravel 159
ice 174  iron_ore 176  lapis_ore 184  light_gray_terracotta 195  moss_block 217  oak_leaves 231
orange_terracotta 239  podzol 260  red_sand 290  redstone_ore 296  red_terracotta 293  sandstone 300
smooth_basalt 307  snow_block 312  spruce_leaves 316  spruce_log 317  terracotta 347  tuff 350
white_terracotta 368  yellow_terracotta 373
```

v1 and v2 use only grass_block, dirt, stone, sand, water and (v2 only) bedrock. `cobblestone`, `mossy_cobblestone` and `red_sandstone` appear in the v3 name list but no rule writes them.

## 12. Verification

**The acceptance test.** Hash each chunk's block array with FNV-1a-32 over the **Uint16 elements**. Each whole 16-bit id is XORed in; the array is not treated as bytes:

```
h = 2166136261;  for each id: h = imul(h ^ id, 16777619) >>> 0
```

| Version | Seed | Chunk (cx, cz) | Hash |
|---|---|---|---|
| v1 | 2026 | (0, 0) | 4166549171 |
| v2 | 12345 | (3, 5) | 3402466961 |
| v3 | 12345 | (0, 0) | 2020764513 |
| v3 | 12345 | (16, 16) | 800740276 |
| v3 | 12345 | (31, 31) | 2743801548 |
| v3 | 12345 | (5, 27) | 161955245 |

These are the constants in `generation.test.ts`. They are recorded once and never re-recorded.

**The six reference hashes cover much less than they appear to.** A clean-room rebuild from this doc still matched all four v3 hashes with any one of these removed: the pit cap, geodes, ravines, pools, cave decoration, shallow entrance pits, or float32 `caveCeil`. The four chunks also contain no spruce, acacia or cherry trees, and no snow, ice, desert, badlands, podzol, coarse dirt or emerald. Matching them is necessary, not sufficient. Also match these **coverage hashes**. They were produced by the shipped engine (2026-09-24). The engine and the rebuild agree on all 1024 chunks of seed 12345.

| Seed | Chunk | Hash | Covers |
|---|---|---|---|
| 12345 | (10, 2) | 2228629264 | spruce template (filled rings), pools, decoration, shallow entrance pits; also snow, podzol |
| 12345 | (12, 13) | 282354078 | geodes (with budding amethyst); also emerald, desert sandstone, badlands terracotta |
| 12345 | (1, 23) | 1029461773 | birch, savanna coarse dirt |
| 12345 | (0, 16) | 1969857804 | ice on snowy water |
| 12345 | (1, 24) | 4095451757 | acacia template |
| 12345 | (6, 22) | 1052017669 | cherry template; geodes |
| 12345 | (6, 27) | 3335755431 | ravine carving; pools |
| 12345 | (7, 15) | 1876328107 | badlands red sand and terracotta band |
| 12345 | (9, 2) | 2754869114 | open-sky pit cap |
| 1 | (25, 19) | 158084171 | float32 `caveCeil` (double precision here changes this chunk) |
| 4 | (25, 14) | 4284147560 | float32 `caveCeil` |

For the pit cap, geodes, ravines, pools, decoration, shallow pits, spruce rings and float32 `caveCeil`, the listed chunk was checked to go red when that rule is removed from the rebuild. For the other entries, the chunk contains those blocks, so a wrong rule would almost certainly change the hash. Float32 is the rarest failure: storing the five float32 arrays as doubles changed 2 of 8,192 chunks across seeds 1–7 and 12345, and those are the last two rows. The snow line is guarded by `docs/worldgen.md`'s map checker, not by any hash here. Two rules the rebuild could not make red anywhere on seed 12345: the `flat` shortcut (skipping `S` when all four corner amps are 0 is exact, since `S` is 0 there) and the ellipsoid's summation order.

**Layer vectors** (seed 12345 unless noted; produced by the shipped code on 2026-09-24). If a hash is wrong, work up from the bottom of this list: the first vector that disagrees points to the layer with the bug.

```
alea('minicraft:v3:12345:C') first three draws   0.2330382512882352, 0.7471213028766215, 0.3985971750225872
noise2D[alea('minicraft:v3:12345:C')](0.1, 0.2)  −0.2802026127558843
noise3D[alea('minicraft:v3:12345:SHAPE')](0.1, 0.2, 0.3)   0.3167236159999999
fbm2(C, 1, 2, 3)                                  −0.10727834005225642
mix32(1)                                          1364076727
streamSeed(12345, 3, 5, ORE=2)                    3610780444;   subSeed(that, 0) = 2611145972
mulberry32(42) first three                        0.6011037519201636, 0.44829055899754167, 0.8524657934904099
hashv(1, 2, 3) = 2668369679;   hashv(−1, 100, 7) = 8901240

column(256, 256): h 141, hRaw 141.18091269944063, forest, amp 0, ent 0, river 0,
                  T 0.19783186770575978, Hu −0.11488945856045903, ravW 0, ravDepth 40, M 0.08509708877269766, snowLine 163.9566373541152
column(100, 400): h 171, hRaw 171.22249017119827, forest, amp 7.535369587062368, ent 0.31485019046020857,
                  T 0.016260816562485125, Hu 0.09846842568393153, M 0.5376885549448902
column(0, 0):     h 102, hRaw 102.07809053497942, biome ocean, land forest, amp 0, T 0, Hu 0, M 0
column(300, 128): h 145, hRaw 145.9925092523188, forest, ent 0.44312786665939363, T −0.13097942980754432, snowLine 149.78360447501154

chunkMaxH(16, 16) = 141
oresOf(16, 16): 67 instances; first three (x, y, z, size, id, sub):
    (259, 181, 265, 13, 85, 2145785774)  (268, 156, 258, 6, 85, 2726483828)  (256, 138, 266, 10, 85, 895881925)
blobsOf(16, 16) first two:   (261, 15, 260, r 4.396517245913856, granite)  (262, 59, 265, r 4.972330962191336, granite)
pocketsOf(16, 16) first two: (265, 66, 265, r 3.770766334608197, gravel)   (258, 96, 257, r 3.799518602900207, gravel)
geodes over the whole map: 34
poolsOf(16, 16): lava (267, 35, 261, r 2.989732012269087), lava (260, 12, 267, r 2.104521526140161),
                 water (263, 96, 263, r 2.5595330528449267), water (260, 82, 266, r 2.5631911881500855)
treesOf(16, 16): oak at (259, 260), h 139, hh 5
treesOf(5, 27), as (x, z, h, hh):  oak (81, 444, 132, 4), oak (85, 437, 135, 5), birch (81, 434, 137, 6),
                 oak (94, 437, 129, 5), birch (86, 445, 128, 7), birch (86, 434, 137, 6)
spawnV3(12345): (280, 286), h 130, pass 1, ring 30, buildable 0.5110370678883799
```

**Finding a divergence inside a chunk.** Hash the intermediate arrays in stage order (`cols`, `ampCell`/`wn`/`caveCeil`, `S`/`Dch`/`Dtn`, `kind` before and after the pit cap, then blocks after stages 4, 5 and 6) against the shipped engine, and fix the first one that differs. `generateChunkV3(chunk, seed, capture)` exposes `S`, `Dch`, `Dtn`, `caveCeil`, `kind` (after the pit cap only) and the entrance flags. `cols`, `ampCell`, `wn` and the pre-cap `kind` need a temporary hook, or can be recomputed from the `column()` vectors. `docs/superpowers/reference/worldgen-v3-prototype/hash.ts` is the independent prototype that the constants were bootstrapped against.

**Beyond hashes.** `npm run worldgen:check` scans every voxel of all 1024 chunks on 8 seeds and checks the exact invariants and statistical bounds (see `docs/worldgen.md`, Instruments). A rebuild that matches the hashes should also pass it.

## 13. Pitfalls

Items 1 and 3, the second half of item 2 and the template/ellipsoid part of item 7 are conservative: probes found no input in this generator where they actually diverge. Keep them anyway, because a future constant change could make them matter. Items 4, 5, 6, 8, 9 and 10, the chunk-array half of item 2 and the cave-decoration part of item 7 do change output.

1. Folding `h − SEA − 6` into `h − 126`, or letting the compiler contract `a + b*c` into an FMA.
2. Keeping the lattice, `ampCell` or `caveCeil` in double precision. They are float32. Conversely, rounding the standalone `ampCellOf`/`waterNear` used by trees and spawn to float32, when those are doubles.
3. Using round-half-away-from-zero for `ravBottom` or ore `y`.
4. Drawing fewer random numbers for a rejected attempt (ores, trees), or changing the draw order (x before z, the chance draw last).
5. Replaying all ores of the 3 × 3 neighbourhood before all blobs. The four feature types interleave per origin chunk.
6. Hashing the chunk as bytes instead of as Uint16 elements.
7. Iterating a template or ellipsoid in a different axis order where later writes depend on earlier ones (leaves only onto air, cave decoration reading its own writes).
8. A symmetric pad of 4. The +5 side is what lets the two chunks sharing a boundary lattice node compute the same `ampCell`, `wn` and `caveCeil` for it.
9. Seeding the noise with anything other than JavaScript's `String(seed)`.
10. Using the textbook 256-swap Fisher–Yates or a `% 8` gradient index in simplex noise. This library does 255 swaps and uses `% 12`.
