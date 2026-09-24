# Multiplayer Implementation Plan

> **For agentic workers:** This plan runs as a Workflow (the Anvil's step 4). Each task is
> implemented by one agent that sees only its own task plus the spec. The **Interfaces** block of
> each task is the contract with the neighbouring tasks. Do not rename anything it names. Steps use
> checkbox (`- [ ]`) syntax.

**Goal:** Add a private multiplayer mode to Minicraft. It consists of a Go + SQLite relay server
on a hand-started VM, and a browser client that syncs differential block edits and player poses.
The work also reworks the menus into Single Player, Multiplayer and Parents.

**Architecture:**
- The server orders, persists and relays; it never generates terrain.
- Each client generates chunks from the seed and applies a per-chunk overlay of edited cells.
- Every edit is server-sequenced and echoed to everyone, author included.
- Simulations (liquids, TNT) run on whichever client causes them, and their writes are broadcast
  like any other edit.
- Multiplayer entry and exit are page reloads.

**Tech Stack:**
- Server: Go 1.25 (`~/.local/go`, no sudo), `github.com/coder/websocket`, `modernc.org/sqlite`.
- Client: TypeScript, Vite, Three.js and vitest, as today.
- End-to-end tests: headless Playwright.

**Spec:** `docs/superpowers/specs/2026-09-24-multiplayer-design.md` (rev 3). **Every implementer
reads the spec sections named in their task before writing code.** The *(G1…)* and *(RG…)* notes
in the spec record measured evidence. Do not "simplify" a rule that has one.

## Global Constraints

- Indentation: **tabs, displayed as 4 spaces**, in every TS, Go, shell and markdown code file.
  Go uses tabs anyway.
- **Solo play must be unchanged.** This covers no socket, no overlay, no minimap, `DualAdapter`
  and autosave exactly as today, and every existing test still passing. Two exceptions:
  - the menu and timer rework (spec §8);
  - existing break-time tests rewritten as listed in spec §10.
- **Never point a test at production.** No test may reach `noah.leap-forward.ca`, `mc.leap-forward.ca`
  or the prod save API (`VITE_MINICRAFT_API_URL` in `.env.local`). Playwright must block the prod
  API host. Multiplayer tests use a local `mcserver` on a temp DB.
- **Playwright runs headless only.** Never open a headed browser; never set `DISPLAY=:1`.
- **Stop only servers you started, and only by port:** `fuser -k <port>/tcp`. Never `pkill` by
  name.
- **Git hygiene:**
  - Never `git add -A` or `git add .`. Stage explicit paths.
  - Throwaway probe files go in the scratchpad `/tmp/claude-1000/-home-julien-Projects-Minicraft/025905b6-e89d-412e-8343-fd1da268b0f3/scratchpad`, never in the repo.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Nothing is deployed.** No `./deploy.sh`, no `server/deploy.sh`, and no gsutil or gcloud
  writes. Julien deploys by hand.
- **Protocol constants** are copied verbatim from spec §5:

  | Constant | Value |
  |---|---|
  | `PROTO` | 1 (server accepts [1,1]) |
  | Ops per `edit` message | ≤ 2000 |
  | Read limit | 4 MiB |
  | Per-connection send queue | 1 MiB |
  | Client and server read silence | 6 s |
  | Client `ping` / server `ping` | every 2 s |
  | Server `tick` | every 100 ms |
  | Flush | every 1 s |
  | World unload | 60 s after the last player leaves |
  | Close codes | 4001 replaced, 4002 slow, 4003 resync, 4004 proto, 4005 gen_unsupported, 4006 unknown_world, 4007 bad_token, 4008 bad_name, 4009 name_taken |

- **Colour packing:** `0` = no colour. Otherwise `0x1000000 | rgb`, where `#FFF5E0` → `0x1FFF5E0`.
  - Pack: `colorToInt(hex)`. Unpack: `intToColor(n)`, which returns `#RRGGBB` uppercase.
- **Fluid packing:** the raw `Chunk.fluidMeta` value. `0` = none or source; `0x80 | d` = flow at
  distance d. A flow at distance 0 is `0x80`.
- **Test commands:**
  - `npx vitest run <path>` for TS.
  - `cd server && ~/.local/go/bin/go test ./...` for Go (`PATH=$HOME/.local/go/bin:$PATH`).
  - `npx tsc -b` must stay clean.

## Review Focus

These are the five failure modes the spec implies that are most likely to bite a real player and
that no single unit test pins by itself. Each has an owning test:

1. **A wifi blip mid-game** must bring the kid back where they were, with the same timer and the
   world intact. Owned by **T-I1** (autojoin reload) and **E6** in Task I2.
2. **Two kids choose the same name on different computers.** The second is told to pick another
   name, and the first is never kicked. Owned by **G7b** in Task S3 and a menu case in Task P3.
3. **A big TNT chain next to water while the friend watches.** It must not disconnect anyone
   (read limit or batch split) and must end identical to a single-player run. Owned by **G11**
   (Task S4), **T3** (Task C3) and **E3** (Task I2).
4. **The VM is off when the kid presses Multiplayer.** He sees "sleeping", it retries on its own,
   and Single Player is unaffected. Owned by the menu test in Task P3 and **E7** in Task I2.
5. **The kid has no PIN and his time runs out in multiplayer.** The friend sees the toasts and "went
   home"; the leaver's reconnect reload does not hand out a fresh timer. Owned by **T9** (Task C7),
   **T12b** (Task I1) and **E5**/**E6** (Task I2).

---

## Gate-2 amendments (NORMATIVE — override the task text below)

Every implementer reads **this section's entries for their task** in addition to the task itself.
Where they conflict, this section wins. Tags: *(K)* kid lens, *(R)* rigour, *(E)* engine,
*(S)* server.

### Cross-cutting
- **Wording (K):** the word is **Parents** everywhere. The sleeping text is "The multiplayer server
  is sleeping. Ask a parent to wake it up." Rename the old "Grown-ups" labels.
- **Durations (K):** durations of 60 minutes or more display as hours and minutes ("1 h", "1 h
  30 min"). `formatDuration(min | null)` goes in `src/game/session-policy.ts` (P1) and is
  unit-tested.

### P1
- **(R)** Also create `src/data/skins.data.ts` here (moved from C5; the content is as C5 describes).
  P2 needs `SkinId`.
- **(R)** Complete file list. P1 also modifies:
  - `src/ui/menu-model.ts`: drop `breakMin` from `Staged` and `SavePlan`.
  - `src/ui/playtime-overlay.ts`: drop `offerPlayAgain` and `setBreakRemaining` from the class
    and from `PlaytimeOverlayLike`.
  - `src/game/playtime.ts`: drop the `break-over` event and `breakRemainingMs`; `phaseOf` never
    returns `'over'` for `breakMs === null`.
  - `src/ui/menu.ts`: the break imports and UI at lines 4–5, 289–316, 364 and 394, minimally.
  - **`src/main.ts` lines ~493–495:** a named exception to "main.ts: I1 only". P1 may only touch
    the `activeLimits`/`resolveSession` call to keep it compiling.
- **(R)** `clampDuration` enforces the 10-minute minimum even when `maxMin === null`.
- **(R)** `sessionPolicy` treats a **`broken` schedule as active** (keep; fail closed).
- **(R) An in-force session always wins over the chosen duration.** At Play, if a stored session
  is in force (not stale), use it, even when the kid picks "No limit". A new session is created
  only when there is none. Test: a stored frozen session plus the "No limit" choice → the timer
  runs and is frozen.

### P3
- **(K)** A name that fails `validName` shows the reason under the field, "Only letters, numbers
  and spaces", and Next stays enabled but refuses. Test in `mp-menu-model.test.ts`: `nameError("Noah!")`
  returns that string.
- **(K)** Sleeping auto-recovery has a smoke step: dead port → "sleeping" shown → start
  `mcserver` on that port → the world list appears within 6 s with no click.

### C1
- **(S)** `TestDecodeTSFixture` (Go) is added **unconditionally** and fails if
  `src/net/testdata/ts-ops.bin` is missing. C1 runs after S1, so it adds the Go test itself.
- **(S)** Go emits **golden JSON per message type** to `server/internal/proto/testdata/msg-*.json`
  (S1 with `-update`). C1's T1 parses each one with the TS types and checks the field names.
- **(S)** `decodeSnapshot` rejects a `count` larger than `remainingBytes / 6` before allocating.

### S1
- **(S)** The snapshot's `prev` starts at **(0, 0, −1)**. A first row at (0, 0, 0) then encodes
  `dy = 1`, and the "≥ 1" note holds. Add a (0, 0, 0) cell to `snapshot-small`.
- **(S)** Every JSON field has an explicit lowercase tag (`json:"x"`, `json:"yaw"`, …). The
  shorthand in the struct block is **not** literal Go.
- **(S)** Player ids start at **1** (so `by,omitempty` never drops a real id).
- **(S)** `CatalogMax` is the **max id** in `BLOCKS`, not `length - 1`.

### S3
- **(S) B1:** `cmdLeave` carries the `Sender`. `run()` ignores a leave whose `Sender` is not the
  player's current one.
  - **G7** (hub) must also assert that the new sender still receives an edit submitted *after*
    the old reader's leave, and that nobody received `left`.
- **(S) B4:** every flush, and `Stop()`, includes each **online** player whose pose or extras
  changed since the last flush. `pos` updates mark the player dirty.
- **(S)** `flushCh` send is **non-blocking**: `select { case flushCh <- b: default: keep the dirty set for next time }`.
  `Stop()`'s final hand-off may block, but only after `run()` stops accepting commands.
- **(S)** `Submit` after `Stop` is a no-op (`select` on a `done` channel). It must not panic or
  hang.
- **(S)** A 4002 kick removes the player and **broadcasts `left`**.
- **(S)** The snapshot frame is **exempt from the 1 MiB queue cap**; `Send` gets a
  `force bool` variant for it. Add a G-test: a world with a snapshot over 1 MiB is joinable.

### S4
- **(S) B2:** `registry.Join(uuid, hello, sender)` holds `mu` from `Get` until `run()` has
  registered the join (it waits on the join reply). `tryUnload` takes `mu`, so the race is closed.
  - A test hook `afterGetBeforeJoin func()` makes **G14 deterministic**: park there while the
    unload timer fires, then release; the join must succeed.
  - The red build (`Join` outside `mu`) must fail it.
- **(S) B3, G9:** push **≥ 8 MB** in the window, about 220 edit messages of 2,000 ops, and
  assert the **max** tick gap under 300 ms, not p99. The stalled client gets 4002. G7's latency
  assertion also uses the max gap.
- **(S) B5:**
  - `Kick` never waits on `Close`. The writer goroutine calls `CloseNow()` after at most 2 s of
    trying to write a close frame, via a `time.AfterFunc` and not a context. **Nothing on the
    shutdown path waits for a close to finish.**
  - Shutdown step 4 means signal all, sleep at most 2 s, and move on.
- **(S) G11:** use a message of **4 MiB − 64 KB**.
- **(S)** A writer goroutine error is logged and never exits the loop.

### S5
- **(S) G5:**
  - Wait for all 10 echoes **before** sending SIGTERM.
  - Connect **2** black-holed clients.
  - Assert exit **under 4 s**, and that the edits persist.
  - The "close before flush" red build must now fail on the 4 s bound. Demonstrate it.

### C3
- **(E)** Lamp colours are **not** restored in `prepareChunk`, which is dead code there.
  - `enqueueRemote` calls `lights.add` / `setColor` for every op with a colour, and
    `lights.remove` for an op on a lamp cell whose id is no longer a lamp, **at receive time,
    loaded or not**.
  - At session start (I1), every coloured overlay cell is added to `LightRegistry`.
  - `drainRemote` then only relights.
- **(E) T14 lift:**
  - `liftPlayerIfInside` searches **upward** from `floor(feetY)` for the first y where the feet
    and head cells are both non-solid, and sets the feet there. It does not use `findSafeSpawn`.
  - T14 cases: stone in the feet cell; stone in the head cell; and a 2-high tunnel with stone
    in the feet cell. In the tunnel case the player moves up through the ceiling to the first
    free 2-high gap: the kid ends up standing on top, which is correct.
- **(E)** `drainRemote` sets `this.mining = null` when an op hits the mining target.
- **(E)** In the paused branch, `drainRemote()` runs **before** `flushDirtyChunks()`.
- **(E) Inventory open in multiplayer does not pause the simulation.** In MP, `simulate` runs
  unless frozen or disconnected. Add `loop.pauseSimulationWhenPaused` (true in solo, false in MP).
  - The paused branch checks `this.mp && !this.mpDisconnected && !this.frozenByTimer` → call
    `drainRemote()` and `simulate(dt)`.
  - main.ts sets `loop.frozenByTimer`.
- **(E) T8** compares the cells around P against a snapshot taken **before** the remote op, not
  "all solid".
- **(E) T3:** "settle" means the simulated network keeps delivering until no client has written
  for 20 simulated seconds. Use an inland cell and explicit vitest timeouts (60 s).

### C7
- **(E)** The `near` ground search, for each candidate column, scans y from `targetY + 4` down to
  `targetY − 4` for a solid, non-liquid block with two air cells above it.
- **(E) Toast text** for any `secondsLeft`:
  - ≥ 90 → "in 2 minutes"
  - ≥ 45 → "in 1 minute"
  - > 0 → "in 30 seconds"
  - 0 → "went home"

  `leavingText(name, secondsLeft)` is exported and unit-tested.

### I1
- **(R)** I1 owns the **solo duration wiring**: `showMenu`'s callback passes `action.duration` to
  `startGame`, which builds the session via P1's rule (an in-force session wins; otherwise a new
  session with the chosen duration; a null duration and no session → no controller).
  - Test: extend `scripts/menu-smoke.ts`: pick **10 min** → Play → `localStorage['minicraft:v1:playtime'].limitMs === 600000`.
- **(R) The boot sequence moves to an exported `boot(deps)`** in `src/game/boot.ts`. It returns
  what main.ts should do (`{kind:'menu'} | {kind:'autojoin', args}`) after applying
  `bootSession`.
  - main.ts calls `boot()` first, before anything reads `loadSession()`. That is the normative
    point, and spec §8.1's "before resolveSession" means the same thing.
  - **T12b** tests `boot()` directly.
  - The text-order guard test is **dropped**.
  - A new **E8** (in I2): no PIN, a stored session, reload → the session is gone. With a PIN →
    it is kept.
- **(K) K1, autojoin failure path:** if the probe or `hello` does not get a `welcome` within 6 s,
  go to the Multiplayer screen (screen 2) in its sleeping state, which auto-retries. **Keep** the
  autojoin args so the preselect points at the same world.
- **(K) K2:** clear `mp:autojoin` **before** acting on any fatal close (4001, 4004–4009) and
  before the Menu link.
  - Test in I1 (a unit test on the close-code handler): for each fatal code, the flag is cleared
    before the reload.
  - An E-step in I2: after a 4009 reload, zero WebSocket constructions, and screen 1 shows the
    message.
- **(R) DEV hooks for E5:** `__mc.playtime.setRemaining(ms)` sets `playedMs = limitMs − ms` on the
  live controller's session. It is DEV only. **No fast clock.**
- **Session start (E):** lamps from the overlay are added to `LightRegistry` (see C3).

### I2
- **(E) E2** as the red proof: A pours, then **closes its page about 1 s later**. B alone finishes,
  and B's hash must equal `refReplay`. The red run (`writeRemote` without the wake) must FAIL
  here.
- **(E) E3:** both players stand **outside** the blast radius plus 2, so the reference needs no
  player box.
- **(K) E4:** the minimap pixel at A's projected spot is within ΔE < 30 of A's skin colour, and
  the ring at radius + 1 is white.
- **(K)(R) E5:** use `__mc.playtime.setRemaining(125_000)` and wait in real time (about 2.2 min).
  Assert:
  - the messages;
  - B's DOM shows "…has to go in 2 minutes", then "…went home";
  - B has no big-countdown element;
  - A shows the big 10…1.
- **(K)(S) E6:**
  - B stays connected throughout.
  - A is placed more than 20 blocks from B.
  - The server is stopped with **`fuser -k -TERM 18080/tcp`** (graceful), then restarted.
  - A must come back within 1 block of where it was, **not** near B, with the same inventory
    counts.
  - A second pass uses `fuser -k -KILL`. A must come back within 1 block of its position as of
    about 1 s before the kill; the per-second flush makes that true.
  - Then kill the server **without** restarting it. Press Try again → the sleeping text
    appears.
- **E8** (from I1).
- **4009 step:** a second browser context with a different `bid` joins as A's name → it sees the
  name message, with zero reconnect loops.

---

## Gate-2 re-gate amendments (NORMATIVE — override both the tasks and the section above)

### C3
- **(E) The lift tests the whole player box.** At each candidate y, from `floor(feetY)` up to
  `world.height − 2`, test `playerBox` at that feet height with the **same overlap test** as the
  trigger, over every column the 0.6-wide box overlaps. Take the first y with no overlap.
  - T14 adds a case where the box straddles into the next column (feet x = 10.8, stone at x = 11
    at feet level). The player must end up not overlapping.
- **(E)** Drop `pauseSimulationWhenPaused`. The **only** mechanism is the paused-branch condition
  `this.mp && !this.mpDisconnected && !this.frozenByTimer`.
  - Order in that branch: `drainRemote()` → `simulate(dt)` → `evict()` → `loadNearbyChunks()` →
    `flushDirtyChunks()`.
- **(E)** `drainRemote`'s no-op check compares **id and fluid only**, never colour. The registry
  was already updated at enqueue, so a colour-only op must still relight.

### I1
- **(R)(K) The autojoin flag never leaks:**
  - On a failed rejoin, the args move to `sessionStorage['mp:preselect']` (read once by the
    Multiplayer screen's preselect, then deleted), and `mp:autojoin` is **cleared**.
  - `boot(deps)` takes `deps.mpUrl`. With no URL and the flag set, it clears the flag and returns
    `{kind:'menu'}`.
  - Starting any solo game clears `mp:autojoin`.
  - T12b adds these cases: flag plus no URL → menu, flag cleared; flag plus URL → autojoin;
    solo start → flag cleared.
- **(K)** "went home" is shown **only** on `leaving 0`. A plain `left` shows no toast; the avatar
  just disappears.
- **(E) Lamp recolour** (the colour picker handler that calls `lights.setColor`) also calls
  `mpSync.record(x, y, z)` in multiplayer, so the colour-only change is sent.

### P1
- **(R)** `resolveSession(stored, limitMin: number | null, now, schedule): PlaytimeSession | null`:
  - it returns the stored session when that session is in force, whatever `limitMin` is;
  - otherwise it returns a new session when `limitMin !== null`;
  - otherwise `null`, meaning no controller.

  P1 unit-tests all three branches, including "a stored frozen session plus null → the frozen
  session".

### P2
- **(R) P2 owns the Parents rename.** Change "ask a grown-up" and "ASK A GROWN-UP" to "ask a
  parent" and "ASK A PARENT" in:
  - `src/ui/playtime-overlay.ts`
  - `src/ui/menu-model.ts`
  - `src/game/continue-policy.ts`
  - their tests: `continue-policy.test.ts` and `menu-model.test.ts`.

### C5
- **(R)** C5 **imports** `src/data/skins.data.ts`, which P1 created in the foundation stage. It
  does not create it.

### S3 / S4
- **(S) Forced snapshot bytes do not count** toward `queuedBytes`. The G-test's client stops
  reading for 1 s after `welcome` (snapshot over 1 MiB), then resumes. It must receive no 4002.
- **(S)** Normative:
  - `run()` never takes `registry.mu` and never calls `tryUnload` synchronously. The unload
    timer is a `time.AfterFunc` goroutine.
  - `registry.Join`'s wait for the join reply selects on the world's `done` channel and a 5 s
    timeout.
  - `Online()` does the same.
- **(S)** `registry.closed`, set by `StopAll`, makes any later `Join` or `Get` fail with close
  1001, so it never loads a new world.
- **(S) S5 red build:** "close before flush" means calling `Close` **synchronously** per
  connection before the flush. With 2 black-holed clients that takes about 10 s and fails the 4 s
  bound.

### I2
- **(K) E6 ordering:**
  - `page.route` holds A's reconnect probe (and its `/ws` upgrade) until B's `welcome` has
    arrived, then releases it. B is online first, so a wrong `near` spawn would put A next to B.
  - The test asserts A is within 1 block of its old spot.
- **(S) E6:** `fuser -k -TERM 18080/tcp` (the listener only). Before the SIGKILL pass, A stands
  still for at least 3 s.

---

## Dependency graph (for the Workflow)

```
S0 ─► S1 ─┬─► S2 ─► S3 ─► S4 ─► S5 ─────────────────────────┐
          └─► C1 ─► C2 ─► C3 ─► C4 ──┐                       │
                     C1 ─► C5, C6, C7 ┼─► I1 ─► I2 ─► D1 ◄───┘
P1 ─► P2 ─► P3 ───────────────────────┘
```

- **Can run in parallel:** the S, C and P streams touch disjoint files. C5, C6 and C7 need only
  C1.
- **Shared files with an owner:**
  - `src/main.ts`: I1 only.
  - `src/game/loop.ts`: C3 only.
  - `src/engine/world/world.ts`: C2 only.
  - `src/ui/menu.ts`: P2 and P3, in sequence.

---

### Task S0: Go toolchain and server scaffold

**Files:**
- Create: `server/go.mod`, `server/cmd/mcserver/main.go`, `server/internal/config/config.go`,
  `server/internal/config/config_test.go`, `server/.gitignore` (`mc.sqlite*`, `mcserver`,
  `backup.sqlite`)
- Create: `scripts/install-go.sh`, which installs Go 1.25.x from `https://go.dev/dl/` into
  `~/.local/go` with no sudo, and is idempotent.

**Interfaces:**
- Produces:
  - Module path `minicraft/server`.
  - `config.Config{Addr string; DB string; Token string; Origins []string; BackupDir string; GCSBucket string}`.
  - `config.FromFlags(args []string) (Config, error)`.
    - Flags: `-addr :8080`, `-db ./mc.sqlite`, `-token` (env `MC_TOKEN` fallback, required),
      `-origins`, `-backup-dir`, `-gcs-bucket` (empty disables upload).
    - Default origins: `https://noah.leap-forward.ca,http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173`,
      the same list as `api/src/handlers.ts:15`.
- `main.go` serves only `GET /health` → `200 ok` in this task.

- [ ] Step 1: Run `bash scripts/install-go.sh`, then `~/.local/go/bin/go version`. It must print
  go1.25.
- [ ] Step 2: Write `config_test.go`:
  - `-token` missing and no env → error;
  - the default origins list equals the 5 above;
  - `-origins a,b` → `[a b]`.
- [ ] Step 3: Run `go test ./...`. It must FAIL: the package doesn't exist yet.
- [ ] Step 4: Implement `config.go` and `main.go` (flag parse, `http.ServeMux`, `/health`).
- [ ] Step 5: Run `go test ./...`. It must PASS. Also `go vet ./...`.
- [ ] Step 6: Commit: `git add server/ scripts/install-go.sh` → `feat(server): Go scaffold and config`.

### Task S1: Protocol, validation, names and snapshot codec (Go), plus shared fixtures

Read spec §4 and §5.

**Files:**
- Create: `server/internal/proto/proto.go`, which holds:
  - the message structs;
  - the close code constants;
  - the `Op` type `[6]int32` (x, y, z, id, fluid, color);
  - `const Proto = 1`, `MinProto`, `MaxProto`.
- Create: `server/internal/proto/validate.go`, holding:
  - `ValidateOps(ops []Op, height int, catalogMax int) error`
  - `NameKey(name string) (string, error)`
- Create: `server/internal/proto/snapshot.go`, holding:
  - `type Cell struct{X, Y, Z, ID, Fluid, Color int32}`
  - `EncodeSnapshot(seq uint32, cells []Cell) []byte`
  - `DecodeSnapshot(b []byte) (uint32, []Cell, error)`
- Create: `server/internal/proto/catalog_gen.go` (generated: `const CatalogMax = N`), plus
  `scripts/gen-server-catalog.ts`. The script imports `BLOCKS` from `src/data/blocks.data.ts` and
  writes `BLOCKS.length - 1`.
- Add `"gen-server-catalog": "tsx scripts/gen-server-catalog.ts"` to `package.json`.
- Create: `server/internal/proto/*_test.go`.
- Create: `server/internal/proto/testdata/snapshot-small.bin`,
  `snapshot-small.json`, `ops-roundtrip.json`. The tests write these with `-update`.
- Create: `server/internal/proto/testdata/gen/` (fixture generators for the clustered and tunnel
  200k worlds; generated at test time, not committed).

**Snapshot format** (normative, spec §5):
- **Header:** 8 bytes, uncompressed: `u32le seq, u32le count`.
- **Body:** the rest is **raw DEFLATE** (Go `compress/flate`, level 6; TS `pako.inflateRaw`) of the
  rows.
- **Row order:** rows sorted by (x, z, y).
- **Row encoding:** all values are unsigned LEB128 varints. `prev` starts at (0, 0, 0).
  ```
  dx = x - prevX            → uvarint(dx)
  if dx > 0:                → uvarint(z), uvarint(y)
  else: dz = z - prevZ      → uvarint(dz)
        if dz > 0:          → uvarint(y)
        else:               → uvarint(y - prevY)      (≥ 1, since rows are unique)
  then uvarint(id), uvarint(fluid), uvarint(color)
  ```

**Interfaces:**
- Produces:
  - The Go types above.
  - `proto.Close*` constants.
  - `proto.NameKey`: trim, check `^[\p{L}\p{N} ]{1,16}$`, then `norm.NFC` and
    `strings.ToLower`. Uses `golang.org/x/text/unicode/norm`.
  - The fixture files, which Task C1 decodes.

- [ ] Step 1: Write `snapshot_test.go`:
  - **Round-trip:** 1,000 random cells, deduplicated, give identical output after
    decode(encode).
  - **G15:** build a *clustered* fixture of 200k cells: 20 houses, 100×100×20 boxes of mixed ids
    near (x, z) centres. Build a *tunnel* fixture: 200k air cells along 40 random-walk tunnels 3
    wide. Assert `len(EncodeSnapshot(...)) < 300_000` for each.
  - **Red build:** add `encodeAbsolute` (absolute x, y, z varints) in the test file. Assert it
    exceeds 300 KB on the clustered fixture. This proves the instrument can go red; see spec §5.
  - **With `-update`:** write `testdata/snapshot-small.bin` and `.json` (25 hand-picked cells,
    including `fluid=0x80`, `fluid=0x83`, `color=0x1FFF5E0`, `y=255`, `x=511`).
- [ ] Step 2: Write `validate_test.go`:
  - Ops out of range are rejected (x = −1, x = 512, y = height, id = CatalogMax + 1).
  - A valid batch is accepted.
  - **G16:** `NameKey("Noé") == NameKey("NOÉ") == NameKey("Noé")`.
    `NameKey("")`, `NameKey("a<b")` and a 17-character name are errors.
- [ ] Step 3: Run the tests. They must FAIL (the functions are undefined).
- [ ] Step 4: Implement `proto.go`, `validate.go` and `snapshot.go`. Run
  `npm run gen-server-catalog`.
- [ ] Step 5: Run `go test ./internal/proto/ -update`, then `go test ./...`. They must PASS.
  Commit the testdata files.
- [ ] Step 6: Commit: `feat(server): protocol, validation, snapshot codec + fixtures`.

**Message structs** (JSON field names are the contract with C1):
```go
type Hello struct{ T string `json:"t"`; World string `json:"world"`; Name string `json:"name"`; Skin string `json:"skin"`; Bid string `json:"bid"`; Proto int `json:"proto"`; Gen int `json:"gen"`; Resume bool `json:"resume"` }
type Pos struct{ T string `json:"t"`; X, Y, Z, Yaw, Pitch float64 }       // json: x,y,z,yaw,pitch
type Edit struct{ T string `json:"t"`; Cid int64 `json:"cid"`; Ops []Op `json:"ops"` }
type Fx struct{ T string `json:"t"`; Kind string `json:"kind"`; X, Y, Z int; Tier int `json:"tier,omitempty"`; By int `json:"by,omitempty"` }
type Extras struct{ T string `json:"t"`; Data json.RawMessage `json:"data"` }
type Leaving struct{ T string `json:"t"`; SecondsLeft int `json:"secondsLeft"`; By int `json:"by,omitempty"` }
// server → client
type Welcome struct{ T string `json:"t"`; You int `json:"you"`; World WorldInfo `json:"world"`; Spawn Spawn `json:"spawn"`; Extras json.RawMessage `json:"extras"`; Players []PlayerInfo `json:"players"`; Seq uint32 `json:"seq"`; CatalogMax int `json:"catalogMax"` }
type WorldInfo struct{ UUID string `json:"uuid"`; Name string `json:"name"`; Seed int64 `json:"seed"`; Gen int `json:"gen"`; Height int `json:"height"`; MustMine bool `json:"mustMine"` }
type Spawn struct{ Mode string `json:"mode"`; X, Y, Z, Yaw, Pitch float64; Target int `json:"target,omitempty"` } // mode: first|return|near
type PlayerInfo struct{ ID int `json:"id"`; Name string `json:"name"`; Skin string `json:"skin"`; X, Y, Z, Yaw, Pitch float64 }
type EditOut struct{ T string `json:"t"`; Seq uint32 `json:"seq"`; By int `json:"by"`; Cid int64 `json:"cid,omitempty"`; Ops []Op `json:"ops"` }
type Tick struct{ T string `json:"t"`; Poses [][6]float64 `json:"poses"` } // [id,x,y,z,yaw,pitch], x/y/z rounded to 0.01, yaw/pitch to 0.001
type Join struct{ T string `json:"t"`; ID int `json:"id"`; Name string `json:"name"`; Skin string `json:"skin"` }
type Left struct{ T string `json:"t"`; ID int `json:"id"` }
type ErrorMsg struct{ T string `json:"t"`; Code int `json:"code"`; Message string `json:"message"` }
```
Add explicit lowercase `json:"x"` style tags on every float field. The shorthand above is for
brevity only. `/worlds` row: `{uuid,name,mustMine,createdAt,online:[{name,skin}]}`.

### Task S2: Store (SQLite)

Read spec §3.1 ("Persistence writer", "Unload") and §4.

**Files:**
- Create: `server/internal/store/store.go`, `store_test.go`.

**Interfaces:**
- Consumes: `proto.Cell`, `proto.Op`.
- Produces:
  - Lifecycle and worlds:
    - `store.Open(path string) (*Store, error)`: WAL mode, schema from spec §4 verbatim,
      `busy_timeout=5000`.
    - `(*Store).Close() error`
    - `CreateWorld(name string, seed int64, gen, height int, mustMine bool) (WorldRow, error)`
    - `ListWorlds() ([]WorldRow, error)`
    - `GetWorld(uuid string) (WorldRow, bool, error)`
    - `DeleteWorld(wid int64) error`: all three tables, one transaction.
  - Loading:
    - `LoadCells(wid int64) (map[CellKey]proto.Cell, uint32 /*lastSeq*/, error)`
    - `LoadPlayer(wid int64, nameKey string) (PlayerRow, bool, error)`
  - Writing:
    - `Flush(b FlushBatch) (upserts int, err error)`: one transaction. Upserts exactly
      `b.Cells`, `b.Players` and `worlds.last_seq`, and returns the count of cell upserts.
  - Types:
    - `type CellKey struct{X, Y, Z int32}`
    - `type WorldRow struct{WID int64; UUID, Name string; Seed int64; Gen, Height int; MustMine bool; CreatedAt int64; LastSeq uint32}`
    - `type PlayerRow struct{NameKey, Name, Skin string; X, Y, Z, Yaw, Pitch float64; HasPos bool; Extras []byte; LastSeen int64}`
    - `type FlushBatch struct{WID int64; LastSeq uint32; Cells []proto.Cell; Players []PlayerRow}`
  - `Store` is safe for use by exactly one writer goroutine plus concurrent reads.

- [ ] Step 1: Write `store_test.go` (temp dir DB):
  - **G3:** create a world. Flush 3 cells and a player. Close and reopen. `LoadCells` gives the
    same 3 cells with the same `lastSeq`; `LoadPlayer` gives the same row.
  - **G4:** flush batch A (1,000 cells), then batch B (5 cells, 2 of them overlapping A).
    `Flush(B)` must return `upserts == 5`; the final `LoadCells` count is 1,003.
    - Red build: a `Flush` that rewrites every cell from memory would need the world's whole map,
      which the API doesn't accept. The count assertion also catches an implementation that
      re-reads and re-writes rows.
  - **Delete:** after `DeleteWorld`, `SELECT count(*)` on cells and players for that wid is 0.
- [ ] Step 2: Run the tests. They must FAIL.
- [ ] Step 3: Implement with `database/sql` and the `modernc.org/sqlite` driver (`"sqlite"`).
  Upsert with `INSERT … ON CONFLICT(wid,x,z,y) DO UPDATE SET id=excluded.id, fluid=…, color=…, seq=…`.
  Use one prepared statement per transaction.
- [ ] Step 4: Run the tests. They must PASS.
- [ ] Step 5: Commit: `feat(server): SQLite store with dirty-only flush`.

### Task S3: World hub (one goroutine per world)

Read spec §3.1, §5, §6 (server side) and §7.2 (spawn modes).

**Files:**
- Create: `server/internal/hub/world.go`, `server/internal/hub/world_test.go`,
  `server/internal/hub/spawn.go`, `server/internal/hub/spawn_test.go`.

**Design:**
- `World` owns everything below. It runs `run()` in one goroutine and receives messages on
  `inbox chan any`:
  - `cells map[store.CellKey]proto.Cell`
  - `dirty map[store.CellKey]struct{}`
  - `players map[int]*Player`, a `nameKey → id` index, and each player's `bid`
  - `seq uint32`
- **Commands:** `cmdJoin{hello, conn Sender, reply chan joinResult}`, `cmdLeave{id}`,
  `cmdEdit{id, cid, ops}`, `cmdPos{id, …}`, `cmdFx`, `cmdExtras`, `cmdLeaving`, `cmdTick`,
  `cmdFlush`, `cmdStop{done chan}`.
- **`Sender` interface** (implemented by the connection layer in S4, faked in tests):
  `Send(msg []byte) bool` (false = queue full), `Kick(code int, reason string)` (non-blocking;
  signals only), `ID() int`.
- **Join:**
  - If `nameKey` is online with the same `bid`: `old.Kick(4001)`. The new connection takes over
    the same player id, with **no** `left`/`join` broadcast.
  - If `nameKey` is online with a different `bid`: reply with an error, `4009`.
  - Otherwise: load the `PlayerRow` via `store.LoadPlayer`, choose the spawn, assign an id,
    broadcast `join`, then send `welcome` and the binary snapshot built **inside `run()`**.
    Subscribe the player in the same step.
  - Takes a test hook `beforeSubscribe func()`, nil in production, called between the snapshot
    build and the subscribe.
- **Edit:**
  - `ValidateOps`. If invalid, `Kick(4003)` and do not apply.
  - Otherwise `seq++`, apply every op to `cells` and `dirty`, and broadcast `EditOut{seq, by, cid, ops}`
    to all players, **author included**.
  - If a `Send` returns false: `Kick(4002)` that player and remove it.
- **Tick** (a 100 ms ticker in `run()`):
  - With ≥ 2 players: for each recipient, send one `Tick` with every *other* player's pose.
  - Otherwise every 2 s: `{"t":"ping"}`.
- **Flush** (1 s ticker): copy the dirty cells and dirty players into a `FlushBatch`, clear
  `dirty`, and hand the batch to `flushCh` (the writer goroutine owned by S4's registry).
  **Never call the store from `run()`.**
- **Leave:** broadcast `left`, persist the player's last pose and extras (as dirty), and remove
  it. When the world becomes empty, start a 60 s timer. Unload itself is S4's job.

**Spawn** (`spawn.go`): `ChooseSpawn(row *PlayerRow /*nil if never*/, resume bool, online []*Player, rnd *rand.Rand) proto.Spawn`:
- `resume && row != nil && row.HasPos` → `return` at `row`.
- `len(online) > 0 && !resume` → `near`, with the target chosen at random and the target's pose
  copied in.
- `row != nil && row.HasPos` → `return`.
- Otherwise → `first`.

**Interfaces:**
- Consumes: `store.*`, `proto.*`.
- Produces:
  - `hub.NewWorld(row store.WorldRow, cells map[store.CellKey]proto.Cell, st PlayerLoader, flushCh chan<- store.FlushBatch) *World`
  - `(*World).Join(h proto.Hello, s Sender) (JoinResult, error)`
  - `(*World).Submit(cmd any)`
  - `(*World).Stop()` blocks until `run` exits, after handing the final flush batch to `flushCh`.
  - `(*World).Online() []proto.PlayerInfo`
  - `(*World).Empty() bool`
  - `type PlayerLoader interface{ LoadPlayer(wid int64, nameKey string) (store.PlayerRow, bool, error) }`
  - `(*World).LastPos(nameKey)`: used for `resume`. Positions are updated live from `pos`.

- [ ] Step 1: Write `world_test.go` with a fake `Sender` that records messages:
  - **G1:** 3 senders join. 300 edits are submitted concurrently from 3 goroutines. Every sender
    receives the same sequence of `(seq, by, cid)`, and each author receives its own.
  - **G2 (deterministic):** set the `beforeSubscribe` hook to block on a channel. Start a join.
    While it is parked, submit 50 edits from another player. Then release. Oracle: an op log kept
    **in the test** (every submitted op, in submission order, applied to a fresh map). Check that
    snapshot cells plus the edits received after it equal the oracle's final map, with no seq
    gap and no duplicate seq.
    - Red build: a variant that builds the snapshot outside `run()`, written as a test-only flag
      `unsafeSnapshotOutsideRun` in the world, must fail this test. Keep the flag; it is the
      instrument's proof.
  - **G7 (hub part):** A joins with bid X. A second hello with the same name and bid X: the old
    sender got `Kick(4001)`, a third player observed no `left`/`join`, and the new sender got
    `welcome` with the same `you`.
  - **G7b:** a hello with the same name and bid Y gets a 4009 error. A still receives the edits.
  - **G12:** an op with id = CatalogMax + 1 leads to `Kick(4003)`, no broadcast, and an unchanged
    `seq`.
  - **G9 (hub part):** a sender whose `Send` returns false is kicked 4002, and the others still
    receive later edits.
  - **G13 (hub part):** `Online()` lists the names and skins of the joined players.
- [ ] Step 2: Write `spawn_test.go`, **G6**, one case per branch above, including "`resume` with
  others online → `return`".
- [ ] Step 3: Run the tests. They must FAIL.
- [ ] Step 4: Implement `world.go` and `spawn.go`.
- [ ] Step 5: Run `go test -race ./internal/hub/`. It must PASS, repeated 20 times:
  `-count=20`.
- [ ] Step 6: Commit: `feat(server): world hub — sequencing, snapshot, spawn, takeover`.

### Task S4: Connections, HTTP API and registry

Read spec §3, §3.1 and §5 (HTTP, close codes).

**Files:**
- Create: `server/internal/net/conn.go` (the WebSocket `Sender` implementation),
  `server/internal/net/http.go` (the `/ws`, `/worlds` and `/health` handlers with CORS),
  `server/internal/net/registry.go` (loaded worlds and the writer goroutine),
  `server/internal/net/net_test.go`.
- Modify: `server/cmd/mcserver/main.go` to wire everything up.

**Design:**
- **Accept:** `websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: hostsOf(cfg.Origins)})`.
- **Token:** the query `token` or `Authorization: Bearer`. Wrong → close 4007.
- **Read limit:** `conn.SetReadLimit(4 << 20)`.
- **Reader goroutine:** each read uses a `context.WithTimeout(6s)`. The first message must be
  `hello`, then `registry.Get(uuid)` → `world.Join`. It routes messages to `world.Submit`.
- **Writer goroutine:** drains `queue chan []byte` while tracking `queuedBytes`. `Send` returns
  false if `queuedBytes + len(msg) > 1<<20`.
  - `Kick(code)` sets the code and cancels the context. The **writer goroutine** then calls
    `conn.Close(code, reason)` with a 2 s context, falling back to `conn.CloseNow()`.
  - Nothing else ever calls `Close`.
- **HTTP:**
  - `GET /worlds` returns the rows with online names (from the registry when a world is loaded),
    sorted by online count descending, then `createdAt` descending.
  - `POST /worlds {name, seed, mustMine, gen}`: 400 if `gen` isn't in the supported set {3}.
  - `DELETE /worlds/:uuid`: 409 if the world is loaded with players.
  - CORS: echo `Origin` when it's allowed; `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`;
    `Access-Control-Allow-Headers: Authorization, Content-Type`; and `OPTIONS` → 204.
- **Registry:**
  - `mu sync.Mutex` over `loaded map[string]*hub.World`.
  - `Get(uuid)`, under `mu`: return the world if loaded; otherwise load cells from the store and
    `NewWorld`.
  - An unload timer calls `tryUnload(uuid)`, which, under `mu`, re-checks `Empty()`, then
    `Stop()`s the world (that includes the final flush) and deletes it from `loaded`.
  - One writer goroutine reads `flushCh` and calls `store.Flush`.

**Interfaces:**
- Consumes: `hub.*`, `store.*`, `proto.*`, `config.Config`.
- Produces:
  - `net.NewServer(cfg config.Config, st *store.Store) *Server`
  - `(*Server).Handler() http.Handler`
  - `(*Server).Shutdown(ctx context.Context) error`: the spec §3.1 order is done in S5, but the
    method lives here.

- [ ] Step 1: Write `net_test.go` using `httptest.NewServer` and `websocket.Dial`:
  - **G10:**
    - Dial with the header `Origin: https://noah.leap-forward.ca` → OK.
    - `Origin: https://evil.example` → handshake error.
    - `OPTIONS /worlds` with an allowed origin → 204 plus the CORS headers.
    - Red build: `AcceptOptions` nil → the first case fails with 403. Say so in a test comment.
  - **G11:** join, then send one `edit` with 2,000 ops, then one message of about 4 MiB (pad an
    `extras` data). Both are accepted, and the 2,000-op echo arrives.
  - **G8:** join, then send nothing. The server closes the connection within 7 s.
  - **G9:**
    - 25 clients join. One client stops reading, done by holding its `websocket.Conn` without
      calling `Read`.
    - The other 24 measure `tick` inter-arrival over 5 s while edits flow. The p99 gap must be
      under 300 ms.
    - The stalled client is closed with 4002.
  - **G7 (full):**
    - A connects through a TCP proxy (a `net.Listener` goroutine in the test) that can
      **black-hole** (stop forwarding without closing).
    - Black-hole it, then within 5 s connect again directly with the same name and bid. The new
      connection gets `welcome`.
    - A third client connected throughout sees p99 `tick` gaps under 300 ms during the takeover.
      Red build: the world goroutine closing the socket itself stalls about 5 s.
  - **G13:** after creating 3 worlds and joining 1, `/worlds` is ordered with the occupied one
    first, and it lists `online`. `DELETE` on the occupied world → 409. On an empty one → 204,
    and a later `GET` omits it.
  - **G14:**
    - Set a test-only package var `unloadDelay = 50 * time.Millisecond`.
    - Join and leave, then loop 200 times: leave, then join at a random 0–60 ms offset.
    - Every join gets `welcome`, and an edit sent after it echoes.
  - **Bad token** → close 4007. **Unknown world** → 4006. **proto 2** → 4004. **gen 4** → 4005.
