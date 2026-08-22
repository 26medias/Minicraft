# Cloud Saves — Design

**Date:** 2026-08-21
**Status:** Draft (gate 1)
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
no realtime multi-device editing, no conflict-resolution UI beyond what §7
specifies.

**Never.** Nothing in this change deletes, rewrites, or migrates-in-place any
existing `localStorage` key. Legacy data is read-only to the migration path.

## Durability stance

Data loss is the only failure mode that matters, so durability is bought at
four independent layers:

1. **Write-through, not write-behind.** Every autosave writes to `localStorage`
   *and* to the cloud. The local write is the one that must not fail; the cloud
   write may fail and retry. A total API outage degrades the game to exactly
   today's behaviour rather than losing edits.
2. **Bucket object versioning.** Every overwrite and every delete leaves the
   prior generation recoverable from the GCS console. A bad client, a bad
   deploy, or a mis-click is undoable.
3. **The server never accepts a world it cannot parse.** A truncated or
   corrupt body is rejected with 4xx before it can overwrite a good object.
4. **Autosave retries.** The dirty flag survives a failed save (today it does
   not — see §8), so a transient network error does not silently drop edits.

## 1. Infrastructure

All of it in the existing personal GCP project **`qs-trading`**, which already
hosts `gs://noah.leap-forward.ca` (the static site) and several Gen2 Node
functions.

| Resource | Value |
|---|---|
| Bucket | `gs://minicraft-worlds`, region `us-central1`, uniform bucket-level access, **not public** |
| Versioning | ON. Lifecycle: delete noncurrent versions after 90 days, keep at least 10 newer versions |
| Function | `minicraft-api`, Gen2, `nodejs22`, region `us-central1`, `--allow-unauthenticated` |
| Memory / timeout | 512 MiB, 60 s, max-instances 3 (cost guard) |
| Service account | Default compute SA, granted `roles/storage.objectAdmin` **on the bucket only** |
| CORS | Allow `https://noah.leap-forward.ca` and `http://localhost:5173`; methods GET, PUT, DELETE, OPTIONS |

The bucket is private; the function is the only reader. This means a leaked
world URL is not a thing that exists — only the API is reachable.

### Repo layout

```
api/
  package.json          # own deps: @google-cloud/storage, zod, express
  src/index.ts          # functions-framework HTTP entry
  src/handlers.ts       # list/get/put/delete, storage client injected
  src/schema.ts         # zod schemas, shared shape with client
  src/handlers.test.ts  # vitest against an in-memory fake storage
  .gcloudignore
```

Root `package.json` gains:

- `deploy:api` — `gcloud functions deploy minicraft-api ... --source=api`
- `deploy:web` — `npm run build && gsutil -m rsync -r -d dist/ gs://noah.leap-forward.ca/minicraft/`

`deploy:web` is not strictly part of this feature, but the site is currently
deployed by hand with no script in the repo. Codifying it costs three lines and
removes the risk that a deploy forgets `--prebuild` (the atlas step) or the
`-d` flag.

## 2. HTTP API

Base: `https://minicraft-api-<hash>-uc.a.run.app` (recorded in `.env.production`
after first deploy).

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| GET | `/worlds` | — | 200 `WorldSummary[]` | 500 |
| GET | `/worlds/:id` | — | 200 `WorldSaveWire` | 400 bad id, 404 |
| PUT | `/worlds/:id` | `WorldSaveWire` | 200 `{updatedAt}` | 400 bad id/body, 413 too large, 500 |
| DELETE | `/worlds/:id` | — | 204 | 400 bad id, 404 |
| GET | `/health` | — | 200 `{ok:true}` | — |

Rules:

- `:id` must match `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`.
  Anything else is 400 before any storage call. This is also the path-traversal
  guard.
- Request body cap **4 MB** (worst-case world is ~1 MB of base64; 4 MB is
  generous headroom without allowing abuse). Enforced by
  `express.json({limit})` *and* by a `content-length` pre-check.
- Every response carries CORS headers, including on errors. `OPTIONS` is
  answered 204.
- Errors are `{error: string}` with a stable machine-readable `code` field.

### Storage layout

One object per world: `worlds/{uuid}.json`, content-type `application/json`,
`Cache-Control: no-store`.

**There is no index object.** `GET /worlds` uses a prefix listing and reads
each object's *custom metadata* — `name`, `seed`, `createdAt`, `updatedAt` —
set at PUT time. Listing metadata does not download object bodies, so the
listing is one API call regardless of world size.

This is the central structural decision. The alternative — a separate
`index.json` — makes every save two writes with no transaction between them,
which is a durability bug (an index that disagrees with reality is a world that
looks lost). Custom metadata keeps a save atomic: one object write, and the
listing derives from the objects themselves.

### Concurrency

`PUT` sends `If-Match: <generation>` when the client loaded a known generation,
via GCS `ifGenerationMatch`. A mismatch returns **409** with the current
`updatedAt`. The client's response to a 409 is in §7.

A first-write (client has no generation) uses `ifGenerationMatch: 0`, which
fails if the object already exists — so a UUID collision cannot silently
clobber.

## 3. Wire format and validation

