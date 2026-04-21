# Block Face Textures — Design

Date: 2026-04-21
Branch: `fix-block-face-textures` (off `main`)

## Problem

Grass blocks render wrong:

1. **Side faces are vertically flipped.** The green grass strip appears at the *bottom* of each side face instead of the top.
2. **The top face renders grey.** It looks like stone rather than grass.

Both issues are visible in `screenshots/Screenshot from 2026-04-21 14-04-39.png`. Dirt bottom and non-tinted blocks (stone, cobblestone, planks, wool) look fine.

## Root causes

### Bug 1 — UV V-axis flipped on side faces

`src/engine/world/mesher.ts:151-152` uses a single UV mapping for every face:

```ts
const uu = [u0, u1, u1, u0];
const vv = [v1, v1, v0, v0];
```

The four side faces (`px`, `nx`, `pz`, `nz`) in the `FACES` table order their corners as `y=[0, 0, 1, 1]`. Combined with `vv = [v1, v1, v0, v0]`, world `y=0` corners sample `v1` (top of texture) and world `y=1` corners sample `v0` (bottom of texture). Net: side textures render upside-down.

Top (`py`) and bottom (`ny`) corners don't have the `y=0,0,1,1` pattern, so the same mapping applied there is just a UV rotation — visually fine on symmetric textures and not the subject of this fix.

### Bug 2 — `grass_block_top` renders untinted

Mojang ships `grass_block_top.png` as a **grayscale mask** that the game multiplies by a biome color at runtime. We don't tint, so the grey mask hits the screen directly. Of the 15 Phase 1 blocks, `grass_block_top` is the only one that requires tinting — `grass_block_side` already ships pre-tinted, and no other Phase 1 block uses a tinted texture.

## Approach

### Fix 1 — Per-face UV tables in the mesher

Replace the shared `uu`/`vv` arrays in `mesher.ts` with a `uvs` field on each `FACES[face]` entry:

```ts
// Each uvs[i] is [uIndex, vIndex] where 0=u0/v0, 1=u1/v1.
px: { corners: [...], uvs: [[0, 0], [1, 0], [1, 1], [0, 1]], ... },
```

Where `v0 = 1 - (rect.v + rect.h)/size` (bottom of tile after the Three.js V-flip) and `v1 = 1 - rect.v/size` (top of tile).

Side faces get `[[0,0],[1,0],[1,1],[0,1]]`, which maps world `y=0 → v0` (tile bottom) and world `y=1 → v1` (tile top) — the correct orientation.

Top and bottom faces keep their current UV mapping (equivalent to `[[0,1],[1,1],[1,0],[0,0]]`) to preserve orientation of directional textures such as `oak_log_top`.

The emission loop becomes:

```ts
for (let i = 0; i < 4; i++) {
    const [ui, vi] = f.uvs[i];
    uvs.push(ui === 0 ? u0 : u1, vi === 0 ? v0 : v1);
    // ... positions, normals, indices as before
}
```

### Fix 2 — Build-time texture tinting

Add a `TEXTURE_TINTS` map to `scripts/build-atlas.ts`:

```ts
const TEXTURE_TINTS: Record<string, [number, number, number]> = {
    grass_block_top: [0x79, 0xC0, 0x5A], // Minecraft plains-biome grass green
};
```

When compositing a tile whose name appears in the map, multiply each pixel's RGB by the tint (each channel × `component / 255`), preserving alpha. Applied before `padEdgeReplicate` so the pad border picks up the tinted edge.

Rationale for build-time over runtime tinting: zero runtime cost, no shader or vertex-attribute changes, and the one-biome Phase 1 world never needs per-block tint variation. A later move to runtime tinting (biomes, seasons) would be a self-contained change in `atlas.ts` + the material.

The map lives inline in `build-atlas.ts`. It's build-time asset metadata, not part of the runtime block catalog (which is the data-file invariant called out in `docs/specs.md` §10 and `CLAUDE.md`).

## Files touched

- `src/engine/world/mesher.ts` — per-face `uvs` field + updated emission loop
- `src/engine/world/mesher.test.ts` — add assertion that a side-face quad maps world `y=0 → v0` and world `y=1 → v1`
- `scripts/build-atlas.ts` — `TEXTURE_TINTS` map + tint application in the raw-pixel pass
- Regenerate `public/atlas.png` and `public/atlas.json` via `npm run build-atlas`

No changes to `src/data/blocks.data.ts` (already specifies per-face textures correctly) or `src/engine/render/atlas.ts` (already returns per-face UVs correctly).

## Testing

- **Unit:** extend `mesher.test.ts` with a fixture UV function that returns distinguishable `u0/v0/u1/v1` values, mesh a single opaque block, and assert that the `+X` face's bottom-edge vertices have V = `v0` and top-edge vertices have V = `v1`.
- **Existing:** all other mesher / atlas / data tests must still pass.
- **Visual:** run `npm run build-atlas && npm run dev`, place a grass block, confirm (a) side shows green strip at the top, (b) top face is green, (c) bottom is dirt. Compare against the before-screenshot.
- **No regression:** check `oak_log` — grain circles on `py`/`ny` should remain correctly oriented (not rotated); side bark should wrap naturally.

## Out of scope

- Runtime biome tinting / variable tint colors.
- Tinting for any texture beyond `grass_block_top` (no other Phase 1 block needs it; leaves etc. come in Phase 2).
- Greedy meshing, worker meshing, or any other mesher-performance work.
- Any change to the block catalog or hotbar UI.
