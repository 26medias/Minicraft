# Sponge — design

**Date:** 2026-09-06
**Status:** revised after gate 1

## Goal

Give Noah a way to empty pools of water and lava. A dry sponge placed next to liquid
soaks up every connected water or lava voxel within reach and becomes a wet sponge.
The wet sponge does nothing further. Mining it back leaves the hole dry, so the loop
is: place sponge, watch it soak, mine it, place a fresh one.

## Non-goals

- No drying, no furnace, no capacity counter, no timers.
- No new block rows. `sponge` (id 315) and `wet_sponge` (id 363) already exist in the
  generated catalog, both in the `earth` inventory group, both hardness 0.3, both with
  Mojang textures in the atlas. The two textures differ only subtly (yellow vs olive
  with dark pits). That is accepted: if Noah cannot tell, placing another sponge or
  shift-replacing the old one both work, and that is the intended fallback.
- No save-format, codec, or API change. A wet sponge persists as an ordinary block id.
- No item drops or inventory state. Mining any sponge just removes it.

## Behaviour

### Trigger

Absorption is a new **first phase** of `LiquidScheduler.tick`, run on the tick's
pre-mutation snapshot before drain, spread, and the obsidian reaction. For every cell
in the snapshot and each of its 6-axis neighbours, if the cell being examined is a
**dry sponge** (id `SPONGE`), that sponge attempts to absorb.

Running first matters: drain would otherwise peel the very flow cell the sponge is
touching before the sponge is examined (verified at gate 1), and the kid would see the
sponge "do nothing" on a draining puddle.

The frontier is the trigger surface, so all of these fire on the next tick (≤ 0.5 s):

- **Sponge placed next to liquid.** `World.setBlock` marks the placed cell and its
  6 neighbours in the liquid frontier (only cells that are liquid are recorded).
- **Sponge placed into a liquid cell.** `placeBlock` refuses only solid targets, so a
  sponge can overwrite a water or lava cell (this is how a sponge goes into the ocean).
  The overwritten liquid is simply gone; the 6 liquid neighbours are marked.
- **Liquid reaches an existing dry sponge.** Flow written by `setBlockFlow` is marked
  the same way. It fires one tick after arrival, because the snapshot is taken before
  the spread that writes it.
- **Chunk load.** `GameLoop.flushDirtyChunks` seeds a freshly mounted chunk's liquids
  into the frontier, so a dry sponge saved beside water fires on the first tick after
  its chunk mounts, possibly off-screen. Desired.

**Frontier decay must not starve the trigger.** Today `decayFrontier` drops any liquid
cell with no AIR among its ±x, ±z, −y neighbours. A water cell in a 1-wide trench that
ends at a sponge has no AIR neighbour and would be dropped the same tick it arrived,
before it ever appears in a snapshot (verified at gate 1). New rule: a liquid cell is
kept in the frontier if any of its **6** neighbours is a dry `SPONGE` (6, not 5: a
sponge resting on top of water is a legitimate trigger).

A wet sponge never fires. A dry sponge with no 6-axis liquid neighbour never fires, and
diagonal-only liquid does not count.

### Absorb

From the sponge cell, breadth-first search through liquid cells (`isLiquid`, so water
and lava mix freely in one component), 6-axis steps, following at most
`SPONGE_RADIUS = 7` **BFS hops** from the sponge. The metric is path length through
liquid, not straight-line taxicab distance: a U-shaped channel whose far arm is 5
blocks away as the crow flies but 9 hops around the bend is only absorbed up to hop 7.
The search never passes through a non-liquid cell.

Every liquid cell reached is written to `AIR` via `world.setBlock`, which clears its
flow meta and re-seeds the frontier for its neighbours. **If at least one cell was
absorbed**, the sponge cell is then written to `WET_SPONGE`. A sponge that finds no
liquid (stale frontier entry) stays dry and costs nothing.

There is no count cap. A 3-D taxicab ball of radius 7 is 575 cells, which bounds the
BFS; in practice a pool is far smaller. The real cost is not the BFS but the per-cell
light update (below).

### Notifications

