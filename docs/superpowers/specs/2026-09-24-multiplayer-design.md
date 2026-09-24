# Multiplayer — design

Date: 2026-09-24 · Branch: `multiplayer` · Status: draft, pre-gate-1

## 1. Intent

Noah wants to play with his best friend, who lives 45 minutes away. Both are
7 and love Minecraft. We add a small, private multiplayer mode: up to ~10
players (25 is a stretch goal), on a cheap VM that Julien starts **by hand
only when needed**.

What Julien said (binding):

- Solo play stays exactly as it is: no account, current saves, current API,
  no changes to the API.
- The deployed API (Cloud Function + `gs://minicraft-worlds`) is always up.
  The multiplayer server and its database are **not**: the VM is off most of
  the time. Solo must never depend on it.
- Server in an efficient compiled language (Go chosen). Database: whatever
  stores levels with differential updates in near real time (SQLite chosen).
- Players see each other move in real time, with a floating name label.
  Avatars start as coloured boxes; skins and animation come later.
- Block changes are saved as differential updates, never whole maps.
- A round, GTA-style minimap sits bottom-left and shows players; off-map
  players are pinned to the rim.
- The play-time limit applies in multiplayer too. The others see a broadcast
  countdown for 2 minutes before a player's time runs out.
- Kids pick a duration. A parent caps the maximum. Break time is removed.
- Security: no auth beyond a static token shipped in the frontend. Julien
  accepts that the token is readable.
- The VM is started by hand. There is no wake-up automation.

Assumptions (flag if wrong):

- **A1.** Names are unique only among the players online in a world. Two kids
  choosing the same name on different days share one inventory and one last
  position on that world.
- **A2.** One timer budget per browser, shared by solo and multiplayer (as
  today).
- **A3.** Multiplayer worlds live only on the VM. They are not mirrored to
  GCS. A lost VM disk loses multiplayer worlds (backups are §9, optional).
- **A4.** No chat, no emotes, no animation, no anti-cheat.

CLAUDE.md lists multiplayer as a hard non-goal. This project deliberately
overrides that line. §11 updates CLAUDE.md.

## 2. What already exists (facts the design relies on)

- **World:** finite, 32×32 chunks of 16×H×16 (H = 256 for v3), stored as a
  `Uint16Array` per chunk plus a sparse `fluidMeta`.
- **Generation:** `generateChunk(chunk, seed, genVersion)` is a pure function,
  **bit-exact across machines** (banned-API rule and golden hashes in
  `docs/worldgen.md`).
- **Solo saves are already differential:** only modified chunks are saved;
  unmodified ones regenerate from the seed. Solo persistence is **unchanged**
  by this project.
- **Mutation points:**
  - `World.setBlock` (`world.ts:95`) and `World.setBlockFlow` (`world.ts:119`)
    sit over `Chunk.set`.
  - Callers: mining, area-mine and TNT (`loop.removeBlocks`), TNT builds
    (`loop.placeBlocks`), place and replace, liquid scheduler steps, and
    `applySave`.
  - Fireworks and pads do not write blocks.
- **Simulation:** liquids (0.5 s accumulator) and TNT fuses run locally in
  `GameLoop.simulate`, dt-driven. There is no `Math.random` in world logic.
  Liquids simulate only within the loaded ring around the local player.
  `LiquidScheduler.seedArrival` seeds liquid that can act when a chunk mounts.
- **Playtime:** a `PlayTimer` session per browser (`minicraft:v1:playtime`).
  A 4-digit PIN (`minicraft:v1:pin`) gates Grown-ups. A schedule
  (`minicraft:v1:schedule`) locks the menu to one world and a start time.
- **Scene and HUD:** `renderer.scene` is public, and the HUD is plain DOM
  under `#app`.
- **Build:** the site reads `VITE_MINICRAFT_API_URL` at build time.

## 3. Architecture

