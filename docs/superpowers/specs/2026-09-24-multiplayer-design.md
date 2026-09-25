# Multiplayer — design

Date: 2026-09-24 · Branch: `multiplayer` · Status: **rev 3** (gate 1 plus its re-gate) — engine,
server/sequencing, rigour, kid-lens. Evidence behind gate changes is quoted inline as *(G1: …)* /
*(RG: …)*.

## 1. Intent

Noah (7) wants to play with his best friend, who lives 45 min away. We add a small, private
multiplayer mode: ≤ 10 players (25 stretch), served by a cheap VM that Julien starts **by hand only
when needed**.

What Julien decided (binding):

- **Solo stays as it is:** no account, current saves, current API. The API is not changed.
- **The deployed API is always up.** That is the Cloud Function plus `gs://minicraft-worlds`.
- **The multiplayer server and its DB are often off.** Solo never depends on them.
- **Server and storage:** a compiled language (Go). The DB stores levels differentially, near real
  time (SQLite).
- **Other players** move in real time, with a floating name label. Avatars start as coloured boxes.
- **Block changes are differential**, never whole maps.
- **Minimap:** round, GTA-style, bottom-right (moved from bottom-left by Julien after play-testing). Other players are dots; off-map ones are pinned to the
  rim.
- **Play timer:** it applies in multiplayer too. The others get a countdown for the last 2 minutes
  before a player leaves.
- **Duration:** the kid picks it, a parent caps the maximum, and break time is removed.
  - An existing play limit becomes the maximum.
  - "No limit" stays possible, and is the default for a browser with no limit set.
- **Refresh:** without a PIN, a refresh discards the play session (honour system). With a PIN, it
  survives, and only a parent resets it.
  - **Exceptions:** the session also survives a refresh
    - under an active schedule, so "all done for today" can't be refreshed away;
    - on a multiplayer reconnect reload (§7.5), so a wifi blip doesn't reset the timer.
  - The existing 12 h stale-session auto-clear is kept in every case.
- **Schedules:** an active schedule locks the menu to its solo world. Multiplayer is hidden until a
  parent cancels it.
- **Security:** none beyond a static token in the frontend (readable, accepted).
- **The VM is started by hand.**

Assumptions (flag if wrong):

- **A1.** Names are unique among the players *online* in a world. The same name on another day
  resumes that name's inventory and position.
- **A2.** One timer budget per browser, shared by solo and multiplayer (as today).
- **A3.** Multiplayer worlds live only on the VM. The mandatory backups (§9) are the safety net;
  there is no undo for griefing, only a parent-run restore.
- **A4.** No chat, emotes, animation or anti-cheat. Two players may pick the same colour.

CLAUDE.md lists multiplayer as a non-goal. This project overrides that deliberately (§11).

## 2. What already exists

- **World:** finite, 32×32 chunks of 16×H×16 (H = 256 for v3), stored as a `Uint16Array` per
  chunk plus a sparse `fluidMeta`.
- **Generation:** `generateChunk(chunk, seed, genVersion)` is pure and **bit-exact across
  machines** (`docs/worldgen.md`).
- **Solo saves already store only modified chunks.** Solo persistence is untouched.
- **Mutation points** *(G1-verified)*:
  - Every block write goes through `World.setBlock` (`world.ts:95`) or `setBlockFlow`
    (`world.ts:119`). That covers mining (single and area), place, replace,
    `removeBlocks`/`placeBlocks`, and every liquid scheduler step.
  - `applySave` and generation write `c.blocks` directly.
  - The lamp colour registry (`lights.add`/`remove`) is **not** a block write.
- **Simulation:** liquids (0.5 s accumulator) and TNT fuses run locally in `GameLoop.simulate`.
  `seedArrival` seeds liquid that can act when a chunk mounts.
- **Session lifecycle:** `startGame` runs once per page load. It has no teardown, and the
  `Renderer` is built once in `main()`.
  - **Returning to the menu means reloading the page** (the TIME'S UP Menu button already does
    this, `playtime-overlay.ts:57`).
- **Playtime:**
  - The `PlayTimer` session lives in `minicraft:v1:playtime`.
  - The PIN is `minicraft:v1:pin` and the schedule is `minicraft:v1:schedule`.
  - Options (`playLimitMin`, `playBreakMin`, …) are in `minicraft:v1:options`.
  - The schedule's "done for today" state lives in the session.

## 3. Architecture

```
browser (static site, hosting unchanged)
  ├── solo:  DualAdapter → localStorage + always-on API          (unchanged)
  └── multi: MpClient ──wss──▶ Cloudflare ──tunnel──▶ VM: cloudflared ──▶ mcserver :8080 (localhost)
                                                                     └── SQLite (WAL), persistent disk
```

- **`server/`** holds a Go module that builds one binary, `mcserver`. Dependencies:
  - `github.com/coder/websocket`
  - `modernc.org/sqlite` (pure Go)
- **Endpoints:**
  - `wss://<host>/ws?token=…` — one socket per player.
  - `GET /worlds`, `POST /worlds`, `DELETE /worlds/:id` — all take `?token=` or
    `Authorization: Bearer`.
