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

1. Same guards as placing: game not paused, pointer locked, raycast hit within
   reach, hotbar slot holds a block (not AIR).
2. The aimed block is mineable: `BLOCKS[id].hardness > 0`, the same guard
   `updateMining` applies. No solid block has hardness 0 today (there is no
   bedrock), so this is consistency with mining, not a live rule.
3. The aimed block differs from the selected block (replacing stone with stone
   does nothing, so no chunk remesh, no autosave dirty).

No player-collision check: the target cell is already a solid block, so the
player is not inside it. Liquids are never hit by the raycast (not solid), so
they cannot be replaced; a hotbar liquid *can* be the replacement — the write
goes through `world.setBlock`, which already marks the liquid frontier, so it
flows like a placed liquid.

**Side effects, mirroring "mine then place".** Removal effects come from the
mining-complete branch of `GameLoop.updateMining`, placement effects from the
right-click handler:

- Old block a primed TNT → cancel the fuse (registry delete + overlay remove).
- Old block a lamp → `lights.remove`.
- Break particles for the old block (`particles.spawnBreak`).
- `world.setBlock(x, y, z, newId)`.
- New block a lamp → `lights.add` with the current light colour.
- `markChunkDirtyAround`, `applyLightUpdate` once (lighting recomputes from the
  final block state), autosave dirty via `onBlockBroken`/`onWorldMutated`.

**Code shape.**

- `src/game/actions.ts`: `canReplace(world, hit, block): boolean` — pure, rules
  2 and 3 above. No world mutation here; the mutation needs the loop's registries.
- `src/game/loop.ts`: extract the old-block cleanup from `updateMining` into a
  private `clearBlockEffects(x, y, z, oldId)` (TNT fuse, lamp light, particles)
  and reuse it. Add `replaceBlock(hit, newId, lampColor): boolean` that applies
  the sequence above and fires `onBlockBroken` (autosave). Returns false when
  `canReplace` fails.
- `src/main.ts`: in the `mousedown` handler, branch on `e.shiftKey` before the
  existing place path.

The existing hotbar `Shift+Tab` binding is a keyboard chord and does not
interact with this.

## 2. Highlight the aimed face

**New.** Every tick, the game raycasts from the eye along the look direction
with the same reach as mining/placing. If it hits, a highlight is drawn on the
hit face of that voxel; otherwise nothing is drawn. Because the raycast and the
reach are the ones the actions use, the highlight is an exact predictor:
*visible highlight ⇔ a click will act on that face*. Too far → no highlight.

**Look.** A unit quad flush with the face, nudged 0.004 along the face normal so
it does not z-fight, white at 25 % opacity, with a 1 px black line loop on its
edges. Depth-tested (hidden behind nearer geometry), no depth write, rendered
after liquids (`renderOrder = 2`) so it is visible on translucent blocks such as
glass and iron bars.

**Hidden** while `loop.paused` is true (time's-up freeze, inventory open) and
when the raycast misses. It stays visible while the pointer is unlocked but the
game is running (Esc to the browser): the world keeps running there and the
crosshair also stays.

**Code shape.**

- `src/engine/render/face-highlight.ts`: `FaceHighlight` class, same pattern as
  `PrimedOverlay` (constructor takes the scene). `show(x, y, z, face)`,
  `hide()`. Internally one `THREE.Mesh` (quad) and one `THREE.LineLoop`
  parented to a `THREE.Group`; `show` positions and orients the group.
  `faceTransform(face)` is an exported pure helper returning the group's
  centre offset and Euler rotation for a face, so orientation is unit-testable
  without WebGL.
- `src/game/loop.ts`: the tick computes `this.aim = raycastVoxel(...)` once
  (before `updateMining`, which now reuses it instead of raycasting again), then
  calls `highlight.show/hide`. `highlight` is a new optional constructor
  parameter after `lights`, defaulting to null, so `loop.test.ts` keeps working.
  While paused the tick already returns early; `hide()` is called on that path.
- `src/main.ts`: construct `new FaceHighlight(renderer.scene)` next to the
  `PrimedOverlay` and pass it in.

The mousedown handlers keep their own raycast (they run on the event, not on
the tick, and the camera may have moved since the last frame).

## Tests

- `actions.test.ts`: `canReplace` — false when the aimed block equals the
  selected block, false when the aimed cell is AIR or a liquid (hardness 0 /
  not solid), true for stone → dirt.
- `loop.test.ts` (headless, existing stub): `replaceBlock` overwrites the block,
  fires `onBlockBroken`, cancels a primed TNT fuse (the registry no longer has
  it, and a later `simulate` does not detonate), and returns false without
  touching the world for a same-block replace.
- `face-highlight.test.ts`: `faceTransform` — the offset for each face points
  along that face's outward normal, and rotating the quad's +Z normal by the
  returned Euler yields that same normal (six cases). `three` imports fine in
  vitest (loop.test already does).
- Manual, in the browser at `localhost:5173`: highlight appears on the aimed
  face and disappears when backing off past reach; Shift+right-click on a stone
  block with dirt selected swaps it in place; with stone selected on stone it
  does nothing; on a primed TNT it cancels the fuse.

## Docs

README "Interaction": add **Shift + Right click** — replace the aimed block with
the selected one; and a line saying the aimed face is highlighted when within
reach.

## Non-goals

No block outline around the whole cube (face only, as asked). No highlight
colour per block. No replace via left click. No keybinding option for the
modifier (Shift is fixed, like Shift+Tab).
