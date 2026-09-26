# Bot brain: emotions, behaviours and a blackboard of experts

**Status:** design, rev 3.2, 2026-09-25. It was brainstormed with Julien on 2026-09-25.
- **Rev 1** (`193069b`) went through gate 1 with four reviewers: models, rigour, engine and sequencing, and consumer. All four ran probes.
- **Rev 2** (`e7b20dd`) repaired every finding and added rulings R12–R15, which Julien made on the review's questions.
- **Rev 3** (`e1cddce`) repaired the re-gate of rev 2, where the same four reviewers re-ran their probes.
- **Rev 3.1** (`183a02d`) repaired a fresh reviewer's check of rev 3.
- **Rev 3.2** repairs a narrow check of rev 3.1.

The disposition of every finding is in §12.

Branch `bot-brain`, cut from `bots` at `b70cc3a`.

**It replaces:** the decision part of the companion bot (`docs/superpowers/specs/2026-09-25-companion-bot-design.md`), which is the 500 ms tick in `bots/src/bots/companion.ts` that picks one of `follow | watch | help_build | wander | idle`. The **body** stays: the `minicraft-bot` SDK, `bots/src/port.ts`, follow/fly/hop movement, the guard, the stop signal, config and safety refusals.

**Why:** the one-shot companion's brain barely decides anything. Laya leans heavily toward `watch`, so `follow` and `help_build` became hard rules (`bots/README.md:145-158`). Julien had too little say in its logic. This design is his model of the bot, made concrete.

## 1. The rulings

| # | Question | Ruling | Turned down |
|---|---|---|---|
| R1 | Models | **Laya + a small local generative LLM.** The LLM runs on events, never on every tick. Local only, no Jev. | Laya only; not tied to a model |
| R2 | How the bot shows its state | **Body language only.** No emote bubbles or speech. No game or server change (optional SDK additions are fine, §10). | Emote bubbles; spoken lines |
| R3 | Where the bot may edit on its own | **Any natural terrain.** It never touches a kid's cell, and keeps a buffer around them (§4.5). | Its own plot only; anywhere with the stop signal as the only brake |
| R4 | Memory across sessions | **Relationships, inventory, builds, digs and explored areas persist** in a local file. Global emotions and the action log start fresh. | Nothing persists; everything persists |
| R5 | Behaviours in v1 | **Follow, Help-build, Build, Mine (including for no reason), Explore, Watch, Rest.** Greeting is a gesture. Show-off and Avoid are out. | — |
| R6 | Materials | **The bot has an inventory in every world, fed only by mining.** Build and Mine live by it. Help-build is the exception (R12). | Kids' rules only in must-mine worlds; no inventory |
| R7 | Architecture | **A blackboard with event-triggered experts** (§3). | An orchestrator LLM; utility AI with models at the edges |
| R8 | Laya prompts | **Short, single-purpose questions.** Laya gets less accurate as prompts grow. Gate 1 confirmed it: a 113-word prompt biased every answer toward "up". | — |
| R9 | Selection merge | **Fixed weights**; the LLM's pick is one weighted vote. | The LLM has the last word |
| R10 | Build shapes | **Hand-made templates as data.** The LLM picks the template, the size and the materials. | LLM-designed shapes |
| R11 | Edit limits | **No per-session cap.** Edits are bounded by their plan, plus a runaway tripwire (§7.2). | A per-session budget |
| R12 | Help-build materials | **It copies the kid's block type from an unlimited supply, except in must-mine worlds**, where it draws from inventory like everything else. | Strict R6; free everywhere |
| R13 | Negative feelings toward kids | **As designed:** the full range, persisted (halved between sessions), including the "turn away" gesture. | Floored at 0 for kids; mild and fast-fading |
| R14 | What Mine may target | **Anything natural, ores and diamonds included.** Deep targets take several Mine episodes, which resume a persisted dig (§6.2). | No ores; common ores only |
| R15 | Engines per question | **A benchmark picks.** Each model question's engine (Laya, LLM, or both-agree) and wording are config. A labelled benchmark (§9.2) picks them before the plan commits to the model experts. The keep-going check is code. | Laya reworded; the LLM for all appraisal |

**Non-goals:**
- no chat or text, and no emotes (R2);
- no game or server changes;
- no combat or mobs;
- no deployment: the bot runs on Julien's machine only;
- no general pathfinding: walking, flying, staircases and site levelling stand in for it.

`CLAUDE.md`'s product non-goals are untouched. The bot's own building and mining is a companion feature, not a game mechanic.

**Scope changes compared with the companion spec, all explicit:**
- the bot now mines (the companion spec said "no mining help");
- it keeps memory across sessions (the companion spec said "no memory across sessions");
- it has an inventory.

## 2. Success criteria

The plan must turn each one into a test or a measured check, and name the defect that turns each test red.

1. **Behaviour reads as alive, not random.** In a recorded 20-minute session with one kid, every switch has a logged reason. No switch happens before the 20 s minimum unless its cause is `done`, `failed`, or an urgent trigger (§5.3). **In any 5-minute window there are at most 10 switches, urgent ones included.** The runtime rule behind this is the urgent governor (§5.3). The check also runs on a **two-kid fixture**: two kids lay lines and look at the bot, alternating every 5 s, for 5 minutes. Without the governor, that fixture fails.
2. **Emotions move the right way.** On the labelled appraisal set (§9.2), the chosen engine configuration gets the direction right in ≥ 80% of cases, and each class (down, stay, up) scores ≥ 60% recall. An always-`stay` baseline must fail the same bar. It's measured against live models, not in CI. If no configuration reaches 80%, the plan stops and the numbers go to Julien.
3. **Different personalities behave differently, and it's the personality doing it.** Two personalities, the same scripted event stream. **At least 2 behaviours must differ by more than 20 points of time share.**
   - **The answer cache:** model answers come from a cache keyed by prompt hash. A miss calls the live model and records the answer, so personality differences do reach the prompts.
   - **Reproducible:** every LLM call uses temperature 0 and a fixed `seed`. The stream runs on a **virtual clock**, and times in prompts are rounded (§4.3), so a replay hits the same prompts.
   - **Committed:** the cache is committed. On a replay of the committed stream, the hit rate must be ≥ 95%.
4. **Kid safety holds.** No edit ever lands on a `kid` cell or inside its buffer (§4.5), except Help-build placing into air next to the kid's line (§7.1). No edit breaks a cell touching liquid. No edit lands inside a kid's body buffer. This is property-tested against the safety tier, and asserted in every end-to-end run.
5. **It never freezes.** With Laya down, the LLM down, or both down, the bot keeps choosing behaviours and acting, using the code fallbacks.
6. **Any decision can be explained.** From the replay of a session, every behaviour switch shows its merge breakdown (§5.3) and links to the exact prompts and answers behind each input.
7. **It's good company.** Measured in a 20-minute end-to-end session. The kid is the scripted `kid-client` (`bots/test/kid-client.ts`) with a fixed script: wander 3 min, lay 2 lines of 6 blocks, stand watching 3 min, fly around 2 min, repeat.
   - The bot spends ≥ 60% of its time within 16 blocks of the kid, measured as 3D distance. A deep dig counts against it, which is intended. The 60% is a tuning target: if it's missed, the weights change, not the design.
   - On the "kid lays a line" fixtures, Help-build wins in ≥ 80% of them, both with models up and with models down.
   - On the "kid near, not laying a line" fixtures, Help-build wins in ≤ 20% of them. This makes sure a bonus big enough to win everywhere turns the test red.
   - The same two checks still pass on the **R13 fixture**: the kid breaks 3 bot blocks every session for 5 sessions, with Grievance pinned at −1 toward that kid for the last session.
   - Every Build site, dig entrance and dig route is ≥ 12 blocks (horizontally) from any `kid` cell **when it is planned or replanned**. Kid cells that appear later don't stop a build in progress.
