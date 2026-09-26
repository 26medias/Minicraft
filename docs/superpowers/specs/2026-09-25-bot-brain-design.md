# Bot brain: emotions, behaviours and a blackboard of experts

**Status:** design, rev 1, 2026-09-25. It has not been through gate 1 yet. It was brainstormed with Julien on 2026-09-25. Branch `bot-brain`, cut from `bots` at `b70cc3a`.

**It replaces:** the decision part of the companion bot (`docs/superpowers/specs/2026-09-25-companion-bot-design.md`), which is the 500 ms tick in `bots/src/bots/companion.ts` that picks one of `follow | watch | help_build | wander | idle`. The **body** stays: the `minicraft-bot` SDK, `bots/src/port.ts`, follow/fly/hop movement, the guard, the stop signal, config and safety refusals.

**Why:** the one-shot companion's brain barely decides anything. Laya leans heavily toward `watch`, and so `follow` and `help_build` became hard rules (`bots/README.md:145-158`). Julien had too little say in its logic. This design is his model of the bot, made concrete.

## 1. The rulings from brainstorming

Each ruling is Julien's answer, with the alternatives he turned down.

| # | Question | Ruling | Turned down |
|---|---|---|---|
| R1 | Models | **Laya + a small local generative LLM.** The LLM runs on events, never on every tick. Local only, no Jev. | Laya only; not tied to a model |
| R2 | How the bot shows its state | **Body language only.** No game or server change, and no emote bubbles or speech in this project. | Emote bubbles; spoken lines |
| R3 | Where the bot may edit on its own | **Any natural terrain.** It never touches a kid-placed or kid-modified block, and keeps a 1-block buffer around them. | Its own plot only; anywhere with the stop signal as the only brake |
| R4 | Memory across sessions | **Relationships, inventory, builds, explored areas and personality persist** in a local file. Global emotions and the action log start fresh. | Nothing persists; everything persists |
| R5 | Behaviours in v1 | **Follow, Help-build, Build, Mine (including for no reason), Explore, Watch, Rest.** Greeting is a gesture. Show-off and Avoid are out. | — |
| R6 | Materials | **The bot has an inventory in every world, fed only by mining.** | Kids' rules only in must-mine worlds; no inventory |
| R7 | Architecture | **A blackboard with event-triggered experts** (§3). | An orchestrator LLM delegating to sub-agents; utility AI with models at the edges |
| R8 | Laya prompts | **Short, single-purpose questions.** Laya gets less accurate as prompts grow, so split into many focused calls, never one big one. | — |
| R9 | Selection merge | **Fixed weights.** The LLM's pick is one weighted vote, not the final call. (This is the default Julien didn't override.) | The LLM has the last word |
| R10 | Build shapes | **Hand-made templates as data.** The LLM picks the template, the size and the materials. (Default, not overridden.) | LLM-designed shapes |
| R11 | Edit limits | **No per-session cap.** Edits are bounded by the plan they belong to, plus a runaway tripwire (§7.2). | A 50 or 400 edit budget per session |

**Non-goals.** No chat or text, no emotes (R2), no game or server changes, no combat or mobs, no deployment: the bot runs on Julien's machine only. No pathfinding beyond what §6 needs; walking, flying and staircases stand in for it. This design leaves `CLAUDE.md`'s product non-goals alone. The bot's own building and mining is a companion feature, not a new game mechanic.

**Scope changes compared with the companion spec, all explicit:** the bot now mines (companion spec: "no mining help"), keeps memory across sessions (companion spec: "no memory across sessions"), and has an inventory.

## 2. Success criteria

The design has succeeded if all of these hold. The plan must turn each one into a test or a measured check.

1. **Behaviour reads as alive, not random.** Across a recorded 20-minute session with one kid:
   - No behaviour lasts less than its minimum time (§5.4), unless an urgent trigger interrupts it.
   - Every switch has a logged reason.
