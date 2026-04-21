# Fly Mode — Design

Date: 2026-04-21
Branch: `feat-fly-mode` (off `fix-block-face-textures` → eventually `main`)

## Problem

Walking is the only way to traverse a 512×512 world. Hills, ravines, and "where did I put that dirt block?" cost the kid real patience. Give him a fly mode: press **F**, gravity off, whoosh.

## Architecture

Three code touch-points:

### 1. Player state (`src/game/player.ts`)

Add two fields:

- `flying: boolean` — default `false`.
- `flySpeedTier: number` — default `2`. Integer in `[1, 5]`.

Behavior change in `update()`:

- **When `flying` is `false`:** current behavior unchanged — gravity, jump, walk speed.
- **When `flying` is `true`:**
  - Skip gravity entirely (`this.vy` is never decremented by gravity).
  - Horizontal speed = `WALK_SPEED × flySpeedTier` (so tier 1 = 5 bps, tier 5 = 25 bps).
  - Vertical velocity comes from input: `flyUp` key sets `vy = +WALK_SPEED × flySpeedTier`; `flyDown` sets `vy = -WALK_SPEED × flySpeedTier`; neither pressed → `vy = 0`. No acceleration, no momentum — discrete on/off.
  - Collision still runs (`moveWithCollisions`) — no clipping through walls, floors, ceilings.

Two methods:

- `toggleFly()`: flips `flying`. On entering fly mode, sets `vy = 0` (don't carry a fall into fly). On leaving, `vy = 0` (gravity resumes and builds from rest).
- `adjustFlySpeed(delta: number)`: `flySpeedTier = clamp(flySpeedTier + delta, 1, 5)`. No-op when not flying.

### 2. Keybindings (`src/data/keybindings.data.ts`)

Add four new actions to the `Action` union, `ACTIONS` array, `ACTION_LABEL`, and `DEFAULT_KEYBINDINGS`:

| Action | Default key code | Label |
|---|---|---|
| `toggleFly` | `KeyF` | `Toggle Fly` |
| `flyUp` | `Space` | `Fly Up` |
| `flyDown` | `ShiftLeft` | `Fly Down` |
| `flySpeedUp` | `Equal` | `Increase Fly Speed` |
| `flySpeedDown` | `Minus` | `Decrease Fly Speed` |

Notes:

- `flyUp` shares its default key (`Space`) with `jump`. They are separate actions so either can be rebound independently. The player state machine picks the semantics based on `flying`.
- `Equal` is the `=` key; the shift-less form of `+`. Chosen over `NumpadAdd` because not all keyboards have a numpad.
- `toggleFly`, `flySpeedUp`, and `flySpeedDown` are edge-triggered (fire once on keydown), not held. The input layer already distinguishes press vs. held state via the existing keybinding dispatcher — no new machinery needed.

### 3. HUD speed meter (`src/ui/hud.ts`)

New method on `Hud`:

```ts
setFlySpeed(tier: number | null): void
```

- `tier: number` in `[1, 5]` — show the meter with that many pips filled.
- `tier: null` — hide the meter.

DOM: a single `<div id="hud-fly-speed">` containing five `<div class="fly-pip">` children. The wrapper has two CSS classes toggled by the method: `visible` (controls opacity/display) and `tier-N` (applies to the N-th and earlier children via `:nth-child` selectors in CSS, or simpler: the method toggles `.filled` on each pip).

Placement (via CSS in the existing HUD stylesheet): center-horizontal, positioned directly above the hotbar with a small gap. Visible only while flying.

## Data flow

```
keydown event
  → keybindings dispatcher
    → game loop wires action flags into Player
      → Player.update() / Player.toggleFly() / Player.adjustFlySpeed()
        → main.ts sends (player.flying ? player.flySpeedTier : null) to Hud.setFlySpeed()
```

`toggleFly` and `flySpeedUp`/`flySpeedDown` are edge-triggered: the game loop detects a fresh press (not held) and calls the corresponding Player method once. `flyUp` / `flyDown` are level-triggered (held-while-pressed) and feed into the existing `Keys` struct path.

## Persistence

Nothing about fly mode is saved:

- World load always starts with `flying=false`, `flySpeedTier=2`.
- `flying` and `flySpeedTier` persist across F-toggles within a single session (toggling off then back on keeps the tier the user picked).
- No change to the save codec or `PersistenceAdapter` interface.

Rationale: fly state is ephemeral session UI, not world state. Keeps the save blob forward-compatible with existing worlds.

## Edge cases

- **Entering fly mid-air:** allowed. Falling player presses F, `vy=0`, hovers.
- **Exiting fly mid-air:** allowed. Gravity resumes, player falls.
- **Holding `flyUp` and `flyDown` simultaneously:** `vy = 0` (they cancel). Not a real-world scenario but deterministic.
- **Speed adjust while not flying:** no-op (`flySpeedTier` unchanged). Keeps the action usable globally without a mode gate in the input layer.
- **Collision against a ceiling while ascending:** resolved by `moveWithCollisions` like any other upward motion — player stops, `vy` clamped to zero.
- **World edge:** unchanged. Player still cannot move past the 512-block boundary.

## Testing

New file: `src/game/player.test.ts` (first player test — module currently has none).

Cases:

1. Player with `flying=false` accumulates downward `vy` each tick (gravity active).
2. Player with `flying=true` does not accumulate gravity (`vy` remains at whatever input set it to).
3. `toggleFly()` zeroes `vy`.
4. `flying=true`, `keys.flyUp` pressed → `vy > 0`; `keys.flyDown` pressed → `vy < 0`; neither → `vy = 0`.
5. Horizontal walking speed in flight = `WALK_SPEED × flySpeedTier`.
6. `adjustFlySpeed(+1)` and `adjustFlySpeed(-1)` clamp at 5 and 1 respectively.
7. Collision still blocks a flying player from passing through a solid block.

No HUD tests (visual feedback is out of test scope per project convention; `setMiningProgress` has no test either).

## Out of scope

- Persisting fly mode or speed tier in saves.
- Any HUD element other than the speed meter (no "FLY MODE" text banner, no icon).
- Noclip / ghost mode (collision stays enforced).
- Separate sprint-while-flying control (the `+`/`-` speed tiers replace that idea).
- Sound, animation, camera FOV change while flying.
- Rebinding UI changes beyond the four new rows added to the existing options screen.

## Files touched

- `src/game/player.ts` — new fields, two new methods, gravity gate.
- `src/game/player.test.ts` — **new file**, 7 cases above.
- `src/data/keybindings.data.ts` — four new actions + defaults + labels.
- `src/game/loop.ts` (or wherever input flags flow into Player) — wire the new keybindings; call `toggleFly` / `adjustFlySpeed` on edge-triggered events; read `flyUp`/`flyDown` each tick.
- `src/ui/hud.ts` — new `setFlySpeed` method, DOM for the meter.
- `src/ui/ui.css` — pip styles, positioning, `.visible` / `.filled` state classes. (HUD styles are in `ui.css` alongside `#hud-hotbar`, `#hud-crosshair`, `#hud-mining`.)
- `src/main.ts` — forward `player.flying ? player.flySpeedTier : null` to `hud.setFlySpeed()` each tick.

No changes needed to `src/ui/options.ts`: it iterates `for (const action of ACTIONS)` at line 46, so new actions appear automatically in the rebind UI.
