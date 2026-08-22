# Cloud Saves — Design

**Date:** 2026-08-21
**Status:** Revised after gate 1 (three reviewers: GCP/rigour, voxel-engine/save-format, adversarial data-loss)
**Branch:** `feat/cloud-saves`

## Problem

Worlds live only in `localStorage` on one device. A cleared cache, a browser
reset, or a new laptop loses them. The worlds are a seven-year-old's build
projects and are not reproducible. Losing one is the failure this whole design
exists to prevent.

Secondary: worlds cannot move between the desktop and the tablet.

## Goal and non-goals

**Goal.** Worlds are stored in a Google Cloud Storage bucket through a Google
Cloud Function. The game can list, load, save, and delete cloud worlds. Every
existing `localStorage` world stays loadable and can be pushed to the cloud.

**Non-goals.** No auth, no accounts, no permissions — anybody who has the API
URL can list, read, write, and delete any world. This is a deliberate choice by
the owner for a family-scale deployment. No world sharing UI, no options sync,
no realtime multi-device editing.

**Never.** Nothing in this change deletes, rewrites, or migrates-in-place any
existing `localStorage` v1 key. Legacy data is read-only to the migration path,
permanently.

## Durability stance

Data loss is the only failure mode that matters. Five independent layers, and
one rule that overrides every other consideration in this document:

> **No code path may discard a copy of a world that has edits the other copy
> lacks.** When two copies disagree and neither is provably derived from the
> other, both are kept and the user sees both. Arbitration never deletes.

1. **Local and cloud are independent legs.** Every autosave attempts both.
   Neither failing prevents the other. (Gate 1 killed the original
   "local must succeed first" ordering — see §7 B2.)
2. **Bucket object versioning.** Every overwrite and delete leaves the prior
   generation recoverable. *Verified*: delete → restore from noncurrent works
   and preserves custom metadata.
3. **The server never accepts a world it cannot parse**, and never accepts a
   suspicious shrink (§3).
4. **Autosave retries** and keeps the dirty flag until a save actually
   succeeds.
5. **Conflicts become visible worlds**, never silent overwrites (§7).

## What gate 1 verified against live infrastructure

These are settled facts, not assumptions. They were exercised against a
throwaway bucket in `qs-trading` (since deleted) and against the real
`@google-cloud/functions-framework@5.0.5` source:

- `ifGenerationMatch: 0` → 200 when absent, **412** when the object exists.
  Stale generation → **412**. The concurrency design is sound.
- **Custom object metadata is returned by a prefix listing without downloading
  bodies.** One Class A operation per 1000 objects. This is what makes the
  "no index object" decision correct.
- Metadata size is a non-issue: a 32 KiB value was accepted; unicode
  (`'Château 🏰 Noah'`) round-trips intact.
- `--allow-unauthenticated` is sufficient for Gen2 here; every existing Gen2
  function in this project already has `roles/run.invoker → allUsers`, so no
  org policy blocks it.
- **Cloud Functions gen2 max request size is 32 MB** (gen1 was 10 MB), max
  non-streaming response 32 MB. Confirmed against Google's published quotas.

## 1. Infrastructure

All in the existing personal GCP project **`qs-trading`**, which already hosts
`gs://noah.leap-forward.ca` (the static site) and several Gen2 Node functions.

| Resource | Value |
|---|---|
| Bucket | `gs://minicraft-worlds`, `us-central1`, uniform bucket-level access, **not public** |
| Versioning | ON, with the lifecycle rule below |
| Soft delete | ON (bucket-level), as a second net under versioning |
| Function | `minicraft-api`, Gen2, `nodejs22`, `us-central1`, `--allow-unauthenticated` |
| Memory / timeout | 512 MiB, 60 s, `--max-instances=3` (cost guard) |
| Service account | Default compute SA, `roles/storage.objectAdmin` **scoped to this bucket only** |

