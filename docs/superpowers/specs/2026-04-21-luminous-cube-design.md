# Luminous Cube — Design

Date: 2026-04-21
Branch: `feat-luminous-cube` (off `main`)

## Problem

The kid wants to make his cave bright. Torches need non-cube geometry, attached-to-wall placement, and a lighting system to be useful — all at once, none of it cheap. A "lamp" block sidesteps the first two: it's a normal cube that emits a coloured `PointLight`. Same lighting benefit, one-tenth the engineering.

## Architecture

Three independent pieces plus a new keybinding and a small save-format addition:

1. **Block catalog.** One new row `lamp` (id 16) that renders like any other cube using the existing `glowstone` texture.
2. **`LightRegistry` class.** Same pattern as `PrimedOverlay`: owns a `Map<coord, THREE.PointLight>` attached to the scene, with `add` / `remove` / `setColor` methods. Wired to block placement/removal in `GameLoop`.
3. **Color picker HUD.** HTML overlay with a 5×4 preset palette of 20 pastel colors. Press `C` to open, click a tile to pick, `ESC` to cancel.

## Components

### Block (`src/data/blocks.data.ts`)

```ts
{ id: 16, name: 'lamp', label: 'Lamp', solid: true, transparent: false, kidMode: true, hardness: 0.3,
    textures: { kind: 'uniform', all: 'glowstone' } },
```

Hardness 0.3s (mineable like dirt). Kid-mode enabled. Block appearance never changes regardless of emitted color — the texture is the unlit glowstone pattern, the light does the talking.

### `LightRegistry` (`src/engine/render/light-registry.ts`, new file)

```ts
export class LightRegistry {
    constructor(scene: THREE.Scene);
    add(x: number, y: number, z: number, colorHex: string): void;
    remove(x: number, y: number, z: number): void;
    setColor(x: number, y: number, z: number, colorHex: string): void;
    getColor(x: number, y: number, z: number): string | null;
    entries(): Iterable<{ x: number; y: number; z: number; color: string }>;
}
```

Each add creates a `THREE.PointLight` at block-center (`x + 0.5, y + 0.5, z + 0.5`), parameters:
- `color` parsed from hex string.
- `intensity = 1.5`.
- `distance = 12` blocks.
- `decay = 1.5` (a shade below physical inverse-square; gameplay-friendly falloff).

`setColor` mutates the existing light's color in place (no re-add). `remove` detaches from scene. Storage keyed by `"x,y,z"` for O(1) lookup — each of `light-registry.ts` and `tnt.ts` declares its own local `key(x, y, z)` helper to avoid cross-module coupling over a one-line utility. (Do not rename or share `tntKey` — the cost of a cross-cutting refactor outweighs the benefit.)

### Color picker HUD (`src/ui/color-picker.ts`, new file)

New class `ColorPicker`:

```ts
export class ColorPicker {
    constructor(root: HTMLElement, palette: string[]);
    onPick: (color: string) => void;
    show(): void;
    hide(): void;
    readonly isOpen: boolean;
}
```

DOM: a modal overlay covering the viewport with a dim backdrop and a centered card containing a 5×4 CSS grid of color swatches. Each swatch is a small square button (~48px) with its tile color as background. Click → `onPick(color)` fires → `hide()`. `ESC` key on window → `hide()` without firing. Click on the backdrop (outside the card) → also cancels.

CSS added to `src/ui/ui.css`. Card styling mirrors the existing `.menu-card` visual language.

### Palette (20 pastel colors, 5×4 grid)

```
Row 1 (warm whites / yellows):
#FFFFFF  #FFF5E0  #FFE8A8  #FFD985  #FFC870

Row 2 (peach / coral):
#FFB594  #FFA585  #FF9580  #FF8A99  #FF99B5

Row 3 (pinks / purples):
#FFB0D0  #FCB8E0  #E8B5F0  #CFA8F0  #B0A5F0

Row 4 (blues / greens):
#A5B8F0  #9FD0F0  #A8E5E0  #A5E5C0  #B5E59B
```

Stored as a constant in `src/data/light-palette.data.ts` so future tweaks are a single-line data edit. Default `currentLightColor = '#FFF5E0'` (warm white — second tile, natural incandescent feel).

