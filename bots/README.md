# bots

Local TypeScript bots that join a Minicraft multiplayer world as players. They run on Julien's own
desktop, never deployed. The first (and so far only) bot is **companion**: it follows a kid, looks
at what he's looking at, and helps him build by continuing his line of blocks.

Design: `docs/superpowers/specs/2026-09-25-companion-bot-design.md`.

## Setup

1. **The decision-model server (the "brain").** Companion asks a local model, Laya, what to do
   next. Laya (and the experimental CLM) live outside this repo, under `~/Projects/AI/*` — no
   Python and no model files are checked in here. Setup, start commands and measured performance
   are in `~/Projects/AI/BRAINS.md`. Read it once before your first run.

   **CLM is experimental and not usable on this desktop today.** Its `clm-serve` process runs
   fine, but the Qwen3-8B pooling encoder it depends on doesn't fit this machine's RTX 3080
   (10 GiB) — a genuine CUDA out-of-memory, not a config mistake (see `BRAINS.md`). If you pass
   `--brain clm`, the CLI's health check will fail and it will refuse to start, with a message
   pointing at `BRAINS.md`.

2. **Install:**

   ```bash
   npm run bots:install
   ```

   Run this from the repo root. It builds the bot SDK (`npm run build:bot`) first, then
   `npm install`s inside `bots/` — the `minicraft-bot` dependency is `file:../packages/minicraft-bot`,
   so bots never run against a stale or missing SDK build.

3. **Start a brain** (in its own terminal, left running):

   ```bash
   npm run brains -- laya
   ```

   This spawns Laya's exact start command from `bots.config.ts` (which mirrors `BRAINS.md`), on
   `127.0.0.1:8000`. Ctrl-C stops it. `npm run brains -- clm` starts CLM the same way, but see the
   note above — its health check will fail downstream in the companion CLI.

All commands below (`npm run bot`, `npm run brains`) are run from `bots/`.

## A local server for playtesting

This is separate from the automated e2e (below), which starts and stops its own throwaway server.
For playing with a bot yourself, start a local `mcserver` you keep around:

```bash
cd server   # from the repo root
DB=$(mktemp -d)
env -u MC_GCS_BUCKET -u MC_MIN_CLIENT ~/.local/go/bin/go run ./cmd/mcserver \
	-db "$DB/mc.sqlite" -addr 127.0.0.1:18090 -token e2e -gcs-bucket '' \
	-origins http://localhost:5180
```

