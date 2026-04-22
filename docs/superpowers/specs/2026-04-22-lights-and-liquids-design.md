# Voxel Light Propagation + Liquids — Design

Date: 2026-04-22
Branch: `feat-lights-and-liquids` (off `main`)

## Problem

Two unrelated-but-interacting problems in one spec:

1. **The current sun-shadow-map approach can't correctly light voxel caves.** Deep enclosed chambers still leak daylight through floor-wall seams; tuning the shadow bias is a dead end because the artifacts are inherent to using a single directional shadow map on axis-aligned voxel geometry with deep pockets of interior space. The kid's cave never feels dark enough, and fixing this on the rendering side was escalated to the architect who confirmed the approach is wrong. The right fix is per-voxel flood-fill light propagation.

2. **Water and lava are desirable kid-creative tools.** Water pools give the world variety; lava gives the kid a glowing orange substance to build with. Both need to arrive eventually, and both interact with lighting: water and lava are translucent (light passes through them with some attenuation), and lava emits light. Designing the light system without accounting for this would mean rewriting parts of the light propagator later.

Combining both into one coordinated spec is correct because:
- The lighting rewrite needs to know about translucent-but-not-air blocks (water, lava) from day one.
- Water and lava rendering requires per-vertex light data, which only exists once the propagator ships.
- World-gen changes (flatter terrain, water pools below sea level) depend on the water block existing and on lighting handling it correctly.
- The fall-vs-spread flow rules compose naturally with `swim` mode, which reuses the fly-mode cursor-directed movement that the user is also changing.

## Goals

- Replace sun shadow mapping with voxel light propagation (skylight + RGB block light).
- Caves genuinely go dark away from light sources; lamps and lava are meaningful illumination.
- Add `water` and `lava` as placeable blocks (hotbar, kid-mode enabled for both).
- Implement simple discrete-step flow (fall-if-unsupported, else spread-sideways, 2 Hz).
- Flatter world-gen with sea-level-based water fill.
- Swim mode (floaty, cursor-directed) engages when the player's eye is inside a liquid.
- Cursor-directed movement (pitch controls vertical via W) extends to fly mode too; space/shift removed from fly.

## Non-goals

- No flow animations or smooth transitions — water and lava render as static blocks.
- No lava damage, ignition, or block-to-stone conversion on water/lava contact.
- No water physics (no fluid pressure, currents, partial-fill levels).
- No bucket item or item-with-state concept — liquids are placeable blocks.
- No save-format migration — the new world-gen will reshape unmodified chunks in existing saves (accepted break).
- No swim-speed tiers — swim is always 60% of walk speed.
- No color picker for water or lava — fixed palette-baked blue and orange-red.
- No underwater visual effects (no fog tint, no screen overlay, no breath / drowning).
- No caves or biomes in this pass (world-gen stays heightmap-only; lava has no gen-time location).
- No migration of existing saves to flag "needs terrain reflow" — users accept that unmodified terrain around existing builds will shift.

---

## Architecture

Four subsystems, loosely coupled:

1. **Light propagation** — per-voxel `skyLight` + per-voxel RGB `blockLight`, flood-filled by BFS, attenuated by each block's `lightFilter`, seeded by blocks with nonzero `lightLevel`. Rendered by writing a per-vertex color attribute on chunk meshes.
2. **Liquid rendering** — separate mesh per chunk for liquid faces, rendered in a translucent second pass.
3. **Liquid flow** — `LiquidScheduler` ticks at 2 Hz, applying fall-or-spread-sideways to each liquid voxel in loaded chunks.
4. **Movement** — `Player` gets a `swimming` state; in fly or swim, W moves along the full 3D look direction; strafe stays horizontal; space/shift ignored.

Plus world-gen edits (flatter noise, sea level, water fill, shoreline sand).

## Block catalog changes

### `BlockDef` schema addition (`src/data/blocks.data.ts`)

Two new scalar fields and one new discriminator:

```ts
export type BlockDef = {
    id: BlockId;
    name: string;
    label: string;
    solid: boolean;
    transparent: boolean;
    kidMode: boolean;
    hardness: number;
    lightLevel: number;   // 0-15, emission. Air=0, lamp=15, lava=12, everything else=0.
    lightFilter: number;  // 0-15, attenuation for propagated light. Opaque solid=15, air=0, glass=0, water=2, lava=3, lamp=15.
    liquid: 'none' | 'water' | 'lava';
    textures: BlockFaceTextures | null;
};
```

