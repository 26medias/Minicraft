# Block Face Textures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two rendering bugs on grass blocks — side faces render vertically flipped, and `grass_block_top` renders as untinted grey.

**Architecture:** Two independent fixes. (1) Replace the single shared `uu`/`vv` UV arrays in `mesher.ts` with per-face UV tables, so side faces map `world y=0 → v0` and `world y=1 → v1` while top/bottom preserve their current orientation. (2) Add a `TEXTURE_TINTS` map in `scripts/build-atlas.ts` that multiplies a texture's RGB channels by a tint color before compositing — used for `grass_block_top` in plains-biome green.

**Tech Stack:** TypeScript, Three.js, Vitest, Sharp (in the build script), tsx.

Source spec: `docs/superpowers/specs/2026-04-21-block-face-textures-design.md`.

---

## Task 1: Per-face UV tables in the mesher

**Files:**
- Modify: `src/engine/world/mesher.ts`
- Modify: `src/engine/world/mesher.test.ts`

**Context for the engineer:**
- The mesher is a pure function `(chunk, neighbors, uvFor) => ChunkMesh`. `uvFor(id, face)` returns `[u0, v0, u1, v1]` where `v0` is the bottom of the tile in the atlas (after the Three.js V-flip) and `v1` is the top.
- Each entry in `FACES` already has a `corners: [number, number, number][]` field — 4 unit-cube offsets in CCW winding viewed from outside.
- Today, a single pair of arrays `uu = [u0, u1, u1, u0]` / `vv = [v1, v1, v0, v0]` is applied to every face. Side faces have corners in `y=[0, 0, 1, 1]` order, so world `y=0` vertices incorrectly sample `v1` (tile top) and world `y=1` vertices incorrectly sample `v0` (tile bottom). That's the flip we're fixing.
- `FACE_ORDER` is `['px', 'nx', 'py', 'ny', 'pz', 'nz']`. The first face emitted for an isolated block is `px`.
- UVs are packed per-vertex, 2 floats each. For face 0 (`px`), vertex 0's V coordinate is at `mesh.uvs[1]`, vertex 1's V at `mesh.uvs[3]`, vertex 2's V at `mesh.uvs[5]`, vertex 3's V at `mesh.uvs[7]`.

- [ ] **Step 1: Write the failing test**

Append to `src/engine/world/mesher.test.ts` inside the existing `describe('meshChunk', ...)` block:

```typescript
it('side face maps world y=0 to v0 and y=1 to v1 (not upside-down)', () => {
    const c = new Chunk(0, 0);
    c.set(5, 5, 5, stone);
    // Distinguishable corners so u0/v0/u1/v1 are each identifiable in the output.
    const uv = (): [number, number, number, number] => [0.1, 0.2, 0.8, 0.9];
    const mesh = meshChunk(c, {}, uv);
    // FACE_ORDER starts with 'px'. Its corners are ordered [y=0, y=0, y=1, y=1].
    // Expected UV layout (u, v) per corner: (u0, v0), (u1, v0), (u1, v1), (u0, v1).
    expect(mesh.uvs[0]).toBe(0.1); // corner 0 U = u0
    expect(mesh.uvs[1]).toBe(0.2); // corner 0 V = v0  (bottom of tile, y=0)
    expect(mesh.uvs[2]).toBe(0.8); // corner 1 U = u1
    expect(mesh.uvs[3]).toBe(0.2); // corner 1 V = v0  (bottom of tile, y=0)
    expect(mesh.uvs[4]).toBe(0.8); // corner 2 U = u1
    expect(mesh.uvs[5]).toBe(0.9); // corner 2 V = v1  (top of tile, y=1)
    expect(mesh.uvs[6]).toBe(0.1); // corner 3 U = u0
    expect(mesh.uvs[7]).toBe(0.9); // corner 3 V = v1  (top of tile, y=1)
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run src/engine/world/mesher.test.ts`

Expected: the new test fails. The current mesher produces `v1, v1, v0, v0` for the `vv` components, so `mesh.uvs[1]` will be `0.9` (not `0.2`) and the test fails on that assertion.