This is the same command as `packages/minicraft-bot/README.md`'s local test server, with the port
moved to **18090** (so it never collides with `npm run e2e:mp`'s 18080) and `-origins` opened for
a dev site on port 5180.

Then run the site pointed at it, on a different port than your usual `npm run dev` (5173), with
the cloud-save API pointed at a dead port so local testing never writes to a kid's real save:

```bash
VITE_MINICRAFT_API_URL=http://127.0.0.1:9099 \
VITE_MINICRAFT_MP_URL=http://localhost:18090 \
VITE_MINICRAFT_MP_TOKEN=e2e \
./node_modules/.bin/vite --port 5180
```

Open `http://localhost:5180`, go to **Multiplayer**, and create a world there (name, seed,
mustMine) — same as a kid would. That's the world you point `--world` at below.

⚠ Never point either command at `minicraft-server.leap-forward.ca`, port 8080, or
`~/minicraft-mp` — those are the live server. `loadConfig` refuses any `--target` URL on port 8080
outright.

## Running the companion

```bash
npm run bot -- companion --target local|live --world <uuid|name> \
	[--name Robo] [--skin <id>] [--brain laya|clm|scripted] \
	[--no-edits] [--revert-on-exit] [--i-deployed-the-server]
```

- **`--target`** picks a server from `bots.config.ts`'s `targets` (`local`: the 18090 server
  above; `live`: the kids' real server). Required.
- **`--world`** is a uuid or an exact name (case-insensitive) from `listWorlds()`. Leave it out and
  the bot prints the target's worlds and exits cleanly — no connection is made. A name that
  matches nothing, or matches more than one world, errors out instead (naming the candidates for
  the ambiguous case).
- **`--name`** defaults to `Bot`. It must not equal (case-insensitively) any name that is online
  or already in the world — this stops a bot from ever taking over a kid's saved record. Give
  bots their own names (a `Robo` prefix is a good habit).
- **`--skin`** defaults to the first catalog skin no online kid is currently wearing.
- **`--brain`** defaults to `laya`. A down or unhealthy brain refuses to start — for `laya`, the
  message names the start command (`npm run brains -- laya`); for `clm`, it explains why (the GPU
  note above) and points at `BRAINS.md` — unless you pass `--brain scripted` (deterministic, no
  external process, always available; the same rules the loop falls back to on a brain failure).
- **`--no-edits`**: follow and watch only, no `help_build`. Recommended for your first live
  session (below).
- **`--revert-on-exit`**: see the live checklist below.
- **`--i-deployed-the-server`**: only needed for `--target live`, and only once per world (see
  below).

`revert` is a second subcommand, for cleaning up after a bot without starting the loop:

```bash
npm run bot -- revert --target <target> --world <uuid|name> --name <bot's name>
```

It connects with the bot's own saved state, calls `revert()`, prints how many cells it restored,
and exits.

## The builder bot

A small, separate bot (`bots/src/builder/`): it only builds (never mines), with unlimited blocks. It loops: pick a
project (a template × size, not one of the last two kinds built; the model chooses, else random-weighted) and a
palette → find a flat site near the nearest online kid (else world spawn), widening 32 → 64 → 96, ≥ 12 from any kid
cell and clear of its own builds → place one block at a time (the model picks among ≤ 3 supported cells, else lowest
then nearest), ~0.8 s apart → a firework → rest 5 minutes → again.

```bash
npm --prefix bots run bot -- builder --target local|live --world <uuid|name> --name <n> [--skin <s>] \
	--brain laya|jev [--compare] [--when always|players] [--no-edits] [--i-deployed-the-server]
```

- **`--brain laya`** asks Laya (`npm run brains -- laya`, 400 ms timeout); **`--brain jev`** asks Jev (hosted, 3 s
  timeout; `JEV_API_KEY` read from the repo's `.env`, never printed). A down engine is not a refusal: every question
  falls back to the heuristic (an engine failing 3 times in a row is skipped for 60 s). **`--compare`** also asks the
  other engine and logs both answers and whether they agree; the bot acts on `--brain`'s.
- **Safety:** every placement goes through brain2's `judgeSafety`: only into air, never on or next to a kid-made
  cell, never in a kid's body buffer, never within 16 blocks of a kid who broke one of its blocks in the last
  10 minutes (the stop signal), and a Tripwire halts all edits on a runaway. A kid cell appearing at the site abandons
  the build; a kid standing inside it pauses it (abandoned after 60 s).
- **State:** `bots/.state/builder/<target>/<world>/<name>.json` (its builds and the cells it owns; a build in
  progress resumes after a restart). **Log:** `bots/.state/logs/<target>/<world>/<name>-<stamp>.jsonl` (`decision`,
  `project`, `place`, `refused`, `build-end`, `stop-signal`, …). A status line every 30 s; Ctrl-C/SIGTERM stops it.

## The decorator bot

A small companion to the builder (`bots/src/decorator/`): it decorates around the builds the builder bots made, with
unlimited blocks, and never mines or changes an existing block. It loops: read every builder record of the world
(`bots/.state/builder/<target>/<world>/*.json`, all bots) → the model picks one of the ≤ 4 nearest builds (else the
least decorated, then nearest) → ≤ 3 candidate decorations (corner light posts, a flower patch, a leaf bush, a path out
of the door, a little fenced garden), each a short cell list → the model picks one (else random) → place it cell by
cell, flying within reach like the builder → rest `--rest-sec` with an idle look-around → again.

```bash
npm --prefix bots run bot -- decorator --target local|live --world <uuid|name> --name <n> [--skin <s>] \
	--brain laya|jev [--compare] [--rest-sec N] [--when always|players] [--no-edits] [--i-deployed-the-server]
```

- **Where:** only into air, only on natural or bot ground, outside every build's footprint and within 4 blocks of
  the chosen build's; never in front of a door except for the path. Blocks come from `DECOR_BLOCKS` in
  `decor.ts` (checked against the SDK's `blockNames()`).
- **Safety and engines:** as the builder (`checkPlace` = brain2's `judgeSafety` with `allowFree`, kid cells and their
  buffer, kid body buffer, stop signal, Tripwire; `--brain`/`--compare` as above). Builder-owned cells count as bot
  cells, so the ground beside a build is not mistaken for a kid's.
- **State:** `bots/.state/decorator/<target>/<world>/<name>.json`; log as the builder's. e2e leg: `decorator`.

## The village bot

A planner (`bots/src/village/`): it plans one village near the nearest kid (else spawn), then builds it. The model
picks a theme (`THEMES` in `themes.data.ts`: cozy wood, stone fort, sandy desert, snowy) and a layout (row / circle /
square around a plaza); the site search tries plaza centres by distance for 5, then 4, then 3 builds (a statue in the
plaza, houses, one tower; lots 4–6 blocks apart), every lot passing brain2's site rules (spawn, leash, other builds,
kid positions, flat and natural, headroom, ≥ 12 from kid cells). Then lot by lot with the builder's move loop: the
statue, then each house/tower followed by a path from its door to the plaza (on top of the ground, only into air) and
lamps on posts at both path ends. The plan persists in `bots/.state/village/<target>/<world>/<name>.json`, so a
restart resumes it. Same flags, engines and safety as the builder; e2e leg: `village`.

```bash
npm --prefix bots run bot -- village --target local|live --world <uuid|name> --name <n> [--skin <s>] \
	--brain laya|jev [--compare] [--rest-sec N] [--when always|players] [--no-edits] [--i-deployed-the-server]
```

## The helper bot (experiment E5)

`bots/src/helper/`: it watches the kids' placements. When a kid is building (≥ 3 placements within 32 blocks of him in
the last 60 s, then a 5 s pause) it builds a small matching structure beside his build: the model picks "a matching
tower", "a wall", "a statue" or "a little house" (else random); the blocks are his (most used = wall, unlimited
supply; never TNT, sand/gravel or liquids); the site puts every footprint column 4–8 blocks from his cells (never
within 3 of any kid cell), out of his body buffer, turned to face his build. It builds with the builder's move loop
(`checkPlace`, Tripwire), then helps the same kid again only for placements after that build. With no kid building
it idles near spawn, looking around. State `bots/.state/helper/<target>/<world>/<name>.json`; log as the builder's
(`decision` what=help, `project`); e2e leg: `helper`.