8. **An ordinary session never trips the runaway tripwire.** Each of these runs at the fastest pacing without halting edits:
   - a full medium house, including levelling;
   - a full tower;
   - a full 120 s stone Mine episode, including a cave crossing with floor fills;
   - a Build that replans once;
   - a Help-build line that the kid keeps extending to 20 blocks;
   - a **renew**: take apart the oldest build, then build a new one.

## 3. Architecture

```
          SDK events (edits with `by`, fx, players, poses)
                      │
   ┌──────────────────▼───────────────────┐
   │ L0 perception (code)                  │──► world events
   └──────────────────┬───────────────────┘
                      ▼
   ┌─────────────────────────────────────────────┐
   │              STORE (blackboard)              │◄── every write is store.apply(patch, cause)
   │ personality · emotions · relations · memory  │    and emits change events
   │ events · inventory · builds · digs ·         │
   │ owned cells · explored · body · behaviour    │
   └──┬──────────┬───────────┬───────────┬───────┘
      ▼          ▼           ▼           ▼
   L1 decay   L2 appraisal  L3 selection  L5 expression
   (code)     (engine per R15) (code+models) (code)
                               │
                               ▼
                     L4 active behaviour
                  plan → planner → judge → execute ──► SDK
```

- **The store** is the single source of truth. Experts never call each other. They read a slice and propose a patch, and only `store.apply` mutates state. Every mutation produces a change event `{path, old, new, cause, t}`, including decay (§5.1), so a replay reproduces the live run exactly.
- **The scheduler** runs experts when their trigger matches.
  - **The Laya lane** takes one call at a time, by priority: fit, then social, then appraisal.
  - **The LLM lane** is a single queue by priority: selection, then parameters, then appraisal, then anything else. Each expert has at most **one** queued call; a newer request replaces the queued one (drop the oldest).
- **Stale answers.** Each expert declares a `materialKey(slice)`: a string built only from what would change its answer. It contains:
  - the active behaviour kind;
  - the ids of the salient events it read, **except plain `placed`/`broke`**, which count as a bucket (0, 1–3, 4+) per player;
  - the ids of the most recent **appraisal** patch on each axis it read.

  It never contains raw values, word bands or decay patches, so **decay can't make an answer stale**, by construction. A kid building steadily doesn't make answers stale either (the rev 2 key survived only 30% of the time at 2 kid edits a second).

  When an answer arrives and the key has changed, the answer is dropped and the expert's **fallback** is used for that trigger. There's no retry. `version` goes up on every apply, but it's only used for ordering.
- **Model answers are proposals.** Each expert's `merge` is code: it clamps, bounds and validates. An answer that is malformed, out of range or names something off its list counts as a failure, and the fallback is used.

### 3.1 The expert contract

```ts
interface Expert<S, P> {
	name: string;
	layer: 0 | 1 | 2 | 3 | 4 | 5;
	trigger: Trigger;                       // every(ms) | on(pattern) | debounce(on(pattern), {quietMs, maxWaitMs})
	reads(state: State): S;
	materialKey(slice: S): string;
	engine: EngineChoice;                   // 'code' | 'laya' | 'llm' | 'both-agree' | 'llm-dir-laya-stay'; config for model experts (R15)
	run(slice: S, signal: AbortSignal): Promise<P>;
	merge(proposal: P, state: State): Patch;  // pure code
	fallback(slice: S): P;
	promptBudgetWords?: number;             // required for any expert that can use Laya
}
```

- **Debounce** is trailing, with a maximum wait: the trigger fires `quietMs` after the last matching event, or at `maxWaitMs` at the latest.
- **Combination engines** are defined only for **direction** questions (`appraise.detect`). Social and fit questions use a single engine.
  - `both-agree`: Laya and the LLM must give the same direction, otherwise the answer is `stay`. The re-gate measured this: it only ever adds `stay`, and the LLM never says stay, so it scores no better than Laya.
  - `llm-dir-laya-stay`: Laya's binary wording decides whether the axis moves at all, and the LLM decides which way. It's a benchmark candidate.
- **Prompt-budget test.** For every Laya-capable expert, the whole request (state text, instructions and option text) is rendered from a deliberately busy state: 8 players, 30 events, a long history. It must:
  - stay under `promptBudgetWords`, counted as whitespace-separated words;
  - contain no player name other than the ones the question is about.

  The plan must show both assertions going red on a renderer that leaks the state.

### 3.2 Engines

- **Laya:** today's `systemone` adapter (`bots/src/brain/systemone.ts`), unchanged. `choice` questions return probabilities, and the answer is max(p). Timeout 400 ms. One warm-up call is sent at startup, because the first call measured 277 ms.
- **Laya must run with `LAYA_MODELS=english`.** With all three checkpoints loaded, the LLM gets only 1.4 of its 3.6 GB on the GPU, and `appraise.size` takes p50 4.4 s. With English only, Laya uses about 1.9 GB, gives identical answers, and the LLM fits fully: GPU at 8.2 of 10 GB.
- **LLM:** `llama3.2:3b` on Ollama is the measured default. The model and endpoint are config. It's asked with JSON-schema output, and the timeout is 5 s. Measured on this design's prompt shapes:

  | Prompt shape | p50 | max |
  |---|---|---|
  | `appraise.size` | 584 ms | 740 ms |
  | `select.situational` | 350 ms | 437 ms |

  **Ollama doesn't enforce numeric schema bounds.** Every numeric field is re-validated in `merge` (§5.2).
- **Every LLM call is deterministic:** temperature 0 with a fixed `seed`. At 0.2, the re-gate got 6 different answers out of 6 on the same prompt.
- **Startup loads the model with `keep_alive: -1`**, so it stays loaded.
- **The health check** fails, and the bot runs on fallbacks for that engine, when:
  - Laya's `/health` fails;
  - Ollama's `/api/ps` shows `size_vram` smaller than the model's size, which means it's partly on the CPU and too slow.

  A model missing from `/api/ps` isn't a failure. It means "load it", followed by one more check.
- **Code:** the default engine, and every model expert's fallback.

## 4. The state

```ts
interface State {
	personality: Personality;           // from *.data.ts, never from the file
	emotions: Record<GlobalAxis, AxisState>;
	relations: Record<PlayerName, Relation>;   // persisted
	memory: { current?: ActionEntry & { startedAgoS: number }; past: ActionEntry[] };  // last 20
	events: WorldEvent[];               // last 60 s or 30 entries
	inventory: Record<BlockName, number>;      // persisted
	builds: Build[];                    // persisted
	digs: Dig[];                        // persisted (§6.2)
	owned: Map<CellKey, BlockId>;       // persisted: the cells the bot wrote and still owns (§4.5)
	explored: Set<ChunkKey>;            // coarse; persisted as a sorted array
	body: { pose: Pose; gesture?: Gesture; editsHalted?: string };
	behaviour?: ActiveBehaviour;
	version: number;                    // ordering only
}
```

