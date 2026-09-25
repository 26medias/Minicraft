# Cheat codes: design

Date: 2026-09-25. Branch `cheats` (from main f3eacb6). Status: draft, for gate 1.

## 1. Purpose

Hidden easter eggs for Noah. He types a secret phrase into the inventory's search box, presses
Enter, and gets a pile of TNT, pads, ores or a pickaxe. Julien tells him the codes; the game never
does. The feature adds no mechanic: each code only adds items the game already has, through the
count and tool rules that crafting already uses.

## 2. Requirements (decided by Julien)

- Codes are typed into the inventory's search box (Blocks tab) and **only activate when the player
  presses Enter**. Activating a code **empties the search input**.
- They are easter eggs: the UI does not document them anywhere.
- The player who activates a code sees a notification.
- Codes must work in multiplayer.
- **Matching is forgiving.** Case, punctuation and extra spaces are ignored, so "mole power" matches
  "Mole Power!".
- **Codes can be repeated any time.** Each Enter grants the reward again.
- Codes and rewards:

| Code | Reward |
|---|---|
| "Big Boom" | 50 each of `tnt`, `big_tnt` and `mega_tnt`. Not tunnel, flatten or lake. |
| "Tunnel this!" | 50 `tunnel_tnt` |
| "I am Mole Man" | Iron Pickaxe (tier 4 in `crafting.data.ts` PICKAXES) |
| "Mole Power!" | Diamond Pickaxe (tier 6) |
| "Jump!" | 50 `slime_pad` + 50 `launch_pad` |
| "I am so rich!" | 500 each of coal, copper, iron, gold, diamond, emerald, lapis and redstone ore, in both the stone and `deepslate_` versions (16 blocks). Not the nether ores. |

