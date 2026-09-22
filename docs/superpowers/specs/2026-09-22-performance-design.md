# Performance — smooth movement in v3 worlds

Status: draft for gate 1, 2026-09-22. Branch `perf` (cut from `worldgen`).

## 1. Goal

The parent measured ≈ 10 fps with periodic freezes while moving in a
generator-v3 world on the GPU desktop. Target after this project, measured
by the protocol in §6 on seed 3 around `spawnV3(3)`:

| Situation | Today | Target |
|---|---|---|
| Standing still | 58 fps, 0 long tasks | unchanged |
| Walking 5 blocks/s | 49 fps, p95 50 ms, ~1 hitch/s (max 116 ms) | ≥ 55 fps, p95 ≤ 25 ms, 0 tasks > 50 ms |
| Flying 27 blocks/s | 26 fps, p95 109 ms, 4.55 s of long tasks per 8 s | ≥ 45 fps, p95 ≤ 40 ms, long-task time ≤ 0.5 s per 8 s |
| Initial 81-chunk load | 2.9 s, 34 long tasks, max 154 ms | ≤ 2 s wall, no task > 50 ms after the first frame |
| JS heap after 450 chunks | 407 MB, unbounded | ≤ 200 MB, bounded by the view radius |

Nothing here changes what a world looks like or how it saves: every change
is byte-identical in world data (the v1/v2/v3 reference hashes must not
move) and pixel-identical in rendering except that far chunks unload.

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

## 3. Changes, in build order (each independently measurable)

### A. `World.getChunk` numeric index
`World` stores chunks in a flat `Array(WORLD_CHUNKS_X * WORLD_CHUNKS_Z)`
indexed by `cx * 32 + cz` (or `cx << 5 | cz`); `ensureChunk`, `getChunk`,
`neighbors`, iteration and eviction (§3.E) use it. No string keys on any hot
path (`markChunkDirty`'s `"cx,cz"` set in the loop is replaced by a numeric
`Set<number>`). Expected: −8.5 ms of the 33 ms cold mount. Behaviour
identical: the full suite and all three reference hashes must pass
unchanged; a micro-benchmark test (informational, not CI-gated) records
lights/shadows ms before/after on 81 v3 chunks.

### B. Time-budgeted, nearest-first chunk streaming
`flushDirtyChunks` becomes a pure scheduler over `(dirty set, player chunk,
clock)`: order candidates by Chebyshev distance to the player's chunk
(ties: insertion order), mount while `elapsed < BUDGET_MS` (6 ms) with a
minimum of one chunk per frame, and count neighbour `ensureChunk` work
against the same budget (a mount that needs 4 neighbours generated may be
the only one that frame). Edits (`markChunkDirtyAround`, block place/break)
keep their current synchronous re-mesh so placing a block stays instant.
`loadNearbyChunks` enqueues nearest-first too. Expected: walking-pace
hitches 74–116 ms → < 40 ms; with §3.A and §3.C, < 25 ms.

### C. Shadow ray cost
`computeChunkShadows` keeps its byte-identical output and the existing
3×3 `maxOpaqueY` early-out, plus: (1) the DDA walks inside the current
chunk's array until the ray crosses a chunk edge (no per-step
floor/modulo/`getChunk`); (2) a per-column highest-opaque heightmap for the
3×3 neighbourhood lets a ray stop as soon as its remaining path stays above
every column it can still visit (the sun ray moves 0.5 x and 0.3 z per +1 y,
so a 32-step ray visits ≤ 14 × 8 columns). Expected: shadows 3.5 → ≈ 1 ms
after §3.A. Test: the existing brute-force equivalence fixtures plus v3
chunks from seeds 1–3 (byte-identical `sunlit`).

### D. Worker for shadows + mesh
Lighting stays on the main thread (it mutates neighbours through a
cross-chunk BFS; moving it is a redesign of lighting ownership and is out of
scope). Shadows and meshing are pure per chunk given `blocks` and `lights`
of the chunk and its 3×3 (shadows) / 4 neighbours (mesh), so they move to a
`Worker`:
- Main thread: generate (or load) the chunk, run `fillChunkLights`, then
  post `{cx, cz, blocks×9, lights×5, atlas uv table once}` as transferable
  copies (a copy of 9 × 128 KB + 5 × 128 KB ≈ 1.8 MB per job; measured
  postMessage cost is what the plan must record, target < 1 ms).
- Worker: `computeChunkShadows` → `meshChunk` → returns `sunlit` and the
  geometry typed arrays (positions, normals, uvs, colors, indices) as
  transferables.