### 4.1 Global emotions

The value is in [−1, 1]. **Word bands**, used in prompts and in `materialKey`:

| Value | Word |
|---|---|
| ≤ −0.6 | very low |
| ≤ −0.2 | low |
| < 0.2 | neutral |
| < 0.6 | high |
| ≥ 0.6 | very high |

Each axis's words come from its poles.

| Axis | −1 | +1 | What 0 means | Half-life, starting value |
|---|---|---|---|---|
| Mood | unhappy | happy | even | 2 min |
| Confidence | afraid | bold | ordinary | 5 min |
| Trust | suspicious | trusting | no opinion yet | 30 min |
| Affection | hostile | fond | neutral | 30 min |
| Curiosity | avoidant | adventurous | mildly interested | 3 min |
| Patience | irritable | tolerant | ordinary | 20 s |
| Outlook | discouraged | hopeful | realistic | 10 min |
| Stimulation | bored | overstimulated | comfortably engaged | 1 min |

`AxisState = { value, pendingDrift, deltas: {amount, cause, agoS}[] }`. It keeps the last 10 deltas.

**Word bands have ±0.03 hysteresis:** a value has to cross an edge by 0.03 before its band changes.

**Decay (repaired twice).**
1. On every tick, decay adds `(baseline − (value + pendingDrift)) · (1 − 2^(−dt/halfLife))` to `pendingDrift`. It's computed from the value *including* the pending drift, so it can't overshoot.
2. When |pendingDrift| ≥ 0.01, it's applied as one patch with `cause: 'decay'`, and `pendingDrift` resets.
3. When |value + pendingDrift − baseline| < 0.01, the value snaps to the baseline, `pendingDrift` resets, and decay stops.

Every axis decays at its true rate. Tests:
- Mood at 1.0 with baseline 0 is 0.5 ± 0.01 after 2 min.
- An axis whose baseline sits on a band edge changes band at most twice while it settles.
- While an axis settles, `value − baseline` **never changes sign**, and settling from a distance d emits at most ⌈d / 0.01⌉ + 1 decay patches. Both tests also run on the drift formula **with the snap disabled**. That's the only setting in which the rev 2 formula's overshoot shows (108 sign changes). Without it, these tests couldn't go red on the old formula.
- From d = 0.0105, the axis snaps within one half-life. This is the test that goes red on the rev 3 snap, which got stuck at 0.0105. Decay events are never appraisal deltas: they don't count toward the selection trigger's Σ|Δ| (§5.3), and they aren't listed in `deltas`.

### 4.2 Relations (per player)

These are Affection, Cooperation, Respect and Grievance (−1 resentful, +1 grateful), in [−1, 1], with the full range allowed toward kids (R13). Each has the same fields as `AxisState`, plus `metSessions`, `minutesTogether` and `lastSeenAgoS`.

- **Within a session:** decay as in §4.1. Grievance's half-life is 30 min; the others' is 4 h.
- **Between sessions:** loading the file moves each axis halfway back to 0, but **only if the file's `lastAlive` is more than 30 minutes ago**, so a crash or restart doesn't wipe feelings. `lastAlive` is written on every debounced write (at most 5 s apart) as well as on exit, so a crash leaves it fresh.
- **Players are keyed by name.** Bots (🤖) never get a relation entry.

### 4.3 Action memory

`ActionEntry = { behaviour, params, lastedS, outcome: 'done' | 'abandoned' | 'interrupted' | 'failed' | 'paused', why }`. `paused` means a Mine episode that ended on its time budget with its dig saved (§6.2). Models never see timestamps, only durations in seconds, as Julien asked.

**Seconds in prompts are rounded:** to 5 s below a minute, and to 30 s above. Prompts then repeat exactly, which makes the answer cache (criterion 3) and the benchmark reproducible.

One shared renderer prints the memory line, for example:

> Now: Explore, started 10 s ago. Before: Build tower 94 s (done). Follow Noah 40 s (interrupted: Noah flew away).

### 4.4 World events

