# Play-Time Limit — Design

**Date:** 2026-09-06
**Status:** Revised after gate 1 (four reviewers: rigour, engine, boundary/sequencing, consumer)
**Branch:** `feat/time-limit`

## Problem

A seven-year-old will play until someone stops him. The parent picks the world
for him on the main menu and walks away. There is no way to say "thirty
minutes, then a break" and have the game enforce it.

## Goal

On the main menu (the screen where the parent picks the world), a parent sets a
per-session play-time limit and, optionally, a break length. During play the
game shows two large, non-blocking warnings (5 minutes and 2 minutes before the
end). At the limit the game freezes under a full-screen overlay. If a break is
configured, the overlay counts the break down and then offers a "Play again"
button that starts a fresh session of the same length. If no break is
configured, the freeze holds until a grown-up presses **Unlock** on the menu.

The point is to get the kid away from the screen. The design therefore favours
predictability and reload-resistance over cleverness.

## Non-goals

- No PIN or password. A kid who learns to reload and change the dropdown can
  turn the limit off. Accepted for a seven-year-old; a PIN can be added later
  without changing anything below. The README says so plainly.
- No daily quota, no schedule, no accumulated totals. One session, one limit.
- No cloud sync of the setting. It lives in this browser's `localStorage`, like
  the other options.
- No in-game clock display during normal play. Warnings only ("low verbosity").
- No change to the world save format.
- No defence against changing the system clock (a clock jump forward ends a
  break early), and no cross-tab coordination (two tabs, last write wins).

## Definitions

- **Play time** is time the kid is actually playing: the page is visible and
  the process is awake. A closed lid, a hidden tab, or a sleeping laptop does
  not count. Without this, ten minutes of play plus a twenty-five-minute lunch
  reads as "TIME'S UP" the moment the lid opens, which the parent would file as a
  bug.
- **Break time** is wall-clock time. Closing the tab must not shorten a break.
- The session is **per browser**, not per world. Starting a different world or
  a new world during a break is still frozen. "I select the map for him"
  chooses the world; the limit is about the kid, not the map.

## User-facing behaviour

### Main menu

Below the world lists and above the "Options" button, a section titled
**Play time**:

| Control | Choices | Default |
|---|---|---|
| Play for | Off, 15, 20, 30, 45, 60, 90 minutes | Off |
| Then break for | Until a grown-up unlocks, 10, 15, 20, 30, 60 minutes | Until a grown-up unlocks |

"Then break for" is shown only while "Play for" is not Off. Turning "Play for"
to Off hides it but keeps its value for when the limit is re-armed.

Changes save immediately (no "Save" button) and clear any stored session.

When a stored session exists, a status row appears under the dropdowns:

- Playing, N minutes left: `12 minutes left  [Start fresh]`
- Frozen, break running: `Break, 7 minutes left  [Unlock]`
- Frozen, no break: `Locked — ask a grown-up  [Unlock]`

Both buttons call `clearSession()` unconditionally. This is the parent's unlock
path, and it works even when the dropdowns are re-selected at their current
value (a native `<select>` fires no `change` event in that case, so a
"change the setting to unlock" path would silently no-op). The row is not
shown when no session is stored.

The section renders both before and after the (possibly slow) cloud world list
resolves, so a parent on a bad connection still sees the controls at once.

### During play

| Play time remaining | What happens |
|---|---|
| ≤ 5 min (first time) | Warning overlay: `END IN 5 MINUTES` |
| ≤ 2 min (first time) | Warning overlay: `END IN 2 MINUTES` |
| 0 | Freeze |

A warning is a large centred text band in the **upper third** of the screen
(clear of the crosshair and hotbar, the kid keeps mining through it), visible
for 10 seconds, then fades out. It has `pointer-events: none`, does not exit
pointer lock, and does not stop the game loop. The number in the text is
`max(1, ceil(remaining / 60 s))`, so a session resumed with 4 minutes left says
`END IN 4 MINUTES` immediately. `END IN 1 MINUTE` is singular.

### Freeze

At the limit, in this order:

1. The loop is paused: no player physics, no mining, no particles, no liquid or
   TNT simulation. **Chunk loading and meshing keep running** so a world loaded
   directly into a break still appears behind the overlay instead of empty sky.
   The camera stays where it is. Rendering continues.
