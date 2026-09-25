# Protocol Job (Bot SDK, Version Check, Protocol Reference): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a local TypeScript bot SDK built from the game's own sources, a server-driven client version gate with a guarded auto-reload, a bot flag, and one protocol reference whose tables are tested against the TS and Go definitions.

**Architecture:** Additive wire fields (`ver`, `bot`, `min`), with `proto` staying at 1. The Go server gains a runtime `MinClient` gate and bot handling. The game client gains outdated handling and a 🤖 label. A shared `applyRemoteOps` helper is extracted from `GameLoop`. The SDK in `packages/minicraft-bot` imports game modules and is bundled by Vite library mode, with a module-graph import guard, an isolated env, and a rolled-up `.d.ts`.

**Tech Stack:** TypeScript, Vite 5, vitest, three (game only), Go 1.2x (`~/.local/go/bin/go`), coder/websocket, Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-09-25-protocol-bots-design.md` (rev 2). It is the authority. Read the sections each task cites.

## Global Constraints

- Tabs for indentation (1 tab = 4 spaces).
- `proto` stays 1. All wire changes are additive. `CLIENT_VERSION = 1`.
- **Go:** `Ver int json:"ver"` and `Bot bool json:"bot,omitempty"` in Hello; `Bot bool json:"bot,omitempty"` in Join and in the welcome player entry; `Min int json:"min,omitempty"` in ErrorMsg.
- **TS:** `ver: number`, `bot?: boolean`, `min?: number`.
- The outdated refusal is the error message `{t:'error', code:4004, message:'outdated', min:N}`, then close 4004 with reason `outdated`.
- `MC_MIN_CLIENT` env or `-min-client` flag. The flag wins only when explicitly set (`fs.Visit`). A bad or negative env value is a startup error. The default is 0.
- Bots are excluded from: `/worlds` `online`, spawn-near targets, and the delete 409 check. Deleting a world kicks its bots with 4006.
- The auto-reload marker is sessionStorage `minicraft:v1:autoReloadAt`, with a 5-minute window, a 2 s "Updating Minicraft…" screen, and `location.replace` with `v=<now>`. Autojoin is kept for `auto`.
- The label is `🤖 ${name}` when `bot`.
- The SDK defaults `editGapMs` to 150, `WALK_SPEED` is 5, and `POS_EVERY_MS` is 100 (moved to `src/net/protocol.ts`). `EYE_HEIGHT` is 1.6.
- The SDK bundle may only contain modules from `src/`, `packages/`, `pako`, `alea` and `simplex-noise`. Build with `envDir` pointing at an empty dir, `publicDir: false`, target node22, and one rolled-up `dist/index.d.ts` that has no `three`.
- **Verification in every task:** full `npm test`, `npm run typecheck` (added in Task 1), `npm run lint`, and `cd server && ~/.local/go/bin/go test ./...`. From Task 5 on, also `npm run test:bot`.
- Never touch port 8080, `~/minicraft-mp`, or `minicraft-server.leap-forward.ca`. E2E runs with `MP_E2E_SCRATCH=/tmp/claude-1000/-home-julien-Projects-Minicraft/b79f7b62-dcf5-4bf5-9b80-08b74dcaef7e/scratchpad` via `rtk proxy npx tsx …`, headless, after checking ports 18080, 5174 and 5175 are free. Kill servers only by port, and only ones you started.
- Never delete anything outside the worktree and that scratchpad. Stage explicit paths. Never commit `package-lock.json` changes unless the task adds a devDependency (Task 5), `dist/`, or `.claude/agent-memory/`.
- Commit messages end with a blank line, then these two lines:
  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Wv64SyRKwvGQi2fmEPuX21
  ```

## Review Focus

1. **A kid on a stale cached bundle while the server minimum is 0:** plays normally. When the minimum is raised: one click (old bundle) or one automatic reload (new bundle), never a loop. (Tasks 2, 3, 7.)
2. **A malformed or hostile hello (`ver:"x"`, `bot:1`, huge `ver`):** refused with 1008, or treated per the rules. The server never crashes, and a kid's session is never affected. (Task 2.)
3. **A buggy AI bot spamming edits or teleporting:** paced by `editGapMs`, and undoable with `revert` without touching kids' later edits. A pose jump snaps on receivers but never breaks them. (Task 5.)
4. **A bot left in a world:** doesn't block deletion, isn't a spawn target, isn't listed as online. (Tasks 2, 7.)
5. **An SDK built while `.env.local` holds an MP token:** the bundle has no token. (Task 5, envDir isolation test.)

---

### Task 1: Wire fields, shared constants, typecheck script (atomic TS ↔ Go ↔ goldens)

**Files:**
- Modify: `src/net/protocol.ts` (`CLIENT_VERSION`, `Hello.ver`, `Hello.bot?`, `Join.bot?`, welcome player `bot?`, `ErrorMsg.min?`, `POS_EVERY_MS`)
- Modify: `src/main.ts` (import `POS_EVERY_MS` from protocol; send `ver: CLIENT_VERSION` in the hello it builds; never `bot`)
- Modify: every TS test that builds a `Hello` (tsc will list them), plus `src/net/protocol.test.ts` (`fields<>` lists)
- Modify: `server/internal/proto/proto.go` (fields, spec §4), `server/internal/proto/messages_test.go` (sample messages set `Bot: true` in hello, join and welcome players, and `Min: 2` in the error sample), and the regenerated `server/internal/proto/testdata/msg-*.json`
- Create: `server/internal/proto/fields_test.go` (the reflection field list) and `server/internal/proto/testdata/fields.json`
- Modify: root `package.json` (add a `"typecheck": "tsc -p tsconfig.json --noEmit"` script; Task 5 extends it)