### Keybinding (`src/data/keybindings.data.ts`)

| Action | Default | Label |
|---|---|---|
| `pickLightColor` | `KeyC` | `Pick Light Color` |

Edge-triggered with `!e.repeat` guard.

### Light lifecycle wiring

Each place-or-remove-a-block call site gets a small addition. No new `applyBlockChange` helper — the three call sites are narrow and adding one-liners is cleaner than a refactor.

- **Right-click placement** (in `main.ts`, after `placeBlock(...)` returns `true`): if the placed id is `lamp`, call `lights.add(tx, ty, tz, currentLightColor)`. `tx/ty/tz` come from the existing hit+face math.
- **Mining completion** (in `GameLoop.updateMining`, after the primed-TNT cancel check and before `world.setBlock(AIR)`): if the block being broken is `lamp`, call `lights.remove(target.x, target.y, target.z)` (symmetric with how we clean up primed-TNT state there).
- **TNT detonation** (in `GameLoop.detonateAt`, inside the `destroyed` loop): before the `world.setBlock(..., AIR)` call, check if the old block was `lamp` via `world.getBlock(x, y, z)`; if so, `lights.remove(x, y, z)`. Alternative if cheaper: pre-read the old ids before the loop and remove lights up front.

`GameLoop` gains a constructor arg `lights: LightRegistry | null = null` (same pattern as `particles` and `overlay`). `main.ts` instantiates once and passes it in.

Ignite path is untouched — lamps aren't TNT, they don't prime.

### Main dispatcher (`src/main.ts`)

New `case 'pickLightColor':` in `onKey`:
- Edge-trigger on `down && !e.repeat`.
- Raycast: if the hit block is a lamp, remember that target.
- Open the color picker.
- Picker's `onPick` callback:
  - If target was remembered: `lights.setColor(target.x, target.y, target.z, pickedColor)`, then update `currentLightColor = pickedColor`, then save the world (so the color persists).
  - Else: only update `currentLightColor` and save options.

Picker opens as a modal overlay — pointer lock released on show, re-acquired on close when the kid clicks the canvas.

## Data flow

```
C keydown
  → main.ts onKey dispatcher
    → raycast → optional targetLampCoord
    → picker.show()  (pointer lock released)

Tile click
  → picker.onPick(colorHex)
    → if targetLampCoord: lights.setColor(...); autosave.markDirty()
    → currentLightColor = colorHex
    → saveOptions({ ..., currentLightColor })
    → picker.hide()

Block placement (lamp):
  → placeBlock(...) → setBlock(lamp)
    → applyBlockChange() adds to lights registry
    → autosave.markDirty()

Block removal (lamp):
  → mining-complete or TNT-destroy → setBlock(AIR)
    → applyBlockChange() removes from lights registry
    → autosave.markDirty()
```

## Persistence

### Options (small change)

Extend `Options` in `src/data/keybindings.data.ts`:

```ts
export type Options = {
    kidMode: boolean;
    keybindings: Record<Action, string>;
    currentLightColor: string;
};
```

`loadOptions` default: `currentLightColor: '#FFF5E0'`. Old saved options without this field fall back to the default (same shape as the existing kidMode / keybindings handling).

### World save (additive field)

Extend `WorldSave` in `src/persistence/adapter.ts`:

```ts
export type LightSave = { x: number; y: number; z: number; color: string };

export type WorldSave = {
    version: 1;
    // ... existing fields
    lights?: LightSave[];
};
```

`LocalStorageAdapter.saveWorld` builds an explicit `metaPayload` object (see `src/persistence/localStorage.ts:33-40`) — add `lights: save.lights` to it. Load path already does `{ ...meta, chunks }` so it forwards `lights` automatically when present. Older saves without the field parse to `undefined` → the game initializes an empty registry.

On save: gather `[...lights.entries()]` into the array. On load: iterate and replay `lights.add(x, y, z, color)` per entry before any chunks are rendered so the scene is correctly lit on first frame.

### Autosave integration

`AutoSave` constructor takes a supplier function for player state (see `src/persistence/autosave.ts`). Add a second supplier for lights: `() => LightSave[]`. On save, the autosave blob calls it and fills `save.lights`. Wiring lives in `main.ts` where both suppliers are constructed.