2. Held keys and the held mouse button are cleared; mining progress in the HUD
   is reset to 0. Window-level key and mouse handlers are gated while paused
   (see "Input gating"), so auto-repeat cannot re-arm a key and no hotkey can
   reach the player, the hotbar, TNT, or the colour picker.
3. Pointer lock is released (only if held).
4. Autosave is flushed. This writes only if there are unsaved edits (the
   existing 5 s debounce means anything older is already saved).
5. A full-screen overlay is shown. It covers the canvas and captures all pointer
   events, so a click cannot re-acquire pointer lock. Any visible warning is
   hidden.

Overlay content, uppercase, centred, white on a dark translucent ground:

- **Break configured:** `TIME'S UP` and below it `PLAY AGAIN IN 20 MINUTES`,
  updated once a minute (`max(1, ceil(remaining / 60 s))`; `1 MINUTE`
  singular). No seconds: a seconds counter is a stare magnet and `19:59` reads
  as a clock time to a seven-year-old. When the break is over the countdown is
  replaced by a large **PLAY AGAIN** button.
- **No break:** `TIME'S UP` and below it `ASK A GROWN-UP`. No button, no
  countdown.

### Play again

Clicking **PLAY AGAIN** starts a fresh session with the same limit and break,
hides the overlay, unpauses the loop, clears held keys again, and requests
pointer lock from the click handler (it is a user gesture, so the kid does not
have to click the canvas a second time). Warnings fire again at 5 and 2
minutes of the new session.

## Persisted session

Reload must not reset the clock. The active session is stored in
`localStorage` under `minicraft:v1:playtime`:

```ts
type PlaytimeSession = {
	limitMs: number;          // > 0
	breakMs: number | null;   // null = until a grown-up unlocks
	playedMs: number;         // accumulated visible play time, ≥ 0
	frozenAt: number | null;  // wall clock (ms since epoch) when the limit was hit
	updatedAt: number;        // wall clock of the last write; drives staleness
};
```

Phase is derived, never stored:

```
phase(session, now) =
	frozenAt === null                          → 'playing'
	breakMs === null                           → 'break'   (until Unlock)
	now < frozenAt + breakMs                   → 'break'
	otherwise                                  → 'over'    (a new session may start)
```

Rules:

- **Start of play** (`startGame` in `main.ts`): if options have "Play for" Off,
  no session is created and nothing below applies. Otherwise load the stored
  session. If there is none, or its phase is `'over'`, or it is **stale**,
  write a new one (`playedMs = 0`, `frozenAt = null`) from the options. If its
  phase is `'playing'`, resume it with the remaining time. If its phase is
  `'break'`, the freeze is applied **before the first frame** (see "Wiring"),
  and the world still loads underneath, paused.
- **Stale:** a session whose `updatedAt` is more than 12 hours old is discarded.
  The parent-facing rule, stated in the doc and README: *a lock always clears
  itself 12 hours after the game was last touched.* It exists so a no-break
  lock from last night does not need re-arming every morning; the Unlock
  button is the normal path.
- **Play again** overwrites the stored session with `playedMs = 0`,
  `frozenAt = null`.
- **Any change on the menu's Play time section, and both buttons,** remove the
  stored session. Saving the Options screen (kid mode, keybindings) does not.
- The stored session's own `limitMs`/`breakMs` win over the options while it is
  in force. Options are read only when a *new* session is created.
- The session is written after every tick that changed `playedMs` (once a
  second while playing and visible; ~100 bytes), at freeze, and on
  `visibilitychange` → hidden. A reload loses at most one second of play.

Options gain two fields, persisted alongside the existing ones in
`minicraft:v1:options`:

```ts
type Options = {
	kidMode: boolean;
	keybindings: Record<Action, string>;
	currentLightColor: string;
	playLimitMin: number | null;   // null = Off
	playBreakMin: number | null;   // null = until a grown-up unlocks
};
```

`loadOptions()` defaults both to `null` when absent or when the stored value is
not a member of the corresponding choice list (a string `"30"` must not reach
the arithmetic). Existing saved options keep working. `Options` stays in
`src/data/keybindings.data.ts` where `kidMode` and `currentLightColor`
already live; moving the type to its own file is a separate, later change.

