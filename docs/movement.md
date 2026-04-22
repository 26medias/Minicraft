# Movement

The player has three distinct movement modes. This doc describes the state machine and the controls for each.

## Three modes

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  WALK ←──F──→ FLY                                           │
│    ↑           ↑                                            │
│    │           │                                            │
│   eye         eye                                           │
│  leaves      enters                                         │
│  liquid      liquid                                         │
│    │           │                                            │
│    ↓           ↓                                            │
│  (fall back    SWIM                                         │
│   to walk)                                                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Mode = f(this.flying, this.swimming).** Both are booleans on `Player`. `swimming` is recomputed every tick from the eye voxel; `flying` is toggled manually with F.

| flying | swimming | Mode effective |
|--------|----------|-----------------|
| false  | false    | Walk            |
| true   | —        | Fly (fly wins)  |
| false  | true     | Swim            |

Fly wins over swim for velocity semantics, but both produce the same qualitative behaviour: no gravity, cursor-directed 3D motion. The difference is speed: fly uses the current `flySpeedTier`, swim is a flat 0.6× walk speed.

## Walk

Default state. Gravity on, feet on ground, horizontal movement in the camera's horizontal-projected forward/right.

- **WASD** — horizontal motion. `forward` and `right` are 3D vectors from the camera, but the walk branch reads only `.x` and `.z` from them, dropping Y. Diagonal strafe is normalised (`Math.hypot(ix, iz)`) so W+A moves at walk speed, not √2× walk speed.
- **Space** — jump. Fires when one of:
  - `this.grounded` is true (standing on a solid block).
  - `feetInLiquid` is true (feet in water or lava, head above — wading, or just breached the surface). This is what lets the kid climb out of a shallow pool onto shore.
- Both jump paths set `this.vy = JUMP_SPEED`.

Walk speed: `WALK_SPEED = 5` blocks/sec.

## Fly

Toggled with F. Gravity off. Motion is fully cursor-directed: W/S use the full 3D look vector (pitch contributes to Y), A/D use the camera's horizontal right (strafe doesn't introduce vertical motion). Space and Shift have no effect.

- **W / S** — move forward or back in the direction the camera is pointing. Pitch down + W descends; pitch up + W ascends. No minimum horizontal speed — looking straight down and pressing W moves straight down.
- **A / D** — strafe left or right, horizontal only regardless of pitch. This keeps circling around a target predictable.
- **=** / **-** — increase or decrease `flySpeedTier` in `[1, 5]`. 5 pips above the hotbar indicate the current tier. Actual speed is `WALK_SPEED * flySpeedTier`.

Collision detection still runs in fly mode — the kid can't clip through walls.

## Swim

Activates automatically when `isLiquid(eyeVoxel)` is true — the instant the player's head enters water or lava. Deactivates as soon as the eye exits. The transition has no animation, no lerp.

Same controls as fly:
- **W / S** — 3D cursor-directed forward/back.
- **A / D** — horizontal strafe.
- **Space / Shift** — no effect. (Space is redundant while fully submerged; the kid exits by looking up and pressing W.)

Speed: `WALK_SPEED * 0.6` — slower than walking, noticeably sluggish, sells the "I'm in water" feel.

## The "jump out of the pool" case

A common scenario: kid is in a 1-block-deep pool, wants to climb onto the block edge above. Swim mode disables Space, but swim's cursor-directed Y movement is 3 blocks/sec (WALK_SPEED × 0.6), which is enough to rise one block by looking up.

The harder case is breaching the surface onto shore: the eye exits water, swim flips off, gravity resumes, and the player falls back down before forward momentum can carry them onto dry land. The fix is in the walk branch: Space also jumps when `feetInLiquid`. So at the moment of breaching:

- Eye exits water → `swimming = false`.
- Feet still in water → `feetInLiquid = true`.
- Space pressed → jump impulse applied (same as grounded jump).
- Player's Y velocity pushes them up above the water surface; horizontal WASD carries them onto shore.

Without this, the kid would have to swim diagonally up+forward while exactly threading the needle between "looking too up and losing forward speed" and "looking too forward and not clearing the block". Space-while-wading cuts through the awkwardness.

## Physics + sub-stepping

All three modes run through the same collision-resolving physics (`moveWithCollisions` in `src/engine/physics/collision.ts`), which sub-steps the displacement so fast motion doesn't tunnel through thin walls:

```ts
const disp = max(|vx|, |vyStep|, |vz|)
const steps = ceil(disp / MAX_STEP)   // MAX_STEP = 0.4 blocks
```

At fly speed tier 5 (`WALK_SPEED * 5 = 25 blocks/sec`) over `dt = 0.016`, that's 0.4 blocks per frame, sub-stepped into ~1 step. At very low frame rates the sub-stepping prevents clipping through walls.

## Keybindings

Defaults in `src/data/keybindings.data.ts`:

| Action        | Default    | Label         |
|---------------|------------|---------------|
| `forward`     | `KeyW`     | Move Forward  |
| `back`        | `KeyS`     | Move Back     |
| `left`        | `KeyA`     | Strafe Left   |
| `right`       | `KeyD`     | Strafe Right  |
| `jump`        | `Space`    | Jump          |
| `toggleFly`   | `KeyF`     | Toggle Fly    |
| `flySpeedUp`  | `Equal`    | Fly Faster    |
| `flySpeedDown`| `Minus`    | Fly Slower    |

There is **no** `flyUp` / `flyDown` action — removed when cursor-directed motion replaced Space/Shift vertical control. Saved options from before that change are filtered at load time: unknown actions are silently dropped so stale mappings can't shadow current actions (e.g., a stale `flyUp: 'Space'` can't shadow `jump: 'Space'`).

## Code map

- `src/game/player.ts` — `Player` class, `update()` with the walk/fly/swim branches, state detection (`swimming`, `feetInLiquid`).
- `src/game/player.test.ts` — coverage for gravity, fly speed tiers, swim activation, cursor direction, jumping on ground and from liquid.
- `src/data/keybindings.data.ts` — action catalog.
- `src/persistence/options.ts` — loads options, strips unknown keybinding actions.
- `src/main.ts` — key dispatcher, building `keyToAction` map from the filtered options.
- `src/engine/physics/collision.ts` — swept-AABB collision used by all three modes.
