# Pause Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Esc during a game (solo or multiplayer) opens an overlaid menu — Return to Game · Controls · Quit to Menu — without breaking the I screen, the colour picker, the play timer or the multiplayer freeze.

**Architecture:** Pure decisions (`pause-model.ts`, `controls-model.ts`) are unit tested; a small DOM class (`pause-menu.ts`) renders the card; `main.ts` wires it inside `startGame` next to the I screen's wiring, reusing `loop.paused`, `updatePaused`, `resetKeys`, the reload-to-menu path and the multiplayer leaving countdown. A headless smoke (`scripts/pause-smoke.ts`) and one `mp-e2e` scenario prove the wiring, each check with a named mutant that turns it red.

**Tech Stack:** TypeScript (strict), Vite, Three.js, vitest, Playwright (headless Chromium).

**Spec:** `docs/superpowers/specs/2026-09-25-pause-menu-design.md` (rev 2). Read it first; §2 (M1–M4) explains why Esc works the way it does.

## Global Constraints

- Indentation: tabs, width 4 (repo prettier). Match the surrounding comment density and idiom.
- Work only in the worktree `/home/julien/Projects/Minicraft/.claude/worktrees/pause-menu`, branch `pause-menu`. Never `git add -A` / `git add .`: stage explicit paths (review agents leave probe files; `.claude/agent-memory/` is not ours).
- Never point anything at `noah.leap-forward.ca` or `minicraft-server.leap-forward.ca`. Smokes start their own Vite on a free port with `--strictPort` and a dead save API; any non-localhost request aborts the run.
- Headless browsers only (never a headed window on Julien's display `:1`). Stop servers by port (`fuser -k <port>/tcp`), never `pkill` by name.
- Labels, verbatim: title `Paused` (solo) / `Game Menu` (multiplayer); buttons `Return to Game`, `Controls`, `Quit to Menu`, `Saving…`, `Back`; Controls title `Controls`.
- Quit flush cap: `3000` ms. Pause backdrop z-index `18`.
- No protocol, server, save-format or timer-rule change.
- The worktree needs the atlas before the game loads in a browser: `npm run build-atlas` (writes gitignored `public/atlas.*`). `node_modules` is a symlink to the main checkout's.

## Review Focus

1. A kid clicks Return to Game within ~1.5 s of pressing Esc (Chromium refuses the lock) → the menu must stay up, not leave a running game with a free cursor. Pinned by S6 (Task 6) and manual check 3.
2. Esc pressed while the I screen's search box has focus, or on the Craft tab, or in the colour picker → closes that screen only. Pinned by S8/S9 (Task 6) — the only checks that catch a bubble-phase listener.
3. Quit on slow or dead wifi → reloads within ~3 s, never a stuck "Saving…". Pinned by S13 (Task 6) and the `quitting` latch in Task 5.
4. The play timer runs out while the menu is open → TIME'S UP wins. Pinned by S11 (Task 6).
5. A rebound key (Options) → Controls shows the rebound key, and never a key that does nothing. Pinned by the `controlRows` tests (Task 2).

---

### Task 1: Pause decisions (`pause-model.ts`)

**Files:**
- Create: `src/game/pause-model.ts`
- Test: `src/game/pause-model.test.ts`

**Interfaces:**
- Produces:
  - `type PauseState = { locked: boolean; pauseOpen: boolean; controlsShown: boolean; quitting: boolean; inventoryOpen: boolean; pickerOpen: boolean; frozen: boolean }`
  - `shouldOpenOnUnlock(s: PauseState): boolean` — spec §3.1 rule (a)
  - `type EscapeAction = 'open' | 'back' | 'none'`
  - `escapeAction(s: PauseState, repeat: boolean): EscapeAction` — spec §3.1 rule (b) and §3.2

- [ ] **Step 1: Write the failing test** — `src/game/pause-model.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { escapeAction, shouldOpenOnUnlock, type PauseState } from './pause-model';

const idle: PauseState = { locked: false, pauseOpen: false, controlsShown: false, quitting: false, inventoryOpen: false, pickerOpen: false, frozen: false };

describe('shouldOpenOnUnlock (spec §3.1 a)', () => {
	it('opens on an unlock nobody owns (the real Esc, alt-tab)', () => {
		expect(shouldOpenOnUnlock(idle)).toBe(true);
	});
	it('does not open when the I screen, the colour picker or a freeze released the pointer', () => {
		expect(shouldOpenOnUnlock({ ...idle, inventoryOpen: true })).toBe(false);
		expect(shouldOpenOnUnlock({ ...idle, pickerOpen: true })).toBe(false);
		expect(shouldOpenOnUnlock({ ...idle, frozen: true })).toBe(false);
	});
	it('does not open twice, nor while quitting', () => {
		expect(shouldOpenOnUnlock({ ...idle, pauseOpen: true })).toBe(false);
		expect(shouldOpenOnUnlock({ ...idle, quitting: true })).toBe(false);
	});
});

describe('escapeAction (spec §3.1 b, §3.2)', () => {
	it('opens on Esc with the pointer free and nothing open', () => {
		expect(escapeAction(idle, false)).toBe('open');
	});
	it('does nothing on the Esc that closes the I screen or the colour picker, or under a freeze', () => {
		expect(escapeAction({ ...idle, inventoryOpen: true }, false)).toBe('none');
		expect(escapeAction({ ...idle, pickerOpen: true }, false)).toBe('none');
		expect(escapeAction({ ...idle, frozen: true }, false)).toBe('none');
	});
	it('does nothing while locked (a headless CDP Esc; the real one never arrives, M1)', () => {
		expect(escapeAction({ ...idle, locked: true }, false)).toBe('none');
	});
	it('does nothing on the pause card: Esc can never give the mouse back (M3)', () => {
		expect(escapeAction({ ...idle, pauseOpen: true }, false)).toBe('none');
	});
	it('goes back from the Controls view', () => {
		expect(escapeAction({ ...idle, pauseOpen: true, controlsShown: true }, false)).toBe('back');
	});
	it('ignores auto-repeat and anything while quitting', () => {
		expect(escapeAction(idle, true)).toBe('none');
		expect(escapeAction({ ...idle, pauseOpen: true, controlsShown: true }, true)).toBe('none');
		expect(escapeAction({ ...idle, quitting: true }, false)).toBe('none');
		expect(escapeAction({ ...idle, pauseOpen: true, controlsShown: true, quitting: true }, false)).toBe('none');
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/game/pause-model.test.ts`
Expected: FAIL — cannot resolve `./pause-model`.

- [ ] **Step 3: Implement** — `src/game/pause-model.ts`

```ts
/**
 * The pause menu's decisions (pause menu spec §3.1–§3.2), pure so they are unit tested.
 * main.ts builds the state from its own flags; `locked` is read from document.pointerLockElement.
 */
export type PauseState = {
	locked: boolean;
	pauseOpen: boolean;
	controlsShown: boolean;
	quitting: boolean;
	inventoryOpen: boolean;
	pickerOpen: boolean;
	frozen: boolean;
};

/** The I screen, the colour picker, a freeze or a quit in progress owns the screen. */
function ownedElsewhere(s: PauseState): boolean {
	return s.inventoryOpen || s.pickerOpen || s.frozen || s.quitting;
}

/** Rule (a): a pointer unlock nobody owns — the real Esc (M1), alt-tab — opens the menu. */
export function shouldOpenOnUnlock(s: PauseState): boolean {
	return !s.pauseOpen && !ownedElsewhere(s);
}

export type EscapeAction = 'open' | 'back' | 'none';

/**
 * An Escape keydown, judged on the state from BEFORE any other Esc handler of this event ran
 * (main.ts listens in the capture phase, spec §5.2). Esc on the pause card does nothing: a lock
 * requested from Esc is always refused or dropped (M3), so it could never resume the game.
 */
export function escapeAction(s: PauseState, repeat: boolean): EscapeAction {
	if (repeat || s.quitting) return 'none';
	if (s.pauseOpen) return s.controlsShown ? 'back' : 'none';
	if (s.locked || ownedElsewhere(s)) return 'none';
	return 'open';
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/game/pause-model.test.ts` → PASS.

- [ ] **Step 5: Mutants (record each as seen red, then revert)** — apply one at a time, run the test file, confirm at least one test FAILS, `git checkout src/game/pause-model.ts`:
  1. `ownedElsewhere` drops `s.inventoryOpen`; 2. drops `s.pickerOpen`; 3. drops `s.frozen`; 4. `escapeAction` drops `s.locked ||`; 5. drops `repeat ||`; 6. drops `|| s.quitting` in `escapeAction`'s first line **and** in `ownedElsewhere`; 7. the pause-card branch returns `'open'` instead of `'none'`.

- [ ] **Step 6: Commit**

```bash
git add src/game/pause-model.ts src/game/pause-model.test.ts
git commit -m "feat(pause): pure decisions for the pause menu's Esc and unlock rules"
```

---

### Task 2: Controls rows (`controls-model.ts`, `controls.data.ts`)

**Files:**
- Create: `src/data/controls.data.ts`, `src/ui/controls-model.ts`
- Test: `src/ui/controls-model.test.ts`

**Interfaces:**
- Consumes: `Action`, `DEFAULT_KEYBINDINGS` from `src/data/keybindings.data.ts`; `buildKeyToAction(bindings: Record<Action, string>): Record<string, Action>` from `src/game/input-gate.ts`.
- Produces:
  - `keyText(code: string): string`
  - `type ControlLine = { does: string; keys: string }`
  - `controlRows(bindings: Record<Action, string>): ControlLine[]`

- [ ] **Step 1: Write the failing test** — `src/ui/controls-model.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { controlRows, keyText } from './controls-model';
import { DEFAULT_KEYBINDINGS } from '../data/keybindings.data';

const row = (rows: { does: string; keys: string }[], does: string) => rows.find((r) => r.does === does);

describe('keyText', () => {
	it('shows keys the way the kid sees them on the keyboard', () => {
		expect(keyText('KeyW')).toBe('W');
		expect(keyText('Digit3')).toBe('3');
		expect(keyText('Numpad3')).toBe('Num 3');
		expect(keyText('Space')).toBe('Space');
		expect(keyText('Equal')).toBe('=');
		expect(keyText('Minus')).toBe('-');
		expect(keyText('ShiftLeft')).toBe('Shift');
		expect(keyText('Escape')).toBe('Esc');
		expect(keyText('ArrowUp')).toBe('↑');
		expect(keyText('F7')).toBe('F7');
	});
});

describe('controlRows (spec §3.5)', () => {
	it('lists the default controls in order, kid words', () => {
		const rows = controlRows({ ...DEFAULT_KEYBINDINGS });
		expect(rows.map((r) => r.does)).toEqual([
			'Walk', 'Jump', 'Mine', 'Build', 'Swap a block', 'Choose a block', 'Inventory', 'Change pickaxe',
			'Fly', 'Fly faster / slower', 'Light TNT', 'Lamp color', 'Stop bouncing', 'Menu',
		]);
		expect(row(rows, 'Walk')!.keys).toBe('W A S D');
		expect(row(rows, 'Jump')!.keys).toBe('Space');
		expect(row(rows, 'Fly faster / slower')!.keys).toBe('= / -');
		expect(row(rows, 'Choose a block')!.keys).toBe('1 – 9, Tab');
		expect(row(rows, 'Menu')!.keys).toBe('Esc');
	});
	it('follows a rebinding', () => {
		const rows = controlRows({ ...DEFAULT_KEYBINDINGS, jump: 'KeyJ' });
		expect(row(rows, 'Jump')!.keys).toBe('J');
	});
	it('leaves out an unbound key, and a row whose keys are all unbound', () => {
		const rows = controlRows({ ...DEFAULT_KEYBINDINGS, flySpeedDown: '', ignite: '' });
		expect(row(rows, 'Fly faster / slower')!.keys).toBe('=');
		expect(row(rows, 'Light TNT')).toBeUndefined();
	});
	it('lists the nine slot keys when they are not Digit1…Digit9', () => {
		const rows = controlRows({ ...DEFAULT_KEYBINDINGS, slot1: 'KeyZ' });
		expect(row(rows, 'Choose a block')!.keys).toBe('Z 2 3 4 5 6 7 8 9, Tab');
	});
	it('never shows a key that does nothing: a code bound twice shows on the later action only', () => {
		// buildKeyToAction: the later action in ACTIONS wins; toggleFly comes after jump.
		const rows = controlRows({ ...DEFAULT_KEYBINDINGS, toggleFly: DEFAULT_KEYBINDINGS.jump });
		expect(row(rows, 'Jump')).toBeUndefined();
		expect(row(rows, 'Fly')!.keys).toBe('Space');
	});
});
```

Before Step 3, check `DEFAULT_KEYBINDINGS` in `src/data/keybindings.data.ts` and that `toggleFly` comes after `jump` in `ACTIONS` (it does today); if a default differs from the expectations above (e.g. jump is not `Space`, fly speed is not `Equal`/`Minus`), fix the **test expectation** to the real default and say so in the task report.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/ui/controls-model.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement the data** — `src/data/controls.data.ts`

```ts
import type { Action } from './keybindings.data';

/**
 * The pause menu's Controls view (pause menu spec §3.5), in display order. Kid words, not the Options
 * screen's labels. A row shows fixed text, the live keys of its actions, or (slots) the hotbar keys.
 */
export type ControlRow =
	| { does: string; fixed: string }
	| { does: string; actions: Action[]; sep: string }
	| { does: string; slots: true };

export const CONTROL_ROWS: ControlRow[] = [
	{ does: 'Walk', actions: ['forward', 'left', 'back', 'right'], sep: ' ' },
	{ does: 'Jump', actions: ['jump'], sep: ' ' },
	{ does: 'Mine', fixed: 'Hold left click' },
	{ does: 'Build', fixed: 'Right click' },
	{ does: 'Swap a block', fixed: 'Shift + right click' },
	{ does: 'Choose a block', slots: true },
	{ does: 'Inventory', actions: ['inventory'], sep: ' ' },
	{ does: 'Change pickaxe', actions: ['cyclePickaxe'], sep: ' ' },
	{ does: 'Fly', actions: ['toggleFly'], sep: ' ' },
	{ does: 'Fly faster / slower', actions: ['flySpeedUp', 'flySpeedDown'], sep: ' / ' },
	{ does: 'Light TNT', actions: ['ignite'], sep: ' ' },
	{ does: 'Lamp color', actions: ['pickLightColor'], sep: ' ' },
	// Shift only stops the bounce pads here; "Sneak" would promise Minecraft's edge protection.
	{ does: 'Stop bouncing', fixed: 'Hold Shift' },
	{ does: 'Menu', fixed: 'Esc' },
];

export const SLOT_ACTIONS: Action[] = ['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6', 'slot7', 'slot8', 'slot9'];
```

- [ ] **Step 4: Implement the model** — `src/ui/controls-model.ts`

```ts
import type { Action } from '../data/keybindings.data';
import { CONTROL_ROWS, SLOT_ACTIONS } from '../data/controls.data';
import { buildKeyToAction } from '../game/input-gate';

const NAMED: Record<string, string> = {
	Space: 'Space', Equal: '=', Minus: '-', ShiftLeft: 'Shift', ShiftRight: 'Shift', Escape: 'Esc',
	Backquote: '`', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',',
	Period: '.', Slash: '/', Backslash: '\\', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
};