- Main thread on reply: if the chunk is still wanted and its `dirty`
  generation counter matches the job's, store `sunlit`, build the
  `BufferGeometry` from the arrays (upload only; not visible in the
  profile today), mount. Stale replies (chunk edited or evicted meanwhile)
  are dropped.
- Edits keep the synchronous main-thread path for the edited chunk and its
  affected neighbours (§3.B), so the worker only serves streaming. One
  worker; jobs are issued nearest-first by the §3.B scheduler with at most
  N (4) in flight.
- The mesher and shadow modules must stay free of DOM/THREE imports
  (`meshChunk` already returns plain arrays; `buildGeometry` stays on the
  main thread). Vite builds the worker with `new Worker(new URL(...),
  {type: 'module'})`.
Expected: moving fps ≈ still fps; main-thread cost per streamed chunk ≈
generate 2–3 ms + lights ≈ 5 ms (after §3.A) + upload.

### E. Bounded memory and scene
- Unmount chunks beyond `VIEW_RADIUS + 1` (dispose geometry, drop from the
  renderer maps) and drop *unmodified* chunk data beyond `VIEW_RADIUS + 3`
  from `World` (`modified` chunks stay in memory until the session ends;
  they are what the save holds). Re-entering regenerates deterministically.
  Lights of a chunk whose neighbour was dropped are recomputed when the
  neighbour comes back (the existing `fillChunkLights` on load path).
- Fog far = `(VIEW_RADIUS + 1) * 16 − 8`, near = 60 % of far, so the unload
  edge is never visible. Sky colour unchanged.
- Skip the 65 k-voxel liquid-frontier rescan on re-mesh when the chunk was
  generated with no liquid and has not been edited (a `hasLiquid` flag set
  by generation and by any liquid write).
Expected: heap bounded (≈ 81 + ring ≈ 120 chunks × 0.9 MB ≈ 110 MB
steady), draw calls bounded, no long-session slowdown.

### F. F3 stats overlay
Top-left monospace, click-through, F3 toggles (hardcoded like Tab; Chrome's
find is suppressed while the canvas has focus). Refreshed twice a second:
fps and average frame time over the last second, worst frame, count of
frames > 50 ms in the last 10 s, main-thread tick time vs frame time,
draw calls, triangles, mounted chunks, dirty queue length, worker jobs in
flight, JS heap when exposed, device pixel ratio and canvas size, GPU
string from `WEBGL_debug_renderer_info`. The aggregation is a pure
function with unit tests; the DOM panel is untested like the other
overlays. This is what the parent reads off the screen next time a machine
feels slow.

## 4. Out of scope
Greedy meshing, worker lighting, vertical sections, pixel-ratio or
resolution changes (measured to be irrelevant), generator cost (3 % of the
mount), any change to world data or save format.

## 5. Order and independence
A → C → B → D → E → F. A and C are pure refactors gated by byte-identical
output; B is a pure scheduler with unit tests; D depends on A–C for a fair
baseline and on B for job ordering; E depends on B (the scheduler owns the
wanted set); F is independent and can be built in parallel with any of them.

## 6. Instrument (the exit criteria)
1. **Byte identity**: v1/v2/v3 reference hashes unchanged; shadows
   equivalence fixtures byte-identical; a golden test that `meshChunk` on
   three v3 chunks returns identical arrays before/after (recorded once on
   `perf`'s base commit, in the test, as FNV-1a hashes of each array).
2. **Scheduler unit tests**: nearest-first order with ties by insertion;
   budget honoured with a fake clock; minimum one per frame; neighbour work
   counted; edits bypass the queue; evicted chunks are never mounted from a
   stale worker reply (generation counter).
3. **Worker round-trip test** (vitest with a stubbed `Worker` that runs the
   worker module inline): identical `sunlit` and geometry arrays to the
   synchronous path for the same inputs; stale reply dropped.
4. **Eviction tests**: a modified chunk is never dropped; an unmodified one
   beyond radius + 3 is; re-entering regenerates byte-identical blocks;
   fog far matches the radius.
5. **Browser benchmark** (on demand, `scripts/perf-bench.ts` driving
   Playwright against `localhost:5174` with the API on a dead port): seed 3,
   new world, wait for the initial load, then the three runs of §1
   (still 10 s; walk 5 b/s for 10 s; fly 27 b/s for 8 s) with a rAF frame
   sampler and a `PerformanceObserver('longtask')`; prints the §1 table and
   exits 1 when a target is missed. It is the exit criterion of the last
   task and the number the parent's report is compared against. Every task
   A–E records its own before/after line from this script in its commit.
6. **Overlay aggregation tests**: rolling fps/avg/worst/stutter-count from
   a synthetic frame series.