**Interfaces produced:**
- `CLIENT_VERSION: number` (1)
- `POS_EVERY_MS: number` (100)
- TS types `Hello{…, ver: number, bot?: boolean}`, `Join{…, bot?: boolean}`, `Welcome.players[i].bot?: boolean`, `ErrorMsg{…, min?: number}`
- Go `proto.Hello.Ver/Bot`, `proto.Join.Bot`, the welcome player struct's `Bot`, `proto.ErrorMsg.Min`
- `testdata/fields.json`: `{ "<key>": ["field", "optfield?", …sorted] }`. Keys are the **golden file names** (`hello`, `pos`, `edit`, `edit-out`, `fx`, `extras`, `leaving`, `welcome`, `tick`, `join`, `left`, `error`, `ping`, `worlds-row`, …), and nested structs are keyed by path (`welcome.world`, `welcome.players`, `welcome.spawn`, `worlds-row.online`, …). A trailing `?` marks `omitempty`.

- [ ] **Step 1: Go reflection field list, failing test first.** `fields_test.go`:
  - The roots are one per wire message, keyed by golden name (`"hello": proto.Hello{}`, `"edit": proto.Edit{}`, `"edit-out": proto.EditOut{}`, `"worlds-row": proto.WorldRow{}`, …; use the real struct names from proto.go).
  - It walks each root's fields **recursively** through struct, pointer, slice and array element types, recording each nested struct under `<parent>.<jsonName>`. The json name is `strings.Split(tag, ",")[0]`, skipping `-`. It appends `?` when the tag contains `omitempty`.
  - It compares the sorted result with `testdata/fields.json`; `-update` rewrites the file.
  - **Reachability check:** with `go/parser`, list every `type X struct` in proto.go that has json tags, and fail if any isn't reached from a root. The one exemption is `Envelope` (the `{t}` dispatch struct, not a wire message), listed by name in one place with that reason. Fix any other failure by adding a root.
  - The create-world request body (http.go) is out of scope and documented in protocol.md by hand.
  - Run it: it FAILS (no file). Run with `-update` and inspect the file.
  - Prove red later in this task: add `Foo string json:"foo,omitempty"` to the online-player struct and confirm TestWireFields fails, then revert.
- [ ] **Step 2: Add the Go fields** (spec §4). Run `-update` again. The diff of `fields.json` shows exactly `ver`, `bot` (hello, join, welcome.players) and `min` (error). Update the samples in `messages_test.go`, regenerate the goldens with that test's `-update` flag, and run `go test ./...` green.
- [ ] **Step 3: TS types plus `fields<>` lists** in `protocol.test.ts`. The test that compares TS field lists with the goldens' keys must pass once the goldens carry `bot` and `min`. Move `POS_EVERY_MS` from main.ts to protocol.ts with a comment ("the pose interval; the game and the bot SDK share it").
- [ ] **Step 4: Add the `typecheck` script.** Run `npm run typecheck`: it lists every Hello construction missing `ver`. Add `ver: CLIENT_VERSION` in `main.ts` (where the hello is built) and in the tests. Prove the instrument: remove `ver` from the `fields<Hello>` list, confirm `npm run typecheck` fails (TS2345), then revert.
- [ ] **Step 5: Verify and commit.** Run full `npm test`, `npm run typecheck`, `npm run lint` and `go test ./...`, then commit: `feat(proto): ver, bot and min wire fields; reflection field list; typecheck script`.

---

### Task 2: Server version gate, bot flag, `/worlds` online, spawn and delete rules