**Perception** diffs today's `Snapshot` (`bots/src/body/perceive.ts`) and the SDK's `onBlockChange` (which carries `by`) into events:
- `placed`, `broke` (these are **other players' edits only**; the bot's own edits aren't events);
- `player-near`, `player-arrived`, `player-gone`;
- `broke-my-block`, `added-to-my-build`;
- `line-started` (a kid made 3 collinear same-block placements; today's detector);
- `looking-at-me` (a kid within 8 blocks, looking at the bot for ≥ 2 s);
- `following-me`.

**Behaviours** write:
- `found` (a block type seen for the first time this session, or an ore uncovered);
- `need`, `stuck`, `hazard`;
- `outcome`, **once per behaviour, when it ends**.

Every event has `agoS`, and a `salient` flag set by `salience` (§5.1).

### 4.5 Who owns a cell (repaired)

Every cell is one of three classes. Gate 1 showed that matching coordinates against `builds` or the journal lets a kid's block be mistaken for the bot's, so ownership is decided by the current block:

- **`bot`**: `owned` has the cell, **and** the world's current block equals the id the bot wrote. Any foreign `onBlockChange` on an owned cell (`by` ≠ the bot) deletes it from `owned` at once. `owned` is persisted in the brain file, not taken from the SDK journal, which is capped at 10,000 entries and cleared when the state file joins another world. When the file loads, every entry in a loaded chunk is checked against the world, and mismatches are dropped. Entries in chunks that aren't loaded yet count as `kid` until their chunk loads and passes the check.

**A known limit:** if a kid breaks a bot cell and re-places the same block while the bot is offline, the bot can't tell, and the cell still counts as `bot`. It's rare, and nothing fixes it.
- **`natural`**: not `bot`, and never edited. The check is the SDK overlay: `world.isEdited(x,y,z)`, a new read-only SDK accessor over the private `ChunkOverlay`, O(1). Gate 1 found 0 of 262,144 unedited cells differing from the generator. The overlay also catches a kid re-placing the same block, which comparing against the generator can't.
- **`kid`**: everything else. That includes other bots' edits and liquid flows set off by edits. This is deliberately conservative.

**The kid-cell index.** Distance rules ("≥ 12 blocks from any `kid` cell") can't be checked cell by cell: that's about 160,000 point queries per candidate site. The bot keeps a per-chunk set of `kid` cells, built once per chunk from a second read-only SDK accessor, `editedCellsInChunk(cx, cz)`. `onBlockChange` keeps it current. Distance checks then run against those sets, not against the world.

**The buffer applies to `kid` cells only:** 1 block for placing, 2 blocks for breaking next to a `kid` cell that is air (a dug base). Bot cells have no buffer, so the bot can build its second block and dig its next step.

### 4.6 Persistence (R4)

The file is `bots/.state/brain/<target>/<world-uuid>/<bot>.json`, keyed by world uuid as `bots/src/config.ts:204` does. It holds `relations`, `inventory`, `builds`, `digs`, `owned`, `explored`, `lastAlive` and `schemaVersion`.

- **Personality always comes from `*.data.ts`**, so tuning takes effect on the next run.
- **Writes:** atomic (a temp file, then a rename), debounced to 5 s, and on exit.
- **An older `schemaVersion`** runs its migration. With no migration, or an unreadable file, the file is renamed `.bad-<ts>` and the bot starts fresh; it never crashes.

**Reconciling with `revert`.**
- The bot's `revert` command must also:
  - remove every reverted cell from `owned`;
  - apply the journal's net inventory effect in reverse: return each placed block, and remove each mined block that `revert` put back, never below 0;
  - mark affected builds and digs `reverted`.
- `--revert-on-exit` does the same before the final write.
- `revert --builds` reverts only cells in `builds` that are still `bot`.
- Anything older than the SDK journal's 10,000 entries can't be reverted. The spec states that limit; it isn't fixed here.

## 5. The experts

### 5.1 Layers 0–1 (code)

| Expert | Trigger | What it does |
|---|---|---|
| `perceive` | every 500 ms, plus SDK edit and fx events | Diffs snapshots and edits into `WorldEvent`s (§4.4). Maintains `owned` on foreign edits. |
| `salience` | on new events | Marks an event salient when it involves the bot's builds, digs or inventory (`broke-my-block`, `added-to-my-build`), or it is `line-started`, `looking-at-me`, `player-arrived`, `player-gone`, `found`, `need`, `stuck`, `hazard` or `outcome`, or another player's edits within 16 blocks. **Those plain edits, and `added-to-my-build`, are salient only when that player's count in the last 10 s moves to a different bucket (0, 1–3, 4+).** Without that rule, a kid building steadily set off about 20 appraisal bursts a minute and pushed Mood to 0.99. **The bot's own edits are never salient.** The rules are data. |
| `decay` | every 500 ms | Accumulated drift (§4.1). |

### 5.2 Layer 2: appraisal (R8, R15)

**`appraise.detect[axis]`** runs on `debounce(on(salient event), {quietMs: 1000, maxWaitMs: 3000})`.
- It runs once for each of the 8 global axes, and once for each of the 4 relation axes of every player involved in the burst.
- It sees only:
  - the axis name and its poles;
  - the value as a word band;
  - its last 2 deltas;
  - the 1–3 salient events of the burst, as short sentences.
- Budget: 60 words.
- **Engine and wording are config (R15).** The benchmark (§9.2) chooses between:
  - Laya, three-way: "go down, stay, or go up?" (5/12 in gate 1);
  - Laya, two binary calls: "more ‹hi› now?" and "more ‹lo› now?" (8/12);
  - the LLM, one call per burst: a schema answer covering every axis in the burst (9/12, never says `stay`);
  - the LLM few-shot: the same call with 4 labelled examples, one of them `stay`;
  - `llm-dir-laya-stay` (§3.1);
  - `both-agree` (§3.1), kept only as a baseline.
- An answer with max(p) < 0.5 counts as `stay`.
- **Cost per burst**, for k players involved:

  | Engine | Calls per burst | Time |
  |---|---|---|
  | Laya three-way | (8 + 4k) calls, at p50 12 ms and p95 19 ms each | ≈ 0.15 s |
  | Laya binary | 2 × (8 + 4k) calls | ≈ 0.3 s |
  | LLM | 1 batched call | p50 ≈ 0.6 s |
  | Combinations | the sum of their parts | ≤ 1 s |

  All of these stay under `maxWaitMs`.

**`appraise.size`** is one LLM call per burst, covering the axes `detect` flagged.
- **Input:** the flagged axes with their directions, the burst's events, the personality in one sentence, and the word bands.
- **Output schema:** `{axis: enum of flagged ids, e.g. "mood" | "rel.Noah.affection", amount: number, because: string}[]`.
- **The merge is code:**
  - amount = clamp(|amount|, 0.05, 0.4);
  - the sign comes from `detect`, never from the LLM;
  - an axis that wasn't flagged is dropped;
  - `because` is cut to 12 words;
  - the value is clamped to [−1, 1].
- **Fallback:** a data table of event kind × axis → signed amount. The same table is the code fallback for `detect`.

### 5.3 Layer 3: selection

**Triggers:**
- **Normal triggers:**
  - the behaviour ends (`done`, `failed`, `abandoned`, `paused`);
  - appraisal deltas with Σ|Δ| > 0.5 within 10 s (decay excluded);
  - `player-arrived` or `player-gone`.
- **Urgent triggers**, which may interrupt within the 20 s minimum:
  - a stop signal;
  - `hazard`;
  - the behaviour's target player gone;
  - `line-started` by a kid within 16 blocks;
  - `looking-at-me`.

  **Limits on urgent triggers:** at most one per trigger kind per player every 20 s. An urgent trigger never interrupts a behaviour that already serves the same player: a `line-started` from Noah doesn't interrupt Help-build {Noah}. **The urgent governor**, a runtime rule, allows an urgent switch only if:
- there has been no urgent switch in the last 30 s, across all players and kinds, **and**
- there have been fewer than 9 switches of any kind in the last 5 minutes.

Otherwise the trigger becomes a normal one. **Stop signals and hazards are exempt**: they always interrupt at once. That stops two kids laying lines from bouncing the bot between them. Criterion 1's two-kid fixture tests it at 3, 4, 5 and 7 s alternation. Without the governor it produced 30 switches.
- **Keep-going (code, R15)** every 30 s: it triggers selection when:
  - the behaviour has run past its `typicalS` upper bound, or
  - Stimulation is "low" or "very low" and the behaviour has run ≥ 60 s, or
  - the last 3 actions of the behaviour failed.

**The three passes run in parallel:**

1. **`select.emotional`** (code): a data table of behaviour × emotion and relation weights. It outputs a score per behaviour.
2. **`select.social`** (engine per R15, split per R8). For each player present, it asks two questions, each ≤ 60 words, about that player only:
   - "Do I want to be near ‹name› right now?"
   - "Does ‹name› seem to want help?"

   Code maps the answers to scores for Follow, Watch and Help-build per player. Gate 1 measured "wants help?" at `no` 0.65 on a real line-laying scene, so this question is in the benchmark (§9.2). Help-build doesn't depend on it: `line-started` is urgent, and the emotional table gives Help-build a flat bonus while `line-started` is fresh (≤ 15 s). The bonus is sized to beat the social penalty of Grievance at "very low", which is what the R13 fixture checks (criterion 7).
3. **`select.situational`** (LLM): the whole state as prose. It outputs `{behaviour: enum, params, because}`. It picked `watch` 22 out of 22 times on a line scene in gate 1, so its merge weight starts low (§11), and its prompt is benchmarked like the others.

**`select.merge`** (code) adds fixed weights (R9, from data):
- The inputs are `emotional + social + situational` (a one-hot vote).
- **Inertia** favours the current behaviour, in proportion to `startedAgoS` up to its `typicalS`.
- The **recency penalty** covers behaviours done in the last 5 min; `abandoned` and `failed` ones are penalised more. A `paused` Mine gets a **resume bonus** instead.
- A **mask** removes behaviours that aren't feasible:
  - no kid present: no Follow, Watch or Help-build;
  - no materials, and Mine can't supply them: no Build;
  - edits halted: nothing that edits.

The full breakdown (behaviour × input × weight → total) is logged on every run and shown in the TUI (criterion 6). The winner takes its params from `situational` if the LLM picked the same behaviour, otherwise from `params.*`.

**Minimum time in a behaviour:** 20 s. Only an ending outcome or an urgent trigger overrides it.

### 5.4 Parameter experts

| Expert | Engine | Output |
|---|---|---|
| `params.build` | LLM | Template, variant, and a role → block mapping. The blocks must be in `WORLDGEN_BLOCKS` (`src/data/crafting.data.ts:25`) and in the inventory, or be minable. Never liquids or `CRAFTED_ONLY`. The merge rejects anything else. |
| `params.mine` | LLM, or the `need` event | A block type in `WORLDGEN_BLOCKS`, ores included (R14). A `paused` dig is offered first. |
| `params.player` | code | The kid present whom the bot has spent the fewest minutes with in the last 10 minutes, unless the LLM named one or `line-started` or `looking-at-me` names one. |
| `params.explore` | code | The least-explored direction within the leash (§6). |

### 5.5 Layer 5: expression (code, R2)

**Style**, applied continuously:
- walking speed comes from Stimulation and Mood (this needs the SDK's optional `walkTo` speed, §10);
- how often it looks around comes from Curiosity;
- its preferred distance from players comes from Confidence and Affection.

**Gestures** are short reactions (≤ 2 s), triggered by appraisal deltas.
- They fire **only when the bot is inside some kid's view**: within 20 blocks, within ±50° of that kid's yaw, and within ±35° of that kid's pitch. Otherwise they're skipped, since nobody would see them.
- **The greeting is the exception.** It's held for up to 20 s until the bot is in the arriving kid's view. Its walk goes to a spot in front of the kid, so it can be seen.
- At most one every 5 s.
- A gesture moves with `move()`, which cancels a walk, so the behaviour reissues its current action afterwards.
- Gate 1 measured that small head motions (look down, pause) don't read at distance, so positive gestures are big, and negative ones are distinct from them.

| Change | Gesture |
|---|---|
| Mood +≥ 0.3 | a double hop, plus a `firework` fx if the cause is a finished build |
| Mood −≥ 0.2 | stop, then a slow full turn, then a 2 s pause. There's no crouch in the protocol, and a look-down doesn't read at distance. |
| Confidence −≥ 0.2, **not** caused by a kid approaching | back off 2 blocks from the cause |
| Affection toward P +≥ 0.15 | turn to P and hop |
| Grievance toward P −≥ 0.2 | turn away from P (R13) |
| Curiosity +≥ 0.2, or `found` | turn toward the thing and pause 1.5 s; for uncovered ore, stand beside it facing it for 3 s |
| Patience < −0.5 and a failed outcome | an abrupt turn, then a 3-block walk **at a right angle to the nearest kid's direction**, so it doesn't read as leaving the kid. It has to look different from the happy double hop. |
| `player-arrived` with Affection ≥ 0.3 (greeting) | turn, walk 2 blocks toward them, hop |

## 6. The behaviours

**One leash for everything:** while any kid is present, every target must lie within **32 blocks, measured horizontally,** of the nearest kid. The targets are a site, a dig **entrance**, a waypoint and the Rest spot. A dig's leash is checked on its entrance, both when it starts and when it resumes; depth isn't leashed (R14). With no kid present, the leash is 32 blocks from the bot's latest build, or from world spawn if there are no builds.

```ts
interface Behaviour<P> {
	kind: BehaviourKind;
	plan(params: P, state: State): Promise<Plan>;
	next(plan: Plan, state: State): Action | 'done' | { failed: string } | 'paused';
	judgeFit?(action: Action, state: State): FitQuestion | null;
	typicalS: [number, number];
	plannedEdits(plan: Plan): number;           // for the tripwire (§7.2); recomputed as below
}
```

**How `plannedEdits` is computed for each behaviour:**

| Behaviour | Budget |
|---|---|
| Build | levelling cells + template cells. A replan (at most one) replaces the budget with the new plan's count. |
| Mine | the breaks of the episode's next S steps, where S = ⌈120 s / (3 × 0.6 s)⌉ = 67 steps (the most a 120 s episode can do at the fastest pace), plus exactly the floor fills those steps need, plus the target cells (up to N). The generator already knows where the cave cells are, so they're counted, not estimated. |
| Help-build | recomputed each time the kid extends the line: the remaining cells of the detected line + 1 |
| Explore, Follow, Watch, Rest | 0 |

| Behaviour | Plan | Next action | Ends |
|---|---|---|---|
| **Follow {P}** | none | today's standing-intent follow; the distance comes from style | P gone (failed); otherwise at selection |
| **Help-build {P}** | today's line detector | the next cell in the kid's line. The block is the kid's block type, free outside must-mine worlds (R12). In must-mine worlds it comes from inventory, and a shortage writes `need`. | done when the kid places nothing for 15 s |
| **Build {template}** | `params.build`, then the site search (§6.1) | levelling cells first, then template cells bottom-up in template order. It walks or flies within reach first. | done when every cell is placed (persisted). Failed when a site cell turns `kid` (it replans once), or there's no site. Materials running out writes `need`. |
| **Mine {block}** | resume a paused dig, or start one (§6.2) | the next staircase cell, with a floor check | done with N of the block (default 8); paused at 120 s; failed on a hazard or when stuck 3 times |
| **Explore** | a direction and waypoints about 12 blocks apart | walk or fly to the next waypoint; look at salient things | 60–120 s, or on `found` |
| **Watch {P}** | none | stay at the style distance; look at what P looks at or edits | 30–60 s; P gone |
| **Rest** | the latest build within the leash, or where it stands | go there, idle, look around slowly; Stimulation's half-life is halved while resting | 30–90 s |

Everything the bot breaks goes into its inventory as the same block id (there are no drops or conversions, `onRemoved`). Every placement from inventory takes one. The bot never holds liquids or `CRAFTED_ONLY` blocks.

**Templates** live in `bots/src/brain/templates.data.ts` (R10): cells relative to an origin, each with a role (`wall`, `roof`, `floor`, `accent`, `door-gap`). Roles map only to `WORLDGEN_BLOCKS`. The first set:
- house 5×5×4
- wall 7×3
- tower 3×3×8
- statues: a creeper, a person, a heart

Each comes in small and medium.

**Clutter limits** (data):
- **at most 3 standing builds per world.** A build is standing while ≥ 50% of its **template cells still hold the template's block**. `bot` cells holding air don't count, since the bot's own breaks leave those; counting them would keep a taken-apart build standing forever.
  - At the cap, Build may pick **renew**: take apart the oldest standing build first (only its `bot` cells, with the blocks going back to inventory), then build the new one **on a different site** that doesn't overlap the old footprint. So the bot keeps building after the third build, and never writes the same cell 3 times.
  - Taking apart counts in that plan's `plannedEdits`.
- a site must be ≥ 12 blocks from any `kid` cell, and ≥ 16 blocks from world spawn;
- a dig's entrance and its whole route must be ≥ 12 blocks (horizontally) from any `kid` cell when it's planned.
- at most 3 paused digs. A dig is dropped once its cells are no longer `bot`.

### 6.1 The Build site search

Gate 1 found that a strictly flat 7×7 site is missing within 48 blocks at 29 of 54 sampled positions. Allowing ±1 height, it's missing at only 2 of 54. So:

- **What qualifies:** the footprint plus a 1-block margin is all `natural` and within ±1 of the median height, with the build's height clear above. It must meet the clutter limits and the leash.
- **Levelling is part of the plan:** first dig the high cells, whose blocks go to inventory, then fill the low cells from it. Digging first means an empty inventory can still level. Those edits count in `plannedEdits`. The re-gate measured up to 16 digs and 20 fills, margin included, on the first site found.
- **The search is spread over ticks:** one chunk per slice, yielding between slices, because one 48-block search measured 75–312 ms of synchronous generation, which would stall the 100 ms pose ticks. The SDK's `region()` is capped at 32 per side, so the search walks chunks itself.
- **No site within the leash** means Build fails with `no-site`, and the recency penalty keeps it from being picked again at once.

### 6.2 Mine and digs (R14)

- **The target** is the nearest cell of the block type that is reachable through `natural` and `bot` cells. The bot knows it from the generator: this is x-ray, accepted for v1.
- **The route is a spiral staircase.** A straight staircase would end about 100 blocks sideways from its entrance on a deep dig.
  - **Shape:** a 3×3 spiral around a central pillar, going down one block per step, 8 steps per turn. Each step is **3 high**. A kid's jump reaches 1.33 blocks, so a 2-high step would leave no headroom to climb it; 3 high lets a kid who wanders in walk back out.
  - **The entrance** is chosen straight above the target, or as close to that as the leash and the ≥ 12 block rule allow. A final horizontal tunnel of at most 8 blocks, also 3 high, reaches the target.
  - So the bot never goes more than about 10 blocks sideways from its entrance.
- **A dig** is persisted as `{block, entrance, target, cells done, status}`. A Mine episode lasts at most 120 s. At the time budget it ends as `paused`, not `failed`, and the next Mine for the same block resumes the dig at its last step.
- **Deep targets take several episodes.** The nearest deepslate diamond measured 98–101 blocks down, about 9–12 minutes of stone digging at 3 breaks a step.
- **Floor check (sense tier):** before stepping, the cell under the next step must be solid. If it's air (a cave), the bot:
  1. places a block from inventory (this is counted in `plannedEdits`);
  2. with an empty inventory, the episode ends `stuck (gap)`.

  **There's no re-routing inside a spiral.** The re-gate checked this cell by cell: reversing the rotation breaks the floor of an earlier step, and leaves a 3-block climb that nobody can walk up.
- **Hazards:** a route cell touching liquid ends the episode as `hazard`, and the dig is re-routed next time.
- **Kids nearby:** a kid inside the staircase's buffer blocks it. That counts as `stuck`, not `hazard`.
- **A kid's liquid in the dig:** if a kid sets off liquid that flows into the dig, those cells become `kid`. The dig can't resume, and it ends `stuck (kid-liquid)`. That's the safe direction.
- **Uncovered ore:** when the staircase uncovers an ore on the way, the bot writes `found`, which triggers the stand-beside-it gesture. Ores that aren't the target are left in place.

## 7. The planner → judge → execute loop and safety

```
plan once → loop { planner.next → judge → ok ? execute → result : back to planner (with reason) }
3 rejections in a row, or 3 failed executions of one action → the behaviour fails
```

### 7.1 The judge, in three tiers

1. **Safety** (code, a hard veto that nothing overrides):
   - Help-build aside, no edit on a `kid` cell or inside its buffer (§4.5);
   - the 1-block buffer around every kid's body, at every height (today's `guard.ts`);
   - no breaking a cell that touches water or lava;
   - **the stop signal:** after a kid breaks a bot block, `StopSignal` (`bots/src/body/stop-signal.ts`) gives that kid a stop for `STOP_SIGNAL_MS` = 10 min, which follows him wherever he goes. While it's active:
     - no Help-build for that kid, as today;
     - no edit within `STOP_RADIUS` = 16 blocks (horizontal) of him.

     Rev 3.2 said "no edits within that kid's buffer", which the buffer rule already forbids, so the stop did nothing. Found while planning;
   - a gap of `EDIT_GAP_MIN_MS` = 600 between edits;
   - `--no-edits`;
   - inventory > 0 to place, except for Help-build under R12;
   - **plan-bound:** every edit must be an action the active plan owns, and within its `plannedEdits`.
2. **Sense** (code):
   - the target is still reachable;
   - the cell is still air (to place) or still the expected block (to break);
   - the floor check (§6.2);
   - it isn't the same failed action a 3rd time.
3. **Fit** (engine per R15, optional). It's asked only when a kid is within 8 blocks, or the action touches a cell a kid is looking at. It's ≤ 60 words.
   - **no** rejects, but only if p(no) ≥ 0.6. Gate 1 saw "place stone on my own tower, Noah 7 blocks away" answered `no`.
   - **wait** pauses 2–4 s, at most 3 times per action; after that the action goes ahead.
   - **yes** goes ahead.
   - Fit cases are in the benchmark.

### 7.2 Runaway tripwire (repaired)

Edits for the rest of the session are **halted** (`body.editsHalted`) when either happens:

- **Rate:** more edits in the last 60 s than `60 000 / EDIT_GAP_MIN_MS × 1.2` (120 at the 600 ms floor). Gate 1 measured normal pacing at 33–100 edits a minute, above rev 1's limit of 30. This limit sits above the fastest legal pace, so it catches pacing bugs, not work.
- **Churn:** the same cell edited 3 times within 10 minutes. Levelling and help-build write a cell at most twice.
- **Plan overrun:** a behaviour **attempts** more edits than its `plannedEdits` (as computed in §6) + 10%. What counts is the edits the **plan-bound veto** rejects, meaning edits outside the plan. Other rejections don't count: a kid in the way, a cell the kid filled first, and so on. Counting them would halt a normal Help-build whenever the kid stands at the end of his line. The count resets whenever `plannedEdits` is recomputed.

The halt is logged loudly and shown in the TUI. The bot keeps running with edits masked out. Criterion 8 checks that normal sessions never trip it.

### 7.3 Interruptions

- A gesture pauses the loop, then the current action is reissued.
- A switch stops the loop after the current action. A walk is cancelled with `move(pose())` (`bots/src/body/act.ts:205`). The old behaviour ends `interrupted`, or `paused` for a Mine.

### 7.4 Pacing

The gap between actions comes from style: 0.6 s (excited) to 2 s (calm). The safety tier enforces the floor.

## 8. The debug view, logs and replay

- **`--tui`**: a live terminal view, plain ANSI at 4 Hz with no UI framework. It shows:
  - a header with the engine health, latency, the LLM queue, and any **edits halted** flag;
  - emotion bars with a baseline marker, word band, value, and the last delta with its cause and age;
  - the relations table;
  - the active behaviour with plan progress, the last verdict per judge tier, and the memory line;
  - **the last selection's merge breakdown**;
  - the inventory, and any paused digs;
  - the expert feed: expert, engine, latency, prompt words, answer, fallback, patch.
- **Logs:** one JSONL line per change event and per expert call. A call's line holds the exact prompt, answer, latency, fallback flag, `materialKey` and merged patch. The last 20 logs are kept per world, in `bots/.state/logs/…`.
- **`npm run bot:replay <log>`** renders a recorded session. Space pauses, ←/→ steps, and `e` shows the full call behind the highlighted line.
- **`npm run bot:replay <log> --data <override.ts>`** is a **per-decision check**, not a re-simulation. It re-scores each recorded selection on its own recorded inputs (the model answers, the emotions and the events at that moment) with the changed data tables, and lists the decisions that would have gone differently.
  - It can't show what would have happened afterwards: after the first different decision, the real session would have diverged.
  - It's still how Julien tunes the roughly 330 hand-set numbers without playing a new session for every change. The output is labelled to say so.
- **Poke keys** (`--tui` only, refused against the live target): set an emotion axis, or inject an event from a menu.

## 9. Testing

### 9.1 Tests

- **Experts:** each is tested alone on fixed slices, with the model engines faked, plus a prompt-budget test for each Laya-capable expert (§3.1).
- **Pure code:** decay (including the half-life test in §4.1), merge, salience, ownership, safety and the tripwire. Ownership and safety are **property-tested** on random worlds, kid edits, foreign overwrites of bot cells and plans. They assert criterion 4, and that a kid overwriting a bot cell makes it `kid`.
- **Scheduler:** a recorded event stream plus answers cached by prompt hash, deterministic with no GPU. It checks triggers, debounce `{quietMs, maxWaitMs}`, `materialKey` staleness (decay alone must never make an answer stale), queue replacement, lane priority, and the fallbacks with each engine down and both down (criterion 5).
- **Criterion 3:** runs on the prompt-hash cache, which calls a live model on a miss.
- **Criterion 8:** full plans at the fastest pacing against a fake port.
- **End-to-end:** the local `mcserver` on a temp database, as today (`bots/test/e2e.ts`). There's one scenario per behaviour; a kid-lays-a-line scenario (criterion 7); a Mine that pauses and resumes; a `revert` that reconciles inventory and `owned`; and a mixed 5-minute session asserting criteria 1, 4 and 8.
- **The instrument rule:** each test in the plan names the defect that turns it red and the build it was seen to fail on.

### 9.2 The model benchmark (R15)

`bots/bench/` holds labelled cases for every model question: appraisal direction, social near/help, fit, and situational. The appraisal set:
- has ≥ 40 cases;
- has classes balanced to at least ⅓ each;
- includes the 12 gate-1 cases.

`npm run bot:bench` runs every candidate engine and wording against live models. It reports accuracy, recall per class, and latency, and it runs an always-`stay` baseline to show that the bar rejects it.

Julien reviews the labels, since they encode what he means by each axis. The chosen configuration is written to `engines.data.ts` with its numbers. This runs **before** the plan's model-expert tasks. It's measured, not run in CI.

## 10. Layout and build order

```
bots/src/brain2/
	store.ts  scheduler.ts  judge.ts  ownership.ts  persist.ts  tui.ts  replay.ts
	engines/  laya.ts (wraps brain/systemone.ts)  llm.ts (Ollama JSON-schema)  health.ts
	experts/  perceive salience decay appraise-detect appraise-size select-* params-* react
	behaviours/  follow help-build build mine explore watch rest  site-search.ts
	render/   prompt renderers (memory line, word bands, event sentences)
	*.data.ts personalities, emotional weights, merge weights, gestures, salience, templates,
	          appraisal fallback, engines (R15 results), clutter limits
bots/bench/   labelled cases and the bench runner
```

**SDK additions** (`packages/minicraft-bot`, no game or server change):
- `world.isEdited(x,y,z)`, a read-only accessor over the overlay;
- `world.editedCellsInChunk(cx, cz)`, which lists a chunk's edited cells, for the kid-cell index (§4.5);
- an optional `speed` on `walkTo`, still ≤ 1 block per pose.

Everything else (`flyTo`, `mine`, `break`, `journal`, `revert`, `onBlockChange` with `by`) exists already.

**Build order**, where each step is testable without the step after it:
1. The store, persistence, ownership (with `isEdited`), and the safety judge with the tripwire, property-tested offline. The JSONL log format is frozen here.
2. The behaviours with code-only selection and all the fallbacks, end to end on a local `mcserver`. That proves criteria 4, 5 and 8 with no model at all.
3. The benchmark (§9.2): labels, then Julien's review, then the engine choice.
4. The Laya experts, and then the LLM experts.
5. The TUI and replay, including `--data`, and criteria 1, 3, 6 and 7.

It all lives in `brain2/`, so today's companion keeps working. `--brain v2` switches over, and the old tick is removed in a later cleanup.

## 11. Open items and starting numbers

- **Starting weights are guesses**, tuned through `replay --data` and logged with their before and after numbers. `select.situational` starts at the lowest merge weight of the three passes because of its measured watch prior.
- **The benchmark will probably fail criterion 2.** On the 12 gate cases, the best engine was the LLM at 9/12 (75%), with 0% recall on `stay`. No combination tried beat it. The few-shot and `llm-dir-laya-stay` candidates haven't been measured yet. If nothing reaches the bar, the plan stops at step 3 (§10), and Julien decides with the numbers in front of him. Options then: lower the bar, use a bigger model, or keep the code fallback table for some axes.
- **Mine uses x-ray (R14).** It's accepted for v1. The staircase keeps it looking like a kid's digging.

## 12. Gate 1 dispositions (rev 1 → rev 2)

| Finding (lens) | Disposition |
|---|---|
| Tripwire trips on every build and staircase (rigour B1, engine B1) | Fixed §7.2, criterion 8 |
| A kid's block can be taken as the bot's (rigour B2, engine M2) | Fixed §4.5 (`owned` checked against the current block, dropped on foreign edit) |
| Decay rule freezes 7 of 8 axes (rigour B3) | Fixed §4.1 (accumulated drift, half-life test) |
| "Changed materially" undefined (rigour M1) | Fixed §3 (`materialKey`) |
| Decay triggers selection (rigour M2) | Fixed §4.1, §5.3 |
| The bot appraises its own edits; unbounded queue (rigour M3) | Fixed §4.4, §5.1, §3 (one queued call per expert), §3.1 (debounce) |
| Two meanings of "natural"; bot cells block the bot (rigour M4) | Fixed §4.5 (three classes, buffer on `kid` only) |
| `revert` vs. inventory and builds (rigour M5) | Fixed §4.6 |
| Stop-signal wording ≠ code (rigour M6) | Fixed §7.1 (matches the code) |
| Rigour minors (criterion 1 wording, schema migration, personality source, restart halving, uuid key, no-player leash, unminable Help-build blocks, fit wait cap, churn window, Rest vs. decay, lane priority, other bots, log growth, `explored` serialisation, journal cap) | Fixed §2, §3, §4.2, §4.5, §4.6, §6, §7, §8, R12 |
| `detect` fails criterion 2 (models B1) | R15: engine and wording chosen by benchmark §9.2; criterion 2 hardened |
| Keep-going never switches (models M1) | R15: keep-going is code (§5.3) |
| VRAM needs `LAYA_MODELS=english` (models M2) | Fixed §3.2, health check |
| Ollama ignores schema bounds; ambiguous axis (models M3) | Fixed §5.2 |
| Fit wrong 2 of 3 times (models M4) | Fixed §7.1 (p(no) ≥ 0.6, wait cap, benchmarked) |
| Criterion 3 was near-vacuous (models M5) | Fixed §2 (prompt-hash cache, live on a miss) |
| Watch prior in the LLM and `social` (models M6) | §5.3: urgent `line-started` and a flat bonus; criterion 7; benchmarked; low starting weight |
| Models minors (balanced labels, prompt-budget leak test, warm-up) | Fixed §9.2, §3.1, §3.2 |
| Mine's 90 s cap can't reach diamonds (engine M1) | R14 and §6.2 (persisted digs, `paused`) |
| No flat sites (engine M3) | Fixed §6.1 (±1 plus levelling) |
| The site search stalls pose ticks (engine M4) | Fixed §6.1 (spread over ticks) |
| `isNatural` via the generator vs. the overlay (engine minor 1) | Adopted: SDK `isEdited` |
| Only worldgen blocks; never TNT or liquids (engine minor 2) | Fixed §5.4, §6 |
| Cave breakthroughs; dug kid bases (engine minor 3) | Fixed §6.2 floor check, §4.5 2-block breaking buffer |
| Walk speed needs the SDK; gestures cancel walks (engine minor 4) | Fixed §10, §5.5 |
| Help-build has no blocks (consumer B1) | R12 |
| Punishing the kid's kill switch (consumer B2) | R13: **kept as designed** by Julien's ruling |
| The bot takes his diamonds (consumer B3) | R14: **the bot may mine ores**, by Julien's ruling. It still shows uncovered ores it isn't after. |
| Too little time with the kid (consumer M4) | §5.3 urgent triggers, criterion 7 |
| No leash (consumer M5) | Fixed §6 (32 blocks) |
| Clutter and spot-hogging (consumer M6) | Fixed §6 clutter limits, `revert --builds` |
| Gestures invisible or confusable (consumer M7) | Fixed §5.5 (in-view only, distinct negatives) |
| Favouritism between two kids (consumer M8) | Fixed §5.4 (the least recent company) |
| About 330 hand-set numbers; no counterfactual (consumer 9) | §8 merge breakdown and `replay --data` |
| Criteria miss what a parent cares about (consumer 10) | Criterion 7 added |
| Backing off when the kid approaches (consumer 11) | Fixed §5.5 |

### Re-gate of rev 2 → rev 3

| Finding (lens) | Disposition |
|---|---|
| A straight deep staircase ends about 100 blocks from its entrance and the kid (consumer B1, engine N1, rigour M4) | Fixed §6.2: a 3×3 spiral with a final tunnel of ≤ 8 blocks; the leash is horizontal, on the entrance, at start and resume (§6) |
| No engine reaches criterion 2 (models B1) | Candidates added (§5.2: few-shot, `llm-dir-laya-stay`, one batched LLM call); §11 warns that the stop rule will probably fire |
| Decay oscillates and changes bands, making answers stale (rigour M1) | Fixed §4.1 (drift from value + pending, snap, band hysteresis); §3 `materialKey` excludes bands and decay by construction |
| Answers are stale whenever a kid builds (rigour M2) | Fixed §3 (plain edits bucketed; on a stale answer, the fallback, no retry) |
| `plannedEdits` undefined for Help-build, cave floors and replans (rigour M3, engine minor) | Fixed §6 table; criterion 8 extended |
| Urgent triggers can make the bot flip back and forth (rigour M5) | Fixed §5.3 limits; criterion 1 switch cap |
| Criterion 7's 12-block rule had no mechanism behind it (rigour M6) | Criterion 7 reworded to plan and replan time |
| Answer cache not reproducible (models M1) | Fixed §3.2 (temperature 0, seed), §4.3 rounded seconds, criterion 3 |
| Cost of `detect` not updated (models M2) | Fixed §5.2 cost table, one batched LLM call |
| Criterion 7 can't fail against an always-Help-build bonus (models M3) | Negative fixtures added to criterion 7 |
| Ollama unloads the model when idle (models m1) | Fixed §3.2 (`keep_alive: -1`, "not loaded" means load) |
| `isEdited` can't list cells; the 12-block rule is too costly (engine N2) | Fixed §4.5 kid-cell index; SDK `editedCellsInChunk` (§10) |
| Levelling order; floor fills unbudgeted; a 2-high staircase is unclimbable; liquid in digs; offline overwrite (engine minors) | Fixed §6.1, §6 table, §6.2 (3 high), §6.2, §4.5 (stated as a limit) |
| Greeting hidden when the kid arrives facing away (consumer M2) | Fixed §5.5 (held until the bot is in view, walks in front) |
| Grievance from R13 pushes the bot away over many sessions (consumer M3) | R13 kept. The R13 fixture is in criterion 7; the line bonus is sized to beat "very low" Grievance (§5.3) |
| The bot never builds again after 3 builds (consumer M4) | Fixed §6 ("standing" defined, **renew**) |
| `replay --data` overclaims (consumer M5) | Fixed §8 (labelled as a per-decision check) |
| Crouch gesture impossible; impatience reads as leaving; view check yaw-only; criterion 7 distance undefined (consumer minors) | Fixed §5.5, criterion 7 |
| Criterion 8 vs the 120 s cap; crash restart halving; `both-agree` scope and lane priority; unloaded `owned` chunks (rigour minors) | Fixed criterion 8, §4.2 `lastAlive`, §3.1, §3, §4.5 |

### Fresh check of rev 3 → rev 3.1

| Finding | Disposition |
|---|---|
| Renew never lowers the build count | Fixed §6: "standing" counts template cells holding the template's block; renew builds on a different site |
| Re-routing a spiral cuts the way out | Fixed §6.2: fill or end `stuck (gap)`; no re-routing inside a spiral |
| The switch cap has no runtime rule, and its test can't fail | Fixed §5.3 urgent governor; two-kid fixture in criterion 1 |
| The decay tests pass on the rev 2 formula | Fixed §4.1: sign test and patch-count test |
| Kid edits start appraisal bursts every ~3 s and saturate emotions | Fixed §5.1: plain edits salient only on a bucket change |
| Snap edge case; renew churn; overrun can't fire; R13 fixture loose; criterion 4 vs Help-build; cache hit rate; Mine budget; `EngineChoice` | Fixed §4.1, §6, §7.2, criteria 3, 4, 7 and 8, the §6 table, §3.1 |

### Narrow check of rev 3.1 → rev 3.2

| Finding | Disposition |
|---|---|
| A 20 s governor still allows 15 switches in 5 min | Fixed §5.3: a 30 s window plus a runtime limit of < 9 switches in 5 min; fixture at 4 cadences |
| Counting every rejected attempt halts Help-build | Fixed §7.2: count only plan-bound vetoes; reset on recompute |
| The decay tests can't go red on the old formula; the snap fix is untested | Fixed §4.1: snap-disabled variants and a d = 0.0105 test |
| The governor downgrades stop signals | Fixed §5.3: stop signals and hazards exempt |
| Mine's budget left out the target; `added-to-my-build` could still saturate | Fixed §6 table, §5.1 |