- [ ] **Step 3: Edit the `FACES` table to add a `uvs` field**

Open `src/engine/world/mesher.ts`.

Update the type of `FACES` (line 19) and each entry to include a `uvs` field. Each entry in `uvs` is `[uIndex, vIndex]` where `0` selects the lower UV bound (`u0` / `v0`) and `1` selects the upper bound (`u1` / `v1`).

Replace the full `FACES` declaration (lines 19–101) with:

```typescript
// Per-face constant data: normal, direction offset, 4 corner offsets (positions within a unit cube),
// and 4 per-corner UV selectors ([uIndex, vIndex] where 0 picks u0/v0, 1 picks u1/v1).
// Winding: CCW when viewed from outside the cube, so front-faces point outward.
const FACES: Record<
    Face,
    {
        normal: [number, number, number];
        corners: [number, number, number][];
        uvs: [0 | 1, 0 | 1][];
        dx: number;
        dy: number;
        dz: number;
    }
> = {
    px: {
        normal: [1, 0, 0],
        dx: 1,
        dy: 0,
        dz: 0,
        corners: [
            [1, 0, 1],
            [1, 0, 0],
            [1, 1, 0],
            [1, 1, 1],
        ],
        // Side face: world y=0 -> v0 (tile bottom), world y=1 -> v1 (tile top).
        uvs: [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
        ],
    },
    nx: {
        normal: [-1, 0, 0],
        dx: -1,
        dy: 0,
        dz: 0,
        corners: [
            [0, 0, 0],
            [0, 0, 1],
            [0, 1, 1],
            [0, 1, 0],
        ],
        uvs: [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
        ],
    },
    py: {
        normal: [0, 1, 0],
        dx: 0,
        dy: 1,
        dz: 0,
        corners: [
            [0, 1, 1],
            [1, 1, 1],
            [1, 1, 0],
            [0, 1, 0],
        ],
        // Top face: preserves the historical orientation (relevant for directional tiles like oak_log_top).
        uvs: [
            [0, 1],
            [1, 1],
            [1, 0],
            [0, 0],
        ],
    },
    ny: {
        normal: [0, -1, 0],
        dx: 0,
        dy: -1,
        dz: 0,
        corners: [
            [0, 0, 0],
            [1, 0, 0],
            [1, 0, 1],
            [0, 0, 1],
        ],
        uvs: [
            [0, 1],
            [1, 1],
            [1, 0],
            [0, 0],
        ],
    },
    pz: {
        normal: [0, 0, 1],
        dx: 0,
        dy: 0,
        dz: 1,
        corners: [
            [0, 0, 1],
            [1, 0, 1],
            [1, 1, 1],
            [0, 1, 1],
        ],
        uvs: [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
        ],
    },
    nz: {
        normal: [0, 0, -1],
        dx: 0,
        dy: 0,
        dz: -1,
        corners: [
            [1, 0, 0],
            [0, 0, 0],
            [0, 1, 0],
            [1, 1, 0],
        ],
        uvs: [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
        ],
    },
};
```

- [ ] **Step 4: Update the emission loop to consume the per-face UV table**

In the same file, replace the inner body of the face loop (current lines 149–161) — from `const [u0, v0, u1, v1] = uvFor(id, face);` through the end of `vcount += 4;` — with:

```typescript
                        const [u0, v0, u1, v1] = uvFor(id, face);

                        for (let i = 0; i < 4; i++) {
                            const [ox, oy, oz] = f.corners[i];
                            const [ui, vi] = f.uvs[i];
                            positions.push(x + ox, y + oy, z + oz);
                            normals.push(f.normal[0], f.normal[1], f.normal[2]);
                            uvs.push(ui === 0 ? u0 : u1, vi === 0 ? v0 : v1);
                        }
                        indices.push(vcount, vcount + 1, vcount + 2, vcount, vcount + 2, vcount + 3);
                        vcount += 4;
```

This removes the `uu` / `vv` local arrays entirely.

- [ ] **Step 5: Run the full test suite and verify all pass**

Run: `npm test`

