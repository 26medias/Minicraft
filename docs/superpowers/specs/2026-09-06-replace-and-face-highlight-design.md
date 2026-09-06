# Shift-to-replace and face highlight — design

Two small interaction changes. Both build on the existing crosshair raycast
(`raycastVoxel`, reach 6 blocks) and touch nothing else.

## 1. Shift + right click replaces the aimed block

**Today.** Right click places the selected hotbar block on the *face* you aim at
(`placeBlock` in `src/game/actions.ts`, called from the `mousedown` handler in
`src/main.ts`). Swapping a block means mining it, then placing.

**New.** If `Shift` is held during a right click, the block *under the crosshair*
is overwritten with the selected hotbar block. The face is ignored. Nothing else
about right click changes when Shift is up.

Rules, in order; the first that fails makes the click a no-op:

1. The shared right-click guards, unchanged and evaluated first: game not
   paused, pointer locked, `e.button === 2`, raycast hit within reach, hotbar
   slot holds a block (`id !== undefined && id !== AIR`). **The Shift branch
   sits after all of these**, in place of the `placeBlock` call only. Putting
   it before the AIR guard would turn an empty slot into an instant-delete
   tool; the plan must keep it after.
2. The aimed block is mineable: `def = BLOCKS[id]` exists, `isSolid(id)` and
   `def.hardness > 0`, the same guard `updateMining` applies. Today every
   solid block has hardness > 0 (there is no bedrock), so this is consistency
   with mining, not a live rule; the test suite cannot tell the two checks
   apart and does not claim to.
3. The aimed block differs from the selected block. Replacing stone with stone
   does nothing: no `setBlock` (which would flag the chunk modified and mark
   the liquid frontier), no remesh, no autosave dirty.

Consequences that are intended, not oversights:

- No player-collision check: the target cell is already solid, so the player
  is not inside it. Replacing the block under the player with water or lava
  is allowed; the player drops into swim mode, and there is no damage system.
- Liquids are never hit by the raycast (not solid), so they cannot be
  replaced. A hotbar liquid *can* be the replacement: `world.setBlock` clears
  fluid meta and marks the frontier, so it becomes a source block and flows,
  exactly like the existing place path.
- A lamp aimed at with a lamp selected is a same-id no-op even if a different
  colour is picked. Recolouring is the `C` key's job.

**Side effects, mirroring "mine then place".** Removal effects come from the
mining-complete branch of `GameLoop.updateMining`, placement effects from the
right-click handler. Order matters: `applyLightUpdate` reads lamp colours via
`lights.getColor`, so both the remove and the add must precede it.

1. If `this.mining` targets this cell, set it to null. Otherwise the stale
   mining state finishes later with the old id: a replaced-in lamp would be
   broken without `lights.remove`, leaving an orphan light that is saved and
   blocks a future lamp at that cell.
2. `clearBlockEffects(x, y, z, oldId)`: primed TNT → registry delete and
   overlay remove; lamp → `lights.remove`; `particles.spawnBreak(oldId)`.
   This helper is extracted from `updateMining` and called there too, before
   `setBlock`; the only observable change to mining is that break particles
   spawn a few lines earlier in the same tick, which is intentional.
3. `world.setBlock(x, y, z, newId)`.
4. New block a lamp → `lights.add(x, y, z, lampColor)`.
5. `markChunkDirtyAround(x, z)`, then `applyLightUpdate(x, y, z)` once.
6. `onWorldMutated?.()` for autosave. Not `onBlockBroken`: that event means
   "a block was mined" and a future consumer (drops) must not see a replace.
   `main.ts` needs no extra `markDirty` after the branch.

Chunk-edge behaviour is inherited: `markChunkDirtyAround` marks lateral
neighbours, `applyLightUpdate` the SE diagonals; the NW diagonal corner is not
marked today and the mesher only reads lateral neighbours, so no regression.

**Code shape.**

