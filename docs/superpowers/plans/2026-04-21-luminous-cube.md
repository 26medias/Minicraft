# Luminous Cube Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `lamp` block that emits a coloured point light, with a 20-tile pastel palette picker bound to `C` that both recolors the aimed-at lamp and sets the default color for new placements, and persists both the world's lamps-with-colors and the kid's current-color preference.

**Architecture:** One new cube block in the catalog. A `LightRegistry` class manages `THREE.PointLight` instances attached to the scene, keyed by coord. A `ColorPicker` HTML overlay picks from a static 20-color palette. Block placement adds a light (in `main.ts`), mining or TNT destruction removes it (in `GameLoop`). Lamps-with-colors persist via an additive `lights` field on `WorldSave`; current color persists via a new `currentLightColor` field on `Options`.

**Tech Stack:** TypeScript, Three.js, Vitest. Existing `PersistenceAdapter` / `AutoSave` / `LocalStorageAdapter` unchanged in shape; extended additively.

Source spec: `docs/superpowers/specs/2026-04-21-luminous-cube-design.md`.

---

## Task 1: Add the `lamp` block and rebuild the atlas

**Files:**
- Modify: `src/data/blocks.data.ts`

**Context:**
- Next free id is 16 (TNT is 15). The existing glowstone texture at `src/assets/blocks/glowstone.png` is a uniform cube texture — use `kind: 'uniform'`.
- `hardness: 0.3s` makes it slightly easier to mine than wool (0.5s), easy enough for the kid to undo a misplacement.
- Atlas build auto-picks up new texture names from `BLOCKS`.

- [ ] **Step 1: Add the lamp row**

Open `src/data/blocks.data.ts`. Append after the TNT row (id 15), before the closing `];`:

```typescript
	{ id: 16, name: 'lamp', label: 'Lamp', solid: true, transparent: false, kidMode: true, hardness: 0.3,
		textures: { kind: 'uniform', all: 'glowstone' } },
```

Use hard tabs matching the surrounding rows.

- [ ] **Step 2: Rebuild the atlas**

Run: `npm run build-atlas`

Expected: `Wrote 20 tiles to public/atlas.png (512x512)` (was 19; +1 for `glowstone`).

- [ ] **Step 3: Full suite + typecheck**

Run: `npm test && npx tsc -b`

Expected: all pass, tsc clean.

- [ ] **Step 4: Commit**

```bash
git add src/data/blocks.data.ts
git commit -m "$(cat <<'EOF'
feat(data): add lamp block to the catalog

New block id 16 using the glowstone texture. Uniform cube (no
per-face variation) — the light-emission behaviour lives in the
LightRegistry wired from GameLoop, not in the catalog.
EOF
)"
```

---

## Task 2: Add `pickLightColor` keybinding and `Options.currentLightColor`

**Files:**
- Modify: `src/data/keybindings.data.ts`

**Context:**
- Pattern matches the fly-mode and ignite keybindings: append to `Action` union, `ACTIONS`, `ACTION_LABEL`, `DEFAULT_KEYBINDINGS`. Default `KeyC`.
- Additionally extend the `Options` type with `currentLightColor: string`. The persistence layer picks up this field in Task 6.

- [ ] **Step 1: Extend the keybinding data**

In `src/data/keybindings.data.ts`:

Append `'pickLightColor'` to the `Action` union (at the end):

```typescript
	| 'ignite'
	| 'pickLightColor';
```

Append to `ACTIONS`:

```typescript
	'ignite',
	'pickLightColor',
];
```

Append to `ACTION_LABEL`:

```typescript
	ignite: 'Ignite TNT',
	pickLightColor: 'Pick Light Color',
};
```

Append to `DEFAULT_KEYBINDINGS`:

```typescript
	ignite: 'KeyE',
	pickLightColor: 'KeyC',
};
```

- [ ] **Step 2: Extend the `Options` type**

In the same file, find the existing `Options` type (near the bottom):

```typescript
export type Options = {
	kidMode: boolean;
	keybindings: Record<Action, string>;
};
```

Replace with:

```typescript
export type Options = {
	kidMode: boolean;
	keybindings: Record<Action, string>;
	currentLightColor: string;
};
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b`

Expected: **one error** in `src/persistence/options.ts` because `loadOptions` no longer satisfies the `Options` type (missing `currentLightColor`). Leave it — Task 6 fixes it.

