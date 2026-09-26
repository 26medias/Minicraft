# Play-time limit

Two modes:

- **Free play** (no schedule): the kid picks how long before each game with the −/+ control on
  Single Player and Multiplayer (10 min … 2 h, or No limit). Honour system: without a PIN a
  reload starts fresh.
- **A scheduled session** (a *plan*): a parent presses **Schedule** in Single Player or
  Multiplayer, picks the world (or "Let him choose"), when it starts (Now, or At a time) and how
  long, and presses OK. The menu is then **locked onto that plan** until a parent ends it or
  makes a new one. Design: `docs/superpowers/specs/2026-09-26-scheduled-session-design.md`.

The game warns at 5 and 2 minutes left (`END IN 5 MINUTES`, ten seconds, click-through), then
freezes: `TIME'S UP` / `ASK A PARENT` in free play, `ALL DONE!` / `GREAT BUILDING · YOUR WORLD IS
SAVED` under a plan. MENU reloads.

## A plan

`minicraft:v1:plan`: `{ id, mode: 'solo' | 'mp', worldId | null, worldName | null, startAt,
limitMin, extraMin, createdAt }`. One session only; it does not repeat.

| Phase | When | The kid sees |
|---|---|---|
| wait | before `startAt` | "Not yet · play at 7:00 AM · in 2 hours" (coarse: hours, then 5-minute steps, then minutes; never seconds), Play off |
| play | started, time left, same local day | the plan's screen, "25 minutes left", Play on |
| done | played ≥ limit + extra, or the start day is over | "All done! · your world is saved", Play off |

- **The lock is sticky.** Done stays done, the next day too: the next session needs the next plan
  (or End schedule). So "not before 7 am" is: at night, schedule tomorrow 7:00.
- **Unused minutes die with the start day**, so they are not playable at 5 am the next morning.
- Under a plan the menu opens straight onto the plan's screen; home and the other mode are out of
  reach and Back is a **Parents** button. Solo: Single Player without New World, Delete or the
  duration control, only the locked world when there is one. Multiplayer: before and after its
  time only the plaque (no name or skin: nothing to do early); in its time the usual name/skin and
  worlds screens, filtered, without New World. A locked world that is not listed shows "Your
  world isn't here · ask a parent". The plaque repaints every second, so Play lights up at the
  start time without a reload.
- **Parents on the lock** (PIN): the plan's state ("Starts tomorrow, 7:00 AM, for 45 min." /
  "Played 20 min of 45 min."), **+15 min**, **Change** (the dialog, prefilled; keeps the plan's
  played time; a plan that has already started opens on "Now", since its old start time has passed
  and would read as tomorrow), **End schedule** (removes the plan and its session: free play).
- **Schedule needs a PIN.** With none, the button first asks to set one (typed twice).
- The dialog's OK reads the plan back: "Lock: Big Crafting · tomorrow, 7:00 AM · 45 min". A time
  at or before now means tomorrow; "Now" starts at once.

## Sessions

`resolveSession(stored, chosen, plan, now)` (`src/game/plan.ts`):

- **Under a plan** the play session is the plan's: a stored session counts iff its `planId` is
  the plan's `id` (Change keeps the id; a new plan gets a new one). Its limit is recomputed from
  the plan (+15 applies at the next Play); it is frozen iff played ≥ limit or the start day is
  over. The kid's duration is ignored.
- **Free play**: the stored session if it is not stale and not a plan's, else a new one of the
  chosen duration, else no timer.
- An unreadable plan record is **broken**: locked ("Something's wrong · ask a parent"), and
  `resolveSession` returns an already-locked session.

**Every way into a game is checked** by `planAllows({ mode, worldId }, …)`: phase play, the
plan's mode, and its world when locked. It guards the menu actions (`new`, `continue`, `mp`) and
the multiplayer autojoin reload.

