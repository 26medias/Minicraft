# Protocol job: bot SDK, client version check, protocol reference — design (rev 2, 2026-09-25)

Branch `protocol` (worktree `.claude/worktrees/protocol`), cut from `multiplayer` @ d8b9447, where
skins are live. Brainstormed with Julien on 2026-09-24/25, and he approved each section in chat.
Rev 2 folds in gate 1 (rigour, engine, boundaries, consumer); see §12. Julien is asleep and
delegated open questions. Every ruling made on his behalf is marked **Ruling** and collected in §12.

## 1. Goal and intent

Julien will write **TypeScript bots** that join the kids' multiplayer worlds as **companions** and as
**AI agents**. The bots need to see the world (terrain plus edits) and act like players. They will not
reimplement world generation. Separately, stale cached clients must be forceable to refresh when a
client update matters. Everything a bot author needs lives in one protocol reference.

Success, the morning after: Julien writes a companion that imports a local package, connects,
appears to the kids as a skinned player with a 🤖 badge, walks after a kid on the ground at walking
speed, faces what it mines (with cracks), and places blocks. Nothing the kids' clients do today
changes.

Non-goals:
- pathfinding and physics (collision, gravity);
- bot inventory rules and chat;
- publishing to npm;
- server-side world generation, and any change to world generation;
- server-side bot limits (declined by Julien; an SDK-side safety net is in §6).

## 2. Decisions (Julien)

- Bots are **TypeScript on Node ≥ 22** (Node has a built-in `WebSocket`).
- A **full bot SDK**: worldgen, a live world model and actions, reusing the game's own code.
- Bots are **marked as bots**: the server knows, labels show 🤖, and bots are left out of the menu's
  "online" list. Otherwise they behave exactly like players.
- A **local package** at `packages/minicraft-bot/`, consumed through a `file:` dependency. Not
  published.
- The **version check**: `CLIENT_VERSION` travels as `hello.ver`, the server minimum is runtime
  config, and an outdated client gets 4004 plus a guarded automatic reload.
- **One protocol reference**, `docs/protocol.md`.

## 3. Architecture: one source tree, two builds

`packages/minicraft-bot/src/index.ts` is a thin entry. It imports the game's own modules:
- `src/engine/world/{generation,chunk,coords,world,overlay,v3/*}`
- `src/engine/input/raycast` (pure)
- `src/data/blocks.data`
- `src/game/tools` (`miningDuration`, `isRemovableId`)
- `src/net/{protocol,snapshot,mp-client,mp-sync,mp-reconnect,echo}`

A library build bundles these, together with their runtime deps (`simplex-noise`, `alea`, `pako`),
into `packages/minicraft-bot/dist/index.js` (ESM, target node22) plus **one rolled-up
`dist/index.d.ts`**. The game and the SDK share one implementation. Measured by gate 1: all of these
modules import and run in plain Node (`new World` and `getBlock` work).

**Build (`npm run build:bot`)**
- Vite library mode with `build.ssr`, everything bundled, `target: 'node22'`, `publicDir: false` (or
  the atlas gets copied in), and **`envDir` pointing at an empty folder**. Otherwise any `VITE_*` in
  `.env.local`, e.g. an MP token, would be inlined into the bundle. `mode: 'production'`, so
  `import.meta.env?.DEV` in `world.ts` compiles to `false`. That guard is allowed; it's the only
  `import.meta.env` use in the graph.
- **Import guard, checked on the module graph, not the text.** A small Vite plugin:
  - `resolveId` **throws** on `three`, on any id under `src/engine/render/`, `src/ui/`, `src/game/loop`
    or `src/main`, on `*.png`, and on `?url`;
  - `buildEnd` asserts every module id outside `src/` and `packages/` belongs to exactly the
    allow-list `{pako, alea, simplex-noise}`;
  - `transform` errors on `import.meta.glob` in any source module.
  - Text greps are not used: pako legitimately contains `state.window`, and a real three import can
    be minified past a grep.
- **Types:** one rolled-up `index.d.ts` from a declaration bundler. This is the one new
  devDependency, justified because tsc-emitted per-file declarations use extensionless relative
  imports, which a `nodenext` consumer can't resolve (gate 1 reproduced TS2305). The public types
  must not reference `three`. The public API never exposes `MpSync`, `GameLoop` or render types.
  The package tsconfig has `types: ["node", "vite/client"]`, because `world.ts` reads
  `import.meta.env`.
