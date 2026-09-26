# Play-time limit

A parent sets two everyday rules in **Parents**: *Can't play before* (a start time, optional) and
*Play time per day* (10 min to 2 h, or No limit). Play time is counted for the whole day, across
every world, solo and multiplayer, and starts fresh at local midnight. Today-only buttons give
more time or reset the day without touching the rules.

The game warns at 5 and 2 minutes of play time left (`END IN 5 MINUTES`, ten seconds,
click-through), then freezes under `TIME'S UP`. There is no break time.

## What the kid sees

`playStatus()` (`src/game/rules.ts`) decides, and the home screen, Single Player, Multiplayer and
main.ts's belt-and-braces gate all read it. The home line refreshes every 30 s.

| Situation | Line | Play |
|---|---|---|
| no rules | none; the kid picks a duration | on |
| before the start time | `Play at 7:00 AM` | off |
| daily limit, time left | `15 minutes left today` (no duration control) | on |
| daily limit, used up | `All done for today · play again tomorrow at 7:00 AM` | off |
| No limit today | `No time limit today` | on |
| no daily limit, a frozen sitting | `Time's up · ask a parent` | off |
| unreadable rules | `Something's wrong · ask a parent` | off |

Under a daily limit the freeze screen says `PLAY AGAIN TOMORROW AT 7:00 AM` (or
`PLAY AGAIN TOMORROW`), otherwise `ASK A PARENT`. A Play button is never enabled when pressing it
would go straight to `TIME'S UP`.

## The Parents screen

Behind the PIN once one is set. Opening it never writes anything: only a button does, and each
button says what it did in a line next to it (`✓ Saved. Play 45 min a day, from 7:00 AM.`), and
the screen stays open.

1. **Today.** A summary (`Played 20 min of 45 min today. Play opens at 7:00 AM.`) and:
   - **+15 min today** and **No limit today** (only under a daily limit). While No limit today
     is on, the only button is **Back to normal today**, which also drops any +15. Stored in
     `minicraft:v1:today` with the local date, read at the press (the screen may stay open past
     midnight); a record from another day means nothing, so extras end at midnight on their own.
   - **Reset today's time**: clears the play session and today's extras. Rules, PIN and worlds are
     untouched.
2. **Every day.** *Can't play before* (checkbox + time) and *Play time per day*. Changing a field
   says `Not saved yet.`; **Save rules** writes `minicraft:v1:rules` and confirms in plain words.
   Saving never uses up today's time; the time already played today counts against a new limit.
   Lifting the daily limit (to No limit) clears today's session, which was made under the old
   limit and would otherwise keep him locked. Without a PIN a warning says anyone can change the
   rules. The saved message scrolls into view.
3. **Parent PIN.** Four digits, typed twice. Change or Remove once set. The PIN prompt carries the
   recovery hint: `localStorage.removeItem('minicraft:v1:pin')` in the browser console on the
   game's tab; nothing else is lost.
4. **Multiplayer worlds** with Delete, when the server is reachable.

## Sessions

At Play, `resolveSession(stored, chosen, rules, today, now)` decides:

- **Under a daily limit** the session is the day's. A stored session started today keeps its
  played time; its limit is recomputed from today's rules (daily + extras), and it is frozen iff
  played ≥ limit. A session from another day is ignored. No limit today → a day-long timer
  (never reached), so the running game can still be stopped at midnight. The kid's duration is
  not asked. Unreadable rules give an already-locked session, so they fail closed even past the
  menu's gate.