- [ ] Step 2: Run the tests. They must FAIL.
- [ ] Step 3: Implement `conn.go`, `http.go` and `registry.go`, then wire `main.go`.
- [ ] Step 4: Run `go test -race ./...`. It must PASS, repeated 5 times.
- [ ] Step 5: Commit: `feat(server): websocket + HTTP layer, registry, bounded send queues`.

### Task S5: Shutdown, backups, ops scripts and runbook

Read spec §3.1 (Shutdown) and §9.

**Files:**
- Modify: `server/cmd/mcserver/main.go` to handle `signal.NotifyContext(SIGTERM, SIGINT)` and the
  shutdown order:
  1. Stop the listener: `srv.Shutdown` with a 1 s context, so hijacked sockets stay open.
  2. `registry.StopAll()`: stops the worlds, which hand over their final flush.
  3. Drain the writer: `flushCh` closed and the writer goroutine done.
  4. Close every connection in parallel, capped at 2 s.
  5. Backup.
  6. Exit 0.
- Create: `server/internal/backup/backup.go`:
  - `Snapshot(db *sql.DB, path string) error` runs `VACUUM INTO`.
  - `Upload(ctx, path, bucket string) error` shells out to `gcloud storage cp` with a 20 s
    timeout, and is skipped when the bucket is empty.
  - `Prune(bucket, keep=48)`.
  - An hourly ticker while any world is loaded.
