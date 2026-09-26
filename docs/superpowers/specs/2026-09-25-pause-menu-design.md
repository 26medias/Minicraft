# Pause menu (Esc) — design

Date: 2026-09-25. Branch `pause-menu`, off `main` @ a3ee265. Rev 2 (gate 1 incorporated, §8).

## 1. What Julien asked for

> When in the game, solo or multiplayer, pressing ESC should open a menu, overlaid on the game,
> unless the inventory is open since ESC closes it too. Keep UI/UX consistent.
> Menu: Return to Game · Controls · Quit (main menu)

## 2. What Esc really does in a browser (measured at gate 1)

Measured in Chromium with real X key events (xdotool, headed Chromium on a private Xvfb display):

- **M1.** A real Esc while the pointer is locked releases the lock; the page gets
  `pointerlockchange` (unlocked) and **no keydown and no keyup**.
- **M2.** `requestPointerLock()` never throws; it returns a promise. Within ~1.2–1.5 s of the
  user's own Esc unlock it is **refused** (SecurityError, and `pointerlockerror` fires, no
  `pointerlockchange`). Firefox returns `undefined` (no promise): `pointerlockerror` is the one
  signal that works in both.
- **M3.** A lock requested from an Esc keydown/keyup is refused inside the cooldown and, after it, is
  granted then dropped in the same millisecond (Esc is not an activating key). **Esc can never give
  the mouse back.**
- **M4.** Headless Chromium is permissive: the lock is granted without a gesture, a CDP Esc arrives
  as a keydown and does *not* unlock, and `document.exitPointerLock()` fires a real
  `pointerlockchange`. Headless cannot reproduce M1–M3.

The game releases the pointer **itself** in four places, none of which may open the pause menu:

| Owner | Where | Flag set before `exitPointerLock()` |
|---|---|---|
| I screen | `openInventory` (main.ts) | `inventoryOpen = true` |
| Colour picker (C) | `ColorPicker.show` | `colorPicker.isOpen` |
| Play timer freeze | `playtime.freeze` | `frozen = true` |
| Network freeze (MP) | `freezeForNetwork` | `frozen = true` |

`pointerlockchange` is dispatched asynchronously, after each flag is set.

## 3. Behaviour

### 3.1 When the pause menu opens

During a game (after `startGame`), the pause menu opens when either:

- **(a) unlock:** `pointerlockchange` with `document.pointerLockElement !== canvas`, and none of
  `inventoryOpen`, `colorPicker.isOpen`, `frozen`, `pauseOpen`, `quitting`. This is the real-Esc
  path (M1). Alt-tab / focus loss unlocks too, so the kid comes back to a stopped world behind the
  menu, as in Minecraft — intended.
- **(b) Esc while unlocked:** an `Escape` keydown, not `e.repeat`, with the pointer not locked, and
  none of the flags above as they were **before any Esc handler of this event ran** (§5.2). This is
  the "I closed the I screen / clicked outside, now I press Esc" case. The Esc that closes the I
  screen, clears its search, or closes the colour picker opens nothing.

Accepted race: if an owner opens and closes within the same frame, before its own async
`pointerlockchange` arrives, the menu opens over nothing. Harmless (Return to Game).

### 3.2 While the pause menu is open

- **Esc on the pause card does nothing** (M3: it cannot resume). **Esc in the Controls view** goes
  back to the pause card (non-repeat only).
- A click on the backdrop outside the card does nothing.
- `loop.paused` is true: a third owner in `updatePaused` (`frozen || inventoryOpen || pauseOpen`).
  On open: `loop.setLeftMouseDown(false)` (multiplayer then sends `mine-stop` on the next frame),
  mining ring cleared. On close: `resetKeys()`.
- **Solo:** the world stops (the paused branch only loads/meshes chunks).
- **Multiplayer:** the shared world keeps running (the existing C3 rule in `loop.tickBody`); only the
  local player stands still, so no `pos` is sent. The friend sees Noah's avatar standing — no cue.
- **The play timer keeps counting.** If the timer freezes the game while the menu is up, the freeze
  wins: the menu closes (like `closeInventory()` in `freeze`) and TIME'S UP shows. Same for
  `freezeForNetwork` ("Reconnecting…").