`docs/persistence.md` gets one sentence clarifying that its "never write or
delete a `minicraft:v1:*` key" rule is about world keys; options and playtime
are different subsystems with their own v1 keys.

## Architecture

Four small units, one clear purpose each. Only `main.ts` sees more than one.

### `src/data/playtime.data.ts` (pure data)

```ts
export const PLAY_LIMIT_CHOICES_MIN = [15, 20, 30, 45, 60, 90];
export const PLAY_BREAK_CHOICES_MIN = [10, 15, 20, 30, 60];
export const WARNING_THRESHOLDS_MS = [5 * 60_000, 2 * 60_000];
export const WARNING_SHOW_MS = 10_000;
export const STALE_SESSION_MS = 12 * 3_600_000;
/** Longest gap one tick may add to playedMs; caps throttled/slept intervals. */
export const MAX_TICK_CREDIT_MS = 2_000;
export const TICK_MS = 1_000;
```

### `src/game/playtime.ts` (pure state machine, no DOM, no storage)

Owns the `PlaytimeSession` type (persistence imports it, not the reverse).

```ts
export type PlaytimePhase = 'playing' | 'break' | 'over';
export type PlaytimeEvent =
	| { type: 'warn'; minutesLeft: number }
	| { type: 'freeze'; breakEndsAt: number | null }
	| { type: 'break-over' };

export class PlayTimer {
	constructor(session: PlaytimeSession, now: number);
	/**
	 * Advance to `now`. `visible` says whether the page was visible for this
	 * tick; play time accrues only when it is, and never more than
	 * MAX_TICK_CREDIT_MS per call. Returns the events that fired, in order.
	 */
	tick(now: number, visible: boolean): PlaytimeEvent[];
	phase(): PlaytimePhase;
	remainingMs(): number;          // limitMs - playedMs, ≥ 0
	breakRemainingMs(): number;     // ≥ 0; Infinity when breakMs === null
	/** Current session, with playedMs/frozenAt/updatedAt as of the last tick. */
	readonly session: PlaytimeSession;
	/** True when the last tick changed anything worth persisting. */
	readonly dirty: boolean;
}

export function phaseOf(session: PlaytimeSession, now: number): PlaytimePhase;
export function isStale(session: PlaytimeSession, now: number): boolean;
```

Behavioural rules, each covered by a unit test:

1. Play time accrues only on visible ticks, by `min(now - lastNow,
   MAX_TICK_CREDIT_MS)`. A tick with `now < lastNow` (clock set back) adds
   nothing and never un-fires anything. `lastNow` is monotonic: break-phase
   comparisons use `max(now, lastNow)`, so a clock set back during a break
   cannot strand the timer in a paused loop with a stopped countdown.
2. Warnings: on any tick, if `remainingMs ≤ t` for some unfired threshold `t`,
   exactly one `warn` fires, for the **lowest** such threshold, and every
   threshold ≥ remaining is marked fired. `minutesLeft = max(1,
   ceil(remainingMs / 60 000))`. So a first tick with 90 s left yields one
   `warn(2)`; a throttled tick that jumps from 6 min to 1 min yields one
   `warn(1)`.
3. `freeze` fires exactly once, on the first tick at which `remainingMs === 0`
   **or** the session was constructed already frozen (`frozenAt !== null`).
   The tick that fires `freeze` fires no `warn`. `frozenAt` is set to `now` if
   it was null.
4. `break-over` fires exactly once, only when `breakMs !== null`, on the first
   tick at which phase is `'over'`. It may arrive in the same call as `freeze`,
   after it: `[freeze, break-over]` (reload just before the break ends, or a
   tab hidden long enough for the throttled interval to skip the whole break).
5. `session.updatedAt` is set to `now` on every tick that changed
   `playedMs` or `frozenAt`; `dirty` is true for that tick only.
6. `phaseOf` and `isStale` are pure functions of `(session, now)` and are what
   `main.ts` uses to decide resume / discard before constructing a timer.
   `isStale` is also true when `updatedAt > now + MAX_TICK_CREDIT_MS` (a
   session written under a clock that has since been set back is garbage).