**Lifecycle — use exactly this JSON.** Conditions inside one rule are ANDed;
separate rules are ORed, and the OR form would delete the entire safety net
within a minute of play (ten autosaves is ~50 seconds).

```json
{"lifecycle":{"rule":[{"action":{"type":"Delete"},
  "condition":{"daysSinceNoncurrentTime":90,"numNewerVersions":10}}]}}
```

Note on the rule above: a *deleted* world's sole noncurrent version has zero
newer versions, so it can never satisfy `numNewerVersions: 10` and is therefore
**kept indefinitely**. That is the desired behaviour and it is why the two
conditions must live in one rule. Split into two rules, a deleted world's only
backup is purged at day 90 — and a seven-year-old's world can easily go
unopened that long.

**Never issue a generation-targeted delete.** Deleting a specific generation
destroys that version permanently, versioning notwithstanding. The handler uses
`ifGenerationMatch` as a *precondition* on a plain delete of the live object,
which leaves a recoverable noncurrent version. Nothing else holding
`objectAdmin` on this bucket may do otherwise.

CORS is **not** bucket configuration — the bucket is private and the browser
never talks to it directly. CORS is the function handler's job; see §2.

### Repo layout

```
api/
  package.json          # own deps: @google-cloud/storage, zod, express
  src/index.ts          # functions-framework HTTP entry
  src/handlers.ts       # list/get/put/delete, storage client injected
  src/codec.ts          # copy of the client codec (see §3)
  src/schema.ts         # zod schemas
  src/handlers.test.ts
  scripts/smoke.ts
  .gcloudignore
```

Root `package.json` gains `deploy:api` and `deploy:web` (the site is currently
deployed by hand with no script in the repo; codifying it removes the risk of a
deploy forgetting the atlas prebuild or `rsync -d`).

## 2. HTTP API

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| GET | `/worlds` | — | 200 `WorldSummary[]` | 500 |
| GET | `/worlds/:id` | — | 200 `WorldSaveWire` + `X-Generation` | 400, 404 |
| PUT | `/worlds/:id` | `WorldSaveWire` | 200 `{updatedAt, generation}` | 400, 409, 413, 500 |
| DELETE | `/worlds/:id` | — | 204 | 400, 404, 409 |
| GET | `/health` | — | 200 `{ok:true}` | — |

Rules:

- `:id` must match the UUID v4 pattern. Anything else is 400 before any
  storage call — this is also the path-traversal guard.
- **Body size cap: 32 MB**, enforced by a `content-length` check that is the
  **first statement in the handler**. `express.json({limit})` is a no-op here:
  functions-framework mounts its own body parsers at `limit: '1024mb'` *before*
  the user handler, and body-parser skips when `req.body` is already set. Any
  test asserting 413 must run through the functions-framework-mounted app, or
  it will pass in vitest and be wrong in production.
- CORS headers on **every** response including errors; `OPTIONS` → 204.
  functions-framework 5.0.5 contains no CORS handling whatsoever. Allowed
  origins: `https://noah.leap-forward.ca`, `http://localhost:5173`, and the
  LAN dev origin pattern. Methods: GET, PUT, DELETE, OPTIONS.
- Errors are `{error: string, code: string}` with a stable `code`.

### Why 32 MB and not 4 MB

Gate 1 measured the real codec over synthetic worlds. A full 32×32 world of
1024 modified chunks:

| Content | Per chunk | Total wire |
|---|---|---|
| Realistic heavily-played world | 988 B | **1.03 MB** |
| Periodic patterns / pixel art | 128 B | 0.13 MB |
| Aperiodic mixing, real ~19-block palette | 15,164 B | **15.56 MB** |
| Random over 256 ids (not reachable by this game) | 28,736 B | 29.50 MB |

The original 4 MB cap would have rejected any densely-built world above roughly
400 dense chunks — and `TOO_LARGE` was specified as non-retrying, so cloud
backup would have silently stopped for the largest and most-loved world. That
is precisely the failure this feature exists to prevent. 32 MB is the platform
ceiling and leaves 2× headroom over the realistic adversarial maximum.

