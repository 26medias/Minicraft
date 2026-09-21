# World v2 — tall worlds (256 high)

Status: draft for gate 1, 2026-09-20. Branch `v2`.

## 1. Goal

New worlds are 256 blocks tall (surface ≈ 120, bedrock at 0) instead of 64, so
there is room to dig and room to build. Horizontal size stays 512 × 512.

**Existing saved worlds are untouched, forever.** They stay 64 tall, keep their
current generator byte for byte, keep their storage keys and API routes, and a
stale cached bundle must never be able to open a tall world. No migration, no
"upgrade" button.

Caves, ores, trees, chunk eviction, worker meshing and vertical sections are
out of scope (worldgen rules are a separate anviled project; performance is
last on the roadmap).

## 2. Engine: per-world height

- `CHUNK_SIZE_Y` and `BLOCKS_PER_CHUNK` constants are removed from
  `src/engine/world/coords.ts`. `World` gets `readonly height: 64 | 256` and
  `Chunk` gets `readonly height` (set from the world); array lengths are
  `16 * height * 16`.
- `indexOf(x, y, z) = y*256 + z*16 + x` is height-independent and stays.
  `inBounds` becomes `World.inBounds` (or takes `height`), every `y < 64`,
  `63`, `CHUNK_SIZE_Y` loop bound in mesher, lighting, shadows, liquid
  scheduler, loop (`flushDirtyChunks` frontier scan), player, TNT and raycast
  reads the chunk/world height instead. `grep -rn "CHUNK_SIZE_Y\|\b6[34]\b"
  src --include=*.ts` must come back empty of height meanings when done.
- Player limits derive from height: `VOID_FLOOR_Y = -24` (unchanged),
  `SKY_CEILING_Y = height + 56`, ground search starts at `height - 1`. Spawn
  for a fresh world is the surface column at (256, 256) plus 2, found with the
  existing `groundAt` helper, not a hard-coded y = 60.
- Shadows (`shadows.ts`) get a required early-out: a chunk-column heightmap
  (`highest opaque y` per (x,z)) is kept per chunk; a voxel whose y is above
  the max heightmap value of the chunk and its 8 neighbours is sunlit without
  casting. Without this a 256-high chunk costs ~2 M ray steps; with it the
  empty sky is free. A test asserts identical `sunlit` output against the
  brute-force version on random chunks at both heights.
- Memory: a loaded 256-column is ~320 KB (blocks Uint16 128 KB, lights
  128 KB, sunlit 64 KB). 81 loaded ≈ 26 MB. A fully explored map ≈ 320 MB
  because chunks are never evicted; accepted for the GPU desktop, eviction
  stays in the performance project.

## 3. Generation: versioned per world

- `generateChunk(chunk, seed, genVersion)`. `genVersion 1` is the current
  `generation.ts` body, moved verbatim to `generation.v1.ts`; the existing
  reference-hash determinism test keeps guarding it and must not change.
- `genVersion 2` (tall placeholder, until the worldgen project ships v3):
  same 2-D simplex terrain, `SEA_LEVEL = 120`, height band 114–130, grass /
  sand / 3 dirt / stone, water to sea level, `bedrock` at y = 0 (catalog
  block, id looked up by name). New reference-hash test at height 256.
- A world's `genVersion` is fixed at creation and stored in its meta. New
  worlds always get the newest version. Height and genVersion are separate
  fields: v1 = 64 only, v2 = 256 only, enforced by a single
  `worldProfile(genVersion) -> {height}` table.

## 4. Persistence: save format v3, additive

- `WorldSave.version: 2 | 3`. v3 adds `height: 64 | 256` and
  `genVersion: number`. A v2 save has neither; readers treat it as
  `{height: 64, genVersion: 1}`.
- localStorage keys for tall worlds: `minicraft:v3:world:{uuid}:meta` and
  `:chunk:{cx}:{cz}`. v2 worlds keep writing v2 keys, exactly as today; the
  v2 code path is not edited except to pass `height` into the codec. v1 keys
  stay read-only.
- `encodeChunk(blocks)` / `decodeChunk(str, expectedLength)`: the length
  check becomes a parameter; RLE format unchanged.
- `listWorlds()` merges v2 and v3 namespaces; `WorldSummary` gains `height`.
  `deleteWorld` deletes from whichever namespace holds the id.
- Dual adapter: unchanged logic, routes each world to the leg/namespace by
  `version`.

## 5. API (deployed with `./deploy.sh` before the site)

- New routes `/v3/worlds`, `/v3/worlds/:id` (GET / PUT / DELETE), same
  handlers parameterised by a wire schema with `version: literal(3)`,
  `height: enum(64, 256)`, `genVersion: int >= 1`; chunk and fluidMeta length
  validated against `16 * height * 16`. Objects stored under `worlds3/`.
- Old `/worlds*` routes are byte-for-byte unchanged and list only `worlds/`,
  so a stale bundle never sees a tall world.
- `/health` returns `{ok: true, codec: 3}`; `deploy.sh --verify` expects
  that. Same 32 MB body cap, same shrink guard, same generation/If-Match
  concurrency.
- The cloud adapter picks the route prefix from `save.version`.

## 6. Menu

- "New world" mints a tall world (`genVersion` newest, `height` from the
  profile). Old worlds list and continue unchanged; the list label appends
  nothing (a 64-high world is still just his world).
- `startGame(id, seed, name, mode)` becomes `startGame(id, seed, name, mode,
  profile)` where profile comes from the summary on continue and from the
  newest version on new. `new World(seed, height, genVersion)`.

## 7. Tests (the instrument)

Every one of these must be shown red-then-green in the plan.

1. Gen v1 reference hash: unchanged test, unchanged hash.
2. Gen v2 reference hash at 256; bedrock at y=0 for every column; surface in
   114–130.
3. Codec: round-trip at 16384 and 65536; decode with the wrong expected
   length throws.
4. localStorage adapter: a committed v2 fixture loads with height 64 and
   genVersion 1 and its keys are not rewritten (assert the storage map is
   identical after load + save of an unmodified world); a v3 world round-trips
   under v3 keys; `listWorlds` returns both.
5. API: `/v3` PUT accepts a 256 world and rejects a 65536-length chunk
   claimed as height 64 and vice-versa; old `/worlds` PUT rejects
   `version: 3`; old `/worlds` list omits worlds3 objects; health = codec 3.
6. Engine at both heights: mesher, lighting (skylight reaches y=0 through an
   air column of 256), shadows early-out equivalence, liquid scheduler
   falling 200 blocks, TNT near y=250 and y=1, raycast to bedrock, player
   clamp and ground search.
7. Browser (localhost:5173, save API blocked by a route intercept): new
   world → fly to 250 and place a block → dig to bedrock and place a block →
   reload → both blocks present; then open a seeded v2 fixture from
   localStorage → renders, height 64, no v3 keys written.

## 8. Rollout

1. `./deploy.sh` (API) — additive, old clients unaffected.
2. Merge `v2`, build, upload site per deploy notes.
Rollback: old routes and namespaces never changed, so reverting the site
alone restores the previous behaviour; tall worlds simply become invisible
until the site is redeployed.

## 9. Decisions taken (so reviewers don't relitigate)

- Flat columns with per-world height, not 16³ sections.
- New namespace + new routes rather than an optional `height` on v2.
- Old worlds never migrate.
- Horizontal size unchanged.
