# Bot builder's guide

For people and Claude agents who build a new Minicraft bot or change an existing one. Read
[`docs/bots.md`](bots.md) first: it is the system overview (the bot types, the architecture, the board, the safety
rules, the state files, operations). [`bots/README.md`](../bots/README.md) is the runbook (every command and flag).
This guide does not repeat them. It covers how to build: the files to touch, the APIs to call, what the code
guarantees, and what has gone wrong live.

Every path, signature and command below was checked against the code on the `bot-brain` branch. When the code and
this guide disagree, the code wins: fix the guide in the same commit.

## Rules that must never break

1. **Kid safety invariants.** A bot never breaks, replaces or builds on or next to a kid's cell. It never edits inside
   a kid's body columns or the 1-column ring around them. It honours the stop signal (no edit within 16 of a kid who
   broke one of its blocks, for 10 min). Build sites keep 12 blocks from kid cells. Every edit goes through
   `judgeSafety` (directly or through `checkPlace`) and a `Tripwire`. No shortcut, no "just this once".
2. **Never touch the live server from tests or agents.** Never `minicraft-server.leap-forward.ca`, never port 8080
   (`loadConfig` refuses it), never `~/minicraft-mp/` (the live database and `~/minicraft-mp/token`), never the live
   token (`MC_LIVE_TOKEN`, `bots/.env.live`). Tests start their own `mcserver` on a free port. Never SIGKILL the
   live server. Never `pkill` by name: stop only what you started, by its PID or with `fuser -k <port>/tcp` on your
   own port.
3. **Never use a `minicraft-*` unit glob.** It matches `minicraft-server` and `minicraft-tunnel`, the live server.
   Bot units are `mcbot-<slug>`. Address them by exact name or by the `mcbot-*` prefix.
4. **The import boundary.** Files in `bots/src/` import only `minicraft-bot`, `node:*` built-ins and other files in
   `bots/`. Files in `bots/test/` may also import `vitest`. `bots/test/boundary.test.ts` enforces this. Never import
   from the game's `src/`.
5. **No change to game or server behaviour.** A bot needs something from the game? Add a read-only, additive export
   to the SDK (`packages/minicraft-bot/src/index.ts`). It must pass the SDK bundle guard
   (`packages/minicraft-bot/src/guard-plugin.ts`, `ALLOWED_DIRS`/`ALLOWED_FILES`) and `npm run test:bot`. Never
   change `src/` game logic or `server/` for a bot.
6. **Movement is code.** Models answer only small multiple-choice questions. Where to go, what is safe and when to
   stop are code, with a code fallback for every model question.
7. **Style and git.** Indent with tabs (width 4). Stage explicit paths (`git add bots/src/x.ts docs/…`), never
   `git add -A` or `git add .`: review agents and e2e runs leave probe files in the tree.

## Contents