- Input gates, all keyed on `pauseOpen`:
  - `shouldHandleKey` gains `pauseOpen` (drops every keydown like `frozen`; keyups pass);
    `sneakKeyChange` likewise;
  - Tab does nothing under the pause menu: the Tab listener calls `preventDefault` and returns on
    `pauseOpen`, so it neither cycles the hotbar nor moves focus (gate 2: Tab-Tab-Space would reach
    Quit); focus stays on Return to Game, where Space/Enter resume;
  - the F3 listener returns on `pauseOpen`;
  - `openInventory` refuses on `pauseOpen` (the one entry point: I key, HUD pickaxe);
  - mouse: `#pause-root` covers the canvas (fixed, inset 0, pointer-events auto), so no canvas click
    and no mousedown reaches the game; `mousedown` is also guarded by `loop.paused`.

### 3.3 The screen

An overlay on the running game (the world stays visible, dimmed), one card in the existing menu
style so it matches the main menu:

- `#pause-root`: `position: fixed; inset: 0; background: rgba(0,0,0,0.55)`, flex-centred,
  `overflow-y: auto` (the Controls card is ~570 px tall), **z-index 18**: above the I screen (15),
  below toasts / colour picker (20), the timer (25/30) and the MP screens (50). Hidden =
  `display: none`.
- card: `.menu-card`. Title **"Paused"** in solo, **"Game Menu"** in multiplayer (the friend's world
  keeps going, so "Paused" would be untrue).
- buttons, in order:
  1. **Return to Game** — `.home-button` (big green).
  2. **Controls** — plain `.menu-card button`.
  3. **Quit to Menu** — plain button, with a 28 px top margin (margins collapse; 28 px is the visible
     gap) so it is set apart from the other two against mis-clicks.
- On open, and on Back from Controls, focus moves to Return to Game; the card view is always the pause
  card on open (the Controls view is reset by `close()`).

### 3.4 Return to Game

A click on Return to Game requests the pointer lock (a user gesture) and **does not close the menu**.
The menu closes when `pointerlockchange` reports the canvas locked. On a refusal (promise rejection,
or `pointerlockerror`) the menu stays open and nothing else happens; the kid clicks again (the
cooldown is ~1.5 s, M2). The promise's rejection is swallowed; no `pointerlockerror` handler is
needed, since a refusal changes nothing.

Consequence for rule (a): the lock-granted `pointerlockchange` closes the menu; it never opens one.

### 3.5 Controls view

Read-only, not the Options rebinding screen: bindings are read once at `startGame` (`keyToAction`),
so a mid-game rebinding would not apply; rebinding stays on the main menu's Options.