- **Without a daily limit** (no rules, or only a start time) the kid's duration applies per
  sitting: the stored session if it is not stale (a frozen one is not escaped by picking "No
  limit"), else a new one of the chosen duration, else no timer. The duration moves in 5-minute
  steps from 10 min to 2 h, then No limit, and is remembered in `minicraft:v1:menu`.

## The refresh rule

At boot, before anything reads the stored session, `boot()` (`src/game/boot.ts`) calls
`sessionPolicy(pinSet, rulesActive, autojoin)`. It **discards** the stored session only when all
three are false:

- **No PIN and no rules → a reload starts fresh** (honour system).
- **A PIN is set, or any rule is set → the session survives reloads.** Unreadable rules count as
  set: parental controls fail closed.
- **A multiplayer reconnect keeps it.** The reconnect is a page reload carrying
  `sessionStorage['mp:autojoin']`, and a wifi blip must not hand out a fresh timer. The flag
  never outlives its purpose: it is cleared when the site has no multiplayer server, when the
  rejoin fails, on any close that does not reconnect, and when a solo game starts.
- **An outdated-client auto-reload keeps it too.** The guarded automatic reload behind "Updating
  Minicraft…" (`docs/protocol.md` §5/§6) deliberately leaves `mp:autojoin` set before it reloads,
  so the boot after it reads exactly like the reconnect case above, not a fresh start.

Without a daily limit the 12-hour stale rule still applies.

## Stored records and migration

- `minicraft:v1:rules`: `{ startMin: 0..1439 | null, dailyMin: 10..120 step 5 | null }`. Present
  but invalid → broken (locks). Always written by Save rules, even "no rules", so the old records
  below are never read again.
- Until then, `loadRules()` migrates: an old per-world schedule (`minicraft:v1:schedule`) becomes
  its start time and minutes per day (the world lock is dropped; an unreadable one stays broken);
  otherwise an old per-sitting maximum (`maxDurationMin` in the options record) becomes minutes per
  day. The old records are left in place, unused.
- `minicraft:v1:today`: `{ day: 'YYYY-MM-DD', extraMin, unlimited }`. Unreadable or another day →
  no extras.
- `minicraft:v1:pin`: four digits.

DST: the start gate is local wall-clock minutes. A start time inside the spring-forward gap opens
when the clock reaches the next real minute; inside the fall-back repeated hour it opens on the
first pass, closes during the second, and reopens.

**Midnight.** Under any rule, a running game stops when the local day changes (`TIME'S UP` /
`A NEW DAY · PRESS MENU`); MENU then Play starts the new day under its start time and limit. So a
tab left open overnight carries neither yesterday's minutes nor "No limit today" into the
morning. Without rules nothing happens at midnight.

Known limits, accepted for a family tool:

- A game already running does not notice a change made in Parents from another tab; it keeps
  its session until it reloads. Parents is only reachable from the menu, not during a game.
- Two tabs playing at once each keep their own copy of the session (the last to save wins), so
  they can together exceed the day. Pre-existing.
- Setting the computer's clock back beats every rule. A browser-only game cannot prevent it.

## Semantics

- **Play time** counts only while the page is visible and awake. A closed lid, a hidden tab or a
  sleeping laptop does not count. Each 1 s tick credits at most 2 s, so a throttled or slept
  interval cannot dump an hour into the count.
- The session is **per browser**, not per world, and shared by solo and multiplayer.
- Without a daily limit, a session untouched for 12 hours is discarded, so a lock from last night
  clears itself. A session written under a clock that has since been set back is discarded too.
  Under a daily limit, a session belongs to the local day it started on; a session running at
  midnight keeps going.
- **In multiplayer** the same timer runs. The player also sends `leaving` at 2 minutes,
  1 minute, 30 seconds and 0 left; friends see small toasts ("Noah has to go in 2 minutes" …
  "Noah went home") and the leaver sees a big 10 … 1. The timer is paused while the connection is
  lost. See `docs/multiplayer.md`, and `docs/protocol.md` for the `leaving` message itself.

## Pieces

| File | Role |
|---|---|
| `src/data/playtime.data.ts` | the duration list, warning thresholds, the stale and tick limits |
| `src/game/rules.ts` | pure rules: start gate, per-day sessions, today's extras, `resolveSession`, `playStatus`, the Parents summary |
| `src/game/session-policy.ts` | `sessionPolicy`, `defaultDuration`, `clampDuration`, `stepDuration`, `formatDuration` |
| `src/game/boot.ts`, `src/game/boot-session.ts` | the boot decision: the refresh rule and the `mp:autojoin` flag |
| `src/game/playtime.ts` | `PlayTimer` state machine; `phaseOf`, `isStale` |
| `src/game/playtime-controller.ts` | `PlaytimeController` turns timer events into overlay and game calls |
| `src/game/leaving.ts` | the multiplayer `leaving` countdown and its toast text |
| `src/persistence/playtime.ts` | `minicraft:v1:playtime` load/save/clear |
| `src/persistence/rules.ts` | `minicraft:v1:rules` (with migration), `minicraft:v1:today`, `minicraft:v1:pin`; fail-closed loader |
| `src/ui/playtime-overlay.ts` | warning band and freeze overlay |
| `src/ui/menu.ts` | home, Single Player, Multiplayer and Parents screens |
| `src/ui/duration-control.ts` | the kid's duration control |
| `src/main.ts` | 1 s `setInterval` + `visibilitychange` → `controller.tick()`; the freeze/resume callbacks; input gating on `loop.paused` |

Stored record: `{ limitMs, breakMs: null, playedMs, frozenAt | null, startedAt, updatedAt }`.
`breakMs` is always null; an old record with a numeric break loads with null. The phase is
derived: not frozen → playing, frozen → locked (it never ends by itself).

## Freeze

`GameLoop.paused` is checked first thing in `tick()`: no physics, mining, particles or
simulation, but chunks keep loading and meshing so a world opened straight into a lock is not
empty sky. `main.ts` also gates the window-level keydown, Tab and mousedown handlers on
`loop.paused`, otherwise fly toggles, hotbar keys, ignite and the colour picker would act under
the overlay. The overlay swallows clicks so the canvas cannot re-acquire pointer lock. Autosave
is flushed at the freeze (it writes only if something is dirty). In multiplayer, the freeze also
sends the extras and then leaves the world.

## Testing a freeze without waiting

At `localhost:5173`, set a PIN (so a reload keeps the session), then in devtools:

    localStorage.setItem('minicraft:v1:playtime', JSON.stringify({
    	limitMs: 900000, breakMs: null, playedMs: 870000, frozenAt: null,
    	startedAt: Date.now(), updatedAt: Date.now() }))

Reload and pick a world: `END IN 1 MINUTE` at once, freeze after 30 s of visible play. In a dev
build, `__mc.playtime.setRemaining(ms)` sets the live session's time left directly. Never do this
on the production site.