**If a world ever does exceed 32 MB**, the client keeps saving locally and
raises a *persistent, non-dismissable* warning in the HUD. It must never fail
silently. This is a known, documented ceiling rather than a handled case.

### Storage layout

One object per world: `worlds/{uuid}.json`, `application/json`,
`Cache-Control: no-store`.

**No index object.** `GET /worlds` prefix-lists and reads each object's custom
metadata (`name`, `seed`, `createdAt`, `updatedAt`), plus `generation` and
`size` from the object itself. An index would make every save two writes with
no transaction between them — an index disagreeing with reality is a world that
looks lost.

`GET /worlds` filters to keys matching exactly `worlds/{uuid}.json`.

**A world whose metadata is missing or unparseable is never skipped.** It is
returned with a synthesized placeholder name (`Recovered world <short-id>`) and
a `degraded: true` flag the menu renders. Skipping it would make a real world
vanish from the menu — the exact "looks lost" failure the no-index design was
chosen to avoid.

### Concurrency

`PUT` sends `ifGenerationMatch`. Rules:

- Client has a cached generation for this id → send it.
- Client has none (first save after a page load, cache is in-memory) → the
  handler does a metadata-only `GET` for the current generation first, then
  PUTs with it. One extra call, once per world per session. **Never** send `0`
  for a world that may exist, and never omit the precondition — omitting it
  disables the protection silently.
- Genuinely new world → `ifGenerationMatch: 0`, so a UUID collision cannot
  clobber.

**412 does not mean conflict.** Retry-plus-precondition manufactures false
conflicts against your own committed write: a PUT commits, the response is lost
to flaky Wi-Fi, the client retries with a now-stale generation and gets 412
despite nothing having changed elsewhere. On 412 the client **re-GETs the
object and compares `updatedAt` to what it just attempted**. Equal → it was our
own write; adopt the new generation and report success. Different → a real
conflict, handled per §7.

`DELETE` accepts an optional generation and returns 409 on mismatch.

## 3. Wire format and validation

`WorldSaveWire` is `WorldSave` with chunks in their existing *encoded* form —
the client already encodes for `localStorage`, so nothing new is invented:

```ts
type WorldSaveWire = {
    version: 2;
    id: string;            // uuid
    seed: number;          // int32, MAY BE NEGATIVE (menu.ts:99 does `Number(x) | 0`)
    name: string;          // 1..64 chars
    createdAt: number;
    updatedAt: number;     // client wall clock, for DISPLAY only (see §5)
    player: PlayerSave;    // x/y/z/yaw/pitch are floats, may be negative, unclamped
    chunks: { cx: number; cz: number; blocks: string; fluidMeta?: string }[];
    lights?: LightSave[];
};
```

Server validation with **zod** (listed as intended in `docs/specs.md` §3 and
never added):

- structural shape; `id` in body equals `:id` in path,
- `cx`/`cz` within `0..31`; chunk count `0..1024`; **no duplicate `(cx,cz)`**,
- `blocks` decodes via the real `decodeChunk` to exactly `BLOCKS_PER_CHUNK`
  bytes,
- **`fluidMeta`, when present, decodes via the real `decodeFluidMeta`**, and
  every index is `< 16384`. `decodeFluidMeta` has no bounds check today: a
  corrupt string can throw at *load* time on the client (world unloadable, the
  server having happily stored it) or run `readVarInt` past the buffer and
  produce NaN keys.
- Do **not** clamp player coordinates to world bounds, do not reject negative
  seeds, do not cap the hotbar at 9 (it is pool-derived, currently ~19).

**Shrink guard.** Reject a PUT whose chunk count is under 50% of the stored
object's when the stored object has more than 4 chunks. Whole-world replacement
is only safe because `main.ts:82` sets `c.modified = true` on every loaded
chunk — an unguarded invariant living in a UI file that the cloud now depends
on. Without this guard a structurally perfect world with 0 chunks passes every
other check and truncates the stored world.