### `src/persistence/playtime.ts` (storage)

```ts
export function loadSession(): PlaytimeSession | null;
export function saveSession(s: PlaytimeSession): void;   // swallows storage errors
export function clearSession(): void;
/** Menu helper: patch options, save them, clear the session. Pure enough to
 *  unit-test with the localStorage stub. */
export function applyPlaytimeSetting(patch: Partial<Pick<Options, 'playLimitMin' | 'playBreakMin'>>): Options;
```

`loadSession` returns `null` for a missing key, unparseable JSON, or
well-formed JSON with the wrong shape (`limitMs` not a positive finite number,
`breakMs` not `null` or a positive finite number, `playedMs` not a finite
number ≥ 0, `frozenAt` not `null` or a finite number, `updatedAt` not a finite
number). Same `localStorage` stub pattern as `options.test.ts`.

### `src/ui/playtime-overlay.ts` (DOM only)

```ts
export class PlaytimeOverlay {
	constructor(container: HTMLElement);
	/** Upper-third band, pointer-events none, auto-hides after `ms`. A new
	 *  warning replaces a visible one and restarts its timer. */
	warn(text: string, ms: number): void;
	/** Full-screen blocking overlay; hides any warning. `breakEndsAt === null`
	 *  shows ASK A GROWN-UP with no countdown node. */
	freeze(breakEndsAt: number | null): void;
	/** Update the countdown line; no-op when the overlay has no countdown
	 *  (no-break freeze) or when `ms` is not finite. */
	setBreakRemaining(ms: number): void;
	/** Replace the countdown with the PLAY AGAIN button. */
	offerPlayAgain(onClick: () => void): void;
	/** Remove the freeze overlay. */
	unfreeze(): void;
}
```

Two DOM nodes under `#app`: `#playtime-warning` (`z-index: 25`, above the HUD
and the colour picker at 20, below the freeze) and `#playtime-freeze`
(`z-index: 30`, `inset: 0`, `pointer-events: auto`). `#save-status` gets
`z-index: 40` so "Saving…/Saved" stays readable over the freeze. Styles go in
`ui.css`; `<select>` gets the same dark styling as the text inputs (there is
none today). Warning text ~8vw, freeze title ~12vw with `word-break: normal`
and a max-width so it wraps on a portrait tablet instead of overflowing.

### `GameLoop` gains `paused`

```ts
paused = false;
```

The guard is the **first statement** of `tick()`, before `player.update` (a
guard after `cam.sync()` would leave gravity running through a 20-minute
break). When paused, `tick()` does only: `cam.sync()`, `loadNearbyChunks()`,
`flushDirtyChunks()`. `setLeftMouseDown(true)` is ignored while paused;
`setLeftMouseDown(false)` is always honoured (it clears in-progress mining).
`dt` is already clamped to 0.1 s by the renderer and `last` advances every
frame, so unpausing after 20 minutes produces a normal ~16 ms step; no extra
clamp is needed and none should be added.

### Input gating (in `main.ts`)

- `onKey(true)` returns early when `loop.paused`. `onKey(false)` is always
  processed so `keys` stays truthful.
- The Tab hotbar-cycle listener and the `mousedown` listener return early when
  `loop.paused`.
- This makes the freeze inert against auto-repeat, fly toggles, hotbar keys,
  ignite (which would otherwise prime a TNT that detonates at PLAY AGAIN), and
  the colour picker (which would otherwise open invisibly under the freeze at
  z-index 20 and pop out on unfreeze).

### Wiring in `main.ts`

`startGame` runs at most once per page load (the menu is reachable only at boot
and from Options before a game starts; unlock is by reload). The interval,
listeners, and overlay therefore need no owner and copy the existing
never-torn-down pattern of the other `startGame` listeners.

In `startGame`, immediately **before** `loop.start()`:

1. `opts.playLimitMin === null` → nothing.
2. `loadSession()`; discard if `null`, `isStale`, or `phaseOf === 'over'`;
   otherwise resume. Create a new one from options if needed. `saveSession`.
