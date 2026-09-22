# Performance

How Minicraft keeps moving smooth in 256-high generator-v3 worlds. The design and its review
history are in `docs/superpowers/specs/2026-09-22-performance-design.md`. The shadow algorithm
is in `docs/lighting.md` under "Cast shadows".

The problem this solved: each new v3 chunk cost about 33 ms of main-thread work (generation,
lighting, shadows, meshing), and the loop mounted two per frame in insertion order. Moving
stalled for 75 to 265 ms at a time. The GPU was never the bottleneck: fps did not change with
pixel ratio 0.5, 1 or 2.

## Radii

All in `src/engine/world/radii.ts`, measured in chunks, Chebyshev distance from the player's chunk.

| Constant | Value | Meaning |
|---|---|---|
| `MESH_RADIUS` | 6 | Chunks within it are streamed in and meshed. Also the "wanted" test for worker replies. |
| `UNMOUNT_RADIUS` | 7 | Meshes beyond it are disposed. Peaks at 15×15 = 225 mounted. |
| `DATA_RADIUS` | 8 | Unmodified chunk data beyond it is dropped. 17×17 = 289 chunks ≈ 92 MB. |

`VIEW_RADIUS = 4` in the loop is only the physics and walk ring.

Fog hides the unmount edge: `FOG_FAR = MESH_RADIUS × 16 − 8` (88 blocks),
`FOG_NEAR = FOG_FAR − 8` (80). The thin 8-block band keeps a summit at the edge legible;
a wider fade dissolved the one peak visible from the seed-3 spawn. The radii were 5/6/7 (fog
72) until the parent found the fog too close; 6/7/8 costs about 40 % more chunks to stream.

## Chunk index

`World` stores chunks in a flat array indexed `cx * WORLD_CHUNKS_Z + cz`, with a bounds check
that returns `undefined` outside 0..31. String keys were a quarter of the per-chunk cost. The
bounds check matters: without it, `(1, −1)` aliases chunk `(0, 31)` and the world's south edge
renders in false shadow.

## Scheduler

`src/game/chunk-scheduler.ts` is pure: `planFrame(input, clock)` decides what to mount this frame.

- **Edit lane first.** A chunk the player just edited is re-meshed before anything else,
  exempt from the budget, and it consumes that frame's stream budget. Placing a block stays instant.
- **Nearest first.** The stream lane is ordered by Chebyshev distance to the player's chunk,
  ties in insertion order.
- **Adaptive budget.** 20 ms per frame during the initial load or while still, 6 ms while
  moving, with a minimum of one chunk. A cold chunk exceeds 6 ms, so moving means one cold
  chunk per frame. Generating missing neighbours counts against the budget.
- **Dirty until applied.** A chunk leaves the dirty set only when its mesh is mounted.

Neighbours dirtied only by a shadow change go to the stream lane flagged `shadowOnly`, and are
re-meshed only if their `sunlitHash` changed.

## Worker

Shadows and meshing run in `src/engine/world/chunk.worker.ts`. Lighting stays on the main
thread because its flood fill writes into neighbouring chunks.

- **Payload** (`snapshotFor` in `chunk-jobs.ts`): copies of `blocks` for the 3×3, `lights`
  for the centre and its 4 axis neighbours, and `sunlit` for those 4 neighbours. The mesher
  samples neighbour `sunlit` at border corners; without it no chunk matched the sync path.
  The copies' buffers are transferred, never the World's own arrays. About 0.3 ms per job.
- **UV table**: a pure `Float32Array` built from `atlas.json` (`uv-table.ts`), posted once.
- **Staleness**: each job records the chunk object and `Chunk.rev`. A reply is applied only if
  the world still holds that same object at the same `rev`, and only if the chunk is still
  within `MESH_RADIUS`. `rev` increases on block writes, light updates and shadow invalidation.