### Existing rows — `lightLevel`, `lightFilter`, `liquid` defaults

| Block | lightLevel | lightFilter | liquid |
|---|---|---|---|
| air (0) | 0 | 0 | none |
| grass_block, dirt, stone, cobblestone, sand, oak_planks, oak_log, *_wool, tnt | 0 | 15 | none |
| glass (8) | 0 | 0 | none |
| lamp (16) | 15 | 15 | none |

(Lamps emit but don't transmit — they propagate their own color outward via the flood-fill seed, but light from outside doesn't pass through them.)

### New rows

```ts
{ id: 17, name: 'water', label: 'Water', solid: false, transparent: true, kidMode: true,
    hardness: 0, lightLevel: 0, lightFilter: 2, liquid: 'water',
    textures: { kind: 'uniform', all: 'water_still' } },
{ id: 18, name: 'lava', label: 'Lava', solid: false, transparent: true, kidMode: true,
    hardness: 0, lightLevel: 12, lightFilter: 3, liquid: 'lava',
    textures: { kind: 'uniform', all: 'lava_still' } },
```

Mining hardness 0 means a left-click deletes the liquid instantly (no bucket pickup). Atlas builder picks up `water_still.png` and `lava_still.png` from `src/assets/blocks/` automatically.

### Mesher-relevant helpers

- `isOpaque(id)` → returns `true` when `lightFilter >= 15`. Solid blocks except glass/lamp (lamp is still opaque — the mesher hides faces behind lamps as before).
- `isLiquid(id)` → returns `BLOCKS[id].liquid !== 'none'`.

## Per-voxel light data (`src/engine/world/chunk.ts`)

Each chunk gains a second storage array:

```ts
readonly lights: Uint16Array;  // 16×64×16 = 16384 entries, 2 bytes each = 32 KB/chunk.
```

Packed layout per voxel, 16 bits, 4 bits per channel:

```
bit  15..12  11..8   7..4   3..0
     skyLight blockR blockG blockB
```

Getter/setter helpers on `Chunk`:

```ts
getSky(x, y, z): number;      // 0..15
getBlockR(x, y, z): number;   // 0..15
getBlockG(x, y, z): number;
getBlockB(x, y, z): number;
setSky(x, y, z, v): void;
setBlockRGB(x, y, z, r, g, b): void;
```

All light arrays are **derived state**. They are never saved. On chunk load, `fillChunkLights(world, chunk)` computes them from the block array before the mesher runs.

Active-liquid tracking (for the flow scheduler) also lives on `Chunk`:

```ts
readonly liquidFrontier: Set<number>;  // local indices of liquid voxels that may change this tick
```

`Chunk.set(x, y, z, id)` maintains this set:
- Adding a liquid → `liquidFrontier.add(indexOf(x,y,z))`.
- Replacing a liquid with a non-liquid → `liquidFrontier.delete(...)`.
- Any write also adds the 6 neighbors to their respective chunks' frontier sets (cross-chunk case handled via a helper on `World`), because adding/removing a block may wake up dormant liquid nearby.

## Lighting algorithm (`src/engine/world/lighting.ts` — new file)

Standard voxel flood-fill with two independent BFS queues: one for skylight, one for block light. Block light uses three separate sub-BFS passes, one per RGB channel.

Step per light "unit":
```
newLight = max(currentLight, sourceLight - max(1, targetLightFilter))
```

The `max(1, ...)` ensures at least 1 level of attenuation per step even in zero-filter media (air, glass), so light fades with distance. `targetLightFilter` from the destination block adds extra attenuation — water subtracts 2 per step, lava subtracts 3.

### Initial full-chunk flood-fill

`fillChunkLights(world: World, chunk: Chunk): Set<Chunk>`