`WorldSaveWire` is the existing `WorldSave` with chunks in their *encoded*
form — the client already encodes chunks for `localStorage`, so the same codec
serves the wire and nothing new is invented:

```ts
type WorldSaveWire = {
    version: 2;
    id: string;            // uuid
    seed: number;          // integer, no longer identity
    name: string;          // 1..64 chars
    createdAt: number;
    updatedAt: number;
    player: PlayerSave;
    chunks: { cx: number; cz: number; blocks: string; fluidMeta?: string }[];
    lights?: LightSave[];
};
```

The server validates with **zod** (already listed as an intended dependency in
`docs/specs.md` §3 and never added). Validation includes:

- structural shape and types,
- `id` in the body equals `:id` in the path,
- `cx`/`cz` within `0..31` (`WORLD_CHUNKS_X/Z`),
- chunk count `<= 1024`,
- `blocks` decodes to exactly `BLOCKS_PER_CHUNK` bytes — the server runs the
  real `decodeChunk` on every chunk and rejects the whole request if any chunk
  fails.

That last one is the load-bearing check: it makes it impossible for a
half-written or corrupted body to replace a good world. The codec is copied
into `api/src/` rather than imported across the project boundary (the function
deploys from `api/` alone); a test asserts the two copies agree on a fixture.

## 4. Client type changes

In `src/persistence/adapter.ts`:

```ts
type WorldSave = {
    version: 2;
    id: string;        // NEW — immutable identity
    seed: number;      // now just worldgen input
    ...
};

type WorldSummary = {
    id: string;                        // NEW
    seed: number; name: string; createdAt: number; updatedAt: number;
    origin: 'cloud' | 'local';         // NEW
    sizeBytes?: number;
};

interface PersistenceAdapter {
    loadWorld(id: string): Promise<WorldSave | null>;   // was (seed: number)
    saveWorld(save: WorldSave): Promise<void>;
    listWorlds(): Promise<WorldSummary[]>;
    deleteWorld(id: string): Promise<void>;
}
```

`MenuAction` becomes `{type:'continue'; id: string}` and
`{type:'new'; seed: number; name: string}` (a new world's id is minted by the
caller, not typed by the user).

Ids are generated with `crypto.randomUUID()`.

## 5. Adapters

Three implementations of the one interface:

**`LocalStorageAdapter`** — keeps the `minicraft:v1` key scheme untouched for
reading. New saves write a `minicraft:v2` scheme keyed by id
(`minicraft:v2:world:{id}:meta` / `:chunk:{cx}:{cz}`). `listWorlds()` scans
both namespaces: v2 keys yield their real id; v1 keys yield a synthetic
`legacy:{seed}` id and `origin:'local'`. `loadWorld` accepts either form. **v1
keys are never written to and never deleted.**

**`CloudAdapter`** — `fetch` against the API. Encodes/decodes chunks with the
same codec. Tracks the last-seen generation per world id for `If-Match`.
Distinct error vocabulary replacing the single `QUOTA_EXCEEDED` string:
`NETWORK`, `CONFLICT`, `TOO_LARGE`, `SERVER`, `NOT_FOUND`.

**`DualAdapter`** — the one the game actually uses. Composes the other two:

- `saveWorld`: write local first (must succeed), then cloud. Local failure
  behaves as today (quota warning). Cloud failure is reported to the caller as
  a *degraded* result, not an exception that loses the edit.
- `loadWorld`: cloud first; on network failure fall back to local; if the local
  copy is newer than the cloud copy by `updatedAt`, prefer local and mark the
  world as needing an upload.
- `listWorlds`: union of both, keyed by id. A world present in both is listed
  once with `origin:'cloud'`. Cloud unreachable → local-only list plus an
  offline flag the menu renders.
- `deleteWorld`: deletes from both. Legacy v1 worlds are exempt — see §6.

## 6. Legacy worlds

A v1 `localStorage` world appears in the menu under **"On this device"** with an
**"Upload to cloud"** button.

Uploading: read the v1 world, mint a fresh UUID, write it to the cloud and to
the v2 local namespace, then leave the v1 keys exactly where they are. The row
moves to the cloud section on the next render. The v1 copy remains as a cold
backup indefinitely; nothing in this feature ever removes it. If the user
deletes the *cloud* world later, the v1 keys are still there.

Auto-upload on first launch is deliberately **not** done. A silent bulk upload
on startup is a bulk-overwrite risk and hides failures; the button makes each
migration an observable, individually-recoverable act.

## 7. Autosave and save status

`AutoSave` (`src/persistence/autosave.ts`, currently 69 lines and **zero
tests**) is the riskiest code in this change, because it is where a network
call gets bolted onto logic that assumes saves are synchronous and infallible.
Its current defects, all of which lose data once saves go over a network:

- `flush()` clears `dirty` *before* awaiting the save. A failed save leaves the
  world dirty-but-unmarked; the edits are never retried.
- No in-flight guard: a blur during a slow save starts a second overlapping
  save.
- No retry, no backoff.
- No `pagehide`/`beforeunload`, so a tab close loses up to 5 s of edits, and an
  in-flight `fetch` is cancelled on unload.
