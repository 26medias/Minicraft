# World v2 — tall worlds (256 high)

Status: gate 1 closed 2026-09-20 (reviewers A + B incorporated). Branch `v2`.

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
  scheduler, loop (`flushDirtyChunks` frontier scan), player and TNT reads
  the chunk/world height instead. Acceptance is the explicit site list
  below, not a grep (a bare grep for 64 trips on hotbar/name limits).
- Player limits derive from height: `VOID_FLOOR_Y = -24` (unchanged),
  `SKY_CEILING_Y = height + 56`, ground search starts at `height - 1`. Spawn
  for a fresh world is the surface column at (256, 256) plus 2, found with the
  existing `groundAt` helper, not a hard-coded y = 60.
- Shadows (`shadows.ts`) get a required early-out. `computeChunkShadows`
  recomputes (not caches) the highest-opaque-y over the chunk and its 8
  neighbours from `blocks` at call time (shadowsDirty already gates the
  call, and an incrementally-maintained heightmap goes stale the moment a
  block is placed at y=250); a voxel above that maximum is sunlit without
  casting. Measured (gate 1): 1.47 M ray steps → 10.6 k at 256, wall
  465 ms → ~6 ms; and 71 ms → 2.4 ms on today's 64-high chunks, so this is
  a win for old worlds too, not a tall-only feature.
  Equivalence test: terrain-like fixtures (NOT uniformly random blocks — a
  random chunk has max height ≈ 255 and never triggers the early-out) plus
  a lone opaque block at y=200 placed in the NW neighbour chunk (the sun ray
  enters from nx / nz / nx-nz; MAX_SHADOW_DIST 32 reaches 14 in x, 8 in z)
  so an early-out that only consults its own chunk marks the shaded voxels
  at y 130..199 sunlit and goes red. Assert byte-identical `sunlit` vs the
  brute-force version at both heights.
- Lighting BFS (`lighting.ts` propagateSkylight :76, propagateBlockLight
  :214, removeAndReflood :354) replaces `queue.shift()` with a head-index
  cursor. Measured (gate 1): the skylight seed queue is 32 k entries at 256
  and V8's `shift` fast path dies between 8 k and 32 k — fillChunkLights
  goes 17 ms → 492 ms per chunk (516 ms per ensureChunk, ~1 s per frame
  while the 81-chunk view loads). Cursor queue: 2.4 ms. docs/lighting.md:147
  already predicted this. Test: fillChunkLights on an all-air 256 chunk
  completes in < 50 ms (red on shift, green on cursor).
- `player.ts:93` `Math.max(dy, 32)` spawn fallback becomes the `groundAt`
  result (or `height / 2`), not a literal.
- `tnt.ts` imports `inBounds` from coords; it must switch to `world.inBounds`.
  `raycast.ts`, `collision.ts` and `liquid-scheduler.ts` carry no height
  constant (they go through `world.getBlock` / `inBounds`) — no edit there.
- Baked-height sites the plan must cover, from gate 1: coords.ts:2,4,26;
  chunk.ts:20-22; lighting.ts:62,96,136,226,359,432,452; shadows.ts:19,93;
  mesher.ts:163,191,229,354,416,494; loop.ts:336; player.ts:18,25,66,71,88,93;
  tnt.ts:3,37,49; world.ts:39,46,69,86. Tests that import the deleted
  constants: coords.test.ts, generation.test.ts, lighting.test.ts,
  chunk.test.ts; tests with a literal 63 that still pass but encode the old
  height: world.test.ts:23, player.test.ts:97,184,235, raycast.test.ts:11 —
  those get a height-64 world explicitly so their meaning survives.
- Load-time honesty: meshChunk measured 15 ms → 27 ms at 256; the plan does
  not claim 60 fps while the initial view loads.
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
  block, id looked up by name; its catalog row must be unbreakable —
  hardness 0 / unminable — otherwise the kid digs into the void floor and
  the liquid scheduler tries to fall to y=-1). New reference-hash test at
  height 256.
- A world's `genVersion` is fixed at creation and stored in its meta. New
  worlds always get the newest version. Height and genVersion are separate
  fields: v1 = 64 only, v2 = 256 only, enforced by a single
  `worldProfile(genVersion) -> {height}` table.

## 4. Persistence: save format v3, additive

### Records
- `WorldSave.version: 2 | 3`. v3 adds `height: 64 | 256` and
  `genVersion: number`. A v2 record has neither; readers treat it as
  `{height: 64, genVersion: 1}`. **The stored `height` is authoritative for
  array sizes**; `genVersion` only selects the generator. The
  `worldProfile(genVersion) -> {height}` table is consulted **only at world
  creation**; it is never used to reinterpret a stored record.