- Create: `server/internal/e2e/sigterm_test.go` (**G5**).
- Create:
  - `server/deploy.sh`: cross-compile `GOOS=linux GOARCH=amd64 CGO_ENABLED=0`, then
    `gcloud compute scp`, then `sudo systemctl restart mcserver` over ssh. It prints what it will
    do and requires the `--yes` flag.
  - `server/vm-setup.sh`: one sudo script, idempotent. It installs `cloudflared`, creates the
    `mcserver` user and `/var/lib/mcserver`, writes `/etc/mcserver.env` (`MC_TOKEN`,
    `MC_GCS_BUCKET`) from the arguments, and installs the systemd units
    `mcserver.service` (`After=network-online.target`, `Wants=network-online.target`,
    `TimeoutStopSec=30`, `Restart=on-failure`) and `cloudflared.service`. The tunnel token is an
    argument.
  - `server/systemd/mcserver.service`
  - `server/README.md`: the runbook. It covers:
    - first-time setup: VM creation with the `gcloud` commands for an e2-micro in us-central1,
      a 10 GB disk and a service account with `storage.objectAdmin` on `minicraft-worlds`;
    - the Cloudflare Tunnel setup;
    - starting and stopping the VM;
    - deploying;
    - restoring a backup;
    - the costs.

