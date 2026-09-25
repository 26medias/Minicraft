# Multiplayer

A private multiplayer mode for two families: Noah and a friend build in the same world from
two computers. It is a Go + SQLite relay server on a VM that Julien starts by hand, and a
browser client that syncs block edits and player poses. Solo play is unchanged: no socket, no
overlay, no minimap, and the same `DualAdapter` autosave.

The design, with the measured evidence behind each rule, is
`docs/superpowers/specs/2026-09-24-multiplayer-design.md`. The server runbook (setup, start and
stop, deploy, backups, restore) is [`server/README.md`](../server/README.md).

## Architecture

```
browser (static site, hosting unchanged)
  ├── solo:  DualAdapter → localStorage + always-on API          (unchanged)
  └── multi: MpClient ──wss──▶ Cloudflare ──tunnel──▶ VM: cloudflared ──▶ mcserver :8080 (localhost)
                                                                     └── SQLite (WAL), persistent disk
```

- **The server orders, persists and relays.** It never generates terrain and never runs a
  simulation. Its only game knowledge is the spawn mode, who is online, and each player's
  stored extras (inventory, tools, hotbar, selected slot).
- **Each client generates chunks from the seed** and applies a per-chunk overlay of the edited
  cells on top.
- **Every edit is server-sequenced and echoed to everyone**, author included.
- **Simulations (liquids, TNT) run on whichever client causes them.** Their writes are broadcast
  like any other edit.
- **Entering and leaving multiplayer are page reloads.** So is a reconnect.

The site reads `VITE_MINICRAFT_MP_URL` and `VITE_MINICRAFT_MP_TOKEN` at build time. When the URL
is unset, the Multiplayer button is hidden.

### Where the code is

| Side | Path | Role |
|---|---|---|
| Server | `server/cmd/mcserver/` | the binary: flags, signals, shutdown order |
| Server | `server/internal/proto/` | messages, close codes, op validation, name keys, snapshot codec |
| Server | `server/internal/hub/` | one goroutine per loaded world: cells, players, seq, spawn mode, flush |
| Server | `server/internal/net/` | HTTP API, WebSocket connections (reader + writer + bounded queue), world registry |
| Server | `server/internal/store/` | SQLite schema and the flush transaction |
| Server | `server/internal/backup/` | `VACUUM INTO` + upload to `gs://minicraft-worlds/mp-backups/` |
| Client | `src/net/protocol.ts` | the wire types, `CLOSE`, colour packing |
| Client | `src/net/snapshot.ts` | the binary snapshot decoder |
| Client | `src/net/mp-client.ts` | the socket: hello/welcome, ping, 6 s silence detection |
| Client | `src/net/mp-sync.ts`, `src/net/echo.ts` | the AutoSave stand-in: batches local writes, the echo rule, extras |
| Client | `src/net/mp-api.ts` | `GET/POST/DELETE /worlds` |
| Client | `src/engine/world/overlay.ts` | the per-chunk overlay of edited cells |
| Client | `src/engine/world/world.ts` | `writeRemote`, the `onLocalWrite` hook |
| Client | `src/game/loop.ts` | `enqueueRemote` / `drainRemote` (applyRemote), the player lift |
| Client | `src/game/boot.ts`, `src/game/mp-reconnect.ts`, `src/game/mp-exit.ts` | autojoin reloads, retries, fatal closes |
| Client | `src/game/mp-spawn.ts`, `src/game/leaving.ts` | spawn resolution, the leaving countdown |
| Client | `src/engine/render/remote-players.ts`, `src/ui/minimap.ts` | avatars and the minimap |
| Tests | `scripts/mp-e2e.ts` (`npm run e2e:mp`) | the two-client headless suite against a local `mcserver` |

## Protocol

JSON text frames, except the snapshot, which is one binary frame. The client sends `hello`
first. The server accepts `proto` in `[1, 1]`. The read limit is 4 MiB on both ends, and a client
batch is split to at most 2,000 ops per `edit` message.

An op is `[x, y, z, id, fluid, color]`:
- `fluid` is the raw `Chunk.fluidMeta`: `0` = none or source, `0x80 | d` = a flow at distance d
  (a flow at distance 0 is `0x80`, not 0).
- `color` is `0` for no colour, otherwise `0x1000000 | rgb` (`colorToInt` / `intToColor`). A
  lamp and its colour travel in the same op.

