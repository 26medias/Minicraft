# Performance — smooth movement in v3 worlds

Status: gate 1 repaired 2026-09-22 (engine + rigour findings incorporated,
see §8). Branch `perf` (cut from `worldgen`).

Constants this document hangs off: `VIEW_RADIUS = 4` (loop.ts) — 81 chunks
in the 9×9 mesh view today; the mesh ring becomes radius 5 (§3.E). Fly tier
5 = `FLY_TIER_MAX` × `WALK_SPEED` = 25 blocks/s (player.ts); there is no
faster movement, so "fast flight" below means tier 5.

## 1. Goal

The parent measured ≈ 10 fps with periodic freezes while moving in a
generator-v3 world on the GPU desktop. The exit criterion is the browser
benchmark of §6.5 on seed 3 around `spawnV3(3)`, **same machine, same
session**, median of 5 repetitions per phase (first repetition discarded as
warm-up). Primary metrics are the two that hold to ±6 % / ±15 % between runs
of the same build: **total long-task ms per phase** and **count of frames
> 50 ms**. fps and p95 frame time are reported but never gate (they swing
2× between runs of one build — gate 1, R-B1).

| Phase | Today (baseline build) | Target |
|---|---|---|
| Standing still, 10 s | 0 long tasks | 0 long tasks, 0 frames > 50 ms |
| Walking 5 b/s, 10 s, ≥ 40 blocks travelled | 799–896 ms long tasks, 13–17 frames > 50 ms | ≤ 100 ms long tasks, 0 frames > 50 ms |
| Flying tier 5 (25 b/s), 8 s, ≥ 160 blocks | 575–615 ms long tasks, 4.5 s on the desktop | ≤ 400 ms long tasks, ≤ 5 frames > 50 ms |
| Initial load (81 mesh + ring), new world | 3.7–3.9 s wall, 35 long tasks, worst 445 ms | no task > 50 ms after the first frame; wall time informational |
| Edits: place 20 blocks along a chunk edge, then break them | 130–160 ms freeze per edit | 0 frames > 50 ms; interior edit re-meshes one chunk in < 20 ms |
| Memory: fly tier 5 for 30 s, idle 2 s, read heap | 407 MB after 450 chunks, unbounded | ≤ 200 MB; mounted ≤ 121, data chunks ≤ 169 |

World data stays byte-identical (the v1/v2/v3 reference hashes must not
move). Rendering stays **identical to a fully-loaded reference**: after this
project a chunk's `sunlit` no longer depends on the order chunks arrived
(today it does — §3.C, gate 1 R-B3). The only visible change is that far
chunks unload behind fog.

## 2. Baseline (measured 2026-09-22, Node 24 + headed Chromium, RTX 3080)

Per chunk, v3 cold mount ≈ 33 ms: generate 3.3, lights 9.0, shadows
6.5 × 1.44 calls, mesh 11.2 (2 896 solid faces mean, 5 272 max); plus 0–4
neighbours' generate + lights at ≈ 12 ms each. `flushDirtyChunks` mounts
2 chunks per frame in insertion order → frames of p50 63 / p95 125 / max
265 ms while streaming. The pixel ratio does not move fps (0.5 / 1 / 2 →
45–58 / 58 / 57 fps standing still); the GPU is not the bottleneck.

Top self time while moving: `rayHitsSolidInLoadedChunks` 18 %,
`propagateSkylight` 17 %, `sampleCornerLight` 12.5 %, `buildSolidMesh`
10 %; one level down, `World.getChunk` (string key + `Map` per DDA step and
per BFS voxel) is 20 % of the whole path. A probe replacing it with an array
lookup took shadows 7.4 → 3.5 ms and lights 9.7 → 5.1 ms per chunk.

Halving the flush budget to 1 chunk/frame (probe): fast-flight long-task
time 4.55 → 1.81 s per 8 s, and MORE chunks loaded (153 vs 117) because
frames got shorter.

Edit path today (gate 1, engine): place/break at a chunk corner = 159/162 ms
(shadows 4 × ~12 ms, mesh 6 × ~19 ms); interior = 129/126 ms (4 shadows,
4 meshes). The edit is enqueued behind streaming chunks in `dirtyChunks`, so
it is neither synchronous nor prioritised.