**G5 test:**
- `go build` the binary into a temp dir and exec it with a temp DB, `-token t`, and a random port.
- Connect one client through a black-holing proxy and black-hole it.
- Connect a second client and send 10 edits. **Within 300 ms**, send `SIGTERM`.
- Assert:
  - the process exits within 10 s, with code 0;
  - after a restart, a fresh join's snapshot contains all 10 edits.
- Red builds, to be demonstrated: no signal handler (the 10 edits are lost, since the flush ticker
  is 1 s), and closing sockets before the flush (exit takes more than 10 s or loses edits).

- [ ] Step 1: Write `sigterm_test.go`. Run it: it must FAIL.
- [ ] Step 2: Implement the shutdown order and `backup.go`.
- [ ] Step 3: Run `go test -race ./...`. It must PASS.
- [ ] Step 4: Write the scripts, units and README.
  - Check with `bash -n`, and `shellcheck` if present.
  - `server/deploy.sh` with no `--yes` must print and exit 1.
- [ ] Step 5: Commit: `feat(server): graceful shutdown, backups, VM setup + runbook`.

### Task C1: Client protocol and snapshot codec

Read spec §4 and §5.

**Files:**
- Create: `src/net/protocol.ts`, which holds:
  - the message types, mirroring the S1 structs field for field;
  - `CLOSE` codes;
  - `PROTO = 1`;
  - `type Op = [x: number, y: number, z: number, id: number, fluid: number, color: number]`;
  - `colorToInt(hex: string): number`, `intToColor(n: number): string | null`.