- [Which kind of bot do I build?](#which-kind-of-bot-do-i-build)
- [How do I add a new bot type?](#how-do-i-add-a-new-bot-type)
- [How do I move the bot somewhere?](#how-do-i-move-the-bot-somewhere)
- [How do I place/break blocks safely?](#how-do-i-placebreak-blocks-safely)
- [How do I ask Laya or Jev a question?](#how-do-i-ask-laya-or-jev-a-question)
- [How do bots coordinate?](#how-do-bots-coordinate)
- [How do I find a site or reshape terrain?](#how-do-i-find-a-site-or-reshape-terrain)
- [How do I test on a local server?](#how-do-i-test-on-a-local-server)
- [How do I run it live?](#how-do-i-run-it-live)
- [How do I add it to the panel?](#how-do-i-add-it-to-the-panel)
- [Common failure modes and fixes](#common-failure-modes-and-fixes)

## Which kind of bot do I build?

There are two patterns. Pick one before you write code.

### The builder family (builder, decorator, village, helper, architect, foreman, landscaper)

Every one of these is a single `run<Type>(opts)` function in `bots/src/<type>/<type>.ts` with the same anatomy
(`bots/src/builder/builder.ts` is the reference):

1. **Connect through the CLI.** `bots/src/cli.ts` resolves the world, checks the name, skin and live ack, connects a
   `BotClient`, wraps it in `realPort(client, listing)` (`bots/src/port.ts`) and calls `run<Type>`.
2. **Port.** The bot sees only `Body` (move, look, edit, events) and `WorldView` (read-only world), never
   `BotClient`/`BotWorld`. Tests replace both with `bots/test/fake-port.ts`.
3. **A loop with pacing.** `async function loop()` runs until `stop()`. It sleeps with a waker-aware `sleep` (so
   `stop()` interrupts it), paces edits (the builder: `paceMs`, default 800 ms), and yields to the event loop during
   long searches.
4. **Decisions.** A few small model questions through `makeAsk` (which project, which site, which of ≤ 3 cells),
   each with a code fallback.
5. **Moves.** Every "get to X" through `navigate()` with the body's `StuckWatchdog`; idle moves through `wanderer()`.
6. **Safety-judged edits.** `checkPlace`/`judgeSafety` before each edit, `Tripwire` after it, ownership recorded.
7. **Persistence, log, status line.** A small JSON state file (atomic write), one JSONL log line per event, a status
   line every 30 s.
8. **Caps, `--when`, rest.** The per-hour cap (`shared/cap.ts`), the `PresenceGate` (`shared/when.ts`) and a visible
   rest between jobs.

Use it for a bot with one job that it repeats (build X, decorate Y, level Z), with free blocks (unlimited, placed
with `allowFree`) or an inventory it manages itself (the landscaper).

### The brain2 companion (`companion --brain v2`)

`runBrain2` (`bots/src/brain2/brain.ts`) is one 100 ms beat over a store with emotions and relations, experts on a
scheduler, selection among behaviours, and a runner that judges and executes one `Action` at a time (see
[docs/bots.md, brain2](bots.md#brain2)). A behaviour never calls the body. It implements `Behaviour`
(`bots/src/brain2/behaviours/behaviour.ts`: `plan`, `next` returning an `Action | 'done' | 'paused' | {failed}`,
`plannedEdits`, `owns`, optional `planPatch`/`onResult`/`endPatch`/`inDig`/`recompute`), and the runner does the rest
(safety, the navigator, the watchdog, climbing out of digs).

Use it only to give the companion a new behaviour. Its inventory rules are strict: it places only what it mined
(free blocks only in Help-build). A new behaviour means:

- a new `BehaviourKind` in `bots/src/brain2/types.ts`;
- a file in `bots/src/brain2/behaviours/`, registered in `BEHAVIOURS` (`behaviour.ts`);
- its row in `EMOTIONAL` (`bots/src/brain2/data/weights.data.ts`) and its place in `ORDER` (`selection.ts`).
  `npm --prefix bots run typecheck` lists every `Record<BehaviourKind, …>` you missed.

Weights are tuned with `npm run bot:replay -- <log> --data <file.ts>`. Part 2 (model experts) waits on Julien's
engine decision in `bots/src/brain2/data/engines.data.ts`: do not wire a model into brain2 before then.

## How do I add a new bot type?

The checklist, then the skeletons. `<type>` is the subcommand name (lower case, no spaces), `<Type>` its PascalCase.

### Checklist

- [ ] `bots/src/<type>/<type>.ts`: `run<Type>(opts): <Type>Handle`, `<type>StatePath(…)`, `load<Type>File`,
      `save<Type>File`.
- [ ] `bots/src/cli.ts`:
  - add `'<type>'` to `Command`;
  - add it to `parseCommand`'s `if` **and to its error message** (`expected companion, revert, …`). The panel parses
    that message to learn which types exist;
  - add `<type>Command(cfg, deps)` and its line in `main`;
  - add the test hook `on<Type>?: (h, client) => void` to `CliDeps`.
- [ ] New flags, if any: `bots/src/cli-args.ts` (the `ParsedArgs` field, `ValueFlagKey`/`BooleanFlagKey`,
      `VALUE_FLAGS`/`BOOLEAN_FLAGS`) and `bots/src/config.ts` (the `Config` field, validation in `loadConfig`
      that throws `ConfigError`, the returned object). Tests go in `bots/test/cli-args.test.ts` and
      `bots/test/config.test.ts`. The CLI does not check flags per command: an unused flag is accepted silently.
- [ ] If it places blocks, append them to the shared registry (`SharedCells`, see [edits](#ownership-natural-bot-kid)).
- [ ] A cap (`shared/cap.ts`) and `--when` (`PresenceGate`). A new cap flag also needs the panel's `maxFlag` type.
- [ ] `bots/panel/lib.ts`: its `BOT_TYPES` row ([panel](#how-do-i-add-it-to-the-panel)).
- [ ] A unit test `bots/test/<type>/<type>.test.ts` against the fake port.
- [ ] An e2e leg `bots/test/e2e-<type>.ts`, wired into `bots/test/e2e.ts`.
- [ ] Docs: the type table, the state-file table and the log kinds in `docs/bots.md`; the command list, the flag
      table, a section and the e2e `--only` list in `bots/README.md`.
- [ ] `npm run bots:test`, `cd bots && npx tsc -p tsconfig.json --noEmit && npm run lint`, and your e2e leg.

### Skeleton: `bots/src/<type>/<type>.ts`

This is condensed from `builder.ts`. For the full versions (resume, rest near a build, cap wander), copy the real
file.

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { blockId } from 'minicraft-bot';
import { StopSignal } from '../body/stop-signal.js';
import type { Body, WorldView } from '../port.js';
import type { Vec3 } from '../types.js';
import { Ownership } from '../brain2/ownership.js';
import { Tripwire, type KidPos } from '../brain2/safety.js';
import { LIMITS } from '../brain2/data/limits.data.js';
import { checkPlace, eyeDist, makeAsk, PLACE_MAX } from '../builder/builder.js';
import type { ChoiceEngine } from '../builder/engines.js';
import { navigate, StuckWatchdog } from '../nav/navigate.js';
import { pickWanderSpot, wanderer } from '../nav/wander.js';
import type { SharedCells } from '../shared/bot-cells.js';
import { capReached } from '../shared/cap.js';
import { idlePaused, PresenceGate, type WhenMode } from '../shared/when.js';

export interface MyJob { t: number; status: 'building' | 'done' | 'abandoned'; placed: string[]; lot?: string }
export interface MyFile { v: 1; jobs: MyJob[]; owned: Record<string, number> }

export function myStatePath(stateRoot: string, target: string, world: string, name: string): string {
	return join(stateRoot, 'mytype', target, world, `${name}.json`);
}
export function loadMyFile(path: string): MyFile {
	try {
		const f = JSON.parse(readFileSync(path, 'utf8')) as MyFile;
		if (f && f.v === 1 && Array.isArray(f.jobs) && f.owned) return f;
	} catch {
		// missing or unreadable: a fresh file
	}
	return { v: 1, jobs: [], owned: {} };
}
/** Atomic: a temp file beside it, then rename. */
export function saveMyFile(path: string, f: MyFile): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(f));
	renameSync(tmp, path);
}

export interface MyOpts {
	name: string; body: Body; world: WorldView; spawn: Vec3;
	primary: ChoiceEngine | null; secondary?: ChoiceEngine | null;
	noEdits: boolean; statePath: string; log: (o: Record<string, unknown>) => void; status?: (line: string) => void;
	rng: () => number; clock?: () => number; when?: WhenMode; maxJobs?: number; shared?: SharedCells | null;
}
export interface MyHandle { stop(): Promise<void>; stats: { placed: number; current: string; asks: number; fallbacks: number }; file: MyFile; done: Promise<void> }

export function runMyType(o: MyOpts): MyHandle {
	const clock = o.clock ?? (() => Date.now());
	StuckWatchdog.for(o.body, o.world).log = (e) => o.log({ ...e, t: clock() });   // unstick lines into this log
	const wand = wanderer(o.body, o.world, { rng: o.rng, clock, log: o.log });
	const gate = new PresenceGate({ mode: o.when ?? 'always', players: () => o.body.players(), clock, log: (e) => o.log({ ...e, t: clock() }) });
	const file = loadMyFile(o.statePath);
	const own = new Ownership(o.world, () => file.owned, o.shared ? () => o.shared!.cells() : undefined);
	const stop = new StopSignal(LIMITS.STOP_SIGNAL_MS);
	const trip = new Tripwire();
	const stats = { placed: 0, current: 'starting', asks: 0, fallbacks: 0 };
	const save = () => saveMyFile(o.statePath, file);
	let stopped = false;
	let lastEditT: number | null = null;
	const wakers = new Set<() => void>();
	const sleep = (ms: number) => new Promise<void>((res) => {
		if (stopped) return res();
		const done = () => { clearTimeout(t); wakers.delete(done); res(); };
		const t = setTimeout(done, ms);
		wakers.add(done);
	});

	const unsubs = [
		o.body.onEdit((e) => {
			const who = stop.onEdit(e, o.body.journal(), clock());
			if (who) o.log({ k: 'stop-signal', kid: who, t: clock() });
			for (const op of own.onEdit(e, o.body.you)) if (op.value === undefined) delete file.owned[op.path[1] as string];
		}),
		o.body.onReconnect(() => own.reset()),
	];
	const kidsNow = (): KidPos[] => o.body.players().filter((p) => !p.bot && p.hasPos).map((p) => ({ name: p.name, x: p.x, y: p.y, z: p.z }));
	const ask = makeAsk({ primary: o.primary, secondary: o.secondary, clock, log: o.log, stats, paused: () => gate.paused() });

	/** One placement: judged, placed only within reach, recorded. */
	async function placeOne(cell: Vec3, block: string): Promise<boolean> {
		const v = checkPlace(cell, block, { world: o.world, own, kids: kidsNow(), stop, now: clock(), lastEditT, noEdits: o.noEdits, halted: trip.halted, self: o.body.pose() });
		if (!v.ok) {
			o.log({ k: 'refused', t: clock(), cell, reason: v.reason });
			return false;
		}
		if (eyeDist(o.body.pose(), cell) > PLACE_MAX) return false;   // never place from afar: navigate first
		const ok = await o.body.place(cell.x, cell.y, cell.z, block).catch(() => false);
		lastEditT = clock();
		trip.recordEdit(cell, lastEditT);
		const id = blockId(block);
		if (ok && id !== null) {
			file.owned[`${cell.x},${cell.y},${cell.z}`] = id;
			own.ownWrite(cell.x, cell.y, cell.z, id);
			o.shared?.append(cell, id);
			stats.placed++;
		}
		o.log({ k: 'place', t: lastEditT, cell, block, ok });
		save();
		return ok;
	}

	async function loop(): Promise<void> {
		while (!stopped) {
			try {
				if (trip.halted) { stats.current = `EDITS HALTED (${trip.halted})`; await sleep(5000); continue; }
				if (gate.paused()) { stats.current = 'paused: no player online'; await idlePaused(o.body, sleep, o.rng); continue; }
				if (capReached(file.jobs, o.maxJobs ?? 10, clock())) {
					o.log({ k: 'cap-reached', t: clock() });
					await wand.go(pickWanderSpot(o.world, o.body.pose(), o.rng), () => !stopped && !gate.paused());
					await sleep(10_000);
					continue;
				}
				// 1. decide (ask + fallback)  2. navigate(…, { watchdog })  3. trip.resetPlan(n)  4. placeOne(…) per cell, sleep(pace)
				await sleep(800);
			} catch (err) {
				o.log({ k: 'error', t: clock(), err: err instanceof Error ? (err.stack ?? err.message) : String(err) });
				await sleep(5000);
			}
		}
	}

	const statusTimer = o.status ? setInterval(() => o.status!(`${o.name}: ${stats.current} | placed ${stats.placed}${trip.halted ? ' | EDITS HALTED' : ''}`), 30_000) : null;
	o.log({ k: 'start', t: clock(), name: o.name, primary: o.primary?.name ?? null, noEdits: o.noEdits });
	const done = loop();
	return {
		stats, file, done,
		async stop() {
			stopped = true;
			for (const w of [...wakers]) w();
			if (statusTimer) clearInterval(statusTimer);
			await done;
			for (const u of unsubs) u();
			if (existsSync(dirname(o.statePath)) || file.jobs.length) save();
			o.log({ k: 'stop', t: clock(), stats });
		},
	};
}
```

Building a template? Do not write your own move loop. Reuse `constructBuild(b, ctx)` (`builder.ts`: the model picks
among ≤ 3 supported cells, `approach()` gets within `PLACE_MAX`, `checkPlace` judges, a firework on finish). The
village bot and the architect reuse it this way.

### Skeleton: the CLI command

Model it on `foremanCommand` (no engines) or `builderCommand` (engines). Both are in `bots/src/cli.ts`. Condensed:

```ts
async function myTypeCommand(cfg: Config, deps: CliDeps): Promise<void> {
	if (cfg.brain !== 'laya' && cfg.brain !== 'jev') throw new ConfigError(`mytype: --brain must be laya or jev, not "${cfg.brain}"`);
	const fetchImpl = deps.fetchImpl ?? fetch;
	const laya = (): ChoiceEngine => layaEngine(cfg.brains.laya.url, fetchImpl, cfg.brains.laya.timeoutMs);
	const jev = (): ChoiceEngine | null => {
		const key = JEV_ENV_FILES.map((f) => parseJevKey(deps.readFile(f))).find((k) => k) ?? null;
		if (!key) deps.print(`jev: no JEV_API_KEY in ${JEV_ENV_FILES.join(' or ')}; jev questions fall back`);
		return key ? jevEngine(key, fetchImpl) : null;
	};
	const primary = cfg.brain === 'jev' ? jev() : laya();
	const secondary = cfg.compare ? (cfg.brain === 'jev' ? laya() : jev()) : null;
	const prepared = await prepare(cfg, deps);          // null: it listed the worlds
	if (!prepared) return;
	const client = await connect(cfg, prepared.listing, prepared.skin, deps);
	const port = realPort(client, prepared.listing);
	const uuid = prepared.listing.uuid;
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const logPath = resolve(deps.stateRoot, 'logs', cfg.target.name, uuid, `${cfg.name}-${stamp}.jsonl`);
	mkdirSync(dirname(logPath), { recursive: true });
	const statePath = myStatePath(deps.stateRoot, cfg.target.name, uuid, cfg.name);
	const sp = worldSpawn(client.world.seed, client.world.gen);
	const handle = runMyType({
		when: cfg.when, name: cfg.name, body: port.body, world: port.world, spawn: { x: sp.x, y: 0, z: sp.z },
		primary, secondary, noEdits: cfg.noEdits, statePath, rng: seededRng((Date.now() ^ (process.pid << 16)) >>> 0),
		shared: new SharedCells(sharedCellsPath(deps.stateRoot, cfg.target.name, uuid), cfg.name),
		log: (o) => { try { appendFileSync(logPath, `${JSON.stringify(o)}\n`); } catch { /* a full disk must not stop the bot */ } },
		status: (line) => deps.print(`[${new Date().toISOString()}] ${line}`),
	});
	deps.onMyType?.(handle, client);
	if (deps.onMyType) return;                          // the e2e drives and stops it itself
	// then, copied verbatim from foremanCommand: installCrashGuards({ event, flush: () => saveMyFile(statePath, handle.file), print }),
	// SIGINT/SIGTERM → Promise.race([handle.stop(), 5 s]) → client.close() → armHardExit(); client.on('close') → exit 0 on 1000, else 1.
}
```

The crash guards (`bots/src/brain2/guards.ts`) log `unhandled-rejection` and keep running. On an uncaught exception
they log `uncaught-exception`, flush the state file and exit 1. systemd's `Restart=on-failure` then restarts the
unit.

### Logging conventions

- One JSON object per line, `{ k: '<kind>', t: <ms>, … }`, appended to
  `bots/.state/logs/<target>/<world>/<name>-<stamp>.jsonl`. A failed append is swallowed.
- Use the existing kinds when they mean the same thing: the panel's log summary reads them. It reads `start`,
  `project`/`lot`/`village`/`plan`/`decoration` (the current job), `place` with `ok: true`,
  `build-end`/`decoration-end`, `cap-reached`, `decision`, `stop`, and any kind matching `/fly|stuck|unstick|unreachable/`
  as movement trouble (`bots/panel/lib.ts`, `summarizeBuilder`).
- Shared components log their own kinds: `decision` (`makeAsk`), `unstick` (watchdog), `walk-fly`/`fly-high`
  (navigator), `wander-fail`/`wander-still` (wanderer), `paused`/`resumed` (`PresenceGate`), `lag` (`LagMonitor`),
  `search-failed` (yours, with `search.rejections`).
- A halted tripwire logs `EDITS-HALTED` once. Errors caught in the loop log `error` with the stack.
- The status line goes to stdout (the unit's journal), every 30 s:
  `<name>: <what it is doing> | <counters> | engine <e> (fallbacks f/asks)[ | paused near <kid> <m>m][ | EDITS HALTED]`.

### Caps and `--when`

- `capReached(records, max, now)` counts records with a `t` whose `status === 'done'` or that placed something, and
  that are not on a plan lot (`countsTowardCap`), within a rolling hour. Records must carry `status`, `placed` and `t`.
  Use `capMsUntilSlot` + `minutesUntilSlot` for the status line. For events rather than records (blasts), use
  `windowReached(times, now, max)` as the landscaper does.
- `PresenceGate.paused()` must be called often: that call is what notices players joining and leaving (5 s
  debounce). While paused: no model call (pass `paused` to `makeAsk`), no edit, `idlePaused()` only. Finish a step
  that cannot be left half-done (a lit fuse always burns).

## How do I move the bot somewhere?

Use `navigate` from `bots/src/nav/navigate.ts`. Nothing else.

```ts
navigate(body: Body, world: WorldView, to: { x: number; y?: number; z: number }, o?: NavOpts): Promise<NavResult>
// NavOpts: { speed?, alive?: () => boolean, maxReissue? (default 3), log?, watchdog?: StuckWatchdog }
// NavResult: { ok: true; via: 'walk' | 'fly-high' } | { ok: false; reason: string }

const r = await navigate(o.body, o.world, { x, y: cellY, z }, { watchdog: StuckWatchdog.for(o.body, o.world), log: o.log, alive: () => !stopped });
if (!r.ok) { o.log({ k: 'nav-failed', to: { x, z }, why: r.reason }); if (r.reason.startsWith('stuck')) /* drop this action */; }
```

What it guarantees:

- It never throws. It tries `walkOrFly` first: a straight walk, and when blocked at a wall or cliff, a flight to the
  same column, landing on top of every column under the body. When the route is higher than flyTo's 16-block climb,
  it lifts straight up first. Blocked again, it uses `flyHigh`: sideways to open sky (within 6, widened to 16),
  up in ≤ 15-block hops, across at the route's top + 3, then down.
- Give `y` when the target is a cell (a build site). A target under a roof or an overhang then lands on the nearest
  standable open-sky column within 4, at ±2 of that height (`landingFor`).
- A leg that ends `'cancelled'` is reissued up to 3 times while `alive()` holds.
- With `watchdog`, the goal is registered, and `guard()` runs first. If the bot has moved less than 0.5 in 15 s
  toward a goal, one escalation level runs: (1) fly high, (2) along air cells to open sky within 8, then up,
  (3) a teleport up to the column's top + 2. After level 3 the result is `{ ok: false, reason: 'stuck (abandoned by
  the watchdog)' }`: drop the action and pick a new goal.

The `StuckWatchdog` API is `StuckWatchdog.for(body, world)` (one per body, shared by everything on it), then
`want(goal)`, `reached()`, `clear()`, `guard(alive?)` and `due()`. Set `.log` once at startup so its `unstick` lines
reach your log. Call `wd.reached()` when you arrive by other means (`approach()` does), and `wd.clear()` while the
bot is busy with a non-movement step, so a long placement is not taken for being stuck.

Idle movement (rests, a capped bot, strolls) uses `wanderer(body, world, { rng, clock, log })`, then
`.go(spot, alive)` with `spot = pickWanderSpot(world, centre, rng, minR = 2, maxR = 12)`. It targets standable
open-sky cells only (never liquid) and gives up on a step after 20 s. After 2 failures in a row it stands still and
looks around for 60 s. When submerged (in water or under an ice sheet), it escapes to dry open sky within 16 first,
else teleports up onto the ice.

`flyLeg(body, to, { alive })` (one flight, reissued on cancel) and `ascend(body, y)` (≤ 15-block hops) are for short,
deliberate vertical moves: stepping out of a blast zone, rising to a build layer. `builder.ts`'s `approach()` shows
the pattern: `flyLeg` to a stand spot in the air, `navigate` on the ground.

### SDK motion facts (`packages/minicraft-bot/src/bot-client.ts`)

- `walkTo({x, z}, {speed?})` walks a **2D straight line**. It is not pathfinding: it checks only the centre column
  and can clip wall corners. It steps up at most 1 block, drops at most 2 per step, and rejects `BlockedError` at a
  wall or cliff. It resolves `'arrived'` within 0.3. `speed` must be in (0, 1], else it throws a `RangeError`.
- `flyTo({x, y, z})` flies a straight 3D line and never enters a solid block. It climbs at most **16** above its
  start y. It rejects `BlockedError{wall}` under a ceiling, in an enclosure, at a wall over 16 high, or when straight
  above or below a target under a roof. It rejects `BlockedError{noGround}` for a target outside the world.
- `move(pose)` is a **teleport**: it sets the pose at once and cancels any walk or flight. A jump over 8 blocks snaps
  on the kids' screens.
- `walkTo` and `flyTo` share one movement slot. A new `walkTo`/`flyTo`, a `move`, a lost connection or `close()`
  resolves the pending one `'cancelled'` (never a rejection). `lookAt` and `mine` do not cancel it.
- Recognise blocks with `isBlocked(err)` (`bots/src/body/act.ts`). Across the package boundary, `instanceof` alone
  can miss.

### What NOT to do

- Do not call `body.walkTo`/`flyTo` for "get to X". The documented exceptions are brain2's dig step columns
  (`walkOrFly(…, { mayFly: false })`), companion v1's follow controller (`body/act.ts`), a short `flyLeg`/`ascend`
  as above, and the landscaper's hole digging and fuse retreat.
- Do not call `body.move` except as the watchdog's or wanderer's last resort. A teleport is visible and can land in
  a kid's view.
- Do not wait for a walk that never ends: pass `alive`, or race it against a timer as the wanderer does.
- Do not hover. Land before idling (the landscaper's `land()`: `landingFor` + `flyLeg`).

## How do I place/break blocks safely?

### Ownership: natural, bot, kid

`new Ownership(world, () => file.owned, shared ? () => shared.cells() : undefined)`
(`bots/src/brain2/ownership.ts`). `classify(x, y, z)` decides by the current block and the last writer, never by
coordinates:

- `'bot'`: the cell holds the id this bot recorded in `owned`, or the id another bot recorded in the shared registry
  (unless a kid edited the cell since this process started watching);
- `'kid'`: any other edited cell (`world.isEdited`);
- `'natural'`: as generated.

Keep it true. Feed every edit to `own.onEdit(e, body.you)` and delete the `owned` keys it drops. Call
`own.ownWrite(x, y, z, id)` plus `file.owned[key] = id` after your own write, and `own.reset()` on reconnect. Also
use `kidCellWithin(x, z, r)` and `kidNeighbour(x, y, z, radius, airOnly?)`.

**The shared registry.** `new SharedCells(sharedCellsPath(stateRoot, target, world), name)`
(`bots/src/shared/bot-cells.ts`). Call `append(cell, id)` after each write, or `appendMany(cells, id)` for a batch
(id 0 for removals). Without it, other bots take your blocks for a kid's and back off from them.

### The verdict: `judgeSafety` and `checkPlace`

`judgeSafety(action, ctx): Verdict` (`bots/src/brain2/safety.ts`) is the hard veto. `Verdict` is `{ ok: true }` or
`{ ok: false, tier: 'safety', reason, planVeto }`. Refusals, in order:

- `edits halted: …` and `--no-edits`;
- `edit gap`: under 600 ms since `lastEditT`. Retry after ~150 ms, as `mineCell` does;
- `not in the plan` (`planOwns`);
- `kid body buffer` (`forbiddenByKids`);
- `stop signal: <kid>` within 16 of him;
- place: `cell not air`, `kid cell buffer` (a kid cell there or adjacent), `nothing to place` (inventory), and
  `free blocks are Help-build only` unless `allowFree: true`;
- break or mine: `kid cell buffer` (a kid cell, an adjacent one, or a kid air cell within 2), `touches liquid`.

`judgeSafety` does **not** require a broken cell to be natural. Mining code checks
`own.classify(x, y, z) === 'natural'` itself (`gather.ts` `mineCell`, `areaExtras`, the blast filter). Do the same
unless you mean to take down your own blocks.

`checkPlace(cell, block, { world, own, kids, stop, now, lastEditT, noEdits, halted, self? })` (`builder.ts`) is
`judgeSafety` for a free place with `allowFree`, plus a refusal for the bot's own body (`own body`). Builder-family
placements use it. An inventory placement calls `judgeSafety({ kind: 'place', cell, block }, { …, inventory })`
without `free`, as the landscaper's `placeToy` does.

Also: place only after `approach()`/`navigate` has put the eye within `PLACE_MAX` (5) of the cell (`eyeDist`). The
SDK does not check reach. The SDK's own last line: `place` resolves false for an unknown or retired name, air,
bedrock or a cell inside a kid's body.

### The tripwire and the stop signal

- `const trip = new Tripwire()`. Call `trip.resetPlan(plannedEdits)` before each plan, then
  `trip.recordEdit(cell, now)` after every single edit, whether it succeeded or not. Call
  `trip.recordBatch(cells, now)` after a batched edit: it counts as one edit for the rate, churn is per cell, and the
  cells are added to the plan. `trip.halted` (a reason, or null) stops every edit for the session. It trips at over
  1.2× the maximum rate (more than 120 edits in 60 s), 3 edits of one cell in 10 min, or more than 110% of the plan. Before the
  first `resetPlan` the plan is infinite: always call it.
- The landscaper's blasts use a stricter plan-bound budget, `BlastBudget` (`landscaper.ts`): `plan(cells)`, then
  `spend(removed)`. Any cell not planned halts the session.
- `const stop = new StopSignal(LIMITS.STOP_SIGNAL_MS)`. Feed `stop.onEdit(e, body.journal(), now)` on every edit (it
  returns the kid's name when a stop starts) and pass `stop` into every verdict. Use `stop.active(now)` on the status
  line.

### Batched edits and mining

- `body.mine(x, y, z)` (the Port) mines with the hand's time. The landscaper needs a pickaxe and batches, so its CLI
  command injects `client.mine(x, y, z, ms, { tier, face })` and `client.breakMany(cells)` from the `BotClient` as
  options (`LandscaperOpts.mine`, `.breakMany`). The Port does not expose them. Follow the same pattern: inject from
  `cli.ts`, never import `BotClient` in a bot.
- `breakMany(cells: Array<{x, y, z, expect?}>)` waits the edit gap once, then breaks every cell that still holds
  `expect` in one batch. It skips air, liquid, bedrock, cells in a kid's body and changed cells, and resolves the
  cells actually broken. Always pass `expect`, and account for the returned cells, not the requested ones.
- A multi-block pickaxe's area: `areaCells(target, face, tier)` from the SDK, each cell filtered on its own
  (`areaExtras` in `gather.ts`), then `breakMany` + `trip.recordBatch`.

### Inventory and block names

- `WORLDGEN_BLOCKS` are the blocks the generator places: the only ones a bot may mine into an inventory.
- `CRAFTED_ONLY` blocks (`flatten_tnt`, `tunnel_tnt`, `big_tnt`, …) are never mined and never granted. brain2 never
  holds one. The landscaper holds a `flatten_tnt` only by crafting it through `craft.ts` with the game's `RECIPES`.
- Builder-family palettes (`builder/palettes.data.ts`, `decorator/decor.ts`, `village/themes.data.ts`) use real
  catalog names only: never a liquid, a `CRAFTED_ONLY` block, TNT or anything that falls. Validate names against
  `new Set(blockNames())` at startup (the CLI passes it as `known`) and in a unit test.
- `blockId(name)` returns null for an unknown name: check it before recording ownership.

## How do I ask Laya or Jev a question?

### Engines

`bots/src/builder/engines.ts`:

```ts
interface ChoiceEngine { readonly name: string; choose(state: string, instructions: string, options: Record<string, string>): Promise<{ choice: string; probs: Record<string, number> }> }
layaEngine(url, fetchImpl = fetch, timeoutMs = 400)            // POST <url>/v1/systemone
jevEngine(key, fetchImpl = fetch, timeoutMs = 3000)            // POST https://api.typesafe.ai/v1/systemone, Bearer key
parseJevKey(envText): string | null                            // JEV_API_KEY from a .env text
```

- **Laya** is local (`bots.config.ts` `brains.laya`: `http://127.0.0.1:8000`, timeout 400 ms), running as the user
  unit `laya` with `LAYA_MODELS=english`.
- **Jev** is hosted. `jevBody()` sends the SystemOne shape plus `model: 'jev-latest'` (`JEV_MODEL`). The key is
  `JEV_API_KEY`, read at runtime from the checkout's `.env`, else `~/Projects/Minicraft/.env` (`JEV_ENV_FILES` in
  `cli.ts`). Never log it, print it or put it in an error.
- An answer that is not one of the offered keys throws, which counts as a failure.
- `--compare` asks the other engine in parallel. Both answers and `agree` go into the `decision` line, and the bot
  acts on the primary.

### Asking

Use `makeAsk` (`builder.ts`). Do not call `choose` directly.

```ts
const ask = makeAsk({ primary, secondary, clock, log, stats /* {asks, fallbacks} */, paused: () => gate.paused() });
const picked = await ask('project', state, 'Pick the build a 7-year-old would be most delighted to find next to him.', {
	'house-small': 'a small little house with a door and windows (58 blocks)',
	'tower-small': 'a small tall lookout tower with a door (40 blocks)',
});
const t = pool.find((x) => opt(x) === picked) ?? weightedFallback();   // null = fall back, always
```

`ask` returns the primary's choice or `null`. It returns null when paused, when the engine fails or times out, or
when the engine is resting: after 3 failures in a row it is skipped for 60 s. Every call logs a `decision` line with
`what`, `state`, `instructions`, `options`, `primary {engine, choice, probs, ms}` or `{error}`, `fallback`, and with
`--compare`, `secondary` and `agree`.

### Rules for a question

- **Short, one question.** The SystemOne wire carries exactly one choice question (`next`). Keep the whole request
  (state, instructions and options) to about 60 words. That is the brain2 spec's budget for anything Laya may answer
  (`promptBudgetWords`), and Jev's social state is held to it too (`experts/jev-select.ts`). Use 2–3 options, each
  a few concrete words.
- **Only names the question is about.** No other player's name in the state.
- **A code fallback is mandatory.** Every question must have a deterministic answer when `ask` returns null: the
  heuristic pick, the weighted random, the first candidate. The e2e legs run with every engine failing and must
  still finish.
- **Never a safety or movement question.** A model picks among options that are already safe.
- **Latency.** Laya answers in 400 ms or the call is dropped (the first call after startup is slower, about
  280 ms). Jev takes up to 3 s. Do not ask inside a hot loop: ask once per job and per small choice. brain2's lanes
  time out at 400 ms (laya) and 5000 ms (llm) (`TIMEOUT_MS` in `experts/expert.ts`).
- **Cost.** Jev is paid. One night of every live bot cost about $0.37. A new per-tick question would multiply that.
  Ask per decision, not per tick.

### Measuring a new question (`bots/bench`)

`npm run bot:bench` (from the repo root) runs the labelled cases in `bots/bench/cases/*.json` against Laya and
Ollama, and writes `bots/bench/results/<date>-<model>.txt`: accuracy, recall per class, confusion and p50/p95. The
benchmark is not generic. To measure a new question:

1. add a cases file;
2. add a prompt builder next to `fitPrompt`/`socialPrompt` in `bots/bench/prompts.ts`;
3. add a section in `bots/bench/bench.ts`'s `main` that asks each engine and calls `summarize(name, classes, rows)`;
4. keep a control (like `always-stay`) that must fail, or the instrument proves nothing;
5. `bots/test/brain2/bench-cases.test.ts` checks the case files' shape.

Jev is not in the benchmark. To compare Laya and Jev on a live question, run the bot with `--compare` and read the
`decision` lines' `agree`.

## How do bots coordinate?

Through files under `bots/.state/shared/<target>/<world>/`, never through sockets or chat.

### The board: `board.json` (`bots/src/board/board.ts`)

```ts
boardPath(stateRoot, target, world)
post(path, p: NewPost, now) → { post, added }                  // with p.key: deduped, returns the existing post
claimNext(path, type, bot, now, filter?, claimMs = 15 min) → Post | null   // its own held post first (a restart resumes it)
renew(path, id, bot, now) → boolean                             // call while working; false = not yours any more
complete(path, id, bot, now, { status?: 'done' | 'open', note? }) → boolean   // 'open' = gave up, back on the board
list(path, { type?, status? }) → Post[]
sight(path, id, bot, dist); fireworkTurn(path, id, bot) → boolean         // kid-marker acknowledgement
```

- `PostType`: `'flat-needed' | 'flattened' | 'build-request' | 'decorate' | 'kid-marker'`. `Post` fields: `region`
  (`{x0, z0, x1, z1, y?}`), `center`, `size`, `floor`, `requester`, `note`, `key`, `marker`.
- A post goes open → claimed → done. A claim not renewed for `BOARD_CLAIM_MS` (15 min) is claimable again.
- Every read-modify-write runs under the plan's lock (`withPlanLock`: a `mkdir`'d `<file>.lock`, broken after 10 s,
  given up after 5 s with a thrown `plan lock busy`), with atomic writes. Wrap board calls in `try/catch` and log
  `board-error`.
- `withPlanLock` busy-waits synchronously (`Atomics.wait`). Keep the work inside it tiny.

### The plan: `plan.json` (`bots/src/foreman/plan-file.ts`, `join.ts`)

- One neighbourhood per world: `lots` (`origin`, `w`, `d`, `h`, `status` open → claimed → built, or dropped with
  `why` and `dropCount`), plus `roads` and `lamps`.
- Builders started with `--join-plan` call `claimLot(path, bot, now, fits)` and check the lot again with
  `lotSite(lot, {w, d, h}, ctx)`. That re-check covers only what can change: the builder's own builds, kids standing
  there (`kid-position` puts the lot back to open) and kid cells within 12 (`kid-cells` drops it).
- While building, `renewClaim(path, lot, bot, clock, log)` renews every minute (stop it after), then
  `endLot(path, lot, bot, now, status, why, log)` marks it built or dropped.
- `planAvoidBoxes(path)` keeps your own site search off the plan's area.
- The foreman reopens dropped lots every 15 min with `reopenDroppedLots`, at most `MAX_DROPS` (3) times. It replaces
  the plan with `replacePlan` (archiving `plan-<ts>.json`).
- Lot builds do not count toward caps.

### Kid wool markers (`bots/src/board/markers.ts`)

3 wool of one colour stacked by a kid means something: red = `flatten`, blue = `house`, green = `garden`. Watch
with `new MarkerWatcher({ name, body, world, boardPath, isKid: (x, y, z) => own.classify(x, y, z) === 'kid', log,
active, onPost? })`, `watcher.scan(centre, r)` at startup, and `watcher.stop()`. It posts one `kid-marker` per marker
(keyed by colour and base) and the nearest watching bot sets off the firework. The marker's cells are kid cells:
never touch them. Today only the landscaper watches, and only red markers are acted on. Blue and green are free for
a new bot to claim with `claimNext(board, 'kid-marker', name, now, (p) => p.marker === 'house')`.

### Worked example: Boss ⇄ Digger Dan ⇄ builders

1. **Boss (foreman)** lays `plan.json` with `createPlan` and builds the roads and lamps.
2. **Milo/Snaky (`builder --join-plan`)** `claimLot` → `lotSite` → `constructBuild` → `endLot`. When no lot is
   left, they fall back to their own `SiteSearch`.
3. **Boss** has no live lot (`liveLots`) and no viable plan, so it posts `flat-needed` (24 × 24 near spawn, one at a
   time, again 30 min after the last one ended).
4. **Digger Dan (landscaper)** runs `claimNext(board, 'flat-needed', …)` (else a red `kid-marker`), searches for
   candidates of that size, blasts, and on finishing posts `flattened` with `region`, `floor` and `requester: Boss`.
   Then it runs `complete()` on the request. When no area qualifies, it runs `complete(…, { note: 'no safe area to
   flatten near it' })`.
5. **Boss** runs `claimNext(board, 'flattened', …)` (its own answer first), `layoutOnRegion`, then `replacePlan`, and
   closes its `flat-needed` posts. When the area is too small, the post goes back to open (or is closed if Boss asked
   for it).
6. **The builders** pick up the new lots.

To join this flow with a new bot, claim a post type nobody takes yet (`build-request`, `decorate`, blue or green
markers). Post answers keyed with `key` so a restart does not post twice.

## How do I find a site or reshape terrain?

### Build sites: `bots/src/brain2/behaviours/site-search.ts`

```ts
const search = new SiteSearch({ w, d, h, anchor, avoid: [...ownBoxes, ...planAvoidBoxes(planPath)], showtime: showtimeOf(body) },
	{ world, own, spawn, kids: kidsNow() });
for (;;) {
	const r = search.step();            // one chunk per call
	if (r === 'none') { log({ k: 'search-failed', t: clock(), anchor, rejections: search.rejections }); break; }
	if (r) { /* r: Site { origin, groundY, digs, fills } */ break; }
	await new Promise((res) => setImmediate(res));   // yield: never run the whole search synchronously
}
```

- The rules per origin (`siteOrReject`) reject with `spawn` (within 16 of spawn), `leash`, `builds`, `kid-position`,
  `not-flat` (the grown footprint must be within median ±1), `not-natural`, `liquid`, `headroom` and `kid-cells`
  (within 12 + half the footprint). Surfaces look through leaves and logs.
- `evaluateSite(x, z, q, ctx, top?)` judges one origin (null when refused): use it in tests.
- The radius widens over `LIMITS.LEASH_STEPS` = `[32, 64, 96]`. `search.rejections` holds one
  `{ radius, counts }` per radius that found nothing, and `search.radius` is the current radius.
- **Showtime** (`nav/showtime.ts`): with `showtime: showtimeOf(body)`, a site 15–30 from the nearest kid within ±70°
  of his facing wins over the plain best. It is only a preference.
- Column helpers: `groundTop(world, x, z)` (topmost solid ground, looking through leaves and logs: the ground to
  build on), `topSolid(world, x, z)` (topmost solid of any kind), `bodyTop(world, x, z)` (the highest top under the
  body's box: where a flight lands), `routeTop(world, a, b)`. `world.groundY(x, z, nearY)` is the SDK's "first
  standable cell at or below nearY + 2, scanning 64 down": it can land in a cave, so do not use it to find the
  surface from high above.
- Neighbourhoods: `NeighbourhoodSearch`, `evaluateNeighbourhood` and `layoutOnRegion` in `foreman/layout.ts` (lots
  of 7 × 7, gap 4, 2 rows).

### What to build

- Templates: `TEMPLATES` / `templateOf(name, 'small' | 'medium')` (`brain2/behaviours/templates.data.ts`): house,
  tower, wall, creeper, person, heart. Roles are `wall`/`roof`/`floor`/`accent`, and `D` door gaps are never placed.
  `planCells(t, origin, palette)` turns one into cells (`builder/moves.ts`). `palettesFor(template)` gives the
  allowed palettes (`builder/palettes.data.ts`).
- Parametric designs: `IDEAS`, `THEMES`, `presetParams`, `clampParams` and `makeDesign(idea, theme, sizeKey,
  styleKey, params, known)` (`architect/designs.ts`). A design is validated before it is offered (`MAX_W` 12,
  `MAX_H` 20, `MAX_CELLS` 400).
- Decorations: `candidateDecorations`, `cellSafe` and `DECOR_BLOCKS` (`decorator/decor.ts`). Village themes are in
  `village/themes.data.ts`.

### Terrain with the game's own toys (read-only SDK exports)

- `blastCells(world: BlastWorld, 'flatten_tnt' | 'tunnel_tnt', center, dir?)` returns `{ destroyed, primed }`: the
  game's own `detonate`. Adapt a `WorldView` with `blastWorld(world)` (`landscaper/blast-plan.ts`). It computes
  cells only and edits nothing.
- `tntSpec(name)` returns `{ radius, fuse, shape }`. `RECIPES`, `FLATTEN_HEIGHT` and `TUNNEL_LENGTH` are also
  exported. Crafting goes through `craft.ts`: `recipeFor`, `rawShortfall(block, n, inv)`, `craftUpTo(block, n, inv)`.
- Pickaxes: `PICKAXES` (tiers hand … emerald), `miningDuration`, `isMultiBlock`, `areaCells`, `AREA_FLOOR_ARMED` and
  `AREA_FLOOR_HELD`.
- The landscaper's blast safety: `filterBlast(destroyed, { world, classify, kidCells, kids })` keeps natural cells
  only. It drops the whole blast when any cell is within 12 of a kid cell or 24 of a kid, or touches liquid. Run it
  before lighting and again after the fuse. Skip a spot whose filtered blast removes fewer than `MIN_SPOT_REMOVE`
  (15) cells, and never blast the same spot twice (`triedSpots`).

### Long searches must yield

A bot's socket (pings, poses, the server's tick stream) shares the event loop with its planning. A search that runs
for seconds without yielding lets the server drop the connection (close 1006). Use `bots/src/shared/slice.ts`:

```ts
const slicer = new Slicer();                          // 15 ms of work per slice
for (const c of candidates) { evaluate(c); await slicer.due(); }
// or: const result = await drive(generatorOfSteps(), slicer, () => !stopped);
const lag = new LagMonitor((ms) => log({ k: 'lag', t: clock(), ms, doing: stats.current }));   // lag.stop() in stop()
```

`SiteSearch.step()` scans one chunk per call. The landscaper's area search is a generator (`evaluateAreaSteps`)
driven through a `Slicer`.

## How do I test on a local server?

### Unit tests (fake port)

Put them in `bots/test/<type>/<type>.test.ts`. Import `describe`/`it`/`expect` from `vitest` (no globals).
`bots/test/fake-port.ts`:

- `new FakeWorld()`: the real generator (seed 12345, gen 3, 512 × 512). `set(x, y, z, nameOrId)` writes an **edited**
  cell, which counts as a kid's unless your `owned` map holds it. `setNatural(…)` writes as if generated. `fill(min,
  max, b)` fills a box, and `surfaceY(x, z)` gives the surface.
- `new FakeBody()`: `current` pose, `list` of players (`player({ id, name, x, y, z, bot? })`), and `calls` recorded.
  With `.world = fakeWorld`, places and motion write through. Swap `walkImpl`/`flyImpl`/`placeImpl`/`mineImpl` to
  script failures. `emitEdit(e)`, `kidEdit(world, by, cell, newId)` and `emitReconnect()` drive events.

```ts
import { describe, expect, it } from 'vitest';
import { Ownership } from '../../src/brain2/ownership.js';
import { StopSignal } from '../../src/body/stop-signal.js';
import { checkPlace } from '../../src/builder/builder.js';
import { FakeWorld } from '../fake-port.js';

describe('mytype safety', () => {
	it('refuses next to a kid cell', () => {
		const world = new FakeWorld();
		const x = 100, z = 100, y = world.surfaceY(x, z) + 1;
		const own = new Ownership(world, () => ({}));
		world.set(x + 1, y, z, 'dirt');                      // an edited cell nobody owns: a kid's
		const v = checkPlace({ x, y, z }, 'oak_planks', { world, own, kids: [], stop: new StopSignal(600_000), now: 1_000_000, lastEditT: null, noEdits: false, halted: null });
		expect(v).toMatchObject({ ok: false, reason: 'kid cell buffer' });
	});
});
```

Test the rules that protect the kid so that they go red on a broken build. For example, delete the check and watch
the test fail. A safety test that passes either way is worth nothing.

### E2E legs (real `mcserver`)

The structure, from `bots/test/e2e-builder.ts`:

```ts
export async function myTypeLeg(c: { check(ok: boolean, what: string): boolean; info(what: string): void }, budgetMs = 300_000): Promise<void> {
	const server = await startServer();                   // our own mcserver, free port, temp DB, token 'e2e'
	if (server.port === 8080) throw new Error('refusing 8080');
	const stateRoot = mkdtempSync(join(scratchRoot(), 'mytype-state-'));
	let kid: Kid | null = null, handle: MyHandle | null = null, client: BotClient | null = null;
	try {
		const world = await server.createWorld('e2e-mytype');
		kid = await Kid.connect({ url: server.url, token: TOKEN, world, name: 'Noah' });   // a real client the server sees as a kid
		// the kid makes something the bot must leave alone (a dirt pillar)…
		const failFetch = (async () => { throw new Error('engine unavailable (e2e)'); }) as unknown as typeof fetch;
		await cliMain(['mytype', '--target', 'local', '--world', world, '--name', 'Robo', '--brain', 'laya', '--compare'], {
			makeClient: (opts) => new BotClient({ ...opts, url: server.url }),
			stateRoot, env: {}, readFile: () => null, print: () => undefined, fetchImpl: failFetch,
			onMyType: (h, cl) => { handle = h; client = cl; },
		});
		// poll handle.stats / handle.file until done or budgetMs; c.check(...) the outcome AND the kid's cells untouched
	} finally {
		if (handle) await Promise.race([(handle as MyHandle).stop(), new Promise((r) => setTimeout(r, 5000))]);
		(client as BotClient | null)?.close();
		kid?.close();
		await server.stop();                                  // SIGTERM to OUR child's PID
	}
}
```

- Wire it into `bots/test/e2e.ts`'s `main`:
  `if (want('mytype')) await leg('mytype', '<one-line claim>', () => myTypeLeg({ check, info }));`. Add the id to
  the README's `--only` list.
- Run it: `BOTS_E2E_SCRATCH=<a scratch dir you own> npm run bots:e2e -- --only mytype`. There is no default scratch
  directory: the Go build, the temp DB and the logs go there. `BOTS_E2E_VERBOSE=1` shows the server's stderr, and
  `BOTS_E2E_KEEP=1` keeps the logs.
- `startServer()` takes a free port (`freePort()` refuses 0 and 8080) and stops **by its own PID**. Do not reuse port
  18090: it may be another session's playtest server. Clean up a stray server you started with
  `fuser -k <that port>/tcp`, never with `pkill`.
- `bots/test/kid-client.ts`'s `Kid` is a real `BotClient` with `bot` stripped from its hello: `place`, `break`,
  `walkTo`, `flyTo`, `lookAt` and `pose`. Script the kid's actions to prove the safety rules against the real server.
- Every e2e runs with the engines failing, so the fallbacks are what gets tested.

For playing with a bot by hand on a local server you keep, see
[bots/README.md, "A local server for playtesting"](../bots/README.md#a-local-server-for-playtesting) (port 18090,
the site on 5180 with the save API pointed at a dead port).

## How do I run it live?

The runbook is [docs/bots.md, Operations](bots.md#operations). The short version for a new type:

1. `--target local` first, then `--target live … --no-edits` for the first live session, watched.
2. The first live run per world needs `--i-deployed-the-server`, remembered in `bots/.state/live-ack.json`. The
   token is read at runtime from `MC_LIVE_TOKEN`, `bots/.env.live` or `~/minicraft-mp/token`. Never copy it anywhere.
3. Start it from the panel (a transient unit `mcbot-<slug>`), or by hand with the `systemd-run` line in
   `docs/bots.md`.
4. Watch it: `journalctl --user -u mcbot-<slug> -f` (status lines) and its newest log (below).

Restarting safely:

```bash
systemctl --user list-units 'mcbot-*'                 # never 'minicraft-*'
systemctl --user reset-failed mcbot-<slug>            # before a restart: 5 starts an hour, then the unit fails and vanishes
systemctl --user restart mcbot-<slug>                 # or stop, then Start again from the panel (it resets first)
```

A transient unit disappears when stopped or failed (and at reboot). Restarting it means creating it again (the panel's
Start, or the `systemd-run` line), not `systemctl start`.

## How do I add it to the panel?

In `bots/panel/lib.ts`, add a row to `BOT_TYPES`:

```ts
{ id: 'mytype', family: 'builder', brain: true, maxFlag: '--max-builds', joinPlan: false },
```

- `id` is the CLI subcommand. The panel shows a type only when the CLI's `parseCommand` error message lists it
  (`parseAvailableCommands`, probed with `__panel_probe__`).
- `family`: `'companion'` adds `--brain v2 --personality …`, `'builder'` or `'foreman'` add nothing special.
- `brain: true` offers `--brain laya|jev` and `--compare`. `maxFlag` is `'--max-builds' | '--max-decorations'`: a new
  cap flag means widening that type. `joinPlan` offers `--join-plan`.
- Any other flag is not offered (the panel whitelists). Document it as CLI-only.
- `--when` appears when `cli-args.ts` has `'--when'`.
- The detail view summarises the newest log with the builder-family kinds listed under
  [Logging conventions](#logging-conventions).
- Tests: `bots/test/panel.test.ts`. Develop with `npm --prefix bots run panel -- --dry-run` (Start/Stop print the
  argv).

## Common failure modes and fixes

### Reading a live bot

Logs are in `bots/.state/logs/<target>/<world>/<name>-<stamp>.jsonl`. brain2 writes `event` lines
(`{k:'event', kind, data}`). The builder family writes flat `{k, t, …}` lines.

```bash
L=$(ls -t bots/.state/logs/live/<world>/"<name>"-*.jsonl | head -1)
journalctl --user -u mcbot-<slug> -n 5 --no-pager                        # the status line
jq -r .k "$L" | sort | uniq -c | sort -rn                                 # what it has been doing
jq -c 'select(.k=="unstick") | [.level, .how, .ok, .at]' "$L"             # builder family: stuck escalations
jq -c 'select(.k=="event" and .kind=="unstick") | .data' "$L"             # brain2: the same
jq -c 'select(.k=="event" and .kind=="act" and .data.ok==false) | .data | [.kind, .err]' "$L"   # brain2 failed actions
jq -r 'select(.k=="search-failed") | .rejections[] | "\(.radius) \(.counts | to_entries | map("\(.key)=\(.value)") | join(" "))"' "$L"
jq -c 'select(.k=="decision") | [.what, .fallback, .primary.engine, .primary.ms, .agree]' "$L"
jq -c 'select(.k=="lot-rejected") | [.lot, .why, .status]' "$L"
jq -c 'select(.k=="lag" or .k=="error" or .k=="uncaught-exception" or .k=="unhandled-rejection" or .k=="EDITS-HALTED")' "$L"
jq -c '.lots[] | [.id, .status, .why, .dropCount]' bots/.state/shared/live/<world>/plan.json
jq -c '.posts[] | [.type, .status, .claimedBy, .requester, .note]' bots/.state/shared/live/<world>/board.json
```

The panel's detail view (click an instance) shows the same summary: the job, placed count, cap, decisions and
movement trouble.

### Failures seen live, and their fixes

| Symptom | Cause | Fix (in the code now) |
|---|---|---|
| Stuck against cliffs, in tunnels, under overhangs; `walkTo blocked (wall)` loops | Raw `walkTo` is a straight line with 1-block steps | Every move through `navigate` + `StuckWatchdog` (fly to the column, fly high, air path, teleport up). New code must not bypass it. |
| Swimming forever under a lake's ice sheet | Open sky beyond 6; the watchdog saw the pose moving | `isSubmerged` widens the search to 16; the wanderer teleports up onto the ice when nothing dry is in range |
| A crash loop, `connection closed (1006)` every few minutes | A synchronous 128-radius search starved the event loop and socket | `Slicer`/`drive`/`LagMonitor` (`shared/slice.ts`); `filterBlast` pre-filters kid cells to the blast's box. Watch for `lag` lines. |
| Every lot `dropped` with `kid-cells`; `--join-plan` builders use their own sites | `lotSite` drops a lot with any kid cell within 12 | By design (kid safety). Check `plan.json`: the foreman re-checks every 15 min, at most 3 drops. Do not relax the rule. |
| A capped bot straight after a restart, or a cap that never frees up | Caps once counted every record ever made | `countsTowardCap` in a rolling hour (`windowCount`); records need `t`, `status`, `placed`. Raise the flag to raise the rate. |
| TNT placed and lit for a blast that removed nothing | The filtered blast was empty or tiny | Skip spots under `MIN_SPOT_REMOVE`, re-filter before lighting and after the fuse, `triedSpots` never retried; a placed TNT whose blast became unsafe or too small is taken back unlit |
| The bot idles in mid-air between jobs | Idling where the last flight ended | `land()` before idling; the wanderer targets only standable open-sky cells |
| `search-failed` at every radius, almost all `not-flat` | The kid is on a mountain; ±1 flat footprints are rare | Expected. The bot waits and retries. The landscaper and the board are how flat ground gets made. |
| `EDITS-HALTED` | The tripwire tripped (rate, churn, overrun, blast budget) | A bug, not noise. Read the reason and fix the loop. The halt lasts for the session by design. |
| The unit vanished after a few restarts | `StartLimitBurst=5` per hour; transient units disappear on failure | `systemctl --user reset-failed mcbot-<slug>` first, or stop and Start again from the panel |
| `jev: no JEV_API_KEY …; jev questions fall back` | No key in the checkout's or the main checkout's `.env` | Add it to `~/Projects/Minicraft/.env`. The bot keeps running on fallbacks meanwhile. |
