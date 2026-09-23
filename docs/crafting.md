# Crafting

Blocks he mines are counted; counts buy pickaxes and bigger TNT from the
**Craft** tab of the I screen. There is no crafting table: recipes resolve from
the counts. Design: `docs/superpowers/specs/2026-09-22-crafting-design.md`.

## Counts

- Per world, in `player.inventory` (block name → count). An absent key means
  "never touched" and reads as `STARTING_COUNT` (`src/data/crafting.data.ts`,
  `0`). A touched key is always written, zeros included, so raising the start
  value later cannot bring back blocks he used up.
- **+1** for every block his actions remove: single mining, each block of an
  area mine, each block a TNT blast destroys (chains included). Not counted:
  the detonating TNT's own cell and any TNT a blast primes (they go off
  themselves); liquid changes. A TNT removed by *mining* is counted.
- **−1** (never below 0) when a placement needed a count. Free placements never
  touch counts. Shift-replace: −1 of the placed block under the same rule, +1
  of the replaced block.
- All rules live in `src/game/inventory.ts`; placing goes through
  `tryPlace` in `src/game/place.ts`.

## "Must mine blocks to build"

A per-world checkbox on the New World screen, off by default and off for every
world made before crafting. Fixed for the life of the world.

In a must-mine world, a **counted** block at 0 cannot be placed (a soft
"nope"). Counted = what worldgen v3 actually writes (`WORLDGEN_BLOCKS`), minus
water, lava and bedrock, plus every recipe ingredient, plus the TNT outputs.
Everything else stays free.

**Why stone is counted but cobblestone is free:** worldgen writes stone and
never writes cobblestone, so stone is something he digs and cobblestone is a
building block. The same goes for planks, glass, wool and lamps. Every recipe
ingredient is counted even if worldgen rarely makes it (diamond ore,
deepslate emerald ore…), otherwise he could place a free ore and mine it back.

When a counted block goes from 0 to more than 0 by mining, it joins the
hotbar (Minecraft-like). It takes the first slot that is empty, else holds a
never-touched counted block, else holds a counted block at 0. It never takes
the selected slot and never replaces a free block.

**Big TNT and Mega TNT are crafted-only**: they need a count in *every* world
and show in the Blocks tab only when he has one. Plain TNT needs a count only
in must-mine worlds.

Unlimited worlds may farm counts (place an ore, mine it back). That is
accepted; it is also how old worlds without ores reach the high tiers.

## Pickaxes

| Tier | Name | Speed | Area (face × face × depth) | Recipe |
|---|---|---|---|---|
| 0 | Hand | — | 1 | always owned |
| 1 | Wood | +15 % | 1 | 8 logs (any `*_log`) |
| 2 | Stone | +50 % | 1 | 24 stone, 4 logs |
| 3 | Copper | +75 % | 1×1×2 | 16 copper ore, 32 stone |
| 4 | Iron | +100 % | 3×3×1 | 16 iron ore, 48 stone |
| 5 | Gold | +200 % | 3×3×2 | 16 gold ore, 8 redstone ore |
| 6 | Diamond | +500 % | 3×3×3 | 8 diamond ore, 6 lapis ore |
| 7 | Emerald | +1000 % | 5×5×5 | 3 emerald ore, 4 diamond ore, 32 deepslate |

"X ore" accepts `x_ore` and `deepslate_x_ore`; crafting takes the plain one
first. Any tier can be crafted without the ones below. A crafted pickaxe is
equipped at once. **P** (rebindable, "Switch Pickaxe") cycles the owned ones;
clicking one in the Blocks tab's pickaxe row, or the HUD pickaxe icon (which
opens I), works too.

Mining time is `hardness / (1 + bonus)` of the aimed block. From Copper up
(multi-block tiers) the highlight is an orange box around the whole area, and a
break takes at least 0.4 s when armed (button press, pickaxe switch, or aim
leaving the last area) and 0.25 s when held inside the last area.

## TNT tiers

| Block | Id | Radius | Fuse | Recipe |
|---|---|---|---|---|
| TNT | 15 | 3 | 2.5 s | 2 TNT from 5 sand, 4 coal ore |
| Big TNT | 1000 | 5 | 4 s | 2 TNT, 4 redstone ore |
| Mega TNT | 1001 | 8 | 6 s | 2 Big TNT, 4 lapis ore |

- Radius and fuse are the `tnt` field of the block's row
  (`BlockDef.tnt`). "Is TNT" is `tntSpec(id) !== null` everywhere.
- Both are fixed when the TNT is primed (lit with E, or reached by another
  blast). A chained TNT waits 0.1 s and explodes with **its own** radius.
- Big and Mega TNT are hand-written in `src/data/blocks.extra.data.ts` at ids
  from `EXTRA_ID_START = 1000`. They are not in `blocks.catalog.ids.json`, and
  `assignIds` refuses to generate an id that high, so a catalog regeneration
  can never collide with them. `BLOCKS` is tombstoned from the last catalog id
  to 999.
- Their textures are derived at build time (`src/data/atlas-derive.ts`): the
  three plain TNT faces, greyscale ×1.8, tinted orange (Big) or purple (Mega).
  The pickaxe icons are original 16×16 pixel art drawn from templates in the
  same file. `npm run build-atlas` writes all of them into `public/atlas.*`.

## The Craft tab

Ten cards, all on screen at 1280×720. Each shows the output, its ingredients
with `have / need` and a fill bar (red when short), and one big green button
(greyed when short). An owned pickaxe shows ✔ instead. Crafting plays a short
chime and sparkles the card. Crafted TNT goes to the hotbar slot already
holding it, else the first empty slot, else the selected slot; crafting never
triggers the must-mine auto-hotbar. The button's logic is `applyCraft`
(`src/game/craft-apply.ts`) and the card view-models are
`src/ui/craft-model.ts`, both pure and unit-tested; `npm run smoke:crafting`
checks the real screen.

## Adding a recipe

1. Add a row to `RECIPES` in `src/data/recipes.data.ts`:
   `{ id, output: { kind: 'block', name, count } | { kind: 'pickaxe', tier }, needs: [{ anyOf: [...names], count }] }`.
2. Every `anyOf` name becomes counted automatically; a test fails if a name is
   not a block. A block output that should be crafted-only must not be a
   worldgen block.
3. A new block output needs a block row. Hand-written rows go in
   `blocks.extra.data.ts` at the next id from 1000 up (never renumber); a
   derived texture goes in `DERIVED_TEXTURES`.
4. A new pickaxe tier also needs a `PICKAXES` row, a head colour in
   `PICKAXE_HEAD`, and `MAX_PICKAXE_TIER` raised (the API already accepts tiers
   0–15).
5. The Craft tab is laid out for 10 cards in a 5-column grid; an 11th starts a
   third row. Re-check the 1280×720 no-scroll check in the smoke.
