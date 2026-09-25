# Companion bot with local decision-model brains — design (rev 2, 2026-09-25)

Branch `bots` (worktree `.claude/worktrees/bots`), cut from `main` @ 35d150e, which contains the bot SDK
`packages/minicraft-bot` and `docs/protocol.md`. Brainstormed with Julien on 2026-09-25 and approved
section by section.

Rev 2 folds in gate 1 (rigour, engine, boundaries, consumer) and Julien's answers to four product
questions. **Ruling** marks a decision made by the controller, with its cost if wrong. They are
collected in §12.

## 1. Goal and intent

Julien runs **TypeScript bots on his own desktop**. They are never deployed. They join a Minicraft
multiplayer world as players, and a local **fast decision model** makes their choices. The first bot
is a **companion** for the kids.

It:
- follows a kid, keeping up even when the kid flies;
- looks at what the kid is looking at;
- helps build by continuing the kid's line of blocks;
- stops helping when the kid breaks what it built.

It must feel alive, never trap a kid or wreck a build, and never freeze when its brain is down.

Success: `npm run bot -- companion --target local --world <name> --brain laya` joins a local server
and visibly follows and helps a scripted kid. A JSONL decision log records each decision and can be
replayed. The same command with `--target live` joins the kids' real world, once Julien has deployed
the server that supports bots.

Non-goals:
- deploying bots anywhere;
- chat;
- pathfinding;
- **mining help** (dropped for v1 by Julien);
- memory across sessions;
- serving several kids at once;
- several bots coordinating;
- training models;
- game or server changes.

The only SDK change is §7's `mine` re-check.

## 2. Decisions (Julien)

- **Same repo, separate project:** `bots/` at the top level. The game code is untouched.
- **Brains:** Laya is the default. CLM is optional and experimental, because its 8B backbone only
  fits the RTX 3080 (10 GB, ~7.8 GB free) when quantized, if at all.
- **Models are installed only under `~/Projects/AI/*`.** The setup, commands and measurements are in
  `~/Projects/AI/BRAINS.md`. The repo holds no Python and no model files.
- **Targets:** bots always run locally, and a config selects a local or a live game server.
- **The companion's actions:**
  - `follow` (walking, and hopping along when the kid flies);
  - `face`/`watch`;
  - `help_build`, only **continuing the kid's line** with the same block;
  - `wander`, `idle`.
- **No `help_mine`.**
- **Stop signal:** if a kid breaks a block the bot placed, the bot makes no edits near that kid for
  10 minutes.

## 3. Layout

```
bots/
  package.json          "minicraft-bots", private, type module, NO dependencies of its own except
                        "minicraft-bot": "file:../packages/minicraft-bot"; tsc/tsx/vitest/@types/node resolve
                        from the root node_modules (one toolchain). package-lock.json is committed.
  tsconfig.json         strict, module/moduleResolution nodenext
  vitest.config.ts
  eslint.config.js      extends the root style + no-restricted-imports for '../src', '../../src',
                        '../packages/*/src', 'three'
  bots.config.ts        targets, brains (with start commands), companion tuning; committed, no secrets
  .env.example          MC_LIVE_TOKEN=
  README.md
  src/
    cli.ts              npm run bot -- <bot> [flags]
    brains-cli.ts       npm run brains -- laya|clm  (starts a brain server from ~/Projects/AI per config)
    config.ts           loadConfig({ argv, env, files }) — pure, everything injected
    port.ts             the Body/WorldView port (§6) + its real adapter over BotClient/BotWorld
    brain/{brain.ts, systemone.ts, scripted.ts}
    body/{perceive.ts, candidates.ts, guard.ts, act.ts, stop-signal.ts, log.ts, status.ts}
    bots/companion.ts
  test/
    fixtures/laya-exchange.json   a REAL recorded request/response (see §5)
    fake-port.ts        in-memory Body/WorldView (worlds built from the SDK's generateChunkBlocks)
    kid-client.ts       raw-protocol WebSocket "kid" (hello WITHOUT bot)
    mcserver.ts         starts a scratch mcserver (copied logic from scripts/mp-e2e.ts)
    *.test.ts, e2e.ts
  .state/               git-ignored: per target/world state, logs, the live acknowledgement
```

**Root changes:**
- `eslint.config.js` ignores `bots/**`.
- `.gitignore` adds `bots/.state/` and `bots/.env.live`.
- Root scripts: `bots:install`, `bots:test`, `bots:e2e`. **Each one runs `npm run build:bot` first**,
  so bots never run against a stale or missing SDK `dist` (the `file:` dependency is a symlink to the
  package).
