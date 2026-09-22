# Worldgen

How terrain is generated in Minicraft. This doc covers the generator versions, the v3 pipeline, its determinism rules, the instruments that guard it, and what it costs downstream. The design, every numeric bound, and the evidence behind them live in `docs/superpowers/specs/2026-09-21-worldgen-v3-design.md` (the source of truth — section numbers below refer to it). This doc does not restate its numbers.

## Generator versions

Dispatch is `generateChunk(chunk, seed, genVersion)` in `src/engine/world/generation.ts`. `genVersion` is stored in the world record at creation and never changes for that world; `worldProfile(genVersion)` maps it to a chunk height and is consulted **only** at world creation (a stored record's own `height` is authoritative afterwards).

| genVersion | Generator | Height | Status |
|---|---|---|---|
| 1 | `generation.v1.ts` — grass/dirt/stone, sea level 28 | 64 | frozen |
| 2 | `generation.v2.ts` — tall placeholder, sea level 120 | 256 | frozen |
| 3 | `v3/generate.ts` — rich world (biomes, caves, ores, trees) | 256 | current |

`NEWEST_GEN_VERSION = 3` is what "New world" uses. Old versions are kept because unvisited chunks of a saved world regenerate on demand: the kid's existing worlds must produce the same blocks forever.

**The freeze rule.** `generation.test.ts` hashes fixed chunks of seed 12345 with the repo's FNV-1a-32 `hashBytes` (XOR over `Uint16` elements) and compares against a recorded constant per version: `EXPECTED_HASH`, `EXPECTED_HASH_V2`, and `EXPECTED_HASH_V3` (four chunks: (0,0), (16,16), (31,31), (5,27) — never the spawn chunk, so spawn constants can be tuned without a bump). The constants were bootstrapped once per spec §10 (engine and reference prototype agreeing in two separate processes) and are **never re-recorded**. Once a v3 world has shipped, any change to a v3 constant, noise-field name, stage order or rule is `genVersion 4` with its own dispatcher branch, not an edit to v3.

**What the reference hash cannot see.** A hash is only as good as the chunks it covers. The four reference chunks happen to be too low or too warm to reach the snow line, so the §4 rule-3 snow-line formula could be broken and all four hashes would still agree (spec §10, pre-ship re-run). Snow line is guarded instead by the seed-3 flank test in `v3/columns.test.ts` and the `T10.snowLineTopBad` map counter. Assume the same blind spot for any rule that fires on a minority of columns — the map checker, not the hash, is the instrument for those.

## v3 pipeline

`generateChunkV3(chunk, seed)` runs on the main thread and writes `chunk.blocks` in place. Stages, in order, with the file that owns each:

1. **Fields** — `v3/fields.ts`. 12 2-D and 7 3-D simplex noise fields, seeded `alea('minicraft:v3:${seed}:${name}')`, built once per seed into a module-level `Map<seed, Fields>` and never cleared mid-map. Renaming a field is a version change.
2. **Columns** — `v3/columns.ts`. `column(seed, x, z)` → height (`hRaw`, `h`), biome, `amp` (mountain amplitude), entrance/river/ravine strengths, temperature `T`, `snowLine`. Computed for a **25 × 25 padded** grid around the chunk (see pad below).
3. **Lattice → fill → surface** — `v3/generate.ts`. A 4 × 4 × 4 lattice of 3-D nodes (`S` shape offset, `Dch` cheese density, `Dtn` tunnel density) is evaluated up to `yTop`, trilinearly interpolated per voxel into a `kind` array (terrain-air / solid / cave-air / water), ravines are cut, the open-sky pit cap is applied, then a top-down surface pass assigns block ids (underwater > beach/bank > snow line > stony peak > biome; deepslate blend; lava below `LAVA_Y` in cave-air).
4. **Underground features** — `v3/features.ts` (`stage5`). Ores, stone blobs, gravel/dirt/clay pockets, geodes, pools, moss and dripstone decoration. Ore/blob/pocket/geode **instance lists** are pure functions of `(seed, originChunk)`; the chunk replays the lists of its 3 × 3 neighbourhood and writes only the voxels that fall inside itself (`put` clips). Pools are own-chunk only. Lists are memoised per seed (`evictLists` is the unload hook; no caller yet).
5. **Trees** — `v3/trees.ts` (`stage6`). Same replay scheme, `treesOf(seed, cx, cz)` over the 3 × 3 origins; five species templates; a tree skips entrance columns that fail `tunnelFree`.
6. **Spawn** — `v3/spawn.ts`. `spawnV3(seed)` is not part of chunk generation; `main.ts`'s new-world branch calls it once after showing "Building your world…" and yielding two frames, then hands `[x + 0.5, height − 1, z + 0.5]` to `findSafeSpawn`. No meta field is stored.

**Purity invariant.** Every stage is a pure function of `(seed, cx, cz)` and the arrays produced by earlier stages of the same chunk. No stage reads another `Chunk`. Consequently generation order does not matter, a chunk regenerated on another machine is bit-identical, and the only shared state is the two caches (fields, instance lists), which are pure memos.

**Shared lattice nodes agree.** Lattice nodes at local 0 and 16 lie on the chunk plane and are also computed by the neighbour. The invariant is that both chunks compute identical `S`, `Dch`, `Dtn`, entrance flag and `caveCeil` there, so caves and water are continuous across planes. `generate.test.ts` (§11.2) compares them across both the +x and +z planes, including the chunk-31 planes.

**Asymmetric pad −4/+5.** Columns are computed for local −4..20 (`PW = 25`). Per-column derived values (`ampCell`, `waterNear`, `caveCeil`) read the four lattice-cell corners `x & ~3 … +4`; the +5 side is what puts the corner at local 20 inside the grid for the shared node at local 16. A symmetric pad 4 truncates `ampCell` at the far edge and makes neighbours disagree (the `pad4` mutant: node mismatches, unstable water voxels, ceiling violations).

**Work counters.** `W.nodes`, `W.replays`, `W.instances` are incremented at the point of evaluation and reset per chunk. They are the machine-independent cost bound (§11.13): an extra lattice pass or a dropped origin changes a counter and goes red.

## Determinism

Bit-exactness across engines and devices is a requirement — the kid plays on two machines and unvisited chunks regenerate.

- **Arithmetic.** Generation uses `+ − × /`, `Math.sqrt`, `floor/ceil/round/min/max/abs`, `Math.imul` and integer ops only. `Math.hypot`, `sin`, `cos`, `exp`, `pow` are implementation-approximated in ECMA-262 and are banned in `src/engine/world/v3/` (the one `Math.sqrt` in `columns.ts` is commented for exactly this reason). The kid harness uses `Math.hypot` for measurement only.
- **Hash streams** — `v3/prng.ts`. Feature randomness comes from numeric streams, not string-seeded `alea`: `streamSeed(seed, cx, cz, feature)` is four rounds of murmur3 `fmix32`, driving a `mulberry32` chunk stream. `hashv(x, y, z)` is white noise on world coordinates (identical on both sides of a plane). String seeding costs ≈ 2 µs and an allocation per stream; there are 45 streams per chunk.
- **Instance index = attempt index.** Every attempt of a feature list, kept or not, consumes the chunk stream and gets sub-stream `i`. A vein's walk uses only its sub-stream, so adding or removing one attempt shifts nothing else in the chunk and a replayed instance is the same no matter which chunk replays it.
- `Math.random` stays banned in generation (`docs/specs.md` §4).

## Instruments

- **`npm run worldgen:check`** — the exit criterion before merging any generator change (≈ 2–3 min). Runs `scripts/worldgen-check.ts` on the 8 CI seeds (1, 2, 3, 5, 8, 13, 21, 34): `v3/mapcheck.ts` scans every voxel of all 1024 chunks per seed, exits 1 if any exact counter is non-zero, and prints min/p50/max of every statistic. Then `scripts/worldgen-kid.ts` on the same seeds: spawn safety and the §11.12 kid distances, with the CI bounds asserted and exit 1 on a violation. A red run is a code bug, never a reason to widen a bound.
- **Per-commit vitest** — `v3/mapcheck.test.ts` runs the full map check on seeds 1 and 2 only (≈ 25 s) and asserts every §11 statistical bound with hand-typed values; the exact-counter key set is itself asserted so an empty result cannot pass. `v3/generate.test.ts`, `columns.test.ts`, `features.test.ts`, `trees.test.ts`, `spawn.test.ts` cover the per-chunk exact clauses; `generation.test.ts` holds the three hashes.
- **The executed mutant.** `mapcheck.test.ts` runs the `coalshift` mutant for real: it shifts the checker's *hand-transcribed* band table by +8 and expects `T7.oreOutsideBand > 0`. This proves the band test can go red — a table imported from the generator would stay green under any shift. The other mutants named in spec §11 and §14 (`pad4`, `noz`, `noceil`, `nobend`, `poolrav`, `nopitcap`, …) were built and run in the prototype at gate time; only `coalshift` runs per commit.
- **Reference prototype** — `docs/superpowers/reference/worldgen-v3-prototype/`. The throwaway Node/tsx generator that produced the spec's evidence on seeds 1–100. Not game code, never imported by `src/`, eslint-ignored. `hash.ts` is the spec §10 bootstrap: prints the four reference hashes for engine and prototype (ids remapped) and `AGREE`/`DISAGREE`. If engine and prototype ever disagree, the engine is presumed wrong; hash each stage's output to find the first divergence.
- **On demand:** `npm run worldgen:kid 1 100` runs the 100-seed spawn/kid suite (≈ 15 min).

## Known costs

Measured at gate time (spec §2.1, §11.13); absolutes vary by machine.

- **Generation:** ≈ 2 ms per chunk warm (fields and lists cached), 3–7 ms cold; the first chunk of a process is 10–25 ms of JIT warm-up. Column stack, lattice, fill and features are roughly equal shares; trees are negligible.
- **Downstream mount** (`fillChunkLights` + `computeChunkShadows` + `meshChunk`): ≈ 1.5× v2 per chunk. Faces per chunk ≈ 3.8× v2 (caves, overhangs, trees), shadows ≈ 2.2–3× and dominant. The liquid scheduler seeds 50–90 k water voxels on tick 1 and then writes nothing.
- **`spawnV3`:** ≈ 0.1–2 s once at "New world". Work-bounded (rings ≤ 128 × 4 passes, memoised predicates), never time-bounded; a fifth fallback returns the map centre and has never been reached.
- **No chunk eviction.** Loaded chunks, their lightmaps, the field cache and the instance-list memos grow with the visited area; `evictLists`/`evictTrees` exist but nothing calls them.

**The performance project owns all of these** — shadow ray budget, off-thread meshing, mount pacing in `flushDirtyChunks`, eviction. The generator's own budget is the §11.13 work counters, not a wall-clock cap.

## Rules that came from playing it

Spec §14 records every gate-1 finding; two rules were added after the engine port from play-testing (§14 "Implementation feedback"):

- **Open-sky pit cap (`PIT_CAP = 24`, §6 rule 5).** A vertical tunnel shaft open to the sky ran 42 voxels on seed 2. In every non-ravine column, sky-open cave-air at `y ≤ h − 24` becomes solid; roofed cave-air is untouched so sloping mouths keep their continuation. Guarded by `pit.over30 == 0` (exact) and `pit.maxDepth ≤ 24` (statistical); mutant `nopitcap`.
- **Snow line continuous with the snowy threshold (§4 rule 3).** Parent play-test on seed 3: snow on the mountain next to a snow patch stopped halfway up, because the snowy biome cut in at `T < −0.45` while the altitude line was still at 151. `snowLine(T)` now meets the biome threshold at the lowlands (`max(122, 160 + 78·T)` for cold `T`). Bare-band columns fell 75 % on the CI seeds; the reference hashes did not move (see the blind spot above).

Parent decisions baked into the design, so nobody re-litigates them:

- **Spawn is a hill with a view.** Pass 1 wants `h ≥ 130`, gentle terrain within 64, ≥ 40 % buildable within 24, a tree within reach and a real cave mouth within 40; later passes relax height and gentleness, never safety. He should see the world, not a wall.
- **The lava sea stays.** Caves at the bottom fill with lava. It glows, it is the reward for digging deep, and it is the one thing down there that can hurt a build; he knows.
- **He flies.** Movement has a fly mode (`docs/movement.md`) and he uses it, so cliffs, ravines and overhangs are features, not hazards; the pit cap and the spawn rules are about not being ambushed on foot near spawn, not about making the whole map walkable.

## Code map

- `src/engine/world/generation.ts` — dispatcher, `NEWEST_GEN_VERSION`, `worldProfile`.
- `src/engine/world/generation.v1.ts`, `generation.v2.ts` — frozen generators.
- `src/engine/world/generation.test.ts` — the three reference hashes; v1/v2 shape tests.
- `src/engine/world/v3/generate.ts` — stages 1–4 orchestration, `PAD`/`PAD_HI`/`PIT_CAP`, `put`, work counters `W`, test `Capture`.
- `src/engine/world/v3/fields.ts` — noise fields, per-seed cache, `fbm2`/`fbm3`/`spline`.
- `src/engine/world/v3/columns.ts` — `column`, biomes, `snowLine`, `isBeach`, `flatCell`, `tunnelFree`, cave densities.
- `src/engine/world/v3/features.ts` — ore/blob/pocket tables, instance lists + memo, `stage5`.
- `src/engine/world/v3/trees.ts` — species templates, `treesOf` + memo, `stage6`.
- `src/engine/world/v3/spawn.ts` — `spawnV3`.
- `src/engine/world/v3/prng.ts` — `mix32`, `streamSeed`, `subSeed`, `mulberry32`, `hashv`.
- `src/engine/world/v3/blocks.ts` — catalog ids used by v3 (`V3`, `TERRA`, ore/log/leaf sets).
- `src/engine/world/v3/mapcheck.ts` + `mapcheck.test.ts` — the map instrument and the per-commit subset.
- `scripts/worldgen-check.ts`, `scripts/worldgen-kid.ts` — the `npm run worldgen:check` sweep.
- `src/main.ts` — new-world branch: "Building your world…", two rAF yields, `spawnV3`.
- `docs/superpowers/reference/worldgen-v3-prototype/` — reference prototype, `hash.ts` bootstrap (not game code).