- `packages/minicraft-bot/package.json`:
  - `"name": "minicraft-bot"`, `"type": "module"`;
  - `"exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }`;
  - `"engines": { "node": ">=22" }`;
  - **no runtime dependencies**.
- `dist/` is git-ignored; `.gitignore` already covers `dist/`, so verify it. Add
  `packages/*/dist/**` to the eslint ignores in the same task that adds `build:bot`, because a built
  bundle trips no-unused-vars in pako.
- **Tests and typecheck.** The root `vitest.config` includes only `src/**` and `api/src/**`, and the
  root `tsc -b` only `src` and `scripts`.
  - The package gets its own `packages/minicraft-bot/vitest.config.ts` and tsconfig.
  - `npm run test:bot` = `build:bot`, then the package tests, then the consumer typecheck (§9.3).
  - A new root script `npm run typecheck` = `tsc -p tsconfig.json --noEmit` plus the package
    tsconfig. `fields<T>()` protocol checks fail only under tsc, and `npm test` never runs tsc.
  - Every task's verification runs `npm test`, `npm run typecheck`, `npm run lint`, plus
    `npm run test:bot` once the package exists.

## 4. Protocol changes (additive; `proto` stays 1)

**`hello`** gains:
- `ver: number`. The client build version, from `CLIENT_VERSION`, an integer exported from
  `src/net/protocol.ts` that starts at **1**. The SDK sends the constant from the source it was built
  from. Missing counts as 0; negative is clamped to 0 by the server.
- `bot?: boolean`. Only `true` marks a bot.

In Go these are `Ver int json:"ver"` and `Bot bool json:"bot,omitempty"`. A `ver` or `bot` of the
wrong JSON type (e.g. `1.5`, `"2"`, `"yes"`) fails the hello decode and gets **1008** "hello
expected", the same as a malformed `proto` today. This is documented and tested.

**The shared pose interval:** `POS_EVERY_MS = 100` moves from `main.ts` to `src/net/protocol.ts`, so
the SDK can use it. The game imports it from there, with no behaviour change.

**Server**
- **Version gate.** Config `MinClient int` from the flag `-min-client` or the env `MC_MIN_CLIENT`.
  - The flag wins **when it is set**, detected with `fs.Visit`, so `-min-client 0` overrides the env.
  - An unparsable or negative env value fails startup with a clear error.
  - The default is 0, which admits everyone.
  - After the existing `proto` range check (conn.go ≈ 262): if `max(h.Ver, 0) < MinClient`, refuse
    with an `error` message `{ code: 4004, message: "outdated", min: MinClient }`, then close with
    code 4004 and reason `outdated`.
  - `ErrorMsg` gains `Min int json:"min,omitempty"` in Go and `min?: number` in TS. `min` is always
    ≥ 1 when sent. `conn.go` gets a refuse variant that sets it.
  - The existing `proto` refusal keeps message `"proto"` and no `min`.
- **Bot flag.** Stored on the hub `Player` for the session only (no DB change).
  - Relayed as `bot: true` in `join` and in `welcome.players[]`.
  - `GET /worlds` `online`: **non-bots only**.
  - **Ruling:** bots are **not spawn-near targets**. `ChooseSpawn` skips `p.Bot`, because a bot has
    no physics and may be mid-air or inside stone.
  - **Ruling:** bots **don't block world deletion**. The 409 "players online" check counts only
    non-bots, and deleting a world with bots in it kicks them with **4006** (unknown world) first.
    Otherwise a parent would see an empty world they can't delete.
  - Name rules are unchanged for bots: 4008, 4009 and resume all apply.

**Golden fixtures and field lists move together.** The Go structs, the TS types, the Go sample
messages (which must set `Bot: true` in hello, join and `welcome.players[]`, and `Min` in error,
because `omitempty` drops unset fields), the regenerated `testdata/msg-*.json`, and the TS field
lists all land in **one commit**.

**Old ↔ new compatibility** (verified by gate 1)