- [ ] **Step 4: Run tests**

Run: `npm test`

Expected: all existing tests pass (vitest is not strict about this typecheck gap).

- [ ] **Step 5: Commit**

```bash
git add src/data/keybindings.data.ts
git commit -m "$(cat <<'EOF'
feat(input): pickLightColor keybinding + Options.currentLightColor

Adds the C-key binding (rebindable, edge-triggered) used to open
the color picker in-game, and the Options field that stores the
kid's chosen color for subsequent lamp placements. Persistence and
UI wiring land in follow-up commits.
EOF
)"
```

---

## Task 3: Palette data file

**Files:**
- Create: `src/data/light-palette.data.ts`

**Context:**
- Pure data. Exports the 20-color palette as a flat `readonly string[]`, conceptually a 5×4 grid (5 tiles per row, 4 rows).
- Hex strings are uppercase and include the leading `#`.
- Default current color (`#FFF5E0`) is NOT exported from here — it's a separate constant in `options.ts` (next task).

- [ ] **Step 1: Create the palette file**

Create `src/data/light-palette.data.ts`:

```typescript
/**
 * 20 pastel colors for the in-game light picker, arranged as a 5-wide grid.
 * Kid-friendly — no pure primaries. Order is stable; UI renders in index order.
 */
export const LIGHT_PALETTE: readonly string[] = [
	// Row 1 — warm whites / yellows
	'#FFFFFF', '#FFF5E0', '#FFE8A8', '#FFD985', '#FFC870',
	// Row 2 — peach / coral
	'#FFB594', '#FFA585', '#FF9580', '#FF8A99', '#FF99B5',
	// Row 3 — pinks / purples
	'#FFB0D0', '#FCB8E0', '#E8B5F0', '#CFA8F0', '#B0A5F0',
	// Row 4 — blues / greens
	'#A5B8F0', '#9FD0F0', '#A8E5E0', '#A5E5C0', '#B5E59B',
];

export const LIGHT_PALETTE_COLUMNS = 5;
```

Hard tabs. `LIGHT_PALETTE_COLUMNS` is exported so the picker UI can derive the CSS grid-template-columns without hardcoding.

- [ ] **Step 2: Typecheck + tests**

Run: `npx tsc -b` (expect the same one error in options.ts from Task 2; no new ones).
Run: `npm test` — all pass.

- [ ] **Step 3: Commit**

```bash
git add src/data/light-palette.data.ts
git commit -m "$(cat <<'EOF'
feat(data): 20-color pastel palette for the light picker

Five tiles per row, four rows. Hand-curated soft tones — no pure
primaries. LIGHT_PALETTE_COLUMNS exports the row width so the
picker UI doesn't hardcode layout.
EOF
)"
```

---

## Task 4: `LightRegistry` class with tests

**Files:**
- Create: `src/engine/render/light-registry.ts`
- Create: `src/engine/render/light-registry.test.ts`

**Context:**
- `LightRegistry` owns a `Map<string, THREE.PointLight>` keyed by `"x,y,z"`. Each add creates a light at `(x+0.5, y+0.5, z+0.5)` so it sits at block-center.
- Point-light parameters: `intensity = 1.5`, `distance = 12`, `decay = 1.5`. Parsed from a hex string via `new THREE.Color(hex)`.
- `add` is idempotent — calling `add` on an existing coord is a no-op.
- `setColor` mutates the color of an existing light in place. No-op if the coord isn't registered.
- `entries()` returns an iterable of `{x, y, z, color: string}` objects for save serialization.
- Test pattern: construct with a `new THREE.Scene()`, call methods, assert on state. Scene child count is an easy observable for add/remove. Color is round-tripped via hex string.

- [ ] **Step 1: Write failing tests**