- `CLAUDE.md` gains one line: "`bots/` holds local bots (never deployed); the live token for bots is
  `bots/.env.live` or `~/minicraft-mp/token`, never `.env.local`".
- Gate 1 verified that the root `tsc`, `vitest`, `npm run build` and prettier don't reach `bots/`.

## 4. Configuration and targets

```ts
export default {
  targets: {
    local: { url: 'http://localhost:18090', token: 'e2e' },
    live:  { url: 'https://minicraft-server.leap-forward.ca', tokenEnv: 'MC_LIVE_TOKEN', tokenFile: '~/minicraft-mp/token' },
  },
  brains: {
    laya: { url: 'http://127.0.0.1:8000', health: '<from BRAINS.md>', home: '~/Projects/AI/laya', start: ['<exact argv from BRAINS.md>'], timeoutMs: 400 },
    clm:  { url: 'http://127.0.0.1:8700', health: '<…>', home: '~/Projects/AI/clm', start: ['<…>'], timeoutMs: 400 },
  },
  companion: { tickMs: 500, editEveryMs: 2000, editBudget: 50, followDist: 2, minConfidence: 0.45,
               stopRadius: 10, stopMs: 600_000, wanderTether: 12, statusEveryMs: 30_000 },
};
```

- `~` is expanded with `os.homedir()`.
- **Ruling:** the local target uses port **18090**, so a manual local server never blocks
  `npm run e2e:mp`, which uses 18080. `loadConfig` **refuses any target on port 8080**, where the
  live mcserver listens on this desktop.
- The live token is taken from `MC_LIVE_TOKEN` (the environment, or `bots/.env.live`), else read from
  `tokenFile`. **Ruling:** reading the live server's own token file is allowed for the **live target
  at runtime only**. Tests inject `env` and `files` and never read it.
- Tests pass their target URL through the config object (`targets.test = { url, token }`). No CLI
  flag exists for this.

**CLI:**
`npm run bot -- companion --target local|live --world <uuid|name> [--name Robo] [--skin <id>] [--brain laya|clm|scripted] [--no-edits] [--revert-on-exit] [--i-deployed-the-server]`

- **`--world`:** a uuid or an exact name, matched case-insensitively against `listWorlds()`. An
  ambiguous name exits and prints the list; with no `--world`, it prints the target's worlds and
  exits.
- **`--name`:** must pass the game's name rule, and must not equal (case-insensitively) any name
  that is online or present in the world. Otherwise it exits, so a bot never takes over a kid's record.
- **`--skin`:** defaults to the first catalog skin that no online kid is wearing.
- **`--no-edits`:** follow and watch only. The README recommends it for the first live session.
- **Live target:** it needs a token. The first run per world needs `--i-deployed-the-server`, stored in
  `bots/.state/live-ack.json`. The README explains why: an older server ignores `bot`, so the bot
  becomes a spawn target and blocks world deletion.
- **Brain health:** checked at start. If it's down, the bot refuses to start unless
  `--brain scripted`.
- **Per call:** a call that fails or exceeds `timeoutMs` falls back to the scripted decision for that
  tick, and the log records the reason. After 5 consecutive failures, the bot runs scripted for the
  rest of the session.
- **The status line** printed every `statusEveryMs`: the brain (or `SCRIPTED-FALLBACK`), the fallback
  count, edits used out of the budget, the target kid, and whether a stop signal is active.
- **`statePath`:** `bots/.state/<target>/<worldUuid>/<botName>.json`.

## 5. The brain interface and Laya's real wire format

```ts
export type Choice = { type: 'choice'; instructions: string; options: Record<string, string> };
export type Answer = { type: 'choice'; best: string; probs: Record<string, number>; confidence: number };
export interface Brain {
  name: string;
  health(): Promise<boolean>;
  ask(state: string, question: Choice, signal: AbortSignal): Promise<Answer>;
}
```

The only question is `next`, a choice over the feasible candidates. **Ruling:** `kid_busy_building` is
dropped: it suppressed `help_build` exactly when help is available.

`systemone.ts` maps `Choice` onto Laya's real `/v1/systemone` format, where a choice question carries
**`criteria`** (key → description) and the answer is `{type:'choice', choice, probabilities,
confidence}`. Read the exact shape from `~/Projects/AI/laya/laya/serve.py` and `agent.py`, and from the
exchange recorded in `BRAINS.md`.