**Files:**
- Modify: `server/internal/config/config.go` (plus test), `server/internal/net/conn.go` (plus test), `server/internal/hub/*` (Player.Bot, join/welcome relay, `infos`/online, `ChooseSpawn`), `server/internal/net/registry.go` (Delete), `server/internal/net/http.go` (online filter, if it's done there)

**Interfaces:** `config.Config.MinClient int`; a `conn.refuseOutdated(min)` variant (or `refuse` with a min argument) that sends `ErrorMsg{Code:4004, Message:"outdated", Min:min}` and then kicks with 4004 and reason `outdated`.

- [ ] **Step 1: Config tests first** (`config_test.go`):
  - `MC_MIN_CLIENT=3` → 3;
  - `-min-client 0` with `MC_MIN_CLIENT=3` → 0 (the explicit flag wins);
  - no flag, no env → 0;
  - `MC_MIN_CLIENT=abc` → error;
  - `MC_MIN_CLIENT=-1` → error;
  - `-min-client -1` → error.

  Implementation:
  ```go
  fs.IntVar(&c.MinClient, "min-client", 0, "lowest client build version admitted (env MC_MIN_CLIENT; 0 admits all)")
  // after Parse:
  set := false
  fs.Visit(func(f *flag.Flag) { if f.Name == "min-client" { set = true } })
  if !set {
  	if v := os.Getenv("MC_MIN_CLIENT"); v != "" {
  		n, err := strconv.Atoi(v)
  		if err != nil || n < 0 {
  			return Config{}, fmt.Errorf("MC_MIN_CLIENT must be a non-negative integer, got %q", v)
  		}
  		c.MinClient = n
  	}
  }
  if c.MinClient < 0 {
  	return Config{}, errors.New("-min-client must be non-negative")
  }
  ```
  Thread `MinClient` to wherever conn.go reads config (follow how `Origins` or the token reach the conn).
- [ ] **Step 2: Gate tests (net tests, existing harness).**
  - Server min 2:
    - hello `ver 1` → an error message `{code 4004, message "outdated", min 2}`, then close 4004 with reason "outdated";
    - `ver 2` → welcome;
    - no `ver` → refused.
  - Min 0: no `ver` → welcome.
  - `ver -5` at min 0 → welcome (clamped).
  - `ver` of `"2"` or `1.5`, `bot: 1` → close 1008 (existing "hello expected" path).
  - A wrong `proto` still gets message `"proto"` without `min`.

  Implement after the proto range check: `if max(h.Ver, 0) < minClient { c.refuseOutdated(minClient); return }`.
- [ ] **Step 3: Bot flag tests (hub and net).**
  - A bot hello → other players' `join` has `bot: true`, and a later joiner's `welcome.players` entry has `bot: true`.
  - A non-bot → the field is absent.
  - `/worlds` `online` lists only non-bots.
  - `ChooseSpawn` with only a bot online returns the non-near spawn (look at its current fallbacks); with a bot and a kid online it never picks the bot. Run this with a deterministic `rnd` over many iterations.
  - `Delete` with only bots in a loaded world: the bots are kicked with 4006 and the delete succeeds. With a kid: `errOccupied` (409) as today.
  - A bot with a name that's online from another bid → 4009.

  Implement: `Player.Bot` is set from the hello at join. `Empty()` stays as it is (it's used for unloading). Add `HumanCount()` or `OnlyBots()` for Delete, and a `KickBots(code)` on the World that runs through the hub's command channel, as other kicks do. Filter `infos` for `online`.
- [ ] **Step 4: Prove the instruments.** Remove the bot filter from online → its test fails. Swap the flag/env precedence → the config test fails. Revert both.
- [ ] **Step 5: Verify and commit.** Run the full suites, then commit: `feat(server): client version gate (MC_MIN_CLIENT) and bot players`.

---

### Task 3: Game client: outdated auto-reload and robot badge

**Files:**
- Create: `src/game/outdated.ts`, `src/game/outdated.test.ts`
- Modify: `src/net/mp-client.ts` (plus test), `src/game/mp-exit.ts` (plus test), `src/ui/mp-overlays.ts` (the "Updating Minicraft…" screen), `src/main.ts` (wiring; pass `bot` to upsert), `src/engine/render/remote-players.ts` (plus test)

**Interfaces:**
- `outdatedAction(nowMs: number, markerRaw: string | null, canWrite: boolean): 'auto' | 'click'`
- `AUTO_RELOAD_KEY = 'minicraft:v1:autoReloadAt'`, `AUTO_RELOAD_WINDOW_MS = 300_000`, `UPDATING_SCREEN_MS = 2_000`
- `MpHandlers.onState('fatal', code, err?: ErrorMsg)`, where `err` is the last error message received before a server close, or undefined
- `RemotePlayers.upsert(id, name, skin, bot = false)`; `positions()` entries gain `bot`

- [ ] **Step 1: `outdated.ts`, test first.** The table must include every row in spec §5:

  | now | marker | canWrite | → |
  |---|---|---|---|
  | 1e6 | null | true | auto |
  | 1e6 | "abc" | true | auto |
  | 1e6 | String(1e6 − 300_000) | true | auto (exactly 5:00) |
  | 1e6 | String(1e6 − 299_999) | true | click |
  | 1e6 | String(1e6 + 5_000) (future) | true | click |
  | 1e6 | null | false | click |

  ```ts
  export function outdatedAction(nowMs: number, markerRaw: string | null, canWrite: boolean): 'auto' | 'click' {
  	if (!canWrite) return 'click';
  	if (markerRaw === null) return 'auto';
  	const at = Number(markerRaw);
  	if (!Number.isFinite(at)) return 'auto';
  	if (at > nowMs) return 'click';
  	return nowMs - at >= AUTO_RELOAD_WINDOW_MS ? 'auto' : 'click';
  }
  ```
  Plus a small browser-side wrapper, `decideOutdated(storage, now)`:
  - a **read that throws** → `click`;
  - storage-free backstop: if the current URL already has a `v=` param younger than 5 minutes → `click`. This covers storage that reads back but doesn't survive the navigation;
  - then `outdatedAction(now, raw, true)`;
  - on `auto`, write the marker (`String(now)`) and **read it back**; if the write throws or the value doesn't match, → `click`.

  Its own tests, with a fake storage:
  - auto writes the marker = now;
  - a throwing write → click;
  - a throwing read → click;
  - two calls in a row → auto, then click.
- [ ] **Step 2: `MpClient` error pass-through.**
  - Store the last `error` message in `onData`, then pass it to `onState('fatal', code, err)` on a server close.
  - On the synthetic two-4003 → 4004 path, pass **no** error.
  - Tests: a server error `{outdated, min 2}` followed by close 4004 → handler gets `err.message === 'outdated'` and `err.min === 2`; the two-4003 path → no `err`.
- [ ] **Step 3: Wire the fatal path** (`mp-exit.ts` `onFatalClose`, `main.ts`).
  - When the code is 4004 and `err?.message === 'outdated'`, call `decideOutdated`.
  - `auto`: keep the `mp:autojoin` entry, show the overlay's new Updating screen, and after `UPDATING_SCREEN_MS` run `location.replace(url with v=<Date.now()>)`. Use URL/URLSearchParams to add or replace `v`, and don't strip `v` afterwards with `history.replaceState`.
  - The reload must count as a **reconnect reload** for the play timer, via the same mechanism the existing resume reload uses (main.ts ≈ 967: "the autojoin flag is still set: the reload rejoins with `resume`"; find how playtime detects it). Otherwise the kid's play session resets. Add a test at the level where that rule is tested today.
  - `click`: today's behaviour, which clears autojoin and shows the "updated" click screen.
  - All other fatal cases are unchanged.
  - Unit-test `onFatalClose` through its injectable deps (see the existing `FatalDeps`): auto keeps autojoin and schedules a replace; click clears autojoin.
- [ ] **Step 4: Robot badge.** `upsert` stores `bot`, and the label text is `bot ? `🤖 ${name}` : name`. Re-upserting a changed `bot` redraws the label.
  - Test through the injectable canvas factory (see the existing `fakeCanvas` in `remote-players.test.ts`): `upsert(1, 'Robo', 'enderman', true)` → the recorded `fillText` has `🤖 Robo`, and `positions()` has `bot: true`.
  - `main.ts` passes `m.bot` from `join` and from `welcome.players`.
- [ ] **Step 5: Prove the instruments.** `outdatedAction` ignoring `canWrite` → the no-write row fails. Dropping the badge → the `fillText` test fails. Revert both.
- [ ] **Step 6: Verify and commit.** Run the full suites, then commit: `feat(mp): outdated clients auto-reload once; bots get a robot badge`.

---

### Task 4: Shared extractions: `applyRemoteOps` and player constants

**Files:**
- Create: `src/engine/world/apply-remote.ts` (plus test), `src/game/player-constants.ts`
- Modify: `src/game/loop.ts` (`drainRemote` uses the helper), `src/game/player.ts` (imports the constants)

**Interfaces:**
- `EYE_HEIGHT = 1.6` and `WALK_SPEED = 5` in `player-constants.ts`. Take the exact current values from `player.ts` and don't change them.
- `applyRemoteOp(world: World, op: Op): { applied: boolean; oldId: BlockId | null }`, the per-cell core of `drainRemote`:
  - skip out of bounds;
  - chunk not loaded → `{ applied: false, oldId: null }`;
  - same id and fluid → `{ applied: false, oldId }`;
  - otherwise `world.writeRemote(x, y, z, id, fluid)` → `{ applied: true, oldId }`.
- `applyRemoteOps(world, overlay, ops, onApplied?)`: for each op, `overlay.set(…)` then `applyRemoteOp`, synchronously. This is the SDK's path. The game keeps its own queue and effects (mining cancel, TNT fuse, lamps, relight batch, lift) around `applyRemoteOp`.

- [ ] **Step 1: Tests first.**
  - `apply-remote.test.ts`: an op on an unloaded chunk → the overlay is updated, `applied` is false, `oldId` is null; a same-value op → not applied; a changed op → `writeRemote` is called and `oldId` is returned; out of bounds → skipped.
  - Reuse the reduced client in `src/game/mp-liquid.test.ts` (`receive()`) as a parity fixture: the same op sequence through `applyRemoteOps` gives the same blocks.
- [ ] **Step 2: Implement, and refactor `drainRemote`.** `applied` is `writeRemote`'s return value. The loop body becomes:
  ```ts
  const r = applyRemoteOp(this.world, op);
  if (r.oldId === null) continue;             // out of bounds or chunk not loaded
  if (!r.applied && !recolor) continue;       // a colour-only op must still relight and cancel mining
  // then, unchanged in order: mining cancel; if (r.oldId !== id) primedTnt.delete(...) + overlay remove; batchCell; anchor
  ```
  The effects never read the world, so running them after the write matches today. The existing `remote-batch.test.ts` (≈ line 219) goes red if the recolor case is dropped: prove it once. Existing loop, liquid and mp tests must stay green unchanged; that is the parity proof.
- [ ] **Step 3: Constants.** Move `EYE_HEIGHT` and `WALK_SPEED` into `player-constants.ts`. `player.ts` imports them; the values are identical.
- [ ] **Step 4: Verify and commit.** Run the full suites, then commit: `refactor(world): applyRemoteOps shared by the game loop and the bot SDK`.

---

### Task 5: The SDK package

**Files:**
- Create:
  - `packages/minicraft-bot/{package.json, tsconfig.json, vite.config.ts, vitest.config.ts, README.md}`
  - `packages/minicraft-bot/src/{index.ts, bot-world.ts, bot-client.ts, errors.ts, guard-plugin.ts, empty-env/.gitkeep}`
  - `packages/minicraft-bot/test/{bot-world.test.ts, bot-client.test.ts, parity.test.ts, guard.test.ts, env.test.ts, consumer/{tsconfig.json, consumer.ts}}`
- Modify: root `package.json` (`build:bot`, `test:bot`, extend `typecheck`, the dts devDependency or dependencies) and `eslint.config.js` (ignore `packages/*/dist/**`). `.gitignore`'s `dist/` pattern already covers the package; verify it.

**Public interface** (from `dist/index.d.ts`):
- Classes: `BotClient`, `BotWorld`.
- Errors: `OutdatedClientError{ver,min}`, `ReplacedError`, `ServerRefusedError{code,message}`, `NotConnectedError`, `BlockedError{at: Pose, reason: 'wall' | 'noGround'}`.
- Constants: `CLIENT_VERSION`, `EYE_HEIGHT`, `WALK_SPEED`, `POS_EVERY_MS`.
- Functions: `raycastVoxel`, `blockName`, `blockId`, `blockNames`, `generateChunkBlocks(seed, gen, cx, cz): Uint16Array`.
- Types: `Pose{x,y,z,yaw,pitch}`, `BotPlayer{id,name,skin,bot,x,y,z,yaw,pitch,hasPos}`, `WalkResult = 'arrived' | 'cancelled'`.

Signatures are spec §6 **as amended here** (spec §12a).

- [ ] **Step 1: The guard plugin, test first (`guard.test.ts`).**
  - The plugin has `enforce: 'pre'`, otherwise Vite's resolver answers first and `resolveId` never runs.
  - It takes an option `extraAllowed: string[]` (absolute directories), used only by tests to admit their temp fixture folders.
  - It skips Rollup virtual ids (starting with `\0`, e.g. `\0commonjsHelpers.js` for alea's CommonJS). Never "fix" such a failure by admitting ids outside the repo.
  - `resolveId(id)` throws `GUARD: three` for `three` or `three/*`, and `GUARD: asset` for `*.png` or `?url`.
  - `load(id)` / `buildEnd`: every **resolved** module id must be either:
    - under the allow-listed directories `src/engine/world/`, `src/data/`, `src/net/`, `packages/minicraft-bot/src/`, or `extraAllowed`; or
    - one of the files `src/engine/input/raycast.ts`, `src/game/tools.ts`, `src/game/mp-reconnect.ts`, `src/game/player-constants.ts`, `src/engine/world/apply-remote.ts`; or
    - under `node_modules/(pako|alea|simplex-noise)/`.

    Anything else throws `GUARD: module <id>`. Check with the resolved absolute path, so relative imports can't dodge it.
  - `transform` throws `GUARD: glob` on `import.meta.glob`.
  - Test builds use `build.write: false` (or a temp `outDir` from `fs.mkdtemp`), **never** the package `dist`, because `parity.test` reads `dist` in parallel. Temporary entry files go in a `fs.mkdtemp` dir outside the repo and import real modules by absolute path.
  - Cases, each asserting its **own** message:
    1. clean entry → OK;
    2. `import 'three'` → `GUARD: three`;
    3. a `.png` import → `GUARD: asset`;
    4. a DOM-only relative import (e.g. a temp module under the temp dir that imports the absolute path of `src/ui/mp-overlays.ts`) → `GUARD: module`;
    5. `import.meta.glob` → `GUARD: glob`.
  - If any allow-listed dir turns out to import something outside the list, stop and report it; do not widen the list silently.

- [ ] **Step 2: Env isolation, test first (`env.test.ts`).**
  - Package Vite config:
    - `envDir: resolve(__dirname, 'src/empty-env')`, `envPrefix: '__MINICRAFT_BOT_NO_ENV__'`, `mode: 'production'`;
    - `publicDir: false`, `build.ssr: 'src/index.ts'`, `ssr.noExternal: true`, `target: 'node22'`, `outDir: 'dist'`, `emptyOutDir: true`;
    - `rollupOptions.output.format: 'es'`, entry `index.js`.
  - The test builds a **fixture entry** (in a temp dir) that returns `import.meta.env.VITE_MINICRAFT_MP_TOKEN`:
    - (a) with plain Vite defaults and `VITE_MINICRAFT_MP_TOKEN=leak-test-123` set on `process.env`, the output **contains** `leak-test-123`, which proves the fixture can leak;
    - (b) with the package's env settings and the same var set, it does **not** contain it;
    - (c) with the process var **unset**, `envDir` pointed at a temp dir holding a `.env.local` with a **different** value (`file-leak-456`): without `envPrefix` it **contains** `file-leak-456` (the positive control), and with the package's `envPrefix` it does not.
  - The env fixtures build with the guard's `extraAllowed` set to their temp dir, or without the guard.
  - `process.env` changes are restored in `finally`. **Never** create, edit or delete the repo's `.env.local`.
  - Also assert that `resolveConfig(pkgConfig)` has `envDir` ending in `src/empty-env`, and that the folder contains only `.gitkeep`.

- [ ] **Step 3: Types.**
  - Produce **one** `dist/index.d.ts` with no relative imports and no `three`.
  - Use `dts-bundle-generator` (self-contained) or `rollup-plugin-dts` (which needs `rollup`, present only via Vite: add it explicitly if used). Up to two devDependencies are allowed; record the choice and the reason in the report.
  - Package tsconfig:
    - `types: ["node", "vite/client"]`, `strict`;
    - `include` covers `src/**` and the tests that do **not** import `dist`;
    - `parity.test.ts` types its import from source (`typeof import('../src/index')`) and loads `dist` with `await import(pathToFileURL(distPath).href)`.
  - The public API must not mention `MpSync`, `LightRegistry`, `World` internals or render types.
  - **Consumer test** (`test/consumer/`):
    - tsconfig: `module` and `moduleResolution: nodenext`, `strict`, **no** `skipLibCheck`, `paths: { "minicraft-bot": ["../../dist/index.d.ts"] }`, with no `file:` install;
    - `consumer.ts` uses `BotClient`, `BotWorld`, `WALK_SPEED`, `OutdatedClientError` and `WalkResult`.
  - Assert `dist/index.d.ts` doesn't contain `three`.
  - Prove red once: point `paths` at the tsc per-file output and confirm an error, then revert.
  - Also: `rm -rf packages/minicraft-bot/dist && npm run typecheck && npm run build` must be green, since nothing in the root typecheck may statically import `dist`.

- [ ] **Step 4: `BotWorld`, tests first.** Construction and reset go through one entry point:
  - `BotWorld.create(welcome, snapshotBuf, send, you)`, and `reset(welcome, snapshotBuf, you)`, both synchronous.
  - The steps: build a **new** `World` (seed, `gen`, height from `welcome.world`) and a new `ChunkOverlay`; `overlay.loadSnapshot(decodeSnapshot(buf).cells)`; then `world.overlay = overlay`; then a **new** `MpSync(world, lights, send, () => ({}), memStorage, (ops) => this.applyRemote(ops))`, whose cids restart per connection; then `world.onLocalWrite = sync.record`. Only after all of that does it swap the internal references.
  - There is no public `loadSnapshot`. The client calls `create`/`reset` from its snapshot handler.
  - Test: with a fake socket, call `getBlock` on a snapshot-edited cell **between** the welcome and the snapshot frame. After the swap it returns the snapshot value.
  - `lights = { getColor: (x, y, z) => this.colors.get(key) ?? null }`.
  - `localSet(x, y, z, id, color?)`:
    - validates the colour as `#RRGGBB`, only when `id === LAMP_ID` (`colorToInt` throws otherwise), then sets or deletes `colors`;
    - calls `world.setBlock`, then `sync.flushFrame()`;
    - fires `onBlockChange` with `by = you`.
  - `applyRemote(ops)`: `applyRemoteOps(world, overlay, ops, cb)`; fire `onBlockChange` **only when applied**, with `oldId` null when the chunk wasn't generated. The echo filter is MpSync's.
  - `onBlockChange(cb)` returns an unsubscribe function.
  - **Every public coordinate API floors x, y, z** (`getBlock`, `groundY`, `surfaceY`, `region`, `findNearest`): `World.getBlock` doesn't floor, and fractional coordinates read `undefined`. Test fractional inputs.
  - `groundY(x, z, nearY)` (x and z floored):
    ```ts
    const top = Math.min(this.height - 3, Math.floor(nearY) + 2);
    for (let y = top; y >= Math.max(1, top - 64); y--) {
    	if (isSolidId(this.getBlock(x, y - 1, z)) && !isSolidId(this.getBlock(x, y, z)) && !isSolidId(this.getBlock(x, y + 1, z))) return y;
    }
    return null;
    ```
    The catalog's solid flag is the right test: every block is a full cube, leaves and glass are standable, and only air and `retired_*` are neither solid nor liquid.
    Tests: under a tree canopy → the ground; under a roof → the floor; near a lake → the bed (documented); none → null; a fractional x → the same as floored.
  - `region(min, max)`: inclusive bounds, floored, indexing `(y−y0)·dx·dz + (z−z0)·dx + (x−x0)`; throws when any side is over 32.
  - `findNearest(name, from, radius)`: clamps the radius to 32, generates every chunk in range first (deterministic), and returns the nearest cell by Euclidean distance with ties by (y, z, x) order, or null. Test: same answer with and without pre-reads.
  - `blockNames()`: all catalog names except `retired_*`.
  - Parity: the `src/net/mp-sync.test.ts` and `src/game/mp-liquid.test.ts` op sequences through `BotWorld` match the game `World` on the touched cells.
  - `onBlockChange` cases: remote op; own write (`by === you`); the echo of an own write doesn't fire a second time, **unless** a kid's write landed in between (then it re-applies and fires once more, which is correct and stated); `oldId` null.

- [ ] **Step 5: `BotClient`, tests first**, with a fake WebSocket (an optional constructor parameter; the default is `globalThis.WebSocket`) and vitest fake timers.
  - **`connect`:**
    - sends `Hello{world, name, skin, bid, proto: PROTO, gen: NEWEST_GEN_VERSION, resume: false, ver: CLIENT_VERSION, bot: true}`, as the game builds it (main.ts ≈ 184);
    - on the snapshot, `BotWorld.create`;
    - sends the spawn pose (`welcome.spawn` plus yaw/pitch 0), **then** resolves `{you, spawn, players, world}`;
    - rejects per spec §6: 4004 with `outdated` → `OutdatedClientError{ver, min}`; 4001 → `ReplacedError`; others → `ServerRefusedError{code, message}`.
  - `bid`: explicit, else `statePath` JSON `{bid, journal}`, else `'bot-' + fnv1a32hex(name)`.
  - **`pose(): Pose`**: the bot's own current pose.
  - **`players()`**: `BotPlayer[]` **excluding the bot itself**, with `hasPos`.
  - **`move(pose)`:**
    - sets the target pose; one interval timer sends at most one `pos` per `POS_EVERY_MS`, only if the key changed (`toFixed(2)` for xyz, `toFixed(3)` for yaw and pitch, as the game does);
    - cancels any active walk (which resolves `'cancelled'`).
  - **`walkTo({x, z}): Promise<WalkResult>`:**
    - each tick (`POS_EVERY_MS`), step `WALK_SPEED × POS_EVERY_MS / 1000` horizontally toward the target;
    - `ny = groundY(nx, nz, cur.y)`. If it is null → reject `BlockedError{at: cur, reason: 'noGround'}`. If `ny > cur.y + 1` → reject `BlockedError{at: cur, reason: 'wall'}`;
    - a drop is capped at 2 blocks per tick: `y = max(ny, cur.y − 2)`, and it keeps descending on following ticks before moving on;
    - yaw faces the direction of travel;
    - resolves `'arrived'` within 0.3 blocks;
    - a new `walkTo` or `move` resolves the old one with `'cancelled'`. It **never rejects** for cancellation, because an unhandled rejection kills Node;
    - `lookAt` and `mine` don't cancel a walk;
    - it checks only the centre column (it can clip wall corners; documented).
    - Tests:
      - from a fractional start over real generated terrain (seed 12345), it **arrives**. Flat 10-block paths are rare, so the test **searches** deterministically (a scan over candidate start cells) for a path whose `groundY` never rises more than 1 and never goes null, and fails if none is found in the scan;
      - consecutive sends are ≥ `POS_EVERY_MS` apart on the fake clock, with horizontal step ≤ 0.5 + 1e-9;
      - a wall → `BlockedError` with reason `'wall'` and `at`;
      - a cliff edge → a descent of at most 2 per tick;
      - two overlapping `walkTo`s: the first resolves `'cancelled'`, and no unhandled rejection is left (`process.on('unhandledRejection')` spy).
  - **`lookAt(x, y, z)`**: yaw and pitch from the eye (`y + EYE_HEIGHT`); only rotates.
  - **`place(x, y, z, name, color?)`:**
    - requires `1 ≤ id ≤ catalogMax`, `isSolid(id) || isLiquid(id)`, and a name not starting with `retired_`;
    - **Ruling:** refuses `bedrock`, which kids can't break;
    - refuses a cell inside any kid's body: for each non-bot player with `hasPos`, every cell overlapping the box x±0.3, z±0.3, y..y+1.8 (`floor(x−0.3)..floor(x+0.3)`, `floor(y)..floor(y+1.8)`, likewise for z);
    - **Ruling:** refusals **resolve `false`** and never throw, the same as `mine`, so a fire-and-forget call can't crash the bot with an unhandled rejection. Only programming errors throw: `NotConnectedError`, a malformed colour;
    - waits out `editGapMs` since the last edit (a promise chain; fake timers);
    - journals `{x, y, z, oldId, newId, t}` and persists it to `statePath` when set.
  - **`break(x, y, z)`**: same gap and journal; resolves `true` when sent, `false` when refused (bedrock, or air already).
  - **`mine(x, y, z, ms?)`:**
    - resolves `false` (no fx sent) unless `isRemovableId`;
    - `lookAt` the block centre;
    - `dur = ms ?? Math.round(miningDuration(hardness, 0, 'none') * 1000)`, the value the bot actually waits (check the signature in `src/game/tools.ts`);
    - sends `fx {kind: 'mine', x, y, z, tier: blockId, dur}` (no `tool`/`face`: the hand);
    - waits `dur`, then `break`;
    - if cancelled first (a new `mine`, a disconnect or `close`), sends `fx {kind: 'mine-stop', x, y, z}` (main.ts ≈ 850) and resolves `false`; otherwise `true`.
  - **`revert(sinceMs?)`:**
    - walks the journal newest-first; restores `oldId` only where the current block equals that entry's `newId`;
    - revert's own writes are **not** journaled. They use an **internal** write path (a direct `localSet` plus flush, one entry after another, sequentially, never `Promise.all`), not the public `place`/`break`, which apply refusals and the edit gap;
    - drops the reverted entries;
    - tests: a kid overwrote one cell, so it's skipped; one cell edited A→B→C by the bot ends at **A**, which fails an oldest-first implementation.
  - **Events:** a typed emitter with `join`, `left`, `pose`, `edit`, `fx`, `leaving`, `close(code)` and `reconnect`.
  - **Reconnect:**
    - on a non-fatal close, build a **new** `Reconnector({probe: listWorlds, onSuccess, onGiveUp})` (one-shot; the global `setTimeout` is covered by fake timers);
    - on success, open a new `MpClient` with `resume: true`, the same bid and the same memory `StorageLike`;
    - on the snapshot, `world.reset(...)` (the same `BotWorld` object), re-send the pose, emit `reconnect`;
    - on give-up, emit `close`;
    - test: the same bid, the same storage object, and the world identity is kept.
  - **Refusal mapping test:** 4004 + `outdated` → `OutdatedClientError{min}`; 4004 without an error → `ServerRefusedError`; 4001 → `ReplacedError`; 4005, 4006, 4007, 4008, 4009 → `ServerRefusedError{code}`.

- [ ] **Step 6: Parity through the bundle (`parity.test.ts`).**
  - Load `dist` at run time (Step 3). If it's missing, fail with "run npm run build:bot".
  - Hash `generateChunkBlocks` output with FNV-1a-32 over the Uint16 ids, checking all 17 hashes (spec §9.1).
  - Prove red once in a **scratch copy** (never the tree): `DEEPSLATE_Y` 48→47 goes red, and Float32Array→Float64Array in `v3/generate.ts` goes red on the seed 1 and seed 4 rows.

- [ ] **Step 7: Scripts.**
  - `build:bot` = the Vite build, then the dts step.
  - `test:bot` = `npm run build:bot && vitest run -c packages/minicraft-bot/vitest.config.ts && tsc -p packages/minicraft-bot/test/consumer`.
  - Extend `typecheck` with the package tsconfig.
  - Add the eslint ignore `packages/*/dist/**`.
  - Confirm the root `npm test` doesn't pick up the package tests, and that `npm run build` still works.

- [ ] **Step 8: README (the quick-start).**
  - Requirements: Node ≥ 22; run bots with `tsx` or Node ≥ 22.18 for `.ts`; add `@types/node`.
  - Build: `npm run build:bot` in the Minicraft repo.
  - Install: `"minicraft-bot": "file:../Minicraft/packages/minicraft-bot"`, and the bot repo's `package.json` needs `"type": "module"` (the example uses top-level await; without it tsx fails with "Top-level await is currently not supported with the cjs output format").
  - State that `place`, `break` and `mine` resolve `false` on refusal and never reject for refusals. The example still wraps its main loop in try/catch and logs.
  - **Token:** the same static token the site uses, `~/minicraft-mp/token` on the live server; `e2e` for a local test server.
  - **Local server:** how to start one on :18080 with a temp DB (link `server/README.md`).
  - How to get the world uuid (`listWorlds()`).
  - A ~30-line companion example: connect; every second pick the nearest kid (`!p.bot && p.hasPos`); `walkTo` 2 blocks short of them; on `BlockedError`, `move()` next to the kid (a rare visible hop); `lookAt` their eye; occasionally `place` a block beside itself.
  - Also document:
    - pose conventions;
    - that `players()` excludes self, and `pose()`;
    - the `onBlockChange` `by` semantics and unsubscribe;
    - costs;
    - `revert`, and setting `statePath` so it survives restarts;
    - `editGapMs`;
    - the place refusals (bedrock, kids' cells, retired ids);
    - `walkTo`'s limits (no pathfinding, centre-column check, blocked by walls over 1 block and by deep water shores);
    - the run command (`npx tsx bot.ts`).
  - `blockNames()` lists the catalog names.

- [ ] **Step 9: Verify and commit.** Run full `npm test`, typecheck, lint, go test, plus `npm run test:bot`, and the clean-tree `rm -rf …/dist && npm run typecheck && npm run build` check. Commit: `feat(bot): minicraft-bot SDK (world model, client, walk/mine/place, revert)` (package-lock changes for the dts devDependency are allowed here).

---

### Task 6: `docs/protocol.md`, the doc move, the upgraded doc test

**Files:**
- Create: `docs/protocol.md`
- Modify: `docs/multiplayer.md` (move the tables out, add a link; also fix its lines ≈ 70 and 294, which name the old test file), the doc test (`src/net/multiplayer-docs.test.ts`; rename it to `protocol-docs.test.ts` in the same commit, and update the comment at `src/net/protocol.ts` ≈ 162), `CLAUDE.md` (lines ≈ 19 and 37: add `protocol.md` to the doc list, fix references), `docs/specs.md` (≈ 7, 23), `docs/playtime.md:68`, `docs/skins-research.md:102`, `server/README.md` (the version runbook, spec §8, and the vm-setup note)

- [ ] **Step 1: Upgrade the doc test first.** It parses `docs/protocol.md` under the headings "### Client → server", "### Server → client" and "### Close and error codes", taking each table's message and fields columns (fields comma-separated, optional ones marked `?`).
  - It checks:
    - the message sets equal `CLIENT_MSG_TYPES` and `SERVER_MSG_TYPES`, and the close codes equal `CLOSE`;
    - each message's doc fields, **including their `?` markers**, equal `server/internal/proto/testdata/fields.json[key]`. Keys are the golden names: the server→client `edit` row maps to `edit-out`, and nested tables to their path keys;
    - with `?` stripped, the doc fields also equal the TS `fields<T>()` lists (export them from `protocol.test.ts` into a shared `src/net/wire-fields.ts`, so both tests use one list).
  - Nested structures (welcome.world, welcome.players): the doc lists them in their own sub-tables or inline as `players[{id,name,skin,bot?,…}]`. Pick one format, and make the parser handle exactly that.
  - It fails before `protocol.md` exists.
- [ ] **Step 2: Write `protocol.md`** with every section in spec §7, sourced from the code (`proto.go`, `protocol.ts`, `validate.go`, `conn.go`, `snapshot.ts`, `http.go`), not from memory. Include the pose conventions and the cost numbers from spec §6.
- [ ] **Step 3: Move the tables** out of `multiplayer.md` (replace them with a one-line link) and update the inbound links.
- [ ] **Step 4: Prove the instrument.** Add a fake `foo` field to the Go Hello and run `-update` (fields.json changes) → the doc test fails. Revert both. Add `foo?` to the TS Hello and its `fields` list → the doc test fails. Revert.
- [ ] **Step 5: Verify and commit.** Commit: `docs(protocol): one tested protocol reference; runbook for forcing client updates`.

---

### Task 7: E2E E11 (bot) and E12 (version gate)

**Files:** Modify `scripts/mp-e2e.ts`.

- [ ] **Step 1: `startMc(extraEnv: Record<string,string> = {})`.** Every start deletes `MC_MIN_CLIENT` from the copied env, then applies `extraEnv`. Setup runs `npm run build:bot` only when E11 or E12 is selected (fail the suite if it fails). Add `'E11'` to `needMp`. B stays connected into E12; its reconnect gets 4004 and auto-reloads, which is harmless because E12 counts loads only on its own fresh page.
- [ ] **Step 2: E11**, placed **immediately before E4** (after E10, so the bot isn't around for E10's pixel checks). Add an A-page init script that wraps `fillText` on both `CanvasRenderingContext2D.prototype` and `OffscreenCanvasRenderingContext2D.prototype` to record strings in a `Set` at `window.__fillTexts`; the minimap draws every frame, so an array would grow without bound. Load the SDK at run time: `const sdk: typeof import('../packages/minicraft-bot/src/index') = await import(pathToFileURL(resolve(ROOT, 'packages/minicraft-bot/dist/index.js')).href)`. Never import `dist` statically, because the root typecheck includes `scripts/`. Then then create `new BotClient({url: MP_URL, token: 'e2e'})` and `connect({world: WORLD, name: 'Robo', skin: 'enderman'})`. Checks:
  1. within 3 s, A's `__fillTexts` includes `🤖 Robo`;
  2. A's `__mc.mp.remote.positions()` has an entry named `Robo` with `bot: true` (visible: it has a pose);
  3. `GET /worlds` `online` for WORLD has no `Robo`;
  4. the bot `walkTo`s 3 blocks toward A, and A's position for Robo moves by more than 2 blocks;
  5. the bot `place`s stone at a free cell next to A → A's `__mc.world.getBlock` shows it within 500 ms;
  6. A sets air at a known solid cell → the bot's `world.getBlock` shows air within 500 ms;
  7. the bot `mine`s a solid cell → A's cracks oracle (see E9 for how it's read) shows a crack at that cell, then air after the mine.

  Then `bot.close()`, and confirm A's remote players no longer have Robo before E4 runs.
- [ ] **Step 3: E12**, placed **last** (after E5), in fresh browser contexts.
  - Stop the suite's server if it's running (`if (mc) await killMc('TERM')`: E7b may have stopped it), then `startMc({ MC_MIN_CLIENT: String(CLIENT_VERSION + 1) })`.
  - (a) The SDK `connect` rejects with `OutdatedClientError` and `min === CLIENT_VERSION + 1`.
  - (b) A fresh page joins WORLD via the menu or autojoin. Count **page loads** with an init script that increments a sessionStorage counter on every load (`framenavigated` also fires on same-document navigations).
    - Expect the "Updating Minicraft…" overlay, then one navigation (the URL gains `v=`).
    - The reloaded page rejoins via autojoin, gets 4004 again, and shows the click-to-reload screen.
    - Keep watching 5 s more: the load counter shows exactly one reload.
  - Prove red once (don't commit it): force `outdatedAction` to return 'auto', rebuild the dev server, see ≥ 2 navigations, then revert.
  - Afterwards, stop that server. Nothing runs after E12.
- [ ] **Step 4: Run** the full suite once and `--only E11` and `--only E12` once each. Save E11's view of Robo as a screenshot, `scratchpad/bot-e11.png`, and describe it in the report (the skinned Enderman rig with a `🤖 Robo` label).
- [ ] **Step 5: Verify and commit.** Run the unit suites plus `test:bot`, then commit: `test(e2e): E11 bot companion and E12 version gate`.
