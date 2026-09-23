# Crafting

Blocks he mines are counted; counts buy pickaxes, bigger TNT and toys from the
**Craft** tab of the I screen. There is no crafting table: recipes resolve from
the counts. Design: `docs/superpowers/specs/2026-09-22-crafting-design.md`; the
toys: `docs/superpowers/specs/2026-09-23-toys-design.md`.

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

**Big TNT, Mega TNT and every toy are crafted-only** (`CRAFTED_ONLY`): they
need a count in *every* world and show in the Blocks tab only when he has one.
Plain TNT needs a count only in must-mine worlds.

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
(multi-block tiers) every block the break will remove gets a faint self-lit orange
glow (air, liquids and bedrock in the area get none; it shows in caves too), and a
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

## Toys

Seven crafted-only blocks, hand-written in `blocks.extra.data.ts` at ids
1002–1008 (never renumber). None changes saves or the API: counts are keyed by
name. Blocks a toy **removes** are counted like any blast; blocks it **builds**
(dome glass, lake water) are free; a used-up toy and its own cell are never
counted.

| Toy | Id | What it does | Recipe |
|---|---|---|---|
| Slime Pad | 1002 | Bounces him back up | 2 from 4 moss block, 2 clay |
| Launch Pad | 1003 | Throws him ~25 blocks straight up | 1 Slime Pad, 4 redstone ore |
| Fireworks | 1004 | A rocket and a burst of sparkles; changes no block | 3 from 1 sand, 2 coal ore |
| Tunnel TNT | 1005 | A 3 × 3 tunnel, 24 long, the way he faces | 2 TNT, 8 iron ore |
| Block Bomb | 1006 | A glass dome (radius 5) in the air around it | 2 TNT, 8 sand |
| Flattening TNT | 1007 | Clears a radius-6 disc, 13 high, down to a flat floor | 2 Big TNT, 16 stone |
| Lake TNT | 1008 | A radius-4 crater that fills with water | 2 TNT, 4 ice |

**Pads** (`src/game/pads.ts`, hooked into `Player.update`). The pad is the
block under the **centre** of his feet, even when he straddles two blocks.
- *Slime Pad*: a landing faster than 3 blocks/s bounces him with 0.8 of the
  speed, so a 10-block drop comes back about 6 blocks and settles after a few
  bounces. Holding jump works like a trampoline: every bounce grows, up to an
  8-block rise.
- *Launch Pad*: standing on it throws him straight up (`LAUNCH_VY`, a 25-block
  rise), jump held or not. Landing back on the same pad does nothing until his
  feet have left its column: step off, step on, fly again.
- **Shift** is sneak: held, neither pad fires. It is not rebindable (like Tab)
  and has its own listener in `main.ts`; closing I, the freeze and resuming
  clear it.

**Blast toys** share one chain rule: a TNT-kind block inside the shape is
primed, never removed or counted; the detonating toy's own cell is always
removed. The Flattening TNT clears from its own height up 12 blocks, so if he
stands on a hill above one it drops him up to 12 blocks. That is harmless: there
is no fall damage.

Textures: the Slime Pad uses Mojang's `slime_block`; the others are derived in
`DERIVED_TEXTURES` (the Launch Pad is slime tinted red; the blast toys are TNT
tinted green, cyan, blue, white and magenta).

## The Craft tab

Three icon tabs, each with 10 cards or fewer, all on screen at 1280×720:
**Pickaxes** (iron pickaxe icon, 7 cards), **Boom** (TNT face: TNT, Big, Mega
and the five blast toys, 8 cards) and **Toys** (slime face: the two pads). A
recipe's tab is its `tab` field. The tab he last looked at is remembered for
the session.

A tab shows a **green dot** when one of its recipes has *become* craftable since
he last looked at that tab. Looking clears it until something new becomes
craftable, so Boom is not green all day. At the start of a session nothing
counts as seen: every tab with a craftable recipe shows its dot once. The rule
is `stepDots` in `src/ui/craft-model.ts`.

Each card shows the output, its ingredients with `have / need` and a fill bar
(red when short), and one big green button (greyed when short). An owned
pickaxe shows ✔ instead. Crafting plays a short chime and sparkles the card. A
crafted block (TNT or a toy) goes to the hotbar slot already holding it, else
the first empty slot, else the first greyed slot, else the selected slot;
crafting never triggers the must-mine auto-hotbar. The button's logic is
`applyCraft` (`src/game/craft-apply.ts`) and the card and tab view-models are
`src/ui/craft-model.ts`, both pure and unit-tested; `npm run smoke:crafting`
checks the real screen (always pass `--port` with a free port, never 5173).

## Adding a recipe

1. Add a row to `RECIPES` in `src/data/recipes.data.ts`:
   `{ id, output: { kind: 'block', name, count } | { kind: 'pickaxe', tier }, needs: [{ anyOf: [...names], count }], tab: 'pickaxes' | 'boom' | 'toys' }`.
   `tab` is required. Give the output block a line in this file:
   `crafting-docs.test.ts` fails on a crafted block whose label is not here.
2. Every `anyOf` name becomes counted automatically; a test fails if a name is
   not a block. A block output that should be crafted-only must not be a
   worldgen block.
3. A new block output needs a block row. Hand-written rows go in
   `blocks.extra.data.ts` at the next id from 1000 up (never renumber); a
   derived texture goes in `DERIVED_TEXTURES`.
4. A new pickaxe tier also needs a `PICKAXES` row, a head colour in
   `PICKAXE_HEAD`, and `MAX_PICKAXE_TIER` raised (the API already accepts tiers
   0–15).
5. Each icon tab is laid out for 10 cards in a 5-column grid; an 11th starts a
   third row. Boom has 8, so 2 more fit. Re-run the smoke's per-tab 1280×720
   no-scroll check.
