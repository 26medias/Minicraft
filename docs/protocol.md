# Multiplayer protocol reference

The single reference for the multiplayer wire protocol: every message, close code, the snapshot
binary format, versioning and the HTTP API. It is written for bot authors (see the SDK,
[`packages/minicraft-bot`](../packages/minicraft-bot/README.md)) and for anyone changing the
protocol itself.

The tables below are checked against the code by `src/net/protocol-docs.test.ts`, against three
sources that must all agree: the TS types in `src/net/protocol.ts` (`src/net/wire-fields.ts` lists
their fields for the test), the Go structs in `server/internal/proto/proto.go` (checked by
**reflection**, not by marshalling a sample, so an `omitempty` field can't hide from the test — the
result is the checked-in `server/internal/proto/testdata/fields.json`), and this document. Change
the wire and update all three together; the test tells you which one you forgot.

For the higher-level design (architecture, the consistency model, connection/spawn/leaving UX,
skins, the minimap, server internals, the running setup) see
[`docs/multiplayer.md`](multiplayer.md).

## 1. Transport

- One WebSocket per player, at `GET /ws?token=…` (or `Authorization: Bearer …`). The browser
  origins allowed by CORS and by the WebSocket accept are one list: the site, and `localhost` or
  `127.0.0.1` on ports 5173 and 4173 (`-origins` overrides it). Node's `WebSocket` (the bot SDK)
  sends no `Origin` header at all, and the server's WebSocket library accepts that.
- Every message except one is a JSON text frame. The exception is the snapshot, sent once per
  join as a single **binary** frame right after `welcome` (§4).
- The read limit is 4 MiB per frame, on both ends.
- Liveness: **6 s of silence closes the connection** (client and server both watch it). A client
  sends `ping` when nothing else has gone out for 2 s, so a hidden tab (no `requestAnimationFrame`)
  still keeps the socket alive — `MpClient`'s liveness runs on `setInterval` only.

## 2. Handshake and resume

1. The client opens the socket and sends `hello` first, before anything else.
2. The server validates it in order (§5) and either joins the player and replies `welcome` (§3)
   plus one snapshot frame, or refuses with `error` + a close code (§5).
3. **Takeover:** each browser (or bot) keeps a random `bid`. A `hello` whose name is already online
   with the **same** `bid` takes over that connection: the old one gets 4001 `replaced`, and no
   `left`/`join` is broadcast (it is the same logical player, mid-reconnect). A **different** `bid`
   for a name that's online gets 4009 `nameTaken`.
   - A takeover can change the `bot` flag (a bot's reconnect logic opens a fresh connection with
     the same `bid`); the server's human/bot counts follow the change.
4. **Resume:** `hello.resume: true` marks a reconnect. It changes only which spawn the server
   picks (`docs/multiplayer.md`'s Connection, spawn and leaving section: `resume` + a known position always returns the player to
   where they were, never spawns them next to a friend). It does not change validation or replay
   any missed messages — the client rebuilds its world from the fresh snapshot.

## 3. Messages

`t` is the discriminant field, always present (omitted below since every row already names it).
`?` marks a field the sender may omit (Go `omitempty` / TS optional). A nested object is written
`name{sub, sub2?, …}`; a nested array of objects is `name[{sub, sub2?, …}]`.

### Client → server

| `t` | fields | notes |
|---|---|---|
| `hello` | `world, name, skin, bid, proto, gen, resume, ver, bot?` | first message; `skin` is a character id (`milo`, `jj`, …; unknown ids fall back to Milo on the client); a `skin` over 32 bytes, not UTF-8 or with a control character is stored as `""` (Milo); `gen` is the client's generator version; `resume: true` on a reconnect; `ver` is the client build (`CLIENT_VERSION`), missing counts as 0; `bot: true` marks a bot connection (the game never sends this field) |
| `pos` | `x, y, z, yaw, pitch` | at most 10 Hz, only while moving or turning |
| `ping` |  | every 2 s when nothing else was sent; driven by `setInterval`, so a hidden tab stays alive |
| `edit` | `cid, ops` | ≤ 2,000 ops (`MAX_OPS_PER_EDIT`); `cid` increases per connection; a batch may touch one cell more than once and is applied in order |
| `fx` | `kind, x, y, z, tier?, dur?, by?, tool?, face?` | cosmetic: `prime`, `boom` or `firework` (`tier` is the explosive's block id); `mine` (a player started mining x,y,z: `tier` is the block id, `dur` the full mining time in ms) and `mine-stop`. `tool` (the miner's pickaxe tier) and `face` (the aimed face) are only sent with a multi-block `tool`. `by` is part of the same wire type both ways but is only ever set by the server on relay (see the Server → client table below) — a client that sends it is ignored |
| `extras` | `data` | `{inventory, tools, hotbar, selected}`, debounced 5 s and on leave; opaque to the server, capped at `MaxExtrasBytes` (256 KiB) — a larger one is ignored |
| `leaving` | `secondsLeft, by?` | the play-time countdown; `by` is the same shared type as the server's relay and is set only by the server |

