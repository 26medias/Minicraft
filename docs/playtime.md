# Play-time limit

A parent sets **Play for** N minutes and optionally **Then break for** M on the
main menu. The game warns at 5 and 2 minutes of play time left
(`END IN 5 MINUTES`, ten seconds, click-through), then freezes under
`TIME'S UP`. With a break it shows `PLAY AGAIN IN 20 MINUTES`, counting down
by the minute, then a `PLAY AGAIN` button that starts a fresh session. Without
a break it shows `ASK A GROWN-UP` and stays frozen until a grown-up reloads and
presses **Unlock** on the menu.

## Semantics

- **Play time** counts only while the page is visible and awake. A closed lid,
  a hidden tab, or a sleeping laptop does not count. Each 1 s tick credits at
  most 2 s, so a throttled or slept interval cannot dump an hour into the count.
- **Break time** is wall clock, so closing the tab does not shorten it.
- The session is **per browser**, not per world.
- A lock always clears itself 12 hours after the game was last touched.
- **No PIN.** The Unlock and Start fresh buttons sit on the same menu the kid
  uses, so a kid who reloads and presses one is through. This limits an honest
  seven-year-old, not a determined one.

## How to unlock

Reload the game's own tab (F5), press **Unlock** (or **Start fresh**) in the
Play time section, then pick the world. Pressing Unlock in a different tab
clears the stored session but does not wake the frozen tab.

## Pieces

| File | Role |
|---|---|
| `src/data/playtime.data.ts` | choices, thresholds, durations |
| `src/game/playtime.ts` | `PlayTimer` state machine; `phaseOf`, `isStale` |
| `src/game/playtime-controller.ts` | `resolveSession`; `PlaytimeController` turns timer events into overlay/game calls |
| `src/persistence/playtime.ts` | `minicraft:v1:playtime` load/save/clear; `applyPlaytimeSetting` |
| `src/ui/playtime-overlay.ts` | warning band and freeze overlay |
| `src/ui/menu.ts` | Play time section with the status row and Unlock / Start fresh |
| `src/main.ts` | 1 s `setInterval` + `visibilitychange` → `controller.tick()`; the freeze/resume callbacks; input gating on `loop.paused` |

Stored record: `{ limitMs, breakMs | null, playedMs, frozenAt | null, updatedAt }`.
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
visible play. Never do this on the production site.