- A world's save version is fixed for life: a record loaded as v2 is saved
  as v2 under v2 keys forever, a world created tall is v3. `World` carries
  `saveVersion`, `height`, `genVersion`; **`AutoSave.snapshot()`
  (autosave.ts:113-130, today hardcoded `version: 2`) reads all three from
  the World**, not from a summary. This is the only writer during play.
- `WorldSummary` gains `version: 2 | 3` and `height?: number` (absent on a
  degraded cloud row).

### Keys and routes
- localStorage v3: `minicraft:v3:world:{uuid}:meta` / `:chunk:{cx}:{cz}`.
  v2 keys are written exactly as today; v1 keys stay read-only.
- Cloud v3: objects under `worlds3/{uuid}`, routes `/v3/worlds*`.
- **Namespace discovery by id** (both legs, load and delete): probe v3
  first, then v2 (then v1 for local). A miss on every namespace is "absent".
  The summary's `version` is a hint only; adapters always probe.
- `listWorlds()` merges v3 and v2 (and adopted v1) on the local leg, and
  `/v3/worlds` **and** `/worlds` on the cloud leg. If either cloud list
  fails the leg is `degraded`, as today.

### Codec
- `encodeChunk(blocks, expectedLength)` and `decodeChunk(str,
  expectedLength)`; both throw on a length mismatch, and both throw if
  `expectedLength` is not a positive integer (today `new Uint16Array(NaN)`
  is silently length 0). The encode-side check is what makes a mis-heighted
  array fail *before* the local prune runs (localStorage.ts:127 encodes
  before the try block — do not reorder). RLE format unchanged.

### Fail-closed load policy (new, §10 has the tests)
- Applying a save into a World checks `rc.blocks.length === 16*height*16`
  for every chunk; any mismatch, any undecodable chunk or fluidMeta, or a
  v3 record missing `height`/`genVersion`, makes the load **throw**
  (`SaveCorrupt`). No partial apply.
- `DualAdapter.loadWorld`: if one leg's copy fails to parse, use the other
  leg's copy (and report the bad leg through `onStatus`); if both fail,
  throw. If the two copies disagree on `height` or `genVersion`, throw
  (`SaveMismatch`) — a cross-height fork is never wanted.