- **Cross-origin handling** *(G1: the default `Accept` returned 403 for the real site)*:
  - `websocket.AcceptOptions.OriginPatterns` and CORS headers both use one allow-list:
    `noah.leap-forward.ca`, `localhost:5173` and `127.0.0.1:5173`.
  - The allow-list mirrors `ALLOWED_ORIGINS` in `api/src/handlers.ts`.
- **Build variables:** the site reads `VITE_MINICRAFT_MP_URL` and `VITE_MINICRAFT_MP_TOKEN`. When
  the URL is unset, the Multiplayer button is hidden.
- **Wire format:** JSON text frames, except the snapshot, which is a binary frame.
- **Read limit:** `conn.SetReadLimit(4 MiB)` *(G1: the 32 KiB default closed the socket at
  3,000 ops)*.
- **Client batches** are split to ≤ 2,000 ops per message (~36 KB).
- **The server never generates terrain or runs simulations.** It orders, persists and relays.
  Its only game knowledge is the spawn mode, the online counts and each player's stored extras.

### 3.1 Server concurrency (normative)

- **One goroutine per loaded world** owns that world's state: the cell map, the players and the
  seq counter. Joins, leaves, edits, the snapshot build and subscribing all run *inside* it, as
  messages on its inbox.
  - *(G1: 0 of 300 trials failed. A variant that took the snapshot in the HTTP handler failed
    134 of 300.)*
- **Each connection** has a reader goroutine and a writer goroutine. The writer drains a bounded
  queue capped at **1 MiB of queued bytes**. *(RG: a cap counted in messages allowed 9 MB per
  client on a 1 GB VM.)*
  - When the queue is full, the connection is closed with code `4002 slow`. The world never
    blocks on a client.
  - *(G1: with blocking sends, one slow reader stretched 5 s of traffic to 93 s for everyone. With
    bounded queues it took 5.2 s.)*
- **Liveness:**
  - Each reader has a 6 s read deadline, renewed by any message. Clients send `pos`, or a `ping`
    every 2 s when idle.
  - The server sends a `tick` of batched poses every 100 ms while at least 2 players are online,
    and `{"t":"ping"}` every 2 s otherwise.
  - A client that hears nothing for 6 s treats the connection as dead *(G1: a black-holed link was
    still undetected after 10 s, and JS never sees protocol-level pings)*.
- **Takeover:** each browser stores a random `bid` (in localStorage `minicraft:v1:mp`) and sends
  it in `hello`.
  - If `name_key` is already online **with the same `bid`**, the new connection takes over the
    old one: the old connection gets `4001 replaced`. This covers the wifi-drop reconnect.
    *(G1: otherwise every retry within 30 s hit `name_taken`.)*
  - If the `bid` differs, the server replies `4009 name_taken`. *(RG kid-lens: plain takeover lets
    two kids called "Noah" kick each other back and forth.)*
  - A takeover broadcasts **no** `left`/`join`. Friends don't get "Noah went home" on every blip.
- **Closing never blocks the world goroutine.** *(RG: `Close` to a black-holed peer blocked
  5 s.)*
  - The world goroutine only *signals* a connection: it cancels the connection's context and sets
    the close code.
  - The connection's own writer goroutine performs `Close`, bounded at 2 s, then `CloseNow`.
- **Persistence writer:** every 1 s the world goroutine hands a *copy* of the dirty cells and
  players to a single writer goroutine, which upserts them in one transaction.
  - The world goroutine never waits on SQLite *(G1: 50k upserts took 170–190 ms on a 28-core box;
    an e2-micro is likely 3–8× slower)*.
- **Unload:** a world with no players for 60 s is unloaded after a final flush. The unload happens
  under the registry lock, so a concurrent join either finds the live world or reloads it from the
  DB *(G1 race)*.
- **Shutdown (SIGTERM, which a GCE stop sends), in this order:**
  1. Stop accepting.
  2. Stop the world goroutines.
  3. Final flush.
  4. Close every socket with code `1001`, in parallel, capped at 2 s total
     (`http.Server.Shutdown` does not close hijacked sockets).
  5. Backup snapshot (§9).
  6. Exit.

  Flushing before any close means half-open peers can't push the flush past `TimeoutStopSec`
  *(RG)*. The budget is under 10 s.

## 4. Data model (SQLite)

```sql
CREATE TABLE worlds (
  wid INTEGER PRIMARY KEY,                 -- compact key for the big table (G1: TEXT keys → 18.7 MB/300k rows)
  uuid TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  seed INTEGER NOT NULL, gen_version INTEGER NOT NULL, height INTEGER NOT NULL,
  must_mine INTEGER NOT NULL, created_at INTEGER NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE cells (                       -- the differential state: latest value per edited cell
  wid INTEGER NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,
  id INTEGER NOT NULL, fluid INTEGER NOT NULL, color INTEGER NOT NULL, seq INTEGER NOT NULL,
  PRIMARY KEY (wid, x, z, y)
) WITHOUT ROWID;
CREATE TABLE players (
  wid INTEGER NOT NULL, name_key TEXT NOT NULL, name TEXT NOT NULL, skin TEXT NOT NULL,
  x REAL, y REAL, z REAL, yaw REAL, pitch REAL,  -- null until first leave
  extras TEXT NOT NULL DEFAULT '{}',             -- inventory/tools/hotbar/selected (PlayerSave extras)
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (wid, name_key)
);
```