- `src/game/actions.ts`: `canReplace(world, hit, block): boolean`, pure, rules
  2 and 3. No world mutation here; the mutation needs the loop's registries.
- `src/game/loop.ts`: extract `clearBlockEffects` from `updateMining`; add
  `replaceBlock(hit, newId, lampColor): boolean` implementing the sequence
  above, returning false when `canReplace` fails.
- `src/main.ts`: in the `mousedown` handler, after the shared guards, if
  `e.shiftKey` call `loop.replaceBlock(hit, id, opts.currentLightColor)` and
  return; else the existing place path. This handler is inline and stays
  manual-test-only, as today.

The existing hotbar `Shift+Tab` binding is a keyboard chord and does not
interact with this. Shift is bound to nothing else.

## 2. Highlight the aimed face

**New.** Every tick, the game raycasts from the eye along the look direction
with the same reach as mining/placing. If it hits, a highlight is drawn on the
hit face of that voxel; otherwise nothing is drawn. The highlight means
"within reach": a highlighted face can be mined, and a right click will act on
it unless placement's own rules refuse (the cell is occupied by the player, or
a Shift replace is a same-block no-op). Too far → no highlight. The mousedown
raycast and the tick's aim can differ by one frame of mouse motion; accepted.

**Look.** Must be legible on white wool, snow, obsidian and glass, at 6
blocks, at 1× DPR (manual acceptance check). A 1 px WebGL line loop fails
that (linewidth is always 1 device pixel; white fill vanishes on white), so:

- A **border** of four thin quads, 1/16 block wide (one texel), white at 85 %
  opacity, inset 0.005 from the face edges so no edge lies in a neighbouring
  block's plane.
- A **fill** quad over the face, black at 20 % opacity, inset the same 0.005.
  The white border reads on dark blocks, the dark fill on light ones.
- The whole group is nudged 0.004 along the face normal (over 50 depth LSBs
  at reach; no z-fight with the face). Both materials: `transparent: true`
  (otherwise they land in the opaque list and `renderOrder` is ignored),
  `depthTest: true`, `depthWrite: false`, `side: FrontSide` (so the quad is
  invisible when the eye is inside a solid voxel), `fog: false`,
  `polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1`.
  `renderOrder` 2 for the fill and 3 for the border, after liquids (1).
  Translucent blocks draw at 0 with depthWrite on; the highlight is 0.004 in
  front of their face, so it passes depth. On iron bars and glass the fill
  shows through the cutout holes as a faint square; accepted.
- On a primed TNT the 1.05-scale pulsing overlay encloses the highlight;
  cosmetic, accepted.