Shadows today depend on load order: `rayHitsSolidInLoadedChunks` treats a
ray leaving the loaded region as "sunlit", `neighbourhoodMaxOpaqueY` reads
neighbours without ensuring them, and `computeChunkShadows` clears
`shadowsDirty` — so a frontier chunk keeps partial-neighbourhood shadows
forever. Replaying the 81-chunk load: 14 of 117 chunks / 595 voxels differ
from a fully-loaded reference; nearest-first order alone makes it worse
(632 voxels). Independently confirmed by both reviewers.

## 3. Changes, in build order (each independently measurable)

### A. `World.getChunk` numeric index
`World` stores chunks in a flat `Array(WORLD_CHUNKS_X * WORLD_CHUNKS_Z)`
indexed by **exactly** `cx * 32 + cz`, and `getChunk` returns `undefined`
unless `0 ≤ cx < 32 && 0 ≤ cz < 32` — the bounds check is mandatory because
hot paths call it with out-of-range coordinates today
(`neighbourhoodMaxOpaqueY` dz −1..1, the DDA's `floor(iz/16)`, `applyLightUpdate`'s
`cz+1`). An unguarded `cx*32+cz` aliases (1,−1) onto (0,31) and (0,33) onto
(1,1); measured: 15 628 of 65 536 voxels of a south-edge chunk flip lit →
dark. `ensureChunk`, `neighbors`, iteration and eviction (§3.E) use the
index; `markChunkDirty`'s `"cx,cz"` strings and the loop's `dirtyChunks` /
`mountedChunks` sets become numeric (`Set<number>` keyed by the same index;
`loadNearbyChunks` builds 81 template strings per frame today). Persistence
keys (`dual.ts` merges by `"cx,cz"`) are a separate namespace and are not
touched.
Expected: −8.5 ms of the 33 ms cold mount. Tests: full suite and the three
reference hashes unchanged; **edge test** — chunks with cx, cz ∈ {0, 31}
plus inputs −1 and 32 compared against a string-keyed reference `World`
(mutant: drop the bounds check → (1,−1) returns (0,31)).

### C. Shadow ray cost, and load-order independence
`computeChunkShadows` keeps byte-identical output for a fully-loaded 3×3
and becomes independent of load order:
1. **Precondition**: the scheduler (§3.B) ensures the full 3×3 (generate +
   `fillChunkLights`) before shadowing a chunk; rays can then only leave
   the loaded region at the world edge (treated as sunlit, deterministic).
   A chunk's shadows are re-dirtied whenever a 3×3 neighbour arrives or is
   dropped (§3.E), so nothing keeps a partial answer.
2. **Per-start-column early-out** (the exact form, gate 1 E-B4): every ray
   starts at a voxel centre with the same direction, so the relative voxel
   path is one constant table (51 steps, spanning −14 x, −9 z, +28 y).
   Build a 48×48 highest-opaque heightmap `colMax` over the 3×3; per start
   column `startMax[x,z] = max_k(colMax[path_k(x,z)] − dy_k)`; skip the
   ray whenever `y > startMax[x,z]`. This replaces the mid-ray wording of
   the draft, which was not exact.
3. The DDA walks over 3×3 chunk references with `>>4` / `&15` indexing —
   no per-step `floor` / modulo / `getChunk`.
Measured on seeds 1–3, 81 chunks each, fully loaded: 16.1 ms (today) →
10.8 (after A) → 1.5 (in-chunk walk) → **0.5 ms/chunk** (early-out),
byte-identical `sunlit`.
Tests: brute-force equivalence fixtures plus v3 chunks from seeds 1–3
(mutant: drop clause 2 → still identical, so also assert the ray-step
counter falls by ≥ 90 %); **stream-equivalence** — `sunlit` after a
simulated nearest-first stream of the 81 chunks of seed 3 equals `sunlit`
of the fully-loaded reference (red at HEAD: 37 voxels; mutant: skip the
re-dirty on neighbour arrival → red).