```
browser (static site, unchanged hosting)
  ├── solo:  DualAdapter → localStorage + always-on Cloud Function API  (unchanged)
  └── multi: MpClient ──wss──▶ Cloudflare (proxied DNS) ──▶ VM: Caddy :443 ──▶ mcserver :8080
                                                                          └─ SQLite (WAL) on persistent disk
```

- **`server/`** is a new top-level directory holding a Go module: one binary,
  `mcserver`. Dependencies:
  - `github.com/coder/websocket` for WebSocket.
  - `modernc.org/sqlite`, pure Go with no cgo, which keeps the cross-compile
    trivial.
- **Transport:** one WebSocket per player: `wss://<MP host>/ws?token=…`.
  Plain HTTP `GET /worlds` (with the token) serves the world list and doubles
  as the health check. The site reads two new build-time variables:
  - `VITE_MINICRAFT_MP_URL`, e.g. `https://mc.leap-forward.ca`. If it is
    unset, the Multiplayer button is hidden.
  - `VITE_MINICRAFT_MP_TOKEN`
- **Messages:** JSON text frames. At 25 players × 10 Hz, position fan-out is
  about 6k small messages per second, trivial for Go. Binary framing is a
  later optimisation, not v1.
- **The server never runs world generation or simulation.** It is an ordering
  and persistence relay with a little game knowledge: spawn rules, inventory
  storage, and the online count.

## 4. Data model (SQLite)

```sql
CREATE TABLE worlds (
  id          TEXT PRIMARY KEY,         -- uuid, server-issued
  name        TEXT NOT NULL,
  seed        INTEGER NOT NULL,
  gen_version INTEGER NOT NULL,         -- pinned at creation; clients refuse a version they can't generate
  height      INTEGER NOT NULL,         -- 256
  must_mine   INTEGER NOT NULL,         -- 1 = Mining, 0 = Sandbox
  created_at  INTEGER NOT NULL,
  last_seq    INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE blocks (                   -- the differential state: latest value per edited cell
  world_id TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,
  id INTEGER NOT NULL, fluid INTEGER NOT NULL DEFAULT 0,   -- fluid: fluidMeta value, 0 = none
  seq INTEGER NOT NULL,
  PRIMARY KEY (world_id, x, y, z)
) WITHOUT ROWID;
CREATE TABLE lights (world_id TEXT, x INTEGER, y INTEGER, z INTEGER, color INTEGER,
  PRIMARY KEY (world_id, x, y, z)) WITHOUT ROWID;          -- coloured-lamp registry, same diff idea
CREATE TABLE players (
  world_id TEXT NOT NULL, name_key TEXT NOT NULL,          -- name_key = lower(trim(name))
  name TEXT NOT NULL, skin TEXT NOT NULL,
  x REAL, y REAL, z REAL, yaw REAL, pitch REAL,            -- null = never joined
  extras TEXT NOT NULL DEFAULT '{}',                       -- JSON: inventory, tools, hotbar, selected (the PlayerSave extras shape)
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (world_id, name_key)
);
```

- **Edits** are applied to an in-memory map per loaded world as they arrive.
  Dirty cells are flushed in one transaction every 1 s, and on shutdown via
  SIGTERM, which a GCP stop sends.
- **Worst-case loss:** a VM hard crash loses up to 1 s of edits.
- A world is loaded into memory when its first player joins and unloaded
  60 s after its last player leaves.
- **A block the player breaks back to its generated value still keeps its
  row.** The server can't know generated values. This is harmless:
  replaying it writes the same id.

## 5. Protocol

Every message is `{"t": "<type>", ...}`.

**Client → server**

| t | fields | meaning |
|---|---|---|
| `hello` | `world, name, skin, proto` | join a world (first message) |
| `pos` | `x,y,z,yaw,pitch` | ≤ 10 Hz, only while moving or turning; send on change, and every 2 s as a heartbeat |
| `edit` | `ops: [[x,y,z,id,fluid], …], cause` | a batch of block changes this client made; `cause` ∈ `mine`, `place`, `tnt`, `liquid`, `replace` |
| `light` | `x,y,z,color` or `color:null` | lamp colour registry change |
| `fx` | `kind, x,y,z, …` | cosmetic only: `prime` (TNT fuse started), `firework`, `break` |
| `extras` | `{inventory,tools,hotbar,selected}` | this player's saved extras, debounced 5 s and on leave |
| `leaving` | `secondsLeft` | play-timer countdown broadcast (§7.4) |