1. **Clear.** Zero the chunk's `lights` array.
2. **Skylight seeding.** For each (x, z) column: walk from y=63 downward. Set `skyLight = 15` at each voxel until we hit a block with `lightFilter >= 15`. Stop that column.
3. **Skylight BFS.** Queue all skylight-15 voxels. Pop each; for each of the 6 neighbors, compute `propagated = currentSky - max(1, neighborFilter)`. If `propagated > neighborCurrentSky`, update it and enqueue. **Vertical downward case gets a special rule:** propagating from a voxel with `skyLight == 15` into a voxel directly below with `lightFilter == 0` keeps skyLight at 15 (no decrement). This preserves "full sunlight streams straight down a mineshaft" behavior. All other directions use the standard attenuation.
4. **Block-light seeding (per channel).** For each voxel with `lightLevel > 0`, seed three 0-15 channels at that voxel, one per BFS queue:
    - **Lamps:** read the stored hex color from `LightRegistry` (default `#FFF5E0` if missing). Parse to `(r, g, b)` floats in `[0, 1]`. Seed channel values = `round(normalizedChannel × lightLevel)`. So a red lamp at lightLevel 15 seeds `(15, 0, 0)`. A warm-white lamp at `#FFF5E0` seeds roughly `(15, 14, 13)`.
    - **Lava:** fixed color `#FF8A3D` (orange-red). At lightLevel 12, seeds roughly `(12, 6, 3)`. Defined as a single constant `LAVA_LIGHT_COLOR = '#FF8A3D'` near the top of `lighting.ts` so future tweaking is a one-line data edit. If more non-lamp emitters are added later, they get their own constant or graduate to a `BlockDef.emissionColor` field — not speculated about now.
5. **Block-light BFS.** Same propagation rule as skylight, per channel, combining with `max` on overlap.

Returns the set of chunks touched (includes the target chunk plus any neighbors the BFS reached into), so the caller can mark all of them for re-mesh.

### Cross-chunk propagation

BFS dequeue operates in world coordinates. On each step, the target voxel's chunk is found via `World.ensureChunk()`; if different from the source's chunk, the target chunk is added to the "touched" set. Neighbor chunks are loaded lazily by `ensureChunk`, which runs the full generation + initial flood-fill for them if they don't exist yet. In practice the initial flood-fill for a new chunk only reaches a few voxels into neighbors before attenuating to 0.

### Incremental update on block change

`updateLightsForBlockChange(world: World, x: number, y: number, z: number): Set<Chunk>`

Called after `world.setBlock(x, y, z, newId)`. The previous light value at `(x, y, z)` is still in `chunk.lights` because the lightmap hasn't been updated yet.

1. **Removal phase.** For each light field (skylight, blockR, blockG, blockB):
    - If the changed voxel's old light value was nonzero, or if `newFilter > oldFilter`, seed a "removal BFS": queue `(x, y, z, oldLightValue)`. Pop each entry; set the voxel's light to 0. For each neighbor: if the neighbor's current light value is less than the popped value, zero it and enqueue it for removal. Else, enqueue that neighbor into the "re-propagate" queue for the addition phase. Also enqueue the original 6 neighbors into the re-propagate queue at the start.
2. **Addition phase.** The re-propagate queue now contains a set of bright voxels (unchanged by the removal). For each, run the standard additive BFS as in step 3–5 of the initial fill, but only within already-loaded chunks.
3. **New emitter.** If `newBlock.lightLevel > 0`, seed the addition phase BFS at `(x, y, z)` with the new emitter's color.
4. **New filter change.** If `newBlock.lightFilter < oldFilter` (block became more transparent: e.g., stone → air), the addition phase will naturally flow light into the newly-unblocked voxel from its neighbors.
5. **Skylight special case.** If the change exposed/covered a column to the sky, re-seed the column's downward skylight propagation: walk down from y=63 at (x, z) and seed the first lit voxel.

Returns the set of chunks whose lightmap changed.

Typical mine/place touches tens to hundreds of voxels. Well under a millisecond on hot paths; re-meshing the affected chunks is the dominant cost (already paid by the existing dirty-chunk pipeline).

### Mesher sampling (`src/engine/world/mesher.ts`)

Per face vertex, compute the vertex's light by averaging the 4 voxels touching that corner:
- The face's own voxel.
- The outward neighbor (across the face).
- The two voxels edge-adjacent to the corner (sharing an edge with both the face's voxel and the outward neighbor).

For each of the 4 voxels, read `(sky, blockR, blockG, blockB)`. Average the four tuples. Result is the vertex's light.

### Ambient occlusion

In the same corner sample: if two of the four corner-voxels are opaque (`lightFilter >= 15` AND `liquid === 'none'`), multiply the vertex's light by `0.75`. If the diagonal corner is also opaque (all three non-face voxels are solid), multiply by `0.6` instead. Classic Minecraft AO. No corner-darkening when the vertex is on a face adjacent to liquid (liquid doesn't darken neighbors — it lets light through).