- **`fluid`:** the raw packed `fluidMeta` value. 0 means none or source; `0x80|d` means a flow at
  distance d. A flow at distance 0 is `0x80`, not 0.
  - *(G1: a build that dropped this field in transit flooded 58,373 cells and diverged.)*
- **`color`:** the packed lamp colour, 0 = none. The lamp colour travels **inside** the block op,
  so a lamp and its colour arrive together *(G1)*.
- **Deleting a world** (Parents only) removes its rows in all three tables.
- **The differential rule:** a flush writes only the cells dirtied since the last flush. A cell
  mined back to its generated value keeps its row. That is harmless: the server can't know
  generated values, and the row replays the same id.

## 5. Protocol

A proto version range is exchanged in `hello`. The server accepts `proto` in `[MIN, MAX]`.

**Client → server (JSON)**

| t | fields | notes |
|---|---|---|
| `hello` | `world, name, skin, bid, proto, gen, resume` | first message; a `skin` over 32 bytes, not UTF-8 or with a control character is stored as `""` (the default colour); `gen` = the client's generator version; `resume: true` on an autojoin reconnect |
| `pos` | `x,y,z,yaw,pitch` | ≤ 10 Hz while moving or turning |
| `ping` | — | every 2 s when nothing else was sent; driven by `setInterval`, not rAF, so a hidden tab stays alive |
| `edit` | `cid, ops: [[x,y,z,id,fluid,color], …]` | ≤ 2,000 ops per message; `cid` increases monotonically per connection; a batch may touch one cell more than once and is applied in order |
| `fx` | `kind: prime\|boom\|firework, x,y,z, tier?` | cosmetic; `tier` is the explosive's block id for `prime` (fuse length) and `boom` (particles), relayed as an opaque int; absent or unknown means plain TNT |
| `extras` | `{inventory,tools,hotbar,selected}` | debounced 5 s, and on leave |
| `leaving` | `secondsLeft` | §7.4 |

**Server → client**

| t | fields | notes |
|---|---|---|
| `welcome` | `you, world{uuid,name,seed,gen,height,mustMine}, spawn, extras, players[{id,name,skin,x,y,z,yaw,pitch,hasPos}], seq, catalogMax` | then one binary snapshot frame; the client hides blocks with ids above `catalogMax` from its inventory and hotbar |
| *(binary)* | snapshot as of `seq` | format below |
| `edit` | `seq, by, cid?, ops` | server order; sent to **everyone, author included** |
| `tick` | `poses: [[id,x,y,z,yaw,pitch], …]` | every 100 ms, one message per recipient, excludes the recipient's own pose *(G1: cuts ~6k msgs/s to 250 at 25 players, and egress)* |
| `join` / `left` | `id,name,skin` / `id` | |
| `fx`, `leaving` | `by, …` | relayed, not echoed |
| `ping` | — | §3.1 |
| `error` | `code, message` | then a close; codes below |

**Close and error codes:**