The codec is copied into `api/src/` rather than imported across the project
boundary (the function deploys from `api/` alone); a parity test asserts both
copies produce identical output for a shared fixture.

## 4. Client type changes

```ts
type WorldSave = {
    version: 2;
    id: string;        // NEW — immutable identity, minted with crypto.randomUUID()
    seed: number;      // now just worldgen input
    ...
};

type WorldSummary = {
    id: string; seed: number; name: string; createdAt: number; updatedAt: number;
    origin: 'cloud' | 'local';   // NEW
    sizeBytes?: number;          // populated from the GCS object size
    degraded?: boolean;          // metadata unreadable; see §2
};

interface PersistenceAdapter {
    loadWorld(id: string): Promise<WorldSave | null>;   // was (seed: number)
    saveWorld(save: WorldSave): Promise<SaveResult>;    // was Promise<void>
    listWorlds(): Promise<WorldSummary[]>;
    deleteWorld(id: string): Promise<void>;
}

type SaveResult = { local: 'ok' | 'quota' | 'error'; cloud: 'ok' | 'failed' | 'skipped' };
```

`MenuAction` becomes `{type:'continue'; id: string}`; a new world's id is minted
by the caller, never typed by the user.

`crypto.randomUUID()` **requires a secure context**. It is `undefined` on
`http://192.168.x.x:5173` — exactly how a tablet reaches the LAN dev server.
A fallback UUID v4 generator is required.

## 5. Adapters

**`LocalStorageAdapter`** — reads the `minicraft:v1` scheme unchanged. New saves
use `minicraft:v2:world:{id}:...`. `listWorlds()` scans both: v2 keys yield
their real id, v1 keys yield a synthetic `legacy:{seed}` id. **v1 keys are never
written to and never deleted.**

**Write order must be inverted: chunks first, meta last.** Today `saveWorld`
writes meta first (`localStorage.ts:53`) and then the chunks. Gate 1
demonstrated the consequence with a red test: when quota hits partway through
the chunk loop, storage is left holding a **new** meta — with a fresh
`updatedAt` — over a mix of old and new chunks. Every individual chunk still
decodes, so the server's per-chunk validation passes, and the newer timestamp
means arbitration prefers this Frankenstein world and uploads it over the good
cloud copy. Writing meta last means an interrupted save leaves the *old*
`updatedAt`, so the cloud copy wins and the torn state is inert. This is the
cheapest fix in the whole design and it closes the worst corruption path.

Migration makes this likely rather than exotic: §6 keeps the v1 copy forever
*and* writes a v2 copy, roughly doubling the local footprint, so
quota-mid-save becomes a common event rather than a rare one.

**Local pruning.** `saveWorld` deletes any stored chunk key not present in the
incoming set (`localStorage.ts:54-60`). Whole-world replacement is only safe
because `main.ts:82` marks every loaded chunk modified. A cloud-loaded world
that does not fully repopulate `modifiedChunks()` before the first flush would
have its local chunks pruned. This needs an explicit regression test, not just
an invariant.

`loadWorld` **normalizes on read**: it currently spreads stored meta
(`{...meta, chunks}`), so a v1 world would carry `version: 1` and
`id: undefined` at runtime despite the v2 type. It must stamp `{version: 2, id}`
before returning, or the §6 upload ships an id-less body that fails zod.

**`CloudAdapter`** — `fetch` against the API, same codec. Caches the last-seen
generation per id, populated on load. Error vocabulary replacing the single
`QUOTA_EXCEEDED` string: `NETWORK`, `CONFLICT`, `TOO_LARGE`, `SERVER`,
`NOT_FOUND`.

**`DualAdapter`** — what the game uses.

- `saveWorld`: **local and cloud are independent.** Both are attempted; neither
  short-circuits the other; the result reports each leg. Only both failing is
  an error. A world with a `legacy:` id **skips the cloud leg entirely** —
  otherwise it PUTs a non-UUID id and 400s every 5 seconds forever.