3. Construct `PlayTimer(session, Date.now())` and `PlaytimeOverlay`.
4. Define `tickPlaytime()`:
   - `events = timer.tick(Date.now(), document.visibilityState === 'visible')`
   - if `timer.dirty` → `saveSession(timer.session)`
   - for each event, in order:
     - `warn` → `overlay.warn(\`END IN ${n} MINUTE${n === 1 ? '' : 'S'}\`, WARNING_SHOW_MS)`
     - `freeze` → `freezeGame(breakEndsAt)`
     - `break-over` → `overlay.offerPlayAgain(playAgain)`
   - if phase is `'break'` **and** `session.breakMs !== null` →
     `overlay.setBreakRemaining(timer.breakRemainingMs())`
5. Call `tickPlaytime()` **synchronously now**, so a session already in
   `'break'` freezes before the first frame and there is never a playable
   frame on reload-into-break.
6. `setInterval(tickPlaytime, TICK_MS)`; `visibilitychange` → `tickPlaytime()`
   (both visible and hidden: visible refreshes the countdown at once after a
   throttled stretch, hidden persists `playedMs`).

`freezeGame(breakEndsAt)`:

```
loop.setLeftMouseDown(false);
loop.paused = true;
reset keys; hud.setMiningProgress(0);
if (document.pointerLockElement) document.exitPointerLock();
void autosave.flush();
overlay.freeze(breakEndsAt);
```

`playAgain()` (from the PLAY AGAIN click):

```
session = { limitMs, breakMs, playedMs: 0, frozenAt: null, updatedAt: now }
saveSession(session); timer = new PlayTimer(session, now);
overlay.unfreeze(); reset keys; loop.paused = false;
renderer.gl.domElement.requestPointerLock();
```

The interval runs on the wall clock and credits play time only on visible
ticks, so a hidden tab (interval throttled to once a minute by Chrome after
5 minutes) neither stretches nor shortens the play phase, while the break
phase, being wall-clock, elapses regardless. A freeze that falls due while
hidden is applied on the next throttled tick or on `visibilitychange`,
whichever comes first; the world is already safe because autosave flushes on
hidden.

### Main menu

`MainMenu.renderHome()` appends the Play time section via a
`renderPlaytime(card)` helper, called once before the world-list `await` and
again when the card is rebuilt after it. Dropdown changes and the two buttons
go through `applyPlaytimeSetting` / `clearSession` and re-render the section.
The menu needs no new `MenuAction`; `main.ts` reads options at `startGame` as
it already does.

## Sequence

```
parent: menu → Play for 30, Then break for 20 → clicks world
main.ts: startGame → loadSession() = null → save {30m, 20m, played 0}
                      tickPlaytime() sync → no events → loop.start()
25 min played   tick → warn(5)       "END IN 5 MINUTES" for 10 s
28 min played   tick → warn(2)       "END IN 2 MINUTES" for 10 s
30 min played   tick → freeze        paused, saved, "TIME'S UP / PLAY AGAIN IN 20 MINUTES"
…               tick each second     "PLAY AGAIN IN 19 MINUTES" … "1 MINUTE"
frozenAt+20m    tick → break-over    PLAY AGAIN button
kid clicks → new session {played 0}, unfreeze, pointer lock requested
```

Reload with 27 min played: `phaseOf` = `'playing'`, 3 min left → resume; the
synchronous first tick fires `warn(3)` → "END IN 3 MINUTES"; `warn(2)` a
minute later as normal.

Reload 5 min into a 20-min break: `phaseOf` = `'break'` → the synchronous first
tick fires `freeze` → loop starts paused, chunks mesh under "TIME'S UP / PLAY
AGAIN IN 15 MINUTES".

Reload after a hidden stretch that skipped the whole break: first tick fires
`[freeze, break-over]` → overlay shows TIME'S UP with the PLAY AGAIN button.

Parent wants to unlock a no-break freeze: reload, menu shows
`Locked — ask a grown-up [Unlock]`, press Unlock, pick the world → fresh
session.

## Error handling

- Garbage or wrong-shaped `minicraft:v1:playtime` → treated as no session.
- `localStorage` throwing (quota, private mode) on `saveSession` → caught and
  ignored; the in-memory timer still enforces the limit for this page load.
- Clock moved backwards → no play time accrues, break comparisons use the
  monotonic `lastNow`; nothing un-fires.
