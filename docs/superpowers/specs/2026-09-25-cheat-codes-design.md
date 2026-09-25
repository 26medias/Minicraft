# Cheat codes: design

Date: 2026-09-25. Branch `cheats` (from main f3eacb6). Status: revised after gate 1. Julien's
answers (J1–J4) and the controller's rulings are folded in and binding.

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
- **J1: the search box takes focus.** Opening the I screen on the Blocks tab, or switching to that
  tab, focuses the search box. Typing, including the letter I, goes into the box. I no longer
  closes the screen while the box has focus; Esc does (it clears first, then closes).
- **J2: grid only.** Granted items never go on the hotbar.
- **J3: "I'm" forms.** "I'm Mole Man" and "I'm so rich!" also work, through a per-row alias list
  kept as data.
- **J4:** `docs/cheats.md` lists the codes for the parent. A test keeps it in step with the data in
  both directions, reward text included.
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
  keeps its text and the filter stays as it was. There is no `<form>`.
- **The box is not focused on open.** A kid in a real browser pressed I and typed "I am so rich!"
  straight away. His keys went to the game: the second I closed the screen, Space jumped, and P
  swapped the pickaxe. J1 fixes this. Two more traps were found by probe. First, the I keydown that
  opens the screen (main.ts `case 'inventory'`) never calls `preventDefault()`, so a box focused
  inside that handler receives the "i". Second, the tile, tab and pickaxe-row buttons call `blur()`
  on click, so focus falls to BODY and the next I closes the screen.
- **Counts** (`src/game/inventory.ts`). The inventory is `Record<blockName, number>`, and an absent
  key counts as `STARTING_COUNT` (0). Counts have **no upper cap** anywhere: not in the client model,
  not in `resolvePlayerExtras`, and not in the API schema (an integer ≥ 0, at most 2000 keys).
  Badges show `999+`, and Craft cards show the raw sums. *Crafted-only* blocks need a count to place
  in every world, and their tiles are hidden at 0. Other counted blocks (ores, plain `tnt`) need a
  count only in `mustMine` worlds. In unlimited worlds their counts still show and still feed
  recipes.
- **Tools.** The shape is `PlayerTools = { owned: number[]; equipped: number }`, and 0 (the hand) is
  always owned. Crafting adds the tier to `owned` (sorted) and equips it, and `canCraft` refuses a
  pickaxe already owned. `owned` need not be contiguous: `nextOwnedTier` (P) and `pickaxeRow` work on
  any set. Tiers outside 0..7 are dropped on load.
- **Notifications.** `MpOverlays.toast(text, color)` (`src/ui/mp-overlays.ts`) is a top-right stack
  (`#mp-toasts`, `.mp-toast`, `.mp-toast-text`, `.mp-dot`). Each toast lasts 6 s, the stack has
  z-index 20 (above `#inventory-root` at 15), and it has `pointer-events: none`. **It exists only in
  multiplayer:** main.ts builds `MpOverlays` in `startMultiplayer`. In solo, `#save-status` sits at
  top 10 px, right 12 px, z-index 40. `.mp-dot` is also used by `src/ui/menu.ts`.
- **Persistence.** Solo: `AutoSave.markDirty()` → `playerSave()` copies `inventory` and `tools` into
  the local save and the cloud PUT (`api/src/schema.ts`). AutoSave also writes locally on
  `pagehide`. Multiplayer: `autosave` is `MpSync`. Its `markDirty()` writes the sessionStorage stash
  (`mp:extras`) at once and sends `extras` 5 s later. **Multiplayer has no `pagehide` flush.** If the
  tab closes within 5 s of a change, the server never gets it; the stash only helps a reload in the
  same tab. Both savers read the **live** player state when their timer fires. Any other dirtying
  action will therefore carry a grant that never called `markDirty` itself, so tests must check
  `markDirty` directly (§11).