**Hidden** while `loop.paused` is true (time's-up freeze, inventory open) and
when the raycast misses. It stays visible while the pointer is unlocked but the
game is running (Esc to the browser) and while the colour picker is open, for
parity with the crosshair. Visible alongside the mining ring.

**Code shape.**

- `src/engine/render/face-highlight.ts`: `FaceHighlight` class, same pattern
  as `PrimedOverlay` (constructor takes the scene). `show(x, y, z, face)`,
  `hide()`. One `THREE.Group` holding the fill mesh and four border meshes,
  added to the scene once; `show` sets `group.position`/`rotation` and
  `visible = true`, `hide` sets `visible = false`. No per-tick allocation or
  scene-graph churn.
- `faceTransform(face): { offset: [x, y, z]; euler: [x, y, z] }` is an
  exported pure helper reading from a frozen constant table:

  | face | offset (block-relative) | euler |
  |---|---|---|
  | px | (1+EPS, .5, .5) | (0, +π/2, 0) |
  | nx | (−EPS, .5, .5) | (0, −π/2, 0) |
  | py | (.5, 1+EPS, .5) | (−π/2, 0, 0) |
  | ny | (.5, −EPS, .5) | (+π/2, 0, 0) |
  | pz | (.5, .5, 1+EPS) | (0, 0, 0) |
  | nz | (.5, .5, −EPS) | (0, π, 0) |

  with `EPS = 0.004`. `PlaneGeometry`'s normal is +Z; rotating it by the
  Euler yields the face's outward normal.
- `src/game/loop.ts`: in `tick`, **immediately after `cam.sync` and before
  `updateMining`** (so the eye is this frame's), compute
  `this.aim = raycastVoxel(...)` once; `updateMining` reuses it. Then
  `highlight.show(...)` or `hide()`. `highlight` is a new optional
  constructor parameter after `lights`, defaulting to null, so `loop.test.ts`
  keeps working. On the paused early-return, call `hide()`.
- `src/main.ts`: construct `new FaceHighlight(renderer.scene)` next to the
  `PrimedOverlay` and pass it in.

The mousedown handlers keep their own raycast (they run on the event, not on
the tick).

## Tests

Each test names the observable that makes it fail on the listed wrong
implementation.

- `actions.test.ts`, `canReplace`:
  - stone aimed, dirt selected → true.
  - stone aimed, stone selected → false (rule 3).
  - AIR cell and water cell aimed with stone selected → false (rule 2).
  - out-of-range id at the cell (write it straight into `chunk.blocks`) →
    false, no throw (the `!def` guard).
- `loop.test.ts` (headless stub; extend `makeLoop` to accept a real
  `LightRegistry`, which needs only a `THREE.Scene`):
  - stone → dirt: block becomes dirt and `onWorldMutated` fires once.
  - stone → stone: after setting `chunk.modified = false` and clearing
    `chunk.liquidFrontier`, both stay so and `onWorldMutated` does not fire
    (fails if the rule-3 guard is skipped, since `setBlock` sets both).
  - primed TNT → stone: after `simulate(TNT_PRIME_FUSE + 0.1)` a neighbouring
    stone block still exists (fails if the fuse is not cancelled; `detonate`
    ignores what sits at the origin).
  - stone → lamp with a real registry: `lights.getColor(x, y, z)` equals the
    colour passed, and some `chunk.lights` entry changed from 0 (fails if
    `lights.add` or `applyLightUpdate` is missing or misordered).
  - lamp → stone: `lights.getColor` is null afterwards.
  - mining in progress on the cell (drive `setLeftMouseDown(true)` and a
    tick with the camera aimed at it, or set the state through a test seam),
    then replace stone → lamp: `miningProgress()` is 0 right after the call
    and, after enough ticks to exceed stone's hardness, the lamp is still
    there and `lights.getColor` non-null (fails if mining state is not
    cleared).
- `face-highlight.test.ts`, `faceTransform`: for each of the six faces,
  rotating (0, 0, 1) by the Euler gives the outward normal, the offset minus
  the block centre (.5, .5, .5) is parallel to that normal, and its length is
  `0.5 + EPS` (fails on a wrong sign, a wrong axis, or a quad at the centre).
- Manual, in the browser at `localhost:5173`, in the browser the kid uses:
  highlight legible on white wool, snow, obsidian and glass; disappears when
  backing off past reach; Shift+right-click on stone with dirt selected swaps
  it in place; with stone selected on stone it does nothing; on a primed TNT
  it cancels the fuse; Shift+right-click opens no browser context menu and
  keeps pointer lock (Firefox is known to force the menu on Shift+right-click
  outside pointer lock).

## Docs

README "Interaction": add
`- **Shift + Right click** — replace the block you're aiming at with the selected one (instead of building next to it).`
and, after the Left/Right click lines, "The face you're aiming at is outlined
when it's close enough to reach." Also fix the stale movement line that says
Shift has no effect in fly/swim: Shift is not a movement key.

## Non-goals

No block outline around the whole cube (face only, as asked). No highlight
that predicts placement failure. No replace via left click. No keybinding
option for the modifier (Shift is fixed, like Shift+Tab).