- `startGame(mode === 'continue')` **refuses to start** when `loadWorld`
  returns null or throws: the menu is shown again with a message ("Couldn't
  open <name> — nothing was changed"). Today (main.ts:116-119) it warns and
  proceeds on a fresh world, whose first autosave then prunes the local copy
  to zero chunks (probe: 9 chunk keys → 0, meta still listed).
- `new World(...)` is constructed **after** `loadWorld`, from the loaded
  record's `height`/`genVersion`; the summary's height is never used to size
  arrays.
- **Local shrink guard**, mirroring the API's (handlers.ts:323-336): a local
  save whose chunk set is smaller than half the stored set (when more than 4
  are stored) does not prune; it writes the incoming chunks, keeps the rest,
  and reports `local: 'error'`. `Chunk.modified` is sticky, so a legitimate
  save can never shrink.
- Per-chunk corruption on load (N1) follows the same rule: throw, fall back
  to the other leg, else refuse to open. No skip-and-continue, because the
  next autosave would prune the skipped chunk.

## 5. API (deployed with `./deploy.sh` before the site)

- New routes `/v3/worlds`, `/v3/worlds/:id` (GET / PUT / DELETE), same
  handler bodies parameterised by a **`.strict()`** v3 wire schema:
  `version: literal(3)`, `height: enum(64, 256)`, `genVersion: int >= 1`;
  chunk and fluidMeta lengths validated against `16 * height * 16`. Objects
  stored under `worlds3/`; `height` and `genVersion` are written into the
  object's custom metadata so the v3 list returns them.
- Old `/worlds*` routes are byte-for-byte unchanged (schema stays
  `z.literal(2)`, list stays `prefix: 'worlds/'` + the `^worlds\/` anchor).
- `/health` returns `{ok: true, codec: 3}`; `deploy.sh --verify` expects 3.
  No client code reads `/health`, so API-first rollout cannot break the old
  bundle; an API rollback would only fail `--verify`.
- `api/src/codec.parity.test.ts` is re-expressed with both codecs
  parameterised by length and asserted at 16384 and 65536.
- Same 32 MB cap, shrink guard, generation / If-Match concurrency.

## 6. Menu and start-up

- "New world" mints `genVersion` = newest, `height` from the profile,
  `saveVersion 3`. Old worlds list and continue unchanged; no label change.
- `startGame(id, seed, name, mode)`: on `new`, build the World from the
  profile; on `continue`, `loadWorld` first (fail closed as in §4), then
  build the World from the record. A degraded cloud row can still be
  continued, because the record, not the row, carries the height.

## 7. Tests (the instrument)

Every one of these must be shown red-then-green in the plan, and each is
chosen because it fails on the current code or on a plausibly wrong
implementation (gate 1 probed the tautological ones out).

1. Gen v1 reference hash: unchanged test, unchanged hash, importing through
   the `generateChunk(c, seed, 1)` dispatcher.
2. Gen v2 at 256: bedrock at y=0 in every column; surface in 114–130; a
   reference hash recorded once and never re-recorded.
3. Codec: `encodeChunk(65536-array, 65536)` round-trips (red today);
   `encodeChunk(16384-array, 65536)` throws; `decodeChunk(str, undefined)`
   and `(str, NaN)` throw.
4. localStorage: a committed v2 fixture loads as `{version 2, height 64,
   genVersion 1}` and saving it again writes only v2 keys; a v3 world
   round-trips under v3 keys; `listWorlds` returns both; `deleteWorld`
   removes exactly the right namespace for a v2 id and for a v3 id; **shrink
   guard**: with 9 chunks stored, a snapshot of 2 chunks leaves 9 keys and
   reports `local: 'error'` (red today: 9 → 2).
5. Autosave: `snapshot()` on a tall World yields `version 3, height 256`
   (red today).
6. Cloud adapter: `loadWorld(v3 id)` hits `/v3/worlds/:id`; `loadWorld(v2
   id)` falls through to `/worlds/:id`; `listWorlds` merges both prefixes
   (red today); a v3 body decodes with `height`.
7. Dual adapter: local copy unparseable + cloud good → cloud copy used;
   both bad → throws; height disagreement → throws.
8. Start-up: `continue` with a null load shows the menu with a message and
   writes nothing (red today: it starts a fresh world); applying a
   16384-chunk record into a 256 World throws before any chunk is written.
9. API: `/v3` PUT accepts a 256 world and rejects a 65536-length chunk
   claimed as height 64 and vice-versa; a v3 body missing `height` is
   refused (`.strict()`, red on `.extend()`); `/v3/worlds` list rows carry
   `height`; health = codec 3; parity at both lengths.
10. Engine at both heights, written so each can go red on a "forgot one
   site, still starts at 63" implementation:
   - lighting: all-air 256 chunk has sky 15 at y 255, 200, 64 AND 0 (y=0
     alone passes on the old code); then a full roof at y=200, fillChunkLights,
     remove one roof block via updateLightsForBlockChange, assert sky 15 at
     (x,150,z) — only that goes red if reSeedSkylightColumn (:452) stays at 63;
   - lighting perf: all-air 256 fillChunkLights < 50 ms;
   - shadows: equivalence fixture from §2 (terrain + lone block at y=200 in
     the NW neighbour);
   - raycast: from (x,140,z) looking down hits the v2 surface (~114-130),
     i.e. a hit with y >= 64;
   - liquid scheduler: a source at y=240 over air reaches the surface;
   - TNT at y=250 and y=1 removes the expected blocks without throwing;
   - player: clamp to height+56, ground search from height-1 finds a
     platform at y=200; spawn on a v2 world lands on the surface, not y=60;
   - mesher: a lone block at y=250 emits 6 faces.
11. Browser (localhost:5173, save API intercepted by a route stub that
   records PUT bodies): new world → fly to 250 and place a block → dig to
   bedrock and place a block → reload → both present; a seeded v2 fixture
   in localStorage opens, height 64, no v3 keys written; **clear
   localStorage, stub the v3 list/get to serve the tall world, continue it,
   and assert the first autosave PUT carries every chunk** (the B2/B4 chain).

## 8. Rollout

1. `./deploy.sh --verify` (API, expects codec 3) — additive, old clients
   unaffected because no client reads `/health` and old routes are frozen.
2. Merge `v2`, build, upload site per deploy notes.
Rollback: reverting the site alone restores the previous behaviour; tall
worlds become invisible until the site is redeployed. Rolling the API back
would only fail `--verify`.

## 9. Decisions taken (so reviewers don't relitigate)

- Flat columns with per-world height, not 16³ sections.
- New namespace + new routes rather than an optional `height` on v2.
- Old worlds never migrate, and a record never changes save version.
- Load fails closed: a world that cannot be fully parsed is not opened.
- Horizontal size unchanged.