- Autosave flush failing at freeze → same handling as any other failed save
  (status indicator); the freeze proceeds regardless.
- An exception inside `tickPlaytime` would kill the interval and the whole
  timer; the only throwing candidate (`setBreakRemaining(Infinity)`) is
  removed by the gate in step 4 and the no-op contract in the overlay.

## Testing

Unit (vitest, node). Each new test must be shown red before the code that
makes it green exists.

- `src/game/playtime.test.ts`: rules 1–6 under "Behavioural rules", the
  sequence above driven by fake `now` values, the `[freeze, break-over]`
  single-call case, and the "6 min → 1 min in one tick yields only `warn(1)`"
  case.
- `src/persistence/playtime.test.ts`: round-trip, missing, garbage JSON, each
  wrong-shape field → `null`; `applyPlaytimeSetting` saves options and removes
  the session key; `clearSession` removes it.
- `src/persistence/options.test.ts`: `expect(loadOptions().playLimitMin).toBeNull()`
  literally (not `toBeUndefined`, not `?? null`) on empty storage; round-trip of
  `{playLimitMin: 30, playBreakMin: 20}`; a non-member value (`"30"`, `7`) loads
  as `null`. The boundary reviewer confirmed the first two fail on the current
  tree.
- `src/game/loop.test.ts`: the existing stub renderer discards the `onTick`
  callback and its `keys` object has a stale shape, so a test driving
  `simulate()` cannot observe `paused`. The stub must **capture** the tick
  function and pass a real `Keys` object. Test: `keys.forward = true`, prime a
  TNT via `loop.ignite`, set `paused = true`, drive the captured tick past
  `TNT_PRIME_FUSE`; assert `player.position` unchanged, `onWorldMutated` not
  called, and `mountChunkMesh` **was** called (chunks still load). Unpause,
  drive again; assert the player moved and `onWorldMutated` fired. The engine
  reviewer ran this harness shape headless (20 ticks with chunk gen, ~2 s).

Manual, at `localhost:5173` only (never the production site). Set up each
case by editing `minicraft:v1:playtime` in devtools, then reloading and
picking a world:

- `{limitMs: 900000, breakMs: null, playedMs: 870000, frozenAt: null,
  updatedAt: Date.now()}` (15 min limit, 30 s left): "END IN 1 MINUTE" at
  once; freeze after 30 s of visible play. Mine a block just before the freeze
  so the flush has something to write and the save indicator shows "Saved".
  Confirm: keys and mouse do nothing, clicking the overlay does not lock the
  pointer, the fly/hotbar keys change nothing, pressing the light-colour key
  opens nothing. Reload: menu shows `Locked — ask a grown-up [Unlock]`; pick
  the world without pressing Unlock → frozen before any frame is playable;
  reload, press Unlock, pick the world → fresh session.
- `{limitMs: 900000, breakMs: 600000, playedMs: 900000, frozenAt: Date.now() -
  590000, updatedAt: Date.now()}`: world loads paused under "PLAY AGAIN IN 1
  MINUTE"; within ~10 s the PLAY AGAIN button appears; clicking it resumes and
  locks the pointer without a second click.
- Hide the tab for 30 s during play; `playedMs` in storage does not advance.
- Change "Play for" on the menu → the `minicraft:v1:playtime` key is gone.

## Files

| File | Change |
|---|---|
| `src/data/playtime.data.ts` | new |
| `src/game/playtime.ts` + test | new |
| `src/persistence/playtime.ts` + test | new |
| `src/ui/playtime-overlay.ts` | new |
| `src/ui/ui.css` | warning, freeze, `<select>`, `#save-status` z-index |
| `src/ui/menu.ts` | Play time section + status row |
| `src/data/keybindings.data.ts` | `Options` gains two fields |
| `src/persistence/options.ts` + test | defaults and validation for the two fields |
| `src/game/loop.ts` + test | `paused`; test stub captures the tick |
| `src/main.ts` | wiring, input gating |
| `docs/playtime.md` | subsystem doc |
| `docs/persistence.md` | one clarifying sentence on v1 keys |
| `README.md` | feature line, incl. "no PIN" and the 12-hour rule |
