# Scheduled play with a grown-ups PIN — design

**Date:** 2026-09-07
**Status:** revised after gate 1
**Builds on:** `docs/superpowers/specs/2026-09-06-play-time-limit-design.md`, `docs/playtime.md`

## Problem

Noah was found playing at 5 a.m. The play-time limit only bounds how long a
session lasts, not when it may start, and its controls sit unguarded on the
menu the kid uses.

## Goal

Julien opens the menu, unlocks the Grown-ups section with a PIN, picks Noah's
world, sets "Play for 45 minutes" and "Not before 07:00", presses Save, and
never has to touch it again. Every day: before 07:00 the menu shows one locked
card; from 07:00 a Play button loads that world; 45 minutes of play, then the
game is done until 07:00 tomorrow. Nothing on the kid's side changes this
without the PIN.

Gate 1 rejected the first draft's one-shot start time: it protected only the
first morning, and the card would have said "not before 7:00" while Play
worked at 5 a.m. on day two. The rule below is daily by construction.

## Non-goals

- No end-of-day time. From the start time onward the kid may start any time
  that day; the daily limit is the bound. (An end time is a natural follow-up.)
- No cloud sync of the schedule or PIN; both live in this browser's
  `localStorage` like the other options.
- No cryptography. The PIN is four digits stored in plain text. It stops a
  seven-year-old, not a teenager with devtools.
- No change to the world save format or the API.
- No change to the world Delete buttons or the Options screen.
- No countdown on the kid's card. "Play at 7:00" is the message; a ticking
  clock invites waiting up.

## Definitions

- **Schedule**: the parent's saved choice: world, daily limit, start time.
- **Gate**: open when the local time of day is at or past the start time.
- **Locked card**: the single-button menu shown while a schedule is saved.
- **Grown-ups section**: the parent controls; opened with the PIN when one is
  set, open by default when none is set.
- **Session**: the existing `PlaytimeSession` record (play time used, freeze).
  Under a schedule a session belongs to the local calendar day it started on.

## Persisted data

### `minicraft:v1:schedule` (new)

```ts
export type Schedule = {
	worldId: string;   // as listed by the adapter; may be a legacy id (see Worlds)
	seed: number;
	name: string;
	limitMin: number;  // member of PLAY_LIMIT_CHOICES_MIN
	startMin: number;  // integer minutes after local midnight, 0..1439
};
```

There is no break field: under a schedule the limit ends play for the day.
A timed break would make the daily limit "per cycle, unlimited cycles"
(gate 1 ran twelve 45/20 cycles in one day with no grown-up involved).

Loader outcomes are three-valued because a parental control must fail closed:

- key absent → `{ kind: 'none' }`;
- valid record → `{ kind: 'armed', schedule }`;
- present but invalid (bad JSON, missing field, `limitMin` not in the choice
  list, `startMin` not an integer in 0..1439, non-string `worldId`/`name`,
  non-finite `seed`) → `{ kind: 'broken' }`. The menu treats `broken` as
  locked with a "Something's wrong · ask a grown-up" line; the Grown-ups
  section can Turn off or Save over it.

`saveSchedule` writes, reads back, and returns `true` only if the read-back
equals what was written. `clearSchedule` likewise returns whether the key is
gone. The menu shows `Couldn't save — try again` in red when either returns
`false`; nothing else changes.

### `minicraft:v1:pin` (new)

A string matching `/^\d{4}$/`, or absent. Its own key so the recovery for a
forgotten PIN is `localStorage.removeItem('minicraft:v1:pin')`, which loses no
worlds and no options. `loadPin(): string | null` (anything invalid → `null`),
`savePin(pin): boolean` (read-back), `clearPin(): boolean`.

### `minicraft:v1:playtime` (extended)

`PlaytimeSession` gains `startedAt: number` (epoch ms when the session was
created). Loader: a record without it gets `startedAt = updatedAt`; a record
with a non-finite `startedAt` is invalid (→ `null`), like any other bad field.

### `minicraft:v1:options`

Unchanged. `playLimitMin` / `playBreakMin` keep serving the no-schedule mode.

## Time rules

All in `src/game/schedule.ts`, pure, no DOM, no storage; every function takes
`now` as epoch ms and uses local `Date` getters.

- `minutesSinceMidnight(now)`: `getHours() * 60 + getMinutes()`.
- `gateOpen(startMin, now)`: `minutesSinceMidnight(now) >= startMin`.
- `sameLocalDay(a, b)`: equal local year, month, and date.
- `sessionInForce(session, schedule | null, now)`:
  - clock-set-back guard first, both modes: `session.updatedAt > now + MAX_TICK_CREDIT_MS` → false;
  - no schedule → `!isStale(session, now)` (unchanged behaviour);
  - schedule → `sameLocalDay(session.startedAt, now)`. The 12-hour stale rule
    does not apply: a lock reached at 07:45 must hold until tomorrow, which is
    exactly the 5 a.m. hole.