| Pairing | Result |
|---|---|
| Old client ↔ new server with `min = 0` | Admitted. |
| Old client ↔ new server with `min > 0` | The old client gets 4004, which is in its FATAL list, so it shows the existing "Minicraft was updated" screen. The click runs `location.reload()` and loads the new bundle, because `index.html` is `no-cache`. |
| New client ↔ old server | Go ignores `ver` and `bot`. Bots work without the badge and count as online. |

## 5. Game client

- **Outdated handling.**
  - `MpClient` stores the last `error` message it received and passes it to its state handler on the
    fatal close. It clears the stored error on the synthetic two-4003 → 4004 path, which keeps
    today's click screen.
  - On close 4004 with `error.message === "outdated"`, a pure function decides:
    `outdatedAction(nowMs, markerRaw: string | null, canWrite: boolean) → 'auto' | 'click'`.
    The marker is sessionStorage `minicraft:v1:autoReloadAt`.

    | Condition | Result |
    |---|---|
    | No marker | `auto` |
    | Marker unparsable (NaN) | `auto` |
    | Marker ≥ 5 min old (exactly 5:00 counts as old) | `auto` |
    | Marker < 5 min old | `click` |
    | Marker in the future | `click` |
    | Marker can't be written (`canWrite` false) | `click`, so a storage failure can never loop |
  - `auto`: write the marker, show **"Updating Minicraft…"** for 2 s, then `location.replace` the URL
    with `v=<Date.now()>` added or replaced.
  - **Ruling:** the automatic reload **keeps** the `mp:autojoin` entry, so the kid lands straight back
    in the world. The 5-minute marker is the loop guard. `onFatalClose` clears autojoin as today for
    every other fatal case, **and** for `click`.
  - Every other 4004 or 4005 keeps today's click screen.
- **Robot badge.**
  - `RemotePlayers.upsert(id, name, skin, bot = false)` stores `bot`, and the label draws
    `🤖 ${name}` when it is true.
  - `positions()` also returns `bot`.
  - `main.ts` passes `bot` from `join` and `welcome.players[]`.
  - The minimap is unchanged.
  - Note: the 🤖 glyph needs an emoji font on the device. The e2e checks the drawn text; a real-device
    look is on Julien's morning list.
- The game sends `ver: CLIENT_VERSION` and never sends `bot`.

## 6. The SDK

### Conventions (in the README and `protocol.md`)
- A pose's `y` is the **feet**; the eye is `+EYE_HEIGHT` (1.6).
- `yaw` is in radians, forward = `(−sin yaw, 0, −cos yaw)`, so facing a target takes
  `yaw = atan2(−dx, −dz)`.
- `pitch` is in radians, positive looks up, clamped to ±π/2.
- `world` in `connect` is the world's **uuid** (from `listWorlds()`).
- The SDK re-exports `EYE_HEIGHT`, `WALK_SPEED` (5 blocks/s), `POS_EVERY_MS` and `raycastVoxel`.
  `EYE_HEIGHT` and `WALK_SPEED` move from `player.ts` into a pure shared module, and the game imports
  them from there.

### `BotWorld`
It's a `World` plus a `ChunkOverlay`, the same pair the game uses.
- **Snapshot:** `overlay.loadSnapshot(decodeSnapshot(buf).cells)`, then `world.overlay = overlay`,
  exactly as `main.ts` does.
- **Remote edits:** `MpSync.onEdit(msg, you)` runs the echo filter, and its `apply` callback calls a
  new shared helper `applyRemoteOps(world, overlay, ops)` in `src/engine/world/`. The helper is
  **extracted from** `GameLoop.enqueueRemote`/`drainRemote` (loop.ts ≈ 547–600), and the game loop
  now calls it, so the write path is one function, not two.
  - The bot applies synchronously: no frame loop and no per-frame cap.
  - The bot runs no liquid scheduler and no TNT. The kids' clients simulate liquids.
- **Local writes:** `world.setBlock`, with `onLocalWrite = sync.record`, then `sync.flushFrame()`
  immediately. `MpSync` is constructed with no light registry and a `getColor` stub that returns the
  colour given to `place`.