### Vertex color output

```
skyColor = vec3(0.9, 0.95, 1.0)       // slightly cool sun tint
minAmbient = vec3(0.08, 0.08, 0.08)   // "caves aren't pitch black"

rgb = (sky/15) * skyColor
    + vec3(blockR/15, blockG/15, blockB/15)
rgb = min(rgb * ao, vec3(1.0)) + minAmbient
rgb = min(rgb, vec3(1.0))
```

Written to the chunk mesh's new `colors: Float32Array` attribute (3 floats per vertex).

### Material change (`src/engine/render/renderer.ts`)

```ts
this.material = new THREE.MeshBasicMaterial({
    map: atlas.texture,
    alphaTest: 0.5,
    vertexColors: true,
    side: THREE.FrontSide,
});
```

Removed from the scene:
- `THREE.DirectionalLight` (the sun).
- `THREE.AmbientLight`.
- `sun.castShadow` + `sun.shadow.*` config.
- `this.gl.shadowMap.enabled` (no longer needed).
- `setSunTarget()` method (no caller once the loop stops calling it).
- Every `mesh.castShadow` / `mesh.receiveShadow` set on chunk meshes.

All illumination now comes from the per-vertex color attribute. No lighting is computed in-shader — `MeshBasicMaterial` multiplies the texel by the vertex color.

## Liquid rendering (`src/engine/world/mesher.ts`)

### New mesher output shape

```ts
export type ChunkMesh = {
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    colors: Float32Array;    // NEW — per-vertex RGB from light sampling
    indices: Uint32Array;
};

export type ChunkMeshResult = {
    opaque: ChunkMesh;
    liquid: ChunkMesh | null;  // null if chunk has no liquid
};

export function meshChunk(chunk: Chunk, neighbors: Neighbors, uvFor: UvFn): ChunkMeshResult;
```

### Opaque pass (unchanged except for the colors attribute)

Existing `shouldEmitFace` logic stays. Added: compute vertex colors per corner via the 4-voxel light sample described above.

### Liquid pass (new)

