# Minicraft — Specs

Status: **committed** as of 2026-04-20. Source of truth for stack and architecture. Update this file when a decision changes; don't let the code silently drift.

## 1. Purpose

A minimal Minecraft-style voxel sandbox for the author's 7-year-old son. Deployed as a static web bundle behind Cloudflare on a private subdomain. Single-player, no mobs, no survival mechanics — mine and place blocks, and that's it.

Primary target environment: **Ubuntu + Chrome + desktop GPU**. Other browsers/OSes are not supported in Phase 1.

Acceptance test for "done enough to ship to Noah": hand him the laptop, he places a block within 30 seconds, builds something within 5 minutes, reloads tomorrow and the world is still there.

## 2. Scope

### Must-haves (Phase 1)
- Deterministic world generation from a seed
- Mine and place blocks, first-person
- Save / Load to `localStorage` behind a narrow `PersistenceAdapter` interface
- Options: "basic blocks" vs "all blocks" as a filter over one catalog; remappable keybindings
- New block = one row in `blocks.data.ts` — no cross-file edits

### Non-goals (do not design for these, ever)
Mobs, combat, health, hunger, damage, multiplayer, networking gameplay, day/night affecting gameplay, weather, redstone, command blocks, automation, farming, mods, custom resource packs, progression, achievements, iPad/touch controls, Safari, Firefox parity.

## 3. Tech Stack

| Concern | Choice | Why |
|---|---|---|
| Language | **TypeScript** | Catches block-id / chunk-coord bugs at compile time |
| Build | **Vite** | Static output, fast dev HMR, zero-config TS |
| Rendering | **Three.js on WebGL2** | See note below |
| UI overlay | Plain HTML + CSS | Hotbar / menu don't warrant React or Vue |
| PRNG | `alea` | Seedable, deterministic, small |
| Noise | `simplex-noise` (jwagner) | Fast, dependency-free |
| Save validation | `zod` (optional) | Guards against corrupted save blobs |
| Testing | **Vitest** | Vite-native |
| Lint / format | ESLint + Prettier | Standard |
| Physics | none — hand-rolled AABB | A physics lib is overkill for voxel collision |

### Why WebGL2, not WebGPU or raw WebGL
- The expected bottleneck at this scope is **JS-side** (mesh rebuild, chunk scheduling), not GPU submission. WebGPU's compute advantages don't apply until we do GPU-side meshing or heavy particles — not on the roadmap.
- Three.js's WebGPU backend is still maturing; WebGL2 is the battle-tested path.
- Raw WebGL trades a 2× dev-time cost for perf headroom we don't need.
- Revisit only if profiling shows GPU-bound frames.

## 4. Voxel Architecture

### World
- **Finite**, 32 × 32 chunks horizontal = **512 × 512 blocks**. Bigger than a kid will explore; bounds localStorage usage.
- Out-of-bounds is a hard wall (no infinite generation).

### Chunks
- **16 × 64 × 16** blocks (height capped at 64 — quarter the memory of vanilla, still plenty of vertical room for a kid).
- Storage: **`Uint8Array(16384)`** per chunk (256 block IDs is enough for Phase 1 and Phase 2; upgrade to `Uint16Array` only if we exceed it).
- Coordinate convention: Y is up. Chunk coords are `(cx, cz)`; block coords within a chunk are `(x ∈ 0..15, y ∈ 0..63, z ∈ 0..15)`.

### Meshing
- **Naive per-face culling** — a face is emitted only when its neighbor is air or a transparent block.
- Implemented as a **pure function** `(chunkData, neighbors) => BufferGeometry`, so it's worker-portable later without refactor.
- A chunk is meshed only when all 4 horizontal neighbors are loaded. Edge chunks re-mesh when a neighbor loads to avoid seam artifacts.
- One `BufferGeometry` per chunk, one `Material` shared across all chunks (backed by the atlas).
- Greedy meshing is explicitly **deferred** until profiling demands it.

