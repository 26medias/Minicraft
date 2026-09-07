# Scheduled play with a grown-ups PIN — design

**Date:** 2026-09-07
**Status:** draft, pending gate 1
**Builds on:** `docs/superpowers/specs/2026-09-06-play-time-limit-design.md`, `docs/playtime.md`

## Problem

Noah was found playing at 5 a.m. The play-time limit only bounds how long a
session lasts, not when it may start, and its controls sit unguarded on the
menu the kid uses.

## Goal

Before bed, Julien opens the menu, unlocks the Grown-ups section with a PIN,
picks Noah's world, sets "Play for 45 minutes" and "Not before 07:00", and
presses Arm. Until 07:00 the menu shows one locked card with a countdown.
From 07:00 a Play button loads that world and the 45 minutes run from then, with
the existing warnings, freeze, and break behaviour. Nothing on the kid's side
changes the schedule without the PIN.

## Non-goals

- No daily repeating window and no end-of-day time. The schedule is armed once
  and stays in force until a grown-up changes it. (A repeating window is a
  natural follow-up; nothing here prevents it.)
- No cloud sync of the schedule or PIN; both live in this browser's
  `localStorage` like the other options.
- No cryptography. The PIN is four digits stored in plain text. It stops a
  seven-year-old, not a teenager with devtools.
- No change to in-game behaviour, the overlay, the world save format, or the API.
- No change to the world Delete buttons or the Options screen.

## Definitions

- **Schedule**: the parent's armed choice: world, limit, break, start time.
- **Locked card**: the single-button menu shown while a schedule is armed.
- **Grown-ups section**: the parent controls; opened with the PIN when one is
  set, open by default when none is set.
- **Session**: the existing `PlaytimeSession` record (play time used, freeze).

## Persisted data

### `minicraft:v1:schedule` (new)

```ts
export type Schedule = {
	worldId: string;
	seed: number;
	name: string;
	limitMin: number;          // member of PLAY_LIMIT_CHOICES_MIN
	breakMin: number | null;   // member of PLAY_BREAK_CHOICES_MIN, null = until a grown-up unlocks
	startMin: number;          // minutes after local midnight, 0..1439, what the parent typed
	notBefore: number;         // epoch ms: the first occurrence of startMin strictly after armedAt
	armedAt: number;           // epoch ms
};
```

A record failing validation (missing field, wrong type, `limitMin`/`breakMin`
not in the choice lists, `startMin` outside 0..1439, non-finite times) loads as
`null`, which means "no schedule". Absent key: `null`.

### `minicraft:v1:options` (extended)

`parentPin: string | null`, validated with `/^\d{4}$/`, default `null`.
`playLimitMin` / `playBreakMin` stay for the unscheduled mode.

### `minicraft:v1:playtime` (extended)

`PlaytimeSession` gains `startedAt: number` (epoch ms when the session was
created). Loader: a stored record without it gets `startedAt = updatedAt`.

## Time rules

All in `src/game/schedule.ts`, pure, no DOM, no storage, every function takes
`now`.

- `nextOccurrence(startMin, from: number): number` returns the epoch ms of the
  first local-time `startMin` strictly after `from`. Implemented with `Date`
  local getters/setters (`setHours(h, m, 0, 0)`), so DST is whatever the
  browser says. Armed at 22:00 with 07:00 → tomorrow 07:00. Armed at 06:00
  with 07:00 → today 07:00. Armed at exactly 07:00 → tomorrow 07:00.
- **Session expiry with a schedule.** The 12-hour stale rule
  (`STALE_SESSION_MS`) does not apply while a schedule is armed: a no-break
  lock must not lift itself overnight, because that is exactly the 5 a.m.
  hole. `sessionInForce(session, schedule, now)` is:
  - no schedule → `!isStale(session, now)` (unchanged behaviour);
  - schedule → `session.startedAt >= schedule.notBefore` and the clock-set-back
    guard from `isStale` (`session.updatedAt > now + MAX_TICK_CREDIT_MS` →
    not in force). A session that started before the current `notBefore`
    belongs to a previous arming and is discarded, so re-arming is a clean
    slate.
- `phaseOf` and the `PlayTimer` are unchanged.

## Menu states

`menuModel(schedule, session, options, worlds, now)` in `src/ui/menu-model.ts`
(pure, tested) returns what to render. `menu.ts` renders it and re-runs the
model every second while the menu is visible.

### No schedule armed

Today's menu: New World, world lists, and the Grown-ups section at the bottom
(which now holds the Play time controls). No countdown timer runs.

### Schedule armed

The world lists and New World are not rendered. The card is:

```
Minicraft
Noah's World
45 minutes of play · not before 7:00
[ ▶ Play ]
Grown-ups ▸
Options
```

The Play button's state comes from the model:

| Condition | Line under the world name | Button |
|---|---|---|
| `now < notBefore` | `Play at 7:00 · in 1 h 52 min` | disabled |
| ready, no session in force | `45 minutes of play` | **Play** |
| session in force, phase playing | `12 minutes left` | **Play** (continues) |
| phase break, timed | `Break · 7 minutes left` | disabled |
| phase break, no break set | `Locked · ask a grown-up` | disabled |
| phase over | `45 minutes of play` | **Play** (fresh session, as PLAY AGAIN does today) |
| world id not in the world list | `World not found · ask a grown-up` | disabled |

Countdown text: `in N h M min` when ≥ 1 h, `in M min` otherwise, `in 1 min`
floor; minutes rounded up. Time text uses the browser locale's short time
(`toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })`).

Pressing Play fires the existing `{ type: 'continue', id, seed }` action.

While the world list is loading (cloud can be slow), the card renders with
the button disabled and `Loading…`; the model treats `worlds === null` as
loading, distinct from an empty list.

### Grown-ups section

Collapsed by default as a single `Grown-ups` button under the card (or under
the world lists when nothing is armed).

- **No PIN set:** pressing it opens the section immediately. At the top a
  row: `Set a PIN so only grown-ups can change this` with a 4-digit input and
  **Set PIN**. Everything below works without a PIN, as today.
- **PIN set:** pressing it shows a 4-digit input (`type="password"`,
  `inputmode="numeric"`, `maxlength=4`, `autocomplete="off"`) and **Open**.
  Right PIN opens the section for as long as the menu stays rendered (a new
  world start or reload closes it). Wrong PIN: `Wrong PIN` under the input,
  input cleared; no lockout, no delay.

Open section contents, top to bottom:

1. PIN row: **Change PIN** (new 4-digit input + Save) and **Remove PIN**.
2. **World**: dropdown `Any world (no schedule)` plus every world from both
   lists, `name (seed)`. Default: the armed world, else `Any world`.
3. **Play for**: as today (Off, 15…90). When a world is chosen, `Off` is not
   offered (a schedule without a limit is meaningless); default 45 if the
   stored value is Off.
4. **Then break for**: as today, shown when Play for is not Off. Its null
   option reads `Until a grown-up unlocks`.
5. **Not before**: `<input type="time" step="900">`, shown only when a world
   is chosen. Default: the armed `startMin`, else `07:00`.
6. Buttons: with a world chosen, **Arm** (or **Re-arm** when a schedule is
   armed) and, when armed, **Turn off**. With `Any world`, the controls save
   on change exactly as today and there is no Arm button.
7. Status row and **Unlock** / **Start fresh**: as today, now inside the
   section. `Unlock` clears the session only; the schedule stays armed. That
   is the "give him ten more minutes" path: Unlock, then Play.

**Arm** writes the schedule (`notBefore = nextOccurrence(startMin, now)`,
`armedAt = now`), clears the session, and re-renders the card. It does not
touch `playLimitMin` / `playBreakMin` in options. **Turn off** deletes the
schedule and clears the session. **Re-arm** with unchanged fields still
recomputes `notBefore` from now, which is how "same thing again tomorrow" works
in one press.

Changing the PIN or removing it never touches the schedule or session.

Every mutating control in the section calls into `src/persistence/schedule.ts`
or `src/persistence/playtime.ts`; the DOM layer holds no state.

## Game start

`startGame` in `main.ts` currently reads `opts.playLimitMin` / `playBreakMin`.
It now calls `activeLimits(schedule, options)` from `src/game/schedule.ts`:

- schedule armed → `{ limitMin: schedule.limitMin, breakMin: schedule.breakMin }`;
- else → `{ limitMin: opts.playLimitMin, breakMin: opts.playBreakMin }`, and
  `limitMin === null` means no timer, as today.

`resolveSession(stored, limitMin, breakMin, now, schedule)` gains the schedule
argument and uses `sessionInForce` instead of `isStale` directly. A fresh
session gets `startedAt = now`. `playAgain` in the controller also sets
`startedAt`.

**Guard against a stale tab.** If a schedule is armed and
`now < schedule.notBefore` when `startGame` is entered (the menu was left open
across a re-arm in another tab, or the clock was set back), `startGame` does
not start; it re-shows the menu. The menu's own model already disables Play,
so this is belt and braces, and it is one `if` at the top of the play-time
block.

The in-game overlay, warnings, freeze, PLAY AGAIN, and the interval are
unchanged.

## What the kid can still do

- Open Options and remap keys. Harmless.
- Press Grown-ups and see the PIN prompt. Guessing is unbounded; four digits
  is the accepted trade-off.
- Clear site data or use another browser. Out of scope, as before.
- Set the system clock forward. Out of scope; `notBefore` is wall clock.

## Files

