# Crafting toys: design

Date: 2026-09-23. Branch: `crafting-2`, worked in the worktree `.claude/worktrees/toys`, based on `main` at 78934b3. Status: rev 2, after the gate-1 repairs. Process: light Anvil.

## 1. Intent

Crafting shipped and is "really fun". The parent asked for more recipes, inspired by Minecraft, and new "toys". This batch adds **7 crafted-only toy blocks** and **icon tabs** in the Craft tab. The non-goals in CLAUDE.md still hold: no mobs, combat, health, progression or automation.

**Decisions taken with the parent:**
- **Toys in this batch:**
  - Slime Pad
  - Launch Pad
  - Fireworks
  - Tunnel TNT
  - Block Bomb
  - Flattening TNT
  - Lake TNT
- **Deferred to its own follow-up:** the Climbing Scaffold. It would be the first walk-in block, which means new code for drawing, aiming, collision and mining.
- **Craft tab:** icon tabs ⛏ / 💥 / 🎈, each holding 10 cards or fewer, with no scrolling and a green dot on a tab.
- **Lake TNT** keeps ice as its ingredient. Finding snow is a small quest.
- **Fireworks** is a first-day toy: sand and coal, no lapis.

**What the brainstorm found:**
- Every toy is a new **crafted-only block**. Plain-block recipes would do nothing, because those blocks are already free.
- Movement is **straight up only**, because the player keeps no horizontal momentum.

**Success criteria:**
1. Existing worlds, saves, pickaxes, TNT, Big TNT and Mega TNT are unchanged.
2. Each toy behaves as §3 says, and each has a test that fails on its named wrong version.
3. No toy blast is heavier than Mega TNT. This is measured by main-thread light time and frame time at the same site (§6). The parent also runs the bench on a real GPU.
4. The Craft tab shows 3 icon tabs at 1280×720 with no scrolling (headless smoke test).

**Out of scope:**
- Scaffold, builder wand, bridge builder
- Buckets, sideways launchers, speed path
- Recipes for plain building blocks

## 2. Common rules

- **Blocks and ids.** Each toy is a new hand-written block in `blocks.extra.data.ts`, ids 1002–1008 in the order of §3. Never renumber them.
- **Crafted-only.** Each toy is in `CRAFTED_ONLY`, so it needs a count to place in every world. It appears in the Blocks tab only when its count is above 0.
- **No save or API change.** Counts are keyed by name. The deploy rules are the same as for Big TNT: atlas first, then purge, then hard refresh.
- **What counts as mined:**
  - Blocks a toy **removes** count as mined, through `removeBlocks` and `onBlocksRemoved`.
  - Blocks a toy **builds** (dome glass, lake water) are free.
  - A toy that is used up is not counted, and neither is its own cell.
- **One chain rule for every toy that removes blocks** (sphere, tunnel, flatten, lake):
  - A TNT-kind cell inside the shape (any block with `tnt`) is **primed with the chain fuse, never removed or counted**.
  - Dome and firework prime nothing.
  - This rule lives in the shape dispatch, not in each shape.
- **Textures.**
  - Slime Pad uses the Mojang `slime_block` texture.
  - The others are derived in `DERIVED_TEXTURES` (grey, then tinted):
    - Launch Pad: slime tinted red.
    - Tunnel, Flatten, Lake: TNT tinted green, cyan and blue.
    - Block Bomb: TNT tinted white.
    - Fireworks: TNT tinted magenta.
  - The atlas test asserts each tint is ≥ 20° of hue away from every other TNT tint, including Big and Mega.

## 3. The toys

### 3.1 Slime Pad (`slime_pad`, 1002), `pad: 'slime'`

- **When it fires.** In `Player.update`, the vertical velocity at the start of the substep loop is recorded (`landingVy`). After the loop, if `grounded`, `landingVy < -MIN_BOUNCE_VY` and the block under the feet is a slime pad:
  - `vy = padResponse(landingVy, 'slime', keys.jump, keys.sneak)`;
  - `grounded = false`, so the jump line on the next frame does not overwrite the bounce. Gate 1 measured that overwrite: a 19.7 bounce became 8.0.
- **`padResponse`:**
  - no jump held: `-landingVy × 0.8`;
  - jump held: `max(-landingVy, JUMP_SPEED) + 2`, capped so the apex is at most 8 blocks. It works like a trampoline: holding jump grows every bounce up to the cap.
  - sneak held: 0.
- **Settling.** A landing with `|vy| < MIN_BOUNCE_VY = 3` ends the bounce.
- **Recipe.** 4 moss_block + 2 clay → 2.

### 3.2 Launch Pad (`launch_pad`, 1003), `pad: 'launch'`

- **When it fires.** He is grounded on it, his feet have been **outside the pad's cell since the last launch**, and sneak is not held. Then `vy = LAUNCH_VY`, and the jump line cannot overwrite it: the launch is applied after the jump line.
- **Height.** `LAUNCH_VY` is chosen so a simulated `Player.update` at 1/60 s reaches 25 ± 1.5 blocks.
- **Re-arming.** Landing back on the pad does not fire it again until his feet have left the cell. So he doesn't loop forever; he steps off, steps on, and flies again.
- **Recipe.** 1 slime_pad + 4 redstone ore → 1.