- **Server.** `extras` are "opaque to the server, capped at `MaxExtrasBytes` (256 KiB)"
  (`docs/protocol.md` §3; `hub/world.go` checks only `len ≤ MaxExtrasBytes && json.Valid`). The
  server stores them in SQLite and returns them in `welcome.extras`. Placed blocks are checked
  against `CatalogMax = 1008`, which covers every granted block.

**Conclusion: no protocol, server or API change is needed.** A grant is an ordinary inventory or
tools change followed by `markDirty()`, as `applyCraft` does.

## 4. Matching rule

```ts
/** Unicode-fold, lower-case, then keep only a–z and 0–9. */
export function normalizeCode(s: string): string {
    return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
/** The cheat whose normalised code or alias equals the normalised text, or null. Blank → null. */
export function matchCheat(text: string, cheats = CHEATS): Cheat | null
```

- **Every** space is dropped (controller, Q1). So "molepower", "Mole-Power!!", " MOLE   POWER " and
  "mole power" all match "Mole Power!".
- NFKD with combining marks stripped folds accents and fullwidth forms: "rích" matches "rich", and
  "ＪＵＭＰ" matches "jump".
- The comparison is on the whole string, not a substring: "big boom please" does not match.
- Aliases go through the same function. An apostrophe is deleted, so "I'm so rich!" normalises to
  "imsorich" and needs the alias (J3).
- The normalised keys are `bigboom`, `tunnelthis`, `iammoleman`/`immoleman`, `molepower`, `jump` and
  `iamsorich`/`imsorich`. Data tests keep all of them distinct, non-empty, and different from every
  normalised block name and label.

## 5. Focus and Enter handling

**Focus (J1).**

- **The opening I is not typed.** main.ts's `'inventory'` action calls `e.preventDefault()` on the
  keydown that opens the screen. Without it the box would read "iI am so rich!".
- **When focus happens.** `Inventory.open()` removes `.hidden`, then calls `this.search.focus()` if
  the Blocks tab is active. `setTab('blocks')` focuses only when `isOpen`, because it also runs in
  the constructor while the screen is hidden.
- **Keys go to the box.** With focus there, every key, including I, P, Space and the digits, is
  typed into the box. The existing `stopPropagation()` keeps them from the game.
- **Esc** keeps its behaviour: it clears the text, or closes the screen when the box is empty. The
  I key closes the screen only when the box does not have focus, for example on the Craft tab.
- `close()` blurs the box, and so does `setTab('craft')`.
- **Focus comes back.** Tab, Shift+Tab (Tab is his hotbar-cycle key) or a click on the dark backdrop
  (`#inventory-root` outside the card) would otherwise take focus out of the box. The box's `blur`
  handler therefore runs `requestAnimationFrame(() => { if (this.isOpen && this.tab === 'blocks')
  this.search.focus(); })`. Probed: Tab, Shift+Tab and the backdrop all keep typing in the box, Esc
  still clears then closes, and switching to the Craft tab is unaffected.
- **Clicks keep focus in the box.** On the Blocks tab, a click on a tile, a tab button or the
  pickaxe row re-focuses the search box instead of calling `blur()`. The blur only existed to stop
  Space re-firing a focused tile, and focusing the box prevents that too. The card's non-input areas
  call `preventDefault()` on `mousedown`, so a click never takes focus out of the box.
- **Held keys.** The box ignores `e.repeat` keydowns for printable keys, so holding I or W does not
  type "iiww".

**Keys.** The signature becomes
`searchKey(code, query, isComposing = false, key = ''): 'clear' | 'close' | 'submit' | 'type'`.

- It returns `'submit'` when `(code === 'Enter' || code === 'NumpadEnter' || key === 'Enter')`,
  `!isComposing` and `normalizeCode(query) !== ''`. Virtual keyboards send `code === ''`, which is
  why `key` is checked too.
- Otherwise it returns `'type'`, or Escape's existing result.
- A composing IME always gives `'type'`.