The tables below are checked against `src/net/protocol.ts` and
`server/internal/proto/proto.go` by `src/net/multiplayer-docs.test.ts`. Change the code and
the tables together.

### Client → server

| t | fields | notes |
|---|---|---|
| `hello` | `world, name, skin, bid, proto, gen, resume` | first message; a `skin` over 32 bytes, not UTF-8 or with a control character is stored as `""` (the default colour); `gen` is the client's generator version; `resume: true` on a reconnect reload |
| `pos` | `x, y, z, yaw, pitch` | at most 10 Hz, only while moving or turning |
| `ping` | — | every 2 s when nothing else was sent; driven by `setInterval`, so a hidden tab stays alive |
| `edit` | `cid, ops` | ≤ 2,000 ops; `cid` increases per connection; a batch may touch one cell more than once and is applied in order |
| `fx` | `kind, x, y, z, tier?, dur?` | cosmetic: `prime`, `boom` or `firework` (`tier` is the explosive's block id); `mine` (a player started mining x,y,z: `tier` is the block id, `dur` the full mining time in ms; the others draw the cracks from it until the block changes, a `mine-stop`, or `dur` + 1 s) and `mine-stop` |
| `extras` | `data: {inventory, tools, hotbar, selected}` | debounced 5 s, and on leave; opaque to the server |
| `leaving` | `secondsLeft` | the play-time countdown (see [Play time](#play-time)) |

### Server → client

| t | fields | notes |
|---|---|---|
| `welcome` | `you, world{uuid,name,seed,gen,height,mustMine}, spawn, extras, players[{id,name,skin,x,y,z,yaw,pitch,hasPos}], seq, catalogMax` | then one binary snapshot frame as of `seq`; blocks with ids above `catalogMax` are hidden from the inventory |
| `edit` | `seq, by, cid?, ops` | server order; sent to everyone, author included |
| `tick` | `poses: [[id, x, y, z, yaw, pitch], …]` | every 100 ms while 2 or more players are online; excludes the recipient's own pose |
| `join` | `id, name, skin` | a new player (a same-browser takeover sends none) |
| `left` | `id` | the avatar disappears; no toast |
| `fx` | `by, kind, x, y, z, tier?` | relayed to the others, not echoed |
| `leaving` | `by, secondsLeft` | relayed to the others, not echoed |
| `ping` | — | every 2 s while fewer than 2 players are online |
| `error` | `code, message` | followed by a close with the same code |

Player ids start at 1.

### Close and error codes

| code | `CLOSE` key | meaning | client reaction |
|---|---|---|---|
| 4001 | `replaced` | a newer connection from this browser took over | "You opened the game somewhere else." with one Menu button; no reconnect |
| 4002 | `slow` | the server's send queue for this client passed 1 MiB | reconnect |
| 4003 | `resync` | the server rejected a batch (an invalid op) | reconnect; after 2 in a row, the 4004 screen |
| 4004 | `proto` | proto version out of range | full screen "Minicraft was updated — click to reload" |
| 4005 | `genUnsupported` | generator version not supported | same as 4004 |
| 4006 | `unknownWorld` | the world doesn't exist | back to the world list |
| 4007 | `badToken` | wrong token | back to the world list |
| 4008 | `badName` | the name failed the name rule | back to the name screen |
| 4009 | `nameTaken` | the name is online from another browser | name screen: "Someone called Noah is already playing. Pick another name." |

A close with a code that does not reconnect (4001, 4004–4009) clears `mp:autojoin` **before**
it shows anything or reloads, so it can never loop.

### Validation and names

- An op must have `0 ≤ x, z < 512`, `0 ≤ y < height`, and `id ≤ catalogMax`. The server gets
  `catalogMax` at build time from `blocks.catalog.ids.json` (`npm run gen-server-catalog`).
- **Any invalid op rejects the whole batch** with 4003. The author's screen is already wrong, so
  a silent drop would leave a divergence nobody sees.
- Names: 1–16 characters of letters, digits and spaces, after trimming. The server's
  `name_key` is the lowercase NFC form. The client checks the same rule only to explain it
  ("Only letters, numbers and spaces").

### Snapshot frame

A header `u32 seq, u32 count`, then one row per edited cell sorted by `(x, z, y)`, then
deflated. Each row is varints: `dx` from the previous row, then `z` and `y` (delta-coded when `x`
repeats; `prev` starts at (0, 0, −1)), then `id`, `fluid`, `color`. The decoder rejects a
`count` larger than the remaining bytes allow before it allocates. Go and TS share the fixtures
in `server/internal/proto/testdata/` and `src/net/testdata/`.

### HTTP

`/ws` and `/worlds` take `?token=` or `Authorization: Bearer`. The browser origins allowed by CORS and
by the WebSocket accept are one list: the site, and `localhost` or `127.0.0.1` on ports 5173
and 4173 (`-origins` overrides it).

| Request | Response |
|---|---|
| `GET /ws?token=…` | the WebSocket, one per player |
| `GET /worlds` | `[{uuid, name, mustMine, createdAt, online: [{name, skin}]}]`, busiest first, then newest |
| `POST /worlds {name, seed, mustMine, gen}` | the new world |
| `DELETE /worlds/{uuid}` | 204, or 409 while anyone is online in it; offered only from Parents |
| `GET /health` | `ok`, no token |

## Consistency model

- **Server order is truth.** Each `edit` gets the next `seq` and goes to every client. Every
  client ends each cell at the value of that cell's highest-`seq` op, because that op is the last
  one applied to the cell everywhere.
- **Local writes** apply at once and are recorded as pending (`cell → latest own cid`).
- **The echo rule:** a client skips its own echo for a cell only when it has a **newer** pending
  write to that cell (whose echo will follow). Otherwise it applies the echo. This removes the
  place-then-mine flicker and keeps the highest-seq invariant.
- **The overlay is updated at receive time**, before any no-op check, for every op, loaded
  chunk or not. The chunk write happens at apply time, and the target chunk is resolved then,
  because a chunk can be evicted while ops wait.
- **applyRemote** (`GameLoop.enqueueRemote` → `drainRemote`) has `setBlock` semantics,
  including the liquid frontier wake. Without the wake, every client agreed but water froze
  half-spread when its simulating client left. For each op it clears block effects (a primed TNT
  at that cell, the fuse overlay, the lamp), writes through `World.writeRemote` (which never calls
  the local-write hook and never touches the inventory), and bumps `rev` even when only the
  fluid distance changed. Lamp colours go into the `LightRegistry` at receive time. The no-op
  check compares id and fluid only, so a colour-only op still relights.
- **At most 2,000 remote ops are applied per frame.** The rest wait for the next frame.
- **Unloaded chunks are never generated to apply an op.** `ensureChunk` applies the chunk's
  overlay right after generation, before lighting, and recomputes `hasLiquid`.
- **In multiplayer, a modified chunk is evictable** like a pristine one: seed plus overlay rebuild
  it. Overlay memory is about 16 bytes per edited cell.
- **Nobody owns water.** Each client's liquid scheduler reacts to writes in its loaded ring, and
  whatever it writes is broadcast. Duplicate and interleaved writes converge. Water whose only
  simulating client left resumes when someone loads that chunk.
- **TNT:** the igniting client runs the fuse and the blast and sends the result as ordinary
  edits, plus `fx: boom`. Others show the fuse from `fx: prime`; that overlay times out at the
  fuse length + 2 s in case the igniter leaves.
- **A remote block inside the local player** lifts the player to the first height above where
  the whole player box is free.
- **Inventory stays per player and client-side.** Two kids mining the same block at the same
  moment can both get it (accepted).
- **Accepted gap:** a chunk evicted before its own local writes were echoed regenerates without
  them until the echoes land.
- **With the inventory open, the simulation keeps running** in multiplayer (unless the timer has
  frozen the game or the connection is lost), so remote edits and liquids never stall.

## Connection, spawn and leaving

- **Liveness:** each side treats 6 s of silence as a dead connection. Idle clients send `ping`
  every 2 s.
- **Takeover:** each browser stores a random `bid` in `minicraft:v1:mp`. A `hello` whose name is
  online with the **same** `bid` takes over the old connection (the old one gets 4001, and no
  `left`/`join` is sent). A **different** `bid` gets 4009.
- **Connection lost** (a close, 6 s of silence, or 4002/4003): input, liquids, fuses and the play
  timer freeze under "Reconnecting…". The client probes `GET /worlds` at 1, 2, 4, 8 and 15 s. On
  success it reloads with `sessionStorage['mp:autojoin']`, sends `hello.resume`, and rebuilds the
  world from seed plus a fresh snapshot. Unacknowledged local writes are discarded. After 30 s it
  shows "Try again" and a small Menu link.
- **A failed rejoin** (no `welcome` within 6 s) moves the args to `mp:preselect`, clears
  `mp:autojoin`, and lands on the Multiplayer screen in its sleeping state, which retries on its
  own.
- **Spawn:** the server picks only the mode. `first` uses the world's spawn, `return` the stored
  position, `near` a spot 3–6 blocks in front of an online player. The client computes the spot
  from the seed and its terrain.
- **The server is sleeping** (`GET /worlds` fails or takes over 4 s): "The multiplayer server is
  sleeping. Ask a parent to wake it up." The screen retries every 5 s.

### Play time

Multiplayer uses the same timer and the same parent maximum as solo. The player sends
`leaving {secondsLeft}` once for each threshold crossed (120, 60, 30), then at 0. Joining with less
than 120 s left sends one immediate `leaving` with the real value. The leaver sees the usual
warnings and a big 10 … 1. Everyone else gets a small toast with the leaver's colour dot:
"Noah has to go in 2 minutes", "…in 1 minute", "…in 30 seconds", then "Noah went home". The
timer is paused while disconnected, and a reconnect reload keeps the session (see
`docs/playtime.md`).

### Minimap

A 160 px round map, bottom-left, in multiplayer only. It covers 48 blocks around the player and
rotates with the player (forward is up). Each column is coloured by its highest non-air block;
liquids are drawn at 70 %, unloaded chunks dark grey. Heights are cached per chunk by `rev`,
rebuilding at most 4 chunks per redraw, and it redraws at 10 Hz. Other players are skin-colour
dots with a white outline, a ▲/▼ when more than 8 blocks above or below, clamped to the rim
beyond the radius. Its cost is in `docs/performance.md`.

## Server internals, in one paragraph each

- **Concurrency:** one goroutine per loaded world owns its cells, players and `seq`. Joins,
  leaves, edits and the snapshot all run inside it as messages. Each connection has a reader and
  a writer goroutine; the writer drains a queue capped at 1 MiB (the welcome snapshot is exempt),
  and a full queue closes the connection with 4002. The world never blocks on a client, on a
  close, or on SQLite.
- **Persistence:** every 1 s the world goroutine hands a copy of the dirty cells and players to
  one writer goroutine, which upserts them in a single transaction. A world with nobody in it for
  60 s is unloaded after a final flush.
- **Shutdown on SIGTERM:** stop accepting, stop the worlds, final flush, close every socket with
  1001 (2 s total), back up, exit. The flush comes before any close, so half-open peers cannot
  delay it.

Schema (`server/internal/store/store.go`): `worlds` (one row per world, keyed by a compact
`wid`), `cells` (the latest value of every edited cell), `players` (position, extras and
`last_seen` per name). A cell mined back to its generated value keeps its row; it replays the
same id.

## Running it

Julien runs everything on the VM by hand. See [`server/README.md`](../server/README.md) for the
first-time setup, starting and stopping the VM, deploying, the backups (hourly and on SIGTERM,
48 kept in `gs://minicraft-worlds/mp-backups/`) and restoring one.

Locally:

```bash
export PATH=$HOME/.local/go/bin:$PATH
cd server && go run ./cmd/mcserver -db ./mc.sqlite -addr :8080 -token dev
```

with `VITE_MINICRAFT_MP_URL=http://localhost:8080` and `VITE_MINICRAFT_MP_TOKEN=dev` for the
site.

⚠ **Never point a test at `mc.leap-forward.ca`.** The multiplayer worlds live in the VM's
`/var/lib/mcserver` and in `gs://minicraft-worlds/mp-backups`. Tests start their own `mcserver`
on a temp database.

## Tests

- `cd server && go test -race ./...`: protocol, validation, snapshot codec, the world hub, the
  network layer (slow clients, takeover, shutdown under SIGTERM), store and backups.
- `npx vitest run src/net src/game src/engine/world`: the client codec (against the Go
  fixtures), the echo rule, MpSync and MpClient, remote batches and liquid convergence, spawn,
  the leaving countdown, the reconnect schedule and boot.
- `npm run e2e:mp`: two headless browsers against a local `mcserver`. It blocks every
  non-local host.
- `src/net/multiplayer-docs.test.ts`: this document's tables against the code.