- Create: `src/net/snapshot.ts`:
  - `decodeSnapshot(buf: ArrayBuffer): { seq: number; cells: Int32Array /* 6 per cell */ }`
  - `encodeSnapshot(seq, cells)` (tests only)
- Create: `src/net/protocol.test.ts`, `src/net/snapshot.test.ts`.

**Interfaces:**
- Consumes: the Go fixtures at `server/internal/proto/testdata/snapshot-small.{bin,json}`.
- Produces: everything named above. `cells` is flat: `[x, y, z, id, fluid, color, …]`.

- [ ] Step 1: Write the tests:
  - **T1:** read `snapshot-small.bin` with `fs.readFileSync`. `decodeSnapshot` must equal the
    JSON. Also check that the TS `encodeSnapshot` of the JSON decodes the same way.
    - The TS encoder writes `src/net/testdata/ts-ops.bin`. Task S1's Go test then decodes that
      file if it exists. If S1 has already run, add that Go assertion here:
      `TestDecodeTSFixture` in `server/internal/proto/`.
  - **T4:** the colour round-trip `#FFF5E0` ↔ `0x1FFF5E0`, and `#000000` → `0x1000000` (not 0).
    For fluid, an op of `fluid=0x80` survives JSON encode and decode through a `JSON.stringify`
    of an `EditOut`, and so does `0x8F`.
- [ ] Step 2: Run the tests. They must FAIL.
- [ ] Step 3: Implement, using `pako.inflateRaw` and `deflateRaw`.
- [ ] Step 4: Run `npx vitest run src/net/` and `go test ./internal/proto/`. Both must PASS.
- [ ] Step 5: Commit: `feat(net): client protocol + snapshot codec, cross-checked with Go`.

### Task C2: World primitives (hook, remote write, overlay, multiplayer eviction)

Read spec §6 ("Where remote writes live", "Unloaded chunks") and §7.1.

**Files:**
- Modify: `src/engine/world/world.ts`
- Create: `src/engine/world/overlay.ts`, `src/engine/world/overlay.test.ts`,
  `src/engine/world/world-remote.test.ts`

**Code** (world.ts additions):
```ts
/** Called with (x,y,z) after every setBlock/setBlockFlow. null in solo. Never called by writeRemote. */
onLocalWrite: ((x: number, y: number, z: number) => void) | null = null;
/** Multiplayer overlay: applied to a chunk right after generation, before lighting. null in solo. */
overlay: ChunkOverlay | null = null;
/** Multiplayer: a modified chunk is evictable (generation + overlay rebuild it). */
modifiedPins = true;
```
- In `ensureChunk`, after `generateChunk(...)` and **before** `fillChunkLights`:
  ```ts
  if (this.overlay) this.overlay.applyTo(c);
  ```
- At the end of `setBlock` and `setBlockFlow`: `this.onLocalWrite?.(x, y, z);`
- New method:
  ```ts
  /**
   * Remote (server-sequenced) write: setBlock/setBlockFlow semantics — liquid frontier wake included (spec §6,
   * G1: without the wake water froze when its simulating client left) — but never the onLocalWrite hook.
   * Returns false when the chunk isn't loaded (the caller already updated the overlay) or nothing changed.
   */
  writeRemote(x: number, y: number, z: number, id: BlockId, fluid: number): boolean {
  	if (!this.inBounds(x, y, z)) return false;
  	const { cx, cz, lx, lz } = worldToChunk(x, z);
  	const c = this.getChunk(cx, cz);
  	if (!c) return false;
  	const i = indexOf(lx, y, lz);
  	const oldFluid = c.fluidMeta.get(i) ?? 0;
  	if (c.blocks[i] === id && oldFluid === fluid) return false;
  	c.set(lx, y, lz, id);
  	if (isLiquid(id)) c.hasLiquid = true;
  	if (fluid === 0) c.fluidMeta.delete(i); else c.fluidMeta.set(i, fluid);
  	if (oldFluid !== fluid) { c.dirty = true; c.rev++; }  // spec §6: a meta-only change must remesh
  	c.modified = true;
  	for (const [ox, oy, oz] of [[0,0,0],[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) this.markLiquidFrontier(x + ox, y + oy, z + oz);
  	return true;
  }
  ```

**`overlay.ts`:** `class ChunkOverlay`
- Storage: `Map<number /*chunkIndex*/, Map<number /*indexOf(lx,y,lz)*/, [id, fluid, color]>>`.
- Methods:
  - `set(x, y, z, id, fluid, color)` is idempotent.
  - `loadSnapshot(cells: Int32Array)`
  - `applyTo(c: Chunk)`: writes `c.blocks` directly and `fluidMeta`, sets
    `c.hasLiquid ||= isLiquid(id)`, and **does not** set `modified`.
  - `colorsIn(cx, cz): Array<{x, y, z, color}>`: the loop uses it to restore lamp colours when a
    chunk arrives.
  - `size` (cell count).

**Eviction:** `loop.evict()` belongs to C3. C2 only adds `modifiedPins`.

- [ ] Step 1: Write the tests:
  - **T5** (`overlay.test.ts`):
    - `World.create(seed 3)` with an overlay that holds a vertical AIR shaft from the surface
      down 10 blocks at an unloaded column.
    - `ensureChunk` that chunk; the cell at the bottom of the shaft reads `getSky === 15`.
    - Red build: the overlay applied after `fillChunkLights` gives 0.
    - Also check that `hasLiquid` becomes true when the overlay holds water in a dry chunk.
  - **T6** (`world-remote.test.ts`): `writeRemote` on an unloaded chunk returns false, and
    `world.chunkCount` is unchanged.
  - **T2:**
    - Load a chunk with water. `writeRemote` AIR next to it. The water cell is in
      `liquidFrontier`.
    - **Control:** a fresh world, then `setBlock` on the same cell. The frontier sets are equal.
    - Red build: the no-wake `writeRemote` fails.
  - **Hook:** `setBlock` calls `onLocalWrite` once with (x, y, z); `writeRemote` never does;
    `setBlockFlow` does.
  - **Meta-only:** `writeRemote` with the same id and a new fluid bumps `rev` and sets `dirty`.
- [ ] Step 2: Run the tests. They must FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Run `npx vitest run src/engine/world/`, then all tests with `npx vitest run`. They
  must PASS. Solo behaviour is untouched because the hooks are null.
- [ ] Step 5: Commit: `feat(world): remote write, local-write hook, MP chunk overlay`.

### Task C3: GameLoop remote batches, and liquid convergence

Read spec §6 (all of it).

**Files:**
- Modify: `src/game/loop.ts`
- Create: `src/game/remote-batch.test.ts`, `src/game/mp-liquid.test.ts`
- The test harness uses `src/game/test-loop.ts`, which already builds a renderer-less loop.

**Code** (loop.ts):
```ts
/** Remote ops waiting to be applied (spec §6: ≤ REMOTE_OPS_PER_FRAME per frame; chunk resolved at apply time). */
private remoteQueue: Op[] = [];
static readonly REMOTE_OPS_PER_FRAME = 2000;
/** Multiplayer: set by main.ts. Its overlay is updated at receive time, before queueing. */
mp: { overlay: ChunkOverlay } | null = null;

/** Queue a server-sequenced batch. The overlay is updated now (idempotent); chunk writes happen in drainRemote. */
enqueueRemote(ops: readonly Op[]): void {
	for (const op of ops) this.mp?.overlay.set(op[0], op[1], op[2], op[3], op[4], op[5]);
	for (const op of ops) this.remoteQueue.push(op);
}

/** Apply up to REMOTE_OPS_PER_FRAME queued ops. Called from tickBody (see the paused-branch rule below). */
drainRemote(): void {
	if (this.remoteQueue.length === 0) return;
	const n = Math.min(this.remoteQueue.length, GameLoop.REMOTE_OPS_PER_FRAME);
	const ops = this.remoteQueue.splice(0, n);
	const batch = this.newBatch();
	let anchor: { x: number; y: number; z: number } | null = null;
	for (const [x, y, z, id, fluid, color] of ops) {
		if (!this.world.getChunk(Math.floor(x / 16), Math.floor(z / 16))) continue; // overlay already has it
		const oldId = this.world.getBlock(x, y, z);
		const oldColor = this.lights?.getColor(x, y, z) ?? null;
		const newColor = intToColor(color);
		if (oldId === id && oldColor === newColor && (this.world.getChunk(Math.floor(x / 16), Math.floor(z / 16))!.fluidMeta.get(indexOfWorld(x, y, z)) ?? 0) === fluid) continue;
		if (oldId !== id) this.clearBlockEffects(x, y, z, oldId, false);
		this.world.writeRemote(x, y, z, id, fluid);
		if (id === LAMP_ID && newColor) { this.lights?.remove(x, y, z); this.lights?.add(x, y, z, newColor); }
		this.batchCell(batch, x, y, z);
		anchor ??= { x, y, z };
	}
	if (anchor) this.routeBatch(batch, anchor);
	this.liftPlayerIfInside();
}
```
- `indexOfWorld` is a small local helper: `indexOf(x - cx*16, y, z - cz*16)`.
- `drainRemote()` is called in `tickBody` **only when not paused**. In multiplayer, "paused" means
  frozen, the inventory open, or disconnected.
  - **Exception:** inventory-open must not stall remote ops. In `tickBody`'s paused branch, call
    `drainRemote()` too when `this.mp && !this.mpDisconnected`.
  - Add a field `mpDisconnected = false` that main.ts sets. While it is true, the paused branch
    must **not** run `simulate` (the existing code already skips it).
- `liftPlayerIfInside()`: if `playerBox(this.player.position)` overlaps any solid cell, set
  `this.player.position = findSafeSpawn(this.world, [px, py, pz])` and zero the vertical
  velocity. This is **T14**.
- `evict()`: change `!c.modified` to `(!c.modified || !this.world.modifiedPins)`.
- **Lamp colours on chunk arrival:** in `prepareChunk`, when `!existed && this.mp`, call
  `lights.add` for each entry of `this.mp.overlay.colorsIn(cx, cz)`.

**T3 harness** (`mp-liquid.test.ts`). Port the gate-1 probe logic. The engine reviewer's copies are
in the scratchpad (`zz-mp-liquid.probe.test.ts`); read them first. The harness:
- **Clients:** two `World` + `LiquidScheduler` pairs (A and B) and a single-client reference R,
  all `World.create(seed)` with the same seed.
- **Sequencer:** a queue of `{by, ops}` with configurable per-client latency.
- **Collecting ops:** each client's local writes are collected through `world.onLocalWrite`,
  reading the id and fluid at flush time, once per tick.
- **Echo-skip:** spec §6, implemented in the test with the same small function Task C4 exports
  (`shouldApplyEcho`). If C4 hasn't landed, inline an identical copy and leave a
  `// replaced by import in C4` comment. C4 must replace it.