The Inventory gets one callback, `onSearchEnter: ((text: string) => boolean) | null`, which returns
true when a code was granted. Its handler starts with `if (!this.isOpen) return`.

| Case | What happens |
|---|---|
| Empty or blank box, or only punctuation | Nothing, exactly as today. No grant, no toast, no sound. |
| Text matches no code | **Nothing, exactly as today.** The text and filter stay. There is no toast and no "nope" sound, since either would reveal that codes exist. |
| Text matches a code or alias | main.ts calls `applyCheat(player, cheat, () => autosave.markDirty())` (§7), which makes the **only** `markDirty` call. It then calls `syncHotbar()` (badges, pickaxe row, craft dots), shows a toast (§8) and plays `playCraft()`. The Inventory then empties the box and calls `applySearch()`; focus stays in the box. `preventDefault()`. |
| Enter held down | The first keydown grants and empties the box; the repeats see an empty box and do nothing. |
| IME composition | `'type'`. |

Enter keeps `stopPropagation()` in every case. A play-time freeze or a network freeze closes the
inventory first (`closeInventory()`).

## 6. Data shape: `src/data/cheats.data.ts`

```ts
import type { PickaxeTier } from './crafting.data';

export type CheatGrant =
    | { kind: 'block'; name: string; count: number }
    | { kind: 'pickaxe'; tier: PickaxeTier };
/** `code` is what Julien tells Noah; `also` lists other accepted spellings. All match through normalizeCode. */
export type Cheat = { id: string; code: string; also: string[]; grants: CheatGrant[]; message: string };

const ORES = ['coal', 'copper', 'iron', 'gold', 'diamond', 'emerald', 'lapis', 'redstone'];
const block = (name: string, count: number): CheatGrant => ({ kind: 'block', name, count });

export const CHEATS: readonly Cheat[] = Object.freeze([
    { id: 'big_boom', code: 'Big Boom', also: [], grants: [block('tnt', 50), block('big_tnt', 50), block('mega_tnt', 50)], message: 'Big Boom! +50 TNT, Big TNT and Mega TNT' },
    { id: 'tunnel_this', code: 'Tunnel this!', also: [], grants: [block('tunnel_tnt', 50)], message: 'Tunnel time! +50 Tunnel TNT' },
    { id: 'mole_man', code: 'I am Mole Man', also: ["I'm Mole Man"], grants: [{ kind: 'pickaxe', tier: 4 }], message: 'Hello, Mole Man! An Iron Pickaxe for you' },
    { id: 'mole_power', code: 'Mole Power!', also: [], grants: [{ kind: 'pickaxe', tier: 6 }], message: 'Mole Power! A Diamond Pickaxe for you' },
    { id: 'jump', code: 'Jump!', also: [], grants: [block('slime_pad', 50), block('launch_pad', 50)], message: 'Boing! +50 Slime Pads and Launch Pads' },
    { id: 'so_rich', code: 'I am so rich!', also: ["I'm so rich!"], grants: ORES.flatMap((o) => [block(`${o}_ore`, 500), block(`deepslate_${o}_ore`, 500)]), message: 'So rich! +500 of every ore' },
]);
```

The logic lives in a new pure module, `src/game/cheats.ts` (`normalizeCode`, `matchCheat`,
`applyCheat`), which mirrors `craft-apply.ts`.

## 7. Grant semantics: `applyCheat(player, cheat, markDirty)`

The function replaces `player.inventory` and `player.tools` with new objects and never mutates them
in place. It calls the injected `markDirty` exactly once, and it is the grant path's only caller.
main.ts passes `() => autosave.markDirty()`, as `onCraft` does; in multiplayer `autosave` is the
`MpSync`. The function returns `{ pickaxeChanged }`, which is true exactly
when the **equipped** tier changed. It never touches the hotbar (J2). It is independent of
`mustMine`: the same grant lands in every world.

