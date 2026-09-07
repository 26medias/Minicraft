# Sponge — design

**Date:** 2026-09-06
**Status:** draft, pending gate 1

## Goal

Give Noah a way to empty pools of water and lava. A dry sponge placed next to liquid
soaks up every connected water or lava voxel within reach and becomes a wet sponge.
The wet sponge does nothing further. Mining it back leaves the hole dry, so the loop
is: place sponge, watch it soak, mine it, place a fresh one.

## Non-goals

- No drying, no furnace, no capacity counter, no timers.
- No new block rows. `sponge` (id 315) and `wet_sponge` (id 363) already exist in the
  generated catalog, both in the `earth` inventory group, both hardness 0.3, both with
  Mojang textures in the atlas.
- No save-format, codec, or API change. A wet sponge persists as an ordinary block id.
- No item drops or inventory state. Mining any sponge just removes it.

## Behaviour

### Trigger

Absorption is evaluated inside `LiquidScheduler.tick`, in the reaction phase, before
the existing lava/water → obsidian check. For every liquid cell in the tick snapshot
and each of its 6-axis neighbours, if the cell being examined is a **dry sponge**
(id `SPONGE`), that sponge absorbs.

This single hook covers both cases:

- **Sponge placed next to liquid.** `World.setBlock` marks the placed cell and its
  6 neighbours in the liquid frontier, so adjacent liquid is in the next snapshot and
  the sponge fires on the next tick (≤ 0.5 s later).
- **Liquid reaches an existing dry sponge.** Flow written by `setBlockFlow` and sources
  placed by the player both mark the frontier the same way.

A sponge that is not adjacent to any liquid never fires. A wet sponge never fires.

### Absorb

From the sponge cell, breadth-first search through cells that are `WATER` or `LAVA`
(either type, mixed freely), 6-axis steps, stopping at a taxicab distance of
`SPONGE_RADIUS = 7` from the sponge. The search does not pass through non-liquid
cells. Every liquid cell reached is written to `AIR` via `world.setBlock`, which clears
its flow meta and re-seeds the frontier for its neighbours. Then the sponge cell is
written to `WET_SPONGE`.

There is no count cap. A taxicab ball of radius 7 has 1,695 cells, so the worst case
is bounded and cheap. Minecraft's cap of 65 exists for a survival economy the game
does not have; for emptying a pool, bigger is better.

Each absorbed cell calls `onBlockChanged` (light update: lava stops glowing, water
stops filtering) and its chunk is reported through `onChunkDirty`, exactly as
obsidian-reaction writes are today. `changed` is set so the loop knows to autosave.

If two dry sponges both touch the same liquid in one tick, the first one visited
absorbs and becomes wet; the second sees AIR when its turn comes and stays dry unless
liquid still reaches it. The order is the snapshot order, which is deterministic for a
given world but not something the player can perceive. Both outcomes are acceptable.

### Ordering inside the reaction phase

1. Sponge absorption (this feature). Writes happen immediately.
2. Existing lava/water contact scan, unchanged. It re-reads the world, so liquid that
   was just absorbed is no longer there to react.

### After absorption

Liquid beyond the radius is untouched. Sources outside the radius spread back into the
hole over the following ticks, one hop per tick, the same as after TNT. The wet sponge
does not stop them. Placing another dry sponge starts over.

Mining the wet sponge (left click, hardness 0.3) writes AIR. Nothing refills unless a
source is within its spread budget, which is the existing liquid behaviour.

Shift-to-replace on a wet sponge with a dry sponge is allowed by the existing
`canReplace` rule (solid, hardness > 0, different id) and results in a fresh dry sponge
that fires on the next tick if liquid is adjacent.

## Code changes

- `src/data/blocks.data.ts`: export `SPONGE` and `WET_SPONGE` ids, resolved by name
  through `BLOCK_BY_NAME` so the generated catalog stays the source of truth.
- `src/game/liquid-scheduler.ts`: new private `applySpongeStep(snapshot)` called at the
  top of `applyReactionStep`; `SPONGE_RADIUS` constant; the BFS described above.
- `src/game/liquid-scheduler.test.ts`: tests below.
- `docs/liquids.md`: new "Sponge" section under "Interaction with other systems".
- `README.md`: one bullet in the feature list.

## Tests

All in `liquid-scheduler.test.ts` using the existing `freshWorld()` helper (chunk
16,16, coords 256..271). Coordinates are chosen so radius-7 searches stay inside the
cleared chunk or hit AIR. Every test puts a stone floor at y=29 under the cells
involved so nothing falls, unless the test says otherwise.

1. **Dry sponge next to a water source absorbs it and becomes wet.** Place water at
   (260,30,260) on a stone floor, sponge at (261,30,260). One tick. Water cell is AIR,
   sponge cell is `WET_SPONGE`.
2. **Radius is respected through connected liquid.** Stone floor at y=29 along x
   256..271, z=260. Water sources at x=257..268, y=30, z=260 (12 in a row). Sponge at
   (256,30,260). One tick. x=257..263 (distance 1..7) are AIR; x=264 (distance 8) is
   still WATER. Assert both the boundary cell and one cell inside.
3. **Search does not jump across non-liquid gaps.** Water at (260,30,260), stone at
   (261,30,260), water at (262,30,260), sponge at (259,30,260). One tick. (260) is AIR,
   (262) is still WATER.
4. **Lava is absorbed too, and mixed liquid is one component.** Lava at (260,30,260),
   water at (261,30,260), sponge at (262,30,260). One tick. Both cells AIR, sponge wet,
   no OBSIDIAN anywhere in the three cells.
5. **Wet sponge does nothing.** `WET_SPONGE` at (261,30,260), water source at
   (260,30,260) on stone. One tick. Water still present (it may have spread; assert the
   source cell is still WATER), sponge still `WET_SPONGE`.
6. **Sponge fires when liquid arrives later.** Sponge at (263,30,260) on stone, water
   source placed at (260,30,260) on stone floor x 258..266. Tick until the cell
   (262,30,260) is WATER (at most 4 ticks), then one more tick: (260..262) are AIR and
   sponge is wet. This test fails if absorption is only triggered on placement.
7. **Light and dirty callbacks fire for absorbed lava.** Lava at (260,30,260), sponge at
   (261,30,260). Scheduler constructed with spy callbacks. After one tick,
   `onBlockChanged` was called with (260,30,260) and `onChunkDirty` with (16,16).

Each test must be run red first. For test 2 the plausible wrong implementation is an
off-by-one on the radius; the assertion on x=264 catches radius 8 and the assertion on
x=263 catches radius 6. For test 6, an implementation that checks only at placement
time cannot pass.

## Manual check (Task 5 of the plan)

At `localhost:5173` on a local-only world: dig a 3×3×2 pool, fill it with water,
place a sponge on the rim, watch it empty and the sponge turn wet, mine the sponge,
confirm the pool stays dry. Repeat with lava and confirm the glow disappears. Place a
sponge in the ocean and confirm a bubble appears and refills after a few seconds.
