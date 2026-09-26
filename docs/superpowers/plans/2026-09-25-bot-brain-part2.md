# Bot Brain (brain2) Implementation Plan, part 2: models and criteria

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the benchmark-chosen models behind the code-only brain from part 1, and measure the spec's end-to-end criteria.

**Prerequisites (hard):**
1. Part 1 (`2026-09-25-bot-brain.md`) is done through Task 19.
2. **Julien has made his Task 19 decision.** Don't start without it.

**Spec:** `docs/superpowers/specs/2026-09-25-bot-brain-design.md` (rev 3.3). Part 1's **Global Constraints** apply unchanged: read them first.

**Order:** Step 0, then Task 20, then Task 22.

---

## Step 0: Record Julien's decision

Write his choice into `bots/src/brain2/data/engines.data.ts`: each question's engine and wording, and the `measured` string (date, model, the numbers from `bots/bench/results/`). Commit it alone:

```bash
git add bots/src/brain2/data/engines.data.ts
git commit -m "chore(brain2): engine choice per Julien's benchmark review"
```

---

## Task 20: The model experts

Spec §5.2 (`appraise.detect[axis]` per the chosen engine and wording; `appraise.size`: one LLM call per burst, amount = clamp(|x|, 0.05, 0.4), the sign from detect, the axis enum of flagged ids, unflagged dropped, `because` ≤ 12 words), §5.3 (`select.social` split per kid and question, ≤ 60 words each, never shown the behaviour list; `select.situational`: the whole-state prose, output `{behaviour enum, params, because}`), §5.4 (`params.build` and `params.mine` through the LLM, validated), §7.1 (fit: only near kids, ≤ 60 words, `no` only when p(no) ≥ 0.6, ≤ 3 waits), R8, R15. Any question Julien left on `code` keeps its code expert.

**Files:**
- Create: `bots/src/brain2/experts/model/appraise-detect.ts`, `appraise-size.ts`, `select-social.ts`, `select-situational.ts`, `params-build.ts`, `params-mine.ts`, `fit.ts`
- Modify: `bots/src/brain2/brain.ts`:
  - register the model experts per `ENGINES`, replacing the code `appraise` expert with detect + size when `ENGINES.appraiseDetect !== 'code'`;
  - pass `fit.ts`'s function to the runner;
  - build the engines from `bots.config.ts` (Laya, and the `llm` entry): a `Health` polled every 10 s from `step()`, and `Laya.warmUp()` at start.
- Modify: `bots/src/cli-args.ts` / `cli.ts`: `--engines code|config`, where `config` (the default) reads `engines.data.ts` and `code` forces `{laya: null, llm: null}`.
- Modify: `bots/test/e2e.ts`: the leg `brain2-dead-engines` (moved here from part 1, since it needs the engines).
- Test: `bots/test/brain2/model-experts.test.ts`

**Interfaces:**
- Consumes: `render.ts` (Task 18), `ENGINES` (Task 19), `appraiseCode`, `APPRAISAL` (Task 15, as the fallbacks), `scoreRows` (Task 15), and the Task 14 `params*` (as fallbacks).
- Produces:
  - one `Expert` per file, each with `promptBudgetWords` where Laya is possible;
  - `fitFn(scheduler, ENGINES): FitFn`;
  - `Scheduler.request<T>(o: { name: string; lane: 'laya' | 'llm'; priority: number; run: (ctx: RunCtx) => Promise<T>; fallback: () => T }): Promise<T>`, a one-off job in a lane's priority queue. Fit uses priority 3, so it goes ahead of social (2) and appraisal (1) in the Laya lane, as spec §3 requires. It has the same timeout, health and no-retry rules as expert jobs, and logs one call line. Add it to `scheduler.ts`, with a test in `scheduler.test.ts`: `a request at priority 3 runs before queued priority-1 jobs`.

**Behaviour of each expert:**

`appraise.detect` produces a direction per axis: `down`, `stay` or `up`. It's written to `state.pendingAppraisal`, a new `State` field: `{ id, burst: WorldEvent[], flagged: Array<{ axis, dir }> } | null`. Its engines:
- **Laya three-way:** the question is "Does my ‹axis› go down, stay, or go up?". The options are `down`, `stay` and `up`, and `stay` wins when max(p) < 0.5.
- **Laya binary:** two calls, "More ‹hi› now?" and "More ‹lo› now?", each yes/no. The answer is `up` if yes(hi) ≥ 0.5 and yes(lo) < 0.5, `down` in the mirror case, and `stay` otherwise.
- **LLM batched:** one call covering every axis of the burst. Its schema is `{ "type": "object", "properties": { "<axisId>": { "enum": ["down", "stay", "up"] }, … }, "required": [...] }`.
- **LLM few-shot:** the same call with 4 labelled examples, one of them `stay`. Take them from the bench cases, never from test fixtures.
- **`llm-dir-laya-stay`:** Laya binary decides move-or-stay; the LLM decides the direction.