| Item kind | Rule |
|---|---|
| Counted block (ores, plain `tnt`) | `inv[name] = countOf(inv, name) + count`. It adds, never sets, so a repeat stacks (50 → 100). No cap. In an unlimited world the count shows as a badge and feeds recipes, and placing the block stays free. In a `mustMine` world placing spends it. |
| Crafted-only block (`big_tnt`, `mega_tnt`, `tunnel_tnt`, `slime_pad`, `launch_pad`) | The same addition. The count is what makes it placeable in every world, and its tile becomes visible. |
| Pickaxe | Add the tier to `owned` if it is missing (sorted, no duplicate). **Equip it if and only if its tier is above the equipped tier** (controller, Q2). |

What the pickaxe rule means in practice:

- Mole Man with the hand or a Stone Pickaxe equipped: Iron is equipped.
- Mole Man with a Diamond Pickaxe equipped: Iron is added and Diamond stays equipped.
- Mole Man when he owns Diamond but holds the hand: Iron is equipped, because 4 > 0.
- A pickaxe he already owns and holds: nothing changes.

The toast shows in every case. When `pickaxeChanged` is true, main.ts calls `loop.onPickaxeChanged()`
as the craft path does. A granted count does not trigger the must-mine auto-hotbar (`rose`); crafting
does not trigger it either.

## 8. Notification

The toast shows only on the activating player's screen, and nothing is sent over the network.

**Extraction: its own first commit.** A new `src/ui/toasts.ts` holds `Toasts.show(text, color?,
kind: 'mp' | 'cheat' = 'mp')`. It keeps the `#mp-toasts`, `.mp-toast`, `.mp-toast-text` and
`.mp-dot` names, the CSS and the 6 s life. main.ts creates one `Toasts` at page load, before
`startMultiplayer`. `MpOverlays` receives that instance in its constructor and no longer builds a
host; `MpOverlays.toast` delegates to it. Run E5 before and after this commit.

**Cap: at most one cheat toast is visible.** A new cheat toast replaces the one on screen.
Cheat toasts never evict multiplayer toasts, and multiplayer toast behaviour (no cap, 6 s each) is
unchanged. A "Noah has to go" warning is therefore never pushed out by code mashing.

**Placement.** In multiplayer the stack stays where it is (top 12 px, right 12 px, z-index 20), above
the open I screen (z-index 15). In solo the stack sits below the `#save-status` pill (top 10 px,
right 12 px, z-index 40), for example with `top: 44px` under a `.solo` modifier, so the pill never
covers it. `startGame` toggles `.solo` on the toast host: on in solo, off in multiplayer. The cheat
toast's dot is gold (`#f5c542`).

| Code | Toast (`message` in the row; pinned by the data test) |
|---|---|
| Big Boom | `Big Boom! +50 TNT, Big TNT and Mega TNT` |
| Tunnel this! | `Tunnel time! +50 Tunnel TNT` |
| I am Mole Man | `Hello, Mole Man! An Iron Pickaxe for you` |
| Mole Power! | `Mole Power! A Diamond Pickaxe for you` |
| Jump! | `Boing! +50 Slime Pads and Launch Pads` |
| I am so rich! | `So rich! +500 of every ore` |

No player-visible string names the game, so the "Noah's Worlds" naming rule does not apply here.

## 9. Persistence and multiplayer

- **Solo.** `markDirty()` saves the new counts and tools locally (including the `pagehide` local
  write) and to the cloud, through the existing `player.inventory` and `player.tools` fields. The
  API schema already accepts the result: integers ≥ 0 with no maximum, well under 2000 keys, tiers
  ≤ 15. `resolvePlayerExtras` reloads it. **No API change.**