Second scan over the chunk. For each liquid voxel at `(x, y, z)` with id `here`:
- For each of the 6 face directions:
  - Let `there = neighborBlock(chunk, neighbors, x+dx, y+dy, z+dz)`.
  - Emit the face if `there === AIR`.
  - Emit the face if `isLiquid(there)` AND `there !== here` AND `here.id < there.id` (liquid-liquid boundary: emit from exactly one side — the lower-id wins, so water shows its face toward lava but lava does not show its face toward water). Prevents double-rendering + z-fighting at the water-lava interface.
  - Skip the face if `there === here` (water-water or lava-lava — no internal faces).
  - Skip the face if `isSolid(there)` (solid block's own face toward the liquid is already emitted by the opaque pass).

Per-vertex lighting sampled identically to the opaque pass.

### Renderer changes

`mountChunkMesh(chunk, meshResult)` accepts the new pair. The renderer manages two `Map<chunkKey, THREE.Mesh>` registries: `opaqueMeshes` and `liquidMeshes`.

Liquid material:

```ts
this.liquidMaterial = new THREE.MeshBasicMaterial({
    map: atlas.texture,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
});
```

`depthWrite: false` prevents translucent water from occluding objects behind it. `DoubleSide` so the kid sees the water surface from inside a pool too. `transparent: true` makes Three.js draw it after opaque geometry automatically.

## Liquid flow (`src/game/liquid-scheduler.ts` — new file)

### Class shape

```ts
export class LiquidScheduler {
    constructor(
        private world: World,
        private onChunkDirty: (cx: number, cz: number) => void,
    );
    tick(dt: number): void;
}
```

### Tick accumulator

```ts
private accumulator = 0;
private readonly TICK_INTERVAL = 0.5;  // seconds

tick(dt: number): void {
    this.accumulator += dt;
    if (this.accumulator < this.TICK_INTERVAL) return;
    this.accumulator -= this.TICK_INTERVAL;  // clamp: never fire more than once per invocation
    this.applyFlowStep();
}
```

A long frame (e.g., `dt=2`) still fires only once per `tick()` call — no catch-up, no cascading ticks. Keeps the algorithm O(active-frontier) per game frame.

### Per-step algorithm

**Atomic reads.** All `world.getBlock` reads during the loop see the state as it was at the start of the tick. Writes are buffered and only committed after every source has been processed. This makes iteration order irrelevant.

```
// Snapshot the frontier so that adds during the loop don't affect this pass.
snapshot = Array.from(union of all chunks' liquidFrontier sets)
pendingWrites = [] as {x, y, z, liquidId}[]

for each (x, y, z) in snapshot:
    currentId = world.getBlock(x, y, z)     // live state, but nothing has written yet this tick
    if !isLiquid(currentId): continue       // stale frontier entry — skip

    // Rule 1: fall if unsupported
    below = world.getBlock(x, y-1, z)
    if below === AIR:
        pendingWrites.push({x, y, z, id: AIR})
        pendingWrites.push({x, y-1, z, id: currentId})
        continue

    // Rule 2: spread sideways
    for each of (+x, -x, +z, -z):
        neighbor = world.getBlock(...)
        if neighbor === AIR:
            pendingWrites.push({x: nx, y, z: nz, id: currentId})

// Commit phase — apply all pending writes, deduplicating by (x,y,z).
// Each voxel gets at most one final id:
//   - If any write sets a liquid id, the liquid wins (covers fall-pair + sideways collisions).
//   - AIR is written only if no liquid write collides on the same voxel.
finalWrites = new Map<coordKey, liquidId>
for w in pendingWrites:
    existing = finalWrites.get(coordKey(w))
    if existing === undefined: finalWrites.set(coordKey(w), w.id)
    else if existing === AIR && w.id !== AIR: finalWrites.set(coordKey(w), w.id)
    // else keep existing (liquid beats air, any liquid beats any other liquid arbitrarily)

for each (coord, id) in finalWrites:
    if world.getBlock(coord) === id: continue   // no-op
    world.setBlock(coord, id)
    lighting.updateLightsForBlockChange(world, coord)   // liquids change filter, re-flood locally
    onChunkDirty(cx, cz)
```

The `liquid-beats-air` rule handles the case where block A falls (writing AIR at its old position and liquid at the position below) and block B, at the position below A, ALSO falls (writing AIR at its old position — which is the same voxel A wants to fill with liquid). In that case B's AIR would come first in the write list, and A's liquid wins — which is correct, since the snapshot is the source of truth: A had liquid at y, B had liquid at y-1, B falls to y-2 vacating y-1, and A fills y-1 with water. Coherent outcome: after commit, y=AIR, y-1=liquid (from A), y-2=liquid (from B).

### Active-frontier maintenance

`Chunk.liquidFrontier` holds local-index keys of liquid voxels that may change on the next tick. Rules:

- On `Chunk.set(x, y, z, newId)`:
  - If `newId` is liquid → add `(x,y,z)` to this chunk's frontier, AND add the 6 neighbor voxels (or their chunks' frontier sets for cross-chunk) to their frontiers too.
  - If the old id was liquid and `newId` is not → remove `(x,y,z)` from this chunk's frontier, add the 6 neighbors to theirs (they may now want to fall or spread into the vacated voxel).
- At the end of each tick, for each liquid that didn't change state: if all 6 neighbors are either solid or the same liquid (i.e., no motion possible next tick), drop it from the frontier. If a future block-change re-exposes it, it re-enters via the `Chunk.set` rule.

Fully-enclosed liquids drop out of the frontier within one tick, so a large pool costs O(perimeter), not O(volume).

### Interactions

- **Mining a liquid block**: hardness-0 left-click deletes it. Scheduler's frontier loses it naturally via `Chunk.set`. Neighbors re-enter their frontiers.
- **Placing a liquid block**: right-click on face places it. Scheduler picks it up on the next tick.
- **TNT destroys a liquid block**: `detonate()` calls `setBlock(AIR)`. Neighbors re-enter frontier, potentially flowing in to fill the void.
- **Lighting**: each liquid block write triggers `updateLightsForBlockChange`, re-flooding locally. A waterfall re-floods ~20 voxels per tick — cheap.
- **Autosave**: liquid blocks live in the `blocks` array and persist through the existing modified-chunk save path. No new save field.

## Movement (`src/game/player.ts`)

### Swim-state detection

Runs once per tick, before physics:

```ts
const eyeX = Math.floor(this.eyePosition()[0]);
const eyeY = Math.floor(this.eyePosition()[1]);
const eyeZ = Math.floor(this.eyePosition()[2]);
const eyeBlock = world.getBlock(eyeX, eyeY, eyeZ);
this.swimming = BLOCKS[eyeBlock]?.liquid !== 'none' && BLOCKS[eyeBlock] !== undefined;
```