- **API:**
  - `getBlock(x, y, z)`: the chunk is generated on first read; out of bounds gives AIR.
  - `blockName(id)` and `blockId(name)`: `blockId` returns `null` for an unknown name, and the README
    lists the catalog names.
  - `isSolid(id)`, `isLiquid(id)`.
  - `groundY(x, z, nearY)`: the y of the first standable cell at or below `nearY + 2` (solid below,
    two air or liquid cells above for the body), scanning at most 64 down; `null` if none. This is
    the primitive for following. It doesn't land on a leaf canopy or a roof above a kid in a cave.
  - `surfaceY(x, z)`: the topmost non-air, non-liquid block, or −1.
  - `region(min, max)`: a `Uint16Array` of ids, indexed `(y−y0)·dx·dz + (z−z0)·dx + (x−x0)`, each
    side ≤ 32. It throws beyond that. It generates what it needs. This is the compact world view for
    LLM agents.
  - `findNearest(name, from, radius)`:
    - **Ruling:** it generates every chunk within the clamped radius (≤ 32 blocks, so ≤ 25 chunks,
      ≈ 230 ms), so the result is deterministic and doesn't depend on history.
    - It returns the nearest cell or `null`.
  - `onBlockChange(cb)`: `cb(x, y, z, oldId | null, newId, by)`.
    - It fires for every **applied** remote op, and for the bot's own local writes with
      `by === you`.
    - Echoes of the bot's own writes are filtered and don't fire twice.
    - `oldId` is `null` when the chunk wasn't generated yet.
- **Costs** (documented): about 30 ms for the first generated chunk, then roughly 2–9 ms per chunk;
  `findNearest` (≤ 25 chunks) about 0.2 s. The whole 1,024-chunk world is about 6.5 s and ~350 MB,
  which is about the server's 6 s silence limit, so a bot must never scan the whole world in one
  synchronous call. `region` and `findNearest` are bounded well below that.

### `BotClient`
- `new BotClient({ url, token, bid?, statePath?, editGapMs? })`.
  - `url` is the HTTP(S) base; `MpClient` derives the WebSocket URL (`^http` → `ws`).
  - `bid` resolution: the explicit `bid`, else the one saved in `statePath`, else **a stable hash of
    the bot name**. The stable hash avoids 4009 when a crashed bot restarts within the server's
    liveness window.
  - Node's WebSocket sends no Origin header, and the server's websocket library accepts that.
  - `listWorlds()` is `MpApi.listWorlds`.
- `connect({ world, name, skin }): Promise<{ you, spawn, players, world: BotWorld }>`.
  - It resolves after the snapshot is applied **and the spawn pose is sent**. A player with no pose is
    invisible to the kids and not a spawn-near candidate.
  - It rejects with:
    - `OutdatedClientError { ver, min }`, whose message says "rebuild the SDK: npm run build:bot";
    - `ReplacedError` (4001);
    - `ServerRefusedError { code, message }` for 4004 proto (and the synthetic two-4003 case), 4005,
      4006, 4007, 4008 and 4009.
- **Actions.** All of them throw `NotConnectedError` before `connect` resolves.
  - `move(pose)` sends `pos`, coalesced to one per `POS_EVERY_MS` (the latest pose wins). An unchanged
    pose is skipped, as in the game. The receiver's `PoseBuffer` snaps jumps over 8 blocks.
  - `walkTo(target: {x, z}, opts?)`:
    - It moves in a straight line at `WALK_SPEED`, one pose per `POS_EVERY_MS`, with `y` from
      `groundY` at each step and yaw facing the direction of travel.
    - It resolves on arrival. It rejects with `BlockedError` when `groundY` is `null` or rises more
      than 1 block in one step (a wall or cliff).
    - It is cancelled by the next `walkTo` or `move`.
    - It is not pathfinding.
  - `lookAt(x, y, z)` sets yaw and pitch from the eye to that point.
  - `place(x, y, z, name, color?)` and `break(x, y, z)`:
    - They apply locally, then flush one `edit`.
    - `place` refuses ids above `welcome.catalogMax`.
    - Each call waits for the **edit gap** since the previous edit: `editGapMs`, default **150 ms**,
      0 allowed. This is the SDK-side pacing and rate cap: an AI can't carpet a build faster than a
      kid could watch.
  - `mine(x, y, z, ms?)`:
    - It refuses a block that isn't removable (`isRemovableId`: not air, liquid or bedrock).
    - It turns to face the block (`lookAt`), sends `fx mine` with `tier: blockId` and `dur` in ms
      (default `miningDuration(hardness, 0, 'none') × 1000`), waits, then `break`s.
  - `fx(msg)` sends a raw fx message.