- **Multiplayer.** `markDirty()` goes to `MpSync`. The stash updates at once, and `extras` are sent
  5 s later. The server stores the opaque JSON; the "I am so rich!" inventory is a few KB against the
  256 KiB cap. It comes back in `welcome.extras` on rejoin. **There is no `pagehide` flush:** closing
  the tab within 5 s of a code loses that grant on the server. The spec adds no flush for this,
  because codes are repeatable. Extras are per player and never relayed, so a friend sees only
  placed blocks, which are ordinary `edit` ops (ids ≤ 1008). **No new message, no `PROTO` bump, no
  `mcserver` change.** A grant never touches the hotbar, so a count for a block that a lower
  `catalogMax` hides does nothing.
- Each family can use the codes in the other's world. They are private worlds, so this is accepted.

## 10. Non-goals

- The UI has no list of codes, no hint, no placeholder change, and no reaction to a wrong code.
- No achievements, "cheater" flag, per-code counters, cooldowns or count cap (controller, Q4).
- No server, protocol or API change, and no new multiplayer flush.
- No hotbar placement of granted items (J2).
- No new items, no removal codes, no codes that change the world, mode, time or flight.
- `docs/cheats.md` is for the parent only (J4). The repo is not UI.

## 11. Test plan

Each test must be able to fail. "Red on" names the broken build that turns it red.

**Unit (vitest, node environment)**

1. `src/data/cheats.data.test.ts`
   - *pins the six rows*: each row's exact grants, `also` and `message`. Red on: Big Boom including
     `tunnel_tnt`, `flatten_tnt` or `lake_tnt`; "I am so rich!" missing a `deepslate_` ore,
     including `nether_gold_ore` or `nether_quartz_ore`, or not using 500; the wrong tiers (4 and 6,
     checked through `PICKAXES[t].label`); a toast text changed without review.
   - *every granted block name is in `BLOCK_BY_NAME` and `isCounted`*. Red on a typo, which would be
     a silent no-op grant.
   - *the normalised codes and aliases are non-empty and unique across rows*.
   - *no collision with the catalog*: no block's `normalizeCode(name)` or `normalizeCode(label)`
     equals any normalised code or alias. Red when a future catalog row turns a block search into a
     code.
   - *counts are positive integers*.
2. `src/data/cheats-docs.test.ts` (J4, both directions)
   - `docs/cheats.md` has one markdown table with the columns `code | also | reward`, one row per
     code. `also` holds the aliases, comma-separated, or is empty. `reward` holds the row's
     `message`. The test parses exactly this table.
   - Every `CHEATS` row has a table row with the same code, aliases and message.
   - Every table row is a `CHEATS` row.
   - Red on a data row without documentation, and on documentation for a code that is gone or
     renamed.
3. `src/game/cheats.test.ts`
   - *normalizeCode / matchCheat*:
     - These match `mole_power`: "mole power", "MOLE POWER!!", "  Mole   Power ", "mole-power",
       "molepower".
     - These match `so_rich`: "I'm so rich!", "i m so rich", "I am so rích".
     - "ＪＵＭＰ" matches `jump`.
     - These match nothing: "mole powers", "mole", "", "   ", "!!!", "diamond", "tnt".
     - Red on a case-sensitive rule, a substring rule, punctuation kept, no NFKD fold, or aliases
       ignored.
   - *adds, never sets*:
     - `{}` + Big Boom gives 50 each; a second grant gives 100.
     - `{big_tnt: 7}` → 57, and `{big_tnt: 0}` → 50.
     - Red on an idempotent grant or an assignment.
   - *pure, and dirty exactly once*: the input objects are unchanged, and a `markDirty` spy is
     called once per grant.
   - *hotbar untouched* (a single check, since `applyCheat` takes no `mustMine`).
   - *pickaxe rules* (`pickaxeChanged` in brackets):
     - `{[0],0}` + Mole Man → `{[0,4],4}` (true).
     - `{[0,6],6}` + Mole Man → `{[0,4,6],6}` (false).
     - `{[0,6],0}` + Mole Man → `{[0,4,6],4}` (true).
     - `{[0,4],4}` + Mole Man → `{[0,4],4}` (false, no duplicate).
     - `{[0,4,6],4}` + Mole Power → equipped 6 (true).
     - Red on "always equip", "never equip", comparing against the best owned tier instead of the
       equipped one, or a duplicate tier.
   - *placeable after the grant*: `canPlace(big_tnt)` is true in an unlimited world, and
     `canPlace(diamond_ore)` is true in a `mustMine` world.
