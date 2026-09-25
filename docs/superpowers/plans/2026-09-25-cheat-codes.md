# Cheat Codes: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Secret phrases typed into the I screen's Blocks-tab search box grant TNT, pads, ores or a pickaxe when the player presses Enter, in solo and in multiplayer, with a toast and no trace in the UI.

**Architecture:** Codes are rows in `src/data/cheats.data.ts`. `src/game/cheats.ts` holds the pure logic: `normalizeCode`, `matchCheat` and `applyCheat`, which mirrors `applyCraft` and makes the grant path's only `markDirty` call. The Inventory UI gets an Enter result from `searchKey`, auto-focus with refocus, and an `onSearchEnter` callback that main.ts wires. The toast stack moves out of `MpOverlays` into a shared `Toasts` used in both modes. Persistence reuses the existing inventory and tools fields: no API, protocol or server change.

**Tech Stack:** TypeScript, Vite 5, vitest (node environment), Playwright (headless Chromium), the Go `mcserver` built by `scripts/mp-e2e.ts`.

**Spec:** `docs/superpowers/specs/2026-09-25-cheat-codes-design.md` (rev 4 plus Julien's gate-2 decisions J5 "Esc only" and J6 "numbers type"). The spec is the authority; each task cites the sections it implements. Where this plan and the spec disagree, the spec wins; stop and report.

## Global Constraints

- Never test against `noah.leap-forward.ca` or `minicraft-server.leap-forward.ca`.
- Never touch port 8080 or `~/minicraft-mp`.
- Headless Playwright only, and block every non-localhost request.
- Kill only servers you started, by port or PID, never with pkill.
- Stage explicit paths only; never `git add -A`, and never stage `.superpowers/`.
- 4-space tabs.
- Every string a player sees says "Noah's Worlds", never "Minicraft".
- Commit messages end with a blank line, then these two lines:
  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Wv64SyRKwvGQi2fmEPuX21
  ```
- Work only in `/home/julien/Projects/Minicraft/.claude/worktrees/cheats` (branch `cheats`).
- Never run `npm ci` or `npm install` in a worktree; deps come through the symlink (`ln -s ../../../node_modules node_modules` if missing). The symlink is not matched by `.gitignore`'s `node_modules/`: never stage it.
- **mp-e2e runs:**
  - Always as `MP_E2E_SCRATCH=/tmp/claude-1000/-home-julien-Projects-Minicraft/b79f7b62-dcf5-4bf5-9b80-08b74dcaef7e/scratchpad/cheats-e2e rtk proxy npx tsx scripts/mp-e2e.ts --only …`, after `mkdir -p` on that directory.
  - Ports 18080, 5174 and 5175 must be free; the script refuses to start otherwise.
- **Solo browser scripts:**
  - Use a free port passed with `--port`, never 5173 or 8080. This plan uses **5186**; check it first with `fuser 5186/tcp` (no output means free).
- **Verification in every task:** `npm test`, `npm run typecheck` and `npm run lint` must all be green before the commit.
- **"Prove red" steps:** make the named mutation, run the named test and see it FAIL with the stated symptom, then revert the mutation. Confirm the revert with `git diff` on that file showing only the intended change. A test that cannot be made red is a defect in the test: fix the test, never skip the step.
- No new player-visible strings other than the six toast texts pinned in Task 2.

## Review Focus

1. **Scrolling the Blocks grid with the mouse wheel** still works after the card's `mousedown` `preventDefault` (the grid is long, and he scrolls it). Test: Task 6, leg "wheel scrolls the grid". Dragging the grid's scrollbar was probed at gate 2 with real 15 px scrollbars and still works with the `mousedown` rule; it has no automated leg.
2. **Clicking a hotbar slot in the I screen's strip** still selects that slot, and focus returns to the box. Digits no longer work while typing, so the strip is his only way. Test: Task 6, leg "strip click".
3. **Esc right after a grant** closes the screen in one press, because the box is already empty. It must not need two presses or leave focus stuck. Test: Task 6, leg "Esc after grant".
4. **Craft tab and back:** after visiting Craft, returning to Blocks puts focus back in the box. The Craft tab has no box, so I there still closes the screen (J5 governs only the focused box). Test: Task 6, leg "craft round trip".
5. **Reopening the I screen after a grant** opens with an empty, focused box, and typing a second code works at once. Test: Task 6, leg "reopen".

---

### Task 1: Shared `Toasts` host (extraction first, E5 before and after)

Spec §8 (extraction, cap, placement) and §11 unit test 5.

**Files:**
- Create: `src/ui/toasts.ts`
- Create: `src/ui/toasts.test.ts`
- Modify: `src/ui/mp-overlays.ts` (constructor takes a `Toasts`; `toast()` delegates; remove the host creation and `TOAST_MS`)
- Modify: `src/main.ts` (one `Toasts` after `#save-status` is created; `new MpOverlays(app, toasts)`; `toasts.setSolo(!mp)` at the top of `startGame`)
- Modify: `src/ui/ui.css` (`#mp-toasts.solo { top: 44px; }`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export type ToastKind = 'mp' | 'cheat'`
  - `export const TOAST_MS = 6_000`
  - `export const CHEAT_TOAST_COLOR = '#f5c542'`
  - `export function nextToasts<T extends { kind: ToastKind }>(current: readonly T[], incoming: T): { keep: T[]; drop: T[] }`
  - `export class Toasts { constructor(app: HTMLElement); setSolo(solo: boolean): void; show(text: string, color?: string, kind?: ToastKind): void }`
  - The DOM names are unchanged: `#mp-toasts`, `.mp-toast`, `.mp-toast-text`, `.mp-dot`.

- [ ] **Step 1: Dependencies and baseline**

Never `npm ci` or `npm install` here: `node_modules` must be the symlink to the shared `/home/julien/Projects/Minicraft/node_modules`, and a reinstall would wipe it for the main checkout and every worktree.

```bash
cd /home/julien/Projects/Minicraft/.claude/worktrees/cheats
[ -e node_modules ] || ln -s ../../../node_modules node_modules
ls -la node_modules   # must print a symlink to ../../../node_modules
npm test && npm run typecheck && npm run lint
mkdir -p /tmp/claude-1000/-home-julien-Projects-Minicraft/b79f7b62-dcf5-4bf5-9b80-08b74dcaef7e/scratchpad/cheats-e2e
fuser 18080/tcp 5174/tcp 5175/tcp   # no output = all free
MP_E2E_SCRATCH=/tmp/claude-1000/-home-julien-Projects-Minicraft/b79f7b62-dcf5-4bf5-9b80-08b74dcaef7e/scratchpad/cheats-e2e rtk proxy npx tsx scripts/mp-e2e.ts --only E5
```

Expected: all green, and `E5 … PASS`. Save the E5 output lines; they are the "before" record. If E5 fails on the untouched tree, stop and report. Do not start the extraction on a red baseline.

- [ ] **Step 2: Write the failing cap test**

`src/ui/toasts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { nextToasts, type ToastKind } from './toasts';

const t = (kind: ToastKind, id: string) => ({ kind, id });

describe('nextToasts: the toast cap (spec §8)', () => {
	it('a cheat toast never evicts a multiplayer toast (catches a global cap pushing out "Noah has to go")', () => {
		const mp1 = t('mp', 'a'), mp2 = t('mp', 'b'), cheat = t('cheat', 'c');
		const r = nextToasts([mp1, mp2], cheat);
		expect(r.keep).toEqual([mp1, mp2, cheat]);
		expect(r.drop).toEqual([]);
	});
	it('a new cheat toast replaces the visible one (catches stacking cheat toasts on Enter mashing)', () => {
		const old = t('cheat', 'x'), mp = t('mp', 'm'), neu = t('cheat', 'y');
		const r = nextToasts([old, mp], neu);
		expect(r.keep).toEqual([mp, neu]);
		expect(r.drop).toEqual([old]);
	});
	it('multiplayer toasts are uncapped, as today (catches a cap applied to them)', () => {
		const a = t('mp', '1'), b = t('mp', '2'), c = t('mp', '3');
		expect(nextToasts([a, b], c)).toEqual({ keep: [a, b, c], drop: [] });
	});
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run src/ui/toasts.test.ts`
Expected: FAIL, "Failed to resolve import ./toasts".

- [ ] **Step 4: Write `src/ui/toasts.ts`**

```ts
/** How long a toast stays up. */
export const TOAST_MS = 6_000;
/** The cheat toast's dot (spec §8). */
export const CHEAT_TOAST_COLOR = '#f5c542';

export type ToastKind = 'mp' | 'cheat';

/**
 * The cap (spec §8): at most one cheat toast; a new one replaces it. Multiplayer toasts are
 * never evicted and never capped. Pure, so the rule is unit-tested without a DOM.
 */
export function nextToasts<T extends { kind: ToastKind }>(current: readonly T[], incoming: T): { keep: T[]; drop: T[] } {
	if (incoming.kind !== 'cheat') return { keep: [...current, incoming], drop: [] };
	return {
		keep: [...current.filter((x) => x.kind !== 'cheat'), incoming],
		drop: current.filter((x) => x.kind === 'cheat'),
	};
}

type Live = { kind: ToastKind; el: HTMLDivElement };

/**
 * The one top-right toast stack of the page, shared by solo and multiplayer (spec §8). The DOM
 * names stay the multiplayer ones: E5 and menu.ts rely on them. `.solo` moves the stack
 * below the #save-status pill.
 */
export class Toasts {
	private host: HTMLDivElement;
	private live: Live[] = [];

	constructor(app: HTMLElement) {
		this.host = document.createElement('div');
		this.host.id = 'mp-toasts';
		app.appendChild(this.host);
	}

	setSolo(solo: boolean): void {
		this.host.classList.toggle('solo', solo);
	}

	show(text: string, color?: string, kind: ToastKind = 'mp'): void {
		const el = document.createElement('div');
		el.className = 'mp-toast';
		if (color !== undefined) {
			const dot = document.createElement('span');
			dot.className = 'mp-dot';
			dot.style.background = color;
			el.appendChild(dot);
		}
		const span = document.createElement('span');
		span.className = 'mp-toast-text';
		span.textContent = text;
		el.appendChild(span);
		const entry: Live = { kind, el };
		const { keep, drop } = nextToasts(this.live, entry);
		for (const d of drop) d.el.remove();
		this.live = keep;
		this.host.appendChild(el);
		setTimeout(() => {
			el.remove();
			this.live = this.live.filter((x) => x !== entry);
		}, TOAST_MS);
	}
}
```

- [ ] **Step 5: Run the test to see it pass**

Run: `npx vitest run src/ui/toasts.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Prove red**

In `nextToasts`, change the cheat branch's `keep` to `[...current.slice(1), incoming]` (a global "drop the oldest" cap). Run the test and expect FAIL in "a cheat toast never evicts a multiplayer toast". Revert.

- [ ] **Step 7: Delegate from `MpOverlays`**

In `src/ui/mp-overlays.ts`:
- Delete `const TOAST_MS = 6_000;`, the `private toasts: HTMLDivElement;` field and the three constructor lines that build `#mp-toasts`.
- Change the constructor to `constructor(private app: HTMLElement, private toasts: Toasts) {}`.
- Add `import type { Toasts } from './toasts';`.
- Replace the body of `toast` with:

```ts
	/** A small toast with a colour dot ("Noah has to go in 2 minutes", "Noah went home"). */
	toast(text: string, color: string): void {
		this.toasts.show(text, color, 'mp');
	}
```

Keep the class doc line about toasts.

- [ ] **Step 8: Wire one `Toasts` in main.ts**

In `src/main.ts`:
- Add `import { Toasts } from './ui/toasts';`.
- Right after `app.appendChild(saveStatus);` add:

```ts
	// One toast stack per page (cheat codes spec §8): multiplayer's toasts and the solo cheat toasts.
	const toasts = new Toasts(app);
```

- Change `const ui = (mpUi ??= new MpOverlays(app));` to `const ui = (mpUi ??= new MpOverlays(app, toasts));`.
- In `startGame`, right after `if (!mp) menu.hide();`, add:

```ts
		// Solo: the toast stack sits below the #save-status pill (spec §8).
		toasts.setSolo(!mp);
```

- [ ] **Step 9: Solo placement CSS**

In `src/ui/ui.css`, directly after the `.mp-toast { … }` block, add:

```css
/* Solo (cheat codes spec §8): below the #save-status pill (top 10px, ~24px tall). */
#mp-toasts.solo {
	top: 44px;
}
```

- [ ] **Step 10: Verify and run E5 after**

```bash
npm test && npm run typecheck && npm run lint
fuser 18080/tcp 5174/tcp 5175/tcp
MP_E2E_SCRATCH=/tmp/claude-1000/-home-julien-Projects-Minicraft/b79f7b62-dcf5-4bf5-9b80-08b74dcaef7e/scratchpad/cheats-e2e rtk proxy npx tsx scripts/mp-e2e.ts --only E5
```

Expected: all green, and E5 PASS with the same check lines as the Step 1 record.

- [ ] **Step 11: Commit**

```bash
git add src/ui/toasts.ts src/ui/toasts.test.ts src/ui/mp-overlays.ts src/main.ts src/ui/ui.css
git commit -m "refactor(ui): one shared toast stack for solo and multiplayer

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wv64SyRKwvGQi2fmEPuX21"
```

---

### Task 2: Cheat data, normalisation and matching

Spec §2 (the table and aliases), §4, §6, §8 (texts) and §11 unit tests 1 and 3 (matching part).

**Files:**
- Create: `src/data/cheats.data.ts`
- Create: `src/game/cheats.ts` (`normalizeCode`, `cheatKeys`, `matchCheat`; Task 3 adds `applyCheat`)
- Create: `src/data/cheats.data.test.ts`
- Create: `src/game/cheats.test.ts`

**Interfaces:**
- Consumes: `BLOCKS`, `BLOCK_BY_NAME` (`src/data/blocks.data.ts`), `PICKAXES`, `PickaxeTier` (`src/data/crafting.data.ts`), `isCounted` (`src/game/inventory.ts`).
- Produces:
  - `export type CheatGrant = { kind: 'block'; name: string; count: number } | { kind: 'pickaxe'; tier: PickaxeTier }`
  - `export type Cheat = { id: string; code: string; also: string[]; grants: CheatGrant[]; message: string }`
  - `export const CHEATS: readonly Cheat[]`
  - `export function normalizeCode(s: string): string`
  - `export function cheatKeys(c: Cheat): string[]`
  - `export function matchCheat(text: string, cheats?: readonly Cheat[]): Cheat | null`

- [ ] **Step 1: Write the failing data test**

`src/data/cheats.data.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { BLOCKS, BLOCK_BY_NAME } from './blocks.data';
import { PICKAXES } from './crafting.data';
import { CHEATS } from './cheats.data';
import { isCounted } from '../game/inventory';
import { cheatKeys, normalizeCode } from '../game/cheats';

const RICH = [
	'coal_ore', 'deepslate_coal_ore', 'copper_ore', 'deepslate_copper_ore', 'iron_ore', 'deepslate_iron_ore',
	'gold_ore', 'deepslate_gold_ore', 'diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore',
	'lapis_ore', 'deepslate_lapis_ore', 'redstone_ore', 'deepslate_redstone_ore',
];

describe('CHEATS (cheat codes spec §2, §6, §8)', () => {
	it('pins the six rows: codes, aliases, grants and toast texts (catches Big Boom with tunnel/flatten/lake, a missing deepslate or a nether ore, a wrong count, a changed toast)', () => {
		const b = (name: string, count: number) => ({ kind: 'block', name, count });
		expect(CHEATS.map((c) => ({ ...c }))).toEqual([
			{ id: 'big_boom', code: 'Big Boom', also: [], grants: [b('tnt', 50), b('big_tnt', 50), b('mega_tnt', 50)], message: 'Big Boom! +50 TNT, Big TNT and Mega TNT' },
			{ id: 'tunnel_this', code: 'Tunnel this!', also: [], grants: [b('tunnel_tnt', 50)], message: 'Tunnel time! +50 Tunnel TNT' },
			{ id: 'mole_man', code: 'I am Mole Man', also: ["I'm Mole Man"], grants: [{ kind: 'pickaxe', tier: 4 }], message: 'Hello, Mole Man! An Iron Pickaxe for you' },
			{ id: 'mole_power', code: 'Mole Power!', also: [], grants: [{ kind: 'pickaxe', tier: 6 }], message: 'Mole Power! A Diamond Pickaxe for you' },
			{ id: 'jump', code: 'Jump!', also: [], grants: [b('slime_pad', 50), b('launch_pad', 50)], message: 'Boing! +50 Slime Pads and Launch Pads' },
			{ id: 'so_rich', code: 'I am so rich!', also: ["I'm so rich!"], grants: RICH.map((n) => b(n, 500)), message: 'So rich! +500 of every ore' },
		]);
	});

	it('the pickaxe rows are Iron and Diamond by label (catches a tier off by one)', () => {
		const tiers = CHEATS.flatMap((c) => c.grants.flatMap((g) => (g.kind === 'pickaxe' ? [PICKAXES[g.tier].label] : [])));
		expect(tiers).toEqual(['Iron Pickaxe', 'Diamond Pickaxe']);
	});

	it('every granted block exists and is counted (catches a typo such as lapis_lazuli_ore: a silent no-op grant)', () => {
		for (const c of CHEATS) for (const g of c.grants) if (g.kind === 'block') {
			expect(Object.hasOwn(BLOCK_BY_NAME, g.name), g.name).toBe(true);
			expect(isCounted(g.name), g.name).toBe(true);
			expect(Number.isInteger(g.count) && g.count > 0, g.name).toBe(true);
		}
	});

	it('normalised codes and aliases are non-empty and unique across rows (catches a new row shadowing an old one)', () => {
		const all = CHEATS.flatMap(cheatKeys);
		for (const k of all) expect(k).not.toBe('');
		const perRow = CHEATS.map((c) => new Set(cheatKeys(c)));
		const union = perRow.flatMap((s) => [...s]);
		expect(new Set(union).size).toBe(union.length);
	});

	it('no block name or label normalises to a code (catches a future catalog row that turns a block search into a code)', () => {
		const keys = new Set(CHEATS.flatMap(cheatKeys));
		for (const def of BLOCKS.filter(Boolean)) {
			expect(keys.has(normalizeCode(def.name)), def.name).toBe(false);
			expect(keys.has(normalizeCode(def.label)), def.label).toBe(false);
		}
	});
});
```

- [ ] **Step 2: Write the failing matching test**

`src/game/cheats.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { matchCheat, normalizeCode } from './cheats';

const id = (text: string) => matchCheat(text)?.id ?? null;

describe('normalizeCode / matchCheat (spec §4)', () => {
	it('ignores case, punctuation and every space (catches a case-sensitive rule, kept punctuation, or only collapsed spaces)', () => {
		for (const s of ['mole power', 'MOLE POWER!!', '  Mole   Power ', 'mole-power', 'molepower']) expect(id(s), s).toBe('mole_power');
	});
	it('matches the aliases and folds accents and fullwidth letters (catches aliases ignored, or no NFKD fold)', () => {
		for (const s of ["I'm so rich!", 'i m so rich', 'I am so rích']) expect(id(s), s).toBe('so_rich');
		expect(id("I'm Mole Man")).toBe('mole_man');
		expect(id('ＪＵＭＰ')).toBe('jump');
	});
	it('is a whole-string match, and blank text matches nothing (catches a substring or prefix rule)', () => {
		for (const s of ['mole powers', 'mole', '', '   ', '!!!', 'diamond', 'tnt', 'big boom please']) expect(id(s), s).toBe(null);
	});
	it('normalizeCode keeps only a-z and 0-9', () => {
		expect(normalizeCode('Tunnel this!')).toBe('tunnelthis');
		expect(normalizeCode('Ünder 9')).toBe('under9');
	});
});
```

- [ ] **Step 3: Run both to see them fail**

Run: `npx vitest run src/data/cheats.data.test.ts src/game/cheats.test.ts`
Expected: FAIL, "Failed to resolve import ./cheats.data" / "./cheats".

- [ ] **Step 4: Write the data**

`src/data/cheats.data.ts`:

```ts
import type { PickaxeTier } from './crafting.data';

/**
 * Cheat codes (spec 2026-09-25-cheat-codes-design). Easter eggs: the UI never lists them;
 * docs/cheats.md does, for the parent. Adding a code is adding a row.
 */
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

- [ ] **Step 5: Write the matching logic**

`src/game/cheats.ts`:

```ts
import { CHEATS, type Cheat } from '../data/cheats.data';

/**
 * Cheat codes (spec §4, §7). Pure. Matching folds Unicode (NFKD, combining marks dropped),
 * lower-cases, then keeps only a–z and 0–9: case, punctuation and every space are ignored.
 */
export function normalizeCode(s: string): string {
	return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** A row's normalised code and aliases. */
export function cheatKeys(c: Cheat): string[] {
	return [c.code, ...c.also].map(normalizeCode);
}

/** The cheat whose normalised code or alias equals the normalised text, or null. Blank → null. */
export function matchCheat(text: string, cheats: readonly Cheat[] = CHEATS): Cheat | null {
	const k = normalizeCode(text);
	if (k === '') return null;
	return cheats.find((c) => cheatKeys(c).includes(k)) ?? null;
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run src/data/cheats.data.test.ts src/game/cheats.test.ts`
Expected: PASS. If the collision test fails, a block label really collides. Stop and report the label; do not change a code.

- [ ] **Step 7: Prove red (three mutations, one at a time)**

1. In `normalizeCode`, remove `.normalize('NFKD')`. `cheats.test.ts` fails on "I am so rích", "Ünder 9" and "ＪＵＭＰ". Revert. (Never use removing `.replace(/\p{M}/gu, '')` as a mutation: the final `[^a-z0-9]` strips the marks anyway, so it stays green. The `\p{M}` step is kept only for clarity.)
2. In `matchCheat`, use `cheatKeys(c).some((key) => key.startsWith(k))`. The whole-string test fails on "mole". Revert.
3. In `cheats.data.ts`, add `block('flatten_tnt', 50)` to Big Boom. The pin test fails. Revert.

- [ ] **Step 8: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint
git add src/data/cheats.data.ts src/data/cheats.data.test.ts src/game/cheats.ts src/game/cheats.test.ts
git commit -m "feat(cheats): code rows, normalisation and matching

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wv64SyRKwvGQi2fmEPuX21"
```

---

### Task 3: `applyCheat`: grant semantics

Spec §7 and §11 unit test 3 (the grant part).

**Files:**
- Modify: `src/game/cheats.ts` (add `applyCheat`)
- Modify: `src/game/cheats.test.ts` (add a `describe('applyCheat')`)

**Interfaces:**
- Consumes: `countOf` (`src/game/inventory.ts`), `Inventory` and `PlayerTools` (`src/data/crafting.data.ts`), `Cheat` (Task 2).
- Produces: `export function applyCheat(player: { inventory: Inventory; tools: PlayerTools }, cheat: Cheat, markDirty: () => void): { pickaxeChanged: boolean }`.
  - It replaces `player.inventory` and `player.tools` with new objects and never mutates the old ones.
  - It calls `markDirty` exactly once.
  - `pickaxeChanged` is true exactly when the equipped tier changed.
  - It never reads or writes the hotbar and takes no `mustMine`.

- [ ] **Step 1: Write the failing tests**

Append to `src/game/cheats.test.ts`, and extend the imports at the top to:

```ts
import { describe, it, expect, vi } from 'vitest';
import { BLOCK_BY_NAME } from '../data/blocks.data';
import type { Inventory, PlayerTools } from '../data/crafting.data';
import { CHEATS } from '../data/cheats.data';
import { canPlace } from './inventory';
import { applyCheat, matchCheat, normalizeCode } from './cheats';
```

```ts
const cheat = (cid: string) => CHEATS.find((c) => c.id === cid)!;
type P = { inventory: Inventory; tools: PlayerTools; hotbar: number[] };
const player = (inventory: Inventory = {}, tools: PlayerTools = { owned: [0], equipped: 0 }): P => ({ inventory, tools, hotbar: [1, 2, 3] });

describe('applyCheat (spec §7)', () => {
	it('adds, never sets: a repeat stacks (catches an idempotent grant or an assignment)', () => {
		const p = player();
		applyCheat(p, cheat('big_boom'), () => {});
		expect([p.inventory.tnt, p.inventory.big_tnt, p.inventory.mega_tnt]).toEqual([50, 50, 50]);
		applyCheat(p, cheat('big_boom'), () => {});
		expect([p.inventory.tnt, p.inventory.big_tnt, p.inventory.mega_tnt]).toEqual([100, 100, 100]);
		const q = player({ big_tnt: 7 });
		applyCheat(q, cheat('big_boom'), () => {});
		expect(q.inventory.big_tnt).toBe(57);
		const z = player({ big_tnt: 0 });
		applyCheat(z, cheat('big_boom'), () => {});
		expect(z.inventory.big_tnt).toBe(50);
	});

	it('is pure on its inputs and marks dirty exactly once (catches in-place mutation of a save in flight, a missing or double markDirty)', () => {
		const inv = { stone: 3 }, tools = { owned: [0], equipped: 0 };
		const p = player(inv, tools);
		const dirty = vi.fn();
		applyCheat(p, cheat('so_rich'), dirty);
		expect(dirty).toHaveBeenCalledTimes(1);
		expect(inv).toEqual({ stone: 3 });
		expect(tools).toEqual({ owned: [0], equipped: 0 });
		expect(p.inventory).not.toBe(inv);
		expect(p.inventory.deepslate_emerald_ore).toBe(500);
		expect(p.inventory.stone).toBe(3);
		applyCheat(p, cheat('mole_man'), dirty);
		expect(dirty).toHaveBeenCalledTimes(2);
	});

	it('never touches the hotbar (J2: grid only)', () => {
		const p = player();
		for (const c of CHEATS) applyCheat(p, c, () => {});
		expect(p.hotbar).toEqual([1, 2, 3]);
	});

	it('pickaxes: owned without duplicates, equipped only above the EQUIPPED tier (catches always-equip, never-equip, comparing with the best owned, or a duplicate)', () => {
		const run = (tools: PlayerTools, cid: string) => {
			const p = player({}, tools);
			const r = applyCheat(p, cheat(cid), () => {});
			return [p.tools, r.pickaxeChanged];
		};
		expect(run({ owned: [0], equipped: 0 }, 'mole_man')).toEqual([{ owned: [0, 4], equipped: 4 }, true]);
		expect(run({ owned: [0, 6], equipped: 6 }, 'mole_man')).toEqual([{ owned: [0, 4, 6], equipped: 6 }, false]);
		expect(run({ owned: [0, 6], equipped: 0 }, 'mole_man')).toEqual([{ owned: [0, 4, 6], equipped: 4 }, true]);
		expect(run({ owned: [0, 4], equipped: 4 }, 'mole_man')).toEqual([{ owned: [0, 4], equipped: 4 }, false]);
		expect(run({ owned: [0, 4, 6], equipped: 4 }, 'mole_power')).toEqual([{ owned: [0, 4, 6], equipped: 6 }, true]);
	});

	it('granted blocks become placeable (catches a grant to the wrong key)', () => {
		const p = player();
		applyCheat(p, cheat('big_boom'), () => {});
		applyCheat(p, cheat('so_rich'), () => {});
		expect(canPlace(p.inventory, BLOCK_BY_NAME.big_tnt.id, false)).toBe(true);
		expect(canPlace(p.inventory, BLOCK_BY_NAME.diamond_ore.id, true)).toBe(true);
	});
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run src/game/cheats.test.ts`
Expected: FAIL, "applyCheat is not a function" (or a TS import error).

- [ ] **Step 3: Implement**

Append to `src/game/cheats.ts`, with the imports added at the top:

```ts
import type { Inventory, PlayerTools } from '../data/crafting.data';
import { countOf } from './inventory';
```

```ts
/**
 * Spec §7. Adds every block grant to its count (no cap) and owns every pickaxe grant, equipping
 * it only when its tier is above the equipped tier. Replaces `player.inventory` and `player.tools`
 * with new objects (a save in flight holds the old ones), never touches the hotbar, and makes the
 * grant path's only markDirty call. `pickaxeChanged`: the equipped tier changed.
 */
export function applyCheat(
	player: { inventory: Inventory; tools: PlayerTools },
	cheat: Cheat,
	markDirty: () => void,
): { pickaxeChanged: boolean } {
	const inv: Inventory = { ...player.inventory };
	let owned = [...player.tools.owned];
	let equipped = player.tools.equipped;
	for (const g of cheat.grants) {
		if (g.kind === 'block') {
			inv[g.name] = countOf(inv, g.name) + g.count;
		} else {
			if (!owned.includes(g.tier)) owned = [...owned, g.tier].sort((a, b) => a - b);
			if (g.tier > equipped) equipped = g.tier;
		}
	}
	const pickaxeChanged = equipped !== player.tools.equipped;
	player.inventory = inv;
	player.tools = { owned, equipped };
	markDirty();
	return { pickaxeChanged };
}
```

- [ ] **Step 4: Run to see it pass**

Run: `npx vitest run src/game/cheats.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove red (one at a time)**

1. Change `inv[g.name] = countOf(inv, g.name) + g.count` to `inv[g.name] = g.count`. The "adds, never sets" test fails at 100. Revert.
2. Change `if (g.tier > equipped)` to `if (true)`. The pickaxe test fails on `{[0,6],6}`. Revert.
3. Change the comparison to `g.tier > Math.max(...player.tools.owned)`. The pickaxe test fails on `{[0,6],0}`. Revert.
4. Delete `markDirty();`. The "exactly once" test fails. Revert.

- [ ] **Step 6: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint
git add src/game/cheats.ts src/game/cheats.test.ts
git commit -m "feat(cheats): applyCheat grant semantics

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wv64SyRKwvGQi2fmEPuX21"
```

---

### Task 4: Enter, focus and refocus wiring

Spec §5 (all of it), §7 (main.ts is the only caller) and §11 unit test 4.

**Reviewer note:** the DOM behaviour in this task (focus, refocus, clicks, the opening key, the repeat guard, J5 "Esc only" and J6 "numbers type") has no node-environment test. It is proven red in Task 6: every row of Task 6's prove-red table mutates code written here. J5 and J6 need no extra code: the focused box already swallows I and the digits (`stopPropagation`, and `searchKey` returns `'type'`). This task still runs the existing crafting smoke as a regression check, because J1 changes how the I screen takes keys.

**Files:**
- Modify: `src/ui/craft-model.ts` (`searchKey`)
- Modify: `src/ui/inventory-search.test.ts`
- Modify: `src/ui/inventory.ts` (focus in `open`/`setTab`, blur in `close`/`setTab('craft')`, the blur→rAF refocus, card `mousedown`, tile and pickaxe-row refocus, repeat guard, Enter → `onSearchEnter`)
- Modify: `src/main.ts` (`preventDefault` on the `'inventory'` keydown; `inventory.onSearchEnter`)
- Modify: `docs/inventory.md` line 8 (I no longer closes while typing in the search box)

**Interfaces:**
- Consumes:
  - `normalizeCode`, `matchCheat` and `applyCheat` (Tasks 2 and 3).
  - `Toasts.show` and `CHEAT_TOAST_COLOR` (Task 1).
  - `toasts`, the main.ts constant from Task 1.
- Produces:
  - `searchKey(code: string, query: string, isComposing?: boolean, key?: string): 'clear' | 'close' | 'submit' | 'type'`.
  - `Inventory.onSearchEnter: ((text: string) => boolean) | null`.
  - The search box keeps its class `.inventory-search`.

- [ ] **Step 1: Write the failing unit tests**

In `src/ui/inventory-search.test.ts`, keep every existing test unchanged and add inside `describe('searchKey…')`:

```ts
	it('Enter over a code-shaped query submits, from Enter, NumpadEnter or a virtual keyboard (catches Enter not distinguished, or code === "" ignored)', () => {
		expect(searchKey('Enter', 'big boom')).toBe('submit');
		expect(searchKey('NumpadEnter', 'x')).toBe('submit');
		expect(searchKey('', 'x', false, 'Enter')).toBe('submit');
	});

	it('Enter over an empty or punctuation-only box, or during IME composition, only types (catches an empty-box submit or a lost IME guard)', () => {
		expect(searchKey('Enter', '')).toBe('type');
		expect(searchKey('Enter', '  !! ')).toBe('type');
		expect(searchKey('Enter', 'x', true)).toBe('type');
	});

	it('I and P type into the box (J1: the game never sees them while he types)', () => {
		expect(searchKey('KeyI', 'x')).toBe('type');
		expect(searchKey('KeyP', 'x')).toBe('type');
	});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run src/ui/inventory-search.test.ts`
Expected: FAIL, `expected 'type' to be 'submit'`.

- [ ] **Step 3: Implement `searchKey`**

In `src/ui/craft-model.ts`, add `import { normalizeCode } from '../game/cheats';` and replace `searchKey` and its doc comment:

```ts
/**
 * What a key does while the Blocks-tab search box has focus: Esc clears the text, or closes the I screen when the
 * box is already empty; Enter over a code-shaped query submits it (cheat codes spec §5: `code` Enter/NumpadEnter,
 * or `key` Enter from a virtual keyboard whose code is ''); an IME composition always types; every other key only
 * types, so digits, I, P, Tab and Shift never reach the game.
 */
export function searchKey(code: string, query: string, isComposing = false, key = ''): 'clear' | 'close' | 'submit' | 'type' {
	if (isComposing) return 'type';
	if (code === 'Escape') return query === '' ? 'close' : 'clear';
	if (code === 'Enter' || code === 'NumpadEnter' || key === 'Enter') return normalizeCode(query) === '' ? 'type' : 'submit';
	return 'type';
}
```

- [ ] **Step 4: Run to see it pass, then prove red**

Run: `npx vitest run src/ui/inventory-search.test.ts`. Expected: PASS.

Prove red:
1. Remove `|| key === 'Enter'`. The virtual-keyboard case fails. Revert.
2. Remove the `if (isComposing) return 'type';` line. The IME case fails. Revert.

- [ ] **Step 5: Inventory: the search box handlers**

In `src/ui/inventory.ts`:

(a) Add the callback field next to `onEquip`:

```ts
	/** Enter over a code-shaped query (cheat codes spec §5). True: a code was granted, and the box is emptied. */
	onSearchEnter: ((text: string) => boolean) | null = null;
```

(b) Replace the search box's `keydown` listener with:

```ts
		this.search.addEventListener('keydown', (e) => {
			e.stopPropagation();
			// A held letter must not type "iiww" (spec §5); held Enter/Esc/Backspace keep their own rules.
			if (e.repeat && e.key.length === 1) {
				e.preventDefault();
				return;
			}
			const action = searchKey(e.code, this.search.value, e.isComposing, e.key);
			if (action === 'type') return;
			e.preventDefault();
			if (action === 'submit') {
				if (!this.isOpen) return;
				// No match: nothing at all, exactly as before (a reaction would reveal that codes exist).
				if (this.onSearchEnter?.(this.search.value)) {
					this.search.value = '';
					this.applySearch();
				}
			} else if (action === 'clear') {
				this.search.value = '';
				this.applySearch();
			} else {
				this.search.blur();
				this.onClose?.();
			}
		});
		// Tab, Shift+Tab or a backdrop click must not leave the box: the next I would close the
		// screen and Space would jump (spec §5). One frame later, so Esc/close and the Craft tab win.
		this.search.addEventListener('blur', () => {
			requestAnimationFrame(() => {
				if (this.isOpen && this.tab === 'blocks') this.search.focus();
			});
		});
```

(c) After `card.className = 'inventory-card';`, add:

```ts
		// A click on the card never takes focus out of the search box (spec §5); the box itself still takes clicks.
		card.addEventListener('mousedown', (e) => {
			if (e.target !== this.search) e.preventDefault();
		});
```

(d) Add a private helper after `paintPicture`:

```ts
	/** Blocks tab open: focus goes back to the search box (spec §5, J1). */
	private keepSearchFocus(): void {
		if (this.isOpen && this.tab === 'blocks') this.search.focus();
	}
```

(e) In the tile click handler, replace `tile.blur();` with `this.keepSearchFocus();`. In the pickaxe-row button's click handler, replace `b.blur();` with `this.keepSearchFocus();`. Leave the top tab buttons (`b.blur(); this.setTab(tab);`), the craft-tab buttons and the craft buttons as they are.

(f) Replace `open`, `close` and `setTab`:

```ts
	open(): void {
		this.root.classList.remove('hidden');
		this.refreshDots();
		this.render();
		this.keepSearchFocus(); // after .hidden is gone: a hidden input cannot take focus
	}

	close(): void {
		this.root.classList.add('hidden');
		this.search.blur();
	}

	setTab(tab: InventoryTab): void {
		this.tab = tab;
		for (const [t, b] of this.tabButtons) b.classList.toggle('active', t === tab);
		this.blocksPanel.classList.toggle('hidden', tab !== 'blocks');
		this.craftPanel.classList.toggle('hidden', tab !== 'craft');
		this.refreshDots();
		this.render();
		// Also runs from the constructor while the screen is hidden: keepSearchFocus checks isOpen.
		if (tab === 'blocks') this.keepSearchFocus();
		else this.search.blur();
	}
```

- [ ] **Step 6: main.ts: the opening key and the grant**

In `src/main.ts`:

(a) In `onKey`'s `case 'inventory':`, make the first line of the case:

```ts
				case 'inventory':
					// The key that opens the I screen must not type into the search box open() focuses (spec §5).
					if (down) e.preventDefault();
					if (down && !e.repeat) {
```

(the rest of the case is unchanged).

(b) Add the imports:

```ts
import { applyCheat, matchCheat } from './game/cheats';
import { CHEAT_TOAST_COLOR } from './ui/toasts';
```

(Merge with the Task 1 `Toasts` import.)

(c) Directly after the `inventory.onCraft = …;` block, add:

```ts
		// Cheat codes (spec §5, §7): applyCheat makes the grant path's only markDirty call.
		inventory.onSearchEnter = (text) => {
			const cheat = matchCheat(text);
			if (!cheat) return false;
			const out = applyCheat(player, cheat, () => autosave.markDirty());
			if (out.pickaxeChanged) loop.onPickaxeChanged();
			playCraft();
			syncHotbar();
			toasts.show(cheat.message, CHEAT_TOAST_COLOR, 'cheat');
			return true;
		};
```

`loop` and `autosave` are declared later in `startGame`. This runs only from a keydown, after both exist, which is the same pattern as `equipPickaxe`.

- [ ] **Step 7: docs/inventory.md**

On line 8, replace `Esc or I closes it.` with:

`Esc or I closes it. On the Blocks tab the search box has the keyboard as soon as the screen opens, so letters (I included), digits and Space type into it; there, Esc clears the text and then closes.`

Do not mention codes.

- [ ] **Step 8: Unit verification and the crafting smoke regression**

```bash
npm test && npm run typecheck && npm run lint
fuser 5186/tcp   # no output = free
rtk proxy npx tsx scripts/crafting-smoke.ts --port 5186
```

Expected: all green, and the smoke exits 0. The smoke's search leg ("typing 'i' in the search box does not close the I screen", "Esc with text clears…", "Esc on an empty search closes…") must still pass. If a leg that presses I to close the screen on the **Blocks** tab now fails, J1 is working as intended and the leg is stale. Change that leg to press Escape, and note it in the commit body. Change nothing else in the smoke.

- [ ] **Step 9: Commit**

```bash
git add src/ui/craft-model.ts src/ui/inventory-search.test.ts src/ui/inventory.ts src/main.ts docs/inventory.md
git commit -m "feat(cheats): Enter grants a code; the Blocks-tab search box keeps the keyboard

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wv64SyRKwvGQi2fmEPuX21"
```

(Add `scripts/crafting-smoke.ts` to the `git add` only if Step 8 changed it.)

---

### Task 5: `docs/cheats.md` and its two-way test

Spec §2 (J4), §10 and §11 unit test 2.

**Files:**
- Create: `docs/cheats.md`
- Create: `src/data/cheats-docs.test.ts`

**Interfaces:**
- Consumes: `CHEATS` (Task 2).
- Produces: `docs/cheats.md` with exactly one markdown table, whose header is `| code | also | reward |`.

- [ ] **Step 1: Write the failing test**

`src/data/cheats-docs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CHEATS } from './cheats.data';

/** The one table in docs/cheats.md: code | also | reward (spec §11 test 2). */
function tableRows(doc: string): string[][] {
	const lines = doc.split('\n').filter((l) => l.trim().startsWith('|'));
	return lines.map((l) => l.trim().slice(1, -1).split('|').map((c) => c.trim()));
}
const key = (r: { code: string; also: string[]; message: string }) => JSON.stringify([r.code, r.also, r.message]);

describe('docs/cheats.md stays in step with CHEATS, both ways (J4)', () => {
	it('has one code | also | reward table whose rows equal the data rows (catches an undocumented code, a stale doc row, a changed alias or reward text)', () => {
		const rows = tableRows(readFileSync('docs/cheats.md', 'utf8'));
		expect(rows[0]).toEqual(['code', 'also', 'reward']);
		expect(rows[1].every((c) => /^:?-+:?$/.test(c))).toBe(true);
		const doc = rows.slice(2).map(([code, also, reward]) => ({ code, also: also === '' ? [] : also.split(',').map((s) => s.trim()), message: reward }));
		const data = CHEATS.map((c) => ({ code: c.code, also: [...c.also], message: c.message }));
		expect(doc.map(key).sort()).toEqual(data.map(key).sort());
	});
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run src/data/cheats-docs.test.ts`
Expected: FAIL, "ENOENT … docs/cheats.md".

- [ ] **Step 3: Write the doc**

`docs/cheats.md`:

```markdown
# Cheat codes (for parents)

Secret codes Noah can type into the search box of the I screen (Blocks tab), then press Enter.
The game never lists them, and a wrong code does nothing at all. Case, spaces and punctuation do
not matter ("molepower" works). A code can be used again any time; each Enter gives the reward
again. Items go into the Blocks grid, never onto the hotbar. They work in multiplayer too.
Only the player who types a code sees its message.

A pickaxe from a code is equipped only if it is better than the one in hand.

The source of truth is `src/data/cheats.data.ts`; `src/data/cheats-docs.test.ts` keeps this
table in step with it, both ways.

| code | also | reward |
|---|---|---|
| Big Boom |  | Big Boom! +50 TNT, Big TNT and Mega TNT |
| Tunnel this! |  | Tunnel time! +50 Tunnel TNT |
| I am Mole Man | I'm Mole Man | Hello, Mole Man! An Iron Pickaxe for you |
| Mole Power! |  | Mole Power! A Diamond Pickaxe for you |
| Jump! |  | Boing! +50 Slime Pads and Launch Pads |
| I am so rich! | I'm so rich! | So rich! +500 of every ore |

The reward column is the toast he sees. In full: Big Boom gives 50 each of TNT, Big TNT and Mega
TNT (not Tunnel, Flattening or Lake TNT); Tunnel this! gives 50 Tunnel TNT; I am Mole Man gives
the Iron Pickaxe (tier 4); Mole Power! gives the Diamond Pickaxe (tier 6); Jump! gives 50 Slime
Pads and 50 Launch Pads; I am so rich! gives 500 of each of the 16 stone and deepslate ores (coal,
copper, iron, gold, diamond, emerald, lapis and redstone), not the nether ores.
```

- [ ] **Step 4: Run to see it pass**

Run: `npx vitest run src/data/cheats-docs.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove red, both directions**

1. Delete the `Jump!` row from the doc. The test fails (data has a row the doc lacks). Restore it.
2. Add `| Fly away |  | Whoosh |` to the table. The test fails (the doc has a row the data lacks). Remove it.
3. Change `I'm Mole Man` in the doc to `Im Mole Man`. The test fails (alias text). Restore it.

- [ ] **Step 6: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint
git add docs/cheats.md src/data/cheats-docs.test.ts
git commit -m "docs(cheats): parent-only code list, kept in step with the data

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wv64SyRKwvGQi2fmEPuX21"
```

---

### Task 6: Solo browser tests (`scripts/cheat-smoke.ts`)

Spec §11 browser tests 6–10, plus the five Review Focus legs.

**Files:**
- Modify: `src/main.ts` (DEV only: wrap `autosave.markDirty` with a counter and expose `markDirtyCalls` on `__mc`)
- Create: `scripts/cheat-smoke.ts`
- Modify: `package.json` (`"smoke:cheats": "tsx scripts/cheat-smoke.ts"`)

**Interfaces:**
- Consumes: everything from Tasks 1–4. Selectors: `.inventory-search`, `#inventory-root`, `.inventory-card`, `.inventory-grid`, `.inventory-tile[data-block=…] .count-badge`, `.inventory-tab[data-tab=…]`, `.inventory-strip`, `#mp-toasts`, `.mp-toast`, `#save-status`, `#hud-pickaxe[data-tier]`.
- Produces: `__mc.markDirtyCalls(): number` (DEV only).

- [ ] **Step 1: The markDirty counter (DEV)**

In `src/main.ts`, directly after the `if (mp) { … } else { … autosave = soloSave; }` block, add:

```ts
		// DEV oracle (cheat codes spec §11 test 9): count calls into the real AutoSave/MpSync
		// markDirty. Every caller goes through `autosave`, so the wrapper sees them all.
		let markDirtyCalls = 0;
		if (import.meta.env.DEV) {
			const inner = autosave;
			autosave = {
				markDirty: () => {
					markDirtyCalls++;
					inner.markDirty();
				},
				flush: () => inner.flush(),
			};
		}
```

In the `__mc = { … }` object, add `markDirtyCalls: () => markDirtyCalls,`.

- [ ] **Step 2: Write the smoke**

`scripts/cheat-smoke.ts`. It is self-contained and follows `scripts/crafting-smoke.ts` (`startDev` with `--strictPort`, a busy-port refusal, stop by port, and a `guard` that aborts every non-localhost request and blocks the dead API):

```ts
// scripts/cheat-smoke.ts — browser smoke of the cheat codes (spec 2026-09-25-cheat-codes-design §11 tests 6–10).
//
//   npm run smoke:cheats -- --port 5186
//
// Starts its OWN Vite dev server on --port (required; never 5173 or 8080; --strictPort) with
// VITE_MINICRAFT_API_URL on a dead local port, drives HEADLESS Chromium at 1280×720 in a new
// Sandbox world. Exit 0 = every check passed, 1 = a check failed, 2 = the page tried to reach a
// non-localhost host. It stops only the server it started, by port.
import { chromium, type Page } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';

function arg(name: string): string | null {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : null;
}
const PORT = Number(arg('--port'));
if (!Number.isInteger(PORT) || PORT === 5173 || PORT === 8080) {
	console.error('cheat-smoke: pass --port <free port> (never 5173 or 8080)');
	process.exit(1);
}
const DEAD_API = 'http://127.0.0.1:9099';
let stopDev: (() => void) | null = null;
const failures: string[] = [];
function check(ok: boolean, what: string) {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
	if (!ok) failures.push(what);
}

async function startDev(): Promise<() => void> {
	try {
		await fetch(`http://localhost:${PORT}/`);
		throw new Error(`port ${PORT} is already serving; this script never reuses a server it did not start`);
	} catch (e) {
		if ((e as Error).message.startsWith('port')) throw e;
	}
	const p = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
		env: { ...process.env, VITE_MINICRAFT_API_URL: DEAD_API },
		stdio: 'ignore',
	});
	const stop = () => { spawnSync('fuser', ['-k', `${PORT}/tcp`], { stdio: 'ignore' }); p.kill(); };
	for (let i = 0; i < 60; i++) {
		if (p.exitCode !== null) throw new Error(`dev server exited with ${p.exitCode}`);
		try { await fetch(`http://localhost:${PORT}/`); return stop; }
		catch { await new Promise((r) => setTimeout(r, 500)); }
	}
	stop();
	throw new Error('dev server did not start');
}