- **The safety net** (SDK-side, since server limits were declined):
  - Every edit the bot makes is appended to a journal `(x, y, z, oldId, newId, time)`, kept in memory
    and in `statePath` when given.
  - `revert(sinceMs?)` undoes the bot's own edits newest-first, restoring `oldId` only where the
    current block is still the bot's `newId`. It never overwrites a kid's later change.
- **State and events:**
  - `players()` returns `{ id, name, skin, bot, x, y, z, yaw, pitch, hasPos }`.
  - A typed emitter with `join`, `left`, `pose`, `edit`, `fx`, `leaving`, `close(code)`, `reconnect`.
- **Reconnect** (the game has none in-process; it reloads the page):
  - On a transient close, `BotClient` runs the game's `Reconnector` (`mp-reconnect.ts`, probing
    `listWorlds` at 1, 2, 4, 8 and 15 s, giving up at 30 s).
  - On success it opens a **new** `MpClient` with `resume: true`, the same bid, and the **same**
    in-memory `StorageLike`, so the two-4003 counter survives.
  - `BotWorld` is **reset in place** from the new welcome: a new World and overlay, with pending
    writes dropped. The same object stays valid.
  - Then `reconnect` fires and the spawn pose is re-sent.
  - If it gives up: `close`, then stop.
  - Fatal codes (the reject list above) stop immediately.

## 7. `docs/protocol.md`, the single reference

It covers:
1. transport: the URL, token, WebSocket, JSON text frames plus one binary snapshot frame, and the
   Origin note;
2. the handshake and resume;
3. every message in both directions, each with its fields' types, ranges and meanings and the
   server's validation (sizes, clamps, `SkinOf`, the name rule, `MaxSkinBytes`, `MAX_OPS_PER_EDIT`,
   the extras size, and malformed `ver`/`bot` → 1008);
4. every close code and what a client should do;
5. the snapshot binary format and the op encoding (`[x, y, z, id, fluid, color]`, colour packing);
6. pose conventions and coordinates (§6), with a pointer to `docs/worldgen-from-seed.md` for terrain.
   That file is untracked in the main checkout and belongs to other work: link it, don't copy it;
7. versioning: `proto`, `ver`/`MinClient`, `gen`, and what counts as additive;
8. HTTP: `/health`, `/worlds` (list, create, delete and the bot rules);
9. costs and limits (§6), and a bot quick-start that points at the SDK README.

**The doc move.** The protocol tables move **out of** `docs/multiplayer.md` into `protocol.md`, and
the doc test moves with them. The test hard-codes its path and the headings "### Client → server",
"### Server → client" and "### Close and error codes". Update the inbound links too: `CLAUDE.md`
(lines ≈ 19 and 37), `docs/specs.md` (≈ 7 and 23), `docs/playtime.md:68` and
`docs/skins-research.md:102`.