### 3.3 Fireworks (`fireworks`, 1004)

- **Data.** `tnt: { radius: 0, fuse: 1, shape: 'firework' }`.
- **When it goes off:**
  - its cell becomes AIR, and it is not counted;
  - no other block changes;
  - `ParticleSystem.spawnFirework(x, y, z, big)` sends a rocket 12 blocks up in 1 s, then about 60 sparkles in 3 random bright colours.
- **Burst cap.** At most 8 bursts at once. Any extra burst is small (about 20 sparkles).
- **Chains.** When primed by a chain it fires the same way.
- **Recipe.** 1 sand + 2 coal ore → 3.

### 3.4 Tunnel TNT (`tunnel_tnt`, 1005)

- **Data.** `tnt: { radius: 0, fuse: 3, shape: 'tunnel' }`.
- **Shape.** 3 wide (centred on the TNT's column), 3 tall with **its floor at the TNT's y**, and 24 long starting at the TNT's cell, along `dir`.
- **Direction when lit.** `ignite(hit, yaw)` changes signature: `dir` comes from the player's yaw, snapped to ±x or ±z.
- **Direction when chained.** `dir` is the dominant horizontal axis of (TNT − blast origin).
  - On a tie (|dx| = |dz|), x wins.
  - When dx = dz = 0 (directly above or below), `dir = 'px'`.
- **Storage.** `dir` is stored in the primed entry. Nothing is saved.
- **Preview.** During the fuse, the area glow (`removableCells`) previews the tunnel.

### 3.5 Block Bomb (`block_bomb`, 1006)

- **Data.** `tnt: { radius: 5, fuse: 3, shape: 'dome' }`.
- **Where glass goes.** When it goes off it writes glass into every **AIR** cell with `4.5 < d ≤ 5.5` (about 350 cells), **except cells the player's box overlaps**. So no glass is ever sealed into his body.
- **What it never touches.** It never replaces a non-air cell or a liquid, and it primes nothing.
- **Its own cell** becomes AIR and is not counted.
- **Batched writes.** The new `GameLoop.placeBlocks(cells, blockId, anchor)` mirrors `removeBlocks`: per-block light, the anchor chunk in the edit lane, the other chunks in the bulk lane. It skips cells that are not AIR, and cells inside the player's box.
- **Recipe.** 2 TNT + 8 sand → 1.

### 3.6 Flattening TNT (`flatten_tnt`, 1007)

- **Data.** `tnt: { radius: 6, fuse: 3, shape: 'flatten' }`.
- **Shape.** The cylinder `dx² + dz² ≤ 36`, for y from the TNT's y to y + 12 inclusive. That leaves a flat floor at y − 1.
- **Size.** About 1,469 cells, against Mega's 2,109.
- **Perf gate.** Measured by light time, not by cell count (§6).
- **Recipe.** 2 Big TNT + 16 stone → 1.

### 3.7 Lake TNT (`lake_tnt`, 1008)

- **Data.** `tnt: { radius: 4, fuse: 3, shape: 'lake' }`.
- **Crater.** It removes the radius-4 sphere, the same cells as today's `detonate` at radius 4.
- **Water level.**
  - The **ring** is the columns with `round(hypot(dx, dz)) == 5`.
  - For each ring column, `top` is the highest solid block at or below the TNT's y (scanning down at most 8).
  - `rimY = min(top over ring columns) − 1`.
  - If no ring column has a solid block, there is **no water** (flat or floating ground).
- **Where water goes.**
  - Water candidates are the removed cells with `y ≤ rimY`, at most 4 layers.
  - Then **erode to stability**: drop any candidate that has a horizontal neighbour, or a cell below, which is neither solid nor itself a candidate. Repeat until nothing changes.
  - So water can never touch an open side or an open floor: no spill on a slope, over a cliff edge or into a cave under the crater.
- **Writes.** Through `placeBlocks(cells, WATER, anchor)`, which updates light and wakes the liquids.
- **Recipe.** 2 TNT + 4 ice → 1.

## 4. Engine changes

- **`BlockDef`** gains:
  - `pad?: 'slime' | 'launch'`
  - `tnt.shape?: 'sphere' | 'tunnel' | 'flatten' | 'lake' | 'dome' | 'firework'`, default `'sphere'`
- **`src/game/blast-shapes.ts`** holds pure shape functions. `detonate` becomes a dispatch that:
  - calls the shape;
  - applies the shared chain rule (§2) to the shape's candidate cells;
  - returns `{ destroyed, primed, build?: { cells, blockId }, water?, effect? }`.

  For plain, Big and Mega TNT, the destroyed and primed lists stay **identical, including cell order** (a frozen copy in the test), on worlds without toys.
- **`PrimedEntry`** gains `dir?: 'px' | 'nx' | 'pz' | 'nz'`.
- **`GameLoop`:**
  - `ignite(hit, yaw)`
  - `placeBlocks(cells, blockId, anchor)`
  - `detonateAt` applies `build`, `water` and `effect`.
- **`src/game/pads.ts`:** `padResponse`, `LAUNCH_VY`, `MIN_BOUNCE_VY`.
- **`Player.update`:** the landing and launch hooks from §3.1 and §3.2, plus launch re-arm state.
- **`Keys`** gains an optional `sneak`:
  - `main.ts` gets its own `keydown`/`keyup` listener for `ShiftLeft` and `ShiftRight`, because `onKey` returns early for keys that have no action.
  - `resetKeys` clears it.
  - No clash with Shift-replace (which reads `e.shiftKey`) or with Shift+Tab.
- **`ParticleSystem.spawnFirework`**, with the burst cap.

## 5. Craft tab: icon tabs

- **Three icon buttons** inside the Craft panel, each holding its cards with no scrolling at 1280×720:
  - Iron pickaxe icon, Pickaxes: 7 cards.
  - TNT face, Boom: TNT, Big, Mega, Tunnel, Flatten, Lake, Block Bomb and Fireworks (8 cards).
  - Slime face, Toys: Slime and Launch (2 cards).
- **Tab field.** Each `Recipe` gains `tab: 'pickaxes' | 'boom' | 'toys'`. The last tab viewed is remembered for the session.
- **Green dot.** A tab gets a green dot when a recipe in it has **become** craftable since that tab was last viewed. Once he looks at the tab, the dot clears until something new becomes craftable, so Boom doesn't stay green all day. At the start of a session nothing counts as seen, so every tab with a craftable recipe shows its dot once.
- **Hotbar slot.** A crafted toy uses the crafted-block slot rule (holding → empty → greyed → selected).

## 6. Testing

Every test names the wrong version it catches.

**Pure tests**
- **`padResponse`:** checks 0.8; jump held grows bounces up to the 8-block cap; sneak gives 0; a landing below `MIN_BOUNCE_VY` gives 0.
- **Blast shapes:** exact counts and pinned cells for each shape.
  - **Tunnel:** 4 directions, floor at the TNT's y, the chained direction including the tie and the directly-above case.
  - **Flatten:** the cylinder, with nothing below the TNT's y.
  - **Lake:** fixtures for flat ground (no water), a 2-step slope (water only below the low rim, and none touching the open side), a cave under the crater (no spill), and at most 4 deep.
  - **Dome:** only AIR cells on the shell, and none inside the player's box.
  - **Firework:** removes and primes nothing.
- **Chain rule:** a TNT inside a Tunnel, Flatten or Lake blast is primed, not removed and not counted.
- **Sphere regression:** plain, Big and Mega give the same lists in the same order as a frozen copy of today's `detonate`.

**Loop tests (`makeLoop`)**
- **Slime:**
  - a 10-block drop onto a pad bounces;
  - with jump held, each rise is higher than the last, up to the cap, and higher than a plain jump's 1.33 apex (this catches the jump overwrite);
  - with sneak held, it doesn't bounce;
  - it settles.
- **Launch:** simulated `Player.update` at 1/60 reaches an apex of 25 ± 1.5, also with jump held. Landing back on the pad does not relaunch; stepping off and on does. Sneak blocks it.
- **Block Bomb:** in a part-built area only AIR becomes glass. Counts are unchanged. The player's cells stay AIR.
- **Lake:** after the liquids settle, no water is outside the crater.
- **Fireworks:** its block becomes AIR, its count is unchanged, and no other block changes.
- **Counts:** Tunnel, Flatten and Lake add their removed cells to the counts and never count their own cell.
- **Ignite:** the direction comes from yaw.

**Craft tab**
- View-model tests: tabs, cards per tab, and the dot rule (it clears on view and comes back only on a new craftable).
- The headless smoke test is extended: 3 tabs, each with ≤ 10 cards inside 1280×720, and crafting a Slime Pad.

**Perf**
- A headless probe measures `stats.lightMs` and the worst frame's main-thread time for Flatten and Lake, against Mega at the same v3 surface site. Neither may exceed Mega's.
- The parent runs the real-GPU `perf:bench` with a Flatten row added.

**Run everything headless, with no windows on the parent's display, never port 5173, and never the main checkout.**

## 7. Sequencing

1. BlockDef fields, the blast-shape dispatch with the chain rule and sphere regression, and `placeBlocks`.
2. The blast toys: Fireworks, Tunnel (with `ignite(hit, yaw)` and the preview), Block Bomb, Flatten, Lake.
3. Pads: Slime, Launch, and the sneak key.
4. Craft tab icon tabs, the recipes, and the derived textures.
5. Docs (`docs/crafting.md`), the smoke test, and the bench row. The docs should mention that standing on a hill above a Flattening TNT drops him up to 12 blocks. That is harmless, since there is no fall damage.
