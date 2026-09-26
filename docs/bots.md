# Bots

Bots are TypeScript programs that join a Minicraft multiplayer world as players. They build, mine, decorate and
flatten, so that when Noah connects the world has visibly moved on. They are for the private family world only.

- **Local, never deployed.** Every bot runs on Julien's desktop (`bots/`, a separate npm package), talks to the
  multiplayer server like a browser client does (through the `minicraft-bot` SDK in `packages/minicraft-bot/`), and
  keeps its state in `bots/.state/` (git-ignored). Nothing here ships with the website or the API.
- **The kid's cells are sacred.** No bot ever breaks or replaces a block a kid placed, builds next to one, or edits
  inside a kid's body. The rules are listed under [Safety](#safety).
- **Movement is code.** Models (Laya, Jev, Ollama) only answer small multiple-choice questions ("which project?",
  "which site?"). Where to walk, what is safe and when to stop are always code.

The runbook with every command and flag is `bots/README.md`. Building a new bot or changing one? Read
[`docs/bot-builders-guide.md`](bot-builders-guide.md) first (the rules, the APIs, skeletons, checklists and live
failure modes). The brain2 design is
`docs/superpowers/specs/2026-09-25-bot-brain-design.md` (part 1 implemented, part 2 pending); everything else here was
built as fast live experiments on the `bot-brain` branch, recorded in the session ledger
`.superpowers/sdd/2026-09-25-bot-brain/progress.md`.

## The bot types

Every type is a subcommand of `npm --prefix bots run bot -- <type> …`. Names are the ones used on the live world.

| Type | Live name(s) | What it does | Models | Key flags |
|---|---|---|---|---|
| `companion --brain v2` (brain2) | Enderman 3 (`pip`, code only), Enderman 2 (`rex`, `--jev`) | The emotional brain: follows a kid, helps continue his line of blocks, builds templates and mines by spiral staircase from its own inventory, explores, watches, rests. Shows its mood by body language only. | Code experts (part 1). `--jev`: Jev answers selection's social and situational questions. | `--personality pip\|rex`, `--jev`, `--tui`, `--when` |
| `companion` (v1) | (none live) | The original follow / watch / help-build companion (500 ms tick). | Laya, CLM (does not fit this GPU) or `scripted` | `--brain laya\|clm\|scripted` |
| `builder` | Milo the noob (Laya), Snaky (Jev) | Builds templates (house, tower, wall, statues) with themed palettes, one block at a time, unlimited blocks, never mines. | Laya or Jev: the project and the next cell among ≤ 3. | `--brain`, `--compare`, `--max-builds` (10/h), `--join-plan`, `--rest-sec` |
| `decorator` | Decky | Decorates around the builder-family builds: corner lights, flower patches, leaf bushes, a path from the door, a fenced garden. | Laya or Jev: which build, which decoration. | `--max-decorations` (30/h) |
| `village` | Mayor Vic | Plans one village (3–5 lots around a plaza: statue, houses, a tower, paths, lamps) in a theme, then builds it lot by lot. One village per hour. | Laya or Jev: theme and layout. | `--rest-sec` |
| `helper` | Copy Cat | When a kid is building (≥ 3 placements in 60 s), builds a small matching structure 4–8 blocks from his cells, in his own blocks. | Laya or Jev: tower, wall, statue or little house. | `--max-builds` (10/h) |
| `architect` | Archie | Designs its own structures: 8 parametric generators (castle gate, lighthouse, pyramid, bridge, mushroom, rocket, treehouse, pixel smiley), 3 sizes × 3 styles × 5 colour themes, validated before offered. | Laya or Jev: idea, theme, size, style. `--llm-params`: Ollama llama3.2:3b proposes the numbers. | `--max-builds`, `--join-plan`, `--llm-params` |
| `foreman` | Boss | Lays out one neighbourhood per world on a road grid (2 rows of 3–5 lots of 7×7) in the shared plan, builds the roads and lamps itself, then strolls. Asks the board for flat ground when no plan fits. | None. | — |
| `landscaper` | Digger Dan | Makes flat building ground with the game's own Flattening TNT: mines the raw ingredients, crafts by the Craft tab's recipes, digs the TNT in, primes it, applies the game's blast. | Laya or Jev: which of ≤ 3 candidate areas. | `--max-blasts` (15/h), `--pickaxe`, `--grant-ores` |