Create `src/engine/render/light-registry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { LightRegistry } from './light-registry';

describe('LightRegistry', () => {
	it('add creates a PointLight attached to the scene', () => {
		const scene = new THREE.Scene();
		const r = new LightRegistry(scene);
		r.add(10, 20, 30, '#FFFFFF');
		const lights = scene.children.filter((c) => c instanceof THREE.PointLight);
		expect(lights.length).toBe(1);
		const l = lights[0] as THREE.PointLight;
		expect(l.position.x).toBeCloseTo(10.5);
		expect(l.position.y).toBeCloseTo(20.5);
		expect(l.position.z).toBeCloseTo(30.5);
	});

	it('remove detaches the light from the scene', () => {
		const scene = new THREE.Scene();
		const r = new LightRegistry(scene);
		r.add(10, 20, 30, '#FFFFFF');
		r.remove(10, 20, 30);
		expect(scene.children.filter((c) => c instanceof THREE.PointLight).length).toBe(0);
	});

	it('add on an already-added coord is idempotent', () => {
		const scene = new THREE.Scene();
		const r = new LightRegistry(scene);
		r.add(10, 20, 30, '#FFFFFF');
		r.add(10, 20, 30, '#FF0000');
		expect(scene.children.filter((c) => c instanceof THREE.PointLight).length).toBe(1);
	});

	it('setColor updates the existing light in place', () => {
		const scene = new THREE.Scene();
		const r = new LightRegistry(scene);
		r.add(10, 20, 30, '#FFFFFF');
		r.setColor(10, 20, 30, '#FF0000');
		const l = scene.children.find((c) => c instanceof THREE.PointLight) as THREE.PointLight;
		expect(l.color.getHexString().toLowerCase()).toBe('ff0000');
	});

	it('setColor on an unregistered coord is a no-op (does not throw)', () => {
		const scene = new THREE.Scene();
		const r = new LightRegistry(scene);
		expect(() => r.setColor(99, 99, 99, '#FF0000')).not.toThrow();
	});

	it('getColor returns the stored color for a registered coord', () => {
		const scene = new THREE.Scene();
		const r = new LightRegistry(scene);
		r.add(10, 20, 30, '#AABBCC');
		expect(r.getColor(10, 20, 30)?.toLowerCase()).toBe('#aabbcc');
	});

	it('getColor returns null for an unregistered coord', () => {
		const scene = new THREE.Scene();
		const r = new LightRegistry(scene);
		expect(r.getColor(99, 99, 99)).toBeNull();
	});

	it('entries yields each registered light as {x,y,z,color}', () => {
		const scene = new THREE.Scene();
		const r = new LightRegistry(scene);
		r.add(1, 2, 3, '#FF0000');
		r.add(4, 5, 6, '#00FF00');
		const got = [...r.entries()].sort((a, b) => a.x - b.x);
		expect(got).toEqual([
			{ x: 1, y: 2, z: 3, color: '#FF0000' },
			{ x: 4, y: 5, z: 6, color: '#00FF00' },
		]);
	});
});
```

- [ ] **Step 2: Run tests — expect red**

Run: `npx vitest run src/engine/render/light-registry.test.ts`

Expected: file fails to import `./light-registry`.

- [ ] **Step 3: Implement `LightRegistry`**

Create `src/engine/render/light-registry.ts`:

```typescript
import * as THREE from 'three';

const INTENSITY = 1.5;
const DISTANCE = 12;
const DECAY = 1.5;

function key(x: number, y: number, z: number): string {
	return `${x},${y},${z}`;
}

type Entry = { light: THREE.PointLight; color: string };

export class LightRegistry {
	private entries_ = new Map<string, Entry>();

	constructor(private scene: THREE.Scene) {}

	add(x: number, y: number, z: number, colorHex: string): void {
		const k = key(x, y, z);
		if (this.entries_.has(k)) return;
		const light = new THREE.PointLight(new THREE.Color(colorHex), INTENSITY, DISTANCE, DECAY);
		light.position.set(x + 0.5, y + 0.5, z + 0.5);
		this.scene.add(light);
		this.entries_.set(k, { light, color: colorHex });
	}

	remove(x: number, y: number, z: number): void {
		const k = key(x, y, z);
		const entry = this.entries_.get(k);
		if (!entry) return;
		this.scene.remove(entry.light);
		this.entries_.delete(k);
	}

	setColor(x: number, y: number, z: number, colorHex: string): void {
		const entry = this.entries_.get(key(x, y, z));
		if (!entry) return;
		entry.light.color.set(colorHex);
		entry.color = colorHex;
	}

	getColor(x: number, y: number, z: number): string | null {
		return this.entries_.get(key(x, y, z))?.color ?? null;
	}

	*entries(): Iterable<{ x: number; y: number; z: number; color: string }> {
		for (const [k, entry] of this.entries_) {
			const [xs, ys, zs] = k.split(',');
			yield { x: Number(xs), y: Number(ys), z: Number(zs), color: entry.color };
		}
	}
}
```

