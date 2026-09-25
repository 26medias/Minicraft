# Companion Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `bots/` TypeScript project whose companion bot joins a local or live Minicraft server through the `minicraft-bot` SDK. It follows a kid, watches what the kid watches, continues the kid's block lines, and backs off when the kid breaks its blocks. A local decision model (Laya, or CLM) chooses each action, with a scripted fallback.

**Architecture:**
- A pure core, tested against a fake port: config, perception, candidates, guard, stop signal, scripted brain.
- A thin real port over `BotClient`/`BotWorld`.
- An HTTP brain adapter for Laya's `/v1/systemone`, pinned by a real recorded exchange.
- A CLI.
- An e2e run with a scratch mcserver and a raw-protocol kid.
- One SDK safety fix: `mine` re-checks the block before breaking.

**Tech Stack:** TypeScript (nodenext), tsx, vitest, and the root toolchain only. The `minicraft-bot` SDK is used via `file:`. Go builds a scratch `mcserver` for the e2e. Laya and CLM are installed separately under `~/Projects/AI`.

**Execution order:** 0, 1, 2, **5**, 3, 4, 6, 7, 8. Task 5 (the SDK changes) lands before Task 3, which uses its exports.

**Spec:** `docs/superpowers/specs/2026-09-25-companion-bot-design.md` (rev 2 + §12a). It is the authority: §3 layout, §4 config and CLI, §5 brain, §6 behaviour, §8 safety, §9 tests. Read the sections each task cites.

## Global Constraints

- Tabs (1 tab = 4 spaces).
- The game (`src/`) and server (`server/`) are unchanged. The only SDK change is Task 5.
- `bots/` has no dependencies of its own except `"minicraft-bot": "file:../packages/minicraft-bot"`. Tools resolve from the root `node_modules`. `bots/package-lock.json` is committed.
- Root scripts `bots:install`, `bots:test` and `bots:e2e` each run `npm run build:bot` first.
- **Ports:**
  - Local target `http://localhost:18090`. `loadConfig` refuses any target on port 8080.
  - Tests never read `~/minicraft-mp`, never use port 8080, and never use `minicraft-server.leap-forward.ca`.
- The live token comes from `MC_LIVE_TOKEN` (env, or `bots/.env.live`), else `~/minicraft-mp/token`, at runtime only.
- **Companion tuning:** `tickMs` 500, `editEveryMs` 2000, `editBudget` 50, `followDist` 2, `minConfidence` 0.40 (compared against **max(p)**, i.e. Laya's `answer_confidence`, never Laya's calibrated `confidence`), `stopMs` 600000 per kid (by name, not an area), `wanderTether` 12, `statusEveryMs` 30000. Hops: final pose ≤ 7.5 blocks (3D) from the bot, ≤ 1 per second, landing outside every kid's Chebyshev buffer.
- **Kid buffer:** the columns overlapped by the kid box (x ± 0.3, z ± 0.3), widened by 1 (Chebyshev ≤ 1), against every non-bot player with a pose. The kid body box (y .. y+1.8) is also excluded.
- **Verification in every task:**
  - `npm run bots:test`;
  - `cd bots && npx tsc -p tsconfig.json --noEmit && npm run lint`;
  - root `npm test && npm run typecheck && npm run lint`;
  - `npm run test:bot` if the SDK was touched;
  - `npm run bots:e2e` once it exists.
- **Running servers and cleanup:**
  - Headless only.
  - Kill servers by port, and only the ones you started.
  - Temp dirs come from `fs.mkdtemp`.
  - Delete nothing outside the worktree and `/tmp/claude-1000/-home-julien-Projects-Minicraft/b79f7b62-dcf5-4bf5-9b80-08b74dcaef7e/scratchpad/`.
