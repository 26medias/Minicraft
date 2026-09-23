# Crafting toys: design

Date: 2026-09-23. Branch: `crafting-2`, from `main` at 78934b3. Status: draft, before gate 1. Process: a light Anvil.

## 1. Intent

Crafting shipped and is "really fun". The parent asked for more recipes, inspired by Minecraft, and new "toys". This batch adds 8 crafted-only toy blocks and splits the Craft tab into icon tabs. All the non-goals in CLAUDE.md still hold: no mobs, combat, health, progression or automation.

**Decisions taken with the parent:**
- **Toys:**
  - Slime Pad
  - Launch Pad
  - Climbing Scaffold
  - Fireworks
  - Tunnel TNT
  - Block Bomb
  - Flattening TNT
  - Lake TNT
- **The Craft tab gets icon tabs:** ⛏ Pickaxes, 💥 Boom, 🎈 Toys. Each tab holds at most 10 cards, nothing scrolls, and a green dot shows on a tab when something inside it can be crafted.

**Findings that shaped this** (from the brainstorm agents):
- Recipes for planks, glass or bricks would do nothing, because those blocks are already free. So every toy is a new **crafted-only block**, like Big TNT.
- The player has no horizontal momentum; only `vy` carries over between frames. So every movement toy works **straight up** only.

**Success criteria:**
1. Existing worlds and saves are unchanged. The old toys are untouched: pickaxes, TNT, Big TNT and Mega TNT keep their radius, fuse and rules.
2. Each toy works as described in §3, and each has a test that fails on its named wrong version.
3. No toy blast produces a frame over the 50 ms perf gate. This is checked headless, by the count of cells removed per frame against the Mega figure, plus a real-GPU run by the parent.
4. The Craft tab shows three icon tabs at 1280×720 with no scrolling. The headless smoke test covers this.

**Non-goals for this batch:**
- Builder wand and bridge builder, because held tools need a save change.
- Buckets.
- Sideways launchers and ice sliding.
- Speed path.
- Recipes for plain building blocks.

## 2. Common rules

- **Each toy is a new hand-written block** in `blocks.extra.data.ts`, with ids 1002 to 1009 in the order of §3. Never renumber them.
- **Crafted-only everywhere.** Each toy is added to `CRAFTED_ONLY`: placing it needs a count in every world, and the Blocks tab lists it only when the count is above 0. So it is counted, and a recipe output.
- **No save or API change.** Counts are already keyed by block name, and blocks with ids ≥ 1000 already round-trip. Deploy notes are the same as for Big TNT: the atlas goes up before the bundle, then a Cloudflare purge and a hard refresh.
- **What counts:**
  - Blocks a toy **removes** count as mined, through `removeBlocks` and `onBlocksRemoved`, exactly like TNT.
  - Blocks a toy **builds** are free and never touch counts: the dome's glass and the lake's water.
  - A toy that is used up is not counted: a firework, or a TNT variant's own cell.
- **Textures:**
  - Slime Pad uses the Mojang `slime_block`.
  - Scaffold uses `scaffolding_top`, `scaffolding_side` and `scaffolding_bottom`.
  - The others are derived when the atlas is built (grey then tinted), using the existing `DERIVED_TEXTURES` mechanism:
    - Launch Pad from slime, tinted red.
    - Tunnel, Flatten and Lake TNT from TNT, tinted green, cyan and blue.
    - Block Bomb from TNT, tinted white.
    - Fireworks from TNT, tinted magenta.
  - Each tint must be distinct by hue (≥ 20°) from its neighbours and from Big and Mega. The atlas test asserts this.

## 3. The toys

### 3.1 Slime Pad (`slime_pad`, 1002)

- **Behaviour.** When the player lands on its top face with `vy < -MIN_BOUNCE_VY`, `vy` becomes `-vy × 0.8` instead of 0.
  - Holding jump at the landing uses a factor of 0.9.
  - Holding Shift (sneak) lands with no bounce.
  - A landing slower than `MIN_BOUNCE_VY = 3` ends the bounce, so there is no jitter.
- **Data.** `pad: 'slime'` on the BlockDef.
- **Where it lives.** A pure function `padResponse(landingVy, pad, jump, sneak): number` in `src/game/pads.ts`. `Player.step` calls it where the grounded collision zeroes `vy`.
- **Recipe.** 4 moss_block + 2 clay → 2.
- **Sneak.** The game has no sneak key today. "Holding Shift" means the Shift key is down (`ShiftLeft` or `ShiftRight`), read by `main.ts` into `keys.sneak`. That is a new optional field on `Keys`, and Shift is already used as a modifier for replace.

### 3.2 Launch Pad (`launch_pad`, 1003)

- **Behaviour.** When the player stands on it (grounded, and the block under the feet is the pad), `vy = LAUNCH_VY`. That value is picked so the apex is about 25 blocks above the pad, given `GRAVITY`. The formula is pinned in a test.
- **Cooldown.** 0.5 s, so standing still does not re-launch every frame; he only re-launches after landing again.
- **Recipe.** 1 slime_pad + 4 redstone ore → 1.

