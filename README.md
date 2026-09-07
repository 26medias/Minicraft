# Minicraft

A deliberately minimal, kid-friendly Minecraft-style voxel sandbox for the browser. Built for Noah (7 years old) who loves Minecraft but doesn't need the mobs, combat, survival, or menus — just mining and building.

## What this is

Minicraft is a single-player, creative-only voxel sandbox. The whole point is what it *doesn't* do. There are no enemies, no health, no hunger, no day/night mechanics, no networking, no crafting tables, no mods. The entire loop is: walk around, mine blocks, place blocks. The game ships as a static web bundle.

Current catalog: 19 hand-written blocks (grass, dirt, stone, cobblestone, sand, oak planks, oak log, glass, 6 wool colors, TNT, lamp, water, lava) plus about 350 solid-cube blocks from Minecraft 1.21.6, picked from an I-key inventory (whole cubes only — no stairs, slabs, doors or flowers). Gameplay toys on top of place/mine: TNT with chain-reaction explosions, coloured lamps that emit point-light illumination, and water/lava with simple block-by-block flow, and a sponge that soaks them back up.

## Tech Stack

- **Language:** TypeScript (strict).
- **Build:** [Vite](https://vitejs.dev/) → static bundle.
- **Rendering:** [Three.js](https://threejs.org/) on WebGL2. One opaque mesh + one liquid mesh per chunk, shared atlas material. No shadow map — all illumination is baked into per-vertex colors from a voxel light propagation pass.
- **Lighting:** per-voxel skyLight + RGB blockLight, packed into a 16-bit nibble-array per chunk; BFS flood-fill with filter-based attenuation; smooth per-vertex interpolation with classic ambient occlusion.
- **PRNG:** [`alea`](https://github.com/davidbau/seedrandom) (seeded, deterministic).
- **Noise:** [`simplex-noise`](https://github.com/jwagnerr/simplex-noise.js).
- **Persistence:** `localStorage` via a narrow `PersistenceAdapter` interface (Phase 2 will swap to a remote backend without touching callers). Chunks are RLE + deflate + base64 encoded.
- **Compression:** [`pako`](https://github.com/nodeca/pako).
- **Physics:** hand-rolled swept-AABB voxel collision with sub-stepping — no physics library.
- **Textures:** Mojang's block PNGs atlased at build time via [`sharp`](https://sharp.pixelplumbing.com/). Select textures are biome-tinted in the build step (grass top: green; leaves: green; water: blue).
- **Tests:** [Vitest](https://vitest.dev/) — unit tests covering the mesher, physics, world generation determinism, block catalog, player state (including fly + swim mode), TNT detonation, the play-time timer, the light registry, voxel lighting propagation (sky + RGB block light, incremental updates, AO), and the liquid scheduler (fall rule, sideways spread, frontier decay, sponge absorption), and persistence (v1/v2 formats, cloud + dual adapters, autosave failure handling, and the worlds API).
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
- **W / A / S / D** — walk (on ground) or fly/swim in the direction you're looking (in fly or swim mode).
- **Space** — jump. Works when grounded, and also while wading (feet in liquid, head above) to clear the shore.
- **F** — toggle fly mode.
- **=** / **-** — increase / decrease fly speed (5 tiers; 5 pips above the hotbar show current speed).

In fly or swim mode: pitch the camera up to ascend, down to descend — W moves in the full 3D look direction. Strafe stays horizontal. Space has no effect during fly/swim. Swim mode engages automatically when the eye is inside a liquid voxel; gravity resumes as soon as the head breaks the surface.

### Interaction
- **Left click (hold)** — mine the block in the crosshair. Each block has its own hardness; a progress ring around the crosshair shows the mine time. Mining a liquid block (hardness 0) is instant.
- **Right click** — place the currently selected block on the face you're aiming at. Placing a liquid mid-air lets it fall to the ground; placing it on a surface lets it spread.
- **Shift + Right click** — replace the block you're aiming at with the selected one (instead of building next to it).
- The face you're aiming at is highlighted when it's close enough to reach.
- **1..9** — select a hotbar slot directly.
- **Tab** / **Shift+Tab** — cycle through hotbar slots.
- **I** — open / close the block inventory.
- **E** — ignite TNT in the crosshair. A pulsing red overlay appears during the fuse (~2.5s); other TNT caught in the blast chain-primes with a short delay for satisfying cascades. Mining a primed TNT before it blows cancels the fuse.
- **C** — open the light-color picker (20-tile pastel palette). If you're aimed at a lamp block when you press C, selecting a color recolors *that* lamp and sets the default for future placements. If you're not aimed at a lamp, the color becomes the default.

### Menu
- **Esc** — exit pointer-lock (you leave the game to the browser but the world keeps running).
- Back on the main menu you can create new worlds, continue existing ones, delete them, and remap keys via **Options**.

## Features

- **Deterministic world generation** from a seed (2D simplex heightmap, flattened to a 10-block amplitude around sea level 28). Columns below sea level fill with water; their top block is sand.
- **Bounded world:** 32×32 chunks (512×512 blocks), hard walls at the edges. Chunks are 16×64×16.
- **Per-face texture atlas**, built offline and edge-replicated to avoid mipmap bleed.
- **Build-time texture tinting:** grass top and leaves get plains-biome green, water_still gets plains-biome blue. One line per tint in `scripts/build-atlas.ts`.
- **Voxel light propagation.** Per-voxel `skyLight` + RGB `blockLight`, packed into a 16-bit per-voxel nibble array. BFS flood-fill attenuates by each block's `lightFilter` value. Sunlight streams down open shafts unattenuated; lamps and lava seed coloured light outward. On every mine/place/TNT edit, an incremental update re-floods only the affected region. Caves go genuinely dark; overlapping lamps of different colours blend per-channel. See [`docs/lighting.md`](docs/lighting.md).
- **Smooth lighting + ambient occlusion.** Each vertex samples 4 surrounding voxels; corners next to solid neighbours darken (0.75, or 0.6 with a diagonal block) for the classic Minecraft corner-inset look.
- **Water and lava.** Both are placeable from the hotbar, both are translucent non-solid blocks. Water tints the world blue underneath it; lava emits an orange-red glow (level 12) and is slightly more opaque (lightFilter 3 vs water's 2). Flow rule: every 0.5s, each liquid voxel falls if the space below is air, otherwise spreads sideways to adjacent air. See [`docs/liquids.md`](docs/liquids.md).
- **Sponge.** Place a sponge next to water or lava and it soaks up everything connected within 7 blocks, then turns into a wet sponge. Mine it and the hole stays dry; place a fresh one to soak more. The middle of a big pool stays empty because water only creeps back 4 blocks from its edges.
- **Swim mode.** Engages automatically when the player's eye is inside a liquid voxel. Gravity is disabled; WASD moves in the full 3D look direction at 60% walk speed. Space is redundant while fully submerged but re-enables at the surface for a "jump out of the water" moment. See [`docs/movement.md`](docs/movement.md).
- **Cursor-directed flight.** Same 3D motion model as swim, at the fly-speed tier's multiplier. `=` / `-` step through 5 speed tiers.
- **Mining state machine:** hardness-driven duration, crosshair progress ring, cancels when you look away.
- **TNT** with 3-block-radius explosions, chain reactions (short delay between detonations), and a pulsing red "primed" overlay. Safe for the player — no damage, no knockback.
- **Lamp blocks** emit coloured light that propagates through the voxel light grid. Each lamp stores its own color; colors persist across save/reload.
- **Color picker** with 20 kid-friendly pastel colors (5×4 grid), keyboard-triggered, click-to-cancel backdrop.
- **Block inventory** (I): every solid-cube block from Minecraft 1.21.6 (~350), grouped; click to fill the selected hotbar slot. Whole cubes only — no stairs, slabs, doors, flowers. 9-slot hotbar saved per world. See [docs/inventory.md](docs/inventory.md).
- **Auto-save** every ~5s and on window blur / tab hide, to `localStorage`. Only modified chunks are persisted; untouched chunks regenerate from the seed. Lights are recomputed from blocks on load (not stored). Primed-TNT fuse state is intentionally not saved (resets to inert on reload).
- **Rebindable keys** via the in-game Options menu. Unknown / deprecated keybindings in old save files are silently dropped at load time so stale mappings can't shadow current actions.
- **Play-time limit** for grown-ups: on the main menu, *Play for* 15–90 minutes, optionally *Then break for* 10–60 minutes. Large `END IN 5 MINUTES` / `END IN 2 MINUTES` warnings, then `TIME'S UP` freezes the game; a break counts down to a `PLAY AGAIN` button, or without a break the game stays locked until a grown-up presses *Unlock* on the menu. Only visible play counts (a closed lid is not play time); breaks are wall-clock. There is no PIN: the Unlock button is on the same menu the kid uses, so this limits an honest kid, not a determined one. A lock always clears itself 12 hours after the game was last touched. To unlock early: reload the game's tab, press *Unlock*, pick the world. See [`docs/playtime.md`](docs/playtime.md).

## Project layout

```
src/
  assets/blocks/          # raw Mojang PNGs (source for the atlas build)
  data/                   # pure-data modules — block catalog, keybindings, color palette
    blocks.base.data.ts   # hand-written base rows (ids 0-19, frozen)
    blocks.catalog.data.ts # generated Minecraft catalog (do not hand-edit)
    blocks.catalog.ids.json # frozen generated ids (never renumbered)
  engine/
    input/                # pointer-lock + DDA voxel raycast
    physics/              # swept-AABB voxel collision
    render/               # Three.js renderer, atlas loader, particle system, mining overlay, light registry
    world/                # chunk storage (blocks + lightmap), world generation, mesher, lighting BFS
  game/                   # player, actions, per-frame game loop, TNT detonation, liquid flow scheduler
  persistence/            # WorldSave shape, localStorage adapter, chunk codec, autosave, options
  ui/                     # HUD, main menu, options menu, color picker
scripts/
  build-atlas.ts          # offline atlas builder (sharp)
  gen-catalog.ts          # reads the Minecraft jar, emits the generated catalog
docs/
  specs.md                # architectural decisions (source of truth for tech stack)
  inventory.md            # block inventory, catalog regeneration, 16-bit ids
  lighting.md             # voxel light propagation algorithm + rendering
  liquids.md              # water/lava blocks + flow scheduler
  movement.md             # walk / fly / swim state machine
  superpowers/            # per-feature design docs + plans
```

## Extensibility notes

- **Adding a block** is one row in `src/data/blocks.base.data.ts` (hand rows) or a regeneration via `npm run gen-catalog` (Minecraft blocks). The atlas builder and hotbar pick it up automatically. New fields `lightLevel` (0-15 emission) and `lightFilter` (0-15 attenuation) drive the lighting system; `liquid: 'none' | 'water' | 'lava'` flags liquids.
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
- Water-on-lava → stone / cobblestone conversion; fluid levels / partial fill / pressure; bucket item; underwater fog tint or breathing / drowning mechanics.

## Assets

Block textures in `src/assets/blocks/` are Mojang's, extracted from a local Minecraft 1.21.6 install for personal/family use. They are not redistributed. If the project ever gains a public face, these will be replaced with original or properly-licensed art.

## License

Source code: TBD. Assets: not licensed for redistribution (see above).