Each absorbed cell and the sponge cell itself call `onBlockChanged` (light update:
lava stops glowing, water stops filtering, the sponge's own face changes) and are
reported through `onChunkDirty`. `changed` is set so `tick` returns true and the loop
autosaves.

**Chunk-edge remesh.** Scheduler writes today dirty only the written chunk (plus
whatever the light flood happens to touch). A liquid face in the −x or −z neighbour
chunk that now looks into an absorbed hole is not remeshed, leaving a see-through wall
until that chunk remeshes for another reason. Drain and the obsidian reaction have this
defect already; radius-7 absorption makes it likely. Fix it once in the scheduler: a
private `reportDirty(x, z)` that calls `onChunkDirty` for the cell's chunk and, when the
cell sits at local x or z of 0 or 15, for the adjacent chunk on that side too. All four
scheduler write sites (sponge, drain, spread commit, reaction) use it.

**Cost.** Measured at gate 1 under vitest (cold JIT): a full 574-cell water absorb is
roughly 90 ms of light updates, a lava one about 200 ms. That is a single hitch of a
few frames when the sponge fires, once per sponge. Accepted for a toy; if it ever
bothers, batch the light flood, do not cap the radius.

### Ordering inside the tick

1. Sponge absorption (this feature), on the pre-mutation snapshot. Writes happen
   immediately.
2. Drain, spread, obsidian reaction, decay: unchanged except for the decay rule above.
   Spread re-reads the world, so it does not re-spread from cells that were just
   absorbed, and the obsidian scan finds no lava/water pairs where the sponge ate them.

Two dry sponges touching the same liquid in one tick: the first visited absorbs and
turns wet, the second finds AIR and stays dry. Snapshot order decides; not perceptible.

### After absorption

Liquid beyond the radius is untouched. Sources outside the radius spread back in at one
hop per tick, but water spreads only 4 hops sideways and lava 2, and the hole is up to 7
hops wide, so **the middle of a wide pool stays empty**. Under the ocean surface the
hole refills from the sources above it, which fall without budget; a sponge at the
surface leaves a shallow crater around the wet sponge. This is the intended toy: Noah
can make a dry room in the sea.

A player standing in the absorbed volume leaves swim mode and drops to the floor.
There is no fall damage in this game. Nobody should "fix" this.

Mining the wet sponge (left click, hardness 0.3) writes AIR. Shift-to-replace a wet
sponge with a dry one is allowed by `canReplace` (solid, hardness > 0, different id)
and gives a fresh sponge that fires on the next tick if liquid is adjacent.

The BFS reads through `world.getBlock`, which generates any missing chunk it touches.
The existing reaction scan already does this at radius 1; radius 7 can touch up to four
neighbour chunks. Accepted; the world is finite and pre-generated in play.

## Code changes

- `src/data/blocks.data.ts`: export `SPONGE` and `WET_SPONGE` ids, resolved by name
  through `BLOCK_BY_NAME` so the generated catalog stays the source of truth.
- `src/game/liquid-scheduler.ts`: `SPONGE_RADIUS`; private `applySpongeStep(snapshot)`
  called first in `tick`; the decay exception; `reportDirty(x, z)` used by every write
  site.
- `src/game/liquid-scheduler.test.ts`: tests below.
- `docs/liquids.md`: new "Sponge" section, the new tick phase, the decay exception,
  and `reportDirty`.
- `README.md`: one bullet, e.g. "Sponge soaks up water and lava within 7 blocks and
  turns into a wet sponge; place a fresh one to soak again. The middle of a big pool
  stays dry."

## Tests

All in `liquid-scheduler.test.ts`. `freshWorld()` clears chunk (16,16), coords
256..271. Tests that search near x=256 or x=271 must also clear the neighbouring chunk
(a `freshWorld` variant that clears (15,16) and (17,16) too), because `getBlock`
generates terrain there and seed 1 happens to be solid at (255,30,260). Every test
puts a stone floor at y=29 under every cell involved, across z=259..261 where a row is
used, so nothing falls and the geometry matches the prose. Nothing here touches
x=256 or x=271 unless the test says so.

Because absorption now runs before spread, a source just outside the radius refills the
outermost absorbed cell **as flow** in the same tick. Tests therefore assert the
boundary with flow meta, not just block id.

1. **Dry sponge absorbs an adjacent source and turns wet; tick reports change.**
   Water at (260,30,260), sponge at (261,30,260). `expect(s.tick(0.6)).toBe(true)`.
   (260) is AIR, (261) is `WET_SPONGE`.
2. **Radius 7 by hops, straight line.** Floor x 258..271, z 259..261. Water sources at
   x=260..270, y=30, z=260. Sponge at (259,30,260). One tick. x=260..265 are AIR (the
   hop-7 cell x=266 may have been refilled by spread from 267). x=267 is WATER and
   `!chunk.isFlow` (still a source). Radius 6 leaves 265 WATER (red); radius 8 turns 267
   into flow (red).
3. **Metric is hops, not taxicab.** U-channel on floor: water sources along
   x=262..268 at z=260, down z=261..263 at x=268, back along x=268..262 at z=263 (walls
   of stone around the channel so spread cannot short-cut; floor under all of it).
   Sponge at (261,30,260). One tick. (262..267, z=260) AIR (268, hop 7, may be
   refilled as flow from (268,261)); the far arm cell (262,30,263) is 7 + 3 + 6 = 16
   hops away but taxicab 4, so it must still be WATER and a source. A taxicab
   implementation absorbs it (red).
4. **Search does not jump across non-liquid gaps.** Water at (260,30,260), stone at
   (261,30,260), water at (262,30,260), sponge at (259,30,260). One tick. (260) AIR,
   (262) WATER.
5. **Lava and water form one component and no obsidian forms.** Lava at (260,30,260),
   water at (261,30,260), sponge at (262,30,260). One tick. Both AIR, sponge wet, no
   OBSIDIAN in the three cells or their z-neighbours. Verified at gate 1 to go red when
   the sponge step runs after the reaction.
6. **Wet sponge does nothing.** `WET_SPONGE` at (261,30,260), water at (260,30,260).
   One tick. (260) still WATER, (261) still `WET_SPONGE`.
7. **Sponge fires when liquid arrives later (open floor).** Sponge at (263,30,260),
   source at (260,30,260), floor x 258..266, z 259..261. Tick until the sponge is wet,
   at most 5 ticks; then (260..262, z=260) are AIR. A placement-only trigger cannot
   pass.
8. **Sponge fires at the end of a 1-wide trench (decay exception).** Same as 7 but
   stone walls at z=259 and z=261 for x 259..263, so the water cell at 262 has no AIR
   neighbour. Tick up to 6 times; sponge must be wet. Without the decay exception the
   sponge stays dry forever (verified at gate 1).
9. **Sponge placed against draining flow still absorbs.** Source at (260,30,260), tick
   4 times so flow reaches 264. Remove the source with `setBlock(AIR)`. Place sponge at
   (265,30,260). One tick. Sponge is wet and (264) is AIR. With absorption after drain
   the sponge stays dry (verified at gate 1).
10. **Zero absorb keeps the sponge dry.** Sponge at (261,30,260), nothing liquid
    anywhere; add `indexOf(260,30,260)` of chunk (16,16) to `liquidFrontier` by hand.
    One tick. Sponge still `SPONGE`.
11. **Light callback fires for the absorbed lava cell.** Lava at (260,30,260), sponge at
    (261,30,260), `onBlockChanged` spy. After one tick the spy was called with
    (260,30,260) and with (261,30,260). Verified at gate 1 that without the sponge step
    the lava cell is never reported. (No `onChunkDirty` assertion here: spread already
    dirties (16,16), so it cannot go red.)
12. **Sponge on a chunk edge dirties the neighbour chunk.** Clear chunks (15,16) and
    (16,16). Floor under x 256..258. Sponge at (256,30,260) (local x 0), water at
    (257,30,260). `onChunkDirty` spy. One tick. Spy called with (15,16). Nothing else
    writes into chunk 15 (the BFS finds AIR at x=255), so this can only come from
    `reportDirty`.

Each test is run red first. Test 2 must be shown red at radius 6 and radius 8; test 3
red with a taxicab metric; test 8 red without the decay exception; test 9 red with the
sponge step after drain.

## Manual check (last task of the plan)

At `localhost:5173` on a local-only world, never production:

1. Dig a 3×3×2 pool, fill it with water, place a sponge on the rim. Within half a
   second the pool is empty and the sponge is wet. Mine the sponge: the pool stays dry.
2. Same with lava: the glow disappears with the lava.
3. Swim down in the ocean and place a sponge underwater. A hole opens, then water falls
   in from above and closes it. Place one at the surface: a shallow crater stays around
   the wet sponge. Both are correct.
4. Fill a pool that spans a chunk boundary and sponge it from one side; look at the far
   wall from inside the hole. No see-through wall.
