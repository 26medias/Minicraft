# Play-time limit

A parent sets **Play for** N minutes and optionally **Then break for** M in the
Grown-ups section of the main menu. The game warns at 5 and 2 minutes of play
time left (`END IN 5 MINUTES`, ten seconds, click-through), then freezes under
`TIME'S UP`. With a break it shows `PLAY AGAIN IN 20 MINUTES`, counting down
by the minute, then a `PLAY AGAIN` button that starts a fresh session. Without
a break it shows `ASK A GROWN-UP` and, without a schedule, stays frozen until a
grown-up reloads and presses **Unlock** on the menu.

## Semantics

- **Play time** counts only while the page is visible and awake. A closed lid,
  a hidden tab, or a sleeping laptop does not count. Each 1 s tick credits at
  most 2 s, so a throttled or slept interval cannot dump an hour into the count.
- **Break time** is wall clock, so closing the tab does not shorten it.
- The session is **per browser**, not per world.
- Without a schedule, a lock clears itself 12 hours after the game was last
  touched. With a schedule it holds until the next day's start time.
- **Grown-ups PIN.** Four digits, stored under `minicraft:v1:pin`. Required to
  open the Grown-ups section once set. Forgotten: run
  `localStorage.removeItem('minicraft:v1:pin')` in the browser console on the
  game's tab; nothing else is lost.

## Schedule

In Grown-ups, *Lock to world* picks Noah's world, *Play for* the daily
minutes, *Not before* the earliest start (local time). Save. From then on the
menu shows only that world with a Play button: disabled with `Play at 7:00`
before the start time, `45 minutes today` after it, `N minutes left` if he
quit early, and `All done for today · play again at 7:00 tomorrow` once the
limit is reached. There is no break under a schedule; the limit ends play for
the day and the freeze screen says `PLAY AGAIN AT 7:00 AM TOMORROW` with a MENU
button. A session belongs to the local day it started on; tomorrow is a fresh
one. A session running at midnight keeps going; the next day's session is
still a fresh one at the start time.

Saving after today's start time has passed also marks today as done, so a
bedtime save locks tonight. Grown-ups then shows `Locked until 7:00 tomorrow`
with *Unlock · play today*, which clears that and gives a fresh full limit
now. To play a grown-up's own world: *Turn off*, play, then set it up again.

DST: the gate is local wall-clock minutes. A start time inside the
spring-forward gap opens when the clock reaches the next real minute; a start
time inside the fall-back repeated hour opens on the first pass, closes again
during the second pass, and reopens.

A game already running does not notice a Save or Turn off made in another
tab; it keeps its old session until it reloads. The schedule record is
`minicraft:v1:schedule`; a present but unreadable record locks the menu
(`Something's wrong · ask a grown-up`) rather than opening it.

## How to unlock

Reload the game's own tab (F5), or press **MENU** on the freeze screen, press
**Unlock** (or **Start fresh**) in the Grown-ups section (PIN), then pick the
world. Pressing Unlock in a different tab
clears the stored session but does not wake the frozen tab.

## Pieces

| File | Role |
|---|---|
| `src/data/playtime.data.ts` | choices, thresholds, durations |
| `src/game/playtime.ts` | `PlayTimer` state machine; `phaseOf`, `isStale` |
| `src/game/playtime-controller.ts` | `resolveSession`; `PlaytimeController` turns timer events into overlay/game calls |
| `src/game/schedule.ts` | pure time rules: daily gate, per-day sessions, world resolution |
| `src/persistence/playtime.ts` | `minicraft:v1:playtime` load/save/clear; `applyPlaytimeSetting` |
| `src/persistence/schedule.ts` | `minicraft:v1:schedule` and `minicraft:v1:pin`; fail-closed schedule loader |
| `src/ui/playtime-overlay.ts` | warning band and freeze overlay |
| `src/ui/menu-model.ts` | pure `menuModel`: storage + clock → locked card / Grown-ups status |
| `src/ui/menu.ts` | locked card; Grown-ups section (PIN) with the status row, schedule fields, Unlock / Start fresh |
| `src/main.ts` | 1 s `setInterval` + `visibilitychange` → `controller.tick()`; the freeze/resume callbacks; input gating on `loop.paused` |

Stored record: `{ limitMs, breakMs | null, playedMs, frozenAt | null, startedAt, updatedAt }`.
Under a schedule a session is in force only on the local day of `startedAt`.
Phase is derived: not frozen → playing; frozen with no break → break; before
`frozenAt + breakMs` → break; after → over (a new session may start).

## Freeze

`GameLoop.paused` is checked first thing in `tick()`: no physics, mining,
particles, or simulation, but chunks keep loading and meshing so a world
opened straight into a break is not empty sky. `main.ts` also gates the
window-level keydown, Tab, and mousedown handlers on `loop.paused`, otherwise
fly toggles, hotbar keys, ignite, and the colour picker would act under the
overlay. The overlay swallows clicks so the canvas cannot re-acquire pointer
lock. Autosave is flushed at the freeze (it writes only if something is dirty).

## Testing a freeze without waiting

At `localhost:5173`, set a limit on the menu, then in devtools:

    localStorage.setItem('minicraft:v1:playtime', JSON.stringify({
    	limitMs: 900000, breakMs: 600000, playedMs: 870000, frozenAt: null, updatedAt: Date.now() }))

Reload and pick a world: `END IN 1 MINUTE` at once, freeze after 30 s of
visible play. `startedAt` defaults to `updatedAt` when absent. Never do this on
the production site.