`revert` is the cleanup subcommand (see [Operations](#reverting-a-bot)).

## Architecture

```
bots/src/
	cli.ts, cli-args.ts, config.ts   subcommands, flags, targets, live-ack
	port.ts                          the Body/WorldView port every bot uses (testable against test/fake-port.ts)
	brain2/                          the emotional brain (companion --brain v2)
	bots/companion.ts, brain/, body/ companion v1, its brains, perception, guard, stop signal, act
	builder/ decorator/ village/ helper/ architect/ foreman/ landscaper/   the builder family
	nav/                             shared navigator, stuck watchdog, wander, showtime
	shared/                          bot-cell registry, per-hour caps, --when gate, slicing
	board/                           board.json and kid wool markers
bots/panel/                          the local control panel
bots/bench/                          the model benchmark
```

### SDK additions (`packages/minicraft-bot`)

All read-only exports of game code, plus four client methods. None changes the game or the server.

- `BotWorld.isEdited(x, y, z)` and `editedCellsInChunk(cx, cz)`: the server overlay plus this bot's own local writes
  (backed by `ChunkOverlay.cellsIn`, added to `src/engine/world/overlay.ts`). Ownership uses them to tell natural from
  edited cells.
- `BotClient.walkTo(target, { speed })`: speed in (0, 1] scales the step (brain2's style); outside it throws.
- `BotClient.mine(x, y, z, ms?, tool?)`: with a pickaxe tier, the game's mining time and the area-crack fx.
- `BotClient.breakMany(cells)`: one batched break (the landscaper's blast and pickaxe area), journaled like any edit;
  skips air, liquid, bedrock, kid bodies and cells whose id changed (`expect`).
- `worldSpawn(seed, gen)`: the generated spawn column (`spawnV3`).
- Block lists: `WORLDGEN_BLOCKS` (what a bot can mine) and `CRAFTED_ONLY` (never mined, never held by a bot).
- Toy TNT (`blast.ts`): `blastCells(world, 'flatten_tnt' | 'tunnel_tnt', center)` runs the game's own `detonate`;
  `tntSpec(name)`; `RECIPES`, `FLATTEN_HEIGHT`, `TUNNEL_LENGTH`. `src/game/blast-shapes.ts` joined the SDK guard's
  allowed files.
- Pickaxes: `PICKAXES`, `miningDuration`, `isMultiBlock`, `areaCells`, `AREA_FLOOR_ARMED/HELD`.

### brain2

`runBrain2` (`brain2/brain.ts`) wires everything into one 100 ms beat:

- **Store** (`store.ts`): one state object (8 global emotion axes with bands and deltas, relations per player, the
  active behaviour, inventory, builds, digs, owned cells), changed only by patches with a cause. Every change is a log
  line, so a session replays exactly.
- **Experts and scheduler** (`experts/`, `scheduler.ts`): event-triggered experts on two lanes (`laya`, `llm`) with
  timeouts and code fallbacks. In part 1 every expert runs its code path; `--jev` routes selection's social and
  situational questions to Jev.
- **Appraisal** (`appraisal.ts`, `data/appraisal.data.ts`): a burst of salient world events becomes signed deltas on
  the emotion and relation axes. Emotions decay toward the personality's baselines (`data/personalities.data.ts`).
- **Selection** (`selection.ts`, `data/weights.data.ts`): when to reselect (triggers, a 20 s minimum, keep-going) and
  how to score (emotional table, social and situational votes, inertia, recency, resume and line bonuses, a mask of
  what is possible now).
- **Behaviours** (`behaviours/`): Follow, Help-build (free blocks), Build (templates on a levelled ±1 site, at most 3
  standing), Mine (a tunnel-free spiral staircase around a pillar, 120 s episodes that pause and resume, at most 3
  paused digs), Explore, Watch, Rest.
- **Runner** (`runner.ts`): one action at a time, each judged by safety, sense and fit before it runs; climbs out of
  a dig before any other behaviour; moves through the shared navigator with the stuck watchdog.
- **Expression** (`expression.ts`, `style.ts`, `data/gestures.data.ts`): gestures (hops, turns, fireworks) on
  appraisal changes, only inside a kid's view; walking speed and edit pace from the emotions.
- **Persistence** (`persist.ts`): `bots/.state/brain/<target>/<world>/<name>.json`, written every 5 s: inventory,
  builds, digs, owned cells, relations, explored chunks. Relation values halve when the bot was offline for more
  than 30 min.
- **Debug**: `--tui` live view, `npm run bot:replay -- <log>` and `--data <file.ts>` (the per-decision check).

### The shared navigator (`nav/`)

Every bot's "get to X" goes through `navigate()`:

1. `walkOrFly`: a straight `walkTo`; blocked at a wall or cliff, a flight to the same column, landing on top of every
   column under the body, lifting straight up first when the route is higher than `flyTo`'s 16-block climb.
2. `flyHigh` when that fails: sideways to the nearest open-sky column (within 6, 16 when submerged), up in ≤ 15-block
   hops, across at the route's highest surface + 3, then down onto the target (or beside it when it is under a roof).

**Stuck watchdog** (`StuckWatchdog`, one per body): while a movement goal is active and the bot moves less than 0.5
blocks in 15 s, each check escalates one level: (1) fly high to the goal; (2) when enclosed, along air cells to open
sky within 8, then straight up; (3) a teleport straight up to the column's top + 2. After level 3 the caller abandons
the action. Every level logs an `unstick` line.

**Wander** (`wander.ts`): the builder family's idle movement (rest between builds, a capped bot, the foreman's stroll)
picks standable open-sky cells within 12 of a centre, never liquid; after 2 navigator failures in a row it stands still
and looks around for 60 s.

**Showtime** (`showtime.ts`): with a kid online, the builder family and brain2's Build prefer a site 15–30 blocks from
him within ±70° of where he faces, so he can watch it go up. Only a preference: every site rule still applies.

### Shared bot-cell registry

`bots/.state/shared/<target>/<world>/bot-cells.jsonl` (`{x,y,z,id,bot,t}`, append-only). Builder, decorator, village,
helper, architect, foreman and landscaper append every cell they write. A cell whose current block equals its latest
entry counts as a bot cell, so bots don't back off from each other's blocks as if they were a kid's; a later non-bot
edit makes it a kid cell again. brain2 keeps its own `owned` map in its brain file instead.

### The job board (`board/`)

`bots/.state/shared/<target>/<world>/board.json`, under the foreman plan's lock (a `mkdir`'d `.lock` directory,
broken after 10 s) with atomic writes. A post goes open → claimed → done; a claim not renewed for 15 min expires.

| Post type | Posted by | Taken by |
|---|---|---|
| `flat-needed` | foreman, when no plan has a lot left (24×24 near spawn, one at a time, again 30 min after the last was answered) | landscaper |
| `flattened` | landscaper, when a square is level (region, floor y, requester) | foreman (its own answer first, else any open one) |
| `kid-marker` | the landscaper's marker watcher, once per marker | landscaper (red markers only) |
| `build-request`, `decorate` | defined, nobody posts or reads them yet | — |

The Boss ⇄ Digger Dan ⇄ builders flow: Boss lays a plan and builders started with `--join-plan` claim its lots
(`plan.json`: open → claimed → built, or dropped with a reason; a dropped lot reopens when its check passes again, up
to 3 drops). When no lot is left, Boss posts `flat-needed`; Digger Dan claims it and levels a square at least that
size; it posts `flattened`; Boss claims that, lays a new plan on the floor (archiving the old one as `plan-<ts>.json`),
and the builders pick up the new lots. A `flattened` area too small for a grid is skipped by Boss from then on and
goes back to the board open (closed instead when Boss asked for it).

### Kid wool markers

A kid stacks exactly 3 wool of one colour, one on another: **red** = flatten here, **blue** = build a house here,
**green** = make a garden here. The watching bot posts a `kid-marker` once and the nearest watcher sets off a
firework above it, so the kid knows it was heard. The marker's cells are kid cells: no bot touches them.

Today only the landscaper watches for markers and only red ones are acted on (it levels there). Blue and green are
acknowledged with the firework and posted, but no bot builds or gardens on them yet.

### Per-hour caps and `--when players`

- **Caps** (`shared/cap.ts`): builder, architect and helper stop at `--max-builds` builds in the last rolling hour
  (default 10), the decorator at `--max-decorations` (30), the landscaper at `--max-blasts` (15). Counted from the
  bot's own state file, so they hold across restarts. Builds on a foreman lot don't count. A capped bot stays online
  and wanders near its builds, logging `cap-reached`. The village bot starts a new village an hour after the last one
  finished. These are a runaway guard, not a throttle (ruling R30 replaced the overnight clutter caps).
- **`--when players`** (`shared/when.ts`): the bot is active only while at least one non-bot player is online; else it
  stays connected, finishes its current step (a lit fuse always burns), makes no model call and no edit, and looks
  around. Both switches wait 5 s. brain2 keeps perceiving while paused. Companion v1 ignores the flag.

### Engines

| Engine | Where | Used by | Notes |
|---|---|---|---|
| Laya | local, `127.0.0.1:8000`, `LAYA_MODELS=english` | builder family (`--brain laya`), companion v1 | 400 ms timeout. Runs as the transient user unit `laya` (see below). |
| Jev | hosted, `api.typesafe.ai/v1/systemone`, model `jev-latest` | builder family (`--brain jev`), brain2 `--jev` | 3 s timeout. Key: `JEV_API_KEY` in the repo's `.env` (a worktree falls back to `~/Projects/Minicraft/.env`), never logged. Observed cost about $0.37 for one night of every bot. |
| Ollama | local, `127.0.0.1:11434`, `llama3.2:3b` | architect `--llm-params`, the benchmark | temperature 0, seed 42. |
| code | — | brain2 part 1, every fallback | |

In the builder family a down engine is never a refusal: each question falls back to a heuristic, an engine failing 3
times in a row is skipped for 60 s, and `--compare` asks the other engine too and logs whether they agree.

## Safety

- **Kid cells** (Ownership: decided by the current block and the last writer, never by coordinates): never broken or
  replaced, never built on or next to; build sites keep 12 blocks from any kid cell.
- **Kid bodies**: no edit inside a kid's columns or the ring around them; sites avoid where kids stand now.
- **Stop signal**: when a kid breaks a bot's block, that bot makes no edit within 16 blocks of him for 10 minutes (the
  stop follows him). brain2 also remembers it as a grievance.
- **Tripwire** (`brain2/safety.ts`): halts every edit for the session on more than 1.2× the maximum edit rate in a
  minute, the same cell edited 3 times in 10 min, or more than 110% of the plan's edits. The landscaper's blasts use a plan-bound budget: exactly
  the filtered cells, else everything halts.
- **Landscaper blast filter**: a blast removes natural cells only, and is dropped whole when any cell is within 12 of
  a kid cell, within 24 of a kid, or touches liquid; checked before lighting and again after the fuse. It never blasts
  flat ground or the same spot twice. Pickaxe area cells each pass the mining safety rules on their own.
- **Builder family placement** (`checkPlace`): only into air, through brain2's `judgeSafety`, plus `--no-edits`.
- **Names**: a bot's name may not equal any name online or saved in the world (so it never takes over a kid's record).
  The server allows letters, digits and spaces, up to 16.