2. **Emotions move the right way.** On a hand-labelled set of at least 40 (event, axis) cases, `appraise.detect` gets the direction (down, none or up) right in ≥ 80% of them. The set is committed as a fixture. It also runs against the live Laya as a measured benchmark, not in CI.
3. **Different personalities behave differently.** Take two personalities, run them through the same replayed event stream, and compare the time they spend in each behaviour. At least 2 behaviours must differ by more than 20 points of share.
4. **Kid safety holds.** No edit ever lands on a kid-modified cell or its buffer, in water or lava contact, or under a player. This is property-tested against the safety tier, and asserted in every end-to-end run.
5. **It never freezes.** With Laya down, the LLM down, or both down, the bot keeps choosing behaviours and acting, using the code fallbacks.
6. **The debug view explains any decision.** From the replay of a session you can reach, for any behaviour switch, the exact prompts and answers that caused it.

## 3. Architecture

```
          SDK events (edits, fx, players, poses)
                      │
   ┌──────────────────▼───────────────────┐
   │ L0 perception (code, 500 ms)          │──► world events
   └──────────────────┬───────────────────┘
                      ▼
   ┌─────────────────────────────────────────────┐
   │              STORE (blackboard)              │◄── every write is store.apply(patch, cause)
   │ personality · emotions · relations · memory  │    and emits change events
   │ events · inventory · builds · explored ·     │
   │ body · active behaviour                      │
   └──┬──────────┬───────────┬───────────┬───────┘
      │ change   │           │           │
      ▼ events   ▼           ▼           ▼
   L1 decay   L2 appraisal  L3 selection  L5 expression
   (code)     (Laya+LLM)    (code+Laya+LLM) (code)
                               │
                               ▼
                     L4 active behaviour
                  plan → planner → judge → execute ──► SDK
```

- **The store** is the single source of truth. Experts never call each other. They read a slice of the store and propose a patch. Only `store.apply` mutates state, and every mutation produces a **change event** `{path, old, new, cause, t}`.
- **The scheduler** runs experts when their trigger matches. It gives Laya one call at a time (Laya has a single worker). LLM calls go through one priority queue: selection, then appraisal, then parameters. Each expert records the **state version** of the slice it read. If that slice has changed materially by the time the answer arrives, the answer is thrown away and the expert may run again.
- **Model answers are proposals.** Each expert's `merge` step is code: it clamps, bounds and validates. A malformed or out-of-range answer counts as a failure and the expert's fallback is used.

### 3.1 The expert contract

```ts
interface Expert<S, P> {
	name: string;
	layer: 0 | 1 | 2 | 3 | 4 | 5;
	trigger: Trigger;                       // every(ms) | on(pattern) | debounce(on(pattern), ms)
	reads(state: State): S;                 // the only view the expert gets
	engine: 'code' | 'laya' | 'llm';
	run(slice: S, signal: AbortSignal): Promise<P>;
	merge(proposal: P, state: State): Patch;  // pure code: clamp, bound, validate
	fallback(slice: S): P;                  // used when the model is down, slow or invalid
	promptBudgetWords?: number;             // required for engine 'laya' (R8)
}
```

- Every expert is tested on its own against fixed slices.
- Every Laya expert has a **prompt-budget test**: its prompt is rendered from a deliberately busy state (8 players, 30 events, a long history) and must stay within `promptBudgetWords`. The test must fail if a renderer starts including the whole state. The plan must show that the test goes red on a renderer that leaks the state.

### 3.2 Engines

- **Laya:** today's `systemone` adapter (`bots/src/brain/systemone.ts`), unchanged. `choice` questions return probabilities over options. Timeout 400 ms. The confidence used is max(p), as today.
- **LLM:** a 3–4B instruct model with JSON-schema-constrained output, served locally by Ollama or vLLM. Timeout 5 s. The first task in the plan is a **measurement**:
  - Does it fit alongside Laya (about 5.7 GiB) on the 10 GB RTX 3080?
  - What is its p50 and p95 latency on this design's three prompt shapes?

  If it doesn't fit, try a smaller model, then Laya on CPU, and record the numbers either way. The model name and endpoint are config, not code.
- **Code:** it is the default engine, and every model expert's fallback.

## 4. The state