`appraise.size` runs `on(pendingAppraisal with flagged.length > 0)` and is LLM-only (code fallback: the `APPRAISAL` amounts).
- Its schema is `{ items: [{ axis: enum(flagged ids), amount: number, because: string }] }`.
- The merge does all of these:
  - amount = clamp(|x|, 0.05, 0.4), with the sign from the flagged `dir`;
  - drops an unflagged axis;
  - cuts `because` to 12 words;
  - calls `appraisalPatch`;
  - clears `pendingAppraisal`.

`select.social`:
- For each kid and each question (`near`, `help`), it asks one Laya question (or LLM, per `ENGINES.social`). The prompt holds only that kid's name, his 4 relation bands and ≤ 3 events involving him.
- `no`, `maybe` and `yes` map to 0, 0.5 and 1.
- It writes `selection.social`. The fallback is Task 15's code rule.

`select.situational`:
- The prompt is the whole-state prose: personality summary, emotion lines, relations, memory line, inventory, last salient events.
- Its schema is `{ behaviour: enum(the unmasked kinds), params: object, because: string }`.
- Invalid params are dropped; the merge keeps the behaviour, and the `params*` code fills the params.
- It writes `selection.situational`. The fallback is `'none'`.

`params-build` / `params-mine` are LLM only.
- The params schema restricts blocks to the enum of `WORLDGEN_BLOCKS` that are held or minable, excluding liquids, ores for build materials, and `CRAFTED_ONLY`.
- An invalid answer falls back to `paramsBuild` / `paramsMine`.

`fit`:
- It's asked only when a kid is within 8 blocks of the action's cell. The prompt follows spec §7.1's example shape.
- `no` requires p(no) ≥ 0.6; otherwise the higher of `wait` and `yes` wins.
- The runner already caps waits at 3.

- [ ] **Step 1: Write the failing tests** (`model-experts.test.ts`, fake engines with scripted answers):
  1. **Prompt budgets:** for every Laya-capable expert, render its prompt from `busyState()` and `assertBudget(prompt, 60, [the kid it's about], ALL_NAMES)`. Red if a renderer leaks the state or another player's name. For each expert, check that it goes red: temporarily append `memoryLine(state)` to its renderer, see the test fail, revert.
  2. **`appraise.size` merge (the Ollama bounds):**
     - `{axis:'rel.Noah.affection', amount:-0.5}` on a flagged `up` gives +0.4;
     - an unflagged axis is dropped;
     - an ambiguous `affection` (not an enum id) is rejected, and the fallback is used;
     - `because` is cut to 12 words.
  3. **`appraise.detect` wordings:** a binary yes(hi) 0.7 / yes(lo) 0.2 gives up; 0.7/0.7 gives stay; three-way max 0.45 gives stay.
  4. **Social:** each kid gets 2 calls; the prompts never mention the behaviour list (assert that no `BehaviourKind` word appears).
  5. **Situational:** a masked behaviour in the answer is rejected (the enum excludes it), and the fallback `'none'` is used.
  6. **Fit:** p(no) 0.55 with `wait` 0.3 gives `wait`; p(no) 0.62 gives `no`; nobody within 8 blocks means no call.
  7. **Engines down:** every expert falls back, and the brain keeps running (criterion 5 with the model experts registered).
  8. **Engines that always reject** (healthy, but every call rejects): 20 simulated minutes of `runBrain2`, behaviours keep changing, there are no unhandled rejections, and the log shows `fallback: true` calls (criterion 5; moved here from part 1's Task 17a).
- [ ] **Step 2: Run to see them fail.** Expected: FAIL.
- [ ] **Step 3: Implement** each file per the rules, add `pendingAppraisal` to `State` and `initialState`, and register per `ENGINES`.
- [ ] **Step 4: Run to see them pass.** Run `npm run bots:test`. Expected: PASS.
- [ ] **Step 4b: The dead-engines e2e leg.** In `brain2-dead-engines`, run `--engines config` with Laya pointed at `http://127.0.0.1:1` (closed), using a test copy of the config with that URL, passed the way `e2e.ts` already overrides targets. Over 60 s the bot keeps switching behaviours, and the log shows `fallback: true, reason: 'engine down'` calls.

Run: `BOTS_E2E_SCRATCH=$CLAUDE_JOB_DIR/tmp/e2e npm run bots:e2e -- --only brain2-dead-engines`. Expected: `ok`. Kill leftovers by port only.

- [ ] **Step 5: Re-run the benchmark** through the real experts' prompts (`npm run bot:bench -- --through-experts`, a flag `bench.ts` gains in this task, which uses the experts' own renderers). Confirm that the numbers match Task 19's within ±1 case. A larger gap means the experts' prompts drifted from the bench's.
- [ ] **Step 6: Commit**

