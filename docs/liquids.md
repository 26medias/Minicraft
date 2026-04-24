# Liquids

Water and lava are placeable blocks with simple discrete-step flow. This doc describes their data rows, rendering, and the scheduler that moves them each tick.

## Philosophy

The goal is a creative toy for a 7-year-old: pour water to fill a room, place lava for a glow. We explicitly do **not** model:

- Fluid pressure or partial-fill levels (every liquid voxel is "full").
- Swimming physics in the Minecraft sense — the player just uses cursor-directed movement while submerged, same as fly mode.
- The two "softer" Minecraft reactions (cobblestone from flowing lava meeting water, stone from lava flowing into water). We collapse to a single rule: any water ↔ lava contact → obsidian + water consumed.
- Two adjacent water sources creating infinite water (Minecraft's source-merging rule).
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

Obsidian (id 19) is a regular solid block produced by the water+lava reaction. It has no liquid behaviour of its own — once placed it's just another mineable block.

## Source vs flow

Every liquid voxel is one of two kinds:

- **Source** — permanent. Created by player placement and by world-gen (the ocean fills with sources). Spreads horizontally up to its budget (water 4 hops, lava 2) and falls vertically with no limit. Removed only by player mining.
- **Flow** — created by spread or fall. Carries an integer `distance` (0–15) = number of *horizontal* hops from the nearest source. Falls do not increment distance. A flow voxel exists only as long as some source can still reach it via same-type-liquid neighbours — otherwise the drain step peels it away (see below).

Storage: each chunk holds a sparse `fluidMeta: Map<number, number>` of packed bytes. Bit 7 is always 1 (marker so the raw byte is self-identifying); bits 0–3 carry the distance. **Sources have no entry** — the default rule is the storage win, so the world-gen ocean carries zero entries and zero per-tick cost.

Persistence: the chunk save format gains an optional `fluidMeta` field, encoded via `encodeFluidMeta` (varint count + pairs, deflate+base64, same pipeline as `encodeChunk`). Saves from before this feature load with `rc.fluidMeta === undefined`, which is correctly interpreted as "every liquid in the saved world is a source."

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

Lives in `src/game/liquid-scheduler.ts`. Instantiated by `GameLoop` and ticked each frame with `dt`. Each tick runs three phases — drain, spread, reaction — on a snapshot of the current frontier, then decays the frontier.

### Tick accumulator

```ts
accumulator += dt
if (accumulator < 0.5) return
accumulator = 0   // no catch-up; discard overflow
```

A long frame (e.g. `dt = 1.2`) fires **once**, not twice. This avoids compounding stutters and keeps the algorithm cost bounded per frame. The scheduler resets (not subtracts) the accumulator, so a hitched frame loses partial credit — imperceptible at 60 fps.

### Active frontier

Each `Chunk` owns a `liquidFrontier: Set<number>` of local voxel indices whose liquid might change on the next tick. Maintenance happens in `World.setBlock` and `World.setBlockFlow`: every write examines the written voxel plus its 6 axis-aligned neighbours, and any liquid found there is added to its chunk's frontier (cross-chunk handled via `worldToChunk`).

On first mount of a chunk, `GameLoop.flushDirtyChunks` seeds the frontier with every liquid voxel in the chunk (a one-time scan). Most of these drop back out immediately at the end of their first tick because they're fully enclosed by same-type liquid on all relevant sides.

**Frontier decay.** At the end of every tick, the scheduler scans each chunk's frontier and removes entries whose 5 neighbours (±x, ±z, −y) are all non-air. Fully-enclosed pool interiors drop out of the active set within one tick of being enclosed, so a 10,000-voxel ocean costs near-zero to tick, not O(volume).

### Phase 1 — drain

Drain runs *first* so that Phase 2's spread step doesn't waste work recomputing cells that are about to be peeled away. It writes `AIR` immediately (no "next-tick flush queue"), and produces a visible outside-in cascade: the outermost ring of orphaned flow peels first, the next tick reveals the new outermost, etc.

1. Gather every flow cell and every source from every chunk's frontier.
2. **BFS pass A** — seed from the in-frontier sources and mark every reachable same-type-liquid cell as alive (6-axis neighbours, so the column-above case is covered).
3. **BFS pass B** — for each un-reached flow candidate, walk its connected component via same-type-liquid neighbours. If the component contains a source (possibly one that decayed out of the frontier because it was fully-enclosed), mark the whole component alive. Otherwise every flow cell in the component — including interior cells that had decayed out of the frontier — is an orphan.
4. Partition orphans by liquid type. For each type, find the current maximum `distance` among orphans and write `AIR` to **only those cells** (via `world.setBlock`, which auto-clears their `fluidMeta` entries and re-seeds the frontier for neighbours).
5. Return the set of drained positions so that Phase 2 can skip them as write targets this same tick.

Sources are never drained.

### Phase 2 — spread

For every liquid voxel in the snapshot:

- **Source.** If air below, create flow voxel below at distance 0 (source stays in place — a source is a true infinite tap, never vacates). Else if `distance < budget` (always true for a source), spread sideways to each AIR neighbour as flow at distance 1.
- **Flow at distance `d`.** If air below: create flow below at distance `d`, and vacate self UNLESS same-type liquid is above (column rule — prevents flicker on a falling column). Else if `d < budget`, spread sideways to each AIR neighbour as flow at distance `d + 1`.

Budgets: **water = 4 hops, lava = 2 hops**. Falls never consume budget.

Writes go through `world.setBlockFlow` (for flow) or `world.setBlock` (for AIR), which keep `fluidMeta` and chunk dirtiness in sync. Writes are buffered and committed after the snapshot is processed; the commit phase dedupes concurrent writes with "liquid beats AIR; lower distance wins."

### Phase 3 — reaction

Scan the snapshot + its 6-axis neighbours. For each lava voxel with ≥1 water neighbour: write lava → `OBSIDIAN`, write each touching water → `AIR`. Both via `world.setBlock` (clears `fluidMeta`). Single pass; reactions don't chain.

### Cost bound

Per-tick work is `O(active connected liquid volume)`, which equals the frontier perimeter plus — during an active drain cascade — the orphaned component traversed by BFS. Stable pools decay to perimeter 0 and cost nothing. Undisturbed world-gen ocean has no `fluidMeta` entries and no frontier, so cost is zero. A lava block dropped on flat ground creates at most ~13 voxels of total spread.

## Interaction with other systems

- **Mining a flow voxel:** instant delete. If the mined cell was a feeder for cells further from the source, the drain step peels them one ring per tick.
- **Mining a source:** instant delete. Downstream flow drains outside-in, one ring per 0.5 s tick. A 4-radius water puddle drains in ~4 ticks (~2 s).
- **Placement:** right-click places a liquid block from the hotbar — always as a **source** (`setBlock` clears any stale `fluidMeta` entry on the target cell). Placed in mid-air, it starts its falling column next tick. Placed on flat ground, it spreads up to its budget horizontally.
- **TNT:** `detonate` clears blocks via `setBlock(AIR)`. Adjacent liquids re-enter the frontier; sources fill the crater over subsequent ticks, flow refills only as far as its remaining budget allows.
- **Lighting:** every liquid write invokes `applyLightUpdate`. A flowing waterfall re-floods a small region of the lightmap ~2× per second — cheap.
- **Autosave:** liquids persist through the existing modified-chunk save path. `fluidMeta` rides alongside `blocks` in each chunk payload, encoded via `encodeFluidMeta` + deflate. Legacy saves (pre-this-feature) load with `fluidMeta === undefined`, correctly interpreted as "every liquid was a source."

## Code map

- `src/data/blocks.data.ts` — water + lava + obsidian rows; `WATER` / `LAVA` / `OBSIDIAN` id exports.
- `src/game/liquid-scheduler.ts` — three-phase tick (drain / spread / reaction), BFS-based orphan detector, commit + frontier decay.
- `src/game/liquid-scheduler.test.ts` — covers accumulator, fall, spread budget bounding, reaction, source-removal cascade, two-source redundancy, ocean-is-free, frontier decay.
- `src/engine/world/chunk.ts` — `liquidFrontier: Set<number>`, `fluidMeta: Map<number, number>`, plus `isFlow` / `getFlowDistance` / `setFluidMeta` / `clearFluidMeta` accessors.
- `src/engine/world/world.ts` — `setBlock` (public, clears `fluidMeta` — any write-through-this-API produces a source), `setBlockFlow` (scheduler-only, writes flow with distance), `markLiquidFrontier` called on every write's 7-cell neighbourhood.
- `src/engine/world/mesher.ts` — `buildLiquidMesh`, emission rule, lower-id-wins boundary (unchanged by this feature — source/flow look identical).
- `src/engine/world/generation.ts` — sea-level water fill (columns below `SEA_LEVEL` get water from `h+1` to `SEA_LEVEL`); writes straight to `chunk.blocks`, so generated ocean is source-by-default (no `fluidMeta` entries).
- `src/engine/render/renderer.ts` — liquid material + mount path.
- `src/persistence/codec.ts` — `encodeFluidMeta` / `decodeFluidMeta` (varint count + pairs, deflate+base64).
- `src/persistence/localStorage.ts` — per-chunk payload is now JSON `{ blocks, fluidMeta? }`; `parseChunkPayload` falls back to the legacy bare-blob format on JSON parse failure.