Hard tabs.

- [ ] **Step 4: Run tests — expect green**

Run: `npx vitest run src/engine/render/light-registry.test.ts`

Expected: 8/8 pass.

- [ ] **Step 5: Full suite + typecheck**

Run: `npm test && npx tsc -b`

Expected: 83/83 pass. Task 2's `options.ts` typecheck error still present — that's fine, Task 6 closes it.

- [ ] **Step 6: Commit**

```bash
git add src/engine/render/light-registry.ts src/engine/render/light-registry.test.ts
git commit -m "$(cat <<'EOF'
feat(render): LightRegistry for per-block colored point lights

Scene-attached PointLight per lamp keyed by coord, with idempotent
add, in-place setColor, and entries() for save serialization.
Parameters (intensity 1.5, distance 12, decay 1.5) hand-tuned for a
gameplay-friendly falloff that lights a small room without washing
out the whole cave.
EOF
)"
```

---

## Task 5: `ColorPicker` UI class + CSS

**Files:**
- Create: `src/ui/color-picker.ts`
- Modify: `src/ui/ui.css`

**Context:**
- Modal HTML overlay. Shown/hidden imperatively via `show()` / `hide()`. Fires `onPick(color: string)` when the kid clicks a tile.
- Takes the palette as a constructor arg (so tests / future variants can swap it).
- Renders a fixed-position container with a dimmed backdrop and a centered card. Card holds a CSS-grid of color tiles.
- Release pointer lock on `show()`, which makes the mouse available to click tiles. Pointer lock is re-acquired when the kid clicks the canvas (existing behavior in `pointerLock.ts`).
- Keyboard: `Escape` closes without firing `onPick`.
- Not unit-tested (visual/DOM, per `Hud` / `OptionsMenu` precedent).

- [ ] **Step 1: Create the picker class**

Create `src/ui/color-picker.ts`:

```typescript
import { LIGHT_PALETTE_COLUMNS } from '../data/light-palette.data';

export class ColorPicker {
	private root: HTMLDivElement;
	private card: HTMLDivElement;
	onPick: (color: string) => void = () => {};

	constructor(container: HTMLElement, palette: readonly string[]) {
		this.root = document.createElement('div');
		this.root.id = 'color-picker-root';
		this.root.classList.add('hidden');

		this.card = document.createElement('div');
		this.card.className = 'color-picker-card';
		this.card.style.gridTemplateColumns = `repeat(${LIGHT_PALETTE_COLUMNS}, 48px)`;

		for (const color of palette) {
			const tile = document.createElement('button');
			tile.className = 'color-picker-tile';
			tile.style.background = color;
			tile.title = color;
			tile.addEventListener('click', (e) => {
				e.stopPropagation();
				this.onPick(color);
				this.hide();
			});
			this.card.appendChild(tile);
		}

		this.root.appendChild(this.card);
		// Clicking the backdrop cancels.
		this.root.addEventListener('click', () => this.hide());

		window.addEventListener('keydown', (e) => {
			if (!this.isOpen) return;
			if (e.code === 'Escape') {
				e.preventDefault();
				this.hide();
			}
		});

		container.appendChild(this.root);
	}

	get isOpen(): boolean {
		return !this.root.classList.contains('hidden');
	}

	show(): void {
		this.root.classList.remove('hidden');
		if (document.pointerLockElement) document.exitPointerLock();
	}

	hide(): void {
		this.root.classList.add('hidden');
	}
}
```

Hard tabs.

- [ ] **Step 2: Add CSS**

Open `src/ui/ui.css`. Append at the end:

```css
#color-picker-root {
	position: fixed;
	inset: 0;
	background: rgba(0, 0, 0, 0.5);
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 20;
}
#color-picker-root.hidden {
	display: none;
}
.color-picker-card {
	background: #2a2a2a;
	padding: 16px;
	border-radius: 8px;
	box-shadow: 0 4px 24px rgba(0, 0, 0, 0.6);
	display: grid;
	gap: 6px;
}
.color-picker-tile {
	width: 48px;
	height: 48px;
	border: 2px solid rgba(255, 255, 255, 0.3);
	border-radius: 4px;
	cursor: pointer;
	padding: 0;
}
.color-picker-tile:hover {
	border-color: #fff;
}
```

