# Pause menu (Esc) — design

Date: 2026-09-25. Branch `pause-menu`, off `main` @ a3ee265.

## 1. What Julien asked for

> When in the game, solo or multiplayer, pressing ESC should open a menu, overlaid on the game,
> unless the inventory is open since ESC closes it too. Keep UI/UX consistent.
> Menu: Return to Game · Controls · Quit (main menu)

## 2. The problem Esc actually poses

While the game has the mouse (pointer lock), **the browser keeps Esc for itself**: Chrome and
Firefox use it to release the pointer and do not deliver a `keydown` to the page. So "press Esc"
reaches the game only as a `pointerlockchange` with `document.pointerLockElement === null`.

Today that unlock just leaves the game running with a free cursor; a click on the canvas takes the
mouse back (README "Menu": "Esc — exit pointer-lock … the world keeps running").

The game also releases the pointer **itself** in four places, and none of those must open the
pause menu:

| Owner | Where | Flag set before `exitPointerLock()` |
|---|---|---|
| I screen | `openInventory` (main.ts) | `inventoryOpen = true` |
| Colour picker (C) | `ColorPicker.show` | picker root un-hidden (`colorPicker.isOpen`) |
| Play timer freeze | `playtime.freeze` | `frozen = true` |
| Network freeze (MP) | `freezeForNetwork` | `frozen = true`, `loop.mpDisconnected = true` |

`pointerlockchange` is dispatched asynchronously, after each of those flags is already set.

## 3. Behaviour

### 3.1 When the pause menu opens

The pause menu opens when, during a game (after `startGame`), either:

- **(a)** the pointer lock is lost (`pointerlockchange`, not locked) and no owner from §2 holds the
  screen (`!inventoryOpen && !colorPicker.isOpen && !frozen`) and the pause menu is not already
  open; or
- **(b)** an `Escape` keydown reaches the page while the pointer is **not** locked, nothing from §2
  is open, and the pause menu is not open — the "I clicked outside / closed the I screen and now
  press Esc" case. This keydown must be the *same* keypress that closed the I screen or the colour
  picker: that one must **not** reopen anything. Rule: decide from the state *before* any Esc
  handler ran this event (see §5.2).

Case (a) also covers alt-tab / focus loss, which releases the pointer too: the game comes back
paused behind the menu, as in Minecraft. This is intended.

### 3.2 What pausing does