async function guard(page: Page) {
	await page.route('**/*', (route) => {
		const url = new URL(route.request().url());
		if (url.origin === DEAD_API) return route.abort();
		if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
		console.error(`cheat-smoke: ABORT — the page tried to reach ${url.href}`);
		void route.abort();
		stopDev?.();
		process.exit(2);
	});
}

type Mc = {
	player: { inventory: Record<string, number>; tools: { owned: number[]; equipped: number }; selected: number };
	markDirtyCalls(): number;
	loop: { stats: { streamQueue: number; mounted: number } };
};
const mc = <T>(page: Page, fn: (m: Mc) => T) => page.evaluate(`(${fn.toString()})(window.__mc)`) as Promise<T>;
const inv = (page: Page, name: string) => mc(page, (m) => m.player.inventory).then((i) => i[name] ?? 0);
const isOpen = (page: Page) => page.locator('#inventory-root').isVisible();
const boxValue = (page: Page) => page.locator('.inventory-search').inputValue();
/**
 * The blur→rAF refocus lands one frame later: wait for it before typing (else "Jump!" loses its J).
 * Resolves true/false, never throws, so a missing refocus prints a FAIL line through check().
 */
const boxFocused = (page: Page) => page.waitForFunction(() => document.activeElement === document.querySelector('.inventory-search'), null, { timeout: 2_000 }).then(() => true, () => false);
/** Blur events on the search box so far (the listener is installed after the world loads). */
const blurs = (page: Page) => page.evaluate(() => (window as unknown as { __searchBlurs: number }).__searchBlurs);
const badge = (page: Page, name: string) => page.locator(`.inventory-tile[data-block="${name}"] .count-badge`).innerText().then((s) => s.trim());

