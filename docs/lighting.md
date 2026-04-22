# Lighting

How illumination works in Minicraft. This doc describes the per-voxel light propagation system that replaced an earlier directional-sun shadow-map implementation.

## Why voxel lighting

Sun shadow mapping leaks. On axis-aligned voxel geometry — cubes meeting at right angles, large underground pockets, thin floors over caves — a single directional shadow map produces residual bleed at floor-wall seams no matter how `bias`, `normalBias`, or filter kernel are tuned. The artifacts are inherent to rasterising shadows from one camera frustum onto concave geometry with sharp corners. Minecraft, Minetest, and Vintage Story all solve this with data-side light propagation rather than screen-space shadows. We do the same.

## Data shape

Each `Chunk` carries a `lights: Uint16Array` alongside its `blocks: Uint8Array`. Both are 16×64×16 = 16,384 entries, indexed by the same `indexOf(x, y, z)` helper in `src/engine/world/coords.ts`.

Each 16-bit voxel entry packs **four 4-bit channels**:

```
bits 15..12   11..8    7..4     3..0
skyLight      blockR   blockG   blockB
```

All four channels are in the range `0..15`. Accessors live on `Chunk`:

```ts
chunk.getSky(x, y, z): number            // 0..15
chunk.setSky(x, y, z, v)
chunk.getBlockR/G/B(x, y, z): number
chunk.setBlockRGB(x, y, z, r, g, b)
```

Memory: 32 KB per chunk. At typical loaded-chunk radius (~80 chunks) the lightmap totals ~2.5 MB — negligible.

**Lights are never saved.** They are derived state, recomputed from `blocks` on load. This keeps the save format simple and guarantees lighting is always consistent with the current block state.

## Block data driving the algorithm

Each row in `src/data/blocks.data.ts` carries two new fields:

- `lightLevel: number` (0-15) — how much light the block emits. `0` for everything except `lamp` (15) and `lava` (12).
- `lightFilter: number` (0-15) — how much light is attenuated when passing through. `0` for air and glass, `2` for water, `3` for lava, `15` for opaque solids (and lamps, which are opaque to transmitted light but emit their own).

## The algorithm

### Initial fill on chunk generation

`fillChunkLights(world, chunk, getLampColor?)` — defined in `src/engine/world/lighting.ts`. Two BFS passes:

**1. Skylight seeding + propagation.** For each `(x, z)` column, walk `y` from 63 down and set `skyLight = 15` at every voxel until the first block with `lightFilter >= 15` (opaque ceiling). Enqueue each seeded voxel. Then BFS outward in all 6 directions. The propagation rule is:

```
propagated = here - max(1, neighborFilter)
```

with one special case: **downward propagation through a zero-filter voxel from a full-strength source preserves the value (no decrement)**. This is what makes sunlight stream down an open mineshaft unattenuated. Every other direction, including horizontal under an overhang, attenuates by at least 1 per block. Water (filter 2) attenuates by 2. Opaque blocks (filter 15) block propagation entirely.

**2. Block-light seeding + propagation.** For each voxel with `lightLevel > 0`, compute three per-channel seed values:

```
seedR = round(colorR * lightLevel)     // colorR in [0, 1], from the emitter's hex
seedG = round(colorG * lightLevel)
seedB = round(colorB * lightLevel)
```

Lamps resolve their colour through an injected lookup (`getLampColor(x, y, z)`); at runtime this reads from the `LightRegistry`. Lava uses a fixed constant `LAVA_LIGHT_COLOR = '#FF8A3D'`. Each channel is flood-filled independently using the same attenuation rule as skylight (minus the downward special case). Overlapping light from two sources combines via **per-channel `max`**, not sum — two lamps of the same colour don't stack brighter than one; two lamps of different colours blend naturally.

### Incremental update on block change

`updateLightsForBlockChange(world, x, y, z, getLampColor?)` is called after every `world.setBlock` from the mine, place, TNT, and liquid-flow paths. Running the full-chunk flood-fill per edit would be wasteful; the incremental algorithm touches only the voxels whose values actually change.

Four per-field passes (sky, R, G, B). Each pass:

1. **Snapshot** the old light value at `(x, y, z)` for this channel.
2. **Removal BFS** from the origin with the old value. For each neighbour:
    - If `neighborValue > 0 && neighborValue < value`, zero it and continue removing outward.
    - If `neighborValue >= value`, it's a **frontier source** — enqueue it for the addition BFS.