Exactly what an open I screen does today (reuse, don't invent):

- `loop.paused` becomes true (a third owner in `updatePaused`: `frozen || inventoryOpen || pauseOpen`),
  the mouse button is released (`loop.setLeftMouseDown(false)`), the mining ring cleared, held keys
  reset on close.
- **Solo:** the world stops (the paused branch loads/meshes chunks only).
- **Multiplayer:** the shared world keeps running (remote ops, simulation — the existing C3 rule in
  `loop.tickBody`); only the local player stands still. Their `pos` stops changing so nothing is sent.
- **The play timer keeps counting.** The pause menu is not a way around the parent's limit. If the
  timer freezes the game while the pause menu is up, the freeze wins: the pause menu closes (same as
  `closeInventory()` in `freeze`), the TIME'S UP screen shows.
- Same for the network freeze: `freezeForNetwork` closes the pause menu, "Reconnecting…" shows.
- Keys: while the pause menu is open, game keydowns are dropped (`shouldHandleKey` gains a
  `pauseOpen` input that behaves like `frozen` for keydowns; keyups always pass). Tab and Shift
  (sneak) likewise. Mouse: the canvas click that normally re-locks must not fire through the overlay
  — the overlay covers the canvas and takes the clicks.

### 3.3 The screen

An overlay on top of the running game (the world stays visible, dimmed), holding one card styled
with the existing menu classes so it matches the main menu:

- backdrop: `position: fixed; inset: 0; background: rgba(0,0,0,0.55)`, z-index 20 (above the I
  screen's 15, below the timer's 30 and the MP screens);
- card: `.menu-card`, title `<h1>Paused</h1>`;
- buttons, in order, the big green `.home-button` for the first and the normal `.menu-card button`
  for the others:
  1. **Return to Game** — closes the menu and asks for the pointer lock (the click is a user
     gesture). A rejected / failed request is swallowed (same `p.catch(() => {})` as the timer's
     resume); the kid can still click the canvas.
  2. **Controls** — replaces the card's contents with the Controls view (§3.4).
  3. **Quit to Menu** — §3.5.

**Esc while the pause menu is open** = Return to Game (Minecraft does this). Chrome may refuse a
lock requested within ~1 s of the user's own Esc unlock; if the request fails, the menu is closed
anyway and the game sits unlocked — the next canvas click locks, the next Esc re-opens the menu by
rule (b). Esc in the Controls view goes back to the pause card (not to the game).

### 3.4 Controls view

A read-only list, not the Options rebinding screen: bindings are read once at `startGame`
(`keyToAction`), so rebinding mid-game would silently not apply; rebinding stays on the main menu's
Options. Rows are **what it does → key**, with the key shown as the game shows keys elsewhere
(`keycapLabel`), from the live `opts.keybindings`; an unbound action is left out. Mouse and fixed
keys are listed too. Order and wording, kid-sized:

| Does | Key |
|---|---|
| Walk | W A S D (the four live bindings) |
| Jump | jump binding |
| Mine | Hold left click |
| Build | Right click |
| Swap a block | Shift + right click |
| Pick a block | 1 – 9, Tab |
| Inventory | inventory binding |
| Change pickaxe | cyclePickaxe binding |
| Fly | toggleFly binding |
| Fly faster / slower | flySpeedUp / flySpeedDown |
| Light TNT | ignite binding |
| Lamp colour | pickLightColor binding |
| Sneak | Shift |
| Pause | Esc |

The row table is data (`src/data/controls.data.ts`), built into rows by a pure function (unit
tested). One **Back** button (`.menu-back`) returns to the pause card.

### 3.5 Quit to Menu

The main menu is only reachable by a reload today (startGame runs once per page load). Quit reuses
that:

- **Solo:** `await autosave.flush()` (the cloud upload included when there is one; the button shows
  "Saving…" and is disabled meanwhile), then `location.reload()`. If the flush rejects, reload
  anyway: `pagehide` already writes the local copy synchronously.
- **Multiplayer:** clear `mp:autojoin` **first** (so the reload lands on the menu, never a rejoin),
  send `leaving {secondsLeft: 0}` so the friend sees "Noah went home" (the existing toast; no protocol
  change), `mpSync.flushFrame()`, `autosave.flush()` (the MP save stand-in), `client.close(1000)`,
  then `location.reload()` — the same order the timer freeze uses at 0.
- **Play timer:** a reload applies the existing refresh rule (spec §8.1 of the play-time design):
  without a PIN or schedule the session is discarded, exactly as an F5 or the TIME'S UP "MENU" button
  does today. Quit adds no new way around the limit.

No confirmation dialog: nothing is lost by quitting (the world is saved), and a 7-year-old reads
"Are you sure?" as an obstacle.

## 4. Not in scope

- No settings / volume / FOV in the pause menu. No "Options" (rebinding) mid-game.
- No change to the protocol, the server, the save format or the timer rules.
- The main menu itself is unchanged.

## 5. Structure

### 5.1 Files

- `src/ui/pause-menu.ts` — `PauseMenu` class (DOM only): `open()`, `close()`, `isOpen`,
  `showControls()`, callbacks `onResume`, `onQuit`; ids `pause-root`, `pause-resume`,
  `pause-controls`, `pause-quit`, `pause-back` for tests.
- `src/data/controls.data.ts` — the §3.4 rows (label + action key or fixed key text).
- `src/ui/controls-model.ts` — `controlRows(bindings)` → `{does, keys}[]` (pure, unit tested).
- `src/game/pause-model.ts` — pure decision functions (unit tested):
  - `shouldOpenOnUnlock(s)` for rule (a);
  - `escapeAction(s)` → `'open' | 'resume' | 'back' | 'none'` for a keydown Escape, given
    `{locked, pauseOpen, controlsShown, inventoryOpen, pickerOpen, frozen}` *as they were before any
    handler of this event ran*.
- `src/game/input-gate.ts` — `GateState` gains `pauseOpen`.
- `src/main.ts` — wiring inside `startGame`.
- `src/ui/ui.css` — `#pause-root` backdrop.
- README "How to play → Menu" line updated; `docs/` gets no new subsystem doc (a short section in
  README is enough).

### 5.2 Esc ordering

The I screen, the colour picker and the inventory search each have their own `window` keydown
listener for Escape, registered before `startGame`'s. To read the state *before* they ran, main.ts
registers its Escape listener in the **capture** phase on `window` (`addEventListener('keydown', …,
true)`): capture-phase listeners on `window` run before bubble-phase ones on `window`. It snapshots
the state, decides with `escapeAction`, and acts after (so it does not reorder the others). It does
not `stopPropagation`.

### 5.3 Dev oracle

`window.__mc.pause = { isOpen, controlsShown }` (DEV only), for the smoke.

## 6. Tests

⚠ Headless Chromium cannot produce a real Esc-releases-pointer-lock, and `requestPointerLock` in
headless is unreliable. So the instrument is split, and each part must be able to go red:

1. **Unit (vitest):** `pause-model` — every row of the §3.1 / §3.3 decisions, including "Esc that
   closes the I screen does not open the pause menu" and "unlock while the picker opens does not
   open it". `controlRows` — live bindings shown, an unbound action left out, a rebinding changes the
   row. `shouldHandleKey` with `pauseOpen`. Each test is checked to fail against a stub that returns
   the opposite / against the pre-change `input-gate`.
2. **Browser smoke** (`scripts/pause-smoke.ts`, same safety harness as `menu-smoke.ts`: own Vite on a
   free port, dead save API, any non-localhost request aborts the run): New World → play; then
   - fire the unlock path by dispatching a real `pointerlockchange` on `document` while
     `pointerLockElement` is null → `#pause-root` visible, `__mc.loop.paused === true`;
   - the player does not move while W is held under the menu;
   - Controls → rows present, the jump row shows the bound key; Esc → back to the pause card;
   - Return to Game → menu hidden, `loop.paused === false`;
   - open the I screen (I), press Esc → I screen closed **and** pause menu **not** open;
   - press Esc with nothing open and unlocked → pause menu opens (rule b);
   - Quit → the page reloads to the main menu, and the world is in the list with the block placed
     before quitting (proves the flush);
   - the timer: set `__mc.playtime.setRemaining(1)` with the pause menu open → TIME'S UP visible,
     pause menu hidden.
   The smoke's own sanity: run once on `main` (no pause menu) and confirm it fails at the first
   check.
3. **Multiplayer** — one scenario added to `scripts/mp-e2e.ts` (it already runs two clients on a
   local `mcserver`): A pauses; B places a block; A still receives it (A's world has it while paused);
   A quits → B gets the "went home" toast, and A's page is on the menu, not rejoining.

Manual check at `localhost:5173` in a headed browser (by Julien, not on his display by an agent):
real Esc with the pointer locked opens the menu.