## State files and logs

Everything is under `bots/.state/` (git-ignored); `<world>` is the world uuid.

| Path | What |
|---|---|
| `<target>/<world>/<name>.json` | The SDK's edit journal (last 10,000 edits), used by `revert`. Every bot has one. |
| `brain/<target>/<world>/<name>.json` | brain2's brain file. |
| `builder/<target>/<world>/<name>.json` | Builder and architect records (builds, cells placed); the decorator reads every file here. |
| `decorator/`, `village/`, `helper/`, `foreman/`, `landscaper/` `<target>/<world>/<name>.json` | Each type's own state (a restart resumes). The landscaper's holds its inventory, areas, blasts, crafts, tried spots and `granted`. |
| `shared/<target>/<world>/plan.json` | The foreman's neighbourhood plan (and `plan-<ts>.json` archives). |
| `shared/<target>/<world>/board.json` | The job board. |
| `shared/<target>/<world>/bot-cells.jsonl` | The bot-cell registry. |
| `logs/<target>/<world>/<name>-<stamp>.jsonl` | One log per session. |
| `live-ack.json` | Worlds acknowledged with `--i-deployed-the-server`. |

**Logs.** brain2 logs a `meta` line, the `initial` state, then every state change, `select` (inputs and rows), `call`
and event lines; past 50 MB it continues in `-2`, `-3`, … and only the newest 20 files are kept. The builder family
logs one JSON object per line with `k` and `t` (ms): `start`, `decision` (the model question, options and answers),
`project`, `place`, `refused`, `build-end`, `cap-reached`, `paused`/`resumed`, `unstick`, `walk-fly`, `fly-high`,
`search-failed` (rejection counts per radius), and for the landscaper `gather`, `mine`, `mine-area`, `craft`, `dig`,
`prime`, `blast`, `flattened`. Companion v1 logs one decision line per tick. For a quick look:

```bash
jq -r .k bots/.state/logs/live/<world>/<name>-<stamp>.jsonl | sort | uniq -c | sort -rn
```

## Operations

### Running live

Live bots run as transient systemd **user** units named `mcbot-<slug-of-name>` (for example `mcbot-milo-the-noob`),
normally started from the control panel.

⚠ **Never use a `minicraft-*` glob for bots.** `minicraft-*` matches `minicraft-server` and `minicraft-tunnel`, the
live multiplayer server and its tunnel. Bot units are `mcbot-*` (ruling R29 moved them there); address them by that
prefix or by exact name.

```bash
systemctl --user list-units 'mcbot-*'
journalctl --user -u mcbot-digger-dan -f
systemctl --user stop mcbot-digger-dan
```

What the panel runs to start one (every value whitelisted; run without a shell):

```bash
systemd-run --user --unit=mcbot-<slug> --working-directory=<worktree> \
	--property=Restart=on-failure --property=RestartSec=60 \
	--property=StartLimitIntervalSec=3600 --property=StartLimitBurst=5 \
	--setenv=PATH=<node dir>:/usr/local/bin:/usr/bin:/bin \
	<node dir>/npm --prefix bots run bot -- <type> --target live --world <uuid> --name <name> --skin <skin> … --i-deployed-the-server
```