- [ ] **Step 3: Typecheck + tests**

Run: `npx tsc -b` (expect the one pre-existing `options.ts` error).
Run: `npm test` — all pass.

- [ ] **Step 4: Commit**

```bash
git add src/ui/color-picker.ts src/ui/ui.css
git commit -m "$(cat <<'EOF'
feat(ui): ColorPicker modal for choosing light colors

HTML overlay with a CSS-grid of palette tiles. show() releases
pointer lock so the mouse can click tiles; clicking a tile fires
onPick(color) and auto-closes. Backdrop-click and Escape cancel
without firing.
EOF
)"
```

---

## Task 6: Persistence (Options + WorldSave + AutoSave)

**Files:**
- Modify: `src/persistence/options.ts`
- Modify: `src/persistence/adapter.ts`
- Modify: `src/persistence/localStorage.ts`
- Modify: `src/persistence/autosave.ts`

**Context:**
- Closes the Task-2 `options.ts` typecheck error by filling in the `currentLightColor` field.
- Extends `WorldSave` with `lights?: LightSave[]`. Loader forwards any loaded `lights` field; saver adds it to the meta payload explicitly.
- `AutoSave` gets a new optional `getLights` supplier argument; when provided, its output feeds `save.lights`.

- [ ] **Step 1: Update `options.ts`**

Open `src/persistence/options.ts`. Replace the file contents with:

```typescript
import { DEFAULT_KEYBINDINGS, type Options } from '../data/keybindings.data';

const KEY = 'minicraft:v1:options';
const DEFAULT_LIGHT_COLOR = '#FFF5E0'; // warm white

function defaults(): Options {
	return {
		kidMode: true,
		keybindings: { ...DEFAULT_KEYBINDINGS },
		currentLightColor: DEFAULT_LIGHT_COLOR,
	};
}

export function loadOptions(): Options {
	const raw = localStorage.getItem(KEY);
	if (!raw) return defaults();
	try {
		const parsed = JSON.parse(raw) as Partial<Options>;
		return {
			kidMode: parsed.kidMode ?? true,
			keybindings: { ...DEFAULT_KEYBINDINGS, ...(parsed.keybindings ?? {}) },
			currentLightColor: parsed.currentLightColor ?? DEFAULT_LIGHT_COLOR,
		};
	} catch {
		return defaults();
	}
}

export function saveOptions(opts: Options) {
	localStorage.setItem(KEY, JSON.stringify(opts));
}
```

Hard tabs.

- [ ] **Step 2: Extend `WorldSave`**

Open `src/persistence/adapter.ts`. Append a new exported type and extend `WorldSave`:

After the existing `RawChunk` type, add:

```typescript
export type LightSave = { x: number; y: number; z: number; color: string };
```

Extend `WorldSave`:

```typescript
export type WorldSave = {
	version: 1;
	seed: number;
	name: string;
	createdAt: number;
	updatedAt: number;
	player: PlayerSave;
	chunks: RawChunk[];
	lights?: LightSave[];
};
```

- [ ] **Step 3: Update `localStorage.ts` save path**

Open `src/persistence/localStorage.ts`. In `saveWorld`, find the `metaPayload` object (around line 33). Add `lights: save.lights` as the last field so it reads:

```typescript
		const metaPayload = {
			version: save.version,
			seed: save.seed,
			name: save.name,
			createdAt: save.createdAt,
			updatedAt: save.updatedAt,
			player: save.player,
			lights: save.lights,
		};
```

The load path already roundtrips every non-chunk field via `return { ...meta, chunks };` so no load-side change is needed — a save without `lights` loads with `lights: undefined`.

- [ ] **Step 4: Update `autosave.ts`**

Open `src/persistence/autosave.ts`. Add a `LightSave` import at the top:

```typescript
import type { LightSave, PersistenceAdapter, PlayerSave, WorldSave } from './adapter';
```

Extend the constructor signature:

```typescript
	constructor(
		private adapter: PersistenceAdapter,
		private world: World,
		private getPlayer: () => PlayerSave,
		meta: { name: string; createdAt: number },
		public onQuotaExceeded: () => void = () => {},
		private getLights: () => LightSave[] = () => [],
	) {
		// ... unchanged body
	}
```

Extend the `save` object built in `flush()`:

```typescript
		const save: WorldSave = {
			version: 1,
			seed: this.world.seed,
			name: this.name,
			createdAt: this.createdAt,
			updatedAt: Date.now(),
			player: this.getPlayer(),
			chunks: this.world
				.modifiedChunks()
				.map((c) => ({ cx: c.cx, cz: c.cz, blocks: c.blocks })),
			lights: this.getLights(),
		};
```

- [ ] **Step 5: Typecheck + tests**

Run: `npx tsc -b` — **now clean** (the Task-2 error is closed).
Run: `npm test` — all pass (the existing `localStorage.test.ts` ignores new optional fields; verify 83/83).

- [ ] **Step 6: Commit**

```bash
git add src/persistence/options.ts src/persistence/adapter.ts src/persistence/localStorage.ts src/persistence/autosave.ts
git commit -m "$(cat <<'EOF'
feat(persistence): persist light placements + current color

Options gains currentLightColor (default warm white #FFF5E0).
WorldSave gains optional lights[] — old saves load with lights
undefined. AutoSave takes an optional getLights supplier and
forwards its output into the save blob.
EOF
)"
```

---

## Task 7: `GameLoop` light-removal on block destruction

**Files:**
- Modify: `src/game/loop.ts`

**Context:**
- Two destruction paths already exist: `updateMining` completion and `detonateAt` inner loop.
- Both need to remove the light if the destroyed block is a lamp. The lamp's id is looked up once at module scope via `BLOCK_BY_NAME['lamp'].id`.
- `GameLoop` gets a new optional constructor arg `lights: LightRegistry | null = null`, same pattern as `particles` and `overlay`.
- Placement-path light add lives in `main.ts`, not here (Task 8).

- [ ] **Step 1: Update imports**

Open `src/game/loop.ts`. In the existing import block (near the top), add the `LightRegistry` type import alongside the existing `PrimedOverlay` type import:

```typescript
import type { PrimedOverlay } from '../engine/render/primed-overlay';
import type { LightRegistry } from '../engine/render/light-registry';
```

- [ ] **Step 2: Add module-level LAMP_ID lookup**

Near the top of `loop.ts`, after the existing imports but before the `GameLoop` class, add:

```typescript
const LAMP_ID = BLOCK_BY_NAME['lamp'].id;
```

(This avoids a per-tick / per-mine `BLOCK_BY_NAME` lookup.)

- [ ] **Step 3: Extend the constructor signature**

Add `private lights: LightRegistry | null = null` as the last optional constructor arg:

```typescript
	constructor(
		private world: World,
		private renderer: Renderer,
		private cam: FpCamera,
		private player: Player,
		private keys: Keys,
		private uvFor: UvFn,
		private particles: ParticleSystem | null = null,
		private overlay: PrimedOverlay | null = null,
		private lights: LightRegistry | null = null,
	) {}
```

- [ ] **Step 4: Remove light on mining completion**

Find the mining-completion block in `updateMining`. After the existing primed-TNT cancel lines (`if (this.primedTnt.delete(k)) this.overlay?.remove(...)`) and BEFORE the `this.world.setBlock(target..., AIR)` call, add:

```typescript
			if (blockId === LAMP_ID) this.lights?.remove(target.x, target.y, target.z);
```

(`blockId` is already in scope — the mining block was captured as `const { target, blockId } = this.mining;`.)

- [ ] **Step 5: Remove lights on TNT detonation**

Find `detonateAt`. Inside the `for (const { x, y, z } of result.destroyed)` loop, BEFORE `this.world.setBlock(x, y, z, AIR)`, add:

```typescript
			if (this.world.getBlock(x, y, z) === LAMP_ID) this.lights?.remove(x, y, z);
```

(One extra `getBlock` per destroyed cell. Fine — detonations are infrequent.)

- [ ] **Step 6: Typecheck + tests**

Run: `npx tsc -b && npm test`

Expected: tsc clean, 83/83 pass.

- [ ] **Step 7: Commit**

```bash
git add src/game/loop.ts
git commit -m "$(cat <<'EOF'
feat(game): remove lamp lights on mine and TNT destruction

GameLoop gains an optional LightRegistry; mining completion and
TNT detonation both fire lights.remove when the destroyed block
is a lamp. Placement-path add lands in main.ts next.
EOF
)"
```

---

## Task 8: `main.ts` wiring — instantiate + wire up the full flow

**Files:**
- Modify: `src/main.ts`