Rows are **what it does → key(s)**, built from the live `opts.keybindings` by a pure function.
Key text goes through one display function, `keyText(code)`: `KeyW`→`W`, `Digit3`→`3`,
`Numpad3`→`Num 3`, `Space`→`Space`, `Equal`→`=`, `Minus`→`-`, `ShiftLeft`/`ShiftRight`→`Shift`,
`Escape`→`Esc`, `Backquote`→`` ` ``, `ArrowUp`→`↑` (etc.), anything else as `e.code`. Words are the
kid words below, one spelling: "color", as in the rest of the app.

| Does | Key(s) |
|---|---|
| Walk | forward, left, back, right bindings, e.g. `W A S D` |
| Jump | jump |
| Mine | Hold left click |
| Build | Right click |
| Swap a block | Shift + right click |
| Choose a block | slot1…slot9: `1 – 9` when they are exactly Digit1…Digit9, else the nine keys; then `, Tab` |
| Inventory | inventory |
| Change pickaxe | cyclePickaxe |
| Fly | toggleFly |
| Fly faster / slower | flySpeedUp `/` flySpeedDown |
| Light TNT | ignite |
| Lamp color | pickLightColor |
| Stop bouncing | Hold Shift |
| Menu | Esc |

Rules: an unbound binding (`''`) is left out of its row; a row whose bindings are all unbound is left
out. If a code is bound to two actions, `buildKeyToAction` makes the later action win, so the
earlier action's row leaves that code out (the view never shows a key that does nothing).

The rows are data (`src/data/controls.data.ts`). One **Back** button (`.menu-back`) returns to the
pause card.

### 3.6 Quit to Menu

The main menu is reachable only by a reload (startGame runs once per page load). Quit sets
**`quitting = true`** first. While `quitting`:
- both buttons are disabled, the Quit button reads "Saving…";
- Esc does nothing, rules (a)/(b) open nothing;
- the timer freeze and the network freeze do not close the menu (the reload is coming anyway);
- multiplayer: a connection loss does not start the Reconnector (`link.wire`'s loss callback returns
  on `quitting`), so nothing can re-arm `mp:autojoin`.

Then:
- **Solo:** `autosave.flush()` raced against **3 s**, then `location.reload()` (also on rejection).
  Safe: `DualAdapter.saveWorld` writes the local copy synchronously before awaiting the cloud;
  `dirty` stays true during the upload, so `pagehide` rewrites the local copy and flags the upload.
- **Multiplayer:** in this order — clear `mp:autojoin` (belt and braces: it is one-shot and consumed
  at boot, so it is not normally set during play); `leaving?.update(0)` (sends `leaving 0` →
  the friend's "Noah went home" toast, and marks every threshold fired so no countdown can follow);
  `mpSync.flushFrame()`; `autosave.flush()` raced against 3 s; `client.close(1000)`;
  `location.reload()`. `client.close` sets `done`, so the close itself starts no reconnect. `leaving`
  exists in every multiplayer session, timer or not, and `update(0)` sends 0 even if it never started.
- **Play timer:** the reload applies the existing refresh rule (play-time spec §8.1): without a PIN
  or schedule the session is discarded — exactly what F5 or TIME'S UP → MENU does today. Quit adds
  no new way around the limit.
- An accidental multiplayer Quit costs a rejoin through Multiplayer → world (autojoin is cleared).
  Accepted.

No confirmation dialog: the world is saved; a 7-year-old reads "Are you sure?" as a wall.

## 4. Not in scope

- No settings / volume / FOV in the pause menu; no rebinding mid-game.
- No change to the protocol, server, save format or timer rules. No "paused" cue for the friend.
- Options accepting `Escape` as a binding: pre-existing, out of scope (noted for later).

## 5. Structure

### 5.1 Files

- `src/game/pause-model.ts` — pure decisions (unit tested):
  - `PauseState = {locked, pauseOpen, controlsShown, quitting, inventoryOpen, pickerOpen, frozen}`;
  - `shouldOpenOnUnlock(s)` — rule (a);
  - `escapeAction(s, repeat)` → `'open' | 'back' | 'none'` — rule (b) and §3.2.
- `src/ui/controls-model.ts` — `keyText(code)` and `controlRows(bindings)` → `{does, keys}[]` (pure).
- `src/data/controls.data.ts` — the §3.5 rows.
- `src/ui/pause-menu.ts` — `PauseMenu` (DOM): `open(title)`, `close()`, `isOpen`, `controlsShown`,
  `setQuitting()`, callbacks `onResume`, `onQuit`; ids `pause-root`, `pause-resume`,
  `pause-controls`, `pause-quit`, `pause-back`, `pause-title`.
- `src/game/input-gate.ts` — `GateState` gains `pauseOpen`.
- `src/main.ts` — wiring inside `startGame`: the capture Esc listener, a `pointerlockchange` listener
  of its own, the gates of §3.2, Quit.
- `src/ui/ui.css` — `#pause-root` and the Quit spacing.
- README "How to play → Menu": the Esc line describes the pause menu.

### 5.2 Esc ordering (measured at gate 1)

main.ts registers its Escape listener on `window` in the **capture** phase. It runs before every
bubble listener on `window` (the I screen's, the colour picker's — registered earlier, at
main.ts:131), and it still runs when the I screen's search `<input>` has focus and calls
`stopPropagation` (a bubble listener would never see that Esc). It snapshots the state
(`locked` = `document.pointerLockElement === canvas`, read then), decides with `escapeAction`, and
acts; it never stops propagation. Capture is **required**, not a nicety.

### 5.3 Dev oracle

`window.__mc.pause = { isOpen(), controlsShown(), quitting() }` (DEV only).

## 6. Tests

Every check below names the mutant that must turn it red; the plan says how each mutant is applied
and records that it was seen red once.

### 6.1 Unit (vitest)

- `pause-model`: every rule of §3.1–§3.2. Mutants: ignore `inventoryOpen`; ignore `pickerOpen`;
  ignore `frozen`; ignore `locked`; ignore `repeat`; ignore `quitting`; Esc on the card returns
  something other than `'none'`.
- `controlRows` / `keyText`: live bindings shown; `Equal`→`=`; an unbound action is left out; an
  all-unbound row is left out; rebinding changes the row; non-default slot keys listed; a code bound
  twice shows only on the winning action. Mutants: hard-coded defaults; no unbound filter.
- `shouldHandleKey` / `sneakKeyChange` with `pauseOpen`. Mutant: the pre-change `input-gate`.

### 6.2 Browser smoke — `scripts/pause-smoke.ts`

Same harness as `menu-smoke.ts`: its own Vite on a free port (`--strictPort`), dead save API, any
non-localhost request aborts the run, headless. The worktree needs the atlas (`npm run build-atlas`
before the first run; `public/atlas.*` is gitignored).