- **Scenarios:**
  1. pour;
  2. A pours, then leaves at t = 1 s (A stops ticking and sending);
  3. A mines the source while B is still spreading, with 0.3–1.5 s latency;
  4. B's tab stalls (B doesn't tick for 3 s, then catches up).
- **Coverage:** seeds 1, 2, 3, 5, 8, 13. dt sequences are 1/60, 1/30 + jitter, 1/144, and 0.1 s
  spikes. Use a deterministic PRNG from `src/data/prng.ts`.
- **Assert:** after settling (20 simulated seconds with no writes), **A == R and B == R** over
  every block and fluidMeta of the touched chunks.
- **Red build:** a flag `REMOTE_NO_WAKE` in the test swaps `writeRemote` for a copy without
  `markLiquidFrontier`. The test runs scenario 2 once with the flag and asserts that it **fails**,
  which proves the instrument can go red.

Other tests, in `remote-batch.test.ts`:
- **T8:** A primes a TNT at P, then `enqueueRemote([[P…, AIR, 0, 0]])` and `drainRemote()`. After
  simulating 5 s, nothing detonated: the blocks around P are intact.
- **T14:** a remote op places stone in the player's feet cell; after the drain the player is not
  inside a solid.
- **Slicing:** enqueue 5,000 ops; after 1 drain, 2,000 are applied and 3,000 remain; after 3
  drains, all are applied.
- **Unloaded:** an op to an unloaded chunk leaves the chunk count unchanged, updates the overlay,
  and then appears when the chunk generates.
- **Eviction:** with `world.modifiedPins = false`, a modified chunk beyond `DATA_RADIUS` is
  dropped by `evict()`. With `true` (solo), it is kept.

- [ ] Step 1: Write both test files. Run them: they must FAIL.
- [ ] Step 2: Implement the loop changes.
- [ ] Step 3: Run `npx vitest run src/game/`. It must PASS. Then run all tests. The whole suite is
  green, so solo is unchanged.
- [ ] Step 4: Commit: `feat(loop): apply remote batches (sliced, woken, effects cleared) + liquid convergence test`.

### Task C4: MpSync and MpClient (echo rule, flush, extras, connection state machine)

Read spec §3.1 (Liveness), §5, §6 (Echo rule), §7.1 (MpSync) and §7.5.

**Files:**
- Create: `src/net/echo.ts` with `shouldApplyEcho(pending: Map<string, number>, key: string, cid: number): boolean`.
  It applies the echo unless `pending.get(key)! > cid`, and deletes `key` when `pending.get(key) === cid`.
- Create: `src/net/mp-sync.ts` with `class MpSync`, which implements the `AutoSave`-shaped interface
  `{ markDirty(): void; flush(): Promise<void> }` that main.ts needs.
- Create: `src/net/mp-client.ts` with `class MpClient`: socket, ping, silence watchdog, close-code
  handling and `hello`.
- Create: `src/net/mp-sync.test.ts`, `src/net/mp-client.test.ts`, `src/net/echo.test.ts`
- Modify: `src/game/mp-liquid.test.ts`: import `shouldApplyEcho` and delete the inline copy.

**`MpSync`:**
- **Constructor:**
  `(world: World, lights: LightRegistry | null, send: (msg: object) => void, getExtras: () => unknown, storage: Storage /* sessionStorage */)`.
- **`record(x, y, z)`**, installed as `world.onLocalWrite`: adds `"x,y,z"` to the frame's
  `touched` set.
- **`flushFrame()`**, called once per tick by main.ts:
  - Build ops for every touched cell. Read `world.getBlock`, the fluid (`chunk.fluidMeta` or 0)
    and `colorToInt(lights.getColor(...))` at this moment (spec §7.1, the lamp colour gate).
  - Split into messages of at most 2,000 ops. Each message gets `cid = ++this.cid`.
  - Record `pending.set(key, cid)` for each op, then `send({t:'edit', cid, ops})`.
- **`onEdit(msg: EditOut, you: number)`:** for each op, if
  `msg.by === you && !shouldApplyEcho(pending, key, msg.cid)`, drop it from the list. Otherwise
  keep it. Pass the kept ops to `loop.enqueueRemote`, through a callback given at construction:
  `apply: (ops: Op[]) => void`.
- **`markDirty()`:** debounces 5 s, then `send({t:'extras', data: getExtras()})`. Also writes
  `storage['mp:extras']` on every call.
- **`flush()`:** sends extras now.
- **`resendStashed()`:** called after `welcome`. If `storage['mp:extras']` exists, send it, then
  delete it.

**`MpClient`:**
- **Constructor:**
  `(url: string, token: string, hello: Hello, handlers: { onWelcome, onSnapshot, onMessage, onState(state: 'connecting'|'open'|'lost'|'fatal', code?: number) }, clock = { setInterval, clearInterval, now: Date.now })`.
- **Transport:**
  - `ws = new WebSocket(url.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(token))`
    with `binaryType = 'arraybuffer'`.
  - The `ping` is sent from `setInterval` (2 s) whenever nothing was sent in the last 2 s.
  - Watchdog: no message for 6 s → `ws.close()` and state `lost`.
- **Close codes:**

  | Code | State |
  |---|---|
  | 4001, 4004, 4005, 4006, 4007, 4008, 4009 | `fatal` |
  | anything else | `lost` |

- **Consecutive 4003 counter:** `sessionStorage['mp:resync']`. A second consecutive 4003 turns
  into `fatal` with code 4004. The counter resets after a `welcome`.