### G. No-allocation mesher
`meshChunk` allocates, per corner, 4 `LightSample` objects, a `V[]` and 3
result objects, and grows five `number[]` before copying to typed arrays
(`sampleCornerLight` 12.5 % + `buildSolidMesh` 10 % of the moving profile).
Rewrite with typed scratch buffers and no per-corner objects; emission
order (`y → z → x → FACE_ORDER`) is unchanged. Off-thread this only bounds
worker throughput (8.6 ms/chunk today, ~110 chunks/s vs ~15/s demand at
tier 5); it matters on the synchronous edit lane (§3.B), where it is the
2–3× that gets an interior edit under 20 ms. Pure refactor gated by the
byte golden of §6.1 (mutant: any changed vertex, colour or index → red).

### B. Budgeted, nearest-first streaming with an edit lane
`flushDirtyChunks` becomes a pure scheduler over `(edit lane, stream set,
player chunk, clock, moving flag)`:
- **Edit lane first, budget-exempt**: the edited chunk (and any chunk whose
  `sunlit` actually changed — §3.E's compare) is re-meshed on the main
  thread this frame, before any streaming. Today an edit sits in
  `dirtyChunks` behind streaming chunks; this is a change.
- **Stream set** ordered by Chebyshev distance to the player's chunk (ties:
  insertion order), mounted while `elapsed < budget`, minimum one per
  frame, with neighbour `ensureChunk` work (the 3×3 of §3.C.1) counted
  against the same budget.
- **Adaptive budget**: 30 ms per frame while the initial ring is loading or
  the player is still; 6 ms while moving. A cold v3 mount (≈ 20 ms after
  A) exceeds 6 ms, so while moving the minimum-one rule makes this exactly
  1 cold chunk per frame — which is §2's winning probe; the 6 ms constant
  only binds for cheap warm re-meshes. The 30 ms budget is what keeps the
  initial load under 50 ms tasks without taking 175 frames (E-B2).
- `loadNearbyChunks` enqueues the mesh ring at radius 5 (§3.E) nearest-first.
Expected: walking-pace hitches 74–116 ms → < 40 ms; with A, C and G,
< 25 ms.

### D. Worker for shadows + mesh
Lighting stays on the main thread: `fillChunkLights` BFS-writes into
already-mounted neighbours (`touched`), so it is not a pure per-chunk
function; moving it is a redesign of lighting ownership, out of scope.
Shadows and meshing are pure given the 3×3, so they move to one `Worker`:
- **Snapshot** taken after `ensureChunk` of the full 3×3 (generate +
  lights): `blocks × 9`, `lights × 5` (chunk + 4 axis neighbours), and
  **`sunlit × 4`** of the axis neighbours — the mesher reads neighbours'
  `sunlit` through `sampleCornerShadow`; without it the worker mesh matched
  the sync path in 0/12 chunks, with it 12/12 (E-B1). Copy-then-transfer
  (`slice()` + transfer list, ≈ 2 MB): measured 0.27 ms + 0.04 ms post,
  0.15 ms latency. A reply for a 2 904-face chunk is 567 KB, transferred in
  0.15 ms.
- **UV table**: a new pure function builds a `Float32Array(BLOCKS.length ×
  6 × 4)` from `AtlasJson` (split out of `loadAtlas`, which stays next to
  the THREE texture); posted once at worker start. `meshChunk` and
  `computeChunkShadows` import only `blocks.data` and `coords` — no THREE,
  DOM or `import.meta` — and the worker rebuilds real `Chunk` instances
  over the received buffers.
- **Revision counter**: new field `Chunk.rev: number`, incremented by
  `Chunk.set`, by `updateLightsForBlockChange` for every touched chunk, and
  by shadow invalidation (§3.C.1). A job carries `{chunk, rev}`; a reply is
  applied only if `world.getChunk(cx, cz) === job.chunk && chunk.rev ===
  job.rev` (object identity covers re-entry after eviction, which creates
  a fresh `Chunk`). Parity note: a neighbour whose lights changed from a
  later chunk's generation is not re-meshed today; keep that parity — do
  not bump `rev` for it, or frontier jobs cancel in a loop.
