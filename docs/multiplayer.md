# Multiplayer

A private multiplayer mode for two families: Noah and a friend build in the same world from
two computers. It is a Go + SQLite relay server, live on Julien's desktop behind a Cloudflare Tunnel
(`minicraft-server.leap-forward.ca`), and a browser client that syncs block edits and player poses. Solo play is unchanged: no socket, no
overlay, no minimap, and the same `DualAdapter` autosave.

The design, with the measured evidence behind each rule, is
`docs/superpowers/specs/2026-09-24-multiplayer-design.md`. The server runbook (setup, start and
stop, deploy, backups, restore) is [`server/README.md`](../server/README.md).

## Architecture

```
browser (static site, hosting unchanged)
  ├── solo:  DualAdapter → localStorage + always-on API          (unchanged)
  └── multi: MpClient ──wss──▶ Cloudflare ──tunnel──▶ Beast: cloudflared ──▶ mcserver :8080 (localhost)
                                                                        └── SQLite (WAL), ~/minicraft-mp/mc.sqlite
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

The full wire protocol — every message and its fields, close and error codes, the snapshot
binary format, versioning (`proto`, the client-build gate, `gen`), pose conventions and the HTTP
API — moved to **[`docs/protocol.md`](protocol.md)**, the single tested reference for it (checked
against `src/net/protocol.ts` and `server/internal/proto/proto.go` by
`src/net/protocol-docs.test.ts`). It's also where the bot SDK's authors should start.

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
  from the seed and its terrain. Bots are never `near` targets: a bot has no physics and may be
  mid-air or inside stone.
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

### Other players

Other players are Minecraft-style skinned rigs (six characters, `src/data/skins.data.ts`; the
PNGs are in `src/assets/skins/`): the body turns with yaw, the head tilts with pitch, the legs
walk, the right arm swings while mining or after a place/break. Old colour ids render as Milo.
Each has a name label with the character's colour as its border. The design is
`docs/superpowers/specs/2026-09-24-player-skins-design.md`. A bot's label carries a 🤖 badge
(`🤖 name`); see `docs/protocol.md` for the rest of what sets a bot apart (never listed in
`GET /worlds`' `online`, never a `near` spawn target, and so on).

### Minimap

A 160 px round map, bottom-right, in multiplayer only. It covers 48 blocks around the player and
rotates with the player (forward is up). Each column is coloured by its highest non-air block;
liquids are drawn at 70 %, unloaded chunks dark grey. Heights are cached per chunk by `rev`,
rebuilding at most 4 chunks per redraw, and it redraws at 10 Hz. Other players are dots in their
character's colour with a white outline, a ▲/▼ when more than 8 blocks above or below, clamped to
the rim beyond the radius. Its cost is in `docs/performance.md`.

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

Live since 2026-09-24 on Julien's desktop ("Beast"). Two systemd **user** services run it:
`minicraft-server` (mcserver on `127.0.0.1:8080`, worlds in `~/minicraft-mp/mc.sqlite`) and
`minicraft-tunnel` (Cloudflare Tunnel to `https://minicraft-server.leap-forward.ca`). They start
with his login session, so the server is gone while the machine sleeps; the kids then see "The
multiplayer server is sleeping" and Single Player is unaffected. The backup is
`~/minicraft-mp/backup.sqlite`, rewritten hourly while anyone plays and on every stop (one copy, no
GCS upload).

[`server/README.md`](../server/README.md) has the runbook: status, start and stop, updating the
server, building the site with the multiplayer URL, backups, restoring, and recreating the tunnel.
The original VM plan is kept there as an alternative that is not in use.

Locally:

```bash
export PATH=$HOME/.local/go/bin:$PATH
cd server && go run ./cmd/mcserver -db ./mc.sqlite -addr :8080 -token dev
```

with `VITE_MINICRAFT_MP_URL=http://localhost:8080` and `VITE_MINICRAFT_MP_TOKEN=dev` for the
site.

⚠ **Never point a test at `minicraft-server.leap-forward.ca`** (or the VM plan's `mc.leap-forward.ca`).
The kids' multiplayer worlds live in `~/minicraft-mp/mc.sqlite` on Julien's desktop. Tests start
their own `mcserver` on a temp database, and the live URL and token are passed only to the
production build, never written to `.env.local`.

## Tests

- `cd server && go test -race ./...`: protocol, validation, snapshot codec, the world hub, the
  network layer (slow clients, takeover, shutdown under SIGTERM), store and backups.
- `npx vitest run src/net src/game src/engine/world`: the client codec (against the Go
  fixtures), the echo rule, MpSync and MpClient, remote batches and liquid convergence, spawn,
  the leaving countdown, the reconnect schedule and boot.
- `npm run e2e:mp`: two headless browsers against a local `mcserver`. It blocks every
  non-local host.
- `src/net/protocol-docs.test.ts`: `docs/protocol.md`'s tables against the code (see
  [Protocol](#protocol) above).