Expected: every test passes, including the new side-face UV test. If `mesher.test.ts` fails on any of the pre-existing cases, you've likely broken corner winding or vertex counts — re-read the diff against steps 3 and 4.

- [ ] **Step 6: Typecheck**

Run: `npx tsc -b`

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/engine/world/mesher.ts src/engine/world/mesher.test.ts
git commit -m "$(cat <<'EOF'
fix(render): per-face UV tables so side textures aren't upside down

Every face was sharing a single vv=[v1,v1,v0,v0] array. Side faces
have corners in y=[0,0,1,1] order, which meant world-y=0 vertices
sampled the tile's top row and world-y=1 vertices sampled the
bottom — grass strips rendered at the floor of each block instead
of the ceiling. Move the per-corner UV selector onto each FACES
entry; top/bottom keep their historical orientation for directional
tiles like oak_log_top.
EOF
)"
```

---

## Task 2: Build-time texture tint for `grass_block_top`

**Files:**
- Modify: `scripts/build-atlas.ts`

**Context for the engineer:**
- `scripts/build-atlas.ts` is a Node script run via `npm run build-atlas` (also `prebuild`). It uses Sharp to read each source PNG at `src/assets/blocks/<name>.png`, downscale to 16×16 with nearest-neighbour, extract raw RGBA bytes, pad with an edge-replicated 2px border, and composite the result into a 512×512 atlas PNG alongside a UV JSON table.
- Mojang's `grass_block_top.png` is a grayscale mask meant to be multiplied by a biome color at runtime. We don't have biomes, so we bake the tint at build time.
- Plains-biome grass green is approximately `#79C05A`, i.e. `[0x79, 0xC0, 0x5A]` = `[121, 192, 90]`.
- Tint math per channel: `out = round(in * tint / 255)`. Alpha is preserved untouched.
- Apply the tint **before** `padEdgeReplicate`, so the replicated border picks up the tinted edge pixels.

- [ ] **Step 1: Add the `TEXTURE_TINTS` constant and `applyTint` helper**

Open `scripts/build-atlas.ts`.

Add this block immediately after the constants at the top of the file (after `const OUT_JSON = 'public/atlas.json';` on line 16):

```typescript
// Textures shipped by Mojang as grayscale masks that the game tints at runtime.
// We have no biomes, so the tint is baked in at build time.
const TEXTURE_TINTS: Record<string, [number, number, number]> = {
    grass_block_top: [0x79, 0xC0, 0x5A], // plains-biome grass green
};

function applyTint(raw: Uint8Array, tint: [number, number, number]): Uint8Array {
    const [tr, tg, tb] = tint;
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 4) {
        out[i + 0] = Math.round((raw[i + 0] * tr) / 255);
        out[i + 1] = Math.round((raw[i + 1] * tg) / 255);
        out[i + 2] = Math.round((raw[i + 2] * tb) / 255);
        out[i + 3] = raw[i + 3];
    }
    return out;
}
```

- [ ] **Step 2: Apply the tint in the tile-compositing loop**

In the same file, in `main()`, replace the block that currently reads (around lines 52–62):

```typescript
        const img = sharp(tilePath).resize(TILE, TILE, { kernel: 'nearest' }).ensureAlpha();
        const raw = await img.raw().toBuffer({ resolveWithObject: true });
        if (raw.info.width !== TILE || raw.info.height !== TILE) {
            throw new Error(`Unexpected tile size for ${name}: ${raw.info.width}x${raw.info.height}`);
        }
        if (raw.info.channels !== 4) {
            throw new Error(`Expected 4-channel RGBA for ${name}, got ${raw.info.channels}`);
        }

        const padded = padEdgeReplicate(raw.data, TILE, PADDING);
```

with:

```typescript
        const img = sharp(tilePath).resize(TILE, TILE, { kernel: 'nearest' }).ensureAlpha();
        const raw = await img.raw().toBuffer({ resolveWithObject: true });
        if (raw.info.width !== TILE || raw.info.height !== TILE) {
            throw new Error(`Unexpected tile size for ${name}: ${raw.info.width}x${raw.info.height}`);
        }
        if (raw.info.channels !== 4) {
            throw new Error(`Expected 4-channel RGBA for ${name}, got ${raw.info.channels}`);
        }

        const tint = TEXTURE_TINTS[name];
        const pixels = tint ? applyTint(raw.data, tint) : raw.data;

        const padded = padEdgeReplicate(pixels, TILE, PADDING);
```

