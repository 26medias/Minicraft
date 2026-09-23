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
`FOG_NEAR = 40`, a 48-block progressive fade. An 8-block band kept a distant summit crisp but read
as a wall of fog appearing, so the parent asked for a gradual fade; distant hills now look hazy. The radii were 5/6/7 (fog
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
- **Bulk lane** (crafting spec §7). A batched removal (a TNT blast, an area break; `GameLoop.removeBlocks`)
  sends only its anchor chunk (the TNT origin, the aimed block) to the edit lane. Every other chunk it
  touched — each removed cell's chunk and its edge neighbours, and every chunk the light touched — goes
  to the bulk lane. `planFrame` drains the bulk lane after the edit lane and before streaming, even in an
  edit frame, nearest first. With the worker, bulk chunks are posted, and when the worker is full they
  wait for the next frame; they never fall back to a synchronous mesh. Without the worker, one bulk chunk
  is meshed per frame. A bulk chunk stays in the lane until its mesh is applied, so a dropped reply
  leaves it there to be posted again. The south-east shadow neighbours stay shadow-only, as for a single
  edit. Single-block mining, placing and replacing never use the bulk lane: a block at a chunk edge still
  re-meshes both chunks in the same frame.
- Accepted visual cost: until its reply lands, a bulk chunk keeps its old mesh, so for a few frames the
  far side of a big hole can show blocks that are gone, or miss the faces that now face the hole. The
  bench asserts every bulk chunk is mounted within 16 frames of its edit.
- Light stays per block, called directly (not through `applyLightUpdate`, which would put every chunk
  the light touched in the edit lane). A bounding-box relight is wrong for sunlight: opening the roof of
  a shaft lights cells far below the box.

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
- **Staleness**: each job records the chunk object and `Chunk.rev` of all 9 chunks of the 3×3
  it copied. A reply is applied only if the world still holds every one of those objects at
  the same `rev`, and only if the chunk is still within `MESH_RADIUS`. `rev` increases on block
  writes, light updates and shadow invalidation. Checking the neighbours matters because a
  border edit in the dark leaves the centre's `rev` alone. The stale reply would then mount
  over the edit with a face missing, and nothing would re-mesh it. Checking identity catches a
  neighbour that was evicted and regenerated at a low `rev`.
- **Dropped replies re-dirty** the chunk so the next frame posts it again.
- **No drop cascade.** When a reply lands, the loop re-dirties its mounted axis neighbours (they sample
  its `sunlit` at their border corners) and bumps their `rev` only if the chunk's `sunlitHash`
  changed. Bumping them unconditionally, with 9-slot freshness, would drop every other in-flight job
  whose 3×3 holds one of them: the replies of a blast's bulk chunks would invalidate each other in turn.
- **Known stale seam (accepted).** A chunk's `sunlit` can change without its `rev` moving: the loop
  shadows axis neighbours on the main thread before posting a chunk, and that recompute does not
  re-dirty their own mounted neighbours. Those neighbours keep slightly stale border-corner shading
  until something else re-meshes them. It is a shading difference at one corner row, never missing
  geometry, and it predates crafting (spec §10 of the crafting design logs it here).
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
| Walking | 3 frames > 50 ms per 10 s | 0 long-task ms; 0 or 1 frame just over 50 ms (flaky, see below) |
| Flying tier 5 | 444 ms of long tasks, 18 frames > 50 ms | 0 ms, 0 frames |
| Initial load | worst task 433 ms | none over 50 ms after the world exists |
| Edits | 130–160 ms freeze | 10 ms interior, 26 ms at a chunk edge |
| Memory | 407 MB, unbounded | 71 MB |

### Crafting rows

The `craft` phase (crafting spec §8) measures batched removal:
- plain TNT (radius 3);
- a 5×5×5 area break held along a tunnel, 10 swings, one every 0.25 s;
- one radius-8 blast;
- a chain of four radius-8 blasts, 0.1 s apart.

Each runs once in a chunk's interior and once on a chunk corner, at fixed sites near the seed-3 spawn. Every row asserts
that each cell it should remove is gone.

Gates:
- no frame over 50 ms;
- light work under 15 ms in any frame;
- every bulk chunk mounted within 16 frames of its edit.

The dev box is faster than Noah's laptop, so a value within 20 % of a gate prints "thin".

Until the Mega TNT block exists, the radius-8 rows are a stand-in. The bench computes `detonate()`'s cell set itself
and removes it through the game's removal path. `MEGA` in the bench switches them to the real block.

Baseline, before batched removal (2026-09-23, medians of 3):

| Crafting row | max frame ms (median / worst) | frames > 50 ms | light ms, worst frame | bulk frames, worst chunk | cells removed | gate |
|---|---|---|---|---|---|---|
| TNT r3 interior | 43.4 / 43.7 | 0 | 1.2 | — (no bulk lane) | 122 | ok (thin) |
| TNT r3 corner | 50.4 / 51.5 | 1 | 0.6 | — (no bulk lane) | 122 | FAIL |
| area 5×5×5 ×10 held interior | 35.9 / 55.4 | 0 | 0.7 | — (no bulk lane) | 1250 | ok |
| area 5×5×5 ×10 held corner | 39.3 / 41.3 | 0 | 0.3 | — (no bulk lane) | 521 | ok |
| Mega r8 interior | 46.3 / 48.5 | 0 | 5.7 | — (no bulk lane) | 1219 | ok (thin) |
| Mega r8 corner | 53.8 / 54.0 | 1 | 7.2 | — (no bulk lane) | 1315 | FAIL |
| Mega r8 chain ×4 interior | 70.7 / 74.5 | 2 | 8.5 | — (no bulk lane) | 3675 | FAIL |
| Mega r8 chain ×4 corner | 52.7 / 53.9 | 1 | 8.7 | — (no bulk lane) | 3738 | FAIL |

Mega r8 chain ×4 interior: detonation frames 50.0 / 33.3 / 16.8 / 33.3 ms
Mega r8 chain ×4 corner: detonation frames 33.3 / 16.8 / 33.4 / 33.3 ms

After batched removal (removeBlocks, bulk lane, 9-slot freshness, no drop cascade), 2026-09-23, medians of 3:

| Crafting row | max frame ms (median / worst) | frames > 50 ms | light ms, worst frame | bulk frames, worst chunk | cells removed | gate |
|---|---|---|---|---|---|---|
| TNT r3 interior | 40.9 / 54.8 | 0 | 0.6 | 0 | 122 | ok (thin) |
| TNT r3 corner | 37.6 / 38.6 | 0 | 0.5 | 3 | 122 | ok |
| area 5×5×5 ×10 held interior | 31.7 / 36.6 | 0 | 0.6 | 3 | 1250 | ok |
| area 5×5×5 ×10 held corner | 38.4 / 45.4 | 0 | 0.3 | 4 | 521 | ok |
| Mega r8 interior | 27.3 / 36.8 | 0 | 4.0 | 4 | 1219 | ok |
| Mega r8 corner | 30.9 / 31.9 | 0 | 2.7 | 4 | 1315 | ok |
| Mega r8 chain ×4 interior | 32.3 / 43.5 | 0 | 4.5 | 10 | 3675 | ok |
| Mega r8 chain ×4 corner | 31.7 / 33.9 | 0 | 4.2 | 4 | 3738 | ok |

Mega r8 chain ×4 interior: detonation frames 16.7 / 16.7 / 16.7 / 16.7 ms
Mega r8 chain ×4 corner: detonation frames 16.7 / 16.8 / 16.7 / 16.8 ms

The chunk-corner TNT went from one ~52 ms frame (four chunks re-meshed synchronously) to 38 ms: only
the anchor is re-meshed in the edit frame, and the other three are posted to the worker and mounted
within 3 frames. Light work stays under 6 ms per frame even for a radius-8 blast. The interior r3 row
is still thin (~41 ms): it is the one chunk's own synchronous re-mesh, the same as a single edit in
a dense chunk.

### Crafting rows, after TNT tiers (2026-09-23)

Real Mega TNT (`MEGA.real = true`), full bench run:

| Crafting row | max frame ms (median / worst) | frames > 50 ms | light ms, worst frame | bulk frames, worst chunk | cells removed | gate |
|---|---|---|---|---|---|---|
| TNT r3 interior | 33.0 / 46.0 | 0 | 0.4 | 0 | 122 | ok |
| TNT r3 corner | 32.6 / 38.7 | 0 | 0.4 | 3 | 122 | ok |
| area 5×5×5 ×10 held interior | 29.1 / 30.9 | 0 | 0.5 | 3 | 1250 | ok |
| area 5×5×5 ×10 held corner | 34.9 / 38.4 | 0 | 0.3 | 4 | 521 | ok |
| Mega r8 interior | 32.6 / 36.2 | 0 | 3.0 | 3 | 1219 | ok |
| Mega r8 corner | 37.9 / 39.8 | 0 | 4.1 | 3 | 1315 | ok |
| Mega r8 chain ×4 interior | 38.0 / 41.8 | 0 | 5.5 | 4 | 3675 | ok |
| Mega r8 chain ×4 corner | 38.6 / 44.3 | 0 | 3.8 | 3 | 3738 | ok |

Mega r8 chain ×4 interior: detonation frames 16.8 / 16.8 / 16.8 / 16.8 ms
Mega r8 chain ×4 corner: detonation frames 16.8 / 16.8 / 16.8 / 16.7 ms

The remaining hitches came from the liquid scheduler, not chunk work: generated ocean at the world
edge read the outside as air and retried ~5 500 phantom flows every tick, and every liquid cell of
each arriving chunk was rescanned. Outside the map now reads as a wall, and `seedArrival` seeds only
cells that can act.

Open item: in some runs a single frame lands just over 50 ms with no long task behind it (so it is
render-side or garbage collection, not script work). It has shown up in the walk row in one run and
in the edit row in another, 0 or 1 per repetition, and is not yet attributed. After the fog change
(radii 6/7/8) the run gave: walk, fly, load and memory ok; edits work max 28 ms edge / 13 ms
interior, one such frame in 3 of 5 reps; memory 85 MB with 72 chunks mounted.

## Out of scope

Greedy meshing, lighting in the worker, vertical chunk sections, resolution changes (measured
to be irrelevant), and generator speed (3 % of a chunk's cost).
