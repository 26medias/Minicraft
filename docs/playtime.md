# Play-time limit

The kid picks how long to play with a big duration control ("30 min", − and +) on the Single
Player and Multiplayer screens, then presses **Play**. A parent sets the **maximum** in Parents.
The game warns at 5 and 2 minutes of play time left (`END IN 5 MINUTES`, ten seconds,
click-through), then freezes under `TIME'S UP` / `ASK A PARENT`. There is **no break time**: a
frozen session stays frozen until a new session is allowed (the refresh rule below) or a parent
resets it.

## The duration and the maximum

- The duration moves in 5-minute steps from 10 min up to the parent's maximum. Durations of an
  hour or more read "1 h", "1 h 30 min" (`formatDuration`).
- **The maximum** (Parents → *Maximum play time* → *Longest the kids can pick*) is 10 min to
  2 h in 5-minute steps, or **No limit**. Under No limit, + goes past 2 h to "No limit".
- **The default** is No limit when the maximum is No limit (a browser without a limit keeps
  playing unlimited, as before). Otherwise it is 30 min, clamped to the maximum.
- The 10-minute floor holds even under No limit. "No limit" picked under a maximum becomes the
  maximum.
- The chosen duration is remembered in `minicraft:v1:menu`. The maximum is `maxDurationMin` in
  the options record. The old `playLimitMin` became the maximum (`null` → No limit), and
  `playBreakMin` was dropped.
- Saving a new maximum also clears the stored session, so "the parent changed something" always
  unlocks.

## Starting a session

At Play, `resolveSession(stored, duration, now, schedule)` decides:

1. A stored session that is **in force** is used, whatever the kid picked, "No limit"
   included. A frozen session cannot be escaped by picking another duration.
2. Otherwise, a duration starts a new session of that length.
3. Otherwise ("No limit" and no session in force), there is no timer at all.

In force means: without a schedule, not stale (the 12-hour rule below); with a schedule, dated
today.

## The refresh rule, and its exceptions

At boot, before anything reads the stored session, `boot()` (`src/game/boot.ts`) calls
`sessionPolicy(pinSet, scheduleActive, autojoin)`. It **discards** the stored session only when
all three are false:

- **No PIN → a reload starts fresh.** Without a PIN this is an honour system: a reload
  (F5, or the freeze screen's MENU followed by Play) gives a new session.
- **A PIN is set → the session survives reloads.** That is how a parent makes the limit stick.
- **An active schedule keeps it**, so "All done for today" cannot be refreshed away. A broken
  (unreadable) schedule counts as active: parental controls fail closed.
- **A multiplayer reconnect keeps it.** The reconnect is a page reload carrying
  `sessionStorage['mp:autojoin']`, and a wifi blip must not hand out a fresh timer. The flag
  never outlives its purpose: it is cleared when the site has no multiplayer server, when the
  rejoin fails, on any close that does not reconnect, and when a solo game starts.
- **An outdated-client auto-reload keeps it too.** The guarded automatic reload behind "Updating
  Minicraft…" (`docs/protocol.md` §5/§6) deliberately leaves `mp:autojoin` set before it reloads,
  so the boot after it reads exactly like the reconnect case above, not a fresh start.

After that, the 12-hour stale rule still applies.

## Semantics

- **Play time** counts only while the page is visible and awake. A closed lid, a hidden tab or a
  sleeping laptop does not count. Each 1 s tick credits at most 2 s, so a throttled or slept
  interval cannot dump an hour into the count.
- The session is **per browser**, not per world, and shared by solo and multiplayer.
- Without a schedule, a session untouched for 12 hours is discarded, so a lock from last night
  clears itself. A session written under a clock that has since been set back is discarded too.
  With a schedule, a session belongs to the local day it started on.
- **In multiplayer** the same timer runs. The player also sends `leaving` at 2 minutes,
  1 minute, 30 seconds and 0 left; friends see small toasts ("Noah has to go in 2 minutes" …
  "Noah went home") and the leaver sees a big 10 … 1. The timer is paused while the connection is
  lost. See `docs/multiplayer.md`, and `docs/protocol.md` for the `leaving` message itself.
- **Parents PIN.** Four digits, stored under `minicraft:v1:pin`. Once set, it is required to open
  Parents. Forgotten: run `localStorage.removeItem('minicraft:v1:pin')` in the browser console on
  the game's tab; nothing else is lost.

## Schedule

In Parents (PIN required), *Schedule* picks a solo world, *Not before* the earliest start (local
time) and *Play for* the daily minutes (10 min to 2 h, not capped by the maximum). **Schedule**
saves it, and from then on the home screen is the scheduled card: only that world, with a Play
button that is disabled with `Play at 7:00` before the start time, then shows
`45 minutes today`, `N minutes left` if he quit early, and
`All done for today · play again at 7:00 tomorrow` once the limit is reached. Multiplayer is not
reachable from the card. The freeze screen says `PLAY AGAIN AT 7:00 AM TOMORROW` with a MENU
button. A session belongs to the local day it started on; tomorrow is a fresh one. A session
running at midnight keeps going.

Saving after today's start time has passed also marks today as done, so a bedtime save locks
tonight. The card's **Parents** button asks for the PIN (or cancels directly if none is set) and
cancels the schedule.

Stored schedules keep loading: the duration list is 10..120 in 5-minute steps, a superset of the
old choices.

DST: the gate is local wall-clock minutes. A start time inside the spring-forward gap opens when
the clock reaches the next real minute; a start time inside the fall-back repeated hour opens on
the first pass, closes again during the second pass, and reopens.

A game already running does not notice a change made in another tab; it keeps its old session
until it reloads. The schedule record is `minicraft:v1:schedule`; a present but unreadable record
locks the menu (`Something's wrong · ask a parent`) rather than opening it.

## How to unlock

- **No PIN:** reload the game's tab (F5), or press **MENU** on the freeze screen, then Play.
- **With a PIN:** Parents → **Reset states** clears the schedule and the play session. Changing
  the maximum also clears the session.

Resetting in a different tab clears the stored session but does not wake the frozen tab.

## Pieces

| File | Role |
|---|---|
| `src/data/playtime.data.ts` | the duration list, warning thresholds, the stale and tick limits |
| `src/game/session-policy.ts` | `sessionPolicy`, `defaultDuration`, `clampDuration`, `stepDuration`, `formatDuration` |
| `src/game/boot.ts`, `src/game/boot-session.ts` | the boot decision: the refresh rule and the `mp:autojoin` flag |
| `src/game/playtime.ts` | `PlayTimer` state machine; `phaseOf`, `isStale` |
| `src/game/playtime-controller.ts` | `resolveSession`; `PlaytimeController` turns timer events into overlay and game calls |
| `src/game/leaving.ts` | the multiplayer `leaving` countdown and its toast text |
| `src/game/schedule.ts` | pure time rules: daily gate, per-day sessions, world resolution |
| `src/persistence/playtime.ts` | `minicraft:v1:playtime` load/save/clear; `applyMaxDuration` |
| `src/persistence/schedule.ts` | `minicraft:v1:schedule` and `minicraft:v1:pin`; fail-closed schedule loader |
| `src/ui/playtime-overlay.ts` | warning band and freeze overlay |
| `src/ui/menu-model.ts` | pure `menuModel`: storage + clock → scheduled card |
| `src/ui/menu.ts` | home, Single Player, Multiplayer and Parents screens; the duration control |
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