### 3.3 Climbing Scaffold (`scaffold`, 1004)

- **New block kind:** `solid: false`, `liquid: 'none'`, `climbable: true`, drawn as a cutout the way leaves are.
- **Collision.** The player walks into it. Its cells do not block movement.
- **Climbing.** Swimming is unchanged. When the feet or eyes are in a climbable cell:
  - holding jump sets `vy = CLIMB_SPEED` (3 blocks/s);
  - otherwise `vy` is clamped to at least `-CLIMB_SPEED`, so he slides down slowly.
- **Aiming (raycast).** The raycast must hit a scaffold so he can mine it, place against it and replace it. So the raycast tests `isTargetable(id) = isSolid(id) || def.climbable`.
- **Placing.** Placing *into* a scaffold cell is refused, just like any occupied cell. `placeBlock` must treat climbable as occupied.
- **Meshing.** Faces are drawn like the cutout leaves path. A face between two scaffolds is culled.
- **Light.** `lightFilter: 0`, so sunlight passes through, like leaves.
- **Mining.** `hardness: 0.3`, counted when mined.
- **TNT and area mining.** `removeBlocks` currently skips non-solid cells. Scaffold must be removed too, so the rule becomes "solid, or climbable, and hardness > 0". The area glow follows the same rule, `removableCells`.
- **Liquids.** Water must not flow into a scaffold cell. The liquid scheduler treats it as solid for spreading.
- **Recipe.** 4 of any log → 6.

### 3.4 Fireworks (`fireworks`, 1005)

- **Behaviour.** Lit with E, fuse 1 s. When it goes off:
  - the block becomes AIR (not counted);
  - no block is ever removed;
  - a rocket particle rises 12 blocks in 1 s, then bursts into about 60 coloured sparkles.
- **Cap.** At most 8 bursts at once. Extra ones burst smaller (about 20 sparkles).
- **Chain.** A firework caught in a TNT blast is primed like TNT: the chain rule applies, and it fires with its own effect.
- **Data.** `tnt: { radius: 0, fuse: 1, shape: 'firework' }`.
- **Recipe.** 1 sand + 2 coal ore + 1 lapis ore → 3.

### 3.5 Tunnel TNT (`tunnel_tnt`, 1006)

- **Behaviour.** A 3×3 cross-section, 24 cells long, starting at the TNT's cell and running along the horizontal direction the player faced when he lit it (the yaw snapped to ±x or ±z).
- **Direction when chained.** When another blast primes it, the direction points away from that blast's origin, along its dominant horizontal axis.
- **Storage.** The direction is stored in the primed entry, like radius. Nothing is saved: primed state isn't saved today either.
- **Preview.** During the fuse, the area glow (`removableCells`) previews the tunnel.
- **Data.** `tnt: { radius: 0, fuse: 3, shape: 'tunnel' }`.
- **Recipe.** 2 TNT + 8 iron ore → 1.

### 3.6 Block Bomb (`block_bomb`, 1007)

- **Behaviour.** On detonation it writes glass into every **air** cell on a sphere shell of radius 5 around its cell (shell = cells with `4.5 < d ≤ 5.5`).
  - It never replaces a non-air cell, and never replaces liquid.
  - Its own cell becomes AIR (not counted).
- **Writes.** Through a batched `placeBlocks(cells, blockId, anchor)` in `GameLoop`. This mirrors `removeBlocks`: per-block light, with the anchor chunk in the edit lane and the others in the bulk lane.
- **Chain.** A block bomb in a TNT blast is primed and builds its dome.
- **Data.** `tnt: { radius: 5, fuse: 3, shape: 'dome' }`.
- **Recipe.** 2 TNT + 8 sand → 1.

### 3.7 Flattening TNT (`flatten_tnt`, 1008)

- **Behaviour.** It removes every removable cell in the cylinder `dx² + dz² ≤ 6²` for `y` from the TNT's own `y` up to `y + 12`, own cell included. That leaves a flat floor at the TNT's `y − 1`.
- **Perf.** Up to about 1,400 cells. That is under Mega's ~2,145, so one `removeBlocks` batch is fine; §6 checks it.
- **Recipe.** 2 Big TNT + 16 stone → 1.

### 3.8 Lake TNT (`lake_tnt`, 1009)

- **Behaviour.** It removes a radius-4 sphere, exactly like TNT's sphere at radius 4. It then writes water sources into the removed cells whose `y ≤ rimY`:
  - `rimY` is the lowest `y` among the solid blocks on the crater's outer ring (the cells at horizontal distance 5 from the centre, at the TNT's `y` and above), minus 1;
  - the result is clamped so the water is at most 4 deep.
- **Water.** It is free, and goes through `world.setBlock`, which wakes the liquids.
- **Recipe.** 2 TNT + 4 ice → 1.

## 4. Engine changes