**Restarts and the start limit.** A unit may start at most 5 times an hour. Repeated manual restarts hit that limit;
the transient unit then fails and disappears. Run `systemctl --user reset-failed mcbot-<slug>` before a restart, or
stop it and start it again from the panel (the panel resets it first). Transient units do not survive a reboot.

### The control panel

`bots/panel/` serves a local page on http://127.0.0.1:7777/ (loopback only, no auth; it rejects foreign `Host`
headers and non-JSON POSTs). It starts and stops `mcbot-*` units, lists them with their personality cards and Laya's
health, and shows an instance's status, journal tail and a summary of its newest log. It never touches
`minicraft-server` or `minicraft-tunnel`. It exposes the common flags only (no `--pickaxe`, `--grant-ores`,
`--max-blasts`, `--llm-params` or `--rest-sec`); use the CLI for those.

```bash
npm --prefix bots run panel                   # foreground, from the worktree root
npm --prefix bots run panel -- --dry-run      # Start/Stop print the argv instead
systemd-run --user --unit=botpanel --working-directory=<worktree> --property=Restart=on-failure \
	--setenv=PATH=<node dir>:/usr/local/bin:/usr/bin:/bin <node dir>/npm --prefix bots run panel
```

The panel runs the bots from the checkout it lives in (today the `bot-brain` worktree).

