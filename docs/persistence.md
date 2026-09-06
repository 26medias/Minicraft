# Persistence

Worlds are stored in two places at once: this browser's `localStorage`, and a
Google Cloud Storage bucket behind an unauthenticated Cloud Function. The point
of the whole subsystem is that **a world is never lost**, so the rules below are
stricter than the feature itself would otherwise need.

## The one rule

> **No code path may discard a copy of a world that has edits the other copy
> lacks.** When two copies disagree and neither is provably derived from the
> other, both are kept and the user sees both. Arbitration never deletes.

## Durability layers

1. **Independent legs.** Every autosave attempts localStorage *and* the cloud.
   Neither failing prevents the other. A full localStorage does not block the
   cloud write; a cloud outage degrades to exactly the old local-only behaviour.
2. **Object versioning + 90-day soft delete** on the bucket, so an overwrite or
   a delete — including one from the open API — is recoverable.
3. **The server never stores a world it cannot parse.** Every chunk and every
   `fluidMeta` is decoded before the write, and a suspicious shrink is refused.
4. **Autosave retries.** The dirty flag survives a failed save, and an edit made
   *during* a save keeps its flag because the snapshot does not contain it.
5. **v1 world keys are read-only, forever.** Nothing in this subsystem writes or
   deletes a `minicraft:v1:world:*` key. (Options and the play-time limit are
   separate subsystems with their own `minicraft:v1:options` and
   `minicraft:v1:playtime` keys, which they do write.)

## Storage formats

### v1 (legacy, read-only)

```
minicraft:v1:world:{seed}:meta
minicraft:v1:world:{seed}:chunk:{cx}:{cz}
```

Identity was the *seed* — a user-typed six-digit number, so two worlds with the
same seed overwrote each other. Chunk values are either `{blocks, fluidMeta?}`
JSON or, for pre-Task-6 saves, a bare base64 blocks string. Both still load.

### v2 (current)

```
minicraft:v2:world:{uuid}:meta
minicraft:v2:world:{uuid}:chunk:{cx}:{cz}
minicraft:v2:legacy-map:{seed}   -> uuid this legacy world was adopted under
```

Identity is an immutable uuid; the seed is worldgen input only. The meta record
also carries `lastSyncedGeneration`, the GCS generation this local copy matches.

**Meta is written last.** A save interrupted by a quota error leaves a mix of
old and new chunks. Every chunk still decodes individually, so nothing downstream
can tell it is torn — but written last, the meta keeps the *previous*
`updatedAt`, and the torn copy loses any comparison against a good one.

### Legacy adoption

A v1 world is adopted under a fresh uuid the first time it is played, recorded in
`legacy-map`. Writing v2 records under a `legacy:{seed}` id would make both
namespaces yield the same id on the next launch: the v1 copy would win the load,
and the prune sweep would then delete the newer session's chunks. Adoption is
recorded *before* the first load, so `loadWorld` falls back to the v1 record when
the v2 one does not exist yet.

The v1 keys stay where they are, permanently, as a cold backup.

## Adapters

All three implement one interface (`src/persistence/adapter.ts`).

| Adapter | Role |
|---|---|
| `LocalStorageAdapter` | Both namespaces. Also `saveLocalSync` for the unload path. |
| `CloudAdapter` | `fetch` against the API; owns generation preconditions. |
| `DualAdapter` | What the game uses. Composes the other two. |

`DualAdapter` encodes chunks **once** and passes them to both legs — the
interface exchanges decoded chunks, so a naive composition would encode the whole
world twice per save (~137 ms per pass on desktop, several times that on a
tablet).

## Concurrency

Every PUT carries a precondition; the server rejects one that does not (428).

- The generation sent is **the one the world was loaded from**, never one
  refreshed by a comparison fetch. Refreshing it would let a stale copy upload
  with a matching precondition and silently overwrite another device.
- A world loaded offline is *unsynced* and sends `If-None-Match: *` rather than
  adopting a generation it never saw.
- **A 409 is not automatically a conflict.** A committed PUT whose response was
  lost looks identical to one on retry, so the client re-reads: a matching
  `updatedAt` means the write was ours.
- A genuine divergence forks the local copy into an ordinary, visible world named
  `<name> (copy from this device)`. After a successful save the local copy is
  stamped with the cloud's generation — without that, every subsequent load reads
  as a divergence and the menu fills with duplicates.

Ordering uses the GCS generation, never `Date.now()`: a tablet with a drifted
clock must not win or lose an arbitration. `updatedAt` is for display.

## Save cadence

- **Local: 5 s** debounce, plus `blur` and `visibilitychange`.
- **Cloud: 30 s.** Not a storage-cost decision (versions are pennies) — it is
  tablet uplink. A 1 MB world at 5 s needs a sustained ~1.6 Mbps; at 30 s it
  needs ~267 kbps.
- **`pagehide` writes locally and synchronously**, then flags the world for
  upload. An awaited write during teardown is a dropped continuation.
  `fetch(keepalive)` and `sendBeacon` are *not* usable here: both cap bodies at
  64 KiB and a world is 3–16× that.

Autosave is armed by block place/break, the light picker, **and** `onWorldMutated`
— TNT detonation and liquid spread mutate chunks directly, and before that hook
existed a crater or a water spread was lost on tab close.

## API

`https://minicraft-api-uv67ojrpvq-uc.a.run.app` — GCP project `qs-trading`,
region `us-central1`, bucket `gs://minicraft-worlds`. No auth by design.

| Method | Path | Notes |
|---|---|---|
| GET | `/worlds` | Derived from GCS custom metadata; no bodies downloaded |
| GET | `/worlds/:id` | Returns the world plus its generation |
| PUT | `/worlds/:id` | Requires `If-Match` or `If-None-Match: *` |
| DELETE | `/worlds/:id` | Plain delete — leaves a recoverable version |
| GET | `/health` | Liveness |

One object per world at `worlds/{uuid}.json`. **There is no index object**: an
index would make every save two writes with no transaction between them, and an
index disagreeing with reality is a world that looks lost. A world whose metadata
is unreadable is listed as `degraded`, never skipped, for the same reason.

**Never issue a generation-targeted delete** — that destroys the version
permanently. Use `ifGenerationMatch` as a precondition on a plain delete.

## Size

Only modified chunks are stored. Measured with the real codec over a full
32×32 world:

| Content | Total wire size |
|---|---|
| Realistic heavily-played world | 1.03 MB |
| Aperiodic building, real block palette | 15.6 MB |

The cap is **32 MB**, the Cloud Functions gen2 platform limit, leaving 2× headroom
over the realistic worst case. Above it the client keeps saving locally and raises
a persistent warning — it must never fail silently. Note the cap can only be a
policy check: functions-framework body-parses at 1024 MB before the handler runs,
so `express.json({limit})` is a no-op.

## Deploying

```bash
./deploy.sh            # provision the bucket + deploy the function
./deploy.sh --verify   # assert the deployed state matches this document
```

`--verify` is not optional ceremony: `gcloud functions deploy` reports success for
a function that cannot start, so the `/health` check is what actually catches a
broken build.

**`deploy.sh` never touches `gs://noah.leap-forward.ca`.** The website is
deployed by hand, separately.