```bash
npm --prefix bots run bot -- helper --target local|live --world <uuid|name> --name <n> [--skin <s>] \
	--brain laya|jev [--compare] [--rest-sec N] [--when always|players] [--no-edits] [--i-deployed-the-server]
```

## The architect bot (experiment E6)

`bots/src/architect/`: it designs its own structures. Eight parametric generators (`designs.ts`: castle gate,
lighthouse, pyramid, bridge, giant mushroom, rocket, treehouse on a trunk, pixel-art smiley wall) each offer 3 sizes
and 3 styles; 5 colour themes map roles to real blocks. The model picks the idea, the theme, then the size (options
state the real dimensions; fallback: the smallest) and the style. Every design is validated before it is offered:
≤ 12×12 footprint, ≤ 20 high, ≤ 400 cells, known block names, and every cell reaches the ground through face-adjacent
design cells; that BFS depth is the placement order (supported first). Then the builder's site search, move loop
(`checkPlace`, Tripwire), firework, rest. Builds live in the builder's state dir
(`bots/.state/builder/<target>/<world>/<name>.json`), so the decorator and the other bots see them. `--llm-params`:
Ollama (`llm` in bots.config.ts, llama3.2:3b, JSON schema, temperature 0) proposes the numbers first; clamped to
each range and validated, else the choices (`llm-params` log line). e2e leg: `architect`.

```bash
npm --prefix bots run bot -- architect --target local|live --world <uuid|name> --name <n> [--skin <s>] \
	--brain laya|jev [--compare] [--llm-params] [--rest-sec N] [--when always|players] [--no-edits] [--i-deployed-the-server]
```

## The foreman and `--join-plan` (experiment E7)