## Edge cases

- **Place a lamp, mine it, place again at same coord.** The `remove` → `add` sequence produces a fresh `PointLight`. Correct.
- **Place two lamps next to each other.** Two `PointLight`s overlap; Three.js adds them naturally. Correct.
- **TNT destroys a lamp mid-cascade.** `applyBlockChange` fires on each destroyed block, cleaning up lights as the explosion advances. No orphans.
- **Lamp is `kidMode: true` but the texture is a yellow-ish cube.** Looks distinct from glowstone-as-world-gen-block — we don't generate glowstone in world-gen today, so no confusion. (If glowstone is ever added as a naturally-occurring block, it gets a different name; both can share the `glowstone` texture.)
- **Picker open while game is "paused"**: no timers freeze, but the game is also not receiving pointer-lock mouse input. Player stays mid-air if they were flying — fine, matches the existing Options menu behavior.
- **ESC during picker**: closes picker, returns to game (canvas focus). No color change.
- **Click a lamp, press C, pick color, break the lamp.** Edge case: picker remembered the target, lamp no longer exists by the time picker closes. `lights.setColor` no-ops on missing coord. Fine.
- **WebGL dynamic-light recompile stutter at high lamp counts.** No hard cap in the initial release. If the kid reports lag at 30+ lamps, we add a soft cap (N nearest to player). Unlikely for Phase 1.

## Testing

New file: `src/engine/render/light-registry.test.ts` — 5 cases:

1. `add` creates a `PointLight`, registry reports it via `entries()`.
2. `remove` detaches the light, `entries()` no longer includes it.
3. `add` on an already-added coord is idempotent (doesn't double-light).
4. `setColor` updates the light's color without creating/destroying.
5. `getColor` returns `null` for a coord not in the registry.

No DOM tests for the color picker UI (visual, per project precedent). No integration test of "place lamp → light appears in scene" (requires full GameLoop fixture — covered by visual verification in the final task).

## Files touched

- `src/data/blocks.data.ts` — add `lamp` row.
- `src/data/blocks.data.test.ts` — no change; existing generic tests (unique IDs, indexed-by-name, kid-mode filter) cover the new row automatically.
- `src/data/keybindings.data.ts` — add `pickLightColor` action + label + default; extend `Options` type with `currentLightColor`.
- `src/data/light-palette.data.ts` — **new file**, exports the 20-color palette constant.
- `src/persistence/adapter.ts` — extend `WorldSave` with optional `lights: LightSave[]`.
- `src/persistence/localStorage.ts` — add `lights: save.lights` to the `metaPayload` object in `saveWorld`. Load path needs no change.
- `src/persistence/options.ts` — default `currentLightColor`, merge on load, persist on save.
- `src/persistence/autosave.ts` — extend the supplier to include lights.
- `src/engine/render/light-registry.ts` — **new file**, the registry class.
- `src/engine/render/light-registry.test.ts` — **new file**, 5 cases above.
- `src/ui/color-picker.ts` — **new file**, the picker HUD class.
- `src/ui/ui.css` — picker CSS.
- `src/game/loop.ts` — add `LightRegistry | null` constructor arg; call `lights.remove(...)` in `updateMining` completion (lamp-break) and in `detonateAt` destroyed loop (TNT destroys lamp).
- `src/game/actions.ts` — no change. Light-add on placement happens in `main.ts` right after `placeBlock` returns `true`.
- `src/main.ts` — instantiate `LightRegistry` and `ColorPicker`; wire the new `pickLightColor` case; pass registry to the `GameLoop`; on world load, replay saved lights.

## Out of scope

- Torches (fully superseded).
- Block-texture tinting to visually match emitted color.
- Flicker / pulse / animated light effects.
- Smooth color transitions when `setColor` changes a lamp.
- Full RGB picker.
- A "turn this light off" toggle (kid breaks and re-places if they want it gone).
- Lamps affecting ambient scene color / tone mapping.
- Drops on mining (Phase 1 doesn't have an inventory-with-items concept).
- Creative-like "pick block" that copies a lamp's color to `currentLightColor` without opening the picker.