3. **Addition BFS** from every frontier source. Re-floods light into the cleared region.

After the per-field passes, two fix-ups:

- **`reSeedSkylightColumn`** walks the `(x, z)` column top-down and re-seeds skylight at any previously-shaded voxel that now has an unobstructed sky path. Handles the "block mined, column now opens to sky" case.
- **`refloodFromNeighbors`** enqueues all 6 neighbours' existing light into the BFS when the new block is passable (`lightFilter < 15`). This covers the "mined an opaque wall" case: the stone block's stored lights were 0, so removal is a no-op, but the newly-transparent gap should let neighbour light flow through.

Finally, if the newly-placed block has `lightLevel > 0` (lamp, lava), seed its emission fresh.

The function returns `Set<Chunk>` — every chunk whose lightmap was touched. The game loop uses that set to flag chunks for re-mesh.

Typical mine/place touches tens to hundreds of voxels. Well under a millisecond on hot paths.

## Mesher integration

`src/engine/world/mesher.ts` produces `{ opaque, liquid }`, each a `ChunkMesh` containing a `colors: Float32Array` attribute (3 floats per vertex).

**Per-vertex sampling.** At each face corner, the mesher averages the 4 voxels that touch that corner on the outward side of the face. Cross-chunk boundaries are resolved through the `neighbors` argument. Diagonal chunk corners (where both X and Z are out of bounds simultaneously) fall through to 0 — we don't resolve across two chunk boundaries at once.

**Colour computation.**

```
SKY_COLOR = (0.9, 0.95, 1.0)       // slightly cool-tinted sun
MIN_AMBIENT = 0.08                 // prevents pitch-black voxels

skyScale = averagedSkyLight / 15
blockR/G/B = averagedBlockChannel / 15

vertexRGB = SKY_COLOR * skyScale + (blockR, blockG, blockB) + MIN_AMBIENT
vertexRGB = clamp(vertexRGB, 0, 1) * aoFactor
```

**Ambient occlusion.** At each corner, the mesher inspects the same 4 outward-side voxels. If two of them (the "edge-adjacent" voxels) are opaque (`lightFilter >= 15` AND `liquid === 'none'`), the vertex's AO factor is `0.75`. If the remaining "diagonal" voxel is also opaque, `0.6`. Otherwise `1.0`. Classic Minecraft corner-inset look.

## Renderer integration

`MeshBasicMaterial({ map, vertexColors: true })` for both the opaque and liquid passes. No `DirectionalLight`, no `AmbientLight`, no shadow map. All illumination comes from the per-vertex `color` attribute that the mesher writes. The liquid material adds `transparent: true, depthWrite: false, side: DoubleSide` so water surfaces alpha-blend without occluding geometry behind them and are visible from both sides.

## Code map

- `src/engine/world/lighting.ts` — BFS module (`fillChunkLights`, `updateLightsForBlockChange`, helpers).
- `src/engine/world/lighting.test.ts` — coverage for column seeding, overhang attenuation, RGB blending, incremental updates.
- `src/engine/world/chunk.ts` — packed-nibble storage + accessors.
- `src/engine/world/mesher.ts` — `sampleCornerLight`, `lightSampleToRGB`, `aoFactorForCorner`, and the opaque/liquid vertex pipelines.
- `src/engine/render/renderer.ts` — `MeshBasicMaterial` setup, `mountChunkMesh` writing the `color` attribute.
- `src/game/loop.ts` — `applyLightUpdate` wiring; called after every block edit.

## Known trade-offs

- **BFS uses `Array.shift()`** which is O(n). Fine at chunk scale (16k voxels × BFS constant factor) but would warrant a ring-buffer replacement if profiling shows stalls.
- **Diagonal chunk corners fall through to dark.** For a `py`/`ny` face at a chunk-corner column, sampling can request a voxel in the diagonal chunk; we return 0 there rather than routing across two boundaries. Produces sub-pixel darkening at chunk corner columns only — visually imperceptible at typical view angles.
- **No animated light sources.** Lava glow is static; lamp colours are static. Adding a flicker or pulse would mean per-frame re-flood for affected voxels, which we avoid by keeping emission constant.