**Tests:**
- **T7** (`echo.test.ts` and `mp-sync.test.ts`):
  - A fake `send` and a fake `apply`.
  - Place then mine quickly on the same cell (two flushes, cids 1 and 2). Receive echo 1, then
    echo 2. `apply` never receives the stone op from echo 1: no flicker. The final state is air.
  - A foreign op on that cell with seq between the two echoes: after everything, the value equals
    the highest-seq op (the author's mine).
  - Red builds: always applying the echo shows the stone op, and always skipping it breaks the
    foreign-op case.
- **T15:**
  - A world plus a `LightRegistry` stub. Simulate `loop.placeBlock` ordering: `setBlock`, which
    fires `record`, then `lights.add(…,'#FF8A99')`.
  - `flushFrame` sends an op with `color === colorToInt('#FF8A99')`.
  - Red build: a record that reads the colour inside the hook sends 0.
- **T16:** `markDirty` then advance fake timers 5 s → one `extras` sent. A stash written;
  construct a new `MpSync`, call `resendStashed` → `extras` sent, and the stash cleared.
- **MpClient** with a fake `WebSocket` class:
  - no messages for 6 s → state `lost`;
  - close 4009 → `fatal`;
  - 4003 twice → `fatal` with code 4004;
  - `ping` is sent with only `setInterval` running, with no rAF involved.

- [ ] Step 1: Write the tests. Run them: they must FAIL.
- [ ] Step 2: Implement.
- [ ] Step 3: Run `npx vitest run src/net/ src/game/mp-liquid.test.ts`. It must PASS.
- [ ] Step 4: Commit: `feat(net): MpSync (echo rule, per-frame flush, extras) + MpClient`.

### Task C5: Remote players

Read spec §7.3.

**Files:**
- Create: `src/data/skins.data.ts`:
  `export const SKINS = [{id:'red',color:'#E53935'},{id:'blue',color:'#1E88E5'},{id:'green',color:'#43A047'},{id:'yellow',color:'#FDD835'},{id:'purple',color:'#8E24AA'},{id:'orange',color:'#FB8C00'},{id:'pink',color:'#EC407A'},{id:'black',color:'#212121'}] as const; export type SkinId = typeof SKINS[number]['id'];`
- Create: `src/game/pose-buffer.ts`:
  `class PoseBuffer { push(t: number, p: Pose): void; sample(now: number): Pose | null }`, with a
  delay of **200 ms**, linear interpolation, and a snap when consecutive samples are more than
  8 blocks apart.
- Create: `src/engine/render/remote-players.ts`:
  `class RemotePlayers { constructor(scene: THREE.Scene); upsert(id, name, skin); remove(id); pushPose(id, t, pose); update(now: number, camera: THREE.Camera): void; positions(): Array<{id, name, skin, x, y, z}> }`
  - The box: `BoxGeometry(0.6, 1.8, 0.6)` in the skin colour, with a darker front face.
  - The label: a `Sprite` with a `CanvasTexture` (white background, border in the skin colour,
    bold 32 px text), `depthTest: false`, `renderOrder: 999`.
  - Minimum on-screen height: 20 px. Each frame, scale the sprite so that its projected height
    is at least 20 px.
- Create: `src/game/pose-buffer.test.ts`, `src/engine/render/remote-players.test.ts`

- [ ] Step 1: Write the tests:
  - **T10:** samples at t = 0 (x = 0) and t = 100 (x = 1). `sample(250)` (render time 50) gives
    x = 0.5. A jump of 20 blocks snaps instead of interpolating. `sample` before any data gives
    null.
    - Red build: rendering the latest sample gives x = 1 at t = 250.
  - `RemotePlayers`: `upsert` adds one group to the scene; `remove` removes it and disposes of
    it. The label material has `depthTest === false`.
    - At a distance of 100 blocks with a 75° FOV and an 800 px canvas, the label's projected
      height is at least 20 px.
- [ ] Step 2: Run the tests. They must FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Run the tests. They must PASS.
- [ ] Step 5: Commit: `feat(mp): remote player avatars, labels, pose interpolation`.

### Task C6: Minimap

Read spec §7.6.

**Files:**
- Create: `src/ui/minimap-model.ts`, holding the pure geometry:
  - `toMap(px, pz, yaw, ox, oz, radiusBlocks, radiusPx): { x: number; y: number; clamped: boolean }`
  - `heightArrow(dy: number): '▲' | '▼' | ''` (threshold > 8)
  - `columnColor(topId: number, table: Uint8Array): [r, g, b]`
- Create: `src/ui/minimap.ts`:
  - `class Minimap { constructor(app: HTMLElement, colorTable: Uint8Array); update(now, world, player, yaw, others: Array<{x, y, z, skin}>) }`
  - A canvas 160 px across. It redraws at 10 Hz and caches heights per chunk by `rev`, at most 4
    chunk rebuilds per frame.
- Create: `src/engine/render/block-colors.ts`:
  `buildColorTable(atlas): Uint8Array` gives the mean top-face colour per block id, 3 bytes each.
- Modify: `src/ui/ui.css`: `#minimap` (bottom-left, `border-radius: 50%`, 3 px white border,
  above the hotbar's z-index).
- Create: `src/ui/minimap-model.test.ts`

- [ ] Step 1: Write the tests (**T11**):
  - The player at the origin facing +z (yaw is the camera convention; read
    `src/engine/render/camera.ts`). A friend 10 blocks straight ahead maps to (0, −r·10/48): up on
    the screen.
  - The same friend with the player turned 90° appears to the side.
  - A friend 200 blocks away maps to the rim (`clamped: true`), in the right direction.
  - `heightArrow(9) === '▲'`, `heightArrow(-9) === '▼'`, `heightArrow(8) === ''`.
  - `columnColor` of a known block id returns the table's entry.
  - Red build: a bearing that ignores yaw fails the rotation case.
- [ ] Step 2: Run the tests. They must FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Run the tests. They must PASS.
- [ ] Step 5: Commit: `feat(mp): round rotating minimap`.

### Task C7: Client spawn and leaving countdown

Read spec §7.2 and §7.4.

**Files:**
- Create: `src/game/mp-spawn.ts`:
  `resolveMpSpawn(world: World, seed: number, spawn: Spawn): { pos: [number, number, number]; yaw: number; pitch: number }`
  - `first`: `spawnV3(seed)`, then `findSafeSpawn`.
  - `return`: `findSafeSpawn(stored)`, with the stored yaw and pitch.
  - `near`: for `d` in 3..6, and angles 0, ±30°, ±60° around the target's facing, take the column
    at the target's position plus `d` along that direction. Accept it when it is **standable**:
    - the ground `y` is within ±4 of the target's feet y;
    - the ground block is solid and not liquid;
    - the two cells above it are air.

    The first match wins. Otherwise use the target's own position. Yaw faces the target.
- Create: `src/game/leaving.ts`:
  `class LeavingCountdown { constructor(send: (secondsLeft: number) => void); update(remainingMs: number): void }`
  - Thresholds `[120, 60, 30, 0]` seconds.
  - On the first `update`, if `remaining < 120 s`: send `ceil(remaining / 1000)` immediately and
    mark every threshold ≥ remaining as fired.
  - Afterwards, every crossed threshold is marked. A tick that crosses one or more unfired
    thresholds sends once, with the lowest crossed threshold value. That handles 2 s jumps.
- Create: `src/game/mp-spawn.test.ts`, `src/game/leaving.test.ts`

- [ ] Step 1: Write the tests:
  - **Spawn:**
    - `near` with the target standing on flat v3 terrain (seed 3, at `spawnV3(3)`) returns a
      position between 3 and 6 blocks away, standable, with |dy| ≤ 4.
    - A target inside a 1×2 cave pocket (build it with `setBlock`) with no standable column
      returns the target's own position.
    - `first` equals `findSafeSpawn(spawnV3)`.
  - **T9:**
    - Remaining time stepping down from 130 s in **2 s** steps sends exactly `[120, 60, 30, 0]`,
      once each, even if a step goes 121 → 119.
    - A first update at 90 s sends `[90]`; later steps send 60, 30, 0; 120 is never sent.
    - Red build: exact-second matching (`=== 120`) misses 121 → 119.
- [ ] Step 2: Run the tests. They must FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Run the tests. They must PASS.
- [ ] Step 5: Commit: `feat(mp): spawn resolution + leaving countdown`.

### Task P1: Play-time model (no breaks, parent maximum, session policy)

Read spec §1 (Refresh and its exceptions), §8 (the duration control), §8.1 and §8.3.

**Files:**
- Modify: `src/data/playtime.data.ts`:
  - Delete `PLAY_BREAK_CHOICES_MIN`.
  - Add `DURATION_CHOICES_MIN` = 10..120 in steps of 5 (23 values).
  - Keep `PLAY_LIMIT_CHOICES_MIN` only if another module still imports it. Otherwise delete it
    and point every user at `DURATION_CHOICES_MIN`.
- Modify: `src/data/keybindings.data.ts` (the `Options` type): replace
  `playLimitMin`/`playBreakMin` with `maxDurationMin: number | null` (null = No limit).
- Modify: `src/persistence/options.ts`: `loadOptions` migrates as follows:
  - if the parsed record has `maxDurationMin`, validate it against `DURATION_CHOICES_MIN` or null;
  - else if it has `playLimitMin`, use `choiceOrNull(playLimitMin, DURATION_CHOICES_MIN)`;
  - else null.
  - `playBreakMin` is ignored.
- Modify: `src/persistence/playtime.ts`:
  - `isSession` accepts any `breakMs`.
  - `loadSession` coerces `breakMs` to `null`.
  - `applyPlaytimeSetting` becomes `applyMaxDuration(max: number | null)`.
- Modify: `src/game/playtime-controller.ts`:
  - `resolveSession(stored, limitMin, now, schedule)`, with the break parameter dropped. New
    sessions have `breakMs: null`.
  - `playAgain` is deleted: no break ever ends.
- Modify: `src/game/schedule.ts`: `activeLimits(schedule, chosenMin)` returns `{ limitMin }`.
- Modify: `src/persistence/schedule.ts`: `isSchedule` validates `limitMin` against
  `DURATION_CHOICES_MIN`.
- Create: `src/game/session-policy.ts`:
  ```ts
  /** Spec §8.1: keep the stored session across this page load? */
  export function sessionPolicy(pinSet: boolean, scheduleActive: boolean, autojoin: boolean): 'keep' | 'discard' {
  	return pinSet || scheduleActive || autojoin ? 'keep' : 'discard';
  }
  /** The duration control's default and clamp (spec §8). */
  export function defaultDuration(maxMin: number | null): number | null { return maxMin === null ? null : Math.min(30, maxMin); }
  export function clampDuration(chosen: number | null, maxMin: number | null): number | null {
  	if (maxMin === null) return chosen;
  	if (chosen === null) return maxMin;
  	return Math.min(Math.max(10, chosen), maxMin);
  }
  export function stepDuration(cur: number | null, dir: 1 | -1, maxMin: number | null): number | null { /* 5-min steps 10..max; past max with maxMin===null → null (No limit); from null, −1 → 120 */ }
  ```
- Create: `src/game/session-policy.test.ts`
- **Rewrite** (do not delete) the break-dependent cases listed in spec §10:
  - `src/game/playtime.test.ts`
  - `src/game/playtime-controller.test.ts`
  - `src/persistence/playtime.test.ts`
  - `src/persistence/options.test.ts`
  - `src/ui/menu-model.test.ts` (the `Staged` shape)
  - `src/game/schedule.test.ts`

  Each old break assertion becomes the no-break equivalent: a freeze stays frozen, and
  `phaseOf` returns `'break'` with `breakMs === null` as today.

- [ ] Step 1: Write `session-policy.test.ts` (**T12**):
  - the full 2×2×2 truth table;
  - `defaultDuration(null) === null`, `defaultDuration(45) === 30`, `defaultDuration(20) === 20`;
  - `stepDuration` walks 10 → 15 → … → 120 → null (max null) and stops at 45 (max 45);
  - `clampDuration(60, 45) === 45`.
  - Options migration: `{playLimitMin: 45}` → `maxDurationMin 45`; `{playLimitMin: null}` →
    null; `{playBreakMin: 20}` → ignored.
  - Session: a stored session with `breakMs: 600000` loads with `breakMs === null`.
  - Schedule: `limitMin: 25` saves and loads; so does `limitMin: 15` (old).
- [ ] Step 2: Run the tests. They must FAIL.
- [ ] Step 3: Implement. Fix the compile errors across `src/`. `menu.ts` break UI references are
  removed minimally here (P2 rewrites the menu). `main.ts`'s call to `activeLimits` and
  `resolveSession` must still compile, so update the call sites minimally. I1 rewires them
  properly.
- [ ] Step 4: Run `npx tsc -b` and `npx vitest run`. Both must PASS, including the rewritten tests.
- [ ] Step 5: Commit: `feat(playtime): remove break time, parent max duration, session policy`.

### Task P2: Menu rework (home, Single Player, Parents)

Read spec §8, §8.1 and §8.3.

**Files:**
- Modify: `src/ui/menu.ts`. Restructure `MainMenu` into screens:
  - `renderHome()`: three big buttons. In scheduled-card mode it keeps today's card, plus a
    **Parents** button on the card.
  - `renderSingle()`: New World form, merged world list with badge and Delete, duration control,
    and Play.
  - `renderParents()`: PIN gate, then Schedule, Maximum duration, Reset states, PIN
    Set/Change/Reset, and a **placeholder container `#parents-mp-worlds`** that P3 fills.
  - `renderMulti()` is a stub that shows "Coming soon" and is replaced by P3.
- Modify: `src/ui/menu-model.ts`, adding:
  - `singleModel(input): { worlds, selectedId, duration, max }`
  - restore and persist for `minicraft:v1:menu` (`{selectedId, duration}`) in a new
    `src/persistence/menu-state.ts` (`loadMenuState`, `saveMenuState`; try/catch like the other
    stores).
  - `MenuAction` gains `duration: number | null` on `new` and `continue`, and a new
    `{type:'mp', world: string, name: string, skin: SkinId, duration: number | null}`. P3 emits it.
- Create: `src/ui/duration-control.ts`:
  `class DurationControl { constructor(parent: HTMLElement, value: number | null, max: number | null, onChange: (v: number | null) => void) }`.
  It shows a big "30 min" or "No limit" between − and + buttons, and uses `stepDuration`.
- Modify: `src/ui/ui.css` for the home buttons, the screens and the duration control.
- Modify: `src/ui/menu-model.test.ts` (**T13** part 1)

**Scheduled card Parents button:** it asks for the PIN when one is set, then calls `clearSchedule()`
and re-renders home. With no PIN it cancels directly.

- [ ] Step 1: Write the tests (**T13**, single-player part):
  - `loadMenuState` restores the selected id and duration. A stored duration above the maximum is
    clamped. With no stored duration and max null, the duration is null. With max 45, it is 30.
  - `singleModel` puts the newly created world first and selects it.
- [ ] Step 2: Run the tests. They must FAIL.
- [ ] Step 3: Implement the menu screens.
  - **Headless smoke:** extend `scripts/crafting-smoke.ts` or add `scripts/menu-smoke.ts`
    (Playwright headless, dev server on 5173 started by the script, prod API blocked, the script
    stops only the port it started).
  - The smoke clicks Single Player → New World → Create → Play. The world loads, which proves
    the menu → startGame path still works.
- [ ] Step 4: Run `npx vitest run` and `npx tsx scripts/menu-smoke.ts`. Both must PASS.
- [ ] Step 5: Commit: `feat(ui): home/Single Player/Parents menu, duration control`.

### Task P3: Multiplayer menu screens

Read spec §8.2 and §8.3 (Multiplayer worlds).

**Files:**
- Create: `src/net/mp-api.ts`:
  - `class MpApi { constructor(base: string, token: string); listWorlds(timeoutMs = 4000): Promise<MpWorldRow[]>; createWorld(name, seed, mustMine): Promise<MpWorldRow>; deleteWorld(uuid): Promise<'ok'|'occupied'> }`
  - `type MpWorldRow = {uuid, name, mustMine, createdAt, online: {name, skin}[]}`
  - All calls send `Authorization: Bearer <token>`.
- Create: `src/persistence/mp-prefs.ts`: `loadMpPrefs()` and `saveMpPrefs()` for
  `minicraft:v1:mp` = `{name, skin, worldId, bid}`. The `bid` is created with
  `crypto.randomUUID()` on first load.
- Create: `src/ui/mp-menu-model.ts`:
  - `preselect(rows, rememberedId): string | null`: the remembered world if it has players;
    otherwise the busiest world if any has players; otherwise the remembered world if it still
    exists; otherwise the first row.
  - `validName(raw): string | null`: the same rule as the server, trimmed,
    `/^[\p{L}\p{N} ]{1,16}$/u`.
- Modify: `src/ui/menu.ts`: implement `renderMulti()`:
  - **Screen 1** (name and 8 swatches) unless a name is remembered. Then screen 2 shows "Playing
    as ● Noah [change]".
  - **Screen 2:** a list refreshed every 5 s. Each row shows name, type, and dots with names. The
    busiest are listed first. New World, duration and Play.
  - **Sleeping state:** when `listWorlds` fails, show the sleeping text, retry automatically
    every 5 s, and show a Retry button.
  - Play emits `{type:'mp', …}`.
  - With no `VITE_MINICRAFT_MP_URL`, the home Multiplayer button is hidden.
  - With a schedule armed, home shows the card: no Multiplayer.
  - **`4009`:** main.ts reloads with `sessionStorage['mp:error']='name_taken'`. `renderMulti`
    shows screen 1 with "Someone called Noah is already playing. Pick another name."
- Modify: `renderParents()`: fill `#parents-mp-worlds` when `listWorlds` succeeds. Delete
  confirms with `Delete "<name>" for everyone?`; on 409 it shows "Someone is playing in it right
  now."
- Create: `src/ui/mp-menu-model.test.ts`

- [ ] Step 1: Write the tests (**T13**, multiplayer part):
  - `preselect`:
    - remembered world empty, other world has 1 player → the other world;
    - remembered world has a player → remembered;
    - nobody online, remembered exists → remembered;
    - remembered deleted → the first row.
  - `validName`: `"Noé"` ok, `" Léo "` → `"Léo"`, `""`, `"a<b"` and 17 characters → null.
  - `loadMpPrefs`: `bid` is stable across calls.
  - `MpApi.listWorlds` against a fetch that never resolves rejects within 4 s (fake timers).
- [ ] Step 2: Run the tests. They must FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Run `npx vitest run`. It must PASS.
  - Also run `menu-smoke` with `VITE_MINICRAFT_MP_URL=http://127.0.0.1:1` (a dead port): the
    Multiplayer screen shows the sleeping text, and Single Player → Play still works.
- [ ] Step 5: Commit: `feat(ui): Multiplayer screens, MP world admin in Parents`.

### Task I1: main.ts integration

Read spec §7 (all of it) and §8.1 (boot).

**Files:**
- Modify: `src/main.ts`
- Create: `src/game/boot-session.ts`:
  `bootSession(storage: {pin: string | null; schedule: LoadedSchedule; autojoin: boolean}, load: () => PlaytimeSession | null, clear: () => void): void`.
  It discards the stored session when `sessionPolicy(...) === 'discard'`. main.ts calls it
  **before** `showMenu()`.
- Create: `src/game/boot-session.test.ts` (**T12b**)
- Create: `src/ui/mp-overlays.ts`, holding the MP UI pieces:
  - the "Reconnecting…" dim overlay, with a "Try again" button and a "Menu" link after 30 s;
  - the fatal screens:
    - 4001: "You opened the game somewhere else." with a Menu button;
    - 4004/4005: "Minicraft was updated — click to reload";
    - 4006: back to the list;
  - the toasts ("Noah has to go in 2 minutes", …, "Noah went home") with a colour dot;
  - the big 10…1 countdown for the local player.

**main.ts changes:**
1. **Boot:**
   - `const autojoin = sessionStorage.getItem('mp:autojoin')`.
   - `bootSession({pin: loadPin(), schedule: loadSchedule(), autojoin: !!autojoin}, …)`.
   - If `autojoin` is set and an MP URL exists, skip the menu and call
     `startMultiplayer(JSON.parse(autojoin))` with `resume: true`.
2. **The `mp` menu action:** `sessionStorage['mp:autojoin'] = JSON.stringify({world, name, skin, duration})`,
   then `startMultiplayer(...)` with `resume: false`. The flag is removed on a clean Menu exit.
3. **`startMultiplayer(args)`:**
   - Show "Joining…" and create `MpClient`. On `welcome` plus the snapshot:
     - `const overlay = new ChunkOverlay(); overlay.loadSnapshot(cells)`
     - Build a synthetic save and call `startGame(world.uuid, world.seed, world.name, null, world.mustMine, mpSession)`.
       `mpSession` carries `{client, welcome, overlay}`.
4. **`startGame` with `mp` set:**
   - It creates the world with `new World(seed, {height, genVersion: gen, saveVersion: 3})`, then
     sets `world.overlay = overlay` and `world.modifiedPins = false`.
   - It skips `adapter.loadWorld` and legacy adoption.
   - The spawn comes from `resolveMpSpawn`.
   - Extras come from `welcome.extras`, through `resolvePlayerExtras(extras, mustMine)`.
   - **`catalogMax`** (spec §5): block ids above `welcome.catalogMax` are removed from the hotbar
     and hidden from the inventory's Blocks tab for this session. Use a filter on `BLOCKS` passed
     to `Inventory`/`resolveHotbar`. Unit-test the filter in `src/net/catalog-filter.test.ts`:
     with an id above the maximum in the hotbar, it is replaced by the default for that slot.
   - `autosave` becomes the `MpSync` instance (same shape). `world.onLocalWrite = mpSync.record`.
   - `loop.mp = {overlay}`.
   - `RemotePlayers`, `Minimap` and `LeavingCountdown` are created. Each tick:
     - `mpSync.flushFrame()`
     - `remote.update(now, renderer.camera)`
     - `minimap.update(...)`
     - `pos` is sent at ≤ 10 Hz when the position or look changed.
   - MpClient messages are routed:
     - `edit` → `mpSync.onEdit`
     - `tick` → `remote.pushPose`
     - `join`/`left` → `remote.upsert`/`remove` plus the "went home" toast
     - `fx` → `particles`/`overlay` (`prime` with a timeout of fuse + 2 s; `boom` → `spawnBreak`;
       `firework` → `spawnFirework`)
     - `leaving` → a toast
   - Local `ignite` sends `fx:prime`, and local detonations send `fx:boom`.
     - Add `loop.onDetonate: ((x, y, z, effect) => void) | null`, called in `detonateAt`.
     - This is a two-line C3-owned file change; I1 may make it, since C3 has landed by then.
   - **Playtime:**
     - The session is created at Play time with the chosen duration (a null duration means no
       controller).
     - `LeavingCountdown.update(remaining)` runs every tick.
     - On freeze: `mpSync.flush()`, close the client normally (code 1000), and clear
       `mp:autojoin`.
   - **Connection lost:**
     - `loop.mpDisconnected = true` and `loop.paused = true`; the playtime controller stops
       ticking. Show the overlay.
     - Retry at 1, 2, 4, 8 and 15 s by probing `MpApi.listWorlds()`. On success,
       `location.reload()`: the autojoin flag is still set.
     - After 30 s, show Try again (→ reload) and Menu (→ clear the flag, then reload).
5. **Solo path:** byte-for-byte the same behaviour. `mp` is undefined, so none of the above runs.

**Tests:**
- **T12b** (`boot-session.test.ts`): a stored session with each of the four policies (no PIN;
  PIN; schedule; autojoin), run through `bootSession`, is discarded only in the first case.
  - Red build: main.ts not calling `bootSession` is caught by E6 (Task I2). This unit test pins
    the function.
  - Add a source-level guard test: `src/main.test.ts` reads `src/main.ts` as text and asserts
    `bootSession(` appears **before** `showMenu(`. It is crude but can go red.

- [ ] Step 1: Write `boot-session.test.ts` and the guard. Run them: they must FAIL.
- [ ] Step 2: Implement `boot-session.ts`, `mp-overlays.ts` and the main.ts changes.
- [ ] Step 3: Run `npx tsc -b` and `npx vitest run`. Both must PASS. `npm run build` must succeed.
- [ ] Step 4: Manual headless check, via a script in the scratchpad (not committed):
  - Start `mcserver` on :8080 with a temp DB, and the dev server with
    `VITE_MINICRAFT_MP_URL=http://localhost:8080 VITE_MINICRAFT_MP_TOKEN=dev`.
  - Join from two headless pages. Each sees the other's box. Screenshot both to the scratchpad.
  - Stop both servers by port.
- [ ] Step 5: Commit: `feat(mp): wire multiplayer session into main (spawn, sync, HUD, reconnect, countdown)`.

### Task I2: Two-client end-to-end suite

Read spec §10 (the E table).

**Files:**
- Create: `scripts/mp-e2e.ts`: Playwright, headless, `chromium.launch({headless: true})`.
  - **Setup:**
    - `go build` `mcserver` into the scratchpad and start it with a temp DB, `-token e2e`, on
      :18080.
    - Start `vite` on :5174 with `VITE_MINICRAFT_MP_URL=http://localhost:18080`,
      `VITE_MINICRAFT_MP_TOKEN=e2e` and `VITE_MINICRAFT_API_URL=http://127.0.0.1:1`, so the prod
      API is never reachable. Also `page.route` any `*.run.app` host to abort.
    - Add `http://localhost:5174` to the server's `-origins`.
  - Two browser contexts, A and B. Each uses `window.__mc` (dev only) for oracle reads.
  - **Hashes:** the world hash of a set of chunks is FNV-1a over `blocks` plus sorted `fluidMeta`
    entries.
  - **Teardown:** `fuser -k 18080/tcp 5174/tcp` in a `finally`, only for the ports it started.
- **Extend the `__mc` debug object in main.ts (DEV only)** with:
  - `mp: { sync, client, remote, overlay }`
  - `worldHash(cxs)`
  - `refReplay(actions)`: builds a fresh `World` from the same seed plus the snapshot, replays the
    given actions single-client with a `LiquidScheduler` until settled, and returns the hash. This
    is the E2/E3 reference.
- Add the script `"e2e:mp": "tsx scripts/mp-e2e.ts"` to `package.json`.

**Scenarios** (each prints PASS/FAIL, and the script exits 1 on any FAIL):
- **E1:** A places stone at a known cell via `__mc`; B polls `getBlock` and must see it within
  500 ms. B mines it; A sees air.
- **E2:** A pours water (places a water source) 5 blocks from B, who is in range. After both are
  quiet for 15 s, each hash equals `refReplay`.
- **E3:** A primes TNT next to a pond. After it settles, `hash(A) == hash(B) == refReplay`. B's
  log shows an `fx` boom.
- **E4:** B's `remote.positions()` includes A. The minimap canvas pixel at A's projected spot
  isn't the background colour.
- **E5:** A's session is set to 125 s remaining (DEV hook `__mc.playtime.setRemaining`). Advance
  real time, or use a 10× clock via a DEV query flag `?mpclock=10`. B receives `leaving` 120, 60,
  30 and 0, and then `left`.
- **E6:**
  - Record A's position and remaining time.
  - `fuser -k 18080/tcp`. A shows the Reconnecting overlay (DOM check).
  - Restart the server on the same DB. A reloads by itself and rejoins.
  - The position is within 1 block of before, the world hash is unchanged, and the remaining
    time is within ±2 s, with no PIN set.
- **E7:**
  - A fresh context with `WebSocket` wrapped by `addInitScript` to count constructions.
  - Single Player → New World → Play: zero WebSocket constructions.
  - With `VITE_MINICRAFT_MP_URL` on a dead port (second vite run on :5175), Single Player still
    plays. The Multiplayer screen says sleeping.

- [ ] Step 1: Write the script. Run it on the current branch; it must pass.
  - Then **prove two instruments can go red**:
    - Temporarily make `writeRemote` skip `markLiquidFrontier` and run E2 alone
      (`--only E2`). It must FAIL. Revert.
    - Temporarily make `bootSession` always discard, and run E6. It must FAIL. Revert.
  - Record both red runs in the commit message.
- [ ] Step 2: Commit: `test(mp): two-client end-to-end suite (E1–E7)`.

### Task D1: Docs, sync test and CLAUDE.md

Read spec §11.

**Files:**
- Create: `docs/multiplayer.md`:
  - the architecture diagram;
  - the protocol tables (messages, close codes), copied from the implemented code;
  - the consistency model;
  - the runbook summary, linking to `server/README.md`.
- Create: `src/net/multiplayer-docs.test.ts`. It parses the message-type and close-code tables in
  `docs/multiplayer.md` and asserts they equal the keys and values in `src/net/protocol.ts`, and
  that every close code appears in `server/internal/proto/proto.go` (text grep).
- Modify: `docs/playtime.md` (break removed, the maximum, the refresh rule and its exceptions),
  `docs/specs.md` (the Go/SQLite/tunnel stack) and `docs/performance.md`.
  - For `performance.md`, measure `Minimap.update` on the perf bench (`npm run perf:bench` via
    `xvfb-run`) and record the ms.
- Modify: `CLAUDE.md`:
  - Remove multiplayer from the non-goals, and add a line that multiplayer exists as a private
    two-family feature.
  - Layout: add `server/` and `src/net/`.
  - Warning: never point tests at `mc.leap-forward.ca`. The multiplayer server's data lives in
    the VM's `/var/lib/mcserver` and in `gs://minicraft-worlds/mp-backups`.

- [ ] Step 1: Write the docs sync test. Run it: it must FAIL (no doc yet).
- [ ] Step 2: Write the docs. Run the test: it must PASS. Run the full `npx vitest run` and
  `go test ./...`.
- [ ] Step 3: Commit: `docs(mp): multiplayer.md, playtime/specs/perf updates, CLAUDE.md`.