`bots/src/foreman/`: one neighbourhood per world, shared through a plan file
`bots/.state/shared/<target>/<world>/plan.json`. The foreman lays it out near the nearest kid (else spawn): 2 rows of
3–5 lots (7×7, room for 16 high; 10, then 8, then 6 lots), 4 columns apart, with a road grid in the gaps (a gravel main
street between the rows, cobblestone cross streets, 1-wide verges) and lamps (oak post + lamp) at every crossing and
at both ends of the main street. Every lot passes brain2's site rules (as the village: flat and natural, headroom,
≥ 12 from kid cells), the whole area stays ≥ 16 from spawn and from every kid standing, and every road column is
natural ground within 3 of the lots. It writes the plan, then builds the roads and the lamps itself (on top of the
ground, only into air, `checkPlace` and a Tripwire), then strolls the streets with no more edits.

Builder and architect bots started with **`--join-plan`** claim the next open lot that fits (an architect design,
or a template, no larger than the lot), re-check only the rules that can change since the plan (their own builds, a
kid standing on it, kid cells within 12; the foreman's roads and lamps are bot cells, and flatness was checked at plan
time), build at the lot's height, and mark it built (dropped, with the reason and a `dropCount`, when that check fails
or the build is abandoned; back to open when a kid stands on it). At start and every 15 min the foreman reopens a
dropped lot whose check passes again, up to 3 drops. With no plan or no open lot they fall back to
their own site search, which (like the village's) now avoids the plan's whole area. Claims are first come, first
served, under a lock (a mkdir'd `plan.json.lock`, broken after 10 s) with atomic writes; a running bot renews its
claim every minute, and a claim not renewed for 15 minutes (a crashed bot) expires. e2e leg: `foreman`.

```bash
npm --prefix bots run bot -- foreman --target local|live --world <uuid|name> --name <n> [--skin <s>] [--when always|players] [--no-edits] [--i-deployed-the-server]
npm --prefix bots run bot -- builder ... --join-plan      # or architect ... --join-plan
```

## The landscaper and the shared board

`bots/src/landscaper/`: makes flat building ground with the game's own toys. It takes an open `flat-needed` post or a
kid's red marker from the board, else picks a hilly 16×16 patch near the foreman's neighbourhood (else spawn); the
model chooses among ≤ 3 candidates. Per Flattening TNT it mines the recipe's raw ingredients into its own inventory
(10 sand, 8 coal, 8 redstone, 16 stone: surface blocks from above, buried ores by brain2's spiral staircase, same
safety), crafts by the Craft tab's recipes (the SDK's `RECIPES`), digs a hole so the TNT sits on natural ground at the
floor level, places it, sends `fx prime`, waits the game's fuse (3 s) and applies the game's own blast cells (the SDK's
`blastCells`) as batched edits (`BotClient.breakMany`) with `fx boom`. A blast removes natural cells only and is
dropped whole when any cell is within 12 of a kid cell, within 24 of a kid, or touches liquid (checked before lighting
and again after the fuse). Blast edits go through a plan-bound budget (exactly the planned cells, else every edit
halts). `--max-blasts N` (default 6, counted across restarts). `--pickaxe <name>` (hand|wood|stone|copper|iron|gold|diamond|emerald, default hand; granted, not crafted): mines with that pickaxe's time, and a multi-block tier (iron and up) also breaks the game's area around each mined cell on the hit face, keeping only cells that pass the mining safety rules on their own and are in reach (one batched edit, counted in the tripwire's plan, all into the inventory; never for the TNT hole). `--grant-ores N`: N of each ore and TNT raw ingredient into the inventory, once per state file (`granted` in it). Done squares are posted `flattened`. e2e leg: `landscaper`.

The board is `bots/.state/shared/<target>/<world>/board.json` (`bots/src/board/`), with the foreman plan's lock and
atomic writes: posts `flat-needed | flattened | build-request | decorate | kid-marker`, open → claimed → done, claims
expire after 15 min. **Kid markers:** a kid stacks exactly 3 wool of one colour: red = flatten here, blue = build a
house here, green = make a garden here. A watching bot posts it once and the nearest one sets off a firework above it.
Marker cells are kid cells: no bot touches them.

```bash
npm --prefix bots run bot -- landscaper --target local|live --world <uuid|name> --name <n> [--brain laya|jev] [--compare] [--max-blasts N] [--pickaxe <name>] [--grant-ores N] [--rest-sec N] [--when always|players] [--no-edits] [--i-deployed-the-server]
```

## The build cap

Builder, architect and helper stop building after `--max-builds N` builds (default 12); the decorator after
`--max-decorations N` (default 40); the village bot builds one village and stops. The count comes from the bot's own
state file (a record counts once it placed a block), so it holds across restarts. A capped bot stays online, logs
`cap-reached` once, and only wanders and looks around near its builds: no edits. Raise the flag (or move the state
file aside) to let it build again.

## Only while a kid plays (`--when`)

Every builder-family bot (builder, decorator, village, helper, architect, foreman) and the brain v2 companion take
`--when always|players` (default `always`). With `players` the bot is active only while at least one non-bot player
is online. When none is, it pauses: it stays connected, ends its current move or build step (a half-built build
resumes later), makes no model call (Laya, Jev) and no edit, and only looks around; brain v2 keeps perceiving, so it
notices the player who joins. It resumes 5 s after a player joins (and pauses 5 s after the last one leaves), and logs
`paused` / `resumed`.

## Shared bot cells

Builder, decorator, village, helper and architect append every cell they place to
`bots/.state/shared/<target>/<world>/bot-cells.jsonl` (`{x,y,z,id,bot,t}`, append-only). A cell whose current block
equals the latest entry's id counts as a bot cell (not a kid's), so one bot does not back off from another's blocks;
a kid's later edit of the cell (a non-bot edit event) still makes it a kid cell.

## The live checklist

Running against the kids' real world is the same command with `--target live`, plus:

1. **Deploy the server first.** An older live server (before this branch merges) ignores the
   `bot` flag entirely: the bot shows up like any other player, can become a spawn target for a
   kid (possibly mid-air or inside stone), and blocks world deletion. Don't point a bot at the
   live server until you've deployed a version that supports bots — see `server/README.md`.
2. **The token.** `--target live` needs one: `MC_LIVE_TOKEN` in the environment, `bots/.env.live`
   (see `.env.example`; never `.env.local`), or — read only at runtime, only for this target —
   `~/minicraft-mp/token`. Tests and agents never read any of these.
3. **The first session against a world uses `--i-deployed-the-server`.** The CLI remembers the
   acknowledgement per world uuid in `bots/.state/live-ack.json`; later runs against the same
   world don't need the flag again. Without it (and without a prior ack), the bot refuses to
   start and explains why (point 1).
4. **Run the first live session with `--no-edits`.** Watch it follow and look before you let it
   place blocks near a real kid.
5. **The stop signal is the kill switch a kid controls himself:** if he breaks a block the bot
   placed, the bot makes no edits within `stopRadius` of him for `stopMs` (10 minutes by default).
   Following and watching continue through a stop. It's logged and shown on the status line
   (below) as `paused near <kid> <N>m`.
6. **`--revert-on-exit` caveats.** It runs the SDK's `revert()` before closing, which keeps the
   SDK's own rule: a cell is restored only while it still holds the bot's block. So a bot block
   the kid later built on top of is pulled out from under that later block, leaving a gap — it's
   for cleaning up a test session, not for tidying after normal play with a kid.
7. **Ctrl-C is the kill switch** for the bot itself, live or local. SIGINT/SIGTERM stop the loop
   cleanly; a second Ctrl-C exits immediately without waiting.

## Rules before the brain

The brain (Laya, or CLM once it's usable here) doesn't decide everything. Two rules run first,
in the loop, before the bot ever asks it — logged as `brain: 'rule'`, with `reason`
`rule:follow-floor` or `rule:help-build`:

- **The follow floor.** When the target kid is out of reach — horizontal distance more than
  `followDist + 3`, or vertical distance more than 1.5 — or he's moving at all, the bot follows
  without asking. The brain only gets a say over a **still kid nearby**: watch, idle, or follow.
- **`help_build`.** When it's offered at all (which already requires the kid to have just placed
  three collinear blocks and be aiming at the next spot), the bot takes it outright. Laya was
  measured picking something else in every one of those cases.

In practice, whenever the brain *is* asked, it mostly answers `watch`. Laya's role today is small:
watch a still, nearby kid, or occasionally `idle`/`wander`. The rules above cover the two things
that actually have to work — following and building — regardless of what the brain says.

## Follow modes

While following, the bot picks one of three modes every tick, without waiting for the brain:

- **walk**, while the target kid is on the ground and within walking reach.
- **fly** (`flyTo`), when the kid is flying, more than 1.5 blocks above the bot or above the bot's
  reachable ground, or a walk just got rejected with `BlockedError`.
- **land**, once the kid has been back on the ground for a moment: the bot flies down near him,
  then walks again.

**Hopping is a last resort.** It never happens before at least 2 blocked flights in a row, and even
then only if the kid is also flying fast or 3 walks have been blocked — never for a kid the bot
could otherwise reach by flying or walking. A hop lands outside every kid's buffer, never in water,
and at most 7.5 blocks away in 3D; at most once per second.

Two things to expect, not bugs: **the bot falls behind a kid flying fast** (10+ blocks/s) and
catches back up once he slows down; and **launch/slime pads can register as "flying" for about a
second**, which may cause one extra hop even though the kid never actually left the ground.

## Reading and replaying the decision log

Every session writes `bots/.state/logs/<target>/<worldUuid>/<name>-<timestamp>.jsonl` — one JSON
line per tick, plus one line per notable event (a stop signal, a target switch, a fallback to the
script). A decision line has, in order: `seed`, `tick`, `t`, `snapshot`, `text`, `candidates`,
`brain` (the brain's name, `scripted`, or `rule`), `raw` (the brain's raw answer or error, `null`
if it wasn't asked), `action`, `reason`, `result`, `latency`.

To look at one session:

```bash
jq -c '{t,action,reason,result}' bots/.state/logs/local/<worldUuid>/<name>-*.jsonl | tail -50
tail -50 bots/.state/logs/local/<worldUuid>/<name>-*.jsonl | jq .
```

To **replay** a specific tick — see exactly what the bot saw and why it chose what it chose — the
line's `snapshot` and `text` are everything the loop had at that moment: `text` is deterministic
from `snapshot` alone (`renderText`, in `bots/src/body/perceive.ts`), and `snapshot` + `candidates`
is everything `question()` (`bots/src/bots/companion.ts`) needs to reconstruct the exact request a
real brain would have seen. There's no separate replay command; pull the `snapshot` out with `jq`
and feed it through `renderText`/`planCandidates`/`question` in a scratch script, or as a fixture
in a test, the way `bots/test/fixtures/laya-exchange.json` and
`bots/test/fixtures/laya-near-band-labels.json` already do.

## Brain v2: the emotional brain

`--brain v2` runs the emotional brain (`bots/src/brain2/`, spec
`docs/superpowers/specs/2026-09-25-bot-brain-design.md`). Until part 2 it uses code engines only
(no Laya, no LLM): every expert runs its code path.

```bash
npm --prefix bots run bot -- companion --target local|live --world <uuid|name> --brain v2 \
	[--personality pip|rex] [--name Pip] [--tui] [--when always|players] [--no-edits] [--revert-on-exit]
```

- **`--personality`** defaults to `pip` (shy, curious builder); `rex` is the bold explorer.
- It runs until SIGINT or SIGTERM (or the server closes the connection), then flushes the brain
  file and exits. Without `--tui` it prints a status line every 30 s.
- **The brain file**, `bots/.state/brain/<target>/<worldUuid>/<name>.json`, keeps inventory,
  builds, digs, `owned`, relations and explored chunks across sessions (written every 5 s).
- **The log**, `bots/.state/logs/<target>/<worldUuid>/<name>-<timestamp>.jsonl` (the newest 20
  files are kept): a `meta` line, the `initial` state, then every state change, every `select`
  (inputs and rows), the model calls and notable events (`plan`, `stop-signal`, `reject`,
  `EDITS-HALTED`, …). Past 50 MB a session continues in `<name>-<timestamp>-2.jsonl`, `-3`, …, each
  headed by the session's `meta` line with `part` and `prev` (the file before it). Replay starts
  from the first file's `initial` state, so replay a continuation only with its earlier parts.
- **`revert`** on a v2 bot also reconciles the brain file with what it undid (inventory, `owned`,
  builds and digs `reverted`). **`revert --builds`** takes the bot's standing builds apart instead
  (each cell still the bot's gets its old block back, one per 600 ms):

```bash
npm --prefix bots run bot -- revert --target <target> --world <uuid|name> --name <bot> [--builds]
```

`revert --builds` can't tell a block the bot placed from the same block a kid put back in that
cell while the bot was offline: the cell holds the bot's block either way. So it leaves alone
every cell within the body buffer of a kid online at that moment (his columns and one around
them), and it writes nothing while an online kid has no position yet. The note says how many
cells it skipped; run it again once he has moved away. Those builds are still marked `reverted`
in the brain file, and their skipped cells stay the bot's until a later run.

### Running it live (overnight)

```bash
npm --prefix bots run bot -- companion --target live --world <uuid|name> --brain v2 --personality pip
```

The live checklist below applies too (the token, `--i-deployed-the-server` once per world).

- **Stopping it.** Press Ctrl-C in its terminal, or `systemctl --user stop minicraft-bot` if you
  run it as that systemd user unit (it sends SIGTERM). Either one stops the loop, flushes the
  brain file and closes the connection. A second Ctrl-C exits at once without the flush. If
  something still keeps the process up 5 s after the clean stop, it exits by itself.
- **Stop the bot before you run `revert`.** A running bot writes its brain file every 5 s, so it
  would overwrite the file that `revert` has just reconciled.
- **Unattended safety.** A stray promise rejection is logged as an `unhandled-rejection` event and
  the bot keeps running. An uncaught exception is logged as `uncaught-exception`, the brain file
  is flushed, and the process exits with code 1. A unit with `Restart=on-failure` restarts it
  then; a clean stop exits 0.
- **Stuck in a hole.** When a climb out of a dig is blocked (for example, a kid filled a step),
  the bot flies to the surface just outside the dig's pillar area. It drops the dig only if that
  flight is blocked too.

### The live view (`--tui`)

`--tui` replaces the status lines with a view redrawn 4 times a second: the header (bot,
personality, world, engine health and latency, the LLM queue, **EDITS HALTED** when set), a bar per
emotion (`|` marks the personality's baseline; the band, the value, the last delta with its cause
and age), the relations, the behaviour (progress, the last results, the memory line), the last
selection's rows by total, the inventory and paused digs, and the newest 8 expert calls.

Keys: **`p`** opens the poke menu (a digit picks an axis, then a digit its value; or a letter
appends an event such as `player-arrived`), **`q`** quits (as Ctrl-C). An axis poke counts as an
appraisal, so it can start a gesture and a selection. **Pokes are refused against a live target.**

### Replay and the per-decision check

```bash
npm run bot:replay -- <log.jsonl>                    # play the session in the same view
npm run bot:replay -- <log.jsonl> --data <file.ts>   # which recorded decisions other weights flip
```

Replay re-applies the log's change lines from its `initial` state, so every state the bot went
through comes back exactly. Keys: **space** pauses, **←/→** step one frame, **`e`** shows the full
prompt and answer of the newest call, **`q`** quits.

`--data` imports the file (tsx runs it) and reads its named exports `EMOTIONAL` and/or `MERGE`,
shaped as in `bots/src/brain2/data/weights.data.ts`; a missing one keeps the committed table. Each
recorded `select` is rescored from its logged inputs under the new tables, and only the decisions
that flip are listed, under the heading **"per-decision check (not a re-simulation)"**: it says how
each recorded decision would have scored, not what the bot would have done next.

**What `--data` can't re-check**, because these change what *happens*, not how one recorded
decision scores (they need a new session):

- the appraisal table (`appraisal.data.ts`) and the salience rules (`salience.data.ts`);
- the style mappings (`style.ts`) and the gestures (`gestures.data.ts`);
- the personality baselines and half-lives (`personalities.data.ts`);
- every threshold in `limits.data.ts`.

## The status line

Printed every `statusEveryMs` (30 s by default) to stdout:

```
Robo: following Noah (fly) | brain laya | fallbacks 0 | edits 3/50 | hops 1 | paused near Noah 9m
```

In order: what the bot is doing and for whom (with the follow mode, and `(switched: <kid> idle
<N>s)` right after a target rotation); the brain in use; how many ticks fell back to the script;
edits used out of the budget; hops so far; then zero or more `paused near <kid> <N>m` entries (one
per kid under an active stop signal); and `SCRIPTED-FALLBACK` if the brain was given up on for the
rest of the session (5 failures in a row).

## Serving several kids: target rotation

The companion serves several kids, one at a time, not all at once. It sticks with its current
target (by name) until that kid has been **idle** — moving under 0.3 b/s and placing or breaking
nothing — for `idleSwitchMs` (30 s by default), *and* another non-bot kid with a pose is online.
Then it switches to the nearest other kid, at any distance, and stays on him for at least
`minTargetMs` (20 s) before it's eligible to switch again — so it never flips back and forth. With
only one kid online, or if every kid is idle, nothing changes; among several idle kids it rotates
round-robin. A switch is logged (`target` event) and shown on the status line.

## The control panel

`npm --prefix bots run panel` (from the worktree root) serves a small local page at
http://127.0.0.1:7777/ (`-- --port N` to change; it refuses any non-loopback `--host`). No auth:
localhost only, and it rejects foreign `Host` headers and non-JSON POSTs.

- **Start** runs `systemd-run --user --unit=mcbot-<slug-of-name> … npm --prefix bots run bot -- <type> …`
  (Restart=on-failure every 60 s, at most 5 starts an hour). Every field is whitelisted server-side
  and the argv is executed without a shell. Bot types the CLI does not offer are hidden; `--when` is
  greyed out until the CLI has it.
- **Stop** runs `systemctl --user stop` + `reset-failed`, and only on `mcbot-*` units or legacy
  `minicraft-*` bot units. `minicraft-server` and `minicraft-tunnel` are refused.
- Clicking an instance shows its status, journal tail, and a summary of its newest log under
  `.state/logs/<target>/<world>/` (the last 2 MB): brain2 behaviour, emotions, relations, inventory,
  selections and events; or builder-family project, placed count, cap, decisions and movement trouble.
- `-- --dry-run` makes Start/Stop print the argv instead of running it (use this for development).

## Adding a bot

Everything companion-specific lives in `bots/src/bots/companion.ts`; the pieces it's built from are
reusable:

- `bots/src/port.ts` — the `Body`/`WorldView` port. A new bot should use this, never the SDK's
  `BotClient`/`BotWorld` directly, so it stays testable against `bots/test/fake-port.ts`.
- `bots/src/brain/brain.ts` — the `Brain` interface (`ask`), if the new bot also wants to consult
  Laya/CLM. `brain/scripted.ts` is a good deterministic fallback/baseline to copy from.
- `bots/src/body/{perceive,candidates,guard,act,stop-signal,log,status}.ts` — perception,
  candidate/guard logic, movement, the stop signal, the decision log and the status line. A new
  bot can reuse as much of this as fits, or write its own equivalents next to it.
- `bots/src/cli.ts` — `parseCommand` only recognises `companion` and `revert` today. A new bot
  needs its own case there (and its own file under `bots/src/bots/`), wired the same way
  `companionCommand` is: build/health-check a brain, resolve the world and name, connect, run a
  loop, log, handle SIGINT/SIGTERM.

Add tests next to the existing ones (`bots/test/*.test.ts` against the fake port; extend
`bots/test/e2e.ts` if the new bot needs end-to-end coverage against a real server).

## Testing

```bash
npm run bots:test                                   # unit tests (builds the SDK first)
cd bots && npx tsc -p tsconfig.json --noEmit && npm run lint
```

The end-to-end suite starts and stops its own local `mcserver` (never the one above, never the
live one) on a free port, with a scripted kid client:

```bash
BOTS_E2E_SCRATCH=<a scratch directory you own> npm run bots:e2e
```

It needs `BOTS_E2E_SCRATCH` — there's no default — for the server build, its temp database and
logs. A Laya leg runs automatically if Laya's health check passes at `127.0.0.1:8000`; otherwise
it prints a clear `SKIP` line rather than failing.