`swimming` flips cleanly as the eye crosses voxel boundaries.

### Movement rule

```ts
if (this.flying || this.swimming) {
    // Full 3D along cursor forward; strafe horizontal only.
    const forwardSpeed = this.flying
        ? FLY_BASE_SPEED * FLY_SPEED_TIERS[this.flySpeedTier]
        : WALK_SPEED * 0.6;
    velX = (forwardInput * fwd.x + strafeInput * right.x) * forwardSpeed;
    velY = (forwardInput * fwd.y) * forwardSpeed;  // strafe has no Y
    velZ = (forwardInput * fwd.z + strafeInput * right.z) * forwardSpeed;
    // Gravity skipped.
} else {
    // On-ground walking — existing behavior unchanged.
    // fwd.xz projected onto XZ plane; Y always 0; gravity applied.
}
```

`right` is computed as `(fwd × worldUp)` normalized — its Y component is already ~0 by construction, so "strafe horizontal" is the default.

### Key removals

`src/data/keybindings.data.ts`:
- Remove `flyUp` action, label, default.
- Remove `flyDown` action, label, default.

Any saved options still containing those keys are harmlessly dropped on load (existing merge logic only keeps known actions).

`src/main.ts`:
- Remove `case 'flyUp'` and `case 'flyDown'` in the key dispatcher.

The `=` / `-` fly-speed-tier keys are untouched (still only meaningful in fly mode).

### Edge cases