async function enterWorld(page: Page) {
	await page.waitForFunction(() => (window as unknown as { __mc?: unknown }).__mc !== undefined, null, { timeout: 60_000 });
	await page.waitForFunction(() => {
		const m = (window as unknown as { __mc: Mc }).__mc;
		return m.loop.stats.streamQueue === 0 && m.loop.stats.mounted >= 81;
	}, null, { timeout: 60_000 });
}

process.on('exit', () => stopDev?.());
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => process.exit(130));

(async () => {
	stopDev = await startDev();
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
		await guard(page);
		await page.addInitScript('window.__name = (f) => f;');
		await page.goto(`http://localhost:${PORT}/`);
		// A new Sandbox world (no must-mine): home → Single Player → New World → Create → Play.
		await page.click('#home-single');
		await page.click('#single-new');
		await page.fill('#w-seed', '5');
		await page.click('#w-create');
		await page.click('#single-play');
		await enterWorld(page);
		// Count blur events on the box: the refocus hides a blur from activeElement, not from this counter.
		await page.evaluate(() => {
			const w = window as unknown as { __searchBlurs: number };
			w.__searchBlurs = 0;
			document.querySelector('.inventory-search')!.addEventListener('blur', () => { w.__searchBlurs++; });
		});

		// --- Held keys: a repeat keydown for a letter is swallowed (spec §5). ---
		// A synthetic keydown never types, so the oracle is defaultPrevented: the guard calls preventDefault.
		await page.keyboard.press('KeyI');
		const held = await page.evaluate(() => {
			const box = document.querySelector('.inventory-search') as HTMLInputElement;
			const fire = (code: string, key: string) => {
				const ev = new KeyboardEvent('keydown', { code, key, repeat: true, bubbles: true, cancelable: true });
				box.dispatchEvent(ev);
				return ev.defaultPrevented;
			};
			return { i: fire('KeyI', 'i'), w: fire('KeyW', 'w'), box: box.value };
		});
		check(held.i && held.w && held.box === '', `held I and W repeats are swallowed (I ${held.i}, W ${held.w}, box ${JSON.stringify(held.box)})`);
		await page.keyboard.press('Escape'); // empty box: closes

		// --- Test 6: I then type at once (J1). ---
		await page.keyboard.press('KeyI');
		await page.keyboard.type('I am so rich!');
		check(await boxValue(page) === 'I am so rich!', `the box holds exactly the code, no leading "i" (got ${JSON.stringify(await boxValue(page))})`);
		await page.keyboard.press('Enter');
		check(await isOpen(page), 'the I screen is still open after typing "I am so rich!"');
		check(await inv(page, 'deepslate_emerald_ore') === 500, 'deepslate_emerald_ore is 500');
		check(await boxValue(page) === '', 'a granted code empties the box');
		// Own a second pickaxe first, so a stray P would really switch; the alias covers J3 in the browser.
		await page.keyboard.type("I'm Mole Man");
		await page.keyboard.press('Enter');
		check(await mc(page, (m) => m.player.tools.equipped) === 4, `"I'm Mole Man" (alias): the Iron Pickaxe is equipped`);
		await page.keyboard.type('Jump!');
		await page.keyboard.press('Enter');
		check(await isOpen(page), 'the I screen is still open after "Jump!"');
		check(await mc(page, (m) => m.player.tools.equipped) === 4, 'the P in "Jump!" did not swap the pickaxe (still Iron)');
		check(await inv(page, 'slime_pad') === 50, 'slime_pad is 50');

		// --- Test 7: click, Tab, Shift+Tab and the backdrop keep the box. ---
		const blurs0 = await blurs(page);
		await page.click('.inventory-tile[data-block="stone"]');
		check(await blurs(page) === blurs0, `a tile click never blurs the box (blur events ${blurs0} → ${await blurs(page)})`);
		check(await boxFocused(page), 'after a tile click, focus is in the box');
		await page.keyboard.type('Tunnel this!');
		await page.keyboard.press('Enter');
		check(await isOpen(page) && await inv(page, 'tunnel_tnt') === 50, 'after a tile click, "Tunnel this!" grants and the screen stays open');
		await page.keyboard.press('Tab');
		check(await boxFocused(page), 'after Tab, focus returns to the box');
		await page.keyboard.press('Shift+Tab');
		check(await boxFocused(page), 'after Shift+Tab, focus returns to the box');
		const spot = await page.evaluate(() => {
			const card = document.querySelector('.inventory-card')!.getBoundingClientRect();
			const x = Math.max(4, Math.floor(card.left / 2)), y = Math.floor(window.innerHeight / 2);
			return { x, y, root: document.elementFromPoint(x, y)?.id ?? '' };
		});
		check(spot.root === 'inventory-root', `the backdrop point (${spot.x}, ${spot.y}) is #inventory-root (got ${spot.root})`);
		await page.mouse.click(spot.x, spot.y);
		check(await boxFocused(page), 'after a backdrop click, focus returns to the box');
		await page.keyboard.type('Jump!');
		await page.keyboard.press('Enter');
		check(await isOpen(page) && await inv(page, 'slime_pad') === 100, 'after Tab, Shift+Tab and a backdrop click, "Jump!" grants (slime_pad 100)');

		// --- Test 8: no match keeps the box. ---
		await page.keyboard.type('diamond');
		await page.keyboard.press('Enter');
		check(await boxValue(page) === 'diamond', 'no match: the box still says "diamond"');
		check(!(await page.locator('.inventory-tile[data-block="stone"]').isVisible()), 'no match: the grid is still filtered');
		await page.keyboard.press('Escape'); // clears; the screen stays open

		// --- Test 9: grant, toast and markDirty (one evaluate). ---
		const g = await page.evaluate(() => {
			const m = (window as unknown as { __mc: Mc }).__mc;
			const box = document.querySelector('.inventory-search') as HTMLInputElement;
			const n0 = m.markDirtyCalls();
			box.value = '  big BOOM!! ';
			box.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true }));
			return { calls: m.markDirtyCalls() - n0, box: box.value, big: m.player.inventory.big_tnt ?? 0 };
		});
		check(g.calls === 1, `one Enter = exactly one markDirty (got ${g.calls})`);
		check(g.box === '' && g.big === 50, `the box is empty and big_tnt is 50 (box ${JSON.stringify(g.box)}, big_tnt ${g.big})`);
		check(await badge(page, 'big_tnt') === '50', 'the Big TNT tile shows 50');
		const t = await page.evaluate(() => {
			const host = document.getElementById('mp-toasts')!;
			const toasts = [...host.querySelectorAll('.mp-toast')];
			const pill = document.getElementById('save-status')!.getBoundingClientRect();
			return {
				solo: host.classList.contains('solo'),
				n: toasts.length,
				text: toasts.map((e) => e.textContent ?? ''),
				hostZ: Number(getComputedStyle(host).zIndex),
				invZ: Number(getComputedStyle(document.getElementById('inventory-root')!).zIndex),
				top: toasts[0]?.getBoundingClientRect().top ?? -1,
				pillBottom: pill.bottom,
				pillHeight: pill.height,
			};
		});
		check(t.solo, 'the toast host has .solo in a solo game');
		check(t.n === 1 && t.text[0].includes('Big Boom!'), `exactly one toast, and it says "Big Boom!" (${JSON.stringify(t.text)})`);
		check(t.hostZ > t.invZ, `toast z-index ${t.hostZ} is above the I screen's ${t.invZ}`);
		// The pill is laid out in solo even at opacity 0 (class "saved"), so its box is its solo position.
		check(t.pillHeight > 0 && t.top >= t.pillBottom, `the toast (top ${t.top}) is below the save pill (bottom ${t.pillBottom})`);
		await page.keyboard.type('Big Boom');
		await page.keyboard.press('Enter');
		check(await inv(page, 'big_tnt') === 100, 'a repeat stacks: big_tnt 100');
		check(await page.locator('#mp-toasts .mp-toast').count() === 1, 'a second cheat toast replaced the first');

		// --- Review Focus legs. ---
		// Esc after grant: the box is empty, so one Esc closes. Reopen: empty and focused.
		await page.keyboard.press('Escape');
		check(!(await isOpen(page)), 'Esc after a grant closes the I screen in one press');
		// J5 Esc only: I types, never closes; Esc clears, then Esc closes.
		await page.keyboard.press('KeyI');
		await page.keyboard.press('KeyI');
		await page.keyboard.press('KeyI');
		check(await isOpen(page) && await boxValue(page) === 'ii', `I, I: the screen stays open and the box holds "ii" (got ${JSON.stringify(await boxValue(page))})`);
		await page.keyboard.press('Escape');
		check(await isOpen(page) && await boxValue(page) === '', 'the first Esc clears the text and keeps the screen open');
		await page.keyboard.press('Escape');
		check(!(await isOpen(page)), 'the second Esc closes the screen');
		await page.keyboard.press('KeyI');
		check(await isOpen(page) && await boxValue(page) === '', 'reopen: the screen opens with an empty box');
		check(await boxFocused(page), 'reopen: the box has focus');
		await page.keyboard.type('Mole Power!');
		await page.keyboard.press('Enter');
		// Test 10 rides on the reopen leg.
		check(await page.locator('#hud-pickaxe').getAttribute('data-tier') === '6', 'Mole Power!: the HUD shows the diamond pickaxe');
		// Wheel scrolls the grid (Review Focus 1; the scrollbar drag was probed at gate 2).
		const before = await page.locator('.inventory-grid').evaluate((e) => e.scrollTop);
		await page.locator('.inventory-grid').hover();
		await page.mouse.wheel(0, 600);
		await page.waitForTimeout(300);
		check(await page.locator('.inventory-grid').evaluate((e) => e.scrollTop) > before, 'the mouse wheel over the Blocks grid scrolls it');
		// Strip click selects a slot and focus returns to the box.
		const sel0 = await mc(page, (m) => m.player.selected);
		const target = (sel0 + 3) % 9;
		await page.locator('.inventory-strip > *').nth(target).click();
		check(await mc(page, (m) => m.player.selected) === target, `a strip click selects slot ${target}`);
		check(await boxFocused(page), 'after a strip click, focus is in the box');
		// Craft round trip: I closes from Craft; back on Blocks the box has focus.
		await page.click('.inventory-tab[data-tab="craft"]');
		await page.keyboard.press('KeyI');
		check(!(await isOpen(page)), 'I on the Craft tab closes the screen');
		await page.keyboard.press('KeyI');
		await page.click('.inventory-tab[data-tab="blocks"]');
		check(await boxFocused(page), 'back on Blocks, the box has focus');
		await page.keyboard.press('Escape');

		// Persistence: wait past AutoSave's 5 s debounce, reload, and continue the same world.
		await page.waitForTimeout(6_000);
		await page.reload();
		await page.click('#home-single');
		await page.waitForSelector('#single-worlds .world-row.selected');
		await page.click('#single-play');
		await enterWorld(page);
		check(await inv(page, 'big_tnt') === 100, 'after a reload big_tnt is still 100');
		check(await inv(page, 'deepslate_emerald_ore') === 500, 'after a reload deepslate_emerald_ore is still 500');
		check(await mc(page, (m) => m.player.tools.owned.includes(6)), 'after a reload the Diamond Pickaxe is still owned');
	} finally {
		await browser.close();
	}
	stopDev?.();
	console.log(failures.length === 0 ? 'cheat-smoke: PASS' : `cheat-smoke: ${failures.length} FAIL`);
	process.exit(failures.length === 0 ? 0 : 1);
})().catch((e) => {
	console.error(e);
	stopDev?.();
	process.exit(1);
});
```

Add to `package.json` `scripts`, after `"smoke:menu"`: `"smoke:cheats": "tsx scripts/cheat-smoke.ts",`.

Before running, confirm `.inventory-strip`'s children are the slot elements in slot order (read `Inventory.setHotbar` in `src/ui/inventory.ts`). If they are wrapped, adjust that one selector and nothing else.

- [ ] **Step 3: Run it green**

```bash
fuser 5186/tcp
rtk proxy npx tsx scripts/cheat-smoke.ts --port 5186
```

Expected: `cheat-smoke: PASS`, exit 0.

- [ ] **Step 4: Prove red (one mutation at a time; re-run the smoke after each and revert)**

| Mutation (in Task 4/1 code) | Expected FAIL line |
|---|---|
| main.ts: delete `if (down) e.preventDefault();` in `case 'inventory'` | `the box holds exactly the code, no leading "i"` (got "iI am so rich!") |
| inventory.ts `open()`: delete `this.keepSearchFocus();` | `the box holds exactly the code, no leading "i"` (the typed I closes the screen, so the box is empty) |
| inventory.ts: delete the search box's `blur` listener | `after Tab, focus returns to the box` |
| inventory.ts tile click: put back `tile.blur();` instead of `this.keepSearchFocus();`, and remove the card `mousedown` listener | `a tile click never blurs the box (blur events n → n+1)` |
| inventory.ts keydown: delete the `if (e.repeat && e.key.length === 1) { … }` guard | `held I and W repeats are swallowed (I false, W false, …)` |
| inventory.ts keydown: before `searchKey`, add `if (e.code === 'KeyI' && /^i*$/i.test(this.search.value)) { this.onClose?.(); return; }` (I closes when the box holds only "i"s) | `I, I: the screen stays open and the box holds "ii"` |
| inventory.ts keydown: `if (this.onSearchEnter?.(…)) {…}` → clear the box unconditionally on submit | `no match: the box still says "diamond"` |
| main.ts `onSearchEnter`: pass `() => {}` instead of `() => autosave.markDirty()` (the sabotage: the grant path makes no markDirty call) | `one Enter = exactly one markDirty (got 0)` |
| main.ts `onSearchEnter`: add a second `autosave.markDirty();` | `… (got 2)` |
| ui.css: delete the `#mp-toasts.solo` rule | `the toast … is below the save pill` |
| toasts.ts `show`: skip the `drop` removal loop | `a second cheat toast replaced the first` |