### Laya as a user unit

```bash
systemd-run --user --unit=laya --working-directory=$HOME/Projects/AI/laya \
	/usr/bin/env LAYA_HOST=127.0.0.1 LAYA_PORT=8000 LAYA_DEVICE=cuda LAYA_PRELOAD=1 LAYA_MODELS=english \
	$HOME/Projects/AI/laya/.venv/bin/laya-serve
curl -s http://127.0.0.1:8000/health
```

`npm --prefix bots run brains -- laya` starts the same command in the foreground. Setup is in
`~/Projects/AI/BRAINS.md`.

### Reverting a bot

Stop the bot's unit first (a running brain2 rewrites its brain file every 5 s, and the name is in use while it is
online), then:

```bash
npm --prefix bots run bot -- revert --target live --world <uuid|name> --name "<bot name>"
npm --prefix bots run bot -- revert --target live --world <uuid|name> --name "<bot name>" --builds   # brain2 only
```

`revert` replays the SDK journal backwards (the last 10,000 edits), restoring a cell only while it still holds the
bot's block; for brain2 it also reconciles the brain file. `--builds` takes brain2's standing builds apart instead and
leaves alone every cell beside an online kid. Builder-family state files, the plan, the board and the bot-cell
registry are not rewritten by `revert`.

## The benchmark (brain2 part 2 decision)

`npm run bot:bench` asks every candidate engine and wording the labelled cases in `bots/bench/cases/` and writes
`bots/bench/results/<date>-<model>.txt`. The bar (spec criterion 2) is ≥ 80% accuracy and ≥ 60% recall per class, for
appraisal only; the always-`stay` control must fail it.

Result on 2026-09-26 (llama3.2:3b and Laya `english`): **no appraisal candidate passes.** Best: `llm-fewshot` 34/63
(54%); Laya binary 27/63 (43%), Laya three-way 26/63 (41%); the control failed as required. On the small unscored
sets: fit, the LLM 6/8 and Laya 2/8; situational, the LLM 6/8.

Part 2 (`docs/superpowers/plans/2026-09-25-bot-brain-part2.md`) wires model experts behind the code brain and must not
start until Julien records his engine choice in `bots/src/brain2/data/engines.data.ts` (today: `code` everywhere,
`measured: 'not yet'`). Jev was tried outside the spec (brain2 `--jev`, and the builder family) and is not in the
benchmark.

## Known issues and open items

- **Boss's lots get dropped near kid edits.** A lot is re-checked when claimed; any kid cell within 12 drops it. On the
  live world all 8 lots of the current plan are dropped (6 `kid-cells`, 2 `not-flat`), so `--join-plan` builders fall
  back to their own site search.
- **The flat-ground loop has not closed yet.** Digger Dan answered two `flat-needed` posts with "no safe area to
  flatten near it", and Boss found the one `flattened` square too small for a neighbourhood.
- **Archie sometimes finds no site.** With the kid high on a mountain the search fails at every radius, almost all
  rejections `not-flat`; it retries and idles meanwhile.
- **The landscaper is slow.** Each Flattening TNT needs 10 sand, 8 coal, 8 redstone and 16 stone mined by hand;
  the last session managed about one blast every 4 minutes with an iron pickaxe and granted ores. Its long area
  searches used to starve the socket (1006, crash loop); they are sliced now (`shared/slice.ts`).
- **Blue and green markers, `build-request`, `decorate`**: posted or defined, but no bot acts on them.
- **brain2 part 2 is pending** Julien's engine decision (above). brain2's llm lane has no tests yet (ruling R7, carried
  to part 2).
- **Flags are not checked per command**: a flag that a command does not use is accepted and ignored.
- **Deferred minors** from the reviews are listed in the ledger (for example: the Tripwire's per-cell times are never
  pruned; resuming a dig from across a wall can fail).