- Encode chunks **once** and share between legs. The interface exchanges
  decoded `RawChunk` and each adapter encodes internally, so a naive
  composition encodes the whole world twice per save — 137 ms measured on
  desktop Node for a full world, expect 3–5× that on a tablet, i.e. a visible
  hitch every 5 seconds.
- `loadWorld`: **never discards.** Fetch both copies' metadata. If one is
  provably the ancestor of the other (same id, and the local copy's recorded
  `lastSyncedGeneration` equals the cloud generation), take the newer. If they
  diverge, load the cloud copy **and first write the local copy to the cloud as
  a new, visible world** named `<name> (copy from this device)`. Both survive
  and both are clickable.
- Ordering uses the GCS **`generation`** (server-assigned, monotonic) wherever
  one exists. `updatedAt` is a client wall clock and is used for display only —
  a tablet with a drifted clock must never win or lose an arbitration.
- **The generation used for `If-Match` is the one the world was LOADED from,
  and is never refreshed by a comparison fetch.** This is the silent-overwrite
  hinge: `loadWorld` fetches the cloud copy in order to compare it, and if that
  fetch were allowed to refresh the cached generation, a stale local copy would
  then upload with a *matching* precondition — no 412, no conflict, a month of
  building gone. The cached generation advances only on a successful PUT, or on
  a load that actually adopted the cloud copy.
- **Cloud 404 with a local v2 copy present → load the local copy** and mark it
  for upload. Returning null would make the world invisible, the kid would
  create a new one, and the old one is effectively lost. A 404 is not an
  absence of data when a local copy exists.
- Delete-resurrection is accepted: if device A deletes a world and device B
  still holds a local copy, B re-uploads it. Resurrecting a world is the safe
  direction of that error.
- `listWorlds`: union keyed by id; present in both → listed once as `cloud`.
  Cloud unreachable → local list plus an offline flag.
- `deleteWorld`: cloud first. Only on success delete the v2 local copy. Cloud
  delete failure aborts the whole operation, leaving both copies. Legacy v1
  keys are never touched. Cloud deletes remain recoverable via versioning.

## 6. Legacy worlds

A v1 world appears under **"On this device"** with an **"Upload to cloud"**
button. Uploading mints a fresh UUID, writes cloud + v2-local, and leaves the
v1 keys exactly where they are, forever, as a cold backup. Re-uploading the
same legacy world is idempotent: the minted UUID is recorded in a
`minicraft:v2:legacy-map:{seed}` key, so a second press updates the existing
cloud world rather than creating a divergent copy.

No auto-upload on launch. A silent bulk upload is a bulk-overwrite risk and
hides failures; the button makes each migration observable and individually
recoverable.

## 7. Autosave

`src/persistence/autosave.ts` is 69 lines with **zero tests** and is the
riskiest code in this change. Gate 1 confirmed a data-loss bug that exists
**today, before any cloud work**:

> **`markDirty()` is called from only three places** (`src/main.ts:172`, `:236`,
> `:276` — light picker, block broken, block placed). **TNT detonation and
> liquid spread mutate chunks without arming autosave.** `detonateAt`
> (`src/game/loop.ts:221`) and `setBlockFlow` (`src/engine/world/world.ts:68`)
> set `chunk.modified` but never notify `AutoSave`. A kid who ignites TNT or
> pours water, watches it resolve, and closes the tab loses the crater or the
> spread. `world.modifiedChunks()` itself is complete — the gap is purely the
> trigger.

Fix: an `onWorldMutated` callback on `GameLoop`, wired to `markDirty`, invoked
from `detonateAt` and from the liquid tick when it changed anything.

Other defects, all of which lose data once saves cross a network:

- `flush()` clears `dirty` **before** awaiting. A failed save leaves the world
  dirty-but-unmarked and the edits are never retried. → Clear only on success;
  failure re-arms.
