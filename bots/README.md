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
