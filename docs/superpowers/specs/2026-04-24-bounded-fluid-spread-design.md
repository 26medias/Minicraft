# Bounded fluid spread

## Problem

Today, every liquid voxel tries to fall and spread to four horizontal neighbours every 0.5s tick. There is no notion of a "source" — every voxel is equal. The frontier-decay optimisation removes interior voxels of a stable pool from the active set, but the *perimeter* of an unbounded spill keeps growing forever. Drop a lava block on a flat plain and it fans out indefinitely, eating CPU as the perimeter grows.

The kid needs to be able to pour water or lava as a creative toy without watching the framerate die. We want bounded spread with a Minecraft-like feel: pours out, stops, drains back when the source is removed.

## Goals

- Liquid placed in the world spreads to a small, bounded volume.
- Removing a source drains the downstream flow visibly over a short time.
- Water touching lava produces obsidian, consuming the water — a visible "reaction" the kid can play with.
- No new per-frame cost for stable pools or for the world-gen ocean.
- No rendering or mesher changes — every liquid voxel still looks like a full block.

## Non-goals

- Partial-fill levels or sloped fluid surfaces.
- Bucket pickup or fluid-as-item.
- Two adjacent water sources creating infinite water (Minecraft's source-merging rule).
- Cobblestone-from-flowing-lava-meets-water and stone-from-lava-flowing-into-water (the two "softer" Minecraft reactions). Single reaction rule only: contact → obsidian.
- Pressure, current, entity displacement.
- Fluid animation (scrolling UVs, animated textures).

## Model

Two kinds of liquid voxels, distinguished by per-voxel state:

- **Source.** Permanent. Created by player placement and by world-gen (the ocean fills with sources). Spreads horizontally up to its budget and falls vertically with no limit. Only removed by player mining.
- **Flow.** Created by spread or fall. Carries an integer `distance` = number of *horizontal* hops from its nearest source. Falls do **not** increment distance. A flow voxel exists only as long as it has a "feeder" each tick (defined below).

### Spread budgets

- Water: 4 horizontal hops from source.
- Lava: 2 horizontal hops from source.

A water source on a flat plain produces a roughly 9-wide diamond / square (≤ ~80 voxels). A lava source produces a 5-wide diamond / square (≤ ~13 voxels).

### Vertical falls are free

A source or flow voxel with `AIR` directly below creates a same-type flow voxel below at the same `distance`. Falls do not count against the spread budget. A waterfall off a 20-block cliff still pools at the bottom with the full 4-hop horizontal radius.

### Reaction rule

After spread commits, scan touched cells and their 6-axis neighbours. Anywhere water and lava are adjacent (any combination of source / flow):

- The lava voxel → **obsidian** (a regular solid block; the source/flow distinction is discarded).
- The water voxel → **AIR**.

Single pass per tick — reactions don't chain. If multiple water voxels touch one lava, the lava becomes obsidian once and all touching waters become air.

### Drain rule (cascade when source removed)

Each tick, for each flow voxel in the active frontier, check for a valid feeder:

- Adjacent same-type **source**, OR
- Same-type liquid directly **above** (column rule for falling waterfalls), OR
- Adjacent same-type **flow** with `distance < this.distance` (downhill from source).

If no valid feeder, the voxel is queued for removal next tick. On removal it becomes `AIR` and its neighbours are added to the frontier so the cascade propagates outward by one ring per tick.

Sources are never drained — only player mining removes a source.

## Data model

### Per-chunk sparse map

Each `Chunk` gains a single new field:

```ts
fluidMeta: Map<number, number>  // local voxel index → packed meta byte
```

Packed byte layout (only flow voxels have entries; sources have none):

| Bit  | Meaning                                  |
|------|------------------------------------------|
| 7    | always `1` — marker so the raw byte is non-zero and self-identifying |
| 4–6  | reserved (write 0)                       |
| 0–3  | `distance` (0–15)                        |

**The default rule is the storage win.** Any liquid voxel with **no entry** in `fluidMeta` is treated as a **source**. So:

- World-gen ocean = millions of source voxels with **zero** entries.
- Player-placed sources = no entry.
- The map only ever holds **flow** voxels, bounded by the spread radii.

A 4-radius water puddle stores at most ~80 entries; a 2-radius lava puddle at most ~13. Across a loaded world this is negligible.

### Persistence

The modified-chunk save path serialises the map alongside `blocks`. New optional field on the on-disk chunk schema:

```ts
fluidMeta?: Array<[index, packedByte]>  // serialised Map entries
```

Older saves with no `fluidMeta` field load as "all liquid is source" — the correct interpretation of legacy worlds (any liquid in an old save was either world-gen ocean or player-placed, both source-equivalent under the old rules). **No migration needed.**

### Frontier

The existing `liquidFrontier: Set<number>` per chunk continues to track voxels whose state might change next tick. It is now seeded by:

1. Spread events (existing).
2. Source-removal events (new: when a source is mined, neighbouring flow joins the frontier so the cascade can start).
3. Reaction events (touched cells re-enter the frontier).

The decay rule extends: a flow voxel still in the frontier with no valid feeder is *not* removed from the frontier — it is queued for drain on the next pass.

## Algorithm

The scheduler still ticks at 2 Hz (every 0.5 s). Each tick has three phases.

### Phase 1 — spread (modified)

For every voxel in the snapshot of all chunks' liquid frontiers:

```text
let meta      = chunk.fluidMeta.get(idx)            // undefined → source (sources never have entries)
let isSource  = meta === undefined
let distance  = isSource ? 0 : (meta & 0x0F)
let budget    = id === WATER ? 4 : 2

// Fall: vertical, free of budget
if (below === AIR) {
    write_flow_below(distance)
    if (!isSource) write_air_here()                 // sources stay in place
    continue
}

// Sideways: only if budget remains
if (distance < budget) {
    for each horizontal neighbour that is AIR:
        write_flow_neighbour(distance + 1)
}
```

**Key change vs. today.** Sources never vacate when they fall — only flow does. A source with air below creates a flow voxel below (same `distance`, i.e. 0 if the source itself was distance 0) and *stays in place*. This makes a source a true infinite tap.

The today-code "stable stack guard" (don't fall if same-type liquid is above) becomes implicit in the new model: a flow voxel below a source is naturally fed every tick, so the column self-stabilises. The explicit guard is removed.

### Phase 2 — reaction (new)

After Phase 1 commits, scan the union of touched cells and their 6-axis neighbours. For each lava voxel that has at least one water voxel in its 6-axis neighbourhood:

- Write the lava voxel → `OBSIDIAN`. Delete its `fluidMeta` entry if any.
- For every water voxel adjacent to it, write → `AIR`. Delete its `fluidMeta` entry if any.

Both writes go through `world.setBlock`, which dirties chunks and triggers light updates. Reactions don't chain — an obsidian write doesn't trigger anything new. If multiple water voxels touch a single lava voxel, the lava becomes obsidian once and all touching waters become air. Adjacencies between two same-type liquids (water-water, lava-lava) are not reactions and do nothing.

### Phase 3 — drain (new)

For each flow voxel in every chunk's frontier:

```text
let valid_feeder =
       (above is same-type liquid)                       // column rule
    || (any horizontal neighbour is same-type source)    // adjacent to source
    || (any horizontal neighbour is same-type flow with lower distance)

if (!valid_feeder) queue_for_removal(idx)
```

The queued removals are committed at the *start* of the next tick (so the visible drain rate is one ring per 0.5 s). Each removal:

- Writes `AIR` to the voxel.
- Deletes the entry from `fluidMeta`.
- Adds same-type liquid neighbours to the frontier so the cascade can propagate outward.

A 4-deep falling column feeding a 4-radius pool drains in ~8 ticks (≈ 4 s) after the source is mined.

### Cost bound

Per-tick work is `O(active frontier)`, which equals the perimeter of the actively-changing puddle plus the currently-draining flow front. A stable pool has perimeter O(0) thanks to existing frontier decay. The world-gen ocean has zero `fluidMeta` entries and zero frontier work. A lava block dropped on flat ground produces at most ~13 voxels of total spread, period.

## Edge cases

| Situation | Behaviour |
|-----------|-----------|
| Player places liquid into existing flow | Replace flow with source (delete from `fluidMeta`). New tap, immediately starts feeding outward. |
| Player places liquid into existing source | No-op. |
| Player places water directly onto lava (or vice versa) | Reaction step fires the same tick — no spread happens first. |
| Player places liquid mid-air on a tall cliff | Source. Source with air below creates flow below at distance 0 each tick; column extends one voxel per tick downward until it hits a floor; bottom flow then spreads horizontally up to budget. |
| Water source mined while feeding a long flow | Cascade drains one ring per tick. Visible "water flows back" effect. |
| Two sources feeding the same puddle | Removing one doesn't drain the puddle — flow voxels still find a feeder via the other source. |
| World-gen ocean voxel mined | Hole left; adjacent ocean sources spread into it next tick. No cascade, no `fluidMeta` entries created (the voxels filling the hole are still sources). Same as today. |
| Two adjacent water sources | No special behaviour. Minecraft's "infinite water" rule is **not** implemented; placed sources are already infinite-feeder for their puddle. |
| Falling column passes through air pocket then lands on ledge | Each fallen voxel is a flow at distance 0; the bottom voxel spreads horizontally up to budget. If the column passes through and continues falling on the other side, that's the same behaviour — distance 0 flow keeps falling. |
| Source surrounded by walls | Tries to spread, finds no air neighbours, stays put. Frontier decay drops it from the active set. Zero ongoing cost. |

## Catalog change: obsidian block

Texture exists at `src/assets/blocks/obsidian.png`; no block row in `src/data/blocks.data.ts`. Add a row:

- `name: 'obsidian'`, `label: 'Obsidian'`
- `solid: true`, `transparent: false`
- `hardness`: matches the highest-hardness existing kid-mode block in the catalog (read `src/data/blocks.data.ts` at implementation time and use that exact value, so obsidian sits at the top of the existing hardness scale rather than introducing a new tier).
- `kidMode: true` (kid should be able to mine it once placed by the reaction)
- `lightLevel: 0`
- `textures: { kind: 'uniform', all: 'obsidian' }`

No new behaviours, no special interactions — once placed it's a regular solid block.

## Documentation update

`docs/liquids.md` needs editing:

- The "Philosophy" section currently lists "Water-on-lava → obsidian / stone conversion" as an explicit non-goal. Remove that line. Keep the other non-goals (partial fill, bucket, animated textures, swimming physics).
- Replace the "Flow scheduler" section with the three-phase algorithm above.
- Add a "Source vs flow" section explaining the model and the `fluidMeta` storage.
- Update the "Interaction with other systems" table: liquid mining now potentially triggers a cascade drain rather than just re-flooding.
- Update the "Code map" to reference the new reaction and drain phases.

## Code map (target end state)

- `src/data/blocks.data.ts` — water row unchanged, lava row unchanged, **new obsidian row**.
- `src/game/liquid-scheduler.ts` — three-phase tick: `applySpreadStep`, `applyReactionStep`, `applyDrainStep`. Source-vs-flow logic. Reads from `chunk.fluidMeta`; writes via a helper that sets the packed byte.
- `src/game/liquid-scheduler.test.ts` — extends with: budget-bounded spread, source removal cascade, reaction rule, falling column does not consume budget, two-source redundancy.
- `src/engine/world/chunk.ts` — `fluidMeta: Map<number, number>` field; serialisation.
- `src/engine/world/world.ts` — `setBlock` updates `fluidMeta` when writing/removing liquid (player-placed = source = delete entry; scheduler writes are explicit).
- `src/engine/world/generation.ts` — sea-level water fill creates **sources** (no `fluidMeta` entries — so this file is unchanged in practice; the default rule covers it).
- `src/persistence/*` — chunk save/load reads/writes the optional `fluidMeta` field.
- `docs/liquids.md` — updated per above.

## Test plan

Unit tests in `src/game/liquid-scheduler.test.ts`:

1. Single placed water source on flat ground spreads to a 9-wide diamond (≤ ~80 voxels) and stops.
2. Single placed lava source on flat ground spreads to a 5-wide diamond and stops.
3. Mining a source on flat ground drains the puddle one ring per tick.
4. Two sources feeding one puddle: mining one leaves the puddle intact; mining both drains it.
5. Water source on a tall cliff: column extends one voxel per tick downward; bottom flow spreads up to budget.
6. Falling column does not consume budget — pool radius at the bottom is the full 4 (water) regardless of fall depth.
7. Water adjacent to lava: lava becomes obsidian, water becomes air, both within one tick.
8. Player places water onto an existing lava voxel: reaction fires immediately, no spread first.
9. World-gen ocean tile mined: hole fills next tick, no `fluidMeta` entries created (regression test for the default-source rule).
10. Stable enclosed source: no per-tick work after frontier decay.
11. Persistence round-trip: save a chunk with mixed source/flow water, load it, scheduler produces identical behaviour to before save.

Manual verification:

- Drop a lava block on flat dirt → confirm bounded spread, frame rate stable.
- Drop a water block adjacent to a placed lava block → confirm obsidian appears.
- Build a 10-block-tall waterfall → confirm column flows down, pools at bottom.
- Mine the source of the waterfall → confirm visible drain over a few seconds.
- Save & reload a world with active flow → confirm flow shape is preserved and drain logic still works after load.