**`BlockDef`** gains three optional fields:
- `pad?: 'slime' | 'launch'`
- `climbable?: true`
- `tnt.shape?: 'sphere' | 'tunnel' | 'flatten' | 'lake' | 'dome' | 'firework'` (default `'sphere'`)

**`detonate`** becomes a small dispatch on `shape`. Each shape is one pure function in `src/game/blast-shapes.ts`, returning `{ remove: Cell[]; build?: { cells: Cell[]; blockId } ; water?: Cell[]; effect?: 'firework' }`. The sphere's behaviour stays byte-identical, including chain-priming.

**`PrimedEntry`** gains `dir?: 'px' | 'nx' | 'pz' | 'nz'`.

**`GameLoop.placeBlocks(cells, blockId, anchor)`** is the build counterpart of `removeBlocks`. It writes only into cells that are currently AIR.

**Particles:** `ParticleSystem.spawnFirework(x, y, z, big: boolean)`.

**Player** (`player.ts`):
- the pad response goes in the grounded branch;
- the climb rule goes next to `feetInLiquid`;
- the collision test is `isSolid`, so the scaffold is non-solid and needs no change there.

**Mining, raycast and placement:** use `isTargetable` where they use `isSolid` today, and `isRemovable` covers the scaffold.

## 5. Craft tab: icon tabs

- **Tabs.** The Craft panel gets three icon buttons inside it: the Iron pickaxe icon for Pickaxes, the TNT face for Boom, and the slime face for Toys.
  - Pickaxes has 7 cards.
  - Boom has TNT, Big, Mega, Tunnel, Flatten, Lake, Block Bomb and Fireworks: 8 cards.
  - Toys has Slime, Launch and Scaffold: 3 cards.
- **Grouping is data.** The tab is a `tab: 'pickaxes' | 'boom' | 'toys'` field on each `Recipe`. The tab you last looked at is remembered for the session.
- **Green dot.** A tab shows a green dot when any recipe in it can be crafted now.
- **The Blocks tab** lists the owned toys in the BASICS row, as Big TNT does today.
- **Placing a crafted toy in the hotbar.** It uses the same slot rule as crafted TNT: the slot holding it, else an empty slot, else a greyed slot, else the selected slot.

## 6. Testing

Every test names the wrong version it catches.

**Pure tests:**
- **`padResponse`:**
  - bounces at 0.8;
  - 0.9 with jump held;
  - no bounce with sneak;
  - no bounce below `MIN_BOUNCE_VY`.
- **Launch Pad:**
  - the apex height from `LAUNCH_VY` is 25 ± 1;
  - the cooldown stops a re-launch while standing.
- **Each blast shape:** exact cell counts and a set of pinned cells.
  - Tunnel: for each of the 4 directions, 3×3×24, and the chained direction.
  - Flatten: the cylinder, with nothing below `y`.
  - Lake: water only below the rim, and never deeper than 4.
  - Dome: shell cells only, and air cells only.
  - Fireworks: removes nothing.
- **Sphere regression:** plain, Big and Mega TNT cells are identical to today's `detonate()` output (a frozen copy in the test).

**Loop tests** (`makeLoop`):
- **Scaffold:**
  - he walks into a scaffold column and climbs to the top holding jump;
  - he slides down slowly without holding jump;
  - the raycast targets it;
  - mining it counts;
  - placing into it is refused;
  - TNT removes it;
  - water does not enter it.
- **Slime Pad:** a drop from 10 blocks onto a pad goes up again, and settles after N bounces.
- **Launch Pad:** standing on it rises to about 25.
- **Block Bomb:** in a partly built area, only air cells become glass, and counts are unchanged.
- **Lake TNT:** after the liquids settle, no water is above `rimY`.
- **Fireworks:** block → AIR, count unchanged, no other block changed.
- **Counts:** Tunnel, Flatten and Lake add their removed cells to the counts and never count their own cell.

**Craft tab:**
- a view-model test: tabs, cards per tab, the dot rule;
- the headless smoke test extended: three tabs, each with 10 or fewer cards, all inside 1280×720, and a Toys card that can be crafted.

**Perf:**
- a headless probe counts the cells written per frame and the edit-lane chunks for Flatten and Lake. Flatten must write at most Mega's cells, and the edit lane must hold only the anchor.
- The parent runs the real-GPU `perf:bench`, with a new Flatten row added.

**Run everything headless: no browser windows on the parent's display.**

## 7. Sequencing

1. BlockDef fields, blast-shape dispatch with sphere regression, and `placeBlocks`.
2. The blast toys: Fireworks, Tunnel, Block Bomb, Flatten, Lake, with their particles and the tunnel preview.
3. The pads: Slime, Launch, and the sneak key.
4. Scaffold: the new block kind across raycast, player, mesher, liquids and removal.
5. The Craft tab icon tabs, the recipes, and the derived textures.
6. Docs (`docs/crafting.md`), the smoke test, and the bench row.