**Precondition for the adapter task:** one **real** request/response pair is recorded from a running
Laya, or taken from `laya/tests/test_serve.py`, and committed as `bots/test/fixtures/laya-exchange.json`.
The adapter test replays it: the request the adapter builds must equal the recorded request, and the
recorded response must map to the expected `Answer`.

- CLM uses the same adapter, with a per-brain key mapping only if its format differs.
- Probabilities are normalised over the offered options; a missing option counts as 0.
- `scripted.ts` implements `Brain` deterministically from the snapshot (§6).

## 6. Port, perception, candidates, loop

**The port** (`port.ts`) is the only surface the companion uses.
- It exists so unit tests fake the port, not a socket. **Ruling:** the SDK's private `BotWorld`
  constructor and its test-only `FakeWS` are not reachable from `bots/`.
- Body: `pose()`, `players()`, `walkTo()`, `move()`, `lookAt()`, `place()`, `revert()`, `onEdit(cb)` and
  `onFx(cb)`.
- WorldView: `getBlock`, `blockName`, `isSolid`, `isLiquid`, `groundY`, `raycast(origin, dir, max)`,
  `generatedBlock(x, y, z)` (the terrain as generated, via `generateChunkBlocks`) and `mustMine`.
- The real adapter delegates to `BotClient` and `BotWorld`. `raycast` uses `raycastVoxel` on the live
  world.

**Snapshot** (`perceive.ts`, pure):
- **Kids:** non-bot players with `hasPos`.
- **The target kid:** the nearest kid, **keyed by name** (sticky), until they leave or go more than 48
  blocks away. A kid who reconnects gets a new id but keeps the same name.
- **Kid motion:** velocity from pose samples on the bot's clock over the last 1 s, plus a flying flag
  (feet more than 1.5 above `groundY` for longer than 0.5 s).
- **Look target:** from the kid's eye (`EYE_HEIGHT`), direction `(−sin yaw·cos p, sin p, −cos yaw·cos p)`,
  max 6.
- **The kid's placements:** only edits with exactly 1 op that set a solid, non-liquid block, with
  `by` = the kid. The last 5 are kept, with age and name. Multi-op edits (TNT, area pickaxes) and
  liquid flow are ignored.
- **Other state:** the stop-signal state, and the bot's last 3 actions.

**The text state** is deterministic and built from the snapshot only. It uses the kid's name (no
pronouns), distance to 1 decimal, and an 8-point compass bearing with north = −z (as
`src/ui/minimap-model.ts` does). Example: "Noah is 6.2 blocks north-east, walking. Noah is looking at
stone 2.0 blocks ahead. Noah placed oak_planks 3 times in the last 20 seconds, in a line going east.
You last followed Noah."

**The kid buffer (Ruling):** columns excluded from any bot edit = every column the kid's body box
(x ± 0.3, z ± 0.3) overlaps, widened by 1 in each direction (Chebyshev ≤ 1). Every edit also stays out
of the kid's body box, above and below. Checked against **every** kid, not only the target.

**Candidates** (`candidates.ts`). Only feasible ones are offered:

| Action | Available when |
|---|---|
| `follow` | a target kid exists and is more than `followDist + 1` away, or is moving |
| `watch` | a target kid exists: look at the kid's look target when the kid is still, otherwise at the kid |
| `help_build` | edits are allowed (not `--no-edits`, not a `mustMine` world, budget left, `editEveryMs` elapsed, no active stop signal near this kid), and the kid's last two placements A, B (≤ 15 s apart) are face-adjacent: the cell C = B + (B − A) is **AIR**, is not in any kid's buffer or body box, is within 6 of the bot's eye, and the block type is B's |
| `wander` | no kid present: a walkable spot 4–8 blocks away, within `wanderTether` of the last kid position (or of spawn), seeded per session |
| `idle` | always |

**Ruling:** `help_build` is off in `mustMine` worlds, because copying a block creates one from
nothing. **Cost if wrong:** no building help in those worlds.

**Follow is a standing intent, not an awaited action.** Measured by gate 1: awaiting `walkTo` kept
the bot within 4 blocks only 48% of the time, while re-issuing it every tick reached 100%.
- Every tick while `follow` is chosen, compute
  `target = kid + v_kid·0.5 s − followDist·unit(kid − bot)`, and re-issue `walkTo(target)` if the target
  moved more than 0.5 blocks. The tick never awaits a walk.