- **Wanted** = within Chebyshev `VIEW_RADIUS + 1` of the *current* player
  chunk; this is the same predicate the evictor uses (§3.E), so a reply for
  an evicted chunk is always unwanted. One worker, at most **2** jobs in
  flight (a deeper queue buys no parallelism and maximises staleness).
- The `Worker` is constructed through an injectable factory
  (`vite`: `new Worker(new URL('./chunk.worker.ts', import.meta.url),
  {type: 'module'})`; tests inject a stub) because vitest runs in the node
  environment where `Worker` does not exist.
- Main thread on reply: store `sunlit`, build the `BufferGeometry` from the
  arrays (upload only), mount. Edits never go through the worker.
Expected: main-thread cost per streamed chunk ≈ generate 2–3 ms + lights
≈ 5 ms + snapshot 0.3 ms + upload; moving fps ≈ still fps.

### E. Bounded memory and scene
- **Rings** (all Chebyshev from the current player chunk, `VIEW_RADIUS =
  4`): mesh ring radius 5 (121 chunks; the visible frontier is 80 blocks
  ahead of the player); unmount beyond radius 6 (dispose geometry, drop
  from the renderer maps, remove from the numeric `mountedChunks` and
  `dirtyChunks` sets — an entry left in `mountedChunks` would block the
  re-mesh on re-entry); drop **unmodified** chunk data beyond radius 8
  (13×13 = 169 data chunks × 320 KB ≈ 54 MB + ≈ 121 meshes × 0.6 MB
  CPU-side ≈ 73 MB → ≈ 130 MB plus baseline). `modified` chunks stay in
  memory for the session; `autosave.snapshot()` is exactly
  `world.modifiedChunks()` (verified), so nothing a save needs is dropped.
  Re-entry regenerates byte-identical blocks (verified 32/32) and re-lights
  (≈ 14.6 ms/chunk); faint light seams on re-entry are the pre-existing
  frontier behaviour, now crossed more often — accepted.
- Dropping a neighbour re-dirties the retained chunks' shadows (§3.C.1).
- Eviction runs **after** `scheduler.tick` in the frame, and no scheduler
  read may reach beyond the data ring: `World.getBlock → ensureChunk`
  regenerates silently (19 scheduler call sites), so a dev-mode assertion
  fires if a read lands outside radius 8. v3 generation places no liquid
  with an air side or air below (0 shoreline cells on seeds 1–3), so
  generated lakes decay out of the frontier and cannot thrash; a
  player-placed source marks its chunk modified and is kept.
- **Fog** today 60 / 200; new near 43 / far 72, inside the 80-block mesh
  frontier so the unload edge is never visible. Sky colour unchanged.
- **`hasLiquid`**: skip the 65 k-voxel liquid-frontier rescan on re-mesh
  when the chunk has no liquid. The flag is set by generation, by any
  liquid write, **and recomputed in `applySave`** — a naturally dry chunk
  the kid poured water into is reloaded from the save, not generated, and
  must still enter the frontier (R-N4).
Expected: heap ≤ 200 MB, draw calls bounded, no long-session slowdown.

### F. F3 stats overlay
Top-left monospace, click-through, F3 toggles. Gated exactly like the Tab
handler: ignored while frozen, while the inventory or colour picker is
open, or while the PIN input has focus; `preventDefault()` on the key.
Refreshed twice a second: fps and average frame time over the last
second, worst frame, count of frames > 50 ms in the last 10 s, main-thread
tick time vs frame time, draw calls, triangles, mounted / data chunks,
stream and edit queue lengths, worker jobs in flight, JS heap when exposed,
device pixel ratio and canvas size, GPU string from
`WEBGL_debug_renderer_info`. The aggregation is a pure function with unit
tests; the DOM panel is untested like the other overlays. This is what the
parent reads off the screen next time a machine feels slow.

## 4. Out of scope
Greedy meshing, worker lighting, vertical sections, pixel-ratio or
resolution changes (measured to be irrelevant), generator cost (3 % of the
mount), any change to world data or save format.

