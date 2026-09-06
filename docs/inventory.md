# Block inventory

Press **I** (rebindable) to open the inventory: every solid-cube block the
family's Minecraft 1.21.6 install has textures for, grouped (BASICS, WOOD,
STONE, …). Click a tile to put it in the selected hotbar slot; digits and Tab
change the slot while it is open; Esc or I closes it. The 9-slot hotbar is
saved with each world. Saves from before the inventory come up with the
default bar once.

Only whole cubes are listed. No stairs, slabs, fences, doors, torches,
flowers, glass panes, chests, beds, signs, candles or shulker boxes: the engine
draws unit cubes only. Blocks with a face (furnace, jack o'lantern) always
face north. Waxed copper and infested stone are not listed; they look identical
to the plain block.

## Regenerating after a Minecraft update

1. Extract the new textures (skip `.mcmeta`):
   `unzip -o -j ~/.minecraft/versions/<v>/<v>.jar 'assets/minecraft/textures/block/*.png' -d src/assets/blocks/`
2. `MINECRAFT_JAR=~/.minecraft/versions/<v>/<v>.jar npm run gen-catalog`.
   Ids are frozen in `src/data/blocks.catalog.ids.json`; a block that no
   longer resolves is a hard error. Retire it deliberately with
   `npm run gen-catalog -- --retire <name>`; its id becomes a tombstone that
   renders as nothing and is never reused.
3. `npm test`, then `npm run build` (the atlas is rebuilt by `prebuild`).
4. `git add` the three generated files (`blocks.catalog.data.ts`,
   `blocks.catalog.ids.json`, and any new textures), update the version
   string in README/CLAUDE.md, deploy the API, then the site by hand with
   cache-control (Cloudflare caches `/minicraft/` separately from
   `index.html`), then reload the game once on Noah's laptop.

## 16-bit block ids and deploy order

Chunks store `Uint16Array` ids; the save codec writes each run as
`[varint id, varint run]`, byte-identical to the old byte codec for ids < 128,
so old saves load unchanged. **Deploy the API before the site**
(`./deploy.sh`, then `./deploy.sh --verify` must print `codec 2`): the old
server refuses any chunk containing an id ≥ 128. A browser still running an
old bundle cannot open a world that contains a new block: the world is intact;
the fix is a hard refresh (Ctrl+Shift+R) so the new bundle loads.

## Rendering notes

- Stained glass, tinted glass and ice render in a third front-face
  translucent pass (`translucent: true`). Honey and slime are two-element
  models and are not listed.
- Leaves are cutouts with `lightFilter: 0`; see `docs/lighting.md`.
- Animated textures show frame 0.
- The atlas is 1024 px with 32 px cells so mip levels do not bleed neighbours.