For each row: `git diff` shows only that mutation, the smoke fails with that line, then revert and confirm `git diff` is clean for that file.

- [ ] **Step 5: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint
git add src/main.ts scripts/cheat-smoke.ts package.json
git commit -m "test(cheats): headless solo smoke, with a DEV markDirty counter

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wv64SyRKwvGQi2fmEPuX21"
```

---

### Task 7: Multiplayer `E13`, with the sabotage run

Spec §9 and §11 test 11 (E13) and test 12 (E5 and E6 unaffected).

**Files:**
- Modify: `scripts/mp-e2e.ts`
  - the header comment: add E13;
  - `const ctxA` → `let ctxA`;
  - `needMp` gets `'E13'`;
  - the "A comes back" list gets `'E13'`;
  - the new `E13` block goes right after the "A comes back" block, before E3.

**Interfaces:**
- Consumes:
  - From the script: `newPage`, `joinWorld`, `standAt`, `place`, `loadBlocks`, `sleep`, `check`, `scenario`, `want`, `A_WHO`, `WORLD`, `BASE`, `browser`.
  - From main.ts: `__mc.player`, `__mc.mp.log`, `__mc.mp.remote.positions()`, `__mc.world`.
  - The stash key `'mp:extras'`, whose JSON value is `{ tag, data: { inventory, tools, … } }`.
- Produces: scenario `E13`, which leaves `A` pointing at the rejoined page and `ctxA` at its fresh context.

- [ ] **Step 1: Wire the lists**

- In `scripts/mp-e2e.ts`, change `const ctxA = await browser.newContext(…)` to `let ctxA = …`.
- Add `'E13'` to the `needMp` array.
- Change the "A comes back" condition to `['E3', 'E5', 'E6', 'E13', '4009'].some(want)`.
- In the header comment, after the E12 sentence, add: `E13 (cheat codes: a code grants, the stash has it at once, the server keeps it across a rejoin in a fresh context, and a granted Big TNT places for real).`

- [ ] **Step 2: Write E13**

Insert right after the "A comes back" `if` block:

```ts
		// ------------------------------------------------------------------ E13
		// Cheat codes (spec §11 test 11). Before E3/E5/E6; A is replaced by a fresh-context rejoin.
		if (want('E13') && A && B) {
			const b = B;
			await scenario('E13', 'a cheat code grants, persists on the server across a fresh-context rejoin, and places for real', async () => {
				let a = A!;
				// 0. Idle > 5 s: no earlier extras send is still pending.
				await sleep(6_000);
				// 1. I, then type (the box has focus: J1).
				await a.keyboard.press('KeyI');
				await a.keyboard.type('Big Boom');
				// 2. The real instrument: Enter and the stash read in ONE evaluate.
				const s = await a.evaluate(() => {
					const m = (window as any).__mc;
					const stashBig = () => {
						const raw = sessionStorage.getItem('mp:extras');
						return raw === null ? null : (JSON.parse(raw).data?.inventory?.big_tnt ?? 0);
					};
					const before = m.player.inventory.big_tnt ?? 0;
					const box = document.querySelector('.inventory-search') as HTMLInputElement;
					box.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true }));
					return { before, stash: stashBig(), live: m.player.inventory.big_tnt ?? 0, box: box.value, toasts: [...document.querySelectorAll('#mp-toasts .mp-toast-text')].map((e) => e.textContent) };
				});
				check(s.stash === s.before + 50, `the stash holds big_tnt ${s.before} + 50 right after Enter (stash ${s.stash})`);
				check(s.live === s.before + 50 && s.box === '', `live big_tnt ${s.live}, box emptied`);
				check(s.toasts.some((t) => (t ?? '').includes('Big Boom!')), `A sees the Big Boom toast (${JSON.stringify(s.toasts)})`);
				// 3. Two more codes, real keys.
				const emeraldBefore = await a.evaluate(() => (window as any).__mc.player.inventory.deepslate_emerald_ore ?? 0);
				await a.keyboard.type('I am Mole Man');
				await a.keyboard.press('Enter');
				await a.keyboard.type('I am so rich!');
				await a.keyboard.press('Enter');
				const lastGrantAt = Date.now();
				const want0 = await a.evaluate(() => {
					const m = (window as any).__mc;
					return { big: m.player.inventory.big_tnt as number, emerald: m.player.inventory.deepslate_emerald_ore as number, owned: [...m.player.tools.owned] as number[] };
				});
				check(want0.owned.includes(4), `I am Mole Man: tier 4 owned (${JSON.stringify(want0.owned)})`);
				check(want0.emerald === emeraldBefore + 500, `I am so rich!: deepslate_emerald_ore ${emeraldBefore} + 500 = ${want0.emerald}`);
				check(want0.big === s.before + 50, `big_tnt is before + 50 before leaving (${want0.big})`);
				await a.keyboard.press('Escape');
				// 4. Before any pick or place: > 5 s after the LAST grant, then close the PAGE, and wait for B to see A leave.
				const aId = await b.evaluate((name) => ((window as any).__mc.mp.remote.positions() as Array<{ id: number; name: string }>).find((p) => p.name === name)?.id ?? null, A_WHO.name);
				check(aId !== null, `B knows A's id (${aId})`);
				const logStart = await b.evaluate(() => (window as any).__mc.mp.log.length as number);
				await sleep(Math.max(0, 6_000 - (Date.now() - lastGrantAt)));
				await a.close();
				const aLeft = await b.waitForFunction(([id, from]) => (window as any).__mc.mp.log.slice(from).some((m: any) => m.t === 'left' && m.id === id), [aId, logStart] as const, { timeout: 20_000 }).then(() => true, () => false);
				check(aLeft, "B's log shows A left");
				if (!aLeft) return;
				// 5. Rejoin in a FRESH context (empty sessionStorage: only the server can hold the grant).
				const oldCtx = ctxA;
				ctxA = await browser.newContext({ viewport: { width: 960, height: 600 } });
				a = await newPage(ctxA, A_WHO, 'A');
				A = a;
				await joinWorld(a, BASE, WORLD, '10 min');
				await oldCtx.close();
				await sleep(1_500);
				const back = await a.evaluate(() => {
					const m = (window as any).__mc;
					return { stash: sessionStorage.getItem('mp:extras'), big: m.player.inventory.big_tnt ?? 0, emerald: m.player.inventory.deepslate_emerald_ore ?? 0, owned: [...m.player.tools.owned] as number[], playtime: m.playtime !== null };
				});
				check(back.big === want0.big, `after the rejoin big_tnt is ${want0.big} (got ${back.big})`);
				check(back.emerald === want0.emerald, `after the rejoin deepslate_emerald_ore is ${want0.emerald} (got ${back.emerald})`);
				check(back.owned.includes(4), `after the rejoin tier 4 is owned (${JSON.stringify(back.owned)})`);
				check(back.playtime, 'the rejoined A has a play timer (E5 needs it)');
				// 6. Pick the Big TNT tile (J2: not on the hotbar), then a REAL right-click with pointer lock.
				await a.keyboard.press('KeyI');
				await a.click('.inventory-tile[data-block="big_tnt"]');
				await a.keyboard.press('Escape');
				const feet = await pos(a);
				const ground = await standAt(a, Math.floor(feet[0]) + 3, Math.floor(feet[2]) + 3);
				await place(a, [ground[0], ground[1] + 1, ground[2]], 0, -Math.PI / 2 + 0.01);
				const cell = [Math.floor(ground[0]), Math.floor(ground[1]), Math.floor(ground[2])];
				const bigId = await a.evaluate(() => (window as any).__blocks.BLOCK_BY_NAME.big_tnt.id as number);
				const was = await a.evaluate((c) => (window as any).__mc.world.getBlock(c[0], c[1], c[2]) as number, cell);
				check(was === 0, `the target cell ${cell} is air before placing (got ${was})`);
				if (was !== 0) return;
				// The renderer's canvas is the first one in #app; the click requests pointer lock.
				await a.locator('canvas').first().click();
				const locked = await a.waitForFunction(() => document.pointerLockElement === document.querySelector('canvas'), null, { timeout: 5_000 }).then(() => true, () => false);
				// STOP AND REPORT if this fails: never replace the real right-click with setBlock or a synthetic event.
				check(locked, 'A has pointer lock on the game canvas');
				if (!locked) return;
				const aLog = await a.evaluate(() => (window as any).__mc.mp.log.length as number);
				await a.mouse.down({ button: 'right' });
				await a.mouse.up({ button: 'right' });
				const seen = await b.waitForFunction(([x, y, z, id]) => (window as any).__mc.world.getBlock(x, y, z) === id, [cell[0], cell[1], cell[2], bigId] as const, { timeout: 5_000 }).then(() => true, () => false);
				check(seen, `B sees A's Big TNT (id ${bigId}) at ${cell}`);
				const after = await a.evaluate((from) => {
					const m = (window as any).__mc;
					return { big: m.player.inventory.big_tnt ?? 0, errors: m.mp.log.slice(from).filter((x: any) => x.t === 'error').map((x: any) => x.code) };
				}, aLog);
				check(after.big === want0.big - 1, `A's big_tnt dropped by 1 (${want0.big} → ${after.big})`);
				check(after.errors.length === 0, `no server error, no 4003 (${JSON.stringify(after.errors)})`);
				// Clean up for the scenarios after this one (E3 compares hashes).
				await a.evaluate(() => document.exitPointerLock());
				await a.evaluate((c) => (window as any).__mc.world.setBlock(c[0], c[1], c[2], 0), cell);
				await b.waitForFunction((c) => (window as any).__mc.world.getBlock(c[0], c[1], c[2]) === 0, cell, { timeout: 5_000 });
			});
		}