4. `src/ui/inventory-search.test.ts` (extended)
   - These return `'submit'`: `searchKey('Enter','big boom')`, `searchKey('NumpadEnter','x')` and
     `searchKey('', 'x', false, 'Enter')` (a virtual keyboard).
   - These return `'type'`: `searchKey('Enter','')`, `searchKey('Enter','  !! ')` and
     `searchKey('Enter','x', true)` (IME).
   - The existing Escape and "other keys" cases are kept, and `KeyI` and `KeyP` return `'type'`.
   - Red on an Enter that is not distinguished, an empty-box submit, or a lost IME guard.
5. `src/ui/toasts.test.ts`: the cap rule is a pure `nextToasts(current, incoming)` list function.
   - 2 MP toasts + 1 cheat → both MP toasts remain, plus the cheat.
   - 1 cheat + 1 cheat → only the new cheat remains.
   - 3 MP toasts → all 3 remain.
   - Red on a global cap, or on a cheat that evicts an MP toast.

**Browser, solo** (headless Chromium, its own Vite on a **free port, never 5173**, API blocked,
never prod). A new leg in `scripts/crafting-smoke.ts` (already headless) or a new `cheat-smoke`:

6. *I then type at once (J1)*
   - Press I, then with no click type "I am so rich!".
   - Before Enter, the box's value is **exactly** "I am so rich!", with no leading "i".
   - Press Enter. The screen is still open and `deepslate_emerald_ore` is 500.
   - Then, still with no click, type "Jump!" + Enter. The screen is still open, the equipped
     pickaxe is unchanged even though "Jump!" contains a P, and `slime_pad` is 50.
   - Red on: no focus; the opening I typed into the box; I closing the screen while the box is
     focused; P reaching the game.
7. *Click, then type*
   - Click a block tile, then type "Tunnel this!" + Enter with no further click.
   - The screen is still open and `tunnel_tnt` rose by 50.
   - Then press Tab, press Shift+Tab, click the backdrop (`#inventory-root` outside the card), and
     type "Jump!" + Enter. The screen is still open and `slime_pad` rose by 50.
   - Red on: a tile click that blurs to BODY, where the next I closes the screen; a Tab or backdrop
     click that loses the box.
8. *No match keeps the box*: "diamond" + Enter → the box still says "diamond", and the grid is still
   filtered.
9. *Grant, toast and markDirty*
   - `__mc` exposes a counter that wraps the real `AutoSave` or `MpSync` `markDirty`, not the lambda
     passed to `applyCheat`.
   - Inside **one** `evaluate`: read the counter, set the box to "  big BOOM!! ", dispatch the Enter
     keydown, then read the counter again. It rose by **exactly 1**, the box is empty and the Big
     TNT tile shows `50`.
     - AutoSave stays dirty while the cloud save fails, and the API is blocked, so the test does not
       check a "clean" state.
   - A toast containing "Big Boom!" exists, and its computed z-index is above `#inventory-root`'s.
     Compare z-index rather than `elementFromPoint`, since toasts have `pointer-events: none`.
   - The toast's top is below the bottom of `#save-status`. Take that bottom while the pill is
     visible; if it is hidden, use its solo position (top 10 px plus its height).
   - A second Big Boom → 100; a second cheat toast replaces the first, so exactly one is visible.
   - Reload → still 100.
   - Red on: a missing solo toast host; a toast under the pill; more than one cheat toast.
   - Red on the sabotage "the grant path makes no `markDirty` call": the counter rises by 0. It is
     also red on a double call (a second `markDirty` in main.ts), where the counter rises by 2.