/** A key code as the Controls view shows it: 'KeyW' → 'W', 'Equal' → '=', 'Numpad3' → 'Num 3'. */
export function keyText(code: string): string {
	const named = NAMED[code];
	if (named) return named;
	const m = /^(Key|Digit|Numpad)(.+)$/.exec(code);
	if (!m) return code;
	return m[1] === 'Numpad' ? `Num ${m[2]}` : m[2];
}

export type ControlLine = { does: string; keys: string };

/**
 * The rows the Controls view shows for these bindings (spec §3.5). A key is shown only on the action
 * it really triggers (buildKeyToAction: a code bound twice goes to the later action), an unbound key
 * is left out, and a row with no key left is dropped.
 */
export function controlRows(bindings: Record<Action, string>): ControlLine[] {
	const winner = buildKeyToAction(bindings);
	const live = (a: Action): string => {
		const code = bindings[a];
		return code !== '' && winner[code] === a ? code : '';
	};
	const out: ControlLine[] = [];
	for (const r of CONTROL_ROWS) {
		if ('fixed' in r) {
			out.push({ does: r.does, keys: r.fixed });
		} else if ('slots' in r) {
			const codes = SLOT_ACTIONS.map(live);
			const digits = codes.every((c, i) => c === `Digit${i + 1}`);
			const shown = digits ? '1 – 9' : codes.filter((c) => c !== '').map(keyText).join(' ');
			out.push({ does: r.does, keys: shown === '' ? 'Tab' : `${shown}, Tab` });
		} else {
			const codes = r.actions.map(live).filter((c) => c !== '');
			if (codes.length > 0) out.push({ does: r.does, keys: codes.map(keyText).join(r.sep) });
		}
	}
	return out;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/ui/controls-model.test.ts` → PASS.

- [ ] **Step 6: Mutants (seen red, then revert):** (1) `live` returns `bindings[a]` without the `winner` check; (2) drop the row filter (`if (codes.length > 0)`) and the `''` filter together (dropping only `code !== ''` in `live` is an equivalent mutant: `buildKeyToAction` already skips `''`); (3) `controlRows` ignores `bindings` and uses `DEFAULT_KEYBINDINGS`; (4) `NAMED` loses `Equal`.

`keyText` deliberately differs from `keycapLabel` (craft-model.ts, the HUD's tiny pickaxe keycap): the Controls view has room for `Num 3` and `=`; the HUD keycap is left unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/data/controls.data.ts src/ui/controls-model.ts src/ui/controls-model.test.ts
git commit -m "feat(pause): the Controls view's rows, from the live key bindings"
```

---

### Task 3: Key gates learn `pauseOpen` (`input-gate.ts`)

**Files:**
- Modify: `src/game/input-gate.ts` (`GateState`, `shouldHandleKey`, `sneakKeyChange`)
- Test: `src/game/input-gate.test.ts`

**Interfaces:**
- Produces: `GateState = { frozen: boolean; inventoryOpen: boolean; pickerOpen: boolean; pauseOpen?: boolean }` (optional so existing callers and tests compile; main.ts always passes it after Task 5).

- [ ] **Step 1: Write the failing tests** — append inside the existing `describe('shouldHandleKey', …)` and add one for sneak:

```ts
	it('drops every keydown under the pause menu, keeps every keyup (pause menu spec §3.2)', () => {
		const s = { ...free, pauseOpen: true };
		for (const a of ['forward', 'jump', 'inventory', 'slot3', 'toggleFly', 'ignite', 'pickLightColor', 'cyclePickaxe'] as const) {
			expect(shouldHandleKey(true, a, s)).toBe(false);
			expect(shouldHandleKey(false, a, s)).toBe(true);
		}
	});
```

and, in the `sneakKeyChange` describe block (create `describe('sneakKeyChange under the pause menu', …)` if simpler):

```ts
	it('ignores a Shift press under the pause menu, still clears on release', () => {
		expect(sneakKeyChange('ShiftLeft', true, { ...free, pauseOpen: true })).toBe(null);
		expect(sneakKeyChange('ShiftLeft', false, { ...free, pauseOpen: true })).toBe(false);
	});
```

- [ ] **Step 2: Run** `npx vitest run src/game/input-gate.test.ts` → the two new tests FAIL.

- [ ] **Step 3: Implement** in `src/game/input-gate.ts`:

```ts
export type GateState = { frozen: boolean; inventoryOpen: boolean; pickerOpen: boolean; pauseOpen?: boolean };
```

In `shouldHandleKey`: `if (s.frozen || s.pauseOpen) return false;` (replacing `if (s.frozen) return false;`).
In `sneakKeyChange`: `if (s.frozen || s.inventoryOpen || s.pauseOpen) return null;`.
Update the doc comments ("keydown is dropped behind the freeze, the pause menu and the I screen").

- [ ] **Step 4: Run** `npx vitest run src/game/input-gate.test.ts` → PASS. Mutant: revert only `shouldHandleKey`'s line → the first new test FAILS; revert.

- [ ] **Step 5: Commit**

```bash
git add src/game/input-gate.ts src/game/input-gate.test.ts
git commit -m "feat(pause): key gates drop keydowns under the pause menu"
```

---

### Task 4: The pause card (`pause-menu.ts`, CSS)

**Files:**
- Create: `src/ui/pause-menu.ts`
- Modify: `src/ui/ui.css` (append a pause-menu section)

**Interfaces:**
- Consumes: `ControlLine` from `src/ui/controls-model.ts`.
- Produces: `class PauseMenu` with
  - `constructor(container: HTMLElement, rows: () => ControlLine[])`
  - `open(title: string): void` — shows the pause card (never the Controls view), focuses `#pause-resume`
  - `showCard()` also focuses `#pause-resume`; `showControls()` focuses `#pause-back`
  - `close(): void` — hides, resets to the card
  - `showCard(): void`, `showControls(): void`
  - `setQuitting(): void` — every button disabled, Quit reads `Saving…`
  - `get isOpen(): boolean`, `get controlsShown(): boolean`
  - `onResume: (() => void) | null`, `onQuit: (() => void) | null`
  - DOM ids: `pause-root`, `pause-title`, `pause-resume`, `pause-controls`, `pause-quit`, `pause-back`; rows are `.controls-row` with `.controls-does` and `.controls-keys`.

This task has no unit test (the repo tests no DOM classes; vitest runs in node). It is exercised by Task 6's smoke. Keep it free of game logic: no pointer lock, no timers.

- [ ] **Step 1: Implement** — `src/ui/pause-menu.ts`

```ts
import type { ControlLine } from './controls-model';

/**
 * The Esc menu over the running game (pause menu spec §3.3–§3.5): one .menu-card, like the main
 * menu, on a dimmed backdrop. DOM only — main.ts owns pausing, the pointer lock and quitting.
 * A click on the backdrop does nothing; Return to Game is the one way back.
 */
export class PauseMenu {
	private root: HTMLDivElement;
	private title = '';
	private view: 'card' | 'controls' = 'card';
	private quitting = false;
	onResume: (() => void) | null = null;
	onQuit: (() => void) | null = null;

	constructor(container: HTMLElement, private rows: () => ControlLine[]) {
		this.root = document.createElement('div');
		this.root.id = 'pause-root';
		this.root.classList.add('hidden');
		container.appendChild(this.root);
	}

	get isOpen(): boolean {
		return !this.root.classList.contains('hidden');
	}

	get controlsShown(): boolean {
		return this.isOpen && this.view === 'controls';
	}

	open(title: string): void {
		this.title = title;
		this.view = 'card';
		this.render();
		this.root.classList.remove('hidden');
		this.root.querySelector<HTMLButtonElement>('#pause-resume')?.focus();
	}

	close(): void {
		this.root.classList.add('hidden');
		this.view = 'card';
		this.root.innerHTML = '';
	}

	showCard(): void {
		this.view = 'card';
		this.render();
		// Back to Return to Game, so Space/Enter on the card always mean "back to the game".
		this.root.querySelector<HTMLButtonElement>('#pause-resume')?.focus();
	}

	showControls(): void {
		this.view = 'controls';
		this.render();
		this.root.querySelector<HTMLButtonElement>('#pause-back')?.focus();
	}

	setQuitting(): void {
		this.quitting = true;
		this.view = 'card';
		this.render();
	}

	private button(parent: HTMLElement, id: string, text: string, onClick: () => void, className?: string): void {
		const b = document.createElement('button');
		b.id = id;
		b.textContent = text;
		if (className) b.className = className;
		b.disabled = this.quitting;
		b.onclick = onClick;
		parent.appendChild(b);
	}

	private render(): void {
		this.root.innerHTML = '';
		const card = document.createElement('div');
		card.className = 'menu-card';
		const h = document.createElement('h1');
		h.id = 'pause-title';
		card.appendChild(h);
		if (this.view === 'controls') {
			h.textContent = 'Controls';
			for (const r of this.rows()) {
				const line = document.createElement('div');
				line.className = 'controls-row';
				const does = document.createElement('span');
				does.className = 'controls-does';
				does.textContent = r.does;
				const keys = document.createElement('span');
				keys.className = 'controls-keys';
				keys.textContent = r.keys;
				line.append(does, keys);
				card.appendChild(line);
			}
			this.button(card, 'pause-back', 'Back', () => this.showCard(), 'menu-back');
		} else {
			h.textContent = this.title;
			this.button(card, 'pause-resume', 'Return to Game', () => this.onResume?.(), 'home-button');
			this.button(card, 'pause-controls', 'Controls', () => this.showControls());
			this.button(card, 'pause-quit', this.quitting ? 'Saving…' : 'Quit to Menu', () => this.onQuit?.(), 'pause-quit');
		}
		this.root.appendChild(card);
	}
}
```

- [ ] **Step 2: CSS** — append to `src/ui/ui.css`:

```css
/* Pause menu (pause menu spec §3.3): the game stays visible, dimmed. Above the I screen (15), below
   the toasts and colour picker (20), the play timer (25/30) and the multiplayer screens (50). */
#pause-root {
	position: fixed;
	inset: 0;
	background: rgba(0, 0, 0, 0.55);
	color: #fff;
	display: flex;
	flex-direction: column;
	align-items: center;
	overflow-y: auto;
	pointer-events: auto;
	z-index: 18;
}
#pause-root.hidden {
	display: none;
}
/* Set apart from Return to Game and Controls against mis-clicks (margins collapse: 28 px is the gap). */
.menu-card button.pause-quit {
	margin-top: 28px;
}
.controls-row {
	display: flex;
	justify-content: space-between;
	gap: 24px;
	padding: 4px 0;
}
.controls-keys {
	font-weight: 600;
	text-align: right;
}
```

- [ ] **Step 3: Typecheck** — `npx tsc -p tsconfig.json --noEmit` → no errors.

- [ ] **Step 4: Commit**

```bash
git add src/ui/pause-menu.ts src/ui/ui.css
git commit -m "feat(pause): the pause card and Controls view"
```

---

### Task 5: Wire it into the game (`main.ts`, README)

**Files:**
- Modify: `src/main.ts` (inside `startGame` and `wireMultiplayer`), `README.md` ("How to play → Menu")

**Interfaces:**
- Consumes: Task 1 (`shouldOpenOnUnlock`, `escapeAction`, `PauseState`), Task 2 (`controlRows`), Task 3 (`GateState.pauseOpen`), Task 4 (`PauseMenu`).
- Produces: DEV oracle `window.__mc.pause = { isOpen(): boolean; controlsShown(): boolean; quitting(): boolean }`.

Read `startGame` in `src/main.ts` first (≈ lines 266–1075). Each edit below names its anchor.

- [ ] **Step 1: Imports** (top of `main.ts`, with the other `./game` / `./ui` imports):

```ts
import { escapeAction, shouldOpenOnUnlock, type PauseState } from './game/pause-model';
import { controlRows } from './ui/controls-model';
import { PauseMenu } from './ui/pause-menu';
```

- [ ] **Step 2: State and the third `paused` owner.** At the anchor `let frozen = false; let inventoryOpen = false; const updatePaused = …`, make it:

```ts
		// One `paused` with three owners. `loop` is declared below; these closures
		// run only after it exists (same pattern as the ignite handler).
		let frozen = false;
		let inventoryOpen = false;
		/** Pause menu spec §3.2: the Esc menu is up. */
		let pauseOpen = false;
		/** Spec §3.6: Quit was clicked; the reload is coming and nothing else may start. */
		let quitting = false;
		const updatePaused = () => {
			loop.paused = frozen || inventoryOpen || pauseOpen;
		};
```

- [ ] **Step 3: The pause menu object and open/close.** Right after `inventory.onClose = closeInventory;`, add:

```ts
		const canvas = renderer.gl.domElement;
		const pauseMenu = new PauseMenu(app, () => controlRows(opts.keybindings));
		const pauseState = (): PauseState => ({
			locked: document.pointerLockElement === canvas,
			pauseOpen,
			controlsShown: pauseMenu.controlsShown,
			quitting,
			inventoryOpen,
			pickerOpen: colorPicker.isOpen,
			frozen,
		});
		const openPause = () => {
			pauseOpen = true;
			updatePaused();
			loop.setLeftMouseDown(false); // multiplayer: mine-stop goes out on the next frame
			hud.setMiningProgress(0);
			pauseMenu.open(mp ? 'Game Menu' : 'Paused');
		};
		const closePause = () => {
			if (!pauseOpen) return;
			pauseMenu.close();
			pauseOpen = false;
			updatePaused();
			resetKeys();
		};
```

- [ ] **Step 4: Gates.**
  - `openInventory`: `if (inventoryOpen || frozen || colorPicker.isOpen || pauseOpen) return;`
  - `onKey`: `shouldHandleKey(down, a, { frozen, inventoryOpen, pickerOpen: colorPicker.isOpen, pauseOpen })`
  - `onSneak`: `sneakKeyChange(e.code, down, { frozen, inventoryOpen, pickerOpen: colorPicker.isOpen, pauseOpen })`
  - Tab listener: keep `if (frozen) return; e.preventDefault();` and add `if (pauseOpen) return;` right **after** `e.preventDefault()`. Under the pause menu Tab does nothing at all: it neither cycles the hotbar nor moves focus, so focus stays on Return to Game and the kid's Tab-Tab-Space habit can never reach Quit (gate 2). Focus cannot leave the card either.
  - `openInventory`'s `pauseOpen` gate is belt and braces: the I key is already dropped by `onKey` and `#pause-root` covers the HUD pickaxe, so no check can reach it. Say so in the code comment; it is not claimed as tested.
  - F3 listener: `if (frozen || inventoryOpen || colorPicker.isOpen || pauseOpen) return;`

- [ ] **Step 5: Freezes close the menu (unless quitting).**
  - In the play timer's `freeze: () => { closeInventory(); …`, right after `closeInventory();` add `if (!quitting) closePause();`
  - In `freezeForNetwork`, right after `closeInventory();` add `if (!quitting) closePause();`
  - In `wireMultiplayer`, the first callback of `link.wire(() => { if (loop.mpDisconnected) return; …`: change the guard to `if (loop.mpDisconnected || quitting) return;` (spec §3.6: a loss mid-quit starts no Reconnector, so nothing re-arms `mp:autojoin`). Leave the second argument (`freezeForNetwork`) alone.

- [ ] **Step 6: Esc, unlock, resume and quit listeners.** Immediately **before** `loop.start();` (so `loop`, `autosave`, `mpSync`, `leaving` all exist), add:

```ts
		// Pause menu (spec §3). Return to Game asks for the lock and leaves the menu up: the menu
		// closes only when the lock is really granted, so a refusal (Chromium's ~1.5 s cooldown after
		// the kid's own Esc, M2) leaves it open and he just clicks again. No pointerlockerror handler
		// is needed for that reason.
		pauseMenu.onResume = () => {
			const p = canvas.requestPointerLock() as unknown;
			if (p instanceof Promise) p.catch(() => {});
		};
		document.addEventListener('pointerlockchange', () => {
			if (document.pointerLockElement === canvas) {
				if (!quitting) closePause();
				return;
			}
			if (shouldOpenOnUnlock(pauseState())) openPause();
		});
		// Capture phase (spec §5.2): runs before the I screen's and the colour picker's own Esc
		// handlers, and still runs when the search box stops propagation — so the Esc that closes
		// one of them is judged on the state from before, and opens nothing.
		window.addEventListener(
			'keydown',
			(e) => {
				if (e.code !== 'Escape') return;
				const action = escapeAction(pauseState(), e.repeat);
				if (action === 'open') openPause();
				else if (action === 'back') pauseMenu.showCard();
			},
			true,
		);
		const QUIT_FLUSH_CAP_MS = 3000;
		pauseMenu.onQuit = () => {
			if (quitting) return;
			quitting = true;
			pauseMenu.setQuitting();
			if (mp) {
				// Spec §3.6, in order: never rejoin, tell the friend, push the last edits.
				clearAutojoin(sessionStorage);
				// `leaving` exists in every multiplayer session, timer or not; update(0) sends 0 even on a
				// countdown that never started, and marks every threshold fired so nothing follows.
				leaving?.update(0);
				mpSync?.flushFrame();
			}
			// A stalled cloud upload must not leave "Saving…" up forever: the local copy is already
			// written synchronously inside the flush, and pagehide writes it again on the reload.
			const cap = new Promise<void>((r) => setTimeout(r, QUIT_FLUSH_CAP_MS));
			void Promise.race([autosave.flush().catch(() => {}), cap]).then(() => {
				if (mp) mp.client.close(1000);
				location.reload();
			});
		};
```

Check while editing: `clearAutojoin` is already imported in `main.ts` (used by the timer freeze); `leaving` is the `LeavingCountdown | null` declared before the playtime block (non-null whenever `mp` is set). If `leaving` or `mpSync` is declared *after* the insertion point in the real file, move the insertion point down to just before `loop.start();` — it must stay after all of them.

- [ ] **Step 7: DEV oracle.** In the `__mc = { … }` object literal add:

```ts
				pause: { isOpen: () => pauseOpen, controlsShown: () => pauseMenu.controlsShown, quitting: () => quitting },
```

- [ ] **Step 8: README.** Replace the line `- **Esc** — exit pointer-lock (you leave the game to the browser but the world keeps running).` with:

```md
- **Esc** — open the game menu: **Return to Game**, **Controls** (every key, read-only) and **Quit to Menu** (saves, then back to the main menu). Solo play stops while it is open; in multiplayer your friend's world keeps going. The play timer keeps counting. With the I screen or the color picker open, Esc closes that instead.
```

- [ ] **Step 9: Verify** — `npm run typecheck && npm run lint && npm test` → all green (paste the tail of each).

- [ ] **Step 10: Commit**

```bash
git add src/main.ts README.md
git commit -m "feat(pause): Esc opens the game menu in solo and multiplayer"
```

---

### Task 6: Browser smoke (`scripts/pause-smoke.ts`)

**Files:**
- Create: `scripts/pause-smoke.ts`
- Modify: `package.json` (`"smoke:pause": "tsx scripts/pause-smoke.ts"`)

**Interfaces:**
- Consumes: the DOM ids of Task 4; `window.__mc` (`loop.paused`, `keys`, `player`, `world`, `playtime`, `pause`) of Task 5; the menu ids `#home-single`, `#duration-minus`, `#duration-value`, New World / Create / Play and Continue as `scripts/menu-smoke.ts` uses them (read menu-smoke.ts §5–§6 for the exact selectors to create and enter a world, and `src/ui/menu.ts` if one is missing).

Copy the harness from `scripts/menu-smoke.ts` (arg parsing, `startDev` with `--strictPort` and stop-by-port, `check`, the exit codes, the route guard that aborts on any non-localhost host). Differences:

- Default `--port 5391`. `VITE_MINICRAFT_API_URL` = `DEAD_API` (`http://127.0.0.1:9099`), no MP URL.
- The route for `DEAD_API` is **configurable** per phase: `apiMode: 'abort' | 'delay' | 'hang'`, and it records every request (`method`, `path`, time) in `apiLog`. `OPTIONS` → 204 with CORS headers `{ 'Access-Control-Allow-Origin': 'http://localhost:<port>', 'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, If-None-Match' }` (read `src/persistence/cloud.ts` for the headers the PUT really sends and allow them all; `If-None-Match` is sent on a first save). Every fulfilled response (not only OPTIONS) carries the `Access-Control-Allow-Origin` header. `'abort'` → `route.abort()`. `'delay'` → a PUT is answered after 1500 ms with `200` (any body: the oracle is the PUT's *arrival* and the timing, not a successful save — do not claim one); GETs → 404. `'hang'` → never answered. **`'hang'` only after the world is entered**: with it on at page load the world list GET hangs and Single Player never shows `#single-new`.
- Headless Chromium (`chromium.launch()` with no `headless: false`). The worktree must have run `npm run build-atlas` first; the script checks `public/atlas.json` exists and exits 1 with that instruction if not.
- Helpers: `lock()` = **no-op if `document.pointerLockElement` is already set** (a click while locked would mine), else click the canvas (`#app canvas` or the renderer's canvas selector) and wait for `document.pointerLockElement !== null`; `unlock()` = `page.evaluate(() => document.exitPointerLock())` and wait for `__mc.pause.isOpen()` (or a short timeout when the check expects it closed). `M = () => page.evaluate(() => (window as any).__mc)`-style accessors for values.

Checks, in this order (one world, started from Single Player with the duration stepped once from No limit to `2 h` so `__mc.playtime` exists):

| # | Steps | Assert |
|---|---|---|
| S1 | `lock()`, `unlock()` | `#pause-root` visible; `#pause-title` = `Paused`; `__mc.loop.paused === true` |
| S2 | record the selected slot (assert it is not index 4) and flying; press `Tab`, `Digit5`, `KeyF`, `KeyI`, `F3` | selected slot, `player.flying` (read the real field name in `player.ts`), `#inventory-root` hidden, `#perf-overlay` visibility all unchanged; `document.activeElement.id === 'pause-resume'` after the Tab (Tab does nothing under the menu); menu still open |
| S3 | fresh cycle: `lock()`, `keyboard.down('KeyW')`, `unlock()`, click `#pause-resume` (S7 path), and only after the assert `keyboard.up('KeyW')` | `__mc.keys.forward === false` right after the menu closed |
| S4 | menu open, press `Escape` | menu still open, card view (`#pause-resume` present) |
| S5 | click `#pause-controls` | rows present; the `Jump` row's keys = `Space`; `Fly faster / slower` = `= / -`; press `Escape` → `#pause-resume` present (card) |
| S5b | open Controls; from the Controls view grant the lock with `page.evaluate(() => canvas.requestPointerLock())` (headless is permissive, M4) → the menu closes; then `unlock()` | the menu reopens on the card: `#pause-resume` present, `__mc.pause.controlsShown() === false` |
| S6 | `page.evaluate` to stub `HTMLCanvasElement.prototype.requestPointerLock = () => Promise.reject(new DOMException('x','SecurityError'))`, click `#pause-resume`, wait 300 ms, restore the original | menu still open |
| S7 | click `#pause-resume` (real, permissive headless lock) | menu hidden within 2 s; `loop.paused === false` |
| S8 | locked: press `KeyI` (I screen opens, pointer released), click the **Craft** tab (read `src/ui/inventory.ts` for its selector) so the search box has no focus, press `Escape` | `#inventory-root` hidden **and** `__mc.pause.isOpen() === false` |
| S9 | `lock()`, press `KeyC` (picker opens), press `Escape` | picker hidden **and** pause not open |
| S10 | now unlocked with nothing open: press `Escape` | pause open (rule b); then Return (S7 path) |
| S11 | `unlock()` (menu open), `page.evaluate(() => __mc.playtime.setRemaining(1))`, wait for `#playtime-freeze:not(.hidden)` | TIME'S UP visible; `#pause-root` hidden |
| S12 | go to the menu with `page.goto(BASE)` (the freeze ended the session), start a **new** world with a duration, set `apiMode = 'delay'`, `lock()`, place a block (right-click on the ground in front — read `scripts/cheat-smoke.ts` for how it places for real and reads the cell back with `__mc.world.getBlock`), then **within 2 s** (well under AutoSave's 5 s debounce) `unlock()` and click `#pause-quit`, noting `tClick` | within 200 ms `#pause-quit` text = `Saving…` and it is disabled; a `PUT` in `apiLog` with time **after `tClick`** and before navigation; navigation **≥ 1400 ms** after `tClick` (the flush was awaited: measured 1925 ms correct vs 350 ms for a no-flush Quit); the main menu shows after navigation; Continue → `__mc.world.getBlock(x,y,z)` equals the placed block (a sanity check only: `pagehide` writes the local copy even without a flush, so this line alone cannot catch a no-flush Quit) |
| S13 | Continue (with `apiMode = 'delay'` so the menu loads), then set `apiMode = 'hang'` **before** placing; `lock()`, place another block, within 2 s `unlock()` and click `#pause-quit`, noting `tClick` | a `PUT` in `apiLog` after `tClick`; navigation **≥ 2800 ms and ≤ 4500 ms** after `tClick` (measured 3.4 s) |

Rules for this task:

- [ ] **Step 1:** Write the script with every check above. Where a row says "read X for the selector", read it — do not guess ids. Remove the question-marked scratch phrasing from your code: the order is S1, S2, S4, S5, S5b, S6, S7, S3, S8, S9, S10, S11, S12, S13 (S5b leaves the menu open on the card; S6 then S7 close it).
- [ ] **Step 2:** `npm run build-atlas` (once), then `npm run smoke:pause` → every check `ok`, exit 0. Paste the output.
- [ ] **Step 3: Mutants — each must turn its check red.** Apply one at a time to `src/main.ts` (or the named file), run the smoke, confirm the named check prints `FAIL`, then `git checkout` that file:

| Mutant | Must fail |
|---|---|
| delete the `pointerlockchange` listener's `openPause()` call | S1 |
| drop `pauseOpen` from `onKey`'s gate state | S2 |
| drop the `if (pauseOpen) return;` from the Tab listener | S2 (slot changes) |
| move the Tab listener's `if (pauseOpen) return;` before `e.preventDefault()` | S2 (focus leaves `#pause-resume`) |
| drop `pauseOpen` from the F3 listener | S2 |
| `closePause` without `resetKeys()` | S3 |
| in the capture Esc listener add `else if (pauseOpen) closePause();` (Esc on the card closes the menu) | S4 |
| `PauseMenu.close()` and `open()` both without `this.view = 'card'` | S5b |
| the capture Esc listener ignores `'back'` | S5 |
| `onResume` calls `closePause()` right after `requestPointerLock()` | S6 |
| `pointerlockchange` locked branch does nothing | S7 |
| register the Esc listener without the `true` (bubble phase) | S8 and/or S9 |
| drop the rule-(b) `openPause()` (capture listener ignores `'open'`) | S10 |
| remove `if (!quitting) closePause();` from the timer freeze | S11 |
| `onQuit` = `location.reload()` only | S12 |
| drop the `cap` from the race | S13 |
| `onQuit` sets "Saving…", waits 3 s, reloads, never calls `autosave.flush()` | S12 (no PUT after the click) |

Record the table with "seen red: yes" per row in the task report. A mutant that does **not** turn its check red is a defect in the check: fix the check, not the mutant.

- [ ] **Step 4: Commit**

```bash
git add scripts/pause-smoke.ts package.json
git commit -m "test(pause): headless smoke of the pause menu, every check with its mutant"
```

---

### Task 7: Multiplayer scenario (`scripts/mp-e2e.ts`)

**Files:**
- Modify: `scripts/mp-e2e.ts`

**Interfaces:**
- Consumes: `__mc.pause`, `#pause-root`, `#pause-title`, `#pause-quit` (Task 4/5); the existing `scenario(id, title, body)`, the two clients `A`, `B`, the `needMp` list and the E13 scenario as the model for placing a block and reading the other client's world (read E13 end to end first).

- [ ] **Step 1:** Add scenario `E14` ("the pause menu: the shared world keeps going, and Quit says went home") **immediately after the E13 block**, and add `'E14'` to the `needMp` list (that is what makes A and B join). Placement matters: after E14, A's page is on the main menu, and E3 / E6 later in the file only check `A && B`. So E14 **ends by rejoining A**: copy the rejoin block that sits before E13 (≈ mp-e2e.ts:1094: `A = null`, a new page, `joinWorld(A, BASE, WORLD, '10 min')`, sleep 1500 — use its real code). Steps:
  1. A: lock the canvas, then `document.exitPointerLock()` → `#pause-root` visible, `#pause-title` = `Game Menu`.
  2. B places a block (as E13 does). Poll A's `__mc.world.getBlock(x,y,z)` until it equals the block (≤ 5 s) **while A's menu is still open** — assert both.
  3. A clicks `#pause-quit`. B: wait (≤ 5 s) for a toast whose text contains `went home` (read how other scenarios read toasts; the toast text comes from `leavingText`). A: wait for navigation, then assert the main menu is showing and `sessionStorage.getItem('mp:autojoin')` is null (use the real `AUTOJOIN_KEY` value from `src/game/boot.ts`).
- [ ] **Step 2:** Run `MP_E2E_SCRATCH=<a dir under the session scratchpad> PATH=$HOME/.local/go/bin:$PATH npm run e2e:mp -- --only E14` (it starts its own local `mcserver` on a temp database; never the live one) → E14 passes. Then `--only E13,E14,E3,E6` (check the header for the list syntax) to show the rejoin leaves the later scenarios working.
- [ ] **Step 3: Mutants:** (a) `openPause` sets `loop.mpDisconnected = true` → step 2 FAILS; (b) remove the `leaving.update(0)` / `send` lines from `onQuit` → step 3's toast FAILS. Revert each. State in the report: the `mp:autojoin` assertion only catches a Quit that calls `rejoinReload` (the flag is one-shot and consumed at boot), per spec §6.3.
- [ ] **Step 4: Commit**

```bash
git add scripts/mp-e2e.ts
git commit -m "test(pause): E14 multiplayer pause keeps the world going, Quit says went home"
```

---

### Task 8: Whole-branch verification

- [ ] **Step 1:** `npm run typecheck && npm run lint && npm test && npm run smoke:pause && npm run smoke:menu && npm run smoke:cheats` (the last two show nothing else broke; `smoke:menu` exercises the main menu the Quit lands on). Paste the tails.
- [ ] **Step 2:** `MP_E2E_SCRATCH=<scratch dir> PATH=$HOME/.local/go/bin:$PATH npm run e2e:mp` full run (all scenarios) → green; paste the summary.
- [ ] **Step 3:** `npm run build` → succeeds.
- [ ] **Step 4:** Write the manual checklist for Julien into the final report, verbatim from spec §6.4.