```

Notes for the implementer:
- `standAt` returns the **feet** position on the ground of a column. `place(page, p, yaw, pitch)` sets `flying` and puts the feet at `p`. So the feet end up one block above the ground surface, looking straight down. The ray hits the ground's top face, and the block lands in the ground-level air cell, below the feet, where it cannot intersect the player. If the first real placement attempt shows a different cell, read `tryPlace` (`src/game/place.ts`) and fix `cell` to the cell it writes. Do not switch to `setBlock`.
- **If `locked` is false in headless Chromium, stop and report.** Do not replace the right-click with `setBlock` or a synthetic event; the spec requires the real path.

- [ ] **Step 3: Run E13 green, then the neighbours**

```bash
fuser 18080/tcp 5174/tcp 5175/tcp
MP_E2E_SCRATCH=/tmp/claude-1000/-home-julien-Projects-Minicraft/b79f7b62-dcf5-4bf5-9b80-08b74dcaef7e/scratchpad/cheats-e2e rtk proxy npx tsx scripts/mp-e2e.ts --only E13
MP_E2E_SCRATCH=/tmp/claude-1000/-home-julien-Projects-Minicraft/b79f7b62-dcf5-4bf5-9b80-08b74dcaef7e/scratchpad/cheats-e2e rtk proxy npx tsx scripts/mp-e2e.ts --only E13,E3,E5,E6
```

Expected: E13 PASS alone, then all four PASS together. E6's "same inventory counts" check still passes, because the grants are in both its before and its after.

- [ ] **Step 4: The one-off sabotage run (required)**

In `src/main.ts`'s `inventory.onSearchEnter`, change `applyCheat(player, cheat, () => autosave.markDirty())` to `applyCheat(player, cheat, () => {})`. With that change the grant path makes no `markDirty` call. Then:

```bash
MP_E2E_SCRATCH=/tmp/claude-1000/-home-julien-Projects-Minicraft/b79f7b62-dcf5-4bf5-9b80-08b74dcaef7e/scratchpad/cheats-e2e rtk proxy npx tsx scripts/mp-e2e.ts --only E13
```

Expected: E13 FAIL, with `FAIL the stash holds big_tnt … + 50 right after Enter` at step 2. Record the output lines in the commit body. Step 5's result on this build is not relied on, because liquid or TNT activity nearby can mark the extras dirty anyway (spec §11).

Revert the change, confirm with `git diff src/main.ts` (no output), and re-run `--only E13` to see it PASS again.

- [ ] **Step 5: Verify and commit**

```bash
npm test && npm run typecheck && npm run lint
git add scripts/mp-e2e.ts
git commit -m "test(e2e): E13 cheat codes grant, persist on the server and place for real