**A running game watches the plan.** Every game (free play with No limit included, through a
day-long unsaved timer) compares `planKey` (id, start, limit, mode, world; not +15) each second:
a different plan, or the plan's start day ending, freezes it (`TIME TO STOP` / `A PARENT CHANGED
THE PLAN`, or `ALL DONE!`). Each tick also adopts a higher stored played time for the same session,
so two tabs cannot double the time.

## The refresh rule

At boot, before anything reads the stored session, `boot()` (`src/game/boot.ts`) calls
`sessionPolicy(pinSet, planActive, autojoin)`. It **discards** the stored session only when all
three are false:

- **No PIN and no plan → a reload starts fresh** (honour system).
- **A PIN is set, or a plan exists → the session survives reloads.** A broken plan counts:
  parental controls fail closed.
- **A multiplayer reconnect keeps it.** The reconnect is a page reload carrying
  `sessionStorage['mp:autojoin']`, and a wifi blip must not hand out a fresh timer. The flag
  never outlives its purpose: it is cleared when the site has no multiplayer server, when the
  rejoin fails, on any close that does not reconnect, and when a solo game starts.
- **An outdated-client auto-reload keeps it too.** The guarded automatic reload behind "Updating
  Minicraft…" (`docs/protocol.md` §5/§6) deliberately leaves `mp:autojoin` set before it reloads,
  so the boot after it reads exactly like the reconnect case above, not a fresh start.

## Parents (no plan)

From home, behind the PIN once set: how to schedule, free play's timer with **Reset play time**
when one is running or frozen, the Parent PIN (typed twice; change; remove; the "Forgot the
PIN?" steps on the PIN prompt: `localStorage.removeItem('minicraft:v1:pin')` in the browser
console), and the multiplayer worlds with Delete.

## Migration

- The deployed daily schedule (`minicraft:v1:schedule`) becomes a solo plan on its world at the
  next occurrence of its start time, for its minutes; the old record is removed once the plan is
  written. Migrating after today's start time moves it to tomorrow. An unreadable one is broken.
- The deployed per-sitting maximum (`maxDurationMin`) no longer applies: free play has no cap.
- This branch's earlier `minicraft:v1:rules` / `minicraft:v1:today` were never deployed.

Known limits:

- The lock is per browser: another browser or device is not covered.
- Setting the computer's clock back beats it.
- Two windows playing the same plan side by side use it up twice as fast (each adopts the other's
  time, then adds its own). Tabs in one window are safe: a hidden tab does not count. It fails
  closed.
- A world created but never played cannot be locked (Schedule makes a "let him choose" plan), and
  it is not listed under a plan until it has been played once.

## Semantics

- **Play time** counts only while the page is visible and awake. A closed lid, a hidden tab or a
  sleeping laptop does not count. Each 1 s tick credits at most 2 s, so a throttled or slept
  interval cannot dump an hour into the count.
- The session is **per browser**, not per world, and shared by solo and multiplayer.
- In free play, a session untouched for 12 hours is discarded, so a lock from last night clears
  itself. A session written under a clock that has since been set back is discarded too. Under a
  plan, staleness does not apply: the session belongs to the plan.
- **In multiplayer** the same timer runs. The player also sends `leaving` at 2 minutes,
  1 minute, 30 seconds and 0 left; friends see small toasts ("Noah has to go in 2 minutes" …
  "Noah went home") and the leaver sees a big 10 … 1. The timer is paused while the connection is
  lost. See `docs/multiplayer.md`, and `docs/protocol.md` for the `leaving` message itself.

## Pieces

| File | Role |
|---|---|
| `src/data/playtime.data.ts` | the duration list, warning thresholds, the stale and tick limits |
| `src/game/plan.ts` | pure plan rules: phases, `resolveSession`, `playStatus`, `planAllows`, `planKey`, countdown and sentences |
| `src/game/session-policy.ts` | `sessionPolicy`, `defaultDuration`, `clampDuration`, `stepDuration`, `formatDuration` |
| `src/game/boot.ts`, `src/game/boot-session.ts` | the boot decision: the refresh rule and the `mp:autojoin` flag |
| `src/game/playtime.ts` | `PlayTimer` state machine; `phaseOf`, `isStale` |
| `src/game/playtime-controller.ts` | `PlaytimeController` turns timer events into overlay and game calls |
| `src/game/leaving.ts` | the multiplayer `leaving` countdown and its toast text |
| `src/persistence/playtime.ts` | `minicraft:v1:playtime` load/save/clear |
| `src/persistence/plan.ts` | `minicraft:v1:plan` (with the old schedule's migration) and `minicraft:v1:pin`; fail-closed loader |
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