**Server → client**

| t | fields | meaning |
|---|---|---|
| `welcome` | `you, world{…}, spawn{mode,x,y,z}, extras, players[], seq` | join accepted; the snapshot follows |
| `snapshot` | `seq, blocks: base64(deflate(packed rows)), lights[]` | all edited cells as of `seq` |
| `edit` | `seq, by, ops` | authoritative, server-ordered, **sent to everyone including the author** |
| `pos` | `id, x,y,z,yaw,pitch` | relayed (not echoed to the author) |
| `join` / `left` | `id, name, skin` / `id` | presence |
| `light`, `fx`, `leaving` | `by, …` | relayed |
| `error` | `code, message` | `name_taken`, `bad_token`, `unknown_world`, `gen_unsupported`, `proto` |

- **Snapshot packing:** rows are sorted by (x, z, y) and packed as varints:
  x, y, z, id, fluid. For a world with 100k edited cells, that is about 600 KB
  before deflate and well under 200 KB after.
- **Ordering guarantee:** the snapshot and all live edits after it come from
  one goroutine per world, so no edit can fall between the snapshot and the
  stream.

**HTTP**

- `GET /worlds` returns `[{id,name,mustMine,online,createdAt}]`, sorted by
  online count descending, then `createdAt` descending.
- `POST /worlds {name, seed, mustMine}` returns the world. `gen_version` is
  set from a server constant equal to the client's current generator version
  (3).

## 6. Consistency model

- **Server order is truth.** The server stamps each incoming `edit` batch with
  the next `seq` and broadcasts it to **every** client in the world,
  author included.
- **The client** applies its own change immediately (optimistic), then applies
  every server `edit` in `seq` order, including its own echo.
- **Result:** if A places and B mines the same cell concurrently, both clients
  end with whatever the later-sequenced op wrote. There may be a brief
  flicker, and nobody diverges permanently. (Proof sketch: every client's
  final value for a cell is the value of the highest-`seq` op on it, because
  that op is applied last everywhere.)
- **Remote edits are written with a new `World.applyRemote(x,y,z,id,fluid)`.**
  It sets the block and the fluid meta. It remeshes and relights like a
  normal write, but it **does not wake the liquid scheduler** and does not
  touch the inventory.
- **Simulations run on the client that caused them:**
  - TNT: the igniting client runs the fuse and computes the blast. It
    broadcasts the resulting removals and builds as one `edit` batch
    (`cause: tnt`). Others see the fuse via `fx:prime` (overlay only; their
    loop does not run the fuse).
  - Liquids: when a local write wakes the scheduler, the local client
    simulates. Every `setBlockFlow` write the local scheduler makes is
    collected and sent as `edit` batches of `cause: liquid`, flushed once per
    liquid tick.
  - Chunk arrival: `seedArrival` still runs, so water that was left mid-flow
    resumes near whoever loads it. If two clients both run the same
    unsettled water, both send edits. Server order resolves it, and because
    the liquid rules are deterministic, both clients converge on the same
    settled state. The duplicate writes cost bandwidth, not correctness.
    **This is the riskiest claim in the spec;** §10 requires a two-client
    test of it.
- **Inventory (Mining mode)** is per player. The client adds a mined block to
  its own inventory when it mines locally, as today. Two players mining the
  same block at the same instant can both receive it. This is accepted.
- **Validation:**
  - The server rejects ops outside `0 ≤ x,z < 512`, `0 ≤ y < height`, or
    with an `id` above the catalog max. Batches are capped at 50k ops.
  - Otherwise it trusts clients.

## 7. Client

### 7.1 Mode seam

