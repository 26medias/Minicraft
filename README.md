# Minicraft

A deliberately minimal, kid-friendly Minecraft-style voxel sandbox for the browser. Built for Noah (7 years old) who loves Minecraft but doesn't need the mobs, combat, survival, or menus — just mining and building.

## What this is

Minicraft is a single-player, creative-only voxel sandbox. The whole point is what it *doesn't* do. There are no enemies, no health, no hunger, no day/night mechanics, no networking, no crafting tables, no mods. The entire loop is: walk around, mine blocks, place blocks. The game ships as a static web bundle.

Current catalog: 17 blocks (grass, dirt, stone, cobblestone, sand, oak planks, oak log, glass, 6 wool colors, TNT, lamp) with a "kid mode" filter that hides anything marked not-for-kids. Two gameplay toys on top of place/mine: TNT with chain-reaction explosions, and coloured lamps that emit point-light illumination.

## Tech Stack

- **Language:** TypeScript (strict).
- **Build:** [Vite](https://vitejs.dev/) → static bundle.
- **Rendering:** [Three.js](https://threejs.org/) on WebGL2. One mesh per chunk, shared atlas material, sun shadow mapping.
- **PRNG:** [`alea`](https://github.com/davidbau/seedrandom) (seeded, deterministic).
- **Noise:** [`simplex-noise`](https://github.com/jwagnerr/simplex-noise.js).
- **Persistence:** `localStorage` via a narrow `PersistenceAdapter` interface (Phase 2 will swap to a remote backend without touching callers). Chunks are RLE + deflate + base64 encoded.
- **Compression:** [`pako`](https://github.com/nodeca/pako).
- **Physics:** hand-rolled swept-AABB voxel collision with sub-stepping — no physics library.
- **Textures:** Mojang's block PNGs atlased at build time via [`sharp`](https://sharp.pixelplumbing.com/). Some textures are tinted in the build step (e.g., `grass_block_top`).
- **Tests:** [Vitest](https://vitest.dev/) — 88 unit tests covering the mesher, physics, world generation determinism, block catalog, player state (including fly mode), TNT detonation, and the light registry.
- **Lint / format:** ESLint + Prettier.

## Prerequisites

- Node 20+ (LTS).
- A Chromium-based browser for playtesting (the game targets desktop Chrome on WebGL2). Firefox and Safari are untested.

## Install

```bash
git clone <repo-url>
cd Minicraft
npm install
```

## Run (dev server)

```bash
npm run dev
```

Opens a Vite dev server on `http://localhost:5173/` with HMR. Click the canvas to lock the pointer and start playing.

## Build (static production bundle)

```bash
npm run build
```

Produces `dist/` with the static files (HTML, JS, CSS, `atlas.png`, `atlas.json`). Serve with any static file host. For quick local preview:

```bash
npm run preview
```

The atlas is rebuilt automatically before each production build. If you add a block and want to regenerate the atlas without a full build, run:

```bash
npm run build-atlas
```

## Test

```bash
npm test         # vitest run (one-shot, CI-style)
npm run lint     # ESLint
```

## How to play

Click the canvas first to capture the mouse pointer.

### Movement
- **W / A / S / D** — walk.
- **Space** — jump (walking) or ascend (flying).
- **Shift** (left) — descend while flying.
- **F** — toggle fly mode.
- **=** / **-** — increase / decrease fly speed (5 tiers; 5 pips above the hotbar show current speed).

### Interaction
- **Left click (hold)** — mine the block in the crosshair. Each block has its own hardness; a progress ring around the crosshair shows the mine time.
- **Right click** — place the currently selected block on the face you're aiming at.
- **1..9** — select a hotbar slot directly.
- **Tab** / **Shift+Tab** — cycle through hotbar slots.
- **E** — ignite TNT in the crosshair. A pulsing red overlay appears during the fuse (~2.5s); other TNT caught in the blast chain-primes with a short delay for satisfying cascades. Mining a primed TNT before it blows cancels the fuse.
- **C** — open the light-color picker (20-tile pastel palette). If you're aimed at a lamp block when you press C, selecting a color recolors *that* lamp and sets the default for future placements. If you're not aimed at a lamp, the color becomes the default.

### Menu
- **Esc** — exit pointer-lock (you leave the game to the browser but the world keeps running).
- Back on the main menu you can create new worlds, continue existing ones, delete them, and remap keys via **Options**.

## Features

- **Deterministic world generation** from a seed (2D simplex heightmap + layered grass / dirt / stone).
- **Bounded world:** 32×32 chunks (512×512 blocks), hard walls at the edges. Chunks are 16×64×16.
- **Per-face texture atlas**, built offline and edge-replicated to avoid mipmap bleed.
- **Grass blocks** render with proper per-face textures and a plains-biome green tint baked at atlas build time.
- **Mining state machine:** hardness-driven duration, crosshair progress ring, cancels when you look away.
- **Fly mode** with 5 speed tiers, HUD pip meter, and collision still enforced.
- **TNT** with 3-block-radius explosions, chain reactions (short delay between detonations), and a pulsing red "primed" overlay. Safe for the player — no damage, no knockback.
- **Lamp blocks** emit coloured `THREE.PointLight`s. Each lamp stores its own color; colors persist across save/reload.
- **Color picker** with 20 kid-friendly pastel colors (5×4 grid), keyboard-triggered, click-to-cancel backdrop.
- **Sun shadow mapping** (`PCFShadowMap`, 4K depth texture, player-following frustum) so caves and overhangs darken naturally. Known limitation: on pure voxel geometry, residual leak artifacts at sharp concave corners underground — a future revision will replace the sun shadow with per-voxel light propagation.
- **Hotbar as inventory** — digits and Tab cycling, no separate inventory screen.
- **Auto-save** every ~5s and on window blur / tab hide, to `localStorage`. Only modified chunks are persisted; untouched chunks regenerate from the seed. Primed-TNT fuse state is intentionally not saved (resets to inert on reload).
- **Kid mode** filter that shows only a curated block set in the hotbar.
- **Rebindable keys** via the in-game Options menu.

## Project layout

```
src/
  assets/blocks/          # raw Mojang PNGs (source for the atlas build)
  data/                   # pure-data modules — block catalog, keybindings, color palette
  engine/
    input/                # pointer-lock + DDA voxel raycast
    physics/              # swept-AABB voxel collision
    render/               # Three.js renderer, atlas loader, particle system, mining overlay, light registry
    world/                # chunk storage, world generation, mesher
  game/                   # player, actions, per-frame game loop, TNT detonation
  persistence/            # WorldSave shape, localStorage adapter, chunk codec, autosave, options
  ui/                     # HUD, main menu, options menu, color picker
scripts/
  build-atlas.ts          # offline atlas builder (sharp)
docs/
  specs.md                # architectural decisions
  superpowers/            # per-feature design docs + plans
```

## Extensibility notes

- **Adding a block** is one row in `src/data/blocks.data.ts`. The atlas builder and hotbar pick it up automatically.
- **Adding a rebindable keybinding** is one entry in each of `Action`, `ACTIONS`, `ACTION_LABEL`, `DEFAULT_KEYBINDINGS` in `src/data/keybindings.data.ts`. The Options UI surfaces it without further changes.
- **Changing the color palette** is editing `src/data/light-palette.data.ts`.
- **Tinting a texture at build time** is one row in the `TEXTURE_TINTS` map in `scripts/build-atlas.ts`.

## Non-goals

Explicitly out of scope forever:

- Mobs, combat, health, hunger, damage.
- Multiplayer / networking gameplay.
- Survival pressure (day/night, weather, starvation).
- Redstone, command blocks, automation.
- Crafting table UI (crafting, if added, resolves directly from inventory).
- Mod loading / custom resource packs.
- Achievements, quests, progression systems.
- Touch / iPad / Safari / Firefox support in Phase 1.

## Assets

Block textures in `src/assets/blocks/` are Mojang's, extracted from a local Minecraft 1.21.6 install for personal/family use. They are not redistributed. If the project ever gains a public face, these will be replaced with original or properly-licensed art.

## License

Source code: TBD. Assets: not licensed for redistribution (see above).