- Leaving `follow` stops the walk with `move(pose())` (the SDK has no cancel).
- **Flying or unreachable kid (Julien):**
  - if the kid is flying, or the walk rejects with `BlockedError` 3 times in a row, the bot **hops**
    with `move()` toward the kid in steps of at most 8 blocks, onto a cell with valid `groundY`, at
    least 1 block from any kid;
  - it hops at most once per second;
  - with no valid cell, it stays and watches.

**Loop** (`companion.ts`, every `tickMs`, never overlapping):
1. Take a snapshot. With no kid, choose `wander`/`idle` from the script, without asking the brain.
2. Build the candidates, then `ask` `next` over them.
3. If `confidence < minConfidence`, use the safe default: `follow` when available, else `watch`.
4. Act:
   - `follow`: the standing intent above.
   - `watch`: `lookAt`.
   - `help_build`: re-read C right before `place`. It must still be AIR and outside every buffer; the
     2 s edit interval puts the check and the SDK's `place` in the same macrotask. Then `place(C, B's
     name)`.
   - `wander`: an awaited `walkTo` with a 4 s cap.
   - `idle`: nothing.
5. Log one JSONL line: session seed, tick index, time, the structured snapshot, the text state, the
   candidates, the brain name, the raw answer, the chosen action, the reason (`brain`, `low-confidence`,
   `fallback:<err>`, `scripted`), the result and the latency.

**Stop signal** (`stop-signal.ts`, Julien): when an edit with `by` = a kid turns a cell whose current
bot-journal entry is the bot's `newId` into anything else, that kid gets a stop until now +
`stopMs`. During a stop:
- no bot edit within `stopRadius` of that kid;
- `help_build` is not offered;
- follow and watch continue.

It is logged and shown on the status line.

**Scripted brain** (the fallback and baseline):
- `follow` if the kid is more than `followDist + 1` away or moving;
- else `help_build` if offered;
- else `watch`.

**Exit:** SIGINT or SIGTERM closes cleanly. `--revert-on-exit` runs `revert()` first. The README warns
that revert keeps the SDK's rule (a cell is restored only if it still holds the bot's block), so bot
blocks under the kid's later blocks are pulled out and leave gaps. It's for cleaning up tests, not
normal play.

## 7. The SDK change

`BotClient.mine` re-checks, just before its timed `break`, that the cell still holds the block id it
started on. If not, it sends `mine-stop` and resolves `false`. Gate 1 showed `mine` destroying a block
a kid had placed mid-mine.

It's a one-line guard plus an SDK test, proven red. v1 doesn't mine, so this only protects future
bots.

## 8. Safety summary

- **The SDK already provides:**
  - the kid-body refusal (non-bot kids only; the e2e kid must therefore not be a bot);
  - the bedrock refusal;
  - a 150 ms edit gap;
  - the journal plus `revert`;
  - a read-only world.
- **The bot adds:**
  - AIR-only `help_build` that continues the kid's line;
  - the Chebyshev buffer against every kid;
  - a 2 s edit interval and a budget of 50;
  - the stop signal;
  - `--no-edits`;
  - the name-collision refusal and the port-8080 refusal;
  - the live acknowledgement;
  - no `help_build` in `mustMine` worlds.
- **The kill switch** is Ctrl-C.

## 9. Tests (each must be able to fail; every "prove red" is run once and recorded)

| # | Area | Checks | Prove red |
|---|---|---|---|
| 1 | Perception | Text from snapshot fixtures, including an **asymmetric** case (kid north-east, not south-west) and a bearing oracle (north = −z); a stickiness row (a second kid comes nearer and the target stays); a reconnect row (new id, same name, same target); the look target via `raycast` on a real generated world; placement filtering (a multi-op edit, a liquid, and another player's edit are ignored). | Flip the bearing sign: the asymmetric row fails. Key the target by id: the reconnect row fails. |
| 2 | Candidates and guard | A table covering: `help_build` only on A→B lines; C must be AIR (a planks cell → not offered); C outside every kid's Chebyshev buffer and body box; `mustMine` → not offered; budget, interval, `--no-edits` and stop signal; `wander` tether. | Drop the AIR check: the planks row fails. Shrink the buffer to 0: the buffer row fails. |
| 3 | Brain adapter | Replays `test/fixtures/laya-exchange.json`: the built request equals the recorded one, and the recorded response maps to `Answer`. Also: timeout → abort; normalisation; a missing option → 0. | Change the `criteria` key name: the replay fails. |
| 4 | Fallback | A timeout or error → a scripted decision for that tick, with the reason logged; 5 in a row → scripted for the session, shown on the status line; a down brain at start → refused unless `scripted`. | |
| 5 | Loop (fake port) | Ticks never overlap; low confidence → the safe default; follow re-issues `walkTo` without awaiting, and stops it with `move(pose())` when leaving follow; 3 blocked walks or a flying kid → hops of at most 8, at most 1 per second; the log schema. | Await `walkTo` in follow: the no-await row (a fake walk that never resolves) fails. |
| 6 | Stop signal | A kid breaking a bot block → no `help_build` for that kid, and no edits within `stopRadius`, for `stopMs`; follow continues; an unrelated edit doesn't trigger it. | |
| 7 | Config and CLI | Name collision; `--world` by name, ambiguous, or missing; live with no token or no ack; port 8080 refused; skin default; env and files injected (the real live token is never read in tests). | |
| 8 | SDK `mine` re-check | In `packages/minicraft-bot/test`: a kid replaces the cell mid-mine → `mine` resolves `false`, no `break` is sent, and `mine-stop` is sent. | Remove the re-check: it fails. |
| 9 | E2E (`npm run bots:e2e`) | Details below. | Disable the buffer rule: the buffer assertion fails. Disable the stop signal: assertion (d) fails. Do both with an explicit mutation run, recorded. |

**E2E details (#9):**
- **Setup:**
  - `test/mcserver.ts` builds `mcserver` from `server/` into a `mkdtemp` directory, with a temp DB and
    a free port. It unsets `MC_GCS_BUCKET`, `MC_TOKEN` and `MC_MIN_CLIENT` and passes `-gcs-bucket ''`,
    with go from `~/.local/go/bin/go`. The logic is copied from `scripts/mp-e2e.ts`, which exports
    nothing.
  - The **kid** is `test/kid-client.ts`, a raw-protocol WebSocket client:
    - `hello` **without** `bot`, `ver: CLIENT_VERSION`;
    - `pos` every 100 ms;
    - `lookAt`-style yaw/pitch toward each cell it places;
    - `edit {cid, ops}`.
- **The kid's script** starts ≥ 25 blocks from spawn, so an idle bot can't pass by standing still:
  1. walk a path;
  2. pause;
  3. place a 3-block line with the last block next to its own feet column;
  4. stand still;
  5. break one bot-placed block;
  6. place 2 more line blocks.
- **The companion** runs with the scripted brain for ~40 s. Assertions:
  - (a) after the first 5 s it stays within `followDist + 2` of the kid on ≥ 80% of 100 ms samples;
  - (b) ≥ 1 `help_build` block lands, exactly at B + (B − A), of B's type;
  - (c) no bot edit is ever inside the kid's buffer or body box, checked against the kid's pose when
    the edit echo arrives;
  - (d) after step 5, no bot edit lands within `stopRadius` of the kid;
  - (e) the log has timestamps that only increase, gaps ≤ `tickMs` + 4 s + slack, and between
    40/4.5 and 40/0.5 lines.
- **An idle-bot baseline** runs the same kid script with the bot never acting. It **must fail** (a).
- **A Laya leg** runs when Laya's health check passes: it must record `reason: brain` on at least half
  its ticks. Otherwise it prints a clear SKIP line.

**Verification per task:**
- `npm run bots:test`, `cd bots && npm run typecheck && npm run lint`;
- the root `npm test && npm run typecheck && npm run lint`;
- `npm run test:bot` whenever the SDK is touched;
- `npm run bots:e2e` once the e2e exists.

Rules for every run:
- Never touch port 8080, `~/minicraft-mp` or the live URL in tests.
- Headless.
- Kill servers by port, and only the ones you started.

## 10. Sequencing

- **T0 scaffold:** `bots/` package with the committed lock, tsconfig, eslint config, root scripts that
  run `build:bot`, the eslint ignore, `.gitignore`, and one smoke test importing the SDK.
- **T1:** config and CLI parsing (pure, injected).
- **T2:** Brain types plus the scripted brain.
- **T3:** port, perception, candidates, guard and stop signal (against the fake port).
- **T4:** the loop, `act`, log and status (against the fake port).
- **T5:** the SDK `mine` re-check.
- **T6:** the systemone adapter, once the recorded fixture exists, plus the brains launcher.
- **T7:** the e2e (mcserver helper, kid client, baseline, Laya leg).
- **T8:** README and the `CLAUDE.md` line.

## 11. Docs

`bots/README.md` covers:
- setup: the models in `~/Projects/AI`, see `BRAINS.md`;
- starting a brain (`npm run brains -- laya`);
- a local server on 18090;
- running locally and live, and the live checklist:
  - deploy the server first;
  - first session with `--no-edits`;
  - the stop signal;
  - `--revert-on-exit` caveats;
- the decision log and how to replay it;
- the status line;
- two kids (v1 follows one: the nearest, sticky);
- adding a bot.

## 12. Gate-1 disposition and rulings

**Accepted:**
- **The e2e kid:** it must be a non-bot raw-protocol client (the SDK kid was filtered out).
- **Follow:** a standing intent that leads the kid (measured 48% vs 100%).
- **`help_build`:** AIR only, re-read before placing, continuing the line with B's type.
- **The kid buffer:** Chebyshev-defined, checked against every kid.
- **Stop signal and controls:** the stop signal; `--no-edits`; the status line; the log includes the
  seed and snapshot for replay.
- **Watching:** look at the kid's look target when still (less staring); a default skin different
  from the kids'.
- **Perception:** a tethered `wander`; the sticky kid keyed by name; placement filtering (single-op,
  solid).
- **Brain:** Laya's real wire format (`criteria`, not `options`); a real recorded fixture; the Laya
  e2e leg asserts brain decisions.
- **Tests and tooling:**
  - the port seam instead of the SDK internals;
  - a URL override through config;
  - local port 18090 and the port-8080 refusal;
  - `bots:*` scripts run `build:bot`;
  - root toolchain only;
  - an eslint restricted-imports rule;
  - the mcserver helper with the full env unset;
  - `~` expansion, and start commands in config;
  - e2e (a) with a baseline and a fixed ≥ 25-block path;
  - log assertions that aren't circular;
  - rows that catch real behaviour (asymmetric, stickiness).
- **The SDK:** the `mine` re-check.

**Julien's product answers:**
- no `help_mine`;
- `help_build` continues the line;
- the stop signal is "break its block";
- a flying kid gets hop-along.

**Rulings** (each with its cost if wrong):
1. Drop `kid_busy_building`. *Cost:* the brain has one question; more can be added later.
2. No `help_build` in `mustMine` worlds. *Cost:* no building help there.
3. Local port 18090, and targets on 8080 refused. *Cost:* none.
4. The live token may be read from `~/minicraft-mp/token` at runtime. *Cost:* bots read the live
   server's token file. `MC_LIVE_TOKEN` overrides it.
5. The token override file is `bots/.env.live` (not `.env.local`, per `CLAUDE.md`'s rule). *Cost:*
   none.
6. The port seam instead of reaching into SDK internals. *Cost:* one small adapter file.
7. The e2e kid is a raw-protocol client, not a browser. *Cost:* the kid is less realistic than
   Playwright, but it's fast and needs no SDK option.
8. `--revert-on-exit` keeps the SDK semantics and the README warns about gaps. *Cost:* a cleanup can
   leave gaps under a kid's later blocks.
9. v1 serves one kid (the nearest, sticky). *Cost:* a second kid gets less attention.

## 12a. Gate-2 amendments (these override §4, §6, §7, §9 where they differ)

- **`help_build`** needs **3** collinear consecutive same-block single-op placements, each ≤ 4 s apart,
  with the last < 4 s old. There must be no off-line placement since, and the kid's look target must be
  on B, C0, N or a face-neighbour of N. N must be AIR, outside every buffer and body box, and within
  6 of the bot's eye. Rare and right beats frequent and wrong.
- **Stop signal:** per kid (by name), for `stopMs`, wherever the kid goes. There's no radius.
- **Flying:** the kid is not in liquid (feet and feet + 1), and his feet are more than 1.5 above
  `groundY` on **every** column his box overlaps, for longer than 0.5 s.
- **Hops:**
  - only when the horizontal distance is > `followDist + 1`, and either (flying with horizontal
    speed > 1 b/s) or 3 blocked walks;
  - the landing is not liquid, is outside every kid's buffer, and the **final pose** is ≤ 7.5 from the
    bot in 3D;
  - at most 1 per second;
  - the bot falls behind fast flight (10+ b/s) and catches up when the kid slows.
- **Confidence** = max(p) (Laya's `answer_confidence`), never Laya's calibrated `confidence`.
  `minConfidence` is 0.40, re-measured against 20 real Laya ticks and recorded in `BRAINS.md`.
- **The e2e kid** is a `BotClient` whose WebSocket strips `bot` from the hello, so the protocol is
  exact. Each leg uses a fresh world, and the bot connects **before** the kid walks away (a late
  joiner is spawned right next to the kid).
- **The e2e script** adds a second line whose N is in the buffer (so the buffer mutation can go red)
  and a turned-away line (the look-target rule).
- **Parity** between the fake WorldView and the real SDK is checked in the e2e, not in unit tests.
- **The SDK exports `isSolidId`/`isLiquidId`**, and `mine` re-checks inside its edit function.
- **The import boundary** is a vitest test that resolves paths; the eslint patterns were wrong both
  ways.
- **CLI:** `loadConfig` is fully injected; `checkLiveAck` runs after the world is resolved; there is a
  `revert` subcommand; the status line shows "paused near <kid>".
- **`mustMine`** comes from the `listWorlds()` row.

## 12b. Amendment (Julien, 2026-09-25, after a live demo): the bot can fly and jump

Observed on the live server: the SDK's `walkTo` has no jump and no flight, so the demo bot got stuck at
the bottom of stairs and only teleport-hopped after 3 failures. Julien: "allow the bot to fly and
jump". Following and looking "work very well".

**SDK additions** (Task 5):
- **`FLY_SPEED`** (10 b/s = `WALK_SPEED × FLY_TIER_DEFAULT`) is exported from
  `src/game/player-constants.ts`. The game's `player.ts` imports it, with no behaviour change. The SDK
  re-exports it.
- **`flyTo({ x, y, z }): Promise<WalkResult>`:**
  - It flies in a straight 3D line at `FLY_SPEED`, one pose per `POS_EVERY_MS`, facing the direction of
    travel (pitch toward the target).
  - Before each step, the bot's body box at the next pose (x ± 0.3, z ± 0.3, y .. y + 1.8) must overlap
    no solid block.
  - If it does, the bot climbs straight up (same x/z, +1 per step at `FLY_SPEED`) until the next
    horizontal step is clear, up to 16 blocks above its start or the world top. Then it continues toward
    the target.
  - If no clearance is found → it rejects `BlockedError{at, reason: 'wall'}`. An out-of-world target
    → `'noGround'`.
  - Like `walkTo`: it's cancelled by `walkTo`, `flyTo`, `move`, disconnect or `close` (resolves
    `'cancelled'`, never rejects); `lookAt` and `mine` don't cancel it.
  - It never moves more than `FLY_SPEED × POS_EVERY_MS/1000` per pose, so it never snaps on kids'
    screens.
- **`walkTo` jump:** a 1-block step-up is shown as an arc over 2 pose ticks (+0.6, then +1.0) instead
  of an instant +1. The ground rules are unchanged.
- **The stairs defect:** Task 5 also reproduces the "stuck at the bottom of stairs" case with
  generated or hand-built full-block stairs, fixes `walkTo` if it's a walk bug (e.g. the centre-column
  or body-fit check on diagonal steps), and pins it with a test.

**Companion follow modes** (Task 4; this replaces hop-first):
- **walk** while the target kid is on the ground and within walking reach.
- **fly** when:
  - the kid is flying (§12a flying flag), or
  - the kid's feet are > 1.5 above the bot's reachable ground, or
  - a walk rejected `BlockedError`.

  The fly target is `kid + v·0.5 − followDist·unit(kid − bot)`, at the kid's height (clamped ≥ the
  ground + 0), re-issued every tick when the target moved > 0.5. The bot flies alongside a flying kid,
  not under him.
- **land:** when the kid is back on the ground (not flying for > 1 s), the bot flies down to
  `groundY` near its landing target, then walks again.
- **hop** (a `move` of ≤ 7.5 in 3D, at most 1/s): only if `flyTo` itself rejects `BlockedError`
  twice in a row (e.g. enclosed caves).
- Hovering kid (20 up, horizontal distance ≤ 1.5): the bot flies up to his level at `followDist`
  and hovers beside him. There's no jitter, because the fly target barely moves.
- Swimming kid: the bot walks, or flies low above the water surface. It never lands in liquid.

**Tests:**
- SDK flight: speed per pose; a body-box collision → climb-over; enclosed → `BlockedError`;
  cancellation; no pose delta > 1.0 block; the walk jump arc; the stairs reproduction.
- Companion: mode switching (walk → fly on `BlockedError`, a flying kid → fly, the kid lands → land →
  walk); a hovering kid → it hovers beside him (0 hops); flight is re-issued without awaiting; hops
  only after 2 blocked flights.
- E2E: the kid script adds a 4-step staircase and a 3-block wall that the kid climbs or flies over
  (the kid-client uses the SDK's `flyTo`). Assert the bot stays within `followDist + 4` through them,
  with no pose jump > 8, and a hop count of 0 on that stretch.

**Target rotation (Julien: "if a player is not moving, it should move on to another player"):**
- A target kid is **idle** when:
  - his horizontal speed has been < 0.3 b/s, **and**
  - he has placed or broken nothing,
  - for `idleSwitchMs` (default **30 s**).
- When the target is idle and **another non-bot kid with a pose is online**, the companion switches to
  the nearest *other* kid. That new target stays sticky for at least `minTargetMs` (default **20 s**),
  so it never flips back and forth.
- The previous kid becomes eligible again when he moves, builds, or every other kid is idle too
  (round-robin, nearest first).
- With only one kid online, nothing changes: it keeps following and watching him.
- Switching is logged, and shown on the status line ("following Noah (switched: Julien idle 30s)").

This supersedes §6's "sticky until they leave or > 48 blocks": the target also changes on idleness.
It's still keyed by name.

Tests:
- Perception or target selection:
  - one kid idle for 30 s plus another online → switch;
  - a switched target is kept for ≥ 20 s even if the old kid moves;
  - a single idle kid → no switch;
  - both idle → round-robin between them, at most once per 20 s.
- E2E: add a second, raw non-bot kid ("Kid2") that stands idle while Kid walks, then the reverse. The
  companion switches to the active one within `idleSwitchMs + 2 s`.

**§12b re-gate corrections:**
- **Stairs:**
  - Today's `walkTo` climbs full-block stairs straight up, straight down and along the edge (probed).
  - The demo's failure was most likely a diagonal approach into a stair's side, which is a 2-block
    rise: the limit of straight-line walking, not a walk bug.
  - Task 5 fixes `walkTo` **only if** it first shows a repro that is **red on the current SDK**,
    taken from the demo geometry. Otherwise there's no walk change, and the case is pinned in the
    companion: a walk blocked at a stair side → `flyTo` → arrives.
- **"Reachable ground":** `groundY(bx, bz, bot.y)` at the bot's column. The fly trigger is that the
  kid's feet are > 1.5 above it.
- **Hover test:** assert the `flyTo` target is at the kid's height ± 0.5, at horizontal ≈
  `followDist`, and not re-issued while the kid is still. It no longer just asserts "0 hops".
- **Hop test:** 1 rejected `flyTo` → 0 hops; 2 → 1 hop.
- **Enclosed-flight test:** runs with a timeout. The pose-delta bound is ≤ 1.0 + 1e-9.
- **E2E:**
  - `Kid2` connects **only at the rotation stretch**, after the companion is locked on `Kid`. It
    takes no part in the idle-baseline or Laya legs.
  - Every stand in `Kid`'s script before the rotation stretch is capped at ≤ 20 s (well under
    `idleSwitchMs`), with small moves between.
  - The rotation assertion is timed from `Kid`'s last move or edit.
  - The wall-stretch follow bound starts from the kid's landing + 2 s.

**§12b engine re-gate corrections (these override the above where they differ):**
- **The stairs root cause is in the companion's follow condition, not in `walkTo`.** `walkTo`
  arrives on stairs straight, at 45° and 30°, and going down (probed). The demo stalled because
  follow looked only at the horizontal distance: the bot sat at the base, 2 blocks from the kid
  horizontally and 6 below.
  - `follow` is also offered when |kid.y − bot.y| > 1.5.
  - Fly mode triggers on |kid.y − bot.y| > 1.5 even when the kid is close horizontally.
  - Test: the kid stands on step 5, the bot is at the base 2 away horizontally → a `flyTo` within one
    tick.
  - Task 5's stairs test is a **green regression pin**: `walkTo` arrives up and down straight and
    diagonal stairs. There's no walk change unless a red repro appears.
- **Lead clamp:** `lead = clamp(v·0.5, length ≤ followDist − 0.5)`. Following stops when the 3D
  distance is ≤ `followDist + 1` and the kid's speed over the **last 0.3 s** is < 0.5 b/s, so the bot
  never flies into a kid who stops. Measured: never closer than 1 block.
  - The e2e judges a **flying** kid against `followDist + 5`.
- **`flyTo`:**
  - each climb step also needs a clear body box, otherwise it rejects `'wall'` (a ceiling);
  - the 16-block climb cap is measured from the flight's start y;
  - `flyTo` and `walkTo` share one movement slot, so each cancels the other.
- **Test hygiene:** with no server messages, the SDK drops to `reconnecting` after about 5 s, which
  cancels walks and flights. Flight, walk and mine tests feed `ping`s or keep advances short, and
  assert the bot is still connected.