- `activeLimits(schedule | null, options)`: schedule → `{ limitMin: schedule.limitMin, breakMin: null }`;
  else `{ limitMin: options.playLimitMin, breakMin: options.playBreakMin }`.
- `formatStartTime(startMin)`: the browser locale's short time for today at
  that minute (`toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })`).

DST: the gate compares local wall-clock minutes, so on the spring-forward day
07:00 still means 07:00. A start time inside the missing hour (02:30) simply
opens at 03:00 that day. On the fall-back day the repeated hour opens the gate
on its first pass. Written down here so nobody "fixes" it.

**Timezone in tests.** `vitest.config.ts` pins `TZ` to `America/Toronto`
(via `test.env`). Without that, a build using UTC getters passes every
local-time test in a UTC container; gate 1 proved it. At least one test in
each of `gateOpen` and `sameLocalDay` uses a local evening time whose UTC date
differs (20:30 Toronto is 00:30 UTC next day), so a UTC build goes red.

`phaseOf` and the `PlayTimer` are unchanged.

## Menu states

`menuModel(input)` in `src/ui/menu-model.ts` (pure, tested) returns what to
render. Input: `{ schedule: LoadedSchedule, session, pin: string | null, worlds: WorldSummary[] | null, offline: boolean, now }`.
Output for the armed case: `{ mode: 'card', title, line, playEnabled, world: { id, seed } | null }`;
otherwise `{ mode: 'full' }`.

### No schedule

Today's menu: New World, world lists, then the Grown-ups section, then Options.

### Schedule saved

The world lists and New World are not rendered. The card is:

```
Minicraft
Noah's World
<line>
[ ▶ Play ]
Grown-ups
Options
```

| Condition (checked in this order) | `line` | Play |
|---|---|---|
| schedule `broken` | `Something's wrong · ask a grown-up` | disabled |
| `worlds === null` (list still loading) | `Loading…` | disabled |
| world not resolved (see Worlds) and `offline` | `Can't reach cloud saves · try again later` | disabled |
| world not resolved and online | `World not found · ask a grown-up` | disabled |
| gate closed | `Play at 7:00` | disabled |
| session in force, phase playing | `12 minutes left` | **Play** (continues) |
| session in force, frozen | `All done for today · play again at 7:00 tomorrow` | disabled |
| otherwise | `45 minutes today` | **Play** (fresh session) |

`phase over` cannot occur under a schedule (no break). The title is the
schedule's `name`. A kid who quits after 20 minutes and comes back the same day
gets the remaining 25, not a fresh 45.

Pressing Play fires `{ type: 'continue', id, seed }` with the **resolved**
world's id and seed, not the stored ones.

**Refresh.** `MainMenu` owns one `setInterval` of 30 s that recomputes the
model and updates only the `line` text and the button's disabled state. It
never re-renders the card or the Grown-ups section (a full re-render would
wipe a PIN being typed). It is cleared at the top of `renderHome`,
`renderNew`, and `hide()`, and started once after the world list resolves.
At 07:00 the button enables itself without a reload.

### Worlds

The parent picks from a dropdown built from both lists, skipping `degraded`
entries. The stored `worldId` may be a legacy id (`legacy:<seed>`): the first
Play adopts that world under a fresh uuid and the list then shows only the
uuid. `resolveWorld(schedule, worlds)` therefore matches `w.id === worldId`
first, then a local world with `w.seed === seed` when `worldId` is a legacy
id. A world that resolves to nothing reads as not found. If the parent deletes
the scheduled world, the card says "World not found · ask a grown-up" until a
grown-up picks another or turns the schedule off; that is accepted.

### Grown-ups section

Collapsed by default as a single **Grown-ups** button.

- **No PIN set:** pressing it opens the section immediately. At the top:
  `Set a PIN so only grown-ups can change this`, a 4-digit input and
  **Set PIN**. Below, the no-schedule controls work without a PIN as today.
  The world dropdown is disabled with the hint `Set a PIN to lock to a world`:
  a schedule without a PIN is a trap (the kid presses Turn off).
- **PIN set:** pressing it shows `Grown-ups PIN`, a 4-digit input
  (`type="password"`, `inputmode="numeric"`, `maxlength="4"`,
  `autocomplete="off"`) and **Open**. Right PIN opens the section for as long
  as the menu stays rendered (a world start or reload closes it). Wrong PIN:
  `Wrong PIN` under the input, input cleared; no lockout, no delay.

Open section, top to bottom. All controls are **staged**; nothing is written
until Save. This replaces today's save-on-change for the play-time dropdowns.