- **Dropped replies re-dirty** the chunk so the next frame posts it again.
- At most 2 jobs in flight. In-flight chunks are skipped by the stream lane.
- The `Worker` is built through an injectable factory. Tests use an inline factory in
  `chunk-jobs.test-utils.ts` that routes payloads through `structuredClone` with transfer, so
  detached buffers are exercised.

## Eviction

`GameLoop.evict()` runs right after `simulate` (after the liquid scheduler's tick).

- Meshes beyond `UNMOUNT_RADIUS` are disposed and removed from every loop set.
- Chunk data beyond `DATA_RADIUS` is dropped only if the chunk is unmodified. Modified chunks
  are what the save holds, so they stay for the session. Liquid flow marks chunks modified,
  so flowed chunks stay too.
- Re-entering regenerates byte-identical blocks and re-lights. Faint light seams at the
  re-entry edge are accepted, as they already existed at the load frontier.
- `hasLiquid` lets dry chunks skip a 65 536-voxel liquid-frontier scan on every re-mesh. It is
  set by generation, by liquid writes, and recomputed in `applySave`.

## F3 overlay

F3 toggles a top-left panel (`src/ui/perf-overlay.ts`), ignored while frozen, in the inventory,
the colour picker, or with a text field focused. Twice a second it shows: fps, average and
worst frame time, frames over 50 ms in the last 10 s, main-thread share, draw calls and
triangles, mounted and data chunk counts, stream, edit and worker queues, time of the last
edit, JS heap, pixel ratio and canvas size, and the GPU name. Frame time is a raw
`performance.now()` delta, because the renderer clamps `dt` at 100 ms.

## Benchmark

`npm run perf:bench` (`scripts/perf-bench.ts`, Playwright). It starts its own dev server on
port 5174 with the save API pointed at a dead local port, and aborts if the page requests any
other host. Seed 3, a fresh world per repetition, 6 repetitions per phase with the first
discarded, median of the other 5. The player is moved by writing its position each frame, and
each phase asserts the distance travelled, so a stuck player fails the run instead of passing it.

Phases and gates: walking (0 frames over 50 ms, ≤ 100 ms of long tasks per 10 s), flying at
tier 5 (≤ 5 frames over 50 ms, ≤ 400 ms per 8 s), initial load (no task over 50 ms that starts
after the `minicraft:world-ready` mark; the one-time spawn search before it is printed
separately), 40 edge and 20 interior edits (every edit applied; main-thread work per edit, the
`lastEditWorkMs` stat, edge ≤ 50 ms and interior ≤ 20 ms; no frame over 50 ms), and memory after 30 s of flight (heap including typed-array
backing stores ≤ 250 MB, mounted ≤ (2·`UNMOUNT_RADIUS`+1)², data ≤ (2·`DATA_RADIUS`+1)² plus
modified chunks). fps and p95 are
printed but never gate: they swung by 2× between identical runs.

Final run (same machine as the baseline, medians of 5):

| Phase | Before | After |
|---|---|---|
| Walking | 3 frames > 50 ms per 10 s | 0 long-task ms; 0 or 1 frame just over 50 ms (flaky, open) |
| Flying tier 5 | 444 ms of long tasks, 18 frames > 50 ms | 0 ms, 0 frames |
| Initial load | worst task 433 ms | none over 50 ms after the world exists |
| Edits | 130–160 ms freeze | 10 ms interior, 26 ms at a chunk edge |
| Memory | 407 MB, unbounded | 71 MB |

The remaining hitches came from the liquid scheduler, not chunk work: generated ocean at the world
edge read the outside as air and retried ~5 500 phantom flows every tick, and every liquid cell of
each arriving chunk was rescanned. Outside the map now reads as a wall, and `seedArrival` seeds only
cells that can act. The walk row's occasional single 50–55 ms frame has no long task behind it and
is not yet attributed.

## Out of scope

Greedy meshing, lighting in the worker, vertical chunk sections, resolution changes (measured
to be irrelevant), and generator speed (3 % of a chunk's cost).