```ts
interface State {
	personality: Personality;           // data, persisted
	emotions: Record<GlobalAxis, AxisState>;
	relations: Record<PlayerName, Relation>;   // persisted
	memory: { current?: ActionEntry & { startedAgoS: number }; past: ActionEntry[] };  // last 20
	events: WorldEvent[];               // last 60 s or 30 entries
	inventory: Record<BlockName, number>;      // persisted
	builds: Build[];                    // persisted
	explored: Set<ChunkKey>;            // coarse, persisted
	body: { pose: Pose; gesture?: Gesture };
	behaviour?: ActiveBehaviour;
	version: number;                    // incremented by every apply
}
```

### 4.1 Global emotions

These are Julien's axes. The value is in [−1, 1], and zero has a specific meaning on each axis.

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

`AxisState = { value, deltas: {amount, cause, agoS}[] }`. It keeps the last 10 deltas. **Decay** is exponential toward the personality's baseline, using that personality's half-life. Personality can override every baseline and half-life.

### 4.2 Relations (per player)

These are Affection, Cooperation, Respect and Grievance (−1 resentful, +1 grateful), in [−1, 1]. Each has the same delta list, plus `metSessions`, `minutesTogether` and `lastSeenAgoS`.

- **Within a session**, they decay toward 0. Grievance has a 30 min half-life; the others have 4 h.
- **Between sessions**, loading the file moves each axis halfway back to 0.
- **Players are keyed by name.** Bots (🤖) never get a relation entry.

### 4.3 Action memory