Sabotage run (grant path with no markDirty call): E13 FAIL at step 2, <paste the FAIL line>.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wv64SyRKwvGQi2fmEPuX21"
```

---

### Task 8: Whole-branch verification

**Files:** none (unless a check fails).

- [ ] **Step 1: Every suite, once, on the final tree**

```bash
npm test && npm run typecheck && npm run lint && npm run build
cd server && ~/.local/go/bin/go test ./... && cd ..
fuser 5186/tcp
rtk proxy npx tsx scripts/cheat-smoke.ts --port 5186
rtk proxy npx tsx scripts/crafting-smoke.ts --port 5186
fuser 18080/tcp 5174/tcp 5175/tcp
MP_E2E_SCRATCH=/tmp/claude-1000/-home-julien-Projects-Minicraft/b79f7b62-dcf5-4bf5-9b80-08b74dcaef7e/scratchpad/cheats-e2e rtk proxy npx tsx scripts/mp-e2e.ts
```

Expected: everything green, and every mp-e2e scenario PASS.

`npm run build` must not need `.env.local`; if it does, stop and report. Never copy the live multiplayer URL or token into this worktree.

- [ ] **Step 2: No server or protocol change**

Run: `git diff main --stat -- server api src/net/protocol.ts docs/protocol.md`
Expected: no output (spec §9, §10).

- [ ] **Step 3: No code list in the UI**

Run: `grep -rn -i "mole\|so rich\|big boom\|tunnel this" src --include=*.ts | grep -v "cheats.data\|\.test\.ts"`
Expected: no output. The codes live only in the data, its tests and `docs/cheats.md`.