- `main.ts` today builds a solo session: a world from a `WorldSave`, then
  `DualAdapter` and autosave. A new `startMultiplayer(conn, welcome,
  snapshot)` path builds the same `World`, `GameLoop` and `Renderer`, but:
  - The world comes from `(seed, genVersion, height)` plus the snapshot
    overlay. The overlay is applied per chunk as each chunk is generated:
    `World.ensureChunk` consults an `overlay: Map<chunkIndex, rows>`, so an
    unvisited chunk gets its edits the moment it exists.
  - There is no `DualAdapter` and no autosave. Instead an `MpSync` object
    hooks into the world's mutation points (a `World.onLocalWrite` callback,
    null in solo), batches ops per frame, and sends them.
  - `MpSync` owns the socket, applies incoming ops with `applyRemote`, and
    relays positions to `RemotePlayers`.
- **Solo is guaranteed unchanged:** every new hook is null or no-op in solo.
  The existing test suite plus one new test ("solo never constructs `MpSync`
  or opens a socket") guard this.

### 7.2 Remote players

- `RemotePlayers` owns one `THREE.Group` per remote player, added to
  `renderer.scene`. Each group holds:
  - a coloured box, 0.6 × 1.8 × 0.6, in the skin's colour, with a darker
    "face" side showing yaw;
  - a name label: a `CanvasTexture` sprite 0.5 above the head, always
    upright.
- **Interpolation:** each remote player is rendered 100 ms in the past,
  linearly interpolated between the last two `pos` samples, and snapped if
  the gap is over 8 blocks.
- **Skins in v1:** 8 named colour presets (`red`, `blue`, `green`, `yellow`,
  `purple`, `orange`, `pink`, `black`), defined in data at
  `src/data/skins.data.ts`. A later project swaps a box for a textured model
  by changing only `RemotePlayers`.
- **Collisions:** remote players do not collide with the local player or
  block placement.

### 7.3 Minimap

- **Placement:** a `<canvas>` 160 px across, bottom-left, circular via CSS
  `border-radius: 50%` plus a clip, mounted under `#app` like the other HUD
  pieces.
- **Visible only in multiplayer.** It could later be enabled in solo by a
  one-line flag. Not in v1.
- **Rendering:**
  - It covers a radius of 48 blocks, 1 block ≈ 1.67 px, and **rotates with
    the player** (the player's facing is always up), GTA-style. An `N` marker
    rides the rim.
  - Each world column is coloured by its highest non-air block. The colour is
    the block's average top-face texture colour, precomputed from the atlas
    at load into `Uint8 rgb[blockId]`. Liquids use their colour at 70%.
  - A column in a chunk that isn't loaded is drawn dark grey.
- **Performance:**
  - The heightmap is cached per chunk and invalidated by the chunk's `rev`.
    It is rebuilt lazily, at most 4 chunks per frame.
  - The canvas redraws at 10 Hz. A redraw is one `putImageData` into an
    offscreen 97×97 buffer, then a rotated `drawImage`.
  - Budget: under 1 ms per redraw on the perf bench. `docs/performance.md`
    gets the number.
- **Dots:**
  - The local player is a white arrow at the centre.
  - Other players are dots in their skin colour.
  - A player beyond the radius is clamped to the rim, in their direction, and
    drawn smaller with an outline.

### 7.4 Play timer in multiplayer

- The existing `PlayTimer` runs unchanged, with the same budget per browser.
- **Countdown to the others:** when the remaining time crosses 120, 60 or 30
  seconds, and at each second from 10 down to 1, the client sends
  `leaving {secondsLeft}`. Other clients show a toast: "Noah leaves in 2 min",
  "… 1 min", "… 30 s", then a big "Noah: 10 … 1".
- **At 0:** the client freezes as today, sends a final `extras` and closes the
  socket. The others see `left`.
- **Refresh:** under a PIN, the timer survives a refresh (existing
  behaviour). A frozen timer blocks rejoining multiplayer just as it blocks
  solo play.

## 8. Menus

The existing single menu becomes three screens off a home screen. The home
screen shows three big buttons: **Single Player**, **Multiplayer** and
**Parents**. When a schedule is active, the existing scheduled-card mode
replaces home as it does today.

### 8.1 Single Player

- **New World:** name, seed and Mining/Sandbox. Create adds the world to the
  list and selects it.
- **World list:** today's cloud and on-device lists, merged into one with a
  small badge. Delete stays.
- **Duration:** 10 min to the parent maximum, in 5-minute steps. The default
  is 30 min, clamped to the maximum.
- **Play.**
- **Remembered in localStorage** (`minicraft:v1:menu`): the selected world id
  and duration.
- **Duration and the timer:**
  - Pressing Play starts a new timer session with that duration, unless a
    session is already in force.
  - **Without a PIN:** a refresh discards the session (clean slate).
  - **With a PIN:** the session survives a refresh, and only Parents → Reset
    States clears it.

### 8.2 Multiplayer

- **Screen 1:** name (1–16 characters: letters, digits, spaces), a skin
  picker showing the 8 colour swatches, and **Next**.
- **Screen 2:**
  - **New World:** name, seed and Mining/Sandbox. Create posts to
    `/worlds`, then adds and selects the world.
  - **World list:** name, type, and how many players are online. The list is
    sorted by online count first and refreshes every 5 s.
  - **Duration** (the same stored value as Single Player), then **Play**.
- **Remembered in localStorage** (`minicraft:v1:mp`): name, skin and the
  selected world id.
- **Server unreachable:** `GET /worlds` fails or takes longer than 4 s.
  Screen 2 shows "The multiplayer server is sleeping. Ask a grown-up to wake
  it up." with a Retry button.
- **Lost connection mid-game:**
  - A banner, "Lost the connection to your friends…", while the client
    retries with backoff (1, 2, 4, 8 s).
  - After 30 s, the client returns to the menu.
  - Edits made while disconnected are **discarded** on rejoin: the snapshot
    is authoritative. So on disconnect, the world is set read-only
    (mining/placing disabled) until reconnected.

### 8.3 Parents (PIN-gated when a PIN is set)

- **Schedule:** pick a solo world, a start time and a duration, then press
  **Schedule**. The app goes to the scheduled-card screen ("You can play at
  4:30"), which also survives a refresh.
  - That screen gains a **Parents** button that asks for the PIN and cancels
    the schedule.
  - If no PIN is set, the Parents button cancels directly.
- **Maximum duration:** 10 min to 2 h, in 5-minute steps. Default 2 h.
  Stored in options.
- **Reset states:** clears the schedule and the play-time session.
- **PIN:** Set, or Change, with a New PIN field and **Save PIN**. **Reset PIN**
  removes the PIN (only offered when one is set).
- **Break time is removed.**
  - Existing sessions with a `breakMs` load as `breakMs = 0`, so they reach
    `over` immediately when the limit hits.
  - `PLAY_BREAK_CHOICES_MIN` and the break UI are deleted.
  - `docs/playtime.md` is updated.

## 9. Hosting (Julien runs these by hand; documented in `server/README.md`)

- **VM:** a GCE `e2-micro` (free tier, us-central1) with a 10 GB standard
  persistent disk, running Debian.
  - `mcserver` is a systemd unit, with Caddy as the TLS front.
  - Stopping the VM keeps the disk and the SQLite file.
- **DNS without a static IP:** `mc.leap-forward.ca` is Cloudflare-proxied.
  At boot, a oneshot systemd unit updates the A record to the VM's ephemeral
  IP through the Cloudflare API. It uses a scoped token kept on the VM.
  Cloudflare proxies WebSockets.
- **TLS:** Caddy serves a Cloudflare Origin Certificate, with the zone set to
  Full (strict). This avoids Let's Encrypt HTTP challenges behind the proxy.
- **Idle and keepalive:**
  - The server sends a WebSocket ping every 20 s.
  - Cloudflare's 100 s idle timeout never triggers, because `pos` heartbeats
    run every 2 s.
- **Backups (optional, recommended):** on SIGTERM and hourly, the server runs
  `VACUUM INTO` into a snapshot and uploads it to
  `gs://minicraft-worlds/mp-backups/`. This uses the VM's service account.
- **Deploy:** `server/deploy.sh` cross-compiles (`GOOS=linux GOARCH=amd64`),
  copies the binary with `gcloud compute scp` and restarts the unit.
  Julien's approval is required for each run; nothing is auto-deployed.
- **Local development:**
  - `go run ./server/cmd/mcserver` serves on `:8080` with a local
    `mc.sqlite`.
  - The site points at it with `VITE_MINICRAFT_MP_URL=http://localhost:8080`.

## 10. Testing

**Instruments first.** Every test below must be shown to go red on a build
that lacks the feature. The plan names the break for each.

**Go (`server/`, `go test ./...`):**

- **Sequencing:** concurrent `edit` from 3 clients. Every client receives the
  same ops in the same seq order, and the author receives its own echo.
- **Snapshot/stream boundary:** a join during a burst of edits. Snapshot
  plus stream equals the final state, with no gap and no duplicate.
- **Persistence:** edits, then a flush, then a server restart. The snapshot
  matches. SIGTERM flushes.
- **Spawn rules:** first-join random; returning alone gets the last
  position; others online gives within 25 blocks of one of them.
- **Name taken online** returns `name_taken`. The same name after leaving
  is accepted.
- **World list order** is by online count, then recency.
- **Validation:** out-of-range ops rejected; bad token rejected.

**TS (vitest):**

- The snapshot codec round-trips against Go-produced fixtures, in both
  directions. A fixture file is shared between the two languages.
- `applyRemote` does not wake the liquid scheduler, and does touch rev,
  remesh and relight.
- Overlay-on-ensureChunk: an edit to an unvisited chunk appears when the
  chunk generates.
- Minimap geometry: rim clamping, rotation, and colour lookup.
- The countdown schedule fires exactly at 120/60/30/10…1.
- Menu models for the three screens: localStorage restore, and duration
  clamped to the parent maximum.
- Solo never opens a socket.

**Two-client end-to-end** (Playwright, headless, against a local
`mcserver`):

- **Harness:** two browser contexts. The prod API is blocked per project
  memory.
- A places a block; B sees it within 500 ms.
- B mines it; A sees air.
- A pours water next to an edge; after it settles, both clients' chunk
  hashes are identical (the §6 liquid claim).
- A ignites TNT; B's crater hash equals A's.
- The minimap shows B's dot.
- A's timer runs out; B sees the countdown and then `left`.

## 11. Docs

- New: `docs/multiplayer.md` covers the protocol, the consistency model and
  the operations runbook, with a sync test in the style of
  `crafting-docs.test.ts` that checks the message types.
- Update:
  - `docs/playtime.md`: break time removed, the maximum duration added.
  - `CLAUDE.md`: move multiplayer out of the non-goals, and note `server/`
    and the "don't point tests at the MP prod host" rule.
  - `docs/specs.md`: the Go and SQLite stack.

## 12. Out of scope (v1)

- Chat, emotes, animated or textured skins, and remote-player collisions
- Server-side simulation, anti-cheat and auth
- Mirroring multiplayer worlds to GCS as playable solo worlds
- Automating VM wake-up and shutdown
- Joining a multiplayer world while offline, or queuing offline edits

## 13. Open questions for gate 1

1. Is "both clients may simulate the same water; server order converges it"
   actually true? The scheduler is dt-driven and iterates in Set order, so
   intermediate states differ. Could a late op from one client overwrite a
   settled cell with a stale intermediate value, leaving a permanent hole or
   stray flow? If so, the fallback is **liquid ownership**: only the client
   whose local write woke a body of water simulates it, and `seedArrival` is
   disabled in multiplayer.
2. What is the snapshot size for a heavily edited world? Measure with a
   synthetic 200k-edit world.
3. Does the `World.onLocalWrite` hook really catch every mutation path
   listed in §2, including `applySave` exclusion and area-mine?