- **Fly + swim simultaneously**: `flying` takes precedence for speed. Both produce full-3D cursor-direction motion, so the transition as the eye exits water while flying is invisible.
- **Waist-deep water**: feet in liquid, eye in air → not swimming. Player walks through with normal speed (liquid is non-solid, doesn't block motion). Matches "wading" feel.
- **Exact voxel boundary**: `Math.floor` gives deterministic flipping on a single-pixel position change.
- **Falling into water from height**: player AABB hits water (non-solid), passes through, eye eventually enters liquid, swim activates. Fall damage would stop on swim activation — but we don't have fall damage, so this is moot.

## World generation (`src/engine/world/generation.ts`)

### New constants

```ts
const MIN_H = 24;               // was 20
const MAX_H = 34;               // was 50 — amplitude 10, down from 30
const NOISE_SCALE = 1 / 64;     // was 1/48 — wider features
const SEA_LEVEL = 28;           // new
const DIRT_BAND = 3;            // unchanged
```

### Solid-column loop (modified — shoreline sand)

```ts
for (let y = 0; y <= h; y++) {
    let id: number;
    if (y === h) {
        id = (h < SEA_LEVEL) ? SAND : GRASS;
    } else if (y >= h - DIRT_BAND) {
        id = DIRT;
    } else {
        id = STONE;
    }
    chunk.blocks[indexOf(lx, y, lz)] = id;
}
```

Underwater/shoreline tops become sand. Grass remains only above sea level.

### Water-fill pass (new)

```ts
if (h < SEA_LEVEL) {
    for (let y = h + 1; y <= SEA_LEVEL; y++) {
        chunk.blocks[indexOf(lx, y, lz)] = WATER;
    }
}
```

Voxels above the heightmap and below-or-at sea level become water. Voxels below the heightmap (underground stone/dirt) are untouched — no water replaces solid material.

### No lava in world-gen

Lava is placement-only. Generation does not seed lava pockets.

### Post-gen

After the solid + water-fill pass, `fillChunkLights(world, chunk)` runs (called from `World.ensureChunk`).

## Persistence

### Save format changes

None. New blocks are just new ids in the existing `blocks` array; they save through the existing modified-chunk path.

### Load sequence

For each chunk loaded:
1. Block data loaded (from save if modified) OR generated from seed.
2. `fillChunkLights(world, chunk)` — new step, always runs after block data is in place.
3. Scheduler scans chunk's liquid voxels into its active-frontier set (populated by `Chunk.set` during generation; verified/re-seeded on save-load).
4. Mesher produces `{opaque, liquid}` pair.
5. Renderer mounts them.

### World-gen compatibility

Existing saves were generated with the old `MIN_H=20, MAX_H=50, NOISE_SCALE=1/48` and no water. With this update:
- Modified chunks keep their saved geometry.
- Unmodified chunks regenerate with the new constants on first load after the update.

Accepted consequences:
- The natural landscape around existing builds shifts: hills flatten, valleys appear, water fills low spots.
- Seams between saved and regenerated chunks may look abrupt at their shared edges.
- No migration / versioning is implemented. A fresh world with a new seed is the cleanest experience, but existing worlds remain playable.

## Testing

New test files. Counts are targets — actual density may grow during implementation.

### `src/engine/world/lighting.test.ts` (~12 cases)
- Skylight fills fully-open column to 15 at every y.
- Skylight drops to 0 immediately below a solid block with no lateral path.
- Skylight attenuates by 1 per block horizontally under an overhang.
- Skylight passes through glass unchanged.
- Skylight attenuates correctly through water (filter 2).
- Block light from one lamp radiates outward with distance decay.
- Block light RGB: red lamp produces nonzero R, zero G/B at neighbors.
- Two overlapping lamps of different colors: per-channel max, not sum.
- Mining a lamp removes its propagated light.
- Breaking a wall exposes new skylight to a previously-dark area.
- Cross-chunk propagation: lamp at chunk edge illuminates voxels in neighbor chunk.
- AO: vertex adjacent to two solid neighbors is darker than zero- or one-solid case.

### `src/engine/world/mesher.test.ts` (extended, ~4 new cases)
- Opaque + liquid are separate outputs for a chunk with both.
- Water face emitted toward air; suppressed between two water blocks.
- `colors` attribute populated with values derived from the chunk's lightmap.
- Fully-lit vertex has RGB near skyColor + ambient.

### `src/game/liquid-scheduler.test.ts` (~10 cases)
- Unsupported liquid block falls by 1 voxel per tick.
- Supported liquid (solid below) spreads horizontally to adjacent air.
- Liquid does not spread upward.
- Fall takes priority over sideways-spread (placed-in-midair water doesn't spread horizontally).
- Tick accumulator: `tick(0.4)` does not fire; `tick(0.6)` fires once; `tick(1.2)` fires once (no catch-up).
- Write-buffering: new blocks from sideways-spread don't process within the same tick.
- Liquid joining existing same-type pool: no-op.
- Lava spreads with the same rules as water.
- Mining a block adjacent to a dormant liquid re-enters that liquid into the active frontier.
- Fully-enclosed liquid exits the active frontier within one tick.

### `src/game/player.test.ts` (extended, ~6 new cases)
- `swimming` activates when eye voxel becomes water.
- `swimming` deactivates when eye voxel becomes air.
- In fly mode, W moves in full 3D camera direction.
- In fly mode, A/D strafes horizontally regardless of pitch.
- In fly mode, space/shift do not affect velocity.
- Swim-mode forward speed is 0.6 × walk speed.

### `src/engine/world/generation.test.ts` (extended, ~3 new cases)
- Water exists at every y in (h, SEA_LEVEL] when h < SEA_LEVEL.
- No water exists above SEA_LEVEL anywhere.
- Solid material at y ≤ h is never replaced by water.

### `src/data/blocks.data.test.ts` (extended, ~3 new cases)
- Water has `liquid: 'water', lightLevel: 0, lightFilter: 2`.
- Lava has `liquid: 'lava', lightLevel: 12, lightFilter: 3`.
- All existing solid opaque blocks default to `lightFilter: 15, lightLevel: 0`.

### Manual verification
- Caves visually dark away from light sources (no shadow-map leak).
- Lamp color picker still works end-to-end; lamp color propagates.
- Waterfall off a cliff: continuous stream, pool at bottom.
- Swim diving: look down + W descends the player.
- Mid-air water placement falls cleanly with no column.
- Flat-ground water placement fills a room.
- Autosave → reload: water/lava persist; lights recompute correctly.

Approximate new test count: ~40 unit cases, bringing total from 88 → ~128.

## Edge cases

- **Place a lamp in water.** Lamp is solid and opaque (`lightFilter: 15`), so water can't be in the same voxel. The right-click placement replaces water with the lamp block. Water doesn't flow back until something mines the lamp.
- **Mine a lamp under water.** Water above now has air below, falls in on next tick. Lamp's light disappears; water's blue tint returns after the next light re-flood.
- **Two lamps of different colors in the same chamber.** Per-channel `max` on overlap means the room is lit by the brighter per-channel component. Cool visual where one corner reads purple (from a red + blue pair).
- **Water flowing onto lava.** Both are non-solid. Water falling hits lava — since `lava !== AIR`, the fall rule fails, and the water block remains. Sideways-spread into lava also fails (neighbor is not air). Net effect: water settles on top of lava, with both coexisting. No stone conversion (explicit non-goal). Mildly weird but stable.
- **Lava flowing onto water.** Symmetric to above. Lava rests on water.
- **Chunks unloading.** Out of view-radius chunks eventually get unloaded (future feature; currently none are). Scheduler's `liquidFrontier` lives on the chunk itself, so an unloaded chunk's frontier goes with it. When the chunk reloads, all liquid voxels re-enter the frontier for one tick to catch up on any blocked flow.
- **Very tall column of water, unsupported at the bottom.** Only the bottom block has "air below" in the snapshot; every higher block has water below in the snapshot. So in one tick only the bottom block falls. Next tick the new-bottom sees air below and falls, etc. The column descends 1 block per tick = 2 blocks per second. Predictable, matches the fall-rate guarantee.
- **Water placed inside a sealed room full of air.** Fills the room block-by-block. Any air pocket with no path to the outside stays unfilled (water can't teleport). OK.

## Files touched

### New files (4)

- `src/engine/world/lighting.ts` — flood-fill + incremental update.
- `src/engine/world/lighting.test.ts` — ~12 cases.
- `src/game/liquid-scheduler.ts` — flow tick.
- `src/game/liquid-scheduler.test.ts` — ~10 cases.

### Modified files (14)

- `src/data/blocks.data.ts` — extend `BlockDef`; fill new fields on all rows; add `water`, `lava`.
- `src/data/blocks.data.test.ts` — 3 new cases.
- `src/data/keybindings.data.ts` — remove `flyUp`, `flyDown`.
- `src/engine/world/chunk.ts` — add `lights: Uint16Array`, getters/setters, `liquidFrontier` set, frontier-maintenance hooks in `set()`.
- `src/engine/world/generation.ts` — flatter heightmap, sea-level water fill, shoreline sand.
- `src/engine/world/generation.test.ts` — 3 new cases.
- `src/engine/world/mesher.ts` — return `{opaque, liquid}`; new `colors` attribute; AO; liquid pass.
- `src/engine/world/mesher.test.ts` — 4 new cases.
- `src/engine/world/world.ts` — call `fillChunkLights` after generate/load; expose `updateLightsForBlockChange` hook.
- `src/engine/render/renderer.ts` — remove sun/ambient/shadow; swap material to `MeshBasicMaterial` w/ vertexColors; add liquid material; `mountChunkMesh` accepts pair.
- `src/game/player.ts` — `swimming` state; full 3D cursor-directed movement in fly/swim; space/shift ignored when flying or swimming.
- `src/game/player.test.ts` — 6 new cases.
- `src/game/loop.ts` — instantiate + tick `LiquidScheduler`; call `updateLightsForBlockChange` on block edits; enqueue returned chunks for re-mesh.
- `src/main.ts` — wire new scheduler; remove fly-up/down key cases; delete sun-target update call.

### Atlas builder (verify, no code change expected)

- `scripts/build-atlas.ts` already scans `src/assets/blocks/*.png`. Verify `water_still.png` and `lava_still.png` exist there; if not, add them from the Mojang source.

### Unchanged (called out to confirm nothing is missed)

- `src/persistence/*` — no save-format changes.
- `src/ui/*` — options menu rebuilds from the `ACTIONS` list; no explicit edits.
- `src/engine/render/light-registry.ts` — still used for lamp color storage; feeds block-light flood-fill.
- `src/engine/render/primed-overlay.ts`, `src/engine/render/particles.ts` — untouched.
- `src/game/tnt.ts`, `src/game/actions.ts` — untouched; liquid blocks pass through the existing mine/place paths.

## Out of scope (deferred)

- Flow animations, UVs that scroll, wave geometry.
- Lava damage, ignition, water-on-lava → stone conversion.
- Fluid physics (levels, pressure, currents, partial-fill).
- Bucket item or any item-with-state concept.
- Underwater visual effects (fog tint, screen overlay).
- Breathing / drowning mechanics.
- Caves, biomes, gen-time lava pockets.
- Save-format version migration.
- Swim-speed tiers / separate swim-speed keys.
- Color-picker integration for water/lava.
- Smooth color transitions when a lamp's color is re-picked.