**The upgraded doc test** fails if any of these three drift apart:
- **protocol.md:** for every message, the doc's field list;
- **TS:** the `fields<T>()` lists in `protocol.test.ts`, which the typecheck ties to the types;
- **Go:** a Go test that lists each wire struct's json tag names **by reflection**, not by marshalling
  samples (so `omitempty` can't hide a field), and writes them to the checked-in
  `server/internal/proto/testdata/fields.json`. It fails with `-update` guidance when the file is
  stale. The TS doc test reads that file.

## 8. Operations

- **The runbook** (`server/README.md`), to force an update:
  1. Bump `CLIENT_VERSION`.
  2. Build and deploy the site.
  3. Check that the bare `/minicraft/` URL serves the new bundle hash (`curl`).
  4. Rebuild the bots.
  5. Set `MC_MIN_CLIENT=<new>` in `~/minicraft-mp/env`.
  6. `systemctl --user restart minicraft-server`.
- The VM path's `vm-setup.sh` rewrites its env file with only `MC_TOKEN` and `MC_GCS_BUCKET`. Note
  that `MC_MIN_CLIENT` must be added there by hand; the live Beast unit is unaffected.
- **Nothing in this job deploys.** Julien decides.

## 9. Tests (each must be able to go red; every "prove red" is run once and recorded)

| # | Area | Checks | Prove red |
|---|---|---|---|
| 1 | Parity, through the **built** bundle (`test:bot`) | Reproduces the 6 reference hashes (`generation.test.ts`) and the 11 coverage hashes: seed 12345 chunks (10,2) 2228629264, (12,13) 282354078, (1,23) 1029461773, (0,16) 1969857804, (1,24) 4095451757, (6,22) 1052017669, (6,27) 3335755431, (7,15) 1876328107, (9,2) 2754869114; seed 1 (25,19) 158084171; seed 4 (25,14) 4284147560. **Load-bearing:** only the last two catch a float64 build. A missing `dist` fails the test; `test:bot` always builds first. | In a scratch build, `DEEPSLATE_Y` 48→47 (red on 15 of 17), and Float32→Float64 (red on the last two). Don't use `ENT_T`, which stays green. |
| 2 | Import guard | `build:bot` passes on the clean tree. | Adding `import 'three'`, or a `src/engine/render` import, to the entry fails the build with the plugin's message. |
| 3 | Consumer typecheck | A fixture consumer (`packages/minicraft-bot/test/consumer/`, with tsconfig `module`/`moduleResolution: nodenext`, `strict`, **no** `skipLibCheck`) imports `BotClient`, `BotWorld` and the constants and typechecks against `dist/index.d.ts`. Separately, `dist/index.d.ts` must not contain `three`. | Point the types at tsc's per-file output: TS2305 appears. |
| 4 | Go | `ver < min` gives the error `{outdated, min}`, then close 4004; missing `ver` counts as 0; negative is clamped; `min 0` admits; `-min-client 0` beats the env; a bad env value fails startup. Malformed `ver`/`bot` → 1008. `bot` is relayed in `join` and `welcome.players[]`. `/worlds` `online` excludes bots. `ChooseSpawn` never targets a bot. Deleting with only bots online kicks them with 4006 and succeeds, but with a kid online it still returns 409. A bot with a taken name gets 4009. The reflection field list matches `fields.json`. | Adding a struct field without updating `fields.json` fails. Removing the bot filter fails the `/worlds` test. |
| 5 | Game client (vitest + typecheck) | The full `outdatedAction` table (§5). `MpClient` passes the error through and clears it on the two-4003 path. Via the injectable canvas factory, the label for `bot: true` calls `fillText` with `🤖 Robo`. `fields<>` covers `ver`, `bot` and `min`. | Changing the guard to `canWrite`-ignorant fails the no-write row. Dropping the badge fails the `fillText` check. |
| 6 | SDK unit (`test:bot`, node) | `applyRemoteOps` extraction: the **game's** existing loop and liquid tests stay green (the game uses it). `BotWorld` over the `mp-sync.test.ts` and `mp-liquid.test.ts` fixtures matches the game's `World`. `groundY` (under a tree, under a roof, on water, `null`). `region` (indexing, the 32 cap). `findNearest` (deterministic regardless of read history). `onBlockChange` (remote, own, echo not doubled, `oldId` null). `BotClient` with a fake socket: refusal codes → typed errors (4001 included); `move` coalesced and unchanged poses skipped; `walkTo` paces at `WALK_SPEED` (pose spacing ≤ 5 × 0.1 + ε) and rejects on a wall; `mine` faces the block, sends dur in ms and `tier`, and refuses bedrock; `place` refuses ids above `catalogMax` and waits `editGapMs`; `revert` doesn't overwrite a later kid edit; reconnect keeps the bid and the storage and resets `BotWorld` in place. | `walkTo` at 2× speed fails. `revert` without the `newId` check fails. |
| 7 | E2E **E11** (`mp-e2e`, uses the built SDK) | Browser A plus the SDK bot "Robo" (`skin: 'enderman'`). A's recorded `fillText` strings include `🤖 Robo`, and A's `remote.positions()` has Robo **with a pose**, i.e. visible. `/worlds` `online` does **not** contain Robo. The bot `walkTo`s near A, and A sees its pose move. The bot `place`s stone, and A sees it within 500 ms. A breaks a block, and `BotWorld` sees air within 500 ms. The bot `mine`s: A's cracks oracle shows cracks, then air. The bot disconnects **before E4**. Placed after E9 and before E4; `E11` is added to `needMp`; setup runs `build:bot`. | |
| 8 | E2E **E12**, version gate (runs **last**, after E5, with fresh contexts) | `startMc(extraEnv)` gets an env parameter; every other start deletes `MC_MIN_CLIENT`. E12 restarts its own server on :18080 with `MC_MIN_CLIENT=CLIENT_VERSION+1`. The SDK `connect` rejects with `OutdatedClientError { min }`. A fresh browser joins: it shows "Updating…", auto-reloads once (with autojoin kept), gets 4004 again, and shows the **click** screen. The main-frame `framenavigated` count is exactly 1, watched for 5 s after the click screen. | A build with the guard forced to `auto` reloads twice (run once, recorded). |
| 9 | Docs | The doc test (§7) fails if `protocol.md`, the TS types or the Go structs drift apart. | Adding a field on either side without the doc fails. |

All e2e runs set `MP_E2E_SCRATCH` (the script requires it), run headless, and check that ports
18080, 5174 and 5175 are free first. Never touch port 8080.

## 10. Sequencing (each step leaves `npm test`, typecheck, lint and go test green)

1. **Wire fields, atomically:**
   - TS: `ver`, `bot`, `min`, `CLIENT_VERSION`, and `POS_EVERY_MS` moved;
   - Go: `Ver`, `Bot`, `Min`;
   - sample messages, goldens, the reflection field list plus `fields.json`, and TS field lists.
2. **Server:** the `MinClient` config and gate, the bot flag and relay, `/worlds` online, spawn, and
   delete.
3. **Game client:** `MpClient` error pass-through, `outdatedAction` plus the Updating screen plus
   autojoin kept, the robot badge, and `main.ts` wiring (`ver`, `bot`).
4. **Shared extractions:** `applyRemoteOps` (the game uses it), and `EYE_HEIGHT` and `WALK_SPEED`
   moved to a pure module.
5. **SDK package:** the build (guard, envDir, publicDir, dts rollup), `BotWorld`, `BotClient`, its
   unit tests, the consumer typecheck, `test:bot`, `typecheck`, the eslint ignore, and the README.
6. **`docs/protocol.md`** plus the doc move plus the upgraded doc test plus link updates.
7. **E2E** E11 and E12, and the `startMc` env parameter.

## 11. Files (expected)

- **New:**
  - `packages/minicraft-bot/{package.json, README.md, tsconfig.json, vite.config.ts, vitest.config.ts, src/index.ts, src/bot-world.ts, src/bot-client.ts, src/errors.ts, test/**}`
  - `src/engine/world/apply-remote.ts` (plus test), `src/game/outdated.ts` (plus test), and a pure constants module (e.g. `src/game/player-constants.ts`)
  - `docs/protocol.md`, `server/internal/proto/testdata/fields.json`
- **Changed:**
  - `src/net/{protocol,mp-client}.ts`, `src/game/{loop,mp-exit,player}.ts`, `src/ui/mp-overlays.ts`, `src/main.ts`, `src/engine/render/remote-players.ts`
  - `server/internal/{config,net,hub,proto}/**` and the goldens
  - root `package.json` (`build:bot`, `test:bot`, `typecheck`, one devDependency for the dts rollup), `eslint.config.js`
  - `docs/multiplayer.md` and the inbound links, `server/README.md`, `scripts/mp-e2e.ts`, and the doc test

## 12. Gate-1 disposition and rulings

**Accepted:**
- **Build guard:** the import guard checks the module graph, not text (a text grep fails on a clean
  build because of pako, and can miss three); `envDir` isolation, so no token can leak into the SDK;
  `publicDir: false`; the `import.meta.env` claim corrected; the eslint ignore.
- **Types:** a rolled-up `.d.ts` checked by a nodenext consumer test, with no `three` in the types.
- **Go side:** the reflection field list (because `omitempty` hid new fields); Go typed-decode
  semantics (1008); a flag-over-env rule that works for ints; atomic goldens.
- **Tests:** a typecheck in the verification steps (because `fields<>` is tsc-only); package test
  discovery.
- **Reconnect:** built in `BotClient` from `Reconnector`, with a new `MpClient` and the same storage.
- **Edit path:** the `applyRemoteOps` extraction, replacing the false "MpSync applies edits" claim.
- **Error handling:** 4001 is fatal; the error stored in `MpClient`, not carried in the close
  reason; the `outdatedAction` storage-failure rows.
- **Bot identity:** a stable default bid.
- **Visibility and movement:** the spawn pose is sent on connect; the pose conventions are
  documented; `groundY`, `walkTo`, `lookAt`, `region`, and the re-exported raycast and constants.
- **Mining:** `mine` faces the block, uses ms units and `tier`, and refuses non-removable blocks.
- **Protocol details:** `POS_EVERY_MS` shared; the `catalogMax` check; the `getColor` stub.
- **SDK safety net:** the journal plus `revert`, and the edit gap.
- **E2E:** oracles on recorded `fillText` and on visibility; bots absent from `online`; E11 placed
  before E4 and disconnecting first; E12 last with `startMc(extraEnv)`; E12 proves the reload guard.
- **Docs:** the cost numbers; the doc-move links; the vm-setup note.

**Rulings on Julien's behalf** (he delegated while asleep), each with its cost if wrong:
1. Bots are not spawn-near targets. *Cost if wrong:* a kid can't spawn beside a companion bot. One
   line to allow it.
2. Bots don't block world deletion; they are kicked with 4006. *Cost if wrong:* a bot is kicked when
   a parent deletes the world, which is the intent anyway.
3. The auto-reload keeps autojoin; the 5-minute marker guards against loops. *Cost if wrong:* after
   an update the kid lands back in the world instead of on the menu.
4. `findNearest` generates within its radius, so it's deterministic. *Cost if wrong:* up to ~230 ms
   per call.
5. SDK-side pacing (150 ms edit gap) plus the journal and `revert`. *Cost if wrong:* bots edit a bit
   slower than raw; `editGapMs: 0` removes it.
6. Bots stay hidden from the menu's online list, as Julien chose. The consumer reviewer suggested
   showing "🤖 Robo" separately; not done. *Cost if wrong:* a kid doesn't know a robot is in the
   world until they join and see it.
7. One new devDependency for the `.d.ts` rollup. *Cost if wrong:* one dependency.

## 12a. Gate-2 amendments (these override §3, §6 and §9 where they differ)

**Build**
- The Vite config also sets `envPrefix: '__MINICRAFT_BOT_NO_ENV__'`, because Vite inlines `process.env` `VITE_*` variables even when `envDir` is empty. The env test uses a fixture that reads the variable and proves both leak and no-leak.
- The guard plugin is `enforce: 'pre'`. Its module check uses **resolved** paths against an allow-list of `src/` directories and files (not all of `src/`), plus `pako`, `alea` and `simplex-noise`. Each rule is proven red on its own.
- Nothing in the root typecheck imports `dist` statically. Tests and scripts take types from source and load `dist` at run time.

**Protocol fields**
- `fields.json` is keyed by the golden file names, including `edit` and `edit-out` and nested paths (`welcome.spawn`, `worlds-row.online`, …). It is walked recursively, a `go/parser` reachability check proves every struct is reached, and `omitempty` is recorded as `?`, which the doc test compares with protocol.md's `?` markers.

**BotWorld**
- `create(welcome, snapshot)` and `reset(welcome, snapshot)` are **atomic**: new World, overlay loaded **before** the world is used, new MpSync, then a reference swap. Otherwise chunks read between the welcome and the snapshot would stay stale for good.
- Every public coordinate API floors its inputs.
- `onBlockChange` fires only for applied ops, and returns an unsubscribe function.

**BotClient**
- `pose()` returns the bot's own pose. `players()` excludes the bot itself.
- `walkTo` resolves `'arrived' | 'cancelled'` and rejects **only** with `BlockedError{at, reason: 'wall' | 'noGround'}`. A cancellation never rejects, because an unhandled rejection kills Node.
- `lookAt` and `mine` don't cancel a walk.
- A drop is capped at 2 blocks per pose step.
- `place` requires a real, visible id. It refuses cells inside any kid's two-cell body column. **Ruling:** it refuses bedrock, which kids can't break.
- `mine` sends `dur` equal to the time the bot actually waits, and sends `mine-stop` when cancelled.
- `revert` doesn't journal its own writes.

**Game client and e2e**
- The auto-reload counts as a reconnect reload for the play timer.
- `decideOutdated`: a read that throws → click, and the marker is verified after writing.
- E12 counts page loads, not `framenavigated`.
- E11 runs immediately before E4.