## 5. Order and independence
**A → C → G → B → D → E → F.** A, C and G are refactors gated by
byte-identical output (A: suite + hashes + edge test; C: equivalence +
stream-equivalence; G: byte golden); B is a pure scheduler with unit tests;
D depends on A–C for a fair baseline, on G for edit-lane latency and on B
for job ordering; E depends on B (the scheduler owns the wanted set); F is
independent and may be built in parallel with any of them. The final bench
(§6.5) is the exit criterion of the last task; per-task bench lines are
informational only (per-task attribution is below the run-to-run noise).

## 6. Instrument (the exit criteria)
Every test names the mutant that turns it red.
1. **Byte identity**: v1/v2/v3 reference hashes unchanged; shadow
   equivalence fixtures byte-identical (§3.C); **mesh golden** — FNV-1a
   over the **bytes** (`Uint8Array` view) of each `meshChunk` array for
   three v3 chunks of seed 3, recorded once on `perf`'s base commit; the
   fixture pins construction (ensure the 5×5, shadow every chunk, then
   mesh) because `sunlit`/`lights` depend on the loaded set. Emission order
   is `y → z → x → FACE_ORDER` and no change here touches it, so an
   order-sensitive hash is the right instrument (mutant: G emitting one
   face in a different order → red).
2. **Scheduler unit tests** (pure function, fake clock): nearest-first with
   a Chebyshev-vs-Euclidean pair — (2,2) must precede (3,0) (mutant:
   `Math.hypot`); ties by insertion with same-ring chunks inserted in
   non-lexicographic order (mutant: sort by (d, cx, cz)); budget honoured
   with ≥ 2 budgets × ≥ 2 per-chunk costs **and** a non-uniform cost
   sequence (2, 2, 10, 2) (mutants: ignore the budget; pre-compute
   `floor(budget / cost)`); minimum one per frame when the clock is already
   past budget (mutant: `while (elapsed < budget)`); a chunk with 4 absent
   neighbours is the only mount that frame (mutant: neighbour work not
   counted); the edit lane runs before streaming regardless of budget
   (mutant: edits appended to the stream set); adaptive budget switches on
   the moving flag (mutant: constant 6 ms → initial-load fixture exceeds
   the frame count).
3. **Worker round-trip** (injected stub that routes the payload through
   `structuredClone(payload, {transfer})` so the sender's buffers are
   detached, and uses the **real** atlas UV table on the worker side and
   the real `uvFor` on the sync side): identical `sunlit` and geometry
   bytes to the synchronous path (mutant: omit `sunlit × 4` → 0/12
   identical); the sender's arrays are detached after post (mutant: stub
   that calls the function directly → not detached); stale reply dropped
   when `rev` moved or the `Chunk` object was replaced, **and** a fresh
   reply is applied (mutant: drop all replies → the twin fails); UV table
   built from `AtlasJson` equals `uvFor` for every block face (mutant: swap
   two faces).
4. **Eviction tests**: in one world, a modified and an unmodified chunk at
   the same distance beyond the data ring → the unmodified one is gone,
   the modified one present (mutant: no-op evictor); re-entry regenerates
   byte-identical blocks; `mountedChunks` / `dirtyChunks` no longer hold
   the evicted index (mutant: leave the entry → re-entry never re-meshes);
   retained neighbours' shadows are re-dirtied (mutant: skip → stream
   equivalence red); fog far = 72 given `VIEW_RADIUS = 4`; `hasLiquid`
   after `applySave` of a chunk with placed water is true (mutant: flag
   only from generation → red).
5. **Browser benchmark** — `scripts/perf-bench.ts`, `npm run perf:bench`,
   Playwright as a devDependency (`npm i -D playwright` + `npx playwright
   install chromium`, an explicit ~200 MB decision) against
   `localhost:5174` started with `VITE_MINICRAFT_API_URL=http://127.0.0.1:9099`
   (autosave stays live and fails against the dead port, as the kid's
   browser does offline; production is never contacted). Seed 3, new
   world, wait for the initial load, then the phases of §1 with a rAF
   frame sampler and a `PerformanceObserver('longtask')`, **driving the
   player by writing `player.position` each frame** (key events measured
   14 blocks in 10 s of "walking" and 0 in 8 s of "flying" while passing
   every fps criterion — R-B2) and **asserting blocks travelled** (walk
   ≥ 40 in 10 s, fly ≥ 160 in 8 s; fewer → the run fails). Median of 5
   repetitions per phase, first discarded. Prints the §1 table, exits 1
   when a primary target is missed. Mutant: a build that stalls 60 ms
   every 30th frame → walking row red.