- A single permanent `quotaHit` latch is the only failure state; any other
  error is rethrown into an unhandled rejection.

Changes:

- `dirty` is cleared only after a successful save; a failure re-arms it.
- An `inFlight` promise guard; a save requested during a save is coalesced into
  one follow-up save.
- Retry with backoff (1 s, 2 s, 4 s, 8 s, capped, jittered) for `NETWORK` and
  `SERVER`. `CONFLICT`, `TOO_LARGE` and quota do not retry blindly.
- `pagehide` and `visibilitychange` flush using `fetch(..., {keepalive: true})`
  so the request survives the unload.
- A `SaveStatus` callback drives a small HUD indicator: `saved` ✓,
  `saving…`, `local only` (cloud unreachable, retrying), `error`.

**409 conflict policy.** On a conflict the local copy is never discarded. The
client writes its version to a sibling object `worlds/{id}.conflict-{ts}.json`
(a plain PUT to a distinct id-shaped path is not possible, so this is a
dedicated `POST /worlds/:id/conflict` endpoint) and shows "this world was
changed elsewhere — your copy is saved as a backup". Choosing between them is a
manual act, not an automatic one. Given a single family, conflicts are expected
to be near-zero; the requirement is only that neither side is ever lost.

## 8. Menu changes

`src/ui/menu.ts` `renderHome()` currently awaits one `listWorlds()` and paints.
It needs:

- a loading state while the network call is in flight,
- two sections: **Worlds** (cloud) and **On this device** (legacy/local-only),
  with the second omitted when empty,
- an offline banner when the cloud list failed, with local worlds still
  playable,
- an "Upload to cloud" button per legacy row,
- delete confirmation text that names where the world will be deleted from.

`src/main.ts` passes the `DualAdapter` into `startGame`/`AutoSave` rather than
capturing a module-level `LocalStorageAdapter`, and routes `continue` by id.

Styles extend the existing `.world-row` rules in `src/ui/ui.css`.

## 9. Configuration

`VITE_MINICRAFT_API_URL` — the first client env var in the project. Read via
`import.meta.env`, set in a gitignored `.env.production`, with `.env.example`
committed. It is baked into the bundle and publicly readable; that is accepted,
since the API is unauthenticated by design.

If the var is absent at build time the client runs local-only, with the cloud
section replaced by a "cloud saves not configured" note. This keeps `npm run
dev` working for anyone without the URL, and makes a mis-built bundle degrade
instead of throwing.

## 10. Testing

**Server** (`api/src/handlers.test.ts`, vitest): an in-memory fake of the GCS
client. Round-trip PUT→GET; list returns metadata without fetching bodies; bad
uuid → 400; oversized body → 413; body whose `id` disagrees with the path →
400; a chunk with a corrupt `blocks` string → 400 **and the pre-existing object
is unchanged**; generation mismatch → 409; delete of a missing world → 404.

**Codec parity**: a fixture asserts `api/src/codec.ts` and
`src/persistence/codec.ts` produce identical output for the same input.

**Client**: `CloudAdapter` against a `fetch` stub, one test per error code.
`DualAdapter`: cloud down → local still written and the call reports degraded,
not throws; cloud newer → cloud wins; local newer → local wins and flags an
upload; list union dedupes by id. `LocalStorageAdapter`: v1 world still loads
(extend the existing legacy test at `localStorage.test.ts:147`), v1 keys
survive a v2 save of the same world, list merges both namespaces.

**AutoSave** (new file, the previously untested unit): with fake timers —
failed save keeps `dirty` set and retries; overlapping flushes coalesce;
backoff schedule; `pagehide` flushes; success clears status. Needs `window`/
`document` stubs since there is no jsdom env configured.

**Integration**: `api/scripts/smoke.ts` runs PUT→GET→LIST→DELETE against the
deployed URL and asserts the world is byte-identical on the way back.

**Manual**: load the live site, create a world, dig, confirm the object appears
in the bucket and the world reloads on a second device.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Anyone with the URL can delete every world | Object versioning + 90-day noncurrent retention makes any delete recoverable. Accepted by the owner. |
| Runaway cost from abuse | max-instances 3, 4 MB body cap, 60 s timeout. A budget alert on the project is recommended but out of scope. |
| Corrupt world overwrites a good one | Server decodes every chunk before writing; versioning keeps the prior generation. |
| Two devices edit the same world | `ifGenerationMatch` → 409 → loser's copy written to a conflict object; nothing is discarded. |
| A localStorage world is lost during migration | v1 keys are read-only; nothing in this change deletes them, ever. |
| Codec drift between client and server copies | Parity test on a shared fixture. |

## 12. Documentation

- New `docs/persistence.md` (the per-subsystem convention — `lighting.md`,
  `liquids.md`, `movement.md` exist; persistence does not).
- `docs/specs.md` §5, §7 and §9 updated: Phase 2 is a Cloud Function + GCS, not
  Cloud Run + Firestore; `zod` moves from "optional" to a real dependency.
- `CLAUDE.md`'s "pre-implementation / no package.json" section is factually
  wrong today and misleads agents. Corrected as part of this work.