### Raycasting (block picking)
- **DDA voxel traversal (Amanatides & Woo)**, not `THREE.Raycaster` against mesh geometry.
- Faster, and it gives us the exact voxel coordinate and hit face without mesh-to-voxel back-conversion.

### Textures / Atlas
- **Do not load 1,083 PNGs at runtime.** Phase 1 ships ~15 hand-picked blocks. Phase 2 adds a second atlas for "all blocks" mode.
- A single **512 × 512 atlas** is built offline by `scripts/build-atlas.ts`, emitting `public/atlas.png` and `public/atlas.json` (UV lookup table keyed by block id + face).
- Each tile is padded with a **2 px edge-replicated border** to prevent bleed under mipmapping at chunk boundaries.
- `NearestFilter` for magnification, `NearestMipMapLinearFilter` for minification, `generateMipmaps: true`.

### Determinism
- All randomness in world generation flows through the seeded `alea` PRNG. **`Math.random()` is banned in generation code.**
- Enforced by a unit test that hashes a known-seed world and compares to a committed reference hash.

### Collision
- Hand-rolled swept AABB against the voxel grid. Gravity, jump, walk speed as constants in `engine/physics/`.

## 5. Persistence

### Interface
```ts
interface PersistenceAdapter {
    loadWorld(seed: number): Promise<WorldSave | null>;
    saveWorld(save: WorldSave): Promise<void>;
    listWorlds(): Promise<WorldSummary[]>;
    deleteWorld(seed: number): Promise<void>;
}
```
Async on purpose, even for `localStorage` — the Phase 2 remote swap must be a local change.

### Phase 1 implementation
- Backend: `localStorage`.
- Key scheme: `minicraft:v1:world:{seed}:meta`, `minicraft:v1:world:{seed}:chunk:{cx}:{cz}`.
- **Only modified chunks are persisted.** Untouched chunks regenerate from the seed.
- Chunk payload: RLE-encode the `Uint8Array`, `deflate`, base64. Typical modified chunk → sub-kilobyte.
- Auto-save is **debounced to ~5 s** and also fires on `blur` / `visibilitychange`.
- Wrap writes in try/catch — `QuotaExceededError` is real; on quota failure, surface a UI warning and stop auto-save until resolved.

## 6. Module Structure

```
src/
    assets/blocks/            # raw Mojang PNGs (source for atlas build)
    data/
        blocks.data.ts        # block catalog — one row per block
        recipes.data.ts       # Phase 2 — crafting recipes as data
    engine/
        world/
            world.ts          # world state, chunk registry, load/evict
            chunk.ts          # Uint8Array + dirty flag
            generation.ts     # deterministic terrain from seed
            mesher.ts         # pure (chunk, neighbors) => BufferGeometry
        render/
            renderer.ts       # three.js setup, frame loop
            atlas.ts          # atlas.json load, UV lookup
            camera.ts         # first-person camera rig
        physics/
            collision.ts      # swept AABB vs voxel grid
        input/
            controls.ts       # pointer lock, keybinding dispatch
            raycast.ts        # DDA voxel raycast
    game/
        player.ts             # player state, hotbar selection
        actions.ts            # mine / place operations
        loop.ts               # per-frame tick
    persistence/
        adapter.ts            # PersistenceAdapter interface
        localStorage.ts       # Phase 1 adapter
        codec.ts              # RLE + deflate + base64
    ui/
        hud.ts                # hotbar overlay
        menu.ts               # main menu (New / Continue / Options)
        options.ts            # keybinding + kid-mode UI
    main.ts                   # entry point
scripts/
    build-atlas.ts            # offline atlas builder (node-canvas or sharp)
public/
    atlas.png
    atlas.json
docs/
    specs.md                  # this file
```

**Invariants enforced by the layout:**
- `data/` is the *only* place block definitions or recipes live. Adding a block edits one row there.
- `persistence/adapter.ts` is the *only* seam the rest of the code imports. Swapping to a remote backend in Phase 2 means adding a new file in `persistence/` and changing one wiring call in `main.ts`.
- `engine/` is framework-agnostic voxel logic; `game/` wires it to player intent; `ui/` is pure DOM overlay. No upward imports.