- Codes are **data**: one row per code in a new `src/data/cheats.data.ts` ("adding a thing is
  adding a row").

All 16 ore names, `tnt`, `big_tnt` (1000), `mega_tnt` (1001), `slime_pad` (1002), `launch_pad`
(1003) and `tunnel_tnt` (1005) exist in the catalog today. Every one of them is a *counted* block
(`isCounted`): the ores are in `WORLDGEN_BLOCKS`, and the others are recipe outputs.

## 3. What the code does today (findings)

- **Search keys.** `searchKey(code, query)` in `src/ui/craft-model.ts` returns `'clear'` or
  `'close'` for Escape and `'type'` for every other key. The keydown handler in
  `src/ui/inventory.ts` (≈ line 95) calls `stopPropagation()` on every key and returns early on
  `'type'`. **Enter therefore does nothing today.** It is swallowed before the game sees it, the box
  keeps its text and the filter stays as it was. There is no `<form>`, so nothing is submitted.
- **Counts** (`src/game/inventory.ts`). The inventory is `Record<blockName, number>`, and an absent
  key counts as `STARTING_COUNT` (0). Counts have **no upper cap** anywhere: not in the client
  model, not in `resolvePlayerExtras`, and not in the API schema, which only requires an integer
  ≥ 0 and at most 2000 keys. The badge shows `999+` above 999. *Crafted-only* blocks (`big_tnt`,
  `mega_tnt`, `tunnel_tnt`, `slime_pad`, `launch_pad`, …) need a count to place in every world, and
  their tiles are hidden at 0. Other counted blocks (ores, plain `tnt`) need a count only in
  `mustMine` worlds. In unlimited worlds their counts still show as badges and still feed recipes.
- **Tools.** The shape is `PlayerTools = { owned: number[]; equipped: number }`, and 0 (the hand) is
  always owned. Crafting adds the tier to `owned` (sorted) and equips it. `canCraft` refuses a
  pickaxe the player already owns. `owned` need not be contiguous: `nextOwnedTier` (the P key) and
  `pickaxeRow` both work on any set. On load, tiers outside 0..7 are dropped.
- **Notifications.** `MpOverlays.toast(text, color)` (`src/ui/mp-overlays.ts`) is a top-right
  stack. Each toast lasts 6 s, `#mp-toasts` has z-index 20 (above `#inventory-root` at 15), and it
  ignores pointer events. **It exists only in multiplayer:** main.ts builds `MpOverlays` in
  `startMultiplayer`, and its doc says "Nothing here exists in solo". Solo has no toast host.
- **Persistence.** Solo: `AutoSave.markDirty()` → `playerSave()` copies `inventory` and `tools` into
  the local save and the cloud PUT (`api/src/schema.ts`: `inventorySchema` and `toolsSchema`,
  optional fields, bounds loose on purpose). Multiplayer: main.ts replaces `autosave` with `MpSync`,
  which has the same shape. `MpSync.markDirty()` writes the sessionStorage stash at once and sends
  `extras {inventory, tools, hotbar, selected}` 5 s later (and on leave).
- **Server.** `extras` are "opaque to the server, capped at `MaxExtrasBytes` (256 KiB)"
  (`docs/protocol.md` §3; `hub/world.go` checks only `len ≤ MaxExtrasBytes && json.Valid`). The
  server stores them in SQLite and returns them in `welcome.extras`. Placed blocks are checked
  against `CatalogMax = 1008` (`server/internal/proto/catalog_gen.go`), which covers every block
  granted here.

**Conclusion: no protocol, server or API change is needed.** A grant is an ordinary inventory or
tools change followed by `markDirty()`. The crafting path (`applyCraft`) already works this way.

## 4. Matching rule

```ts
/** Lower-case, then keep only a–z and 0–9. */
export function normalizeCode(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}
/** The cheat whose normalised code equals the normalised text, or null. Blank text → null. */
export function matchCheat(text: string, cheats = CHEATS): Cheat | null
```

- The comparison is on the **whole string**, not a substring: "big boom please" does not match.
- The rule ignores all whitespace, not only extra spaces. So "molepower", "Mole-Power!!",
  " MOLE   POWER " and "mole power" all match "Mole Power!". This is slightly wider than "extra
  spaces", and deliberately so: a 7-year-old drops spaces and adds punctuation. **Ruling asked,
  §10 Q1.** If Julien wants only runs of spaces collapsed, the alternative is to map every non a–z0–9
  character to a space, collapse the runs and trim. Under that rule "Mole-Power" still matches, but
  "molepower" does not.
- An apostrophe is deleted, so "I'm so rich" normalises to "imsorich" and does **not** match "I am
  so rich!". Accented letters are dropped. The codes are plain ASCII, so neither case matters for
  them.
- The normalised codes today are `bigboom`, `tunnelthis`, `iammoleman`, `molepower`, `jump` and
  `iamsorich`. They are distinct, and a data test keeps them distinct and non-empty.

## 5. Enter handling

`searchKey` gains a third result: `searchKey(code, query): 'clear' | 'close' | 'submit' | 'type'`.
It returns `'submit'` for `Enter` or `NumpadEnter` when `normalizeCode(query) !== ''`, and `'type'`
otherwise, as today. Escape is unchanged. The Inventory gets one callback,
`onSearchEnter: ((text: string) => boolean) | null`, which main.ts wires. It returns true when a
code was granted.

| Case | What happens |
|---|---|
| Empty or blank box, or only punctuation | Nothing, exactly as today. No grant, no toast, no sound. |
| Text matches no code | **Nothing, exactly as today.** The text and the filter stay, with no toast and no "nope" sound. Any reaction would reveal that codes exist. |
| Text matches a code | `onSearchEnter` grants (§7), then: `markDirty()`, `syncHotbar()` (badges, pickaxe row, craft dots), a toast (§8), `playCraft()`. The Inventory then empties the box and calls `applySearch()`, so the whole grid is back with the new badges. Focus stays in the box, ready for another code. `preventDefault()`. |
| Enter held down (key repeat) | The first keydown grants and empties the box. The repeats see an empty box, so they do nothing. One grant per press. |
| IME composition (`e.isComposing`) | Treated as `'type'`. |

Enter keeps `stopPropagation()` in every case, so it never reaches the game. Codes are only
reachable from the Blocks tab, because the Craft tab has no search box. A play-time freeze or a
network freeze closes the inventory first (main.ts `closeInventory()`). The callback is also a no-op
unless the inventory is open.

## 6. Data shape: `src/data/cheats.data.ts`

```ts
import type { PickaxeTier } from './crafting.data';

export type CheatGrant =
    | { kind: 'block'; name: string; count: number }
    | { kind: 'pickaxe'; tier: PickaxeTier };
/** `code` is what Julien tells Noah, as written; matching uses normalizeCode(code). */
export type Cheat = { id: string; code: string; grants: CheatGrant[]; message: string };

const ORES = ['coal', 'copper', 'iron', 'gold', 'diamond', 'emerald', 'lapis', 'redstone'];
const block = (name: string, count: number): CheatGrant => ({ kind: 'block', name, count });

export const CHEATS: readonly Cheat[] = Object.freeze([
    { id: 'big_boom', code: 'Big Boom', grants: [block('tnt', 50), block('big_tnt', 50), block('mega_tnt', 50)], message: '…' },
    { id: 'tunnel_this', code: 'Tunnel this!', grants: [block('tunnel_tnt', 50)], message: '…' },
    { id: 'mole_man', code: 'I am Mole Man', grants: [{ kind: 'pickaxe', tier: 4 }], message: '…' },
    { id: 'mole_power', code: 'Mole Power!', grants: [{ kind: 'pickaxe', tier: 6 }], message: '…' },
    { id: 'jump', code: 'Jump!', grants: [block('slime_pad', 50), block('launch_pad', 50)], message: '…' },
    { id: 'so_rich', code: 'I am so rich!', grants: ORES.flatMap((o) => [block(`${o}_ore`, 500), block(`deepslate_${o}_ore`, 500)]), message: '…' },
]);
```

The messages are in §8. The logic lives in a new pure module, `src/game/cheats.ts`: `normalizeCode`,
`matchCheat` and `applyCheat`. It mirrors `craft-apply.ts`.

## 7. Grant semantics: `applyCheat(player, cheat, markDirty)`

The function mutates `player.inventory` and `player.tools` with new objects, never in place. It
calls `markDirty` exactly once and returns `{ pickaxeChanged: boolean }`. It does **not** touch the
hotbar. It is independent of `mustMine`: the same grant lands in every world.

| Item kind | Rule |
|---|---|
| Counted block (ores, plain `tnt`) | `inv[name] = countOf(inv, name) + count`. It adds, never sets, so a repeat stacks (50 → 100). There is no cap. In an unlimited world the count shows as a badge and feeds recipes, and placing the block stays free. In a `mustMine` world placing spends the count, as with mined blocks. |
| Crafted-only block (`big_tnt`, `mega_tnt`, `tunnel_tnt`, `slime_pad`, `launch_pad`) | The same addition. The count is what makes it placeable in every world, and its tile becomes visible. |
| Pickaxe, not owned | Added to `owned` (sorted, no duplicate). **Equipped only if its tier is above the equipped tier.** Iron over the hand or a Stone Pickaxe is equipped at once, which gives the reward feel crafting gives. |
| Pickaxe already owned | `owned` is unchanged (no duplicate tier). Equipped only if above the equipped tier; that can happen when he owns it but holds a lower one. Otherwise nothing changes. The toast is shown anyway. |
| Pickaxe below his best | Added to `owned` if missing. **Never equipped**, so "I am Mole Man" typed while holding a Diamond Pickaxe does not downgrade his hand. He can switch to it with P or the pickaxe row. The toast is shown anyway. |

When `pickaxeChanged` is true, main.ts calls `loop.onPickaxeChanged()`, as the craft path does, to
re-arm the mining floor. A granted count does **not** trigger the must-mine auto-hotbar (`rose`).
Crafting does not trigger it either (crafting spec §3), and "I am so rich!" would otherwise fill his
bar with 16 ores.

**Ruling asked, §10 Q2:** this "equip only if higher" rule differs from crafting, which always
equips. Crafting can only make a pickaxe he does not own, so the two never conflict there.

## 8. Notification

The toast shows only on the activating player's screen, and nothing is sent over the network.
Solo has no toast host, so the toast stack moves out of `MpOverlays` into a small `src/ui/toasts.ts`
(`Toasts.show(text, color?)`: the same markup, CSS, 6 s life and top-right position; the colour dot
is optional). `MpOverlays.toast` delegates to it, and main.ts creates one instance per page for both
modes. At z-index 20 it shows above the open I screen. At most 3 toasts are visible at once; a
fourth pushes out the oldest, so mashing Enter on repeated codes cannot fill the screen. The cheat
toast has a gold dot (`#f5c542`).

| Code | Toast (`message` in the row) |
|---|---|
| Big Boom | `Big Boom! +50 TNT, Big TNT and Mega TNT` |
| Tunnel this! | `Tunnel time! +50 Tunnel TNT` |
| I am Mole Man | `Hello, Mole Man! An Iron Pickaxe for you` |
| Mole Power! | `Mole Power! A Diamond Pickaxe for you` |
| Jump! | `Boing! +50 Slime Pads and Launch Pads` |
| I am so rich! | `So rich! +500 of every ore` |

No player-visible string names the game, so the "Noah's Worlds" naming rule does not apply here.

## 9. Persistence and multiplayer

- **Solo.** `markDirty()` saves the new counts and tools locally and to the cloud through the
  existing `player.inventory` and `player.tools` fields. The API schema already accepts the result:
  integers ≥ 0 with no maximum, well under 2000 keys, tiers ≤ 15. `resolvePlayerExtras` reloads it:
  live names are kept, and tiers 4 and 6 are within 0..7. **No API change and no redeploy.**
- **Multiplayer.** `markDirty()` goes to `MpSync`. The stash updates at once, and the `extras`
  message follows 5 s later or on leave. The server stores the opaque JSON; the "I am so rich!"
  inventory is a few KB against the 256 KiB cap. On rejoin it comes back in `welcome.extras`.
  Extras are per player and are never relayed, so a friend sees nothing until blocks are placed,
  and placed blocks are ordinary `edit` ops the server already accepts (ids ≤ 1008). **No new
  message, no `PROTO` bump, no `mcserver` rebuild or restart.** Because a grant never touches the
  hotbar, a count for a block hidden by a lower `catalogMax` (an older server) does nothing, just as
  a count carried in from elsewhere does nothing.
- Each family can use the codes in the other's world. They are private worlds, so this is accepted.

## 10. Non-goals

- The UI has no list of codes, no hint, no placeholder change, and no reaction to a wrong code.
- No achievements, "cheater" flag, per-code counters or cooldowns.
- No server, protocol or API change.
- No new items, no removal codes, no codes that change the world, mode, time or flight.
- The feature does not check or advance crafting progression; bypassing it is the point.
- Julien (the parent) gets a list in a repo doc, `docs/cheats.md`, kept in step with the data by a
  test in the style of `crafting-docs.test.ts`. The repo is not UI.

## 11. Test plan

Each test must be able to fail. "Red on" names the broken build that turns it red.

**Unit (vitest, node environment)**

1. `src/data/cheats.data.test.ts`
   - *pins the six rows*: each code's exact grants. Red on: Big Boom including `tunnel_tnt`,
     `flatten_tnt` or `lake_tnt`; "I am so rich!" missing a `deepslate_` ore, including
     `nether_gold_ore` or `nether_quartz_ore`, or not using 500; the wrong tiers (4 and 6, checked
     through `PICKAXES[t].label`).
   - *every granted block name is in `BLOCK_BY_NAME` and `isCounted`*. Red on a typo such as
     `lapis_lazuli_ore`, which would be a silent no-op grant.
   - *normalised codes are non-empty and unique*. Red on a new row that shadows an old one.
   - *counts are positive integers*.
2. `src/game/cheats.test.ts`
   - *normalizeCode / matchCheat table*: "mole power", "MOLE POWER!!", "  Mole   Power ",
     "mole-power" and "molepower" each match `mole_power`. "mole powers", "mole", "", "   " and
     "!!!" match nothing, and nor does a block search such as "diamond" or "tnt". Red on a
     case-sensitive rule, a substring rule, or punctuation that is kept.
   - *adds, never sets*: `{}` + Big Boom → `tnt/big_tnt/mega_tnt = 50`, and again → 100; `{big_tnt: 7}`
     → 57; `{big_tnt: 0}` → 50. Red on an idempotent grant or an assignment.
   - *pure and dirty once*: the input objects are unchanged and `markDirty` is called exactly once
     per grant. Red on in-place mutation, which breaks the in-flight save copy, or on a missing
     `markDirty`.
   - *hotbar untouched*, in both `mustMine` values.
   - *pickaxe rules*: `{[0],0}` + Mole Man → `{[0,4],4}`, changed. `{[0,6],6}` + Mole Man →
     `{[0,4,6],6}`, not re-equipped. `{[0,4],4}` + Mole Man → owned `[0,4]` with no duplicate,
     unchanged. `{[0,4,6],4}` + Mole Power → equipped 6. Red on "always equip" or a duplicate tier.
   - *placeable after the grant*: `canPlace(big_tnt)` is true in an unlimited world, and
     `canPlace(diamond_ore)` is true in a `mustMine` world. Red on a grant to a wrong key.
3. `src/ui/inventory-search.test.ts` (extended)
   - `searchKey('Enter','big boom')` and `searchKey('NumpadEnter','x')` → `'submit'`. `searchKey('Enter','')`
     and `searchKey('Enter','  !! ')` → `'type'`. The existing Escape and "other keys" cases are kept
     unchanged. Red on Enter not being distinguished, or on Enter over an empty box calling the
     handler.
4. `src/data/cheats-docs.test.ts`: `docs/cheats.md` contains every `code`.

**Browser (headless Chromium, own Vite on a free port, API blocked; never 5173 in use, never prod)**

5. Solo leg, added to `scripts/crafting-smoke.ts` (made headless) or a new `cheat-smoke`:
   - Type "diamond" + Enter → the box still says "diamond" and the grid is still filtered. Red on a
     build that clears on every Enter.
   - Type "  big BOOM!! " + Enter → the box is empty, a toast with "Big Boom!" is visible above the
     open I screen, the Big TNT tile shows `50`, and the HUD pickaxe is unchanged. Red on a toast host
     that exists only in multiplayer.
   - Enter again with the same code → `100`. Reload the page (API blocked, local save) → `100` still.
     Red on a missing `markDirty` in solo.
   - "Mole Power!" → the HUD shows the diamond icon.

**Multiplayer (`scripts/mp-e2e.ts`, new scenario `E13`)**

This needs `MP_E2E_SCRATCH`. The suite's own `mcserver` runs on 127.0.0.1:18080 against a temp DB,
with Vite on :5174. Never 8080, never `minicraft-server.leap-forward.ca`.

6. `E13` "a cheat code grants, persists on the server and places for real":
   - A opens I, types "Big Boom" + Enter: the box is empty, a toast shows, and `__mc.player.inventory.big_tnt` has risen by 50.
   - A places one Big TNT; B's `mp.log` shows the `edit` with id 1000. A's count drops by 1 and there is no 4003.
   - "I am Mole Man" → `tools.owned` includes 4.
   - Wait more than 5 s (the debounce), close A's **browser context**, and rejoin under the same
     name in a **fresh context**, so sessionStorage is empty and the stash cannot carry the grant.
     A's counts and tools equal the values before it left.
   - Red on: extras not marked dirty in multiplayer, a grant that only reached the stash, or a
     client that stops sending `extras` for large inventories.
7. The existing `E5` (the leaving toasts) must stay green after the toast extraction. It is the red
   test for breaking `MpOverlays.toast`. `E6`'s "same inventory counts" check is unaffected.

## 12. Risks and open questions

- **Q1 (ruling):** should the rule ignore all spaces ("molepower" matches) or only extra ones? §4
  recommends all.
- **Q2 (ruling):** should a granted pickaxe be equipped only when higher than the one in hand (§7,
  recommended), or always, as crafting does?
- **Q3:** should block grants also put the item on the hotbar, as a craft does (`craftedBlockSlot`)?
  The recommendation is no: 16 ores cannot fit, and he is in the I screen with the tiles in front of
  him. It could be a per-row opt-in later.
- **Q4:** counts have no cap, and each "I am so rich!" adds 8,000 ores. JSON and the save are fine far beyond
  anything a child can type. A cap (for example 99,999 per key) would be one line; not
  recommended unless Julien wants one.
- **Codes collide with searches.** A block search that happens to equal a code, followed by Enter,
  grants the reward. The only word-like code is "jump", and no block label is "jump", so the harm is
  low.
- **Progression.** The codes bypass must-mine and crafting on purpose. The Craft tab will light
  green dots after "I am so rich!", as intended.
- **Toast refactor.** Moving the stack out of `MpOverlays` touches multiplayer UI that works today.
  E5 guards it.