(The only changes are the two new lines creating `tint` and `pixels`, and swapping `raw.data` for `pixels` in the `padEdgeReplicate` call.)

- [ ] **Step 3: Check the existing `padEdgeReplicate` signature accepts the tinted buffer**

The function is declared `function padEdgeReplicate(src: Uint8Array, size: number, pad: number): Buffer` (line 73). `applyTint` returns a `Uint8Array`, and `raw.data` is also a `Uint8Array` (well, a `Buffer`, which is a `Uint8Array` subclass). No signature change needed.

- [ ] **Step 4: Rebuild the atlas and confirm no errors**

Run: `npm run build-atlas`

Expected: the script prints `Wrote N tiles to public/atlas.png (512x512)` with no errors. `public/atlas.png` and `public/atlas.json` are regenerated (both are gitignored, so they won't show in `git status`).

- [ ] **Step 5: Run the full test suite one more time**

Run: `npm test`

Expected: all tests pass (this task doesn't change any code paths under test, but confirms nothing regressed).

- [ ] **Step 6: Commit**

```bash
git add scripts/build-atlas.ts
git commit -m "$(cat <<'EOF'
feat(atlas): bake per-texture tints at build time

Mojang ships grass_block_top as a grayscale mask expecting a biome
color multiply at runtime. We don't have biomes, so the top of
every grass block was rendering grey. Apply the plains-biome tint
(#79C05A) to grass_block_top during atlas build; TEXTURE_TINTS is
data-driven so leaves / other tintable tiles slot in later without
touching the pipeline.
EOF
)"
```

---

## Task 3: Visual verification in the browser

**Files:** none

**Context for the engineer:**
- Automated tests only cover the UV flip. The tint fix is visual; confirm it in a running game before calling this done.
- The dev server runs the app against the atlas in `public/`.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`

Expected: Vite prints a local URL (e.g. `http://localhost:5173/`). Open it in Chrome.

- [ ] **Step 2: Play far enough to stand next to a grass block**

From the main menu, click **New World**, wait for the world to generate, and walk a few steps. Look at any grass block.

- [ ] **Step 3: Confirm all three faces look right**

Verify each of:
- [ ] **Side faces** — the green grass strip appears at the **top** of each side face, with dirt below it. (Before the fix it was inverted.)
- [ ] **Top face** — looking down or mining into a hill, the top of a grass block is **green**, not grey. (This is the tint fix.)
- [ ] **Bottom face** — if you mine out a cube and look up at the block above, the bottom is **dirt**. (Unchanged from before, should still be correct.)

- [ ] **Step 4: Spot-check a directional top texture**

Place or find an `oak_log` block. Look down at its top face. The grain circles on `oak_log_top` should look like rings, not mirrored or sideways. (Confirms the per-face UV change didn't rotate top/bottom textures.)

- [ ] **Step 5: Quick regression scan**

- [ ] Walk around for ~30 seconds. No z-fighting, no seam artifacts between chunks.
- [ ] No console errors in Chrome devtools.
- [ ] Stone, cobblestone, sand, planks, and wool blocks all still look correct (uniform-texture blocks — baseline sanity check).

- [ ] **Step 6: Capture a new screenshot for the record**

Save a screenshot of a grass block next to the original `screenshots/Screenshot from 2026-04-21 14-04-39.png` — not committed, just for comparison in the handoff summary. (The `screenshots/` directory is already untracked.)

- [ ] **Step 7: Report outcome**

If all checks pass: task complete, summarise the two commits on this branch and offer to open a PR to `main`.

If any check fails: stop. Do not paper over the issue. Re-read the mesher or build-atlas change and diagnose — the spec explicitly calls out each face's expected behavior, so any discrepancy points at a specific line to fix.