```bash
git add bots/src/brain2/experts/model bots/src/brain2/brain.ts bots/src/brain2/types.ts bots/src/brain2/store.ts bots/src/brain2/scheduler.ts bots/src/cli-args.ts bots/src/cli.ts bots/bench/bench.ts bots/test/e2e.ts bots/test/brain2/model-experts.test.ts bots/test/brain2/scheduler.test.ts
git commit -m "feat(brain2): model experts per the benchmark's engine choice, all with code fallbacks (Task 20)"
```

---

## Task 22: The criteria harness, a 20-minute session, and docs

Spec §2 criteria 1, 3, 6 and 7 (the end-to-end measures), §9.1 (end-to-end), §10 (`--brain v2` switches over; the old tick is removed in a later cleanup, not here).

**Files:**
- Modify: `bots/test/e2e.ts`: leg `brain2-session`, 20 minutes with the scripted kid (criteria 1, 4, 7 and 8)
- Create: `bots/test/brain2/criteria.test.ts` (criteria 3 and 6, offline on the answer cache), `bots/test/fixtures/answer-cache.json` (recorded, committed)
- Modify: `bots/README.md` (a brain2 section: running, the TUI, replay, the bench, personalities, tuning with `--data`), `docs/superpowers/specs/2026-09-25-bot-brain-design.md` (status: implemented, with the plan's commit range), `CLAUDE.md` (one line under Repo State: `bots/src/brain2/` is the emotional brain, `--brain v2`)

**Criteria:**
- **Criterion 1 (e2e):** over the 20-minute session, every switch has a `select` line with a reason; no switch comes < 20 s after the previous one unless it's an outcome or urgent; ≤ 10 switches in every 5-minute window, **not counting** switches caused by an outcome, a stop signal or a hazard (spec criterion 1).
- **Criterion 3 (offline).** How it runs:
  - A fixed **world script** plays on a `FakeBody`/`FakeWorld` with a `ManualClock`: the same `kid-client` script as criterion 7, expressed as scripted `player()` poses and `EditEvent`s per 100 ms tick. It lives in `bots/test/brain2/kid-script.ts`, and its output is the same for any bot.
  - `runBrain2` (`manual: true`) runs 20 simulated minutes for **Pip**, then for **Rex**, each on a fresh world copy.
  - The engines are wrapped by the committed `AnswerCache` in `replay-or-live`.
  - The time share per behaviour is the sum of `memory.past[].lastedMs` plus the current behaviour's time, divided by 20 min.
  - **Assertions:** ≥ 2 behaviours differ by more than 20 points of time share, and the cache hit rate is ≥ 95%.
  - **Recording the cache:** run this test once with the live models, which records **both** personalities' prompts. Pip-only recording from the session leg would leave Rex's prompts uncached (gate 2). Then commit `bots/test/fixtures/answer-cache.json`.
- **Criterion 6 (offline):** for every `select` line in the session log, `framesFromLog` reaches that point, and the call lines behind its social and situational inputs are found by `selection.id`.
- **Criterion 7 (e2e):**
  - the kid script (wander 3 min, lay 2 lines of 6 blocks, stand watching 3 min, fly around 2 min, repeat);
  - ≥ 60% of the time within 16 blocks, 3D, as a tuning target: report the number, and fail only below 40% so a bad design is still caught;
  - Help-build ≥ 80% on the line fixtures and ≤ 20% on the not-a-line fixtures, from the Task 15 selection tests re-run with the engines chosen in Task 19 (models up) and with code (models down);
  - every site, dig entrance and route is ≥ 12 from kid cells at plan time (asserted from the log's plan events).

- [ ] **Step 1: Write `criteria.test.ts`** (criteria 3 and 6), and the `brain2-session` leg (criteria 1, 4, 7 and 8).
- [ ] **Step 2: Record the answer cache.** With the live models up (Laya on `LAYA_MODELS=english`, and Ollama), run `criteria.test.ts` once with `BRAIN2_CACHE=record`: `AnswerCache` records every miss for both personalities. Stop the models afterwards (Laya by port, Ollama `keep_alive: 0`), then run it again **without** the models. It must pass entirely from the cache.
- [ ] **Step 3: Run everything**

Run: `npm run bots:test && BOTS_E2E_SCRATCH=$CLAUDE_JOB_DIR/tmp/e2e npm run bots:e2e -- --only brain2-help,brain2-alone,brain2-dead-engines,brain2-session`
Expected: PASS. Report the criterion 7 near-time percentage and the criterion 3 shares in the commit message.
- [ ] **Step 4: Write the docs** (README section, spec status, CLAUDE.md line).
- [ ] **Step 5: Commit**

```bash
git add bots/test/e2e.ts bots/test/brain2/criteria.test.ts bots/test/fixtures/answer-cache.json bots/README.md docs/superpowers/specs/2026-09-25-bot-brain-design.md CLAUDE.md
git commit -m "test(brain2): criteria harness and 20-minute session; docs (Task 22)"
```
