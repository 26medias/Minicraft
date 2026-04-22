# Liquids

Water and lava are placeable blocks with simple discrete-step flow. This doc describes their data rows, rendering, and the scheduler that moves them each tick.

## Philosophy

The goal is a creative toy for a 7-year-old: pour water to fill a room, place lava for a glow. We explicitly do **not** model:

- Fluid pressure or partial-fill levels (every liquid voxel is "full").
- Swimming physics in the Minecraft sense — the player just uses cursor-directed movement while submerged, same as fly mode.
- Water-on-lava → obsidian / stone conversion.
- Buckets, fluid pickup, or any item-with-state.
- Animated flow textures or scrolling UVs.

The scheduler ticks at 2 Hz (every 0.5 s), not 20 Hz like Minecraft — the discrete stepping is visible and that's fine, it matches the chunky aesthetic.

## Block rows

In `src/data/blocks.data.ts`:

```ts
{ id: 17, name: 'water', label: 'Water', solid: false, transparent: true, kidMode: true,
    hardness: 0, lightLevel: 0, lightFilter: 2, liquid: 'water',
    textures: { kind: 'uniform', all: 'water_still' } }

{ id: 18, name: 'lava', label: 'Lava', solid: false, transparent: true, kidMode: true,
    hardness: 0, lightLevel: 12, lightFilter: 3, liquid: 'lava',
    textures: { kind: 'uniform', all: 'lava_still' } }
```

Key fields:
- `solid: false` — player passes through; blocks are non-colliding.
- `transparent: true` — meshed in the translucent liquid pass.
- `hardness: 0` — left-click deletes instantly (no bucket pickup; liquids can't be "held").
- `lightLevel` — lava emits at 12 (seeded through the block-light BFS); water emits nothing.
- `lightFilter` — controls how much light is attenuated passing through. Water dims at 2/block (~7 blocks visibility underwater); lava attenuates slightly more.
- `liquid: 'water' | 'lava'` — the discriminator used by `isLiquid()` and the scheduler.

Water's source texture is greyish; the atlas builder multiplies it by plains-biome blue (`#3F76E4`) in `TEXTURE_TINTS`. Lava's texture is used unmodified.

## Rendering

The mesher emits two outputs per chunk: `{ opaque, liquid }`.

Liquid face emission rule (in `buildLiquidMesh`):

- Liquid neighbour is `AIR` → emit.
- Liquid neighbour is a **different** liquid AND `here.id < there.id` → emit (water shows its face toward lava; lava doesn't show its face toward water — lower id wins to prevent double-faced boundaries and z-fighting).
- Liquid neighbour is the **same** liquid → skip (internal faces of a pool don't render).
- Liquid neighbour is solid → skip (the solid block's own outward face, emitted by the opaque pass, covers the boundary).

Liquid vertices get the same per-corner light sampling and AO as opaque faces. The renderer mounts each chunk's liquid geometry as a second `THREE.Mesh` with a translucent material:

```ts
new THREE.MeshBasicMaterial({
    map: atlas.texture,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    alphaTest: 0.01,
});
```

`depthWrite: false` lets opaque geometry behind water still render without z-fighting; `DoubleSide` means you can see the water surface from underwater too.

## Flow scheduler

Lives in `src/game/liquid-scheduler.ts`. Instantiated by `GameLoop` and ticked each frame with `dt`.

### Tick accumulator

```ts
accumulator += dt
if (accumulator < 0.5) return
accumulator = 0   // no catch-up; discard overflow
applyFlowStep()
```

A long frame (e.g. `dt = 1.2`) fires **once**, not twice. This avoids compounding stutters and keeps the algorithm cost bounded per frame. The scheduler also resets (not subtracts) the accumulator, so a hitched frame loses partial credit — imperceptible at 60 fps.

### Active frontier

Each `Chunk` owns a `liquidFrontier: Set<number>` of local voxel indices whose liquid might change on the next tick. Maintenance happens in `World.setBlock`: every write examines the written voxel plus its 6 axis-aligned neighbours, and any liquid found there is added to its chunk's frontier (cross-chunk is handled via `worldToChunk`).

On first mount of a chunk, `GameLoop.flushDirtyChunks` seeds the frontier with every liquid voxel in the chunk (a one-time scan). Most of these drop back out immediately at the end of their first tick because they're fully enclosed by same-type liquid on all relevant sides.

**Frontier decay.** At the end of every tick, the scheduler scans each chunk's frontier and removes entries whose 5 neighbours (±x, ±z, -y — we don't spread upward) are all non-air. Fully-enclosed pool interiors drop out of the active set within one tick of being enclosed, so a 10,000-voxel ocean costs O(perimeter) to tick, not O(volume).

### Rule: fall-or-spread-sideways

For every liquid voxel in the snapshot:

```
1. If the voxel directly below is AIR (and not blocked by the "stable stack" guard):
       fall: write AIR at current, liquid at (x, y-1, z)

2. Else, for each of the 4 horizontal neighbours:
       if that neighbour is AIR:
           spread: write liquid at that neighbour
```

Reads are **atomic**: they always return the state as of the start of the tick. Writes are buffered into a pending list and committed after all source voxels are processed. This means iteration order doesn't affect results.

**Stable-stack guard.** The fall rule has one additional check: a liquid block with a same-type liquid directly *above* doesn't fall. Without this guard, the bottom block of a mid-air water column would vacate and leave a gap above it. With the guard, stacked columns are stable in place. The trade-off: deliberately placing two water blocks on top of each other in mid-air results in a stuck 2-block column that never falls. For the kid's use case, this is preferable to telescoping columns.

Waterfalls still work because the source of the waterfall spreads sideways over the cliff edge to a voxel with **no water above** — that new voxel falls normally on the next tick.

### Commit phase

Pending writes are deduplicated with the rule "liquid beats air on the same coord" — if two sources write to the same voxel and one is liquid, liquid wins. Then each write is applied via `world.setBlock`, which in turn triggers `GameLoop.applyLightUpdate` (via the scheduler's `onBlockChanged` callback) so the lightmap stays consistent with every flow step.

## Interaction with other systems

- **Mining:** hardness-0 left-click deletes a liquid block instantly. Neighbour liquids re-enter the frontier and flow in over subsequent ticks.
- **Placement:** right-click places a liquid block from the hotbar. Placed in mid-air, it starts falling next tick. Placed on flat ground, it starts spreading sideways next tick.
- **TNT:** `detonate` clears blocks via `setBlock(AIR)`. Adjacent liquids re-enter the frontier and fill the crater over subsequent ticks.
- **Lighting:** every liquid write invokes `applyLightUpdate`. A flowing waterfall re-floods a small region of the lightmap ~2× per second — cheap.
- **Autosave:** liquids are just blocks in the chunk's `blocks` array; they persist through the existing modified-chunk save path. No new save field.

## Code map

- `src/data/blocks.data.ts` — water + lava rows.
- `src/game/liquid-scheduler.ts` — class, tick, flow rules, commit.
- `src/game/liquid-scheduler.test.ts` — covers accumulator, fall, spread, frontier decay.
- `src/engine/world/chunk.ts` — `liquidFrontier: Set<number>` field.
- `src/engine/world/world.ts` — `markLiquidFrontier` called from `setBlock`; `allChunks()` iterator.
- `src/engine/world/mesher.ts` — `buildLiquidMesh`, emission rule, lower-id-wins boundary.
- `src/engine/world/generation.ts` — sea-level water fill (columns below `SEA_LEVEL` get water from `h+1` to `SEA_LEVEL`).
- `src/engine/render/renderer.ts` — liquid material + mount path.