| File | Change |
|---|---|
| `src/game/schedule.ts` | new: `Schedule` type, `nextOccurrence`, `sessionInForce`, `activeLimits`, `formatCountdown`, `formatStartTime` |
| `src/game/schedule.test.ts` | new |
| `src/persistence/schedule.ts` | new: `SCHEDULE_KEY`, `loadSchedule`, `saveSchedule`, `clearSchedule`, `armSchedule(fields, now)` |
| `src/persistence/schedule.test.ts` | new |
| `src/persistence/options.ts` + test | `parentPin` load/validate; `setParentPin(pin | null)` |
| `src/persistence/playtime.ts` + test | `startedAt` load/default; `applyPlaytimeSetting` unchanged |
| `src/game/playtime.ts` | `PlaytimeSession.startedAt` |
| `src/game/playtime-controller.ts` + test | `resolveSession(…, schedule)`, `startedAt` on fresh sessions |
| `src/ui/menu-model.ts` + test | new: `menuModel`, the state table above |
| `src/ui/menu.ts` | locked card, Grown-ups section, PIN prompt, 1 s refresh while visible, cleared on `hide()` |
| `src/ui/ui.css` | card, disabled Play, PIN row |
| `src/main.ts` | `activeLimits`, schedule guard, pass schedule to `resolveSession` |
| `docs/playtime.md` | schedule + PIN sections; the 12-hour rule now applies only without a schedule |
| `README.md` | play-time bullet: schedule, PIN, "forgot the PIN: clear site data for the game in the browser" |

## Testing

Node environment only (no DOM tests exist); the DOM layer stays thin and the
model, time rules, and storage carry the tests.

`src/game/schedule.test.ts` (build dates with `new Date(y, m, d, h, mi)` so
they are local-time and timezone-independent):

1. `nextOccurrence(420, 22:00 on 7 Sep)` → 07:00 on 8 Sep.
2. `nextOccurrence(420, 06:00 on 8 Sep)` → 07:00 on 8 Sep.
3. `nextOccurrence(420, 07:00:00.000 on 8 Sep)` → 07:00 on 9 Sep (strictly after).
4. `nextOccurrence(0, 23:59 on 8 Sep)` → 00:00 on 9 Sep.
5. `sessionInForce`: no schedule → mirrors `isStale` (in force at 11 h 59, not at 12 h 01).
6. `sessionInForce` with schedule: a session started 13 h ago but after `notBefore` is in force (would be stale without the schedule; this is the 5 a.m. hole).
7. `sessionInForce` with schedule: a session started before `notBefore` is not in force even if fresh.
8. `sessionInForce` with schedule: `updatedAt` 10 s in the future → not in force (clock set back).
9. `activeLimits`: schedule wins over options; without a schedule, options' null limit → null.
10. `formatCountdown`: 6 599 999 ms → `in 1 h 50 min`; 59 000 ms → `in 1 min`; 2 h exactly → `in 2 h 0 min`.

`src/ui/menu-model.test.ts`, one case per row of the state table, plus:
`worlds === null` → loading, disabled; Play enabled exactly at `now === notBefore`.

`src/persistence/schedule.test.ts`: round trip; each invalid field → `null`;
`armSchedule` computes `notBefore` via `nextOccurrence` and stores `armedAt`.

`src/persistence/options.test.ts`: `parentPin` `'1234'` round-trips; `'12'`,
`1234` (number), `'abcd'` → `null`.

`src/persistence/playtime.test.ts`: a legacy record without `startedAt` loads
with `startedAt === updatedAt`.

`src/game/playtime-controller.test.ts`: `resolveSession` with a schedule keeps
a 13-hour-old playing session (red without the schedule branch); a fresh
session has `startedAt === now`.

Each test is run red first on the missing or deliberately wrong
implementation; the plan names the wrong build for the load-bearing ones
(tests 3, 6, 7 and the menu-model `now === notBefore` boundary).

## Manual check (last task of the plan)

At `localhost:5173`, local world, never production. Use `window.__mc` where a
game is running and `localStorage` reads on the menu.

1. No PIN: open Grown-ups, set PIN 1234. Reload: Grown-ups asks for the PIN;
   0000 says Wrong PIN; 1234 opens.
2. Pick the local world, Play for 15, Not before = two minutes from now, Arm.
   Menu becomes the locked card with `in 2 min`; Play disabled; no world list.
   Wait: at the minute, Play enables without a reload.
3. Press Play: world loads, `localStorage['minicraft:v1:playtime']` has
   `startedAt`, `limitMs` 900000.
4. Set the stored session to 14.5 minutes played (as `docs/playtime.md` shows,
   adding `startedAt`), reload, Play: `END IN 1 MINUTE`, freeze, `ASK A
   GROWN-UP`. Reload: card says `Locked · ask a grown-up`, Play disabled.
   Edit the stored session's `updatedAt` to 13 h ago, reload: still locked
   (the 12-hour rule is off under a schedule).
5. Grown-ups → PIN → Unlock: card returns to `15 minutes of play`, Play enabled.
6. Grown-ups → Turn off: the normal menu with world lists is back.
7. Production build: `npm run build`, `grep -c parentPin dist/assets/*.js` is
   at least 1 (sanity that the feature is in the bundle) and `__mc` is 0.