- No in-flight guard; a blur during a slow save starts an overlapping save. →
  An `inFlight` promise; a save requested during a save coalesces into one
  follow-up.
- No retry. → Backoff (1/2/4/8 s, jittered, capped) for `NETWORK` and `SERVER`.
  `CONFLICT` and `TOO_LARGE` do not retry blindly.
- **The permanent `quotaHit` latch is removed.** Today one
  `QuotaExceededError` disables `markDirty()` and `flush()` for the rest of the
  session — and under the original write-through ordering that would have
  disabled *cloud* saving too, at exactly the moment worlds got big enough to
  need it. Quota becomes a per-attempt local-leg failure that never touches the
  cloud leg.

**Unload handling.** There is no `pagehide` handler today, and the obvious fix
does not work: `fetch(..., {keepalive: true})` and `sendBeacon` both cap request
bodies at **64 KiB** (a shared in-flight budget; over it the request rejects
synchronously with a `TypeError` indistinguishable from a network error). A
real world is 200 KB–1 MB, 3–16× over. So:

- On `pagehide`/`visibilitychange`, do the **localStorage** write only — it is
  synchronous and always completes.
- Record a `needsUpload` flag for that world.
- Reconcile on next launch via the §5 load path, which uploads a local copy the
  cloud lacks.

**Save cadence.** Local flushes on the existing 5 s debounce. The **cloud leg
debounces at 30 s** (plus blur). At 5 s with versioning on, an hour of play on a
1 MB world generates ~700 MB of noncurrent versions per day; 30 s cuts that 6×
and cuts tablet uplink pressure, while the local leg keeps the 5 s safety net.

**Conflicts are visible worlds, not backup files.** The original design had a
`POST /worlds/:id/conflict` endpoint writing to `worlds/{id}.conflict-{ts}.json`.
Gate 1 verified those objects appear in the `worlds/` prefix listing as phantom
worlds with undefined names and NaN dates; the endpoint was also absent from the
route table and blocked by the CORS method list. And a backup nobody can open
without a `gsutil` prompt is not a recovery story for a seven-year-old. The
endpoint is **dropped**. A losing copy is written with `PUT /worlds/{newUuid}`
as an ordinary world named `<name> (copy from <device>)` — same durability, no
new surface, and the kid can click it.

A `SaveStatus` callback drives a HUD indicator: `saved` ✓ / `saving…` /
`local only` (cloud unreachable, retrying) / `error`.

## 8. Menu changes

`renderHome()` currently awaits one `listWorlds()` and paints. It needs a
loading state; two sections (**Worlds** = cloud, **On this device** = legacy /
local-only, omitted when empty); an offline banner with local worlds still
playable; an "Upload to cloud" button per legacy row (disabled while in
flight); delete confirmation that names where the world will be deleted from;
and rendering for `degraded` rows.

The delete handler currently has **no `try`/`catch`** — once `deleteWorld` can
throw on a network failure, that is an unhandled rejection plus a UI that
re-renders as though the delete succeeded. Delete must surface failure and
leave the row in place.

`src/main.ts` passes the `DualAdapter` into `startGame`/`AutoSave` instead of
capturing a module-level `LocalStorageAdapter`, and routes `continue` by id.

## 9. Configuration

`VITE_MINICRAFT_API_URL` — the project's first client env var. Gitignored
`.env.production`, committed `.env.example`. It is baked into the bundle and
publicly readable; accepted, since the API is unauthenticated by design.

Absent at build time → the client runs local-only with a "cloud saves not
configured" note, so `npm run dev` works without the URL and a mis-built bundle
degrades instead of throwing.

## 10. Testing

**Server** (in-memory fake GCS client): PUT→GET round-trip; list returns
metadata without fetching bodies; bad uuid → 400; body `id` ≠ path `id` → 400;
corrupt `blocks` → 400 **and the stored object is unchanged**; corrupt
`fluidMeta` → 400; duplicate `(cx,cz)` → 400; shrink guard → 400; generation
mismatch → 409; delete of a missing world → 404; **oversized body → 413 run
through the functions-framework-mounted app**, not a bare express app.