**Context:**
- Three integration pieces:
  1. Instantiate `LightRegistry` and `ColorPicker` once per app; pass registry to `GameLoop`.
  2. After a successful `placeBlock`, if the placed id is `lamp`, add to the registry with `currentLightColor`.
  3. Dispatch `case 'pickLightColor':` — raycast for an optional target lamp, open the picker; on pick, optionally `setColor` the target, update `currentLightColor`, save options, call `autosave.markDirty()`.
  4. On world load (in `startGame`), replay `save.lights` into the registry. On save, supply the registry's entries to `AutoSave`.

- [ ] **Step 1: Imports**

Open `src/main.ts`. In the import block, add:

```typescript
import { LightRegistry } from './engine/render/light-registry';
import { ColorPicker } from './ui/color-picker';
import { LIGHT_PALETTE } from './data/light-palette.data';
import { BLOCK_BY_NAME } from './data/blocks.data';
```

(BLOCK_BY_NAME may already be imported — check and merge if so.)

- [ ] **Step 2: Construct the global singletons**

Near the top of `main()`, right after `const options = new OptionsMenu(app);`, add two new lines:

```typescript
	const lights = new LightRegistry(renderer.scene);
	const colorPicker = new ColorPicker(app, LIGHT_PALETTE);
```

Both live for the app's lifetime (outside `startGame`), so one instance is shared across all worlds the kid opens in one session.

- [ ] **Step 3: Pass the registry to `GameLoop`**

Find the existing `new GameLoop(...)` call (currently 8 args ending with `overlay`). Add `lights` as the 9th arg:

```typescript
		const loop = new GameLoop(world, renderer, cam, player, keys, atlas.uvFor, particles, overlay, lights);
```

- [ ] **Step 4: Replay saved lights on world load**

Inside the `if (mode === 'continue') { ... }` block in `startGame`, after the chunks are restored and before `hud.setHotbar(...)`, add:

```typescript
			if (save?.lights) {
				for (const l of save.lights) lights.add(l.x, l.y, l.z, l.color);
			}
```

For `mode === null` (new world), no replay is needed — the registry starts empty naturally. But for safety, also clear the registry when a new world starts so a second `startGame` call doesn't inherit the prior world's lights. Add at the very top of `startGame`, before any world construction:

```typescript
		// Clear any lights from a prior session of startGame.
		for (const entry of [...lights.entries()]) lights.remove(entry.x, entry.y, entry.z);
```

- [ ] **Step 5: Wire AutoSave to supply lights**

Find the `new AutoSave(...)` construction. Add a sixth argument (after `onQuotaExceeded`) that returns the current light entries as `LightSave[]`:

```typescript
		const autosave = new AutoSave(
			adapter,
			world,
			() => ({ /* existing PlayerSave */ }),
			{ name: worldName, createdAt },
			() => alert('Save storage full. Auto-save disabled for this session.'),
			() => [...lights.entries()],
		);
```

- [ ] **Step 6: Add light on successful place**

Find the right-click block placement handler (currently in the `mousedown` listener, `button === 2` branch). After the existing `placeBlock(...)` call that returns `placed`, and after `loop.markChunkDirtyAround(hit.x, hit.z)`, check if the placed block is a lamp and register its light:

```typescript
			if (!placed) return;
			loop.markChunkDirtyAround(hit.x, hit.z);
			if (id === BLOCK_BY_NAME['lamp'].id) {
				// placeBlock puts the new block at hit.{x,y,z} + face-normal; recompute tx/ty/tz here.
				const face = hit.face;
				const normal = { px: [1,0,0], nx: [-1,0,0], py: [0,1,0], ny: [0,-1,0], pz: [0,0,1], nz: [0,0,-1] }[face];
				const tx = hit.x + normal[0];
				const ty = hit.y + normal[1];
				const tz = hit.z + normal[2];
				lights.add(tx, ty, tz, opts.currentLightColor);
			}
			autosave.markDirty();
```

(`opts` is the `loadOptions()` result already in scope around line 79.)

- [ ] **Step 7: Dispatch `pickLightColor`**

In the `onKey` switch, immediately after the existing `case 'ignite':` block, add:

```typescript
				case 'pickLightColor':
					if (down && !e.repeat) {
						const eye = player.eyePosition();
						const dir = cam.getLookDir();
						const hit = raycastVoxel(world, eye, [dir.x, dir.y, dir.z], REACH);
						const target =
							hit && world.getBlock(hit.x, hit.y, hit.z) === BLOCK_BY_NAME['lamp'].id
								? hit
								: null;
						colorPicker.onPick = (color) => {
							if (target) {
								lights.setColor(target.x, target.y, target.z, color);
								autosave.markDirty();
							}
							opts.currentLightColor = color;
							saveOptions(opts);
						};
						colorPicker.show();
					}
					break;
```

Also add a `saveOptions` import near the top if it isn't already:

```typescript
import { loadOptions, saveOptions } from './persistence/options';
```

- [ ] **Step 8: Typecheck + tests**

Run: `npx tsc -b && npm test`

Expected: tsc clean, 83/83 pass.

- [ ] **Step 9: Commit**

```bash
git add src/main.ts
git commit -m "$(cat <<'EOF'
feat(input): wire lamp lights + color picker end-to-end

Instantiates LightRegistry and ColorPicker once per app, hands
the registry to GameLoop, adds lights on successful lamp
placement using the current color, dispatches C for the picker
(with optional aimed-at-lamp recolor), and replays saved lights
on world load. AutoSave now forwards lights on each save.
EOF
)"
```

---

## Task 9: Visual verification

**Files:** none

**Context:**
- All the logic is unit-tested; this task validates the end-to-end kid experience.
- Dev server at `http://localhost:5173/`.

- [ ] **Step 1: Reload the game**

Open `http://localhost:5173/` in Chrome. Click **New World** or **Continue**.

- [ ] **Step 2: Verify lamp appears in the hotbar**

After spawning in, the hotbar should include a new slot showing the `glowstone` texture labelled "Lamp" on hover.

- [ ] **Step 3: Place a lamp in a dark spot**

Dig a small cave or night-like enclosure. Select the lamp. Right-click to place it. Expected: nearby blocks are visibly lit in warm-white. Moving away dims the effect with distance (~12 blocks).

- [ ] **Step 4: Open the color picker**

Press **C**. Expected: a dimmed overlay appears with a 5×4 grid of 20 pastel colors. Mouse moves freely (pointer lock released).

- [ ] **Step 5: Pick a color without aiming**

Click a blue tile in the picker. Expected: picker closes, click the canvas to re-lock, place another lamp — it should glow blue. The previously placed warm-white lamp is unchanged.

- [ ] **Step 6: Recolor an existing lamp**

Aim at the warm-white lamp (place it in the crosshair). Press **C**. Pick a pink tile. Expected: the lamp's emitted light changes color to pink immediately on close, AND the default color updates to pink so the next placement also glows pink.

- [ ] **Step 7: Destroy a lamp with mining**

Aim at any lamp. Left-click and hold to break it. Expected: the light disappears exactly when the block does (no lingering glow, no orphan).

- [ ] **Step 8: Destroy a lamp with TNT**

Place a lamp, then a TNT block within 3 blocks of it. Ignite the TNT. Expected: when the explosion destroys the lamp, its light disappears with it.

- [ ] **Step 9: Save / reload**

Place two or three lamps with distinct colors. Wait ~6 seconds for autosave, OR blur the window (alt-tab) to force flush. Reload the page. Continue the world. Expected: the lamps are still there AND still emit the colors they had before reload.

- [ ] **Step 10: ESC cancels picker**

Press **C** to open the picker, then **ESC**. Expected: picker closes, no color changes, no error in console.

- [ ] **Step 11: Regression scan**

- [ ] Mining still works for non-lamp blocks.
- [ ] TNT chain reactions still work.
- [ ] Fly mode still works (F, Space/Shift, +/−, pip meter).
- [ ] Hotbar cycling (Tab) still works.
- [ ] Grass blocks still render correctly (side strip on top, green top).
- [ ] No console errors during 1 minute of mixed play.

- [ ] **Step 12: Options menu spot check**

Open **Options** from the main menu. Scroll the keybindings list. Confirm a new **Pick Light Color** row appears with default key **C**. Try rebinding to **V**, save, return to game, press V to open the picker. Rebind back to C when done.

- [ ] **Step 13: Report outcome**

If every check passes: task complete. Summarise the commits on the branch and offer the four finishing options (merge, PR, keep, discard).

If any check fails: stop, diagnose against the spec. Do not paper over — each failure points at a specific line to fix.