### Server → client

| `t` | fields | notes |
|---|---|---|
| `welcome` | `you, world{uuid,name,seed,gen,height,mustMine}, spawn{mode,x,y,z,yaw,pitch,target?}, extras, players[{id,name,skin,x,y,z,yaw,pitch,hasPos,bot?}], seq, catalogMax` | then one binary snapshot frame as of `seq` (§5); blocks with ids above `catalogMax` are hidden from the inventory; `spawn.target` is the near-spawn player's id (`near` mode only); a `players[]` entry with `hasPos: false` has meaningless `x`..`pitch` — it hasn't sent `pos` yet |
| `edit` | `seq, by, cid?, ops` | server order; sent to everyone, author included; `cid` (present only for the author's own echo) lets a client suppress it per the echo rule |
| `tick` | `poses` | `poses: [[id, x, y, z, yaw, pitch], …]`, one entry per player with a pose; every 100 ms while 2 or more players are online; excludes the recipient's own pose |
| `join` | `id, name, skin, bot?` | a new player (a same-browser takeover sends none) |
| `left` | `id` |  the avatar disappears; no toast |
| `fx` | `by?, kind, x, y, z, tier?, dur?, tool?, face?` | relayed to the others, not echoed; `by` is the sender's player id, set here; the server strips a `face` it doesn't recognise (and `tool` with it) |
| `leaving` | `by?, secondsLeft` | relayed to the others, not echoed; `by` is the sender's player id |
| `ping` |  | every 2 s while fewer than 2 players are online |
| `error` | `code, message, min?` | followed by a close with the same code; `min` (the server's minimum client build) is present only on the "outdated" refusal (§5, §6) |

Player ids start at 1 (`FirstPlayerID`), so `by` is never confused with an absent field.

## 4. Snapshot frame

One binary frame, sent right after `welcome`. Go and TS share the fixtures in
`server/internal/proto/testdata/` and `src/net/testdata/`; the codec lives in
`server/internal/proto/snapshot.go` and `src/net/snapshot.ts`.

```
header  u32le seq, u32le count          (8 bytes, uncompressed)
body    raw DEFLATE of `count` rows, sorted by (x, z, y)
```

Each row is unsigned LEB128 varints, delta-coded against the previous row (`prev` starts at
`(0, 0, −1)`, so a first row at the origin still has `dy = 1`):

```
dx = x - prevX                → uvarint(dx)
if dx > 0:                    → uvarint(z), uvarint(y)
else: dz = z - prevZ          → uvarint(dz)
      if dz > 0:               → uvarint(y)
      else:                    → uvarint(y - prevY)   (≥ 1: rows are unique)
then uvarint(id), uvarint(fluid), uvarint(color)
```

The decoder refuses a `count` larger than the remaining bytes can hold, before it allocates for
it (a malformed or truncated frame can't be used to over-allocate).

An **op** (in `edit`/`edit-out`, and each row of the snapshot) is `[x, y, z, id, fluid, color]`:
- `fluid` is the raw `Chunk.fluidMeta`: `0` = none or source, `0x80 | d` = a flow at distance `d`
  (a flow at distance 0 is `0x80`, not `0`).
- `color` is `0` for no colour, otherwise `0x1000000 | rgb` (`colorToInt` / `intToColor`). A lamp
  and its colour travel in the same op.

## 5. Validation and close codes

- **`ValidateOps`** (`server/internal/proto/validate.go`), for every op in a batch: `0 ≤ x, z <
  512` (`WorldSize`), `0 ≤ y < height`, `0 ≤ id ≤ catalogMax`, `0 ≤ fluid ≤ 0xFF`, and `color` is
  `0` or in `[0x1000000, 0x1FFFFFF]`. **Any invalid op rejects the whole batch** with 4003: the
  author's screen is already wrong, so a silent drop would leave a divergence nobody sees.
- **Names** (`NameKey`): 1–16 characters of `\p{L}` or `\p{N}` or spaces, after trimming. The
  server's key is the NFC-normalised, lowercased form (normalising before the rule check means a
  decomposed "Noé" gets the same key as the precomposed one). A name that fails the rule is
  refused with 4008.
- **Skins** (`SkinOf`): a `skin` over `MaxSkinBytes` (32 bytes), not valid UTF-8, or containing a
  control character is stored and relayed as `""` (Milo) instead. An unrecognised but well-formed
  id passes through, so a newer client's skin still renders correctly for other newer clients.
- **`fx.face`**: only the six strings `ValidFxFace` accepts (`px, nx, py, ny, pz, nz`) are relayed;
  anything else is stripped, and its `tool` with it, so a friend's client never receives an
  arbitrary string.
- **A malformed `hello`** — wrong JSON type for a field (`ver: "x"`, `bot: 1`), or not JSON at all
  — fails Go's typed `json.Unmarshal` and is refused with WebSocket close **1008** ("hello
  expected"), not a protocol `error` message. A negative `ver` is clamped to 0 rather than
  refused.

### Close and error codes

| code | `CLOSE` key | meaning | client reaction |
|---|---|---|---|
| 1008 | — (`websocket.StatusPolicyViolation`) | the first message wasn't a well-formed `hello` | never seen by a real client; a hostile or broken one is simply dropped |
| 4001 | `replaced` | a newer connection from this browser/bid took over | "You opened the game somewhere else." with one Menu button; no reconnect |
| 4002 | `slow` | the server's send queue for this client passed 1 MiB | reconnect |
| 4003 | `resync` | the server rejected a batch (an invalid op) | reconnect; after 2 in a row, the client treats it as a synthetic 4004 |
| 4004 | `proto` | either `hello.proto` is out of `[MinProto, MaxProto]`, **or** the client build is below `MC_MIN_CLIENT` (§6) | `proto` out of range, or two 4003s in a row: full-screen "Minicraft was updated" with a reload button. The **outdated-build** case (`error.message === "outdated"`, `error.min` set) instead gets one **automatic** reload after a 2 s "Updating Minicraft…" screen, guarded by a 5-minute `sessionStorage` marker so it can never loop |
| 4005 | `genUnsupported` | `hello.gen` isn't a generator version this server hosts (`supportedGen`) | same full screen as the non-outdated 4004 |
| 4006 | `unknownWorld` | the world doesn't exist (also used to kick a bot when its world is deleted, §8) | back to the world list |
| 4007 | `badToken` | wrong token | back to the world list |
| 4008 | `badName` | the name failed the name rule | back to the name screen |
| 4009 | `nameTaken` | the name is online from a **different** bid | name screen: "Someone called Noah is already playing. Pick another name." |

A close with a code that does not reconnect (4001, 4004–4009) clears the client's autojoin flag
**before** it shows anything or reloads, so a fatal close can never loop — except the outdated
build's guarded automatic reload above, which deliberately keeps it so the reload rejoins the same
world.

## 6. Versioning

- **`proto`** (currently `1`, `[MinProto, MaxProto] = [1, 1]`): the wire *shape*. It only changes
  for a breaking change to the messages above, and a client outside the accepted range is refused
  with 4004 `proto` — not the same case as the version gate below, even though it shares a close
  code.
- **`ver` / `MinClient`**: the client *build* number (`CLIENT_VERSION` in `src/net/protocol.ts`),
  independent of `proto`. The server admits any `ver ≥ MinClient` (`MC_MIN_CLIENT` env or
  `-min-client` flag; the flag wins only when explicitly passed; default `0` admits everything). A
  client below the minimum gets the "outdated" `error` (with `min`) then a 4004 close — see the
  runbook in `server/README.md` for forcing an update.
- **All wire changes are additive**: a new field is optional (or has a safe default when omitted,
  like `ver: 0`) so that `proto` never has to bump for it. `ver`, `bot` and `min` were all added
  this way.
- **`gen`**: the world generator version (`supportedGen`, currently `{3}`; `genHeight[3] = 256`).
  It is not a protocol version — it selects which terrain algorithm the client must run to agree
  with everyone else in the world. See
  [`docs/worldgen-from-seed.md`](worldgen-from-seed.md) (the generator's rebuild reference) for what `gen` actually determines.

## 7. Pose conventions and coordinates

These apply to `pos`, `tick`, `welcome.spawn`, `welcome.players`, and to the bot SDK's `move`,
`walkTo` and `lookAt`:

- A pose's `y` is the **feet**; the eye is `y + EYE_HEIGHT` (1.6).
- `yaw` is in radians. Forward is `(−sin yaw, 0, −cos yaw)`, so facing a target takes
  `yaw = atan2(−dx, −dz)`.
- `pitch` is in radians, positive looks up, clamped to `±π/2`.
- Coordinates are world blocks: `0 ≤ x, z < 512` (`WorldSize`), `0 ≤ y < height` (256 for `gen: 3`).
- `world` (in `hello`, and in `connect` for the bot SDK) is the world's **uuid**, from
  `GET /worlds`, never its display name.

## 8. HTTP

`/ws` and `/worlds` take `?token=` or `Authorization: Bearer`, checked with a constant-time
compare. CORS follows the same allowed-origins list as the WebSocket (§1).

| Request | Response |
|---|---|
| `GET /health` | `ok`, no token |
| `GET /ws?token=…` | the WebSocket, one per player |
| `GET /worlds` | `[{uuid, name, mustMine, createdAt, online[{name, skin}]}]`, busiest first, then newest. **Bots are excluded from `online`** — a companion bot never shows in the "who's playing" list |
| `POST /worlds {name, seed, mustMine, gen}` | the new world, in the same shape as one row of `GET /worlds` (this request body is not in `fields.json`: it's plain HTTP, checked by hand against `server/internal/net/http.go`'s `createReq`). `name` is trimmed and must be 1–40 characters; `gen` must be one `supportedGen` |
| `DELETE /worlds/{uuid}` | 204, or 409 while a **human** is online in it; offered only from Parents |
| — | a world with only bots online is not refused: its bots are kicked first with 4006 `unknownWorld`, then the world is stopped. The kick is submitted to the same per-world command inbox as the stop, and that inbox is FIFO, so the kick has already run — the bot/human counts already updated — by the time the stop runs |

## 9. Costs, limits and the bot SDK

- **Chunk generation** (used by the bot SDK's `getBlock`, `region`, `findNearest`, and by every
  client): about 30 ms for the first chunk, then roughly 2–9 ms per chunk; `findNearest` (≤ 25
  chunks, its radius capped at 32 blocks) is about 0.2 s. The whole 1,024-chunk world is about
  6.5 s and ~350 MB, which is about the server's 6 s silence limit above, so a bot must never scan
  the whole world in one synchronous call — it would block past the limit and get dropped (it then
  reconnects). `region` and `findNearest` are bounded well below that.
- **Wire limits**: `MaxOpsPerEdit` 2,000, `MaxExtrasBytes` 256 KiB, `MaxSkinBytes` 32, read limit
  4 MiB, send-queue cap 1 MiB (past it: 4002).
- **`pos`**: at most 10 Hz (`POS_EVERY_MS` = 100), shared by the game and the SDK.

**Writing a bot:** the SDK builds a client from the game's own code (world generator, snapshot
codec, echo rule) so a bot's view of the world matches the kids' exactly. Start with
[`packages/minicraft-bot/README.md`](../packages/minicraft-bot/README.md) — it covers `BotClient`,
`BotWorld`, the edit-gap pacing and the journal/`revert` safety net that this document doesn't
duplicate. Only point a bot at a server built from this branch or later. An older server ignores
`bot`: the bot shows without 🤖, is listed online, can be a spawn target for kids (possibly mid-air
or inside stone), and blocks world deletion. Deploy the server first.