`ActionEntry = { behaviour, params, lastedS, outcome: 'done' | 'abandoned' | 'interrupted' | 'failed', why }`. Models never see timestamps (Julien's rule). A shared renderer prints the memory as text:

> Now: Explore, started 12 s ago. Before: Build tower 94 s (done). Follow Noah 40 s (interrupted: Noah flew away).

### 4.4 World events

**Perception** writes these event kinds:
- `placed`, `broke` (with the actor and the cell)
- `player-near`, `player-left`, `player-arrived`, `player-gone`
- `broke-my-block`, `added-to-my-build`
- `following-me`, `looking-at-me` (≥ 2 s)

**Behaviours** write these:
- `found`, `need`, `stuck`, `hazard` (liquid or a drop)
- `outcome`

Every event has `agoS`, and a `salient` flag set by the `salience` expert (§5.1).

### 4.5 Persistence (R4)

The file is `bots/.state/brain/<target>/<world>/<bot>.json`. It holds `personality`, `relations`, `inventory`, `builds` and `explored`, plus a `schemaVersion`. It's written atomically (a temp file, then a rename) on every change to those fields, debounced to 5 s, and on exit. An unreadable file is renamed to `.bad-<ts>` and the bot starts fresh; it never crashes. Emotions, memory and events are never persisted.

**Natural vs. modified cells (R3).** The SDK runs the game's own world generator. A cell whose current block differs from the generator's output has been modified. A modified cell is the **kid's** unless it's in the bot's own persisted `builds` or journal. A pure `isNatural(cell)` in the body layer computes this from the world and the bot's records, so it also covers edits made before the bot ever joined.

## 5. The experts

### 5.1 Layers 0–1: perception and drift (code)

| Expert | Trigger | What it does |
|---|---|---|
| `perceive` | every 500 ms, plus SDK edit and fx events | Turns SDK events and pose diffs into `WorldEvent`s. Reuses `bots/src/body/perceive.ts` where it fits. |
| `salience` | on new events | Marks an event salient when it: involves the bot, its builds or its inventory; involves a player within 16 blocks; is a find, need, stuck, hazard or outcome; or is a player arriving or leaving. The rules are data. |
| `decay` | every 500 ms | Exponential pull toward baselines (§4.1, §4.2). Writes no change event below 0.01 of movement, so decay alone never wakes the appraisal experts. |

### 5.2 Layer 2: appraisal (R8: many short calls)

**`appraise.detect[axis]`** (Laya, one instance per axis). It's triggered by `debounce(on(salient event), 1 s)`.
- It runs once for each of the 8 global axes, and once for each of the 4 relation axes of every player involved in the burst.
- It sees only:
  - that axis's name and its meaning at −1 and +1;
  - the current value, as a word band plus the number;
  - its last 2 deltas;
  - the 1–3 salient events of the burst, as short sentences.
- It is asked: **"Does my ‹axis› go down, stay, or go up?"**
- Budget: **60 words**. Answers where max(p) < 0.5 count as `stay`.
- A burst costs about (8 + 4k) × 14 ms, which is ≈ 0.3 s for k = 1.

**`appraise.size`** (LLM, one call per burst). It covers all axes that `detect` flagged. Input: the flagged axes with their directions, the burst's events, the personality in one sentence, and the current values. Output (JSON schema): `{axis, amount ∈ [0.05, 0.4], because: string ≤ 12 words}[]`. The merge does three things:
- It applies the direction from `detect`, not from the LLM.
- It clamps each amount to 0.4.
- It clamps each value to [−1, 1].

Fallback: a code table, `event kind × axis → amount`. It's also the fallback for `detect`.

### 5.3 Layer 3: selection

**Triggers:**
- The behaviour finishes, fails or is abandoned.
- The emotions move a lot: Σ|Δ| > 0.5 within 10 s.
- `player-arrived` or `player-gone`.
- A stop signal.
- `hazard`.
- Every 30 s, a **keep-going check**: Laya is asked "Keep doing ‹behaviour›, or do something else?" with the memory line and at most 2 emotion lines (budget 50 words). A `keep` answer ends the check there.

**The three passes run in parallel:**

1. **`select.emotional`** (code). A data table gives each behaviour weights over the emotions and relations, e.g. `Explore: +0.5·Curiosity −0.3·Stimulation +0.2·Confidence`. Output: a score per behaviour.
2. **`select.social`** (Laya, split per R8). For each player present, it asks two questions:
   - "Do I want to be near ‹name› right now?" (no / maybe / yes)
   - "Does ‹name› seem to want help?" (no / maybe / yes)

   Each prompt is ≤ 60 words and holds that player's 4 axes and ≤ 3 recent events involving them. Code turns the answers into scores for Follow, Watch and Help-build per player. **Laya is never shown the list of behaviours.**
3. **`select.situational`** (LLM). The whole-state prose: the personality, the emotions as words, the relations, the memory line, the inventory and the last salient events. Output (JSON schema): `{behaviour, params, because}`. This is the only pass that sees everything.

**`select.merge`** (code) adds four inputs with fixed weights (R9, in data): `emotional`, `social`, `situational` (a one-hot vote), and `inertia`.
- **Inertia** favours the current behaviour in proportion to `startedAgoS`, up to its typical length.
- It penalises behaviours done in the last 5 minutes, and especially ones that were `abandoned` or `failed`.
- Behaviours that aren't feasible are masked out: no players means no Follow, and no materials means no Build unless Mine can supply them.
- The winner takes its params from `situational` if the LLM picked it too. Otherwise `params.<behaviour>` fills them in (§5.4).

**Minimum time in a behaviour:** 20 s. Only these interrupt sooner: a stop signal, `hazard`, `player-gone` for the behaviour's target, or a failed outcome.

### 5.4 Parameter experts

| Expert | Engine | Output |
|---|---|---|
| `params.build` | LLM | template, variant, role → block mapping, restricted to templates the inventory can cover once Mine is counted |
| `params.mine` | LLM, or the `need` event | block type |
| `params.player` | code | the player with the highest affection among those present, unless the LLM named one |
| `params.explore` | code | the least-explored direction, leashed to 64 blocks from the nearest player |

### 5.5 Layer 5: expression (code, R2)

**Style** is computed continuously from the emotions and applied by the body:
- Walking speed and pauses come from Stimulation and Mood.
- How often it looks around comes from Curiosity.
- Its preferred distance from players comes from Confidence and Affection.
- It hops between steps when Stimulation and Mood are both high, and walks slower with a lowered pitch when Mood < −0.4.

**Gestures** are short reactions (≤ 2 s) that pause the behaviour and then resume it. They're triggered by emotion deltas, at most one every 5 s, and the table is data:

| Change | Gesture |
|---|---|
| Mood +≥ 0.3 | double hop; a `firework` fx if the cause is a finished build |
| Mood −≥ 0.2 | stop, look down 1.5 s |
| Confidence −≥ 0.2 | back off 2 blocks from the event's cell or player |
| Affection toward P +≥ 0.15 | turn to P, hop |
| Grievance toward P −≥ 0.2 | turn away from P |
| Curiosity +≥ 0.2 | turn toward the event, pause 1.5 s |
| Patience < −0.5 and a failed outcome | 3 quick hops |
| `player-arrived` with Affection ≥ 0.3 (greeting) | turn, walk 2 blocks toward them, hop |

## 6. The behaviours

Every behaviour is a module:

```ts
interface Behaviour<P> {
	kind: BehaviourKind;
	plan(params: P, state: State): Promise<Plan>;   // may use the LLM
	next(plan: Plan, state: State): Action | 'done' | { failed: string };  // code
	judgeFit?(action: Action, state: State): FitQuestion | null;  // null: no Laya fit check
	typicalS: [number, number];
}
```

| Behaviour | Plan | Next action | Done | Failed |
|---|---|---|---|---|
| **Follow {P}** | none | today's standing-intent follow; the distance comes from style | selection moves on | P gone |
| **Help-build {P}** | today's line detector | the next cell in the kid's line, from the bot's inventory | the kid stops (no placement in 15 s) | short of the block, which also writes `need` |
| **Build {template}** | `params.build`, then a site search (code): flat natural ground whose footprint and 1-block margin are all natural, within 48 blocks of a player | the next template cell, bottom-up then in template order; walk or fly within reach first | every cell placed; the build is persisted | a site cell turns out modified, which triggers a replan; no site within 48 blocks; materials run out, which writes `need` |
| **Mine {block}** | a target chosen with the world generator's knowledge (the nearest reachable one, but not through kid-modified cells); a walkable staircase toward it | the next staircase cell (break it), then the target | got N (default 8) of them, or 90 s passed | a hazard on the route; stuck 3 times |
| **Explore** | a direction from `params.explore`; waypoints every ~12 blocks | walk or fly to the next waypoint; look at salient things | 60–120 s, or a `found` event | stuck 3 times |
| **Watch {P}** | none | stay at the style distance, look at what P looks at or edits | 30–60 s | P gone |
| **Rest** | the latest build, or where it stands | go there, idle, look around slowly; Stimulation drifts toward 0 twice as fast | 30–90 s | — |

Everything the bot breaks is added to its inventory. Every placement takes one from it.

**Builds** are recorded in `builds` as `{template, variant, origin, cells, status}`. A kid adding a block adjacent to a bot build, in the build's footprint box, produces `added-to-my-build`.

**Templates** live in `bots/src/brain/templates.data.ts` (R10): cells relative to an origin, each with a role (`wall`, `roof`, `floor`, `accent`, `door-gap`). The first set:
- house 5×5×4
- wall 7×3
- tower 3×3×8
- statues: a creeper, a person, a heart

Each comes in small and medium.

## 7. The planner → judge → execute loop and safety

```
plan once → loop { planner.next → judge → ok ? execute → result event : back to planner (with reason) }
3 rejections in a row, or 3 failed executions of the same action → the behaviour fails
```

### 7.1 The judge, in three tiers

1. **Safety** (code, a hard veto that nothing overrides). Today's rules stay, plus the new ones:
   - no edit on a non-natural cell (`isNatural`, §4.5) or within 1 block of one, except Help-build, which works on the kid's line under today's rules;
   - the 1-block buffer around every kid, and nothing inside a kid's body;
   - no breaking a cell that touches water or lava, and no breaking under a player (any cell within 1 block horizontally and at or below their feet down to 3 below);
   - the stop signal: after a kid breaks a bot block, no edits near that kid for 10 minutes;
   - a minimum gap between edits, 0.6 s;
   - `--no-edits`;
   - placing needs inventory > 0;
   - **plan-bound** (R11): every edit must be an action the active plan owns.
2. **Sense** (code). Is the action still valid? The target must still be reachable, the cell still air (to place) or still the expected block (to break), and it must not be the same failed action a 3rd time.
3. **Fit** (Laya, optional). It's asked only when a player is within 8 blocks, or when the action touches a cell a player is looking at. Question (≤ 60 words): "‹personality in ≤ 8 words, relevant emotion›. ‹P› is ‹d› blocks away, ‹doing›. I'm about to ‹action›. Should I?" The answers are **no** (reject), **wait** (pause 2–4 s, then retry) and **yes**.

### 7.2 Runaway tripwire (R11)

Any of these **halts all edits for the rest of the session**:
- more than 30 edits in 60 s;
- the same cell edited 3 times;
- an edit refused as not belonging to the plan.

The halt shows in the debug view and the log, and the bot keeps running with edits off. The SDK journal keeps every edit, so `revert` can still undo a session.

### 7.3 Interruptions

- A gesture pauses the loop and resumes it afterwards.
- A selection switch stops the loop after the current action. A walk is cancelled with `move(pose())`, as today. The old behaviour's outcome is `interrupted`.

### 7.4 Pacing

The gap between actions comes from style: 0.6 s (excited) to 2 s (calm). The safety tier enforces the floor.

## 8. The debug view, logs and replay

- **`--tui`**: a live terminal view, plain ANSI redraw at 4 Hz with no UI framework. It shows:
  - a header with the model health and latency, and the LLM queue depth;
  - emotion bars with a baseline marker, the value, and the last delta with its cause and age;
  - the relations table;
  - the active behaviour with plan progress, the last judge verdict per tier, and the memory line;
  - the inventory;
  - the expert feed, newest first: expert, engine, latency, prompt word count, answer, and the patch it produced.
- **The log** is one JSONL line per change event and per expert call. An expert-call line holds the exact prompt, the answer, latency, fallback use and the merged patch. It replaces today's per-tick log. The folder is `bots/.state/logs/…`, as today.
- **`npm run bot:replay <log>`** renders a recorded session in the same view. Space pauses, ←/→ steps, and `e` shows the full prompt and answer of the highlighted call.
- **Poke keys** (`--tui` only, refused when the target is the live server): set an emotion axis, or inject an event from a menu ("‹player› broke my block", "found diamond").

## 9. Testing

- **Experts:** each is tested alone on fixed slices. The model engines are faked with recorded answers. Every Laya expert has a prompt-budget test (§3.1).
- **Merge, decay, salience, safety, `isNatural`:** pure code. Safety is **property-tested**: random worlds, kid-modified sets and plans, asserting criterion 4.
- **Scheduler:** replays a recorded event stream with recorded model answers, deterministically, with no GPU. It checks triggers, debounce, stale-answer discard and the fallbacks, with one engine and then both engines down (criterion 5).
- **Personality divergence:** criterion 3, on a replayed stream.
- **The appraisal benchmark:** the labelled set (criterion 2) is a fixture. The benchmark script runs it against the live Laya and prints the accuracy per axis. It's measured, not in CI.
- **End-to-end:** the local `mcserver` on a temp database, as today (`bots/test/e2e.ts`). There's one scenario per behaviour, plus a mixed 5-minute session that asserts criteria 1 and 4.
- **The instrument rule:** each test in the plan names the defect that turns it red and the build it was seen to fail on. A test that can't go red doesn't count.

## 10. Layout

```
bots/src/brain2/
	store.ts            state, apply, change events, versions
	scheduler.ts        triggers, Laya lane, LLM priority queue, stale discard
	engines/laya.ts     wraps brain/systemone.ts
	engines/llm.ts      Ollama/vLLM JSON-schema client
	experts/            perceive, salience, decay, appraise-detect, appraise-size,
	                    select-*, params-*, react
	behaviours/         follow, help-build, build, mine, explore, watch, rest
	judge.ts            safety / sense / fit tiers, tripwire
	render/             the shared text renderers for prompts (memory line, emotion words)
	persist.ts          the memory file
	tui.ts, replay.ts
	*.data.ts           personalities, emotion→behaviour weights, gestures, salience rules,
	                    templates, appraisal fallback table, merge weights
```

It goes in `brain2/` so today's companion keeps working until the new brain passes its end-to-end runs. The companion switches over with `--brain v2`, and the old tick is removed in a later cleanup.

## 11. Open items for the plan

- The LLM model and whether it fits (§3.2): task 1 measures it.
- The starting weights (merge, emotional table, gestures) are guesses. They get tuned against replays, and each tuning is logged with its before and after numbers.
- The labelled appraisal set needs about 40 cases. Julien should look over the labels, since they encode what he means by each axis.
- Mine's target choice uses the world generator's knowledge (x-ray). The staircase makes it look natural, but the kid can't do the same. That's accepted for v1 and flagged here for review.
