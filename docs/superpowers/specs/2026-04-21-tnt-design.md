# TNT — Design

Date: 2026-04-21
Branch: `feat-tnt` (off `fix-block-face-textures` → eventually `main`)

## Problem

The 7-year-old wants TNT. Give him a block he can place, prime, and watch explode — with chain reactions propagating through a line of TNT for the classic satisfying "boom-boom-boom" cascade. No damage, no sound, no redstone triggers.

## Architecture

Three independent pieces plus a new keybinding:

1. **Block catalog**: add one row for `tnt`. The inert and primed states reuse the same block ID — the primed state is tracked in a separate runtime registry, not in the chunk's block data.
2. **Ticking registry** on `GameLoop`: a map of primed TNT coords with fuse seconds remaining.
3. **Overlay renderer**: a small class that adds a pulsing red transparent box over each primed TNT so the kid sees which blocks are armed.

Block storage remains a flat `Uint8Array` per chunk. No per-voxel metadata.

### Why registry instead of two block IDs

- Avoids a texture-variant problem: the primed "glow" is additive, which our multiply-only build-time tint can't produce. An overlay mesh does the glow cleanly without touching the atlas pipeline.
- Keeps chunk data compact: no extra blocks in the catalog, no mesher changes.
- Save codec unchanged: primed TNT persists as plain `tnt`. On reload all TNT is inert — simpler mental model for a kid who won't understand "why did my castle explode?"

## Components

### New block (`src/data/blocks.data.ts`)

One row:

```ts
{ id: 15, name: 'tnt', label: 'TNT', solid: true, transparent: false, kidMode: true, hardness: 0.5,
    textures: { kind: 'top-bottom-side', top: 'tnt_top', bottom: 'tnt_bottom', side: 'tnt_side' } },
```

`hardness: 0.5s` — mineable, so the kid can undo a misplaced TNT block.

### New action (`src/data/keybindings.data.ts`)

One new rebindable action:

| Action | Default | Label |
|---|---|---|
| `ignite` | `KeyE` | `Ignite TNT` |

Edge-triggered with `!e.repeat` guard in `main.ts`, matching the pattern used for `toggleFly` / `flySpeedUp` / `flySpeedDown`.

### Ignite action (`src/game/actions.ts`)

New exported function:

```ts
export function igniteTnt(
    world: World,
    hit: VoxelHit,
    registry: Map<string, { x: number; y: number; z: number; fuse: number }>,
    fuse: number,
): boolean
```

Behavior:

- If `world.getBlock(hit.x, hit.y, hit.z)` is not `tnt` → return `false`.
- If the coord is already in `registry` → return `false` (don't reset fuse).
- Otherwise insert `{x, y, z, fuse}` into registry and return `true`.

### Ticking registry and detonation (`src/game/loop.ts`)

New field on `GameLoop`:

```ts
private primedTnt: Map<string, { x: number; y: number; z: number; fuse: number }> = new Map();
```

New method, called each tick after mining and particles, before chunk flush:

```ts
private updatePrimedTnt(dt: number): void
```

Behavior (pseudocode):

```
for each entry in primedTnt:
    entry.fuse -= dt
    if entry.fuse <= 0:
        detonate(entry.x, entry.y, entry.z)
        remove entry from primedTnt
        overlay.remove(entry.x, entry.y, entry.z)
```

Detonation helper:

```
const RADIUS = 3
const RADIUS_SQ = 9
const CHAIN_FUSE = 0.1

detonate(ox, oy, oz):
    # Remove the exploding TNT itself
    world.setBlock(ox, oy, oz, AIR)
    markChunkDirtyAround(ox, oz)

    for dx in -RADIUS..RADIUS:
        for dy in -RADIUS..RADIUS:
            for dz in -RADIUS..RADIUS:
                if dx*dx + dy*dy + dz*dz > RADIUS_SQ: continue
                wx, wy, wz = ox+dx, oy+dy, oz+dz
                if wy < 0 or wy >= CHUNK_SIZE_Y: continue
                if not world.inBounds(wx, wz): continue

                id = world.getBlock(wx, wy, wz)
                if id === TNT_ID:
                    # Prime without destroying — it'll explode on its own fuse.
                    if not primedTnt.has(key(wx, wy, wz)):
                        primedTnt.set(key, {x: wx, y: wy, z: wz, fuse: CHAIN_FUSE})
                        overlay.add(wx, wy, wz)
                elif isSolid(id):
                    world.setBlock(wx, wy, wz, AIR)
                    markChunkDirtyAround(wx, wz)

    particles.spawnBreak(ox + 0.5, oy + 0.5, oz + 0.5, TNT_ID)
```

Ordering detail: chain-primed TNT is NOT destroyed by the explosion — it's left in place and added to the registry with a short fuse (0.1s). When its own timer expires, its `detonate()` runs and the cascade continues.

### Primed overlay (`src/engine/render/primed-overlay.ts`, new file)

A small class that manages pulsing red transparent cubes attached to the scene:

```ts
export class PrimedOverlay {
    constructor(scene: THREE.Scene) { ... }
    add(x: number, y: number, z: number): void
    remove(x: number, y: number, z: number): void
    tick(dt: number): void  // advances the pulse animation
}
```

Implementation:

- Each overlay is a single `THREE.Mesh` using a red `MeshBasicMaterial` with `transparent: true`, `depthWrite: false`, and scaled to ~1.05 voxels (slightly larger than the TNT cube so it's visible on every face).
- `tick()` updates the material's opacity with `0.2 + 0.3 * (0.5 + 0.5 * sin(totalTime * 6))`.
- All overlays share a single material so the pulse is synchronized — easier on the eye than independent per-block phases.
- Storage: `Map<string, THREE.Mesh>` keyed by `"x,y,z"`.

### Ignite wiring (`src/main.ts`)

Add `case 'ignite':` in the `onKey` dispatcher, edge-triggered with `!e.repeat`:

```ts
case 'ignite':
    if (down && !e.repeat) {
        const eye = player.eyePosition();
        const dir = cam.getLookDir();
        const hit = raycastVoxel(world, eye, [dir.x, dir.y, dir.z], REACH);
        if (hit) loop.ignite(hit);
    }
    break;
```

`GameLoop.ignite(hit: VoxelHit)` is a new public method that calls `igniteTnt()` (from actions.ts) against its own `primedTnt` map, and if successful, adds the block to the overlay.

### Game loop wiring

In `GameLoop.tick()`, add one line after particles and before `loadNearbyChunks`:

```ts
this.updatePrimedTnt(dt);
this.overlay.tick(dt);
```

`this.overlay` is a new `PrimedOverlay` field initialized in the constructor, taking `renderer.scene` as its target.

## Data flow

```
E keydown
    → main.ts onKey dispatcher
        → loop.ignite(hit)
            → igniteTnt(world, hit, primedTnt, 2.5)
            → overlay.add(hit.x, hit.y, hit.z)

Tick:
    → loop.updatePrimedTnt(dt)
        → for each primed entry: fuse -= dt
            → if fuse <= 0: detonate(x, y, z)
                → world.setBlock(..., AIR) for radius
                → primedTnt.set(...) for chain-primed TNT in radius
                → overlay.add(...) for chain-primed TNT
                → overlay.remove(x, y, z) for the detonator
                → particles.spawnBreak(x, y, z, TNT_ID)
```

## Persistence

**Primed state is not saved.** On save, primed TNT persists as plain `tnt`. On load, the registry initializes empty and all TNT is inert until the kid re-primes.

No changes to `PersistenceAdapter`, `codec.ts`, or `autosave.ts`.

## Edge cases

- **Exploding at world edge:** loop skips any `(wx, wz)` that falls outside `world.inBounds()` and any `wy` outside `[0, CHUNK_SIZE_Y)`. No out-of-bounds writes. World boundary is an invisible wall for explosions too.
- **Two TNTs exploding the same block:** the `if not primedTnt.has(key)` guard prevents double-priming. The later detonation's `setBlock(..., AIR)` on an already-air block is a no-op.
- **Primed TNT mined by the kid:** mining a primed TNT cancels the fuse. In `GameLoop.updateMining()`, when a block break completes, after `world.setBlock(..., AIR)` the loop checks `primedTnt.delete(key)` and `overlay.remove(x, y, z)` if the coord was primed. Kid-intuitive: "oh no, I made a mistake" → mine the TNT back before it blows. TNT's 0.5s hardness leaves a narrow-but-possible undo window before the 2.5s fuse expires.
- **Igniting from max reach on a wall-attached TNT:** raycast already handles this; `hit` is the block directly in the crosshair. No change.
- **Placing TNT inside the player AABB:** `placeBlock()` already rejects self-intersecting placements. Unchanged.
- **Chain reaction runaway:** bounded by world size. A fully TNT-filled world would cascade but completes in finite time (each TNT detonates once).
- **Primed TNT in an unloaded chunk:** unreachable in practice — view radius is 4 chunks and fuse is 2.5s; the player can't outrun their own ignition fast enough to leave the chunk. But even if they did, `setBlock` on unloaded chunks is supported (it lazily ensures the chunk).

## Testing

New file: `src/game/tnt.test.ts` covering the action + registry + detonation behaviors (no overlay, no rendering):

1. `igniteTnt` on a TNT block adds to the registry and returns `true`.
2. `igniteTnt` on a non-TNT block is a no-op and returns `false`.
3. `igniteTnt` on an already-primed TNT is a no-op and returns `false` (no fuse reset).
4. A fuse ticking to zero calls detonate — block becomes AIR.
5. Detonation destroys solid blocks within radius 3.
6. Detonation respects radius exactly (block at radius 4 survives).
7. Detonation skips blocks outside world bounds (no throw).
8. A chain-primed TNT is added to the registry with fuse 0.1s, not destroyed.
9. A chain reaction through a line of TNT propagates end-to-end (test: 6 TNT in a row, prime the first, after N ticks all are gone).

Tests exercise a pure `detonate(world, primedTnt, ox, oy, oz)` function exported from `src/game/tnt.ts`. `GameLoop` calls this function and is responsible for chunk-dirty bookkeeping and overlay updates around it. This keeps the detonation math unit-testable without a full `GameLoop` fixture.

HUD/rendering (overlay pulse) is not unit-tested — consistent with the `Hud` / `ParticleSystem` precedent of no visual tests.

## Files touched

- `src/data/blocks.data.ts` — add TNT row (1 line).
- `src/data/keybindings.data.ts` — add `ignite` action + defaults + label.
- `src/game/actions.ts` — add `igniteTnt()`.
- `src/game/tnt.ts` — **new file**, pure `detonate()` function + shared constants (`TNT_RADIUS`, `TNT_CHAIN_FUSE`, `TNT_PRIME_FUSE`).
- `src/game/tnt.test.ts` — **new file**, 9 cases above.
- `src/game/loop.ts` — add `primedTnt` map, `overlay` field, `ignite()` method, `updatePrimedTnt(dt)` helper, wire into `tick()`.
- `src/engine/render/primed-overlay.ts` — **new file**, overlay manager class.
- `src/main.ts` — route `ignite` action in `onKey`.
- `src/ui/options.ts` — no change (iterates `ACTIONS`).

## Out of scope

- Sound on ignition or explosion (Phase 1 non-goal).
- Flint-and-steel item.
- TNT triggered by pressure plate / redstone / other indirect sources.
- Falling TNT when its support is removed (real Minecraft behavior; skipped).
- Player damage or knockback from explosions.
- Saving primed fuse state across reloads.
- Any block being immune to TNT (no bedrock tier in Phase 1).
- Multiple particle bursts per detonation; one puff at origin is enough.