## 7. Phase Plan

### Phase 1 — MVP (ship to Noah)
- Single 32×32-chunk world, 2D simplex heightmap, grass / dirt / stone layering. No caves, trees, or ores.
- ~15 blocks: grass, dirt, stone, cobblestone, sand, oak planks, oak log, glass, 6 wool colors.
- First-person camera, WASD + mouse, space to jump. No sprint, no crouch.
- Left-click mines (instant, no tool tiers). Right-click places. DDA raycast.
- 9-slot hotbar, 1–9 to select. **Hotbar IS the inventory** in Phase 1. Infinite stacks.
- Auto-save every 5 s + on tab blur → `localStorage`.
- Main menu: New World / Continue / Options (kid-mode toggle, keybindings).
- No sound, no music, no crafting UI.

### Phase 2
- Crafting as data (`recipes.data.ts`) + pure resolver, triggered from hotbar. No crafting table.
- "All blocks" mode with a second atlas.
- Trees, ores, caves in generation.
- Remote persistence adapter (likely GCP Cloud Run endpoint).
- Block place / break sounds.

### Phase 3 or never
- Greedy meshing (only if profiling demands it)
- Web-worker meshing (only if main thread stalls)
- WebGPU backend (only if it wins on desktop Chrome + GPU and Three.js backend is stable)
- Touch controls / iPad (gate touch devices with "please use a laptop")

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Texture bleed at chunk seams | 2 px edge-replicated padding + `NearestFilter` + mipmaps |
| `localStorage` quota | Persist only modified chunks; RLE + deflate; wrap in try/catch; UI warning on quota |
| Non-determinism sneaks into generation | PRNG-only policy + committed-hash unit test |
| Mesh rebuild stalls on block edit | Mesher is pure; dirty-flag a chunk and re-mesh next frame. Phase 1 main-thread is fine; Phase 3 worker migration is pre-designed |
| Mojang asset licensing | Subdomain must be **gated (password or unlisted)** before any public DNS record. These textures are personal-use only |
| Scope creep | Non-goals list in §2 and `CLAUDE.md`; every new feature is checked against a phase |

## 9. Deployment

Static bundle from `vite build` → upload to a **GCP Cloud Storage** bucket configured for static hosting → fronted by **Cloudflare** on a private subdomain. No server in Phase 1. Phase 2's remote persistence endpoint is a separate concern (likely Cloud Run + Firestore or a minimal KV) and does not affect the static bundle.

**Gate the subdomain.** Either HTTP basic auth at the Cloudflare edge, or an unlisted URL, until the Mojang textures are replaced with original or licensed art.

## 10. Coding Conventions

- 1 tab = 4 spaces (from `/home/julien/Projects/CLAUDE.md`).
- `strict: true` in `tsconfig.json`. No `any` without a `// eslint-disable-next-line` and a reason.
- No comments explaining *what* code does — only *why*, when the why is non-obvious.
- Data files (`*.data.ts`) are pure exports, no logic.

## 11. Playtest Checklist

Before handing the laptop to Noah:

- [ ] `npm run build-atlas && npm run build && npm run preview` runs clean
- [ ] Main menu shows; "New World" creates a world in under 2 seconds
- [ ] Walking feels responsive; no falling through ground, no stuck-in-wall
- [ ] Mining works on left click; placing on right click; crosshair aligned with hit
- [ ] Hotbar 1–9 keys select correct slot; placed block matches selection
- [ ] Save survives reload: close tab, reopen, Continue restores world + position
- [ ] Options: kid-mode toggle persists across reloads; keybinding rebinding persists
- [ ] No console errors in Chrome devtools during 5 minutes of play
- [ ] World edges: player is blocked at x=0 and x=512 (and z same) — no infinite fall

If any box fails, the bug belongs in a new task or a Phase 1 fix before ship.