1. PIN row: **Remove PIN**, and a 4-digit input + **Set PIN** (which also
   serves as change).
2. **World**: `No schedule` (first option) or each world as `name (seed)`.
   Default: the saved world, else `No schedule`.
3. **Play for**: Off, 15…90 as today. With a world chosen, `Off` is not
   offered and a stored Off shows as 45.
4. **Then break for**: only with `No schedule`, as today.
5. **Not before**: `<input type="time">` with no `step` (07:10 is fine).
   Only with a world chosen. Default: the saved `startMin`, else `07:00`.
6. Buttons: **Save**, and **Turn off** when a schedule is saved.
7. Status row and **Unlock** / **Start fresh**: as today, inside the section.
   Unlock reads `Unlock · fresh 45 minutes now` under a schedule, because that
   is what it does (clears the session; the schedule stays).
8. A red `Couldn't save — try again` line appears under the buttons when a
   storage write fails read-back.

**Save** with a world: writes the schedule, clears the session, re-renders.
Does not touch `playLimitMin` / `playBreakMin`. **Save** with `No schedule`:
writes `playLimitMin` / `playBreakMin` via `applyPlaytimeSetting` (which clears
the session) and clears the schedule. **Turn off**: clears the schedule and
the session. PIN changes never touch the schedule or session.

The section does not re-lock on a timer. Turning the schedule off to play a
grown-up's own world is the expected path; `docs/playtime.md` says so.

## Game start

In `showMenu`'s action callback, **before** `startGame` is entered: if the
schedule is `armed` or `broken` and `menuModel(...).playEnabled` is false, the
menu re-renders and returns. `startGame` has already hidden the menu, built the
world, and registered window listeners by the time its play-time block runs,
so the guard cannot live there (gate 1).

`startGame`'s play-time block calls `activeLimits(schedule, opts)` instead of
reading `opts` directly, passes the schedule to
`resolveSession(stored, limitMin, breakMin, now, schedule)`, which uses
`sessionInForce`, and sets `startedAt = now` on a fresh session. `playAgain`
in the controller also sets `startedAt`; it is unreachable under a schedule.

**Freeze overlay.** `PlaytimeOverlayLike.freeze(breakEndsAt, lockedText?)`:
with `lockedText` set, the no-break freeze shows it instead of `ASK A
GROWN-UP`. The controller receives `lockedText` in its deps; `main.ts` passes
`PLAY AGAIN AT 7:00 TOMORROW` under a schedule and nothing otherwise. Both
no-break variants gain a **MENU** button that reloads the page, so a kid
staring at last night's frozen tab at 07:05 can get to the Play button, and a
parent can reach Unlock without knowing about F5.

A game already running does not notice a Save or Turn off in another tab; its
controller keeps ticking the old session. Same class as the documented "Unlock
in another tab does not wake the frozen tab". Written in `docs/playtime.md`.

## CSS

`#menu-root` gets `overflow-y: auto` and the card `margin: auto` instead of
flex centring, so a card taller than the viewport scrolls. Gate 1 measured the
open Grown-ups section with ten worlds at 1178 px on a 1280×800 laptop with
Save off-screen and no way to scroll; Options is already unreachable today at
800×600. Disabled Play is greyed with the line above it; the PIN row and the
error line get styles.

## What the kid can still do

- Open Options and remap keys. Harmless.
- Press Grown-ups and see the PIN prompt. Guessing is unbounded; four digits
  is the accepted trade-off.
- Clear site data or use another browser. Out of scope, as before.
- Move the system clock. Out of scope; the gate is wall clock.

## Files

| File | Change |
|---|---|
| `vitest.config.ts` | `test.env.TZ = 'America/Toronto'` |
| `src/game/schedule.ts` + test | new: `Schedule`, `minutesSinceMidnight`, `gateOpen`, `sameLocalDay`, `sessionInForce`, `activeLimits`, `formatStartTime`, `resolveWorld` |
| `src/persistence/schedule.ts` + test | new: `SCHEDULE_KEY`, `PIN_KEY`, `loadSchedule` (three-valued), `saveSchedule`, `clearSchedule`, `loadPin`, `savePin`, `clearPin` |
| `src/persistence/playtime.ts` + test | `startedAt` load/default/validate |
| `src/game/playtime.ts` | `PlaytimeSession.startedAt` |
| `src/game/playtime-controller.ts` + test | `resolveSession(…, schedule)`, `startedAt`, `lockedText` dep |
| `src/ui/menu-model.ts` + test | new: `menuModel`, the state table |
| `src/ui/menu.ts` | locked card, Grown-ups section, PIN prompt, staged Save, 30 s refresh with ownership |
| `src/ui/playtime-overlay.ts` | `lockedText`, MENU button |
| `src/ui/ui.css` | scrolling menu, card, disabled Play, PIN row, error line |
| `src/main.ts` | guard in the menu callback, `activeLimits`, schedule into `resolveSession`, `lockedText` |
| `docs/playtime.md` | schedule + PIN sections; 12-hour rule only without a schedule; other-tab note; forgot-PIN recovery |
| `README.md` | play-time bullet: schedule, PIN, forgot-PIN line |