10. "Mole Power!" → the HUD shows the diamond icon.

**Multiplayer: `scripts/mp-e2e.ts`, new scenario `E13`**

`MP_E2E_SCRATCH` is required. The suite's own `mcserver` runs on 127.0.0.1:18080 with a temp DB,
and Vite on :5174. Never 8080, never `minicraft-server.leap-forward.ca`.

E13 runs before E5 and E6. It joins the `needMp` list and the "A comes back" list (`mp-e2e.ts`
≈ line 1087), and it reassigns `A` after its rejoin.

11. `E13` "a cheat code grants, persists on the server, and places for real". Steps in order:
    0. Wait until A has been idle for more than 5 s, so no earlier extras send is pending.
    1. A presses I and types "Big Boom".
    2. Inside **one** `evaluate`:
       - read `big_tnt` from `sessionStorage['mp:extras']`;
       - dispatch the Enter keydown;
       - read the stash again: `big_tnt` has risen by exactly 50.

       Also check that the box is empty and a toast is shown. Record `big_tnt` as *before + 50*.
    3. "I am Mole Man" → `tools.owned` includes 4. "I am so rich!" → `deepslate_emerald_ore` is 500.
    4. **Before any pick or place:**
       - Wait more than 5 s, counted from the **last** grant.
       - Close A's **page**. Wait until B's `mp.log` shows A `left`, which avoids the 4009
         `nameTaken` race.
    5. Rejoin as A in a **fresh context**, never the old `ctxA`, with
       `joinWorld(page, BASE, WORLD, '10 min')`. E5 needs its `playtime`.
       - The empty sessionStorage means only the server can supply the state.
       - `big_tnt` equals the recorded before + 50 exactly, `deepslate_emerald_ore` is 500, and
         tier 4 is owned.
    6. A opens I, picks the Big TNT tile (J2 keeps grants off the hotbar), closes I, and places the
       block through the real right-click path with pointer lock (not `setBlock`).
       - B's log shows the `edit` with id 1000, and there is no 4003.
       - A's count drops by 1.
    - **Red on** the sabotage "the grant path makes no `markDirty` call".
      - Step 2's stash read, inside the same `evaluate` as the Enter, is the real instrument: no
        call means no stash write.
      - Step 5 alone is not reliable. Liquid or TNT activity nearby fires `onWorldMutated` →
        `markDirty`, which would send the live extras anyway.
      - Verify this once by running E13 against the sabotaged build.
12. `E5` (the leaving toasts) runs before and after the toast-extraction commit, and stays green.
    `E6`'s "same inventory counts" check is unaffected.

## 12. Decisions and remaining risks

- **Decided.**
  - Q1: every space is dropped, plus the NFKD fold (§4).
  - Q2: equip only if above the equipped tier (§7).
  - Q3 / J2: no hotbar placement.
  - Q4: no cap.
  - J1: auto-focus. J3: aliases. J4: the two-way doc test.
- **Grant lost in multiplayer on a quick close.** Closing the tab within 5 s of a code loses the
  grant on the server. This is accepted, because codes are repeatable.
- **Code/search collisions.** The data test blocks collisions with block names. A free-text search
  equal to a code (say "jump") followed by Enter still grants, which is harmless.
- **Progression.** The codes bypass must-mine and crafting on purpose. After "I am so rich!" the
  Craft tab will show green dots.
- **Auto-focus changes the I screen for everyone.** Digits and P no longer act while the Blocks tab
  is open, because they are typed into the box. The hotbar strip and pickaxe row stay clickable.
  Tests 6 and 7 cover the new behaviour.
- **Toast refactor.** It touches multiplayer UI that works today. It goes in its own commit, guarded by E5 and unit test 5.