The pointer path is **real** (M4): click the canvas → locked; page-side `document.exitPointerLock()` →
a real `pointerlockchange`. Start a solo New World **with a duration** (not "No limit"), so
`__mc.playtime` exists.

| # | Check | Mutant that turns it red |
|---|---|---|
| S1 | lock, then unlock → `#pause-root` visible, title "Paused", `loop.paused` | no unlock listener |
| S2 | under the menu: Tab, `3`, F, I, F3 → selected slot, flying, inventory, perf overlay unchanged | each gate removed in turn |
| S3 | hold W, open, Return → `__mc.keys.forward === false` | no `resetKeys` on close |
| S4 | Esc on the pause card → still open | `escapeAction` returns 'resume' on the card |
| S5 | Controls → the jump row shows `Space`, fly row `= / -`; Esc → pause card; open→close→open shows the card | no key display map; no reset in `close()` |
| S6 | Return to Game with `requestPointerLock` stubbed to reject → menu stays open | close on click |
| S7 | Return to Game (real lock) → menu closed, `loop.paused === false` | no close on locked |
| S8 | I, switch to the **Craft tab** (search not focused), Esc → I closed and pause **not** open | bubble-phase listener |
| S9 | C (colour picker), Esc → picker closed, pause not open | bubble-phase listener |
| S10 | unlocked, nothing open, Esc → pause opens (rule b) | no rule (b) |
| S11 | `__mc.playtime.setRemaining(1)` with the menu open → TIME'S UP visible, pause hidden | freeze does not close pause |
| S12 | (new game with a duration) place a block; answer the save API's PUT with a **delayed 200 (1.5 s)**; Quit → button reads "Saving…" and is disabled; the PUT arrives before navigation; the page is on the main menu; Continue → `__mc.world.getBlock` shows the block | Quit = bare `location.reload()` |
| S13 | save PUT never answered → reload happens within 3 s + margin | no timeout race |

### 6.3 Multiplayer — one scenario in `scripts/mp-e2e.ts`

Two clients on its local `mcserver`. A pauses (title "Game Menu"); B places a block; A's world has it
while paused (mutant: pause sets `mpDisconnected`-like freeze). A quits → B shows "… went home"
(mutant: no `leaving`), A's page is on the main menu. The "not rejoining" assertion only catches a
Quit that calls `rejoinReload` — stated, not overclaimed.

### 6.4 Manual (Julien, headed browser, the browser Noah uses)

1. Lock, one real Esc → the menu opens and **stays** open.
2. Esc on the pause card, twice, > 2 s apart → nothing happens.
3. Return to Game within 1 s of the Esc → menu stays; a second click resumes.
4. Alt-tab away and back → the menu is up, the world stood still (solo).
5. Firefox, if Noah uses it: 1–3 again.

## 7. Open for Julien

- Label: **"Quit to Menu"** (matches the existing MENU / Menu buttons) rather than "Save & Quit".

## 8. Gate 1 — what changed from rev 1

Accepted: Esc on the card does nothing (all three technical reviewers measured M3); Return closes only
on lock; `quitting` latch + 3 s flush cap; the MP quit uses `leaving.update(0)` and blocks the
Reconnector; gates for F3, Tab (before `preventDefault`), `openInventory`; z-index 18 so toasts draw
above; `overflow-y: auto`; the key display map; "Stop bouncing: hold Shift" instead of "Sneak"
(Shift only stops pads here — "Sneak" would make Noah expect edge protection); slot keys from
bindings; "Game Menu" title in MP; kid words, "color" spelling; Quit set apart; every smoke check
re-cut so it can go red, each with its named mutant (the Craft-tab / picker Esc checks catch a
bubble listener; the Quit check uses the save API as oracle, since `pagehide` and
`visibilitychange` already write the local copy on reload; the timer check starts with a duration
and runs before Quit); the real headless lock instead of a synthetic event.
Rejected: a 300 ms Esc-after-unlock guard — unneeded once Esc on the card does nothing.

## 9. Gate 2 — what changed

Tab does nothing under the menu (Tab-Tab-Space reached Quit); Back refocuses Return; Quit's gap 28 px;
no `pointerlockerror` listener (a refusal needs none); the dead "no timer" multiplayer branch dropped
(`leaving` always exists in multiplayer). The plan's S12/S13 checks now require a save request after
the Quit click and a timed navigation, since a pre-Quit debounced save could satisfy them; E14 sits
after E13 and rejoins A. Kept: `=` for fly speed (matches the README).
