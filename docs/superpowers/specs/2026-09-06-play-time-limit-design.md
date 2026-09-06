# Play-Time Limit — Design

**Date:** 2026-09-06
**Status:** Draft, awaiting gate 1
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
configured, the freeze holds until a grown-up changes the setting on the menu.

The point is to get the kid away from the screen. The design therefore favours
predictability and reload-resistance over cleverness.

## Non-goals

- No PIN or password. A determined kid can turn the limit off on the menu. This
  is accepted for a seven-year-old; a PIN can be added later without changing
  anything below.
- No daily quota, no schedule, no accumulated totals. One session, one limit.
- No cloud sync of the setting. It lives in this browser's `localStorage`, like
  the other options.
- No in-game clock display during normal play. Warnings only, as asked ("low
  verbosity").
- No change to the world save format.

## User-facing behaviour

### Main menu

Below the world lists and above the "Options" button, a section titled
**Play time** with two dropdowns:

| Control | Choices | Default |
|---|---|---|
| Limit | Off, 15, 20, 30, 45, 60, 90 min | Off |
| Break | Until a grown-up unlocks, 10, 15, 20, 30, 60 min | Until a grown-up unlocks |

The Break dropdown is disabled while Limit is Off. Changes save immediately (no
"Save" button) and **clear any active or locked session** (see "Persisted
session"). This is how a grown-up unlocks a frozen game: reload, change the
setting, pick the world.

### During play

Sessions are measured on the **wall clock** (`Date.now()`), not on frames. A
hidden tab or a throttled `requestAnimationFrame` does not stretch the session.

| Remaining | What happens |
|---|---|
| ≤ 5 min (first time) | Warning overlay: `END IN 5 MINUTES` |
| ≤ 2 min (first time) | Warning overlay: `END IN 2 MINUTES` |
| 0 | Freeze |

A warning is a large centred text block over the game, visible for 10 seconds,
then fades out. It has `pointer-events: none`, does not exit pointer lock, and
does not stop the game loop. The kid keeps playing through it. The number in the
text is `ceil(remaining / 60 s)`, so a session resumed with 4 minutes left says
`END IN 4 MINUTES` immediately, not `5`.

### Freeze

At the limit, in this order:

1. The game loop is paused: no player update, no mining, no liquid/TNT
   simulation, no chunk loading. Rendering continues (the last frame stays on
   screen behind the overlay).
2. Held keys and the held mouse button are cleared, so nothing moves on resume.
3. Pointer lock is released.
4. Autosave is flushed so the world is saved as of the freeze.
5. A full-screen overlay is shown. It covers the canvas and captures all pointer
   events, so a click cannot re-acquire pointer lock. Keyboard input is ignored
   by the loop while paused.

Overlay content:

- **Break configured:** `TIME'S UP` and below it `PLAY AGAIN IN 19:59`, ticking
  every second. At `0:00` the countdown is replaced by a large **PLAY AGAIN**
  button.
- **No break:** `TIME'S UP` and below it `ASK A GROWN-UP`. No button.

### Play again

Clicking **PLAY AGAIN** starts a fresh session with the same limit and break
(`startedAt = now`), hides the overlay, and unpauses the loop. The kid clicks
the canvas to re-acquire pointer lock as usual. Warnings fire again at 5 and 2
minutes of the new session.

## Persisted session

Reload must not reset the clock. The active session is stored in
`localStorage` under `minicraft:v1:playtime`:

```ts
type PlaytimeSession = {
	startedAt: number;   // ms since epoch, wall clock
	limitMs: number;
	breakMs: number | null;
};
```

Everything else (deadline, break end, phase) is derived from these three
numbers and `now`:

```
deadline  = startedAt + limitMs
breakEnd  = breakMs === null ? Infinity : deadline + breakMs
phase(now) =
	now <  deadline              → 'playing'
	now <  breakEnd              → 'break'
	otherwise                    → 'over'   (a new session may start)
```

Rules:

- **Start of play** (`startGame` in `main.ts`): if options have Limit Off, no
  session is created and nothing below applies. Otherwise load the stored
  session. If there is none, or its phase is `'over'`, or it is **stale**, write
  a new one with `startedAt = now`. If its phase is `'playing'`, resume it with
  the remaining time. If its phase is `'break'`, show the freeze overlay
  immediately with the remaining break (the world still loads underneath, paused
  and saved).
- **Stale:** a session whose `startedAt` is more than 12 hours old is discarded.
  Without this, a no-break session from yesterday would still be frozen this
  morning and the parent would have to re-arm the setting every day. Twelve
  hours is long enough that a lock set at breakfast still holds at dinner.
- **Play again** overwrites the stored session with `startedAt = now`.
- **Changing Limit or Break on the menu** removes the stored session.
- The stored session's own `limitMs`/`breakMs` win over the options while it is
  in force. Options are only read when a *new* session is created. This keeps
  "the parent changed the setting" and "the session is still running" from
  disagreeing mid-session; changing the setting clears the session anyway.

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

`loadOptions()` defaults both to `null` when absent, so existing saved options
keep working.

## Architecture

Four small units, one clear purpose each. Only `main.ts` sees more than one.

### `src/data/playtime.data.ts` (pure data)

The dropdown choices, the warning thresholds, the warning display duration, and
the stale threshold:

```ts
export const PLAY_LIMIT_CHOICES_MIN = [15, 20, 30, 45, 60, 90];
export const PLAY_BREAK_CHOICES_MIN = [10, 15, 20, 30, 60];
export const WARNING_THRESHOLDS_MS = [5 * 60_000, 2 * 60_000];
export const WARNING_SHOW_MS = 10_000;
export const STALE_SESSION_MS = 12 * 3_600_000;
```

### `src/game/playtime.ts` (pure state machine, no DOM, no storage)

```ts
export type PlaytimePhase = 'playing' | 'break' | 'over';
export type PlaytimeEvent =
	| { type: 'warn'; minutesLeft: number }
	| { type: 'freeze'; breakEndsAt: number | null }
	| { type: 'break-over' };

export class PlayTimer {
	constructor(session: PlaytimeSession);
	/** Advance to `now`. Returns the events that fired, in order. Idempotent
	 *  for the same `now`; each warning threshold and the freeze fire once. */
	update(now: number): PlaytimeEvent[];
	phase(now: number): PlaytimePhase;
	remainingMs(now: number): number;      // until deadline, ≥ 0
	breakRemainingMs(now: number): number; // until breakEnd, ≥ 0; Infinity when no break
	readonly session: PlaytimeSession;
}

export function isStale(session: PlaytimeSession, now: number): boolean;
export function phaseOf(session: PlaytimeSession, now: number): PlaytimePhase;
```

Behavioural rules, each covered by a unit test:

- Thresholds already crossed on the first `update` fire once, immediately, with
  `minutesLeft = ceil(remaining / 60 000)`. A first `update` with 90 s left
  yields exactly one `warn` with `minutesLeft = 2` (the 5-minute one is
  subsumed: only the *lowest* crossed threshold fires).
- A first `update` past the deadline yields `freeze` and no `warn`.
- `freeze` fires exactly once. `break-over` fires exactly once, only after
  `freeze`, and never when `breakMs === null`.
- `update` with a `now` earlier than the previous `now` (clock set back) is
  treated as no time passing. It never un-fires anything.

### `src/persistence/playtime.ts` (storage)

```ts
export function loadSession(): PlaytimeSession | null;  // null on missing/garbage
export function saveSession(s: PlaytimeSession): void;
export function clearSession(): void;
```

Same `localStorage` stub pattern as `options.test.ts`.

### `src/ui/playtime-overlay.ts` (DOM only)

```ts
export class PlaytimeOverlay {
	constructor(container: HTMLElement);
	/** Big centred text, pointer-events none, auto-hides after `ms`. A new
	 *  warning replaces a visible one and restarts its timer. */
	warn(text: string, ms: number): void;
	/** Full-screen blocking overlay. `breakEndsAt === null` shows ASK A GROWN-UP. */
	freeze(breakEndsAt: number | null): void;
	/** Update the countdown text (called once a second while frozen). */
	setBreakRemaining(ms: number): void;
	/** Replace the countdown with the PLAY AGAIN button. */
	offerPlayAgain(onClick: () => void): void;
	/** Remove the freeze overlay (warnings are unaffected). */
	unfreeze(): void;
}
```

Two DOM nodes: `#playtime-warning` (z-index above the HUD, `pointer-events:
none`) and `#playtime-freeze` (z-index above the colour picker, `pointer-events:
auto`, `inset: 0`). Styles go in `ui.css` next to the other overlays. Text is
uppercase, ~9vw on the warning and ~12vw on the freeze title, white on a dark
translucent band, so it is unmissable at tablet distance but does not hide the
whole view.

### `GameLoop` gains `paused`

```ts
paused = false;
```

`tick()` returns after `cam.sync()` when paused: the camera stays where it is,
nothing else runs. `setLeftMouseDown()` is a no-op while paused.

### Wiring in `main.ts`

In `startGame`, after the loop starts:

1. `opts.playLimitMin === null` → nothing.
2. Load the stored session; discard if stale or `'over'`; otherwise resume.
   Create a new one from options if needed. Save it.
3. Construct `PlayTimer`, `PlaytimeOverlay`.
4. `setInterval(1000)` calling `timer.update(Date.now())` and dispatching:
   - `warn` → `overlay.warn(\`END IN ${n} MINUTE${n === 1 ? '' : 'S'}\`, WARNING_SHOW_MS)`
   - `freeze` → `freezeGame(breakEndsAt)`: `loop.paused = true`, reset `keys`,
     `loop.setLeftMouseDown(false)` (called *before* setting paused),
     `document.exitPointerLock()`, `void autosave.flush()`, `overlay.freeze(breakEndsAt)`.
   - `break-over` → `overlay.offerPlayAgain(playAgain)`.
   - While phase is `'break'`: `overlay.setBreakRemaining(timer.breakRemainingMs(now))`.
5. `playAgain`: build a new session `{ startedAt: Date.now(), limitMs, breakMs }`
   from the current one, save it, replace `timer`, `overlay.unfreeze()`,
   `loop.paused = false`.
6. The `visibilitychange` → visible event also triggers an immediate `update`,
   so a freeze that fell due while the tab was hidden shows the moment the kid
   comes back rather than up to a second later.

The interval runs on the wall clock, so even if `requestAnimationFrame` is
paused (hidden tab) the freeze state is computed correctly on the next tick.

### Main menu

`MainMenu.renderHome()` appends the Play time section. It reads the current
options with `loadOptions()`, writes with `saveOptions()` on every change, and
calls `clearSession()` on every change. The menu does not need a new
`MenuAction`; `main.ts` reads options at `startGame` as it already does.

## Sequence

```
parent: menu → Limit 30, Break 20 → clicks world
main.ts: startGame → loadSession() = null → save {startedAt: T, 30m, 20m}
T+25m   update → warn(5)      overlay "END IN 5 MINUTES" for 10 s
T+28m   update → warn(2)      overlay "END IN 2 MINUTES" for 10 s
T+30m   update → freeze       loop paused, saved, "TIME'S UP / PLAY AGAIN IN 20:00"
T+30m…  update each second    "PLAY AGAIN IN 19:59" … "0:01"
T+50m   update → break-over   PLAY AGAIN button
kid clicks → new session {startedAt: T+50m+, 30m, 20m}, unfreeze, resume
```

Reload at T+27m: startGame → loadSession() phase 'playing', 3 min left →
resume; first update fires `warn(3)` → "END IN 3 MINUTES"; 2-min warning at
T+28m as normal.

Reload at T+35m: phase 'break' → world loads paused under "TIME'S UP / PLAY
AGAIN IN 15:00".

## Error handling

- Garbage in `minicraft:v1:playtime` → treated as no session.
- `localStorage` throwing (quota, private mode) on `saveSession` → caught and
  ignored; the in-memory timer still enforces the limit for this page load.
- Clock moved backwards → no time passes; nothing un-fires.
- Autosave flush failing at freeze → same handling as any other failed save
  (status indicator); the freeze proceeds regardless.

## Testing

Unit (vitest, node):

- `src/game/playtime.test.ts`: every rule under "Behavioural rules", plus the
  sequence above driven by fake `now` values.
- `src/persistence/playtime.test.ts`: round-trip, garbage, missing.
- `src/persistence/options.test.ts`: new fields default to `null`; stored values
  round-trip.
- `src/game/loop.test.ts`: `paused` skips `simulate` side effects (existing test
  file already drives `simulate` without WebGL).

Manual, at `localhost:5173` only (never the production site):

- Set Limit 15 on the menu, then in devtools overwrite
  `minicraft:v1:playtime` with `startedAt = Date.now() - 14.5 * 60_000` and
  reload. Pick the world. Within a second: `END IN 1 MINUTE`. Thirty seconds
  later: freeze. Confirm the world cannot be moved (keys, mouse), that clicking
  the overlay does not lock the pointer, and that the save indicator showed a
  save.
- Same with Break 10 and `startedAt = Date.now() - 24.9 * 60_000` to land at the
  end of the break: `PLAY AGAIN` appears within seconds; clicking it resumes.
- Change Limit on the menu → `minicraft:v1:playtime` key is gone.

## Files

| File | Change |
|---|---|
| `src/data/playtime.data.ts` | new |
| `src/game/playtime.ts` + test | new |
| `src/persistence/playtime.ts` + test | new |
| `src/ui/playtime-overlay.ts` | new |
| `src/ui/ui.css` | warning + freeze styles |
| `src/ui/menu.ts` | Play time section |
| `src/data/keybindings.data.ts` | `Options` gains two fields |
| `src/persistence/options.ts` + test | defaults for the two fields |
| `src/game/loop.ts` + test | `paused` |
| `src/main.ts` | wiring |
| `docs/playtime.md` | subsystem doc |
| `README.md` | one line in the feature list |