## Testing

Node environment; the DOM layer stays thin. All dates are built with the
local constructor `new Date(y, m, d, h, mi)` under the pinned TZ.

`src/game/schedule.test.ts`:

1. `gateOpen(420, 06:59)` false; `gateOpen(420, 07:00)` true (boundary).
2. `gateOpen(420, 20:30)` true. A UTC-getter build reads 00:30 and says false.
3. `sameLocalDay(19:30, 20:30 same date)` true. A UTC build sees two dates.
4. `sameLocalDay(23:59 on 7 Sep, 00:01 on 8 Sep)` false.
5. `sessionInForce`, no schedule: in force at 11 h 59 since `updatedAt`, not at 12 h 01.
6. `sessionInForce`, schedule: started 07:10 today, `updatedAt` 07:55, now 20:00 (13 h later) → in force. Red without the schedule branch.
7. `sessionInForce`, schedule: started yesterday 07:10, now 05:00 → not in force.
8. `sessionInForce`, either mode: `updatedAt` 10 s in the future → not in force.
9. `activeLimits`: schedule wins and yields `breakMin: null` even when options have a break; no schedule + Off → `limitMin: null`.
10. `resolveWorld`: exact id match; legacy id + local seed match; legacy id + cloud seed no match; nothing → null.
11. Spring-forward day (8 Mar 2026): `gateOpen(420, new Date(2026, 2, 8, 7, 0))` true and `gateOpen(420, new Date(2026, 2, 8, 6, 59))` false; `minutesSinceMidnight(new Date(2026, 2, 8, 3, 0))` is 180.

`src/ui/menu-model.test.ts`: one case per row of the state table in order,
plus: `worlds === []` online with an unknown id → not found; `playEnabled`
exactly at `now === today's startMin`; a frozen session from yesterday at
07:00 today → `45 minutes today`, enabled (day rollover); `broken` beats
everything even when the gate is open.

`src/persistence/schedule.test.ts`: absent → `none`; round trip → `armed`;
each invalid field → `broken`; `limitMin` 7 → `broken`; `startMin` 1440 or
`7.5` → `broken`; `saveSchedule` returns `false` when `setItem` throws
(stubbed) and `true` on success; PIN `'1234'` round-trips; `'12'`, `1234`,
`'abcd'`, `' 1234'` → `null`.

`src/persistence/playtime.test.ts`: legacy record → `startedAt === updatedAt`;
`startedAt: 'x'` → `null`.

`src/game/playtime-controller.test.ts`: `resolveSession` with a schedule keeps
a 13-hour-old playing session from today (red without the schedule branch)
and discards yesterday's; a fresh session has `startedAt === now`; the freeze
event passes `lockedText` through to `overlay.freeze`.

Each test is run red first. The plan names the wrong build for tests 2, 3, 6,
7, the model's gate boundary, and the `broken` precedence.

## Manual check (last task of the plan)

At `localhost:5173`, local world, never production. Read `localStorage` on the
menu and `window.__mc` in game.

1. No PIN: Grown-ups opens at once; the world dropdown is disabled with the
   hint. Set PIN 1234. Reload: Grown-ups asks for the PIN; 0000 → Wrong PIN;
   1234 opens.
2. With the real world list at 1280×800, open Grown-ups, pick the local world,
   Play for 15, Not before = two minutes from now, scroll to Save, Save. The
   locked card shows `Play at H:MM`, Play disabled, no world list. Wait: at
   that minute the button enables without a reload.
3. Play: world loads; the stored session has `startedAt` and `limitMs` 900000.
4. Set the stored session to 14.5 minutes played (per `docs/playtime.md`, with
   `startedAt` = today), reload, Play: `END IN 1 MINUTE`, freeze, `PLAY AGAIN
   AT H:MM TOMORROW`, a MENU button. Press MENU: the card says `All done for
   today`, Play disabled. Set the session's `updatedAt` to 13 h ago (same
   day): still locked. Set `startedAt` to yesterday: Play enabled again.
5. Grown-ups → PIN → Unlock: `15 minutes today`, Play enabled.
6. Grown-ups → Turn off: normal menu with world lists.
7. Corrupt the schedule key to `{}`: the card says `Something's wrong`, Play
   disabled, Grown-ups still opens and Turn off recovers.
8. `npm run build`; `grep -c "minicraft:v1:pin" dist/assets/*.js` ≥ 1 and
   `__mc` 0.