**Codec parity**: fixture asserting `api/src/codec.ts` and
`src/persistence/codec.ts` agree.

**Client**: `CloudAdapter` per error code against a fetch stub; the 412
false-conflict path (same `updatedAt` → adopt generation, report success).
`DualAdapter`: cloud down → local still written and the result reports
degraded, not throws; local quota → cloud still written; `legacy:` id → cloud
skipped; divergent copies → both survive; list union dedupes by id.
`LocalStorageAdapter`: v1 world still loads (extend the existing legacy test at
`localStorage.test.ts:147`), v1 keys survive a v2 save, list merges both
namespaces, load normalizes v1 → `{version:2, id}`.

**Sequencing requirement.** The `AutoSave` test file must land and pass
**before** `CloudAdapter` is wired in. `AutoSave` is the one component with
zero existing coverage, and this change is what makes every save fallible;
wiring the network in first means debugging a retry state machine with no
safety net. A test that the `inFlight` coalescing does not itself drop the
follow-up save is required — that is the classic bug in the fix.

**AutoSave** (new file, previously untested): failed save keeps `dirty` and
retries; overlapping flushes coalesce; backoff schedule; quota on local does
not disable cloud; `pagehide` writes locally and sets `needsUpload`; TNT and
liquid mutation arm `markDirty`.

**Torn-save regression** (the B1 corruption path): simulate quota partway
through the chunk loop and assert the stored `updatedAt` is still the *old*
one, so arbitration cannot prefer the torn copy. Also assert a cloud-loaded
world repopulates `modifiedChunks()` before the first flush, so local pruning
cannot delete chunks.

**Integration** (`api/scripts/smoke.ts`, against the deployed URL):
PUT→GET→LIST→DELETE with a byte-identical round-trip assertion; one world with
an emoji name; one near-maximum-size PUT to confirm a large body fits the
60 s / 512 MiB envelope.

**Manual**: live site, create a world, dig, confirm the object appears in the
bucket and the world reloads on a second device.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Anyone with the URL can delete every world | Versioning + 90-day noncurrent retention makes deletes recoverable. Accepted by the owner. |
| Runaway cost from abuse | `max-instances=3`, 32 MB cap, 60 s timeout. **A project budget alert is required, not optional** — an open API with unbounded world creation has no other cost ceiling. |
| A flood of valid PUTs buries the good version | Under the single ANDed lifecycle rule the buried versions survive 90 days, so the detection window is 90 days. Stated here so it is a known window rather than a surprise. |
| A torn local save is uploaded over a good cloud copy | Meta written last, so an interrupted save keeps the old `updatedAt` and loses arbitration. |
| Version storage growth | 30 s cloud debounce + the single ANDed lifecycle rule. |
| Corrupt world overwrites a good one | Server decodes every chunk and every fluidMeta; shrink guard; versioning. |
| Two devices edit one world | `ifGenerationMatch` → 412 → self-write check → real conflicts become a second visible world. |
| A localStorage world lost during migration | v1 keys are read-only; nothing in this change ever deletes them. |
| Codec drift between the two copies | Parity test. |
| A world exceeds the 32 MB platform ceiling | Local saves continue; persistent HUD warning. Documented limit, not a handled case. |

## 12. Documentation

- New `docs/persistence.md` (per-subsystem convention: `lighting.md`,
  `liquids.md`, `movement.md` exist; persistence does not).
- `docs/specs.md` §5/§7/§9 updated: Phase 2 is Cloud Function + GCS, not Cloud
  Run + Firestore; `zod` becomes a real dependency.
- `CLAUDE.md`'s "pre-implementation / no package.json / no source code"
  section is factually wrong and actively misleads agents. Corrected.
- `README.md`'s stale test count (says 148; actual 178).