6. **Overlay aggregation tests**: rolling fps / avg / worst / count > 50 ms
   from a synthetic frame series (mutant: off-by-one window).

## 7. Deviations from the draft, stated
"Initial load ≤ 2 s" is dropped as a gate: with a fixed 6 ms budget it is
unreachable (117 chunks × ≈ 9 ms main-thread = 175 frames ≈ 2.9 s); the
adaptive 30 ms budget makes it ≈ 1 s but wall time stays informational.
"Pixel-identical" became "identical to a fully-loaded reference" because
today's rendering is not even self-consistent (§2).

## 8. Gate 1 changes (finding → action)
| Finding | Action |
|---|---|
| E-B1 worker mesh needs neighbours' `sunlit` (0/12 → 12/12 identical) | §3.D payload adds `sunlit × 4`; copy-then-transfer numbers recorded |
| E-B2 initial load ≤ 2 s unreachable at 6 ms/frame | §3.B adaptive budget (30 ms still / loading, 6 ms moving); §7 drops the wall-time gate |
| E-B3 edit path 130–160 ms freeze, absent from §1 | §1 edit row; §3.B edit lane; §3.E sunlit-compare before neighbour re-mesh; change G |
| E-B4 §3.C early-out wording not exact; measured 16 → 0.5 ms | §3.C rewritten as the per-start-column form with the measured numbers |
| E-N1/N2 lights on main thread; rev counter and identity | §3.D snapshot after the 3×3; `Chunk.rev` + object identity; parity note |
| E-N3–N5 eviction numbers | §3.E: 14.6 ms re-entry, autosave = modifiedChunks, 169 data chunks ≈ 130 MB |
| E-N7 frontier shadows never redone | §3.C.1 re-dirty on neighbour arrival/drop |
| E-N8 mesher allocations | Change G |
| E-N9 uv table inside `loadAtlas` | §3.D pure `AtlasJson` → `Float32Array` function |
| E-U2/U4 worker count and queue depth | One worker, 2 in flight |
| R-B1 3 of 5 targets flip between runs | §1 primary metrics = long-task ms + frames > 50 ms; median of 5; same session |
| R-B2 bench passed while moving 0 blocks | §6.5 drives `player.position`, asserts blocks travelled |
| R-B3 `sunlit` depends on load order; identity gates blind | §3.C.1 precondition + re-dirty; stream-equivalence test (red at HEAD) |
| R-B4 index formula aliases the world edge (15 628 voxels) | §3.A one formula, mandatory bounds check, edge test |
| R-B5 worker test cannot go red; `Worker` absent in vitest; no counter | §3.D injectable factory, `Chunk.rev`; §6.3 structuredClone-with-transfer stub, real UV table, positive twin |
| R-N1 golden fixture unpinned; hash bytes | §6.1 |
| R-N2 scheduler mutants | §6.2 fixtures |
| R-N3 no-op evictor passes; stale sets | §6.4; §3.E numeric sets cleared |
| R-N4 `hasLiquid` breaks liquids on reload | §3.E recompute in `applySave` + test |
| R-N5 heap row unmeasurable | §1 memory phase (30 s tier-5 flight) |
| R-N6 Playwright not a dependency | §6.5 devDependency decision |
| R-N7 6 ms budget never binds while streaming | §3.B says so |
| R-U1/U2 fog vs load radius; `VIEW_RADIUS` unstated | Header constants; §3.E mesh ring 5, fog 43/72 |
| R-U3 edits: sync vs bypass vs today | §3.B edit lane, stated as a change |
| R-U5/U6 "wanted", counter | §3.D |
| R-U7 F3 gating | §3.F |
| R-U8 27 b/s unreachable | Tier 5 = 25 b/s everywhere |