- **Staging:** stage explicit paths. Never commit `.state/`, `.env.live`, `dist/` or `.claude/agent-memory/`.
- **Commit messages** end with a blank line, then:
  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Wv64SyRKwvGQi2fmEPuX21
  ```

## Review Focus

1. **A kid building a tower while the bot helps:** the bot never places into a non-air cell, never within the buffer, never into a window or door (it only continues A→B lines), and stops near that kid for 10 minutes when the kid breaks one of its blocks. (Tasks 3, 4, 7.)
2. **The brain server down or slow mid-session:** the bot keeps following on the scripted fallback, the status line says so, and it never freezes or throws. (Tasks 2, 4, 6.)
3. **A kid flying away, hovering to build high, swimming, or walking behind walls:** the bot keeps him in sight (it falls behind fast flight at 10+ blocks/s and catches up when he slows); it never jitters under a hovering kid, never hops into water, and never snaps more than 8 blocks. (Tasks 3, 4, 7.)
4. **Julien points the bot at the wrong place:** port 8080, a missing live token, the first live run without the ack, a bot name equal to a kid's → refused with a clear message. (Task 1.)
5. **A stale SDK `dist` after an SDK change:** `bots:*` scripts rebuild it first, so bots never run old code or an old `CLIENT_VERSION`. (Task 0.)

---

### Task 0: Scaffold

**Files:**
- Create: `bots/package.json`, `bots/package-lock.json` (from `npm i` inside `bots/`), `bots/tsconfig.json`, `bots/vitest.config.ts`, `bots/eslint.config.js`, `bots/bots.config.ts` (the values in spec §4; the Laya/CLM `start`/`health` values stay `TODO_FROM_BRAINS_MD` until Task 6), `bots/.env.example`, `bots/test/smoke.test.ts`.
- Modify: root `package.json` (the scripts), root `eslint.config.js` (ignore `bots/**`), `.gitignore` (`bots/.state/`, `bots/.env.live`).

- [ ] **Step 1: `bots/package.json`.**
  - `"name": "minicraft-bots"`, `"private": true`, `"type": "module"`, `"dependencies": { "minicraft-bot": "file:../packages/minicraft-bot" }`.
  - Scripts:
    - `test: "vitest run"`
    - `typecheck: "tsc -p tsconfig.json --noEmit"`
    - `lint: "eslint ."`
    - `bot: "tsx src/cli.ts"`
    - `brains: "tsx src/brains-cli.ts"`
    - `e2e: "tsx test/e2e.ts"`
- [ ] **Step 2: Root scripts.**
  - `"bots:install": "npm run build:bot && npm --prefix bots install"`
  - `"bots:test": "npm run build:bot && npm --prefix bots test"`
  - `"bots:e2e": "npm run build:bot && npm --prefix bots run e2e"`
- [ ] **Step 3: tsconfig.**
  - `strict`, `module` and `moduleResolution` `nodenext`, `types: ["node"]`, `include: ["src", "test", "bots.config.ts"]`.
  - `bots/eslint.config.js`: TS rules like the root's (no import restrictions; eslint's patterns can't express the boundary).
  - **The import boundary is a vitest test**, `bots/test/boundary.test.ts`:
    - it scans every `import`/`export … from` in `bots/{src,test}/**/*.ts`;
    - each relative specifier is `path.resolve`d, and it fails if the result is outside `bots/`;
    - bare specifiers other than `minicraft-bot` and `node:*` fail, which catches `three` and `vite`.
- [ ] **Step 4: The smoke test** imports `{ WALK_SPEED, CLIENT_VERSION, BotClient }` from `minicraft-bot` and asserts `WALK_SPEED === 5`. Run `npm run bots:install && npm run bots:test`: green.
- [ ] **Step 5: Prove the boundary test red**, at two depths:
  - `bots/src/x.ts` importing `'../../src/net/protocol.js'`;
  - `bots/test/sub/x.ts` importing `'../../../packages/minicraft-bot/src/index.js'`;
  - a file importing `'three'`.

  Each fails. Delete them and confirm with `git status`. The root `npm run lint` is green with `bots/**` ignored.
- [ ] **Step 6: Verify and commit.** Run the full verification set, then commit: `feat(bots): scaffold the local bots project`.

---

### Task 1: Config and CLI parsing

**Files:** Create `bots/src/config.ts`, `bots/src/cli-args.ts`, `bots/test/config.test.ts`.

**Interfaces:**
- `loadConfig({ argv, env, readFile, homedir, stateRoot }): Config`. It throws `ConfigError` with a human message. Nothing reads the real filesystem or env unless injected.
  - `readFile(path)` returns `string | null` (null = missing).
  - `stateRoot` defaults (in cli.ts only) to `bots/.state`, resolved from `import.meta.url`.
  - The live token file is read **only when target = live**.
- `checkLiveAck({ cfg, worldUuid, readFile, writeFile, now }): void | ConfigError`. Called after the world is resolved: the first run per world needs `--i-deployed-the-server`, which writes `{[uuid]: isoDate}` into `<stateRoot>/live-ack.json`.
- `Config`:
  - `target: { name, url, token }`
  - `worldArg`, `name`, `skin?`
  - `brain: 'laya' | 'clm' | 'scripted'`
  - `noEdits`, `revertOnExit`, `ackLive`
  - `companion` (tuning)
  - `brains` (map)
  - `statePath(worldUuid)`
- `resolveWorld(worlds, arg): World | ConfigError` (uuid, or exact case-insensitive name; ambiguous → an error listing the candidates).
- `checkName(name, occupiedNames): ok | ConfigError`.
- `pickSkin(skins, kidsSkins, requested?)`.

- [ ] **Step 1: Tests first**, covering spec §9 #7:
  - a target on port 8080 refused (for both `http://localhost:8080` and `http://127.0.0.1:8080/`);
  - live with no `MC_LIVE_TOKEN` and no token file → error;
  - `MC_LIVE_TOKEN` beats the token file;
  - `~` expanded via the injected `homedir`;
  - `checkLiveAck`: the first run per world without `--i-deployed-the-server` → error; with it → written through the injected `writeFile` with the injected `now`; a later run → ok without the flag;
  - `--world` by uuid, by name (case-insensitive), ambiguous, and missing (→ `listOnly`);
  - `--name` colliding case-insensitively with an online or in-world name → error;
  - the skin default skips kids' skins;
  - `statePath` = `.state/<target>/<uuid>/<name>.json`.
- [ ] **Step 2: Implement.** Refuse 8080 by parsing the URL: `new URL(u).port === '8080'`, or an empty port with a protocol default that is 8080 (none are).
- [ ] **Step 3: Verify and commit.** Commit: `feat(bots): config and CLI parsing with safety refusals`.

---

### Task 2: Brain types and the scripted brain

**Files:** Create `bots/src/types.ts` (`Snapshot`, `Candidate`, `KidInfo`, `Placement`; the shapes in Task 3's interfaces), `bots/src/brain/brain.ts`, `bots/src/brain/scripted.ts`, `bots/test/scripted.test.ts`.

**Interfaces:** `Choice`, `Answer`, `Brain` exactly as in spec §5. `Answer.confidence` = **max(p)** over the offered options (not Laya's calibrated `confidence` field). `scriptedDecide(snapshot, candidates): Answer`, with rules from spec §6. `ScriptedBrain implements Brain` (health is always true).

- [ ] **Step 1: Tests.** The rule table from spec §6 "Scripted brain", deterministic. `confidence` is 1 for the chosen option.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify and commit.** Commit: `feat(bots): brain interface and scripted brain`.

---

### Task 3: Port, perception, candidates, guard, stop signal

**Files:** Create:
- `bots/src/port.ts` (interfaces, plus `realPort(client: BotClient, listing: WorldListing)`);
- `bots/src/body/{perceive,candidates,guard,stop-signal}.ts`;
- `bots/test/fake-port.ts`;
- `bots/test/{perceive,candidates,stop-signal}.test.ts`.

**Interfaces** (the shapes live in `bots/src/types.ts` from Task 2):
- `Body`: `pose()`, `players()`, `walkTo()`, `move()`, `lookAt()`, `place()`, `revert()`, `journal()`, `onEdit(cb)`, `onFx(cb)`, `you`.
- `WorldView`: `getBlock`, `blockName`, `isSolid(id)`, `isLiquid(id)`, `groundY`, `raycast(origin, dir, max)`, `generatedBlock`, `mustMine`.
- `perceive(prev, body, world, nowMs) → { snapshot, state }`, `renderText(snapshot)`.
- `kidBuffer(players)`: the set of column keys; `inBodyBox(cell, players)`.
- `candidates(snapshot, world, guard) → Candidate[]`.
- `StopSignal`: `onEdit(edit, journal, now)`, `activeFor(kidName, now)`, `anyActive(now)`.

**`realPort`:**
- `mustMine` = `listing.mustMine`, the `listWorlds()` row that `--world` resolved. `connect()` doesn't return it.
- `generatedBlock` caches `generateChunkBlocks(client.world.seed, client.world.gen, cx, cz)` per chunk.
- `raycast` = `raycastVoxel(client.world, …)`.
- `isSolid`, `isLiquid`, `groundY` delegate to `client.world`.

**Fake port:**
- An in-memory `WorldView` over `generateChunkBlocks(12345, 3, cx, cz)` for a few chunks, plus an edit overlay.
- Solidity uses the SDK's exported `isSolidId`/`isLiquidId` (Task 5, which **runs before this task**).
- `groundY` uses the SDK README's rule; `raycast` is a DDA with max 6.
- **Parity with the real SDK is proven in Task 7**, where a real connected world exists.

**Flying (spec, amended at gate 2).** A kid is flying when:
- he is **not in liquid**, where *in liquid* means the block at feet **or** at feet + 1 is liquid; and
- his feet are more than 1.5 above `groundY` for **every** column his box (x ± 0.3, z ± 0.3) overlaps;
- for longer than 0.5 s.

Jumps peak at 1.33, so they never count. Launch and slime pads may count for about 1 s, which is accepted.

**`help_build` (amended at gate 2, from the kid lens):**
- The kid's last **three** placements A, B, C0 are collinear and consecutive (face-adjacent steps in one direction), all single-op solid placements of the **same block**, with each gap ≤ 4 s and the last one < 4 s old.
- He has placed nothing off that line since.
- His **look target** (a raycast hit, so never the AIR cell N itself) is B, or a face-neighbour of N = C0 + (C0 − B). C0 is one of those neighbours.
- That look target has stayed there for **≥ 1 s while he placed nothing** (he is aiming where the next block goes).
- It is offered **at most once per line**.
- N is AIR, outside every kid's Chebyshev buffer and body box, and within 6 of the bot's eye.
- The block is C0's type.

- [ ] **Step 1: The fake port** as above, and a fake `Body` with a scripted player list and an event emitter.
- [ ] **Step 2: Perception tests:**
  - the asymmetric bearing row (a kid at +dx, −dz → "north-east", north = −z);
  - stickiness (a second kid comes nearer, and the target is unchanged);
  - reconnect (a new id with the same name → the same target);
  - the look target via the fake raycast on generated terrain;
  - placement filtering (multi-op, liquid, and another player's edits are ignored);
  - velocity;
  - the **flying flag**:
    - a hovering kid 20 blocks above → flying;
    - a kid swimming at the surface of a 4-deep lake → **not** flying;
    - a kid standing on a cliff edge with his centre over air but his box on the block → **not** flying;
    - a jump apex of 1.33 → not flying;
  - exact text fixtures.

  Prove red: flip the bearing sign; key the target by id; drop the liquid check (the swimming row fails).
- [ ] **Step 3: Candidate and guard tests,** as a table:
  - `help_build` is offered for 3 collinear same-block placements with the look target along the line;
  - not for 2 placements;
  - not when the kid **turned away** (look target elsewhere);
  - not when B's age is > 4 s;
  - not after an off-line placement;
  - not when N is planks;
  - not when N is in any kid's buffer (the target kid **or another kid**);
  - not in `mustMine`, with `--no-edits`, at budget 0, before the interval, or with a stop active for this kid;
  - not when N is further than 6 from the eye;
  - `wander` stays in the tether;
  - `follow` is offered only when far or moving.

  The body-box rule is tested **with the buffer mutated to 0**. The body box's columns lie inside the buffer, so it can't be isolated otherwise.

  Prove red: drop the AIR check; set the buffer to 0.
- [ ] **Step 4: Stop-signal tests:**
  - a kid turns a journaled bot cell (current = the bot's `newId`) into anything → a stop **for that kid by name**, until now + `stopMs`, wherever he goes;
  - an unrelated edit → no stop;
  - it expires;
  - another kid is unaffected.
- [ ] **Step 5: Verify and commit.** Commit: `feat(bots): perception, candidates, kid buffer and stop signal`.

---

### Task 4: Companion loop, act, log, status

**Files:** Create:
- `bots/src/body/{act,log,status}.ts`, `bots/src/bots/companion.ts`, `bots/src/cli.ts`;
- `bots/test/{companion,log}.test.ts`.

**Interfaces:** `runCompanion({ body, world, brain, config, log, clock, rng }) → { stop(): Promise<void> }`; `Logger`; `Status`.

**Hops (amended at gate 2).** The bot hops only when:
- the kid's **horizontal** distance is > `followDist + 1`, **and**
- either (the kid is flying and his horizontal speed is > 1 block/s) or 3 walks in a row were blocked.

The hop cell:
- `groundY` = g, with blocks g and g + 1 not liquid;
- outside every kid's Chebyshev buffer;
- the **final pose, after centring on the cell**, is ≤ 7.5 from the bot in 3D (the kids' screens snap above 8 in 3D);
- chosen toward the kid.

At most 1 hop per second. With no valid cell, the bot watches.

- [ ] **Step 1: Loop tests** with the fake port, a fake clock and a fake brain:
  - ticks never overlap;
  - low confidence (**max(p)** < 0.40) → `follow`, else `watch`;
  - a brain timeout → a scripted decision, reason `fallback:timeout`; 5 in a row → scripted for the session, and the status line shows `SCRIPTED-FALLBACK`;
  - **follow re-issues `walkTo` on the very next tick** after the kid moved > 0.5, with a fake `walkTo` that never resolves. Asserted at the single next tick, so an implementation that awaits behind a cap fails;
  - leaving follow → `move(pose())`;
  - hops:
    - 2 hop-eligible ticks within 1 s → exactly 1 `move`;
    - a hovering kid 20 blocks up, **circling at horizontal radius ≤ 1.5 at ~2 b/s**, with the fake `walkTo` **rejecting BlockedError every time** → **0 hops over 10 s**. Only the horizontal-distance condition prevents the hop, so removing it goes red;
    - a swimming kid → 0 hops into water;
    - every hop's final pose is ≤ 7.5 (3D) and outside the buffers;
  - `help_build` re-reads N before `place`; if N became non-air → no place, and it's logged;
  - `--no-edits` → never `place`;
  - no kid → `wander`/`idle` without an `ask`;
  - the log schema (seed, tick, snapshot, text, candidates, brain, raw, action, reason, result, latency);
  - the status line shows the fallback count, edits used / 50, and "paused near <kid> <min>m" while a stop is active.

  Prove red: await `walkTo` in follow; remove the horizontal-distance condition (the hover row fails).
- [ ] **Step 2: Implement.**
  - The follow target is `kid + v·0.5 − followDist·unit(kid − bot)` (horizontal), re-issued when it moved > 0.5.
  - `watch` looks at the kid's look target when he's still, otherwise at his eye.
  - SIGINT/SIGTERM: with `--revert-on-exit`, run `revert()`, then `close()`.
  - `cli.ts`:
    - wires `loadConfig`, `listWorlds`, `resolveWorld`, `checkLiveAck` (live), the name and skin checks, `BotClient`, `realPort(client, listing)`, and `runCompanion`;
    - **refuses `--brain laya|clm` until Task 6 lands**, with "only --brain scripted is available in this build";
    - adds a **`revert` subcommand**: `npm run bot -- revert --target … --world … --name …` connects with the same `statePath`, runs `revert()`, prints the count, and exits.
- [ ] **Step 3: Verify and commit.** Commit: `feat(bots): companion loop with standing-intent follow, safe hops, status, decision log and revert command`.

---

### Task 5: SDK changes: `mine` re-check, and exported solidity helpers

**Files:** Modify `packages/minicraft-bot/src/bot-client.ts`, `packages/minicraft-bot/src/index.ts` (+ README rows), `packages/minicraft-bot/test/bot-client.test.ts`.

- [ ] **Step 1: The `mine` re-check, test first.**
  - Start a `mine` on stone. Before the timer fires, deliver a kid edit replacing the cell with planks. Expect: `false`, no break edit sent, and `fx mine-stop` sent. It fails today.
  - Advance only `dur + 100` ms, and assert the bot is still connected: no `reconnect` event, and a follow-up `mine` on another stone cell resolves `true`. Otherwise the teardown's `cancelMine` can make the test pass without the re-check.
  - Implement the check **inside the edit function**, because `break` goes through the edit chain and can run later:
    ```ts
    timer: setTimeout(() => {
    	if (this.mining !== m) return;
    	this.mining = null;
    	if (this.state !== 'connected') return resolve(false);
    	resolve(this.edit(() => {
    		if (this.core!.getBlock(fx, fy, fz) !== id) { this.send({ t: 'fx', kind: 'mine-stop', x: fx, y: fy, z: fz }); return false; }
    		return this.write(fx, fy, fz, AIR);
    	}));
    }, dur),
    ```
    Adapt the variable names to the actual code.
- [ ] **Step 2: Export `isSolidId(id)` and `isLiquidId(id)`** (pure, from the catalog), so `bots/`' fake world uses the real rule. Test them against `BotWorld.isSolid`/`isLiquid` over every catalog id. Then switch Task 3's fake port to them, if Task 3 already landed; otherwise Task 3 uses them directly.
- [ ] **Step 3: Don't bump** `CLIENT_VERSION` or the SDK's package version.
- [ ] **Step 4: Verify and commit.** Run `npm run test:bot` plus the full set. Commit: `fix(bot): mine re-checks the block before breaking; export isSolidId/isLiquidId`.

---

### Task 6: Brain adapter (Laya `/v1/systemone`) and the brains launcher

**Fixture:** the real exchange recorded at gate 2 against the real Laya on this machine: `/tmp/claude-1000/-home-julien-Projects-Minicraft/b79f7b62-dcf5-4bf5-9b80-08b74dcaef7e/scratchpad/gate2-bots-rigour/req.json` and `resp1.json`.
- Copy them into `bots/test/fixtures/laya-exchange.json` as `{ request, response, note }`.
- If they're missing, record a fresh one: start Laya per `~/Projects/AI/BRAINS.md`, or per `~/Projects/AI/laya` (`laya-serve`), on 127.0.0.1 with a free port that is never 8080; send one `next` choice; save both bodies; stop it by port.
- **Never** use `laya/tests/test_serve.py`: its reply comes from a fake router.

**Files:** Create:
- `bots/src/brain/systemone.ts`, `bots/src/brains-cli.ts`;
- `bots/test/fixtures/laya-exchange.json`, `bots/test/systemone.test.ts`.

Modify `bots/bots.config.ts`: the exact Laya start argv, health path and URL, taken from `BRAINS.md` or the Laya repo; CLM only if `BRAINS.md` shows it runs, otherwise `experimental: true` with a comment.

- [ ] **Step 1: Tests first,** against a `node:http` fake on port 0:
  - the request `SystemOneBrain.ask` builds for the fixture's state and choice (using the fixture's `instructions` and `criteria` descriptions verbatim) is **deep-equal after `JSON.parse`** to the recorded request;
  - the recorded response maps to `Answer`, from `answers.next` only (`usage` and `routing` are ignored), with `best` = its choice, `probs` = its probabilities normalised over the offered options (a missing option is 0), and `confidence` = **max(p)** (`answer_confidence`). Laya's calibrated `confidence` is **not** used;
  - a timeout aborts;
  - `health()` hits the health path.

  Prove red: `criteria` → `options` (real Laya returns 422 for that; the replay fails); mapping `confidence` from the calibrated field (the max(p) row fails).
- [ ] **Step 2: A measured threshold.** With Laya running, send 20 varied `next` requests built from the Task 3 text fixtures and record max(p) in `~/Projects/AI/BRAINS.md`'s Laya section, **appending** to that file (never touching anything else in `~/Projects/AI`). If the median max(p) is below 0.40, lower `minConfidence` in `bots.config.ts` to the 25th percentile and record why. Then stop Laya.
- [ ] **Step 3: Implement** `brains-cli.ts laya|clm`: it spawns the start argv with `cwd` = the expanded `home`, inherits stdio, forwards signals, and refuses port 8080.
- [ ] **Step 4: Verify and commit.** Commit: `feat(bots): Laya/CLM systemone brain adapter and brains launcher`.

---

### Task 7: E2E

**Files:** Create `bots/test/{mcserver,kid-client,e2e}.ts`.

- [ ] **Step 1: `mcserver.ts`** (logic copied from `scripts/mp-e2e.ts`):
  - `go build` into `fs.mkdtemp` with `~/.local/go/bin/go`; a temp DB;
  - a free port (bind 0, read the port, close) asserted to be numeric, not 0 and not 8080; `-addr 127.0.0.1:<port>`;
  - token `e2e`; delete `MC_GCS_BUCKET`, `MC_TOKEN`, `MC_MIN_CLIENT` and pass `-gcs-bucket ''`;
  - readiness: fail if the child exited; require **HTTP 200 from `/worlds`** with the e2e token; retry once on a new port;
  - `createWorld(name)` via `POST /worlds`;
  - `stop()` sends SIGTERM to our PID and removes its temp dir.
- [ ] **Step 2: `kid-client.ts`.** A `BotClient` built with a `WebSocket` option: a subclass of the global `WebSocket` whose `send` JSON-parses the `hello` and **deletes `bot`**. The SDK then supplies `proto`, `gen`, `bid`, poses and edits exactly, and the kid is seen as `{bot: false}`.

  Name `Kid`, skin `jj`. Helpers:
  - `walkTo`;
  - `face(cell)` (`lookAt`), then `place(cell, name)` / `break(cell)`, so the kid's look target matches its building.

  A `first` spawn may come back as 0,0,0. The kid finds its own ground via its `world.groundY` (and it's a BotClient, so it has a world).
- [ ] **Step 3: `e2e.ts`.** Each leg gets a **fresh world**. In each leg:
  1. The kid connects.
  2. **Then the companion (or the idle bot) connects**, while the kid is still at spawn, so the server spawns it near the kid.
  3. **Parity checks** before any edit, over the generated chunks around spawn:
     - `realPort`'s `raycast` vs the fake WorldView on 20 random rays;
     - `isSolidId` vs `world.isSolid` on the ids seen;
     - `groundY` (real vs fake) on 20 columns.
  4. The kid script:
     1. walk to a flat site ≥ 25 blocks away (found with `surfaceY` flat over a 9×9 area; on seed 12345 this may be ~70 blocks out). If the walk is blocked, fall back to a `move`. Time assertion (a) from arrival;
     2. pause 2 s;
     3. **3a:** facing along the line, place 3 collinear blocks such that N is outside the kid's buffer.
        - Wait ≥ 1 s between the last placement and the end of the aim hold, placing nothing (the ≥ 1 s rule).
        - Aim at the **top face of the block under N**, i.e. at `(N.x+0.5, N.y−0.01, N.z+0.5)`. N is AIR, so aiming at N's centre hits the ground beyond it, which is not a face-neighbour.
        - Hold that aim for 4 s.
     4. **3b:** place a second 3-block line whose N2 is **inside the kid's buffer but outside its body box**.
        - Aim the same way, at the block under N2, for 4 s.
     5. **4:** **turn away before the first placement** (look target null or far off the line), and place a 3-block line **without facing the cells**.
        - Its N is AIR, outside every buffer, and within 6 of the bot's eye, so the look-rule mutation would place there.
        - Then stand.
     6. **5:** break one bot-placed block;
     7. **6:** place another valid 3a-style line, aimed at the block under N, whose N is AIR, outside the buffer, and within 6 of the bot's eye (so a stop-off mutation really places);
     8. walk 10 more blocks.
- [ ] **Step 4: Assertions,** over the companion leg (scripted brain):
  - **(a)** ≥ 80% of 100 ms samples within `followDist + 2` while the kid stands (after a 2 s settle), and ≥ 80% within `followDist + 4` while he walks;
  - **(b)** at least one bot block lands exactly at N from step 3a, of C0's type;
  - **(c)** no bot edit is inside any kid's buffer or body box, checked against the kid's pose when the edit echo arrives. N2 from 3b is never placed;
  - **(c2)** no bot block from step 4 (the turned-away line);
  - **(d)** after step 5, no bot edit at all for the rest of the leg (the stop is per kid);
  - **(e)** log timestamps only increase, with gaps ≤ `tickMs` + 4 s + slack, and the line count is within the bounds.
- [ ] **Step 5: The idle baseline** (a fresh world, the same script, a bot that connects at spawn and never acts) must **fail (a)**.
- [ ] **Step 6: The Laya leg** (a fresh world), only if `health()` passes:
  - `reason: brain` on ≥ 1/3 of the ticks with a kid present;
  - at least one brain choice that is **not** the safe default;
  - (c), (c2) and (d) still hold.

  Otherwise it prints `SKIP laya: <reason>`.
- [ ] **Step 7: Prove red, recorded and reverted:**
  - buffer = 0 → (c) fails at N2;
  - stop signal disabled → (d) fails at step 6;
  - the look-target rule removed → (c2) fails.

  Run with `npm run bots:e2e`, checking ports first. Commit: `test(bots): companion e2e with a non-bot kid, parity checks, idle baseline and Laya leg`.

---

### Task 8: Docs

**Files:** Create `bots/README.md` (spec §11, plus: the `revert` subcommand in the live checklist; the "paused near <kid>" status field; the fact that the bot falls behind fast flight; pads may cause one hop). Modify `CLAUDE.md`:
- Add `bots/` to the Layout paragraph.
- Add the line: "`bots/` holds local bots (never deployed); the live token for bots is `bots/.env.live` or `~/minicraft-mp/token` (read by the bot at runtime for `--target live` only; tests and agents never read it), never `.env.local`".

- [ ] **Step 1: README.**
  - Setup (the models in `~/Projects/AI`, `BRAINS.md`).
  - `npm run bots:install`.
  - Starting a brain (`npm run brains -- laya`).
  - A local server on 18090: the exact command from the SDK README, with the port changed.
  - Running locally and live.
  - The live checklist:
    - deploy the server first;
    - the first session with `--no-edits`;
    - the stop signal;
    - `--revert-on-exit` caveats.
  - Reading and replaying the decision log.
  - The status line.
  - Two kids: v1 serves one.
  - Adding a bot.
- [ ] **Step 2: Verify and commit.** Commit: `docs(bots): README and CLAUDE.md pointer`.