| code | meaning | client reaction |
|---|---|---|
| `4001 replaced` | a newer connection from this browser took over | "You opened the game somewhere else." with one big **Menu** button; no reconnect |
| `4002 slow` | the send queue filled up | reconnect (§7.5) |
| `4003 resync` | the server rejected a batch | reconnect (§7.5); after **2 consecutive** 4003s, show the 4004 screen instead *(RG: this breaks the loop when the site is newer than the server's catalog)* |
| `4004 proto` | proto version out of range | full-screen "Minicraft was updated — click to reload" |
| `4005 gen_unsupported` | generator version not supported | same full-screen message |
| `4006 unknown_world` | the world doesn't exist | back to the list |
| `4007 bad_token` | wrong token | back to the list |
| `4008 bad_name` | name failed the rule below | back to the name screen |
| `4009 name_taken` | the name is online from another browser | name screen: "Someone called Noah is already playing. Pick another name." |

- **Validation:**
  - Ops must satisfy `0 ≤ x,z < 512` and `0 ≤ y < height`.
  - `id` must be ≤ the catalog maximum. The server gets that constant at build time from
    `blocks.catalog.ids.json`.
  - Any invalid op rejects the whole batch with `4003 resync`, because the author's screen is
    already wrong (G1: silent drops left a divergence nobody could see).
- **Names:** 1–16 characters matching `[\p{L}\p{N} ]`, after trimming.
  - `name_key` = the lowercase, NFC-normalised name, computed on the server only.
  - The client checks the same rule for UX only.
- **Snapshot binary format:**
  - A header `u32 seq, u32 count`, then rows sorted by `(x, z, y)`, then deflated.
  - Each row is varints: `dx` (delta from the previous row), `z` and `y` (delta-coded when `x`
    repeats), `id`, `fluid`, `color`.
  - *(RG measured this exact format at 200k edits: clustered 8 KB, air tunnels 92 KB, scattered
    456–688 KB. Absolute coding gave about 480 KB even for the clustered case.)*
  - Scattered edits sit near their information-theoretic floor, so no size is promised for
    arbitrary worlds. G15 asserts under 300 KB on the **named clustered and tunnel fixtures**
    only.
- **HTTP:**
  - `GET /worlds` returns
    `[{uuid,name,mustMine,createdAt,online:[{name,skin}]}]`, sorted by online count descending,
    then `createdAt` descending.
  - `POST /worlds {name, seed, mustMine, gen}` returns the world.
  - `DELETE /worlds/:uuid` returns 204, or **409 while anyone is online in that world**. The
    client only offers it from Parents, behind a confirm that names the world.

## 6. Consistency model

- **Server order is truth.** Each `edit` gets the next `seq` and goes to every client, including
  its author.
  - Every client ends each cell at the value of that cell's highest-`seq` op.
  - Proof sketch: that op is the last one applied to the cell everywhere.
- **Local writes:** the client applies its own write immediately and records it as pending
  (`cell → latest own cid`).
- **Echo rule:** a client skips its own echo for a cell when it has a *newer* pending own write to
  that cell (that write's echo will follow). Otherwise it applies the echo.
  - The chunk write is a no-op when the incoming (id, fluid, colour) equals the cell's current
    value, so plain echoes cost nothing. Colour equality is a `LightRegistry` lookup.
  - The **overlay is always updated, at receive time**, before any no-op check. Overlay writes are
    idempotent.
  - The chunk write happens at **apply time**. The target chunk is resolved then, not when the op
    arrives, because a chunk can be evicted while ops wait in the queue.
  - The echo-skip rule was run through the liquid probe: 12/12 seeds matched the reference in
    every scenario *(RG)*.
  - This removes the place-then-mine flicker *(G1)* and keeps the highest-seq invariant, because
    the newer own write is sequenced after it.
- **Where remote writes live** *(RG: the primed TNT, the fuse overlay and the lamp registry are
  private to `GameLoop`)*:
  - `World` gains one primitive, `writeRemote(x,y,z,id,fluid)`: a write with the liquid wake that
    never calls the hook.
  - `GameLoop.applyRemoteBatch(ops)` does, per op: `clearBlockEffects`, then `writeRemote`, then
    the lamp colour, then `batchCell`. It calls `routeBatch` once at the end.
  - The rest of this section calls that whole path **applyRemote**.
- **applyRemote** has `setBlock`/`setBlockFlow` semantics, **liquid frontier wake included** *(G1: without the wake, all clients agreed but were often **wrong** —
  water froze half-spread when its simulating client left in 12 of 12 runs, and orphan flows never
  drained in 2 of 12. With the wake, all 9 scenarios × 12 seeds matched a single-client
  settle)*. It also:
  - runs `clearBlockEffects`: primed TNT at that cell, the fuse overlay and the lamp registry
    *(G1: otherwise a primed TNT someone else mined still detonates)*;
  - applies the colour to the lamp registry;
  - bumps `rev` and dirty **even when only fluidMeta changes** (fixes the existing
    same-id/new-distance miss for remote writes);
  - never calls `onLocalWrite` and never touches the inventory.
- **Simulations stay on the client that causes them.** Nobody owns water.
  - Every client's scheduler reacts to writes in its loaded ring. Whatever it writes is broadcast
    like any other local write.
  - Duplicate and interleaved writes converge (evidence above).
  - Water whose only simulating client left resumes via `seedArrival` when someone loads that
    chunk.
  - **Liquid ownership is rejected:** it is exactly the "owner leaves, water frozen" failure.
- **TNT:**
  - The igniting client runs the fuse and blast and sends the result as ordinary edit batches,
    plus `fx:boom` for the explosion particles and sound.
  - Others show the fuse from `fx:prime`. The overlay times out at fuse length + 2 s in case the
    igniter leaves.
- **Applying remote batches:**
  - Remote batches are applied through the same batched path as `removeBlocks`/`placeBlocks`
    (`batchCell`/`routeBatch`, not `removeBlocks` itself, which filters non-removable and
    air-to-block cells).
  - At most 2,000 remote ops are applied per frame; the rest queue to the next frame.
  - *(G1: 2.1k ops cost 15 ms to apply plus 44 ms in the first tick. A radius-8 TNT is about
    2.1k cells; 10k+ only comes from chains.)*
- **Unloaded chunks:**
  - `applyRemote` **never** calls `ensureChunk` on an unloaded chunk *(G1: 27–51 ms per chunk, and
    the chunk gets pinned)*.
  - The client keeps an **overlay** `Map<chunkIndex, packed rows>`. It is seeded from the snapshot
    and updated by **every** sequenced op, loaded chunk or not.
  - `ensureChunk` applies a chunk's overlay right after generation, **before `fillChunkLights`**,
    and recomputes `hasLiquid` *(G1: an overlay applied after lighting left a dug shaft at sky
    light 0)*.
  - **In multiplayer, `modified` does not pin a chunk.** It is evictable like a pristine chunk,
    because generation plus the overlay rebuild it. Overlay memory is about 16 bytes per edited
    cell (200k edits ≈ 3 MB).
  - **Accepted:** a chunk evicted before its own local writes are echoed regenerates without them
    until the echoes land. It is a brief visual gap and ends correct.
- **A remote block landing inside the local player:** after applying a remote batch, if the
  player's box overlaps a solid block, lift the player to the nearest free space above (the
  `findSafeSpawn` column search).
- **Inventory** (Mining mode) is per player and client-side, as today. Two kids mining the same
  block at the same instant can both receive it (accepted).

## 7. Client

### 7.1 Mode seam

- The real `startGame(worldId, seed, name, mode, newMustMine)` gains an optional final
  `mp?: MpSession`. Multiplayer does **not** duplicate the ~400 lines of wiring.
- **The multiplayer path:**
  - It builds a synthetic `WorldSave` in memory: `{seed, genVersion, height, mustMine}` with no
    chunks, and a player placed at the resolved spawn with the server's `extras`.
  - It **bypasses** `adapter.loadWorld` and legacy adoption.
  - It installs the overlay (§6) and `World.onLocalWrite = mpSync.record`.
  - It skips `DualAdapter`.
  - It creates `RemotePlayers`, `Minimap` and `MpSync`.
- **`MpSync` stands in for autosave:** it is `AutoSave`-shaped, so the existing
  `countRemoved`/`onWorldMutated`/freeze callbacks that call `autosave.markDirty`/`flush`
  (`main.ts:463–483, 509`) work unchanged. *(RG)*
  - `markDirty` debounces an `extras` send by 5 s.
  - `flush` sends `extras` now.
  - Pending extras are also mirrored to `sessionStorage` and re-sent after the next `welcome`, so a
    reconnect reload doesn't lose recently mined items *(RG)*.
- **`World.onLocalWrite`** is null in solo and called from `setBlock`/`setBlockFlow`.
- **Lamp colours:** `onLocalWrite` records only the cell. `MpSync` builds the ops at its
  **per-frame flush**, reading id, fluid and colour then.
  - *(RG: `placeBlock`/`replaceBlock` call `setBlock` before `lights.add`, so a colour read inside
    the hook is always 0.)*
- **Leaving:**
  - Every exit from multiplayer is a page reload, with a `sessionStorage` flag `mp:autojoin`
    when the goal is to rejoin (§7.5).
  - There is no in-page teardown, which matches today's session lifecycle.
- **Solo guarantee:** with `mp` unset, no socket, overlay or minimap exists.
  - Guarded by a Playwright check: solo with a `WebSocket` constructor spy, run on the
    multiplayer build.
  - Guarded by a second Playwright check: Single Player works with `VITE_MINICRAFT_MP_URL`
    pointing at a dead port.

### 7.2 Spawn (client-computed; the server picks only the mode)

`welcome.spawn` is one of:

- **`{mode:'first'}`** (never joined): use `spawnV3(seed)`, the settled worldgen hill-with-a-view
  spawn, then `findSafeSpawn`.
- **`{mode:'return', x,y,z,yaw,pitch}`** (joined before and nobody online, **or `hello.resume`**):
  the last position, then `findSafeSpawn`.
  - A reconnect always returns the kid to where they were, never next to a friend *(RG kid-lens)*.
  - With `resume`, the server takes the position from the player's live record, which is
    updated from `pos` messages.
- **`{mode:'near', target: id, x,y,z,yaw}`** (someone online; the server picks one at random):
  - Try the columns 3–6 blocks in front of the target's facing, then fan out ±60°.
  - Accept a dry, standable column within ±4 of the target's y.
  - Otherwise use the target's own position.
  - Face the target.
  - *(Kid-lens: "within 25 blocks" is often out of sight on v3 hills.)*

### 7.3 Remote players

- **The avatar:** one `THREE.Group` per remote player:
  - a 0.6 × 1.8 × 0.6 box in the skin colour, with a darker front face showing yaw;
  - a name label: a `CanvasTexture` sprite with a white background and a coloured border,
    `depthTest: false` so it shows through hills, and a minimum on-screen height of 20 px.
- **Interpolation:** rendered 200 ms in the past (two tick periods, to absorb jitter), linear between `tick` samples. The label and
  box snap when the gap is over 8 blocks.
- **Skins:** 8 presets in `src/data/skins.data.ts` (red, blue, green, yellow, purple, orange,
  pink, black).
- **No collisions** with remote players.

### 7.4 Play timer in multiplayer

- The same `PlayTimer` and budget.
- **Countdown messages:** the client sends `leaving {secondsLeft}` once for each threshold
  **crossed** (120, 60, 30), and when `secondsLeft` reaches 0.
  - Crossing is checked each tick, which may credit 2 s, the same way as `WARNING_THRESHOLDS`.
  - Joining with less than 120 s left sends **one** immediate `leaving {secondsLeft}` with the
    real value. Every threshold already passed is marked fired, as `WARNING_THRESHOLDS` does
    today. The thresholds still ahead fire as they are crossed.
  - Example: joining at 90 s left sends 90 now, then 60, 30 and 0.
  - The timer pauses while the tab is hidden, so the countdown does too. That is correct.
- **What each screen shows:**
  - **The leaver:** the existing warnings, plus a big 10 … 1 in the last 10 s.
  - **Everyone else:** one small toast per threshold, with the leaver's colour dot: "Noah has to
    go in 2 minutes" / "…in 1 minute" / "…in 30 seconds". Then "Noah went home".
- **At 0:** freeze as today, send `extras`, then close.
- **Disconnected:** the timer is paused while disconnected (§7.5).
- **A frozen timer that survives** (under a PIN) blocks rejoining, as it blocks solo.

### 7.5 Connection loss

- **Triggers:** the socket closes, a 6 s silence, or `4002`/`4003`.
- **Freeze:** input, the simulation (liquids, fuses) and the play timer are all frozen. The screen
  dims under a big "Reconnecting…".
- **Retries** at 1, 2, 4, 8 and 15 s. Each attempt first probes `GET /worlds`.
- **On success:** reload the page with `mp:autojoin`. The world is rebuilt from seed plus the fresh
  snapshot, exactly like a first join.
  - `hello.resume` is set, so the kid comes back where they were.
  - The play session is **kept** (§8.1 `sessionPolicy`).
  - Local writes that were never acknowledged are discarded.
  - *(G1: an overlay alone can't repair a mined generated cell the server never received.)*
- **After 30 s without success:** show one big "Try again" button, which rejoins the same world,
  and a small "Menu" link.

### 7.6 Minimap

- **Placement:** a 160 px circular canvas, bottom-right, in multiplayer only.
- **Coverage and rotation:** a radius of 48 blocks, **rotating with the player** (forward is up).
  No N marker.
- **Colours:**
  - Each column is coloured by its highest non-air block, using that block's average top-face
    colour from the atlas.
  - Liquids are drawn at 70% opacity. Columns in unloaded chunks are dark grey.
  - Heights are cached per chunk and invalidated by `rev`, rebuilding at most 4 chunks per
    frame.
- **Redraw:** 10 Hz. One `putImageData` into a 97×97 offscreen canvas, then a rotated
  `drawImage`. The budget is under 1 ms, measured on the perf bench.
- **Dots:**
  - The local player is a white arrow at the centre.
  - Other players are skin-colour dots with a **white outline**.
  - A dot gets a small ▲/▼ when the player is more than 8 blocks above or below.
  - Players beyond the radius are clamped to the rim in their direction.

## 8. Menus

The home screen has three big buttons: **Single Player**, **Multiplayer** and **Parents**.

- When a schedule is active, the existing scheduled-card mode replaces the home screen.
  Multiplayer is not reachable from it.
- **The duration control is shared:** a big "30 min" with − and + buttons, in 5-minute steps from
  10 min up to the parent maximum.
  - When the maximum is "No limit", + goes past the top value to "No limit".
  - **The default duration:**
    - When the maximum is No limit, the default is **No limit**. A browser that has no limit
      today keeps playing unlimited solo, as today.
    - Otherwise the default is 30 min, clamped to the maximum.
  - The value is remembered in `minicraft:v1:menu`.

### 8.1 Single Player

- **New World:** name, seed and Mining/Sandbox. **Create** adds the world and selects it.
- **World list:** today's cloud and device lists, merged into one list with a badge. Delete stays.
- **Duration**, then **Play**.
- **Remembered:** the selected world id and the duration.
- **Play and the timer:**
  - Play starts a new timer session with the chosen duration, unless a session is already in
    force. A "No limit" duration starts no session.
  - **Refresh:** at boot, a new function `sessionPolicy(pinSet, scheduleActive, autojoin)`
    decides whether to keep the stored session.
    - It returns `discard` only when there is no PIN, no active schedule and no `mp:autojoin`
      flag.
    - `main.ts` calls it **before** `resolveSession`.
    - The 12 h stale rule still applies afterwards.

### 8.2 Multiplayer

- **Screen 1:** name and skin (8 swatches), then **Next**. It is skipped when a name is
  remembered: screen 2 shows "Playing as ● Noah [change]".
- **Screen 2:**
  - **World list:** name, type, and **who is in it**, as coloured dots with names ("Noah, Léo").
    Worlds with players are listed first.
    - If the remembered world is empty and another world has players, the busiest world is
      preselected.
    - The list refreshes every 5 s.
  - **New World:** name, seed (prefilled at random) and Mining/Sandbox. **Create** posts, then
    adds and selects the world.
  - **Duration**, then **Play**.
- **Remembered** in `minicraft:v1:mp`: name, skin and the selected world id.
- **When the server is sleeping** (`GET /worlds` fails or takes over 4 s): "The multiplayer server
  is sleeping. Ask a grown-up to wake it up." The screen retries automatically every 5 s and also
  has a Retry button.

### 8.3 Parents (PIN-gated when a PIN is set)

- **Schedule:** a solo world, a start time and a duration, then **Schedule**.
  - The duration is the parent's choice, from 10 min to 2 h in 5-minute steps. The maximum
    doesn't cap it.
  - `isSchedule` validates against the **new 5-minute list**, a superset of the old choices, so
    both old and new schedules load and save *(RG)*.
  - The app goes to the scheduled card, which survives a refresh. The card's **Parents** button
    asks for the PIN (or cancels directly if none is set) and cancels the schedule.
- **Maximum duration:** 10 min to 2 h in 5-minute steps, or **No limit**.
  - **Migration:** the existing `playLimitMin` becomes the maximum. `null` becomes No limit.
  - `playBreakMin` is dropped.
- **Reset states:** clears the schedule and the play session.
- **PIN:** Set/Change with a New PIN field and **Save PIN**. **Reset PIN** removes it.
- **Multiplayer worlds:** a list of the multiplayer worlds with Delete. It is shown only when the
  server is reachable.
  - Delete asks "Delete *World name* for everyone?".
  - A world with anyone online can't be deleted; the server returns 409.
- **Break time is removed:**
  - A new session has `breakMs = null`: at its limit it freezes until the next session per the
    §8.1 refresh rule, or a Parents reset.
  - A stored session with a numeric `breakMs` loads with `breakMs = null`.
  - `PLAY_BREAK_CHOICES_MIN` and the break UI are deleted.
  - Stored schedules still validate: the 5-minute duration list is a superset of
    `PLAY_LIMIT_CHOICES_MIN`.

## 9. Hosting (Julien runs everything; `server/README.md` is the runbook)

- **VM:** a GCE `e2-micro` (us-central1, free tier) with a 10 GB persistent disk, running Debian 12.
  - It keeps an ephemeral external IPv4, billed only while running, for outbound traffic.
  - No inbound ports.
- **Cloudflare Tunnel** (`cloudflared`, free) maps `mc.leap-forward.ca` to `localhost:8080`.
  - It replaces Caddy, the origin certificate and the DNS updater *(G1)*.
  - `server/vm-setup.sh` is a **single sudo script** Julien runs once on the VM. It installs
    cloudflared, creates the `mcserver` user and directory, and installs the systemd units
    (`mcserver.service` with `After=network-online.target` and `TimeoutStopSec=30`).
- **Mandatory backups:** on SIGTERM and every hour while any world is loaded, the server runs
  `VACUUM INTO /var/lib/mcserver/backup.sqlite` and uploads it to
  `gs://minicraft-worlds/mp-backups/<timestamp>.sqlite` using the VM's service account.
  - The last 48 backups are kept.
  - `server/README.md` documents the restore: stop the unit, copy the file back, start the unit.
- **Deploy:** `server/deploy.sh` cross-compiles, runs `gcloud compute scp` and restarts the unit.
  It runs on Julien's approval only.
- **Local development:** `go run ./server/cmd/mcserver -db ./mc.sqlite -addr :8080`, with the
  site's `VITE_MINICRAFT_MP_URL=http://localhost:8080`.
- **Toolchain:** Go is installed without sudo into `~/.local/go` from the official tarball.
- **Cost:** traffic is dominated by `tick`. At 10 players and 10 Hz that is about
  10 × 9 × ~45 B × 10/s ≈ 150 MB/h. Julien should expect a few cents per play session in egress.
  The rest is free tier or pennies.

## 10. Testing

**Every test names the build it goes red on.** The plan must show each one failing before its
feature lands.

**Go (`server/`)**

| # | Test | Goes red when |
|---|---|---|
| G1 | 3 clients send concurrent edits: all receive the same seq order; the author gets its echo | ordering breaks, or the author isn't echoed |
| G2 | Snapshot/stream boundary uses a **test hook that parks the world goroutine between snapshot build and subscribe** while edits arrive, and checks against an independent op-log oracle | snapshot and subscribe are split, or run outside the world goroutine |
| G3 | Persistence: edits, then flush, then restart gives an identical snapshot | the DB is wrong |
| G4 | Flush writes **only** the dirty rows (count the upserts) | the flush rewrites whole worlds |
| G5 | **Exec the binary** with one **black-holed client** connected, write edits, send `kill -TERM` within 300 ms, restart: the edits are present, and the process exited in under 10 s | the signal handler is missing, or closes happen before the flush / serially |
| G6 | Spawn modes: first / return / near / `resume` → return even with others online, with the near target chosen from online players | a mode is wrong, or `resume` is ignored |
| G7 | Takeover: a black-holed first connection, then the same name **and bid** rejoins within 5 s and succeeds; the old one gets 4001; no `left`/`join` is broadcast; a third player's tick latency stays under 300 ms throughout | there is no takeover, or the world goroutine closes the socket itself (5 s stall) |
| G7b | The same name with a **different bid** gets 4009, and the online player is untouched | takeover ignores the bid |
| G8 | Read deadline: a silent client is dropped within 7 s | the deadline is missing |
| G9 | Slow consumer: 25 simulated players with one reader stalled; the others' tick latency stays under 300 ms; the stalled client gets 4002 once its queue passes 1 MiB | sends block, or the queue is counted in messages |
| G10 | Handshake with `Origin: https://noah.leap-forward.ca` succeeds; `https://evil.example` fails; CORS preflight on `/worlds` | the default origin check is used |
| G11 | A 2,000-op batch (and a 4 MiB message) is accepted and echoed | the 32 KiB default read limit is used |
| G12 | An invalid op (including id > `catalogMax`) closes with 4003 and the batch isn't applied; `welcome` carries `catalogMax` | ops are dropped silently |
| G13 | `/worlds` is ordered by online count then recency and lists `online[]` names; delete removes rows in all three tables; delete of an occupied world returns 409 | the sort key is wrong, rows are orphaned, or an occupied world is deletable |
| G14 | Unload race: a join lands during the unload window and gets a working world | there is no registry lock |
| G15 | Snapshots of the named **clustered** and **tunnel** 200k-cell fixtures are each under 300 KB and round-trip | absolute (non-delta) coding is used (~480 KB clustered) |
| G16 | Names: the rule is enforced; `Noé` and `NOÉ` (and the decomposed `Noé`) share a `name_key` | there is no NFC normalisation, or no lowercasing |

**TS (vitest)**

| # | Test | Goes red when |
|---|---|---|
| T1 | The snapshot codec round-trips **fixtures produced by the Go encoder** (committed files), and TS-encoded ops are decoded in G-tests | the formats drift |
| T2 | `applyRemote` wakes the frontier; **control:** `setBlock` on the same cell produces the same frontier | the no-wake variant (spec rev 1) is used |
| T3 | Liquid convergence: two `World`+`LiquidScheduler` clients, a sequencer and a **single-client reference**, with the §6 echo-skip rule on, over scenarios: pour; the simulating client leaves at t=1 s; the source is removed under 0.3–1.5 s latency; a stalled tab. **Each client must equal the reference**, not just each other. Several seeds and dt sequences | the no-wake variant is used (G1 caught 12/12) |
| T4 | Fluid packing round-trip, including a flow at distance 0 (`0x80`) | fluid is sent as a distance, or dropped |
| T5 | Overlay: an op to an unloaded chunk is applied at generation, **before lighting**; a dug shaft reads sky light 15 | the overlay is applied after `fillChunkLights` |
| T6 | A remote op to an unloaded chunk does not create the chunk | `applyRemote` calls `ensureChunk` |
| T7 | Echo rule: place then mine quickly gives no flicker (no intermediate write observed); a concurrent foreign op still converges | echoes are always applied, or always skipped |
| T8 | A remote mine of primed TNT cancels the local detonation | `clearBlockEffects` is skipped |
| T9 | Countdown with **2 s ticks**: every threshold fires exactly once, even when a tick jumps over it; joining at 90 s left sends 90 immediately, then 60, 30 and 0, and never 120 | thresholds are matched on exact seconds, or already-passed thresholds aren't marked |
| T10 | Pose interpolation: renders at t−200 ms between samples; snaps when the gap is over 8 | there is no delay buffer (it renders the latest sample), or there is no snap |
| T11 | Minimap: an off-radius player clamps to the rim at the right bearing after rotation; ▲/▼ at dy > 8; the colour table maps a known block to its atlas mean | the bearing ignores player yaw, the clamp is missing, or the threshold is off by one |
| T12 | `sessionPolicy` truth table (pin × schedule × autojoin); break-field migration; `playLimitMin` → maximum (null → No limit) | the autojoin exemption is missing, or old limits are dropped |
| T12b | **Boot-level**: store a session, then run the boot path, for each of: no PIN, PIN, schedule, autojoin; assert whether the session is kept | `main.ts` never calls `sessionPolicy` (T12 alone stays green) |
| T13 | Menu models: restoring name/skin/world/duration; busiest-world preselect when the remembered world is empty; duration clamped to the maximum; default is No limit when the maximum is No limit | the remembered world wins over an occupied one, or the default is 30 under No limit |
| T14 | Remote block inside the player: the player is lifted to free space | the post-batch overlap check is missing |
| T15 | Placing a **coloured lamp** sends an op with `color != 0` | colour is read inside the `onLocalWrite` hook |
| T16 | `MpSync` as the autosave stand-in: `markDirty` sends `extras` after 5 s; pending extras survive a reload via sessionStorage and are re-sent after `welcome` | extras are lost on a reconnect reload |

The existing tests rewritten for break removal (listed by gate 1) are rewritten, not deleted: they
become T12 cases.

- `src/game/playtime.test.ts`
- `src/game/playtime-controller.test.ts`
- `src/persistence/playtime.test.ts`
- `src/persistence/options.test.ts`
- `src/ui/menu-model.test.ts`
- `src/game/schedule.test.ts`

**End-to-end (Playwright, headless)**

The harness runs a local `mcserver` against a temp DB and blocks the production API host.

| # | Scenario | Goes red when |
|---|---|---|
| E1 | A places a block; B sees it within 500 ms; B mines it; A sees air | edits don't relay or apply |
| E2 | A pours water while B is in range: **both equal a single-client replay** of A's actions (the hash compare against the reference) | remote writes don't wake the liquid scheduler |
| E3 | A ignites TNT **next to water**: B's crater equals A's, and both equal the reference after the water settles; B saw `fx:boom` | batches are sliced or applied wrongly, or there is no boom fx |
| E4 | B's minimap shows A's dot; B's scene has A's label | remote players aren't rendered |
| E5 | A's timer runs out: B sees the toasts and then "went home" | `leaving` isn't sent or shown |
| E6 | The server is killed mid-game: A shows "Reconnecting…"; the server restarts; A auto-rejoins **at its last position**, with the world intact and **remaining play time unchanged (±2 s)** with no PIN | the reload discards the session, or `resume` isn't sent |
| E7 | Solo on the multiplayer build: no WebSocket is constructed; solo works with the multiplayer URL on a dead port | solo wires `MpSync`, or waits on the multiplayer server |

## 11. Docs

- **New:** `docs/multiplayer.md` (protocol, consistency model, runbook), with a sync test
  checking that its message and close-code tables match `server/` and `src/net/protocol.ts`.
- **Update:**
  - `docs/playtime.md`
  - `docs/specs.md` (Go, SQLite and the tunnel)
  - `docs/performance.md` (the minimap cost)
  - `CLAUDE.md`: multiplayer leaves the non-goals; add `server/` and "never point tests at the
    multiplayer production host".

## 12. Out of scope (v1)

- Chat, emotes, and animated or textured skins
- Remote-player collisions
- Protecting a player's blocks from other players' TNT (revisit if griefing tears happen;
  backups are the v1 answer)
- Server-side simulation, auth and anti-cheat
- Mirroring multiplayer worlds to solo, automated VM wake/sleep, and offline multiplayer
