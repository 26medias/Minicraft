# Block Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An `I`-key inventory listing every solid-cube block from the local Minecraft 1.21.6 install (~340), a 9-slot saved hotbar the kid fills from it, and the 16-bit block ids that make room for them.

**Architecture:** Pure catalog rules under `src/data/` turn the jar's blockstates/models into a generated, committed catalog with frozen ids; `blocks.data.ts` composes a dense id-indexed array. Chunks and both codecs widen to 16-bit ids with a byte-compatible varint format. A third translucent mesh pass renders stained glass. `main.ts` owns one `paused` derived from `frozen || inventoryOpen`.

**Tech Stack:** TypeScript strict, Vite, Three.js, vitest (node), `sharp` (build scripts), `unzip` CLI for the jar, zod + express in `api/`.

**Spec:** `docs/superpowers/specs/2026-09-06-block-inventory-design.md` — read it first.

## Global Constraints

- Tabs for indentation.
- vitest include is `src/**/*.test.ts` and `api/src/**/*.test.ts`; nothing under `scripts/` is collected, so every rule that needs a test lives under `src/`.
- `api/` tests are type-checked by nothing (`api/tsconfig.json` excludes them); Task 6 must hand-update its fixtures.
- Never test against `https://noah.leap-forward.ca`. Manual checks use `localhost:5173`.
- The jar is `~/.minecraft/versions/1.21.6/1.21.6.jar`; the generator reads it via the `unzip` CLI (`/usr/bin/unzip`). Textures are already in `src/assets/blocks/`; do not re-extract.
- Base ids 0–19 never change. Generated ids start at `GENERATED_ID_START = 20`, are frozen in `src/data/blocks.catalog.ids.json`, and are never reused.
- Copy, verbatim: hotbar labels are `Title Case` of the block name; group headers are the group name uppercased, except `basics` → `BASICS`.
- Every new test is run and seen to FAIL before the implementation that makes it pass.
- Stage explicit paths; never `git add -A`. Agents do not commit; the orchestrator commits.
- Commit trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_013iT9aEJFRZmSuCLmrCcEBz
  ```

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/data/blocks.base.data.ts` | types, 20 base rows, `DEFAULT_HOTBAR`, `GENERATED_ID_START`, `HOTBAR_SIZE` | 1 |
| `src/data/blocks.data.ts` | dense `BLOCKS` composition + existing helpers + `isTranslucent` | 1 |
| `src/data/keybindings.data.ts`, `src/persistence/options.ts` (+test), `src/ui/options.ts` | kid mode removed; `inventory` action | 1 |
| `src/data/catalog-rules.ts` (+test) | pure generator rules | 2 |
| `scripts/gen-catalog.ts`, `package.json` | jar I/O, emits the two generated files | 3 |
| `src/data/blocks.catalog.data.ts`, `src/data/blocks.catalog.ids.json`, `src/data/blocks.catalog.test.ts` | generated catalog + invariants | 3 |
| `scripts/build-atlas.ts` | 1024/32/8, frame crop, leaf tints | 4 |
| `src/engine/world/chunk.ts`, `src/persistence/codec.ts` (+test), `adapter.ts`, `localStorage.ts` (+test), `cloud.test.ts`, `dual.test.ts`, `src/engine/world/generation.test.ts` | 16-bit ids | 5 |
| `api/src/codec.ts`, `codec.parity.test.ts`, `handlers.ts` (+test), `testFixtures.ts`, `deploy.sh` | server codec, `codec: 2` | 6 |
| `src/engine/world/mesher.ts` (+test), `src/engine/render/renderer.ts` | translucent pass | 7 |
| `src/game/hotbar.ts` (+test) | `resolveHotbar` | 8 |
| `src/ui/inventory.ts`, `src/ui/ui.css` | overlay | 9 |
| `src/main.ts` | pause ownership, gating, wiring | 10 |
| `docs/inventory.md`, `docs/lighting.md`, `README.md`, `docs/specs.md`, `CLAUDE.md`, `docs/liquids.md` | docs | 11 |
| (none) | API deploy, manual browser check | 12 |

**Dependency order:** 1 → 2 → 3 → 4. 5 → 6. 7 needs 3 (uses a generated stained-glass row). 8 needs 1. 9 needs 1. 10 needs 1–9. 11 and 12 need 10. Parallel-safe groups: {1}, then {2, 5, 8, 9}, then {3, 6}, then {4, 7}, then {10}, then {11, 12}.

---

### Task 1: Split the catalog, dense composition, retire kid mode

**Files:**
- Create: `src/data/blocks.base.data.ts`
- Modify: `src/data/blocks.data.ts` (rewrite), `src/data/blocks.data.test.ts` (kid-mode tests), `src/data/keybindings.data.ts` (`Options`, `Action`), `src/persistence/options.ts`, `src/persistence/options.test.ts`, `src/ui/options.ts`, `src/main.ts` (only the `opts.kidMode` line), `docs/liquids.md` (two example rows)

**Interfaces (produces):**
```ts
// blocks.base.data.ts
export type BlockId = number; export type Face = 'px'|'nx'|'py'|'ny'|'pz'|'nz';
export type BlockFaceTextures = …unchanged…;
export type BlockGroup = 'basics'|'wood'|'stone'|'earth'|'sand'|'ore'|'metal'|'wool'|'concrete'|'terracotta'|'glazed'|'glass'|'light'|'nether'|'end'|'deepslate'|'coral'|'utility'|'other';
export const GROUP_ORDER: BlockGroup[];
export type BlockDef = { id; name; label; solid; transparent; translucent: boolean; hardness; lightLevel; lightFilter; liquid; textures; group: BlockGroup; retired?: true };
export const AIR = 0; export const GENERATED_ID_START = 20; export const HOTBAR_SIZE = 9;
export const BASE_BLOCKS: BlockDef[]; export const DEFAULT_HOTBAR: BlockId[];
// blocks.data.ts re-exports all of the above plus BLOCKS, BLOCK_BY_NAME, isSolid, isTransparent, isTranslucent, isLiquid, faceTexture (and whatever it exports today)
// keybindings.data.ts: Action gains 'inventory' (KeyI, 'Open Inventory'); Options loses kidMode
```

- [ ] **Step 1: Failing tests.** In `src/data/blocks.data.test.ts` replace the `flags exactly the kid-mode set` test with:

```ts
	it('is a dense array indexed by id', () => {
		for (let i = 0; i < BLOCKS.length; i++) expect(BLOCKS[i].id).toBe(i);
	});

	it('base rows carry group basics and are not translucent', () => {
		for (const b of BLOCKS.slice(0, 20)) {
			expect(b.group).toBe('basics');
			expect(b.translucent).toBe(false);
		}
	});

	it('DEFAULT_HOTBAR is nine live base blocks', () => {
		expect(DEFAULT_HOTBAR).toHaveLength(9);
		expect(DEFAULT_HOTBAR.map((id) => BLOCKS[id].name)).toEqual([
			'grass_block', 'dirt', 'stone', 'cobblestone', 'sand',
			'oak_planks', 'oak_log', 'glass', 'white_wool',
		]);
	});
```

and delete the three `expect(x.kidMode).toBe(true)` lines (water, lava, obsidian tests). Add `DEFAULT_HOTBAR` to the import from `./blocks.data`.

In `src/persistence/options.test.ts`: delete `expect(opts.kidMode).toBe(true);` and the `kidMode:` keys in the three fixtures; add:

```ts
	it('ignores a stored kidMode', async () => {
		store['minicraft:v1:options'] = JSON.stringify({ kidMode: false, keybindings: DEFAULT_KEYBINDINGS });
		const { loadOptions } = await import('./options');
		expect('kidMode' in loadOptions()).toBe(false);
	});

	it('binds inventory to KeyI by default', async () => {
		const { loadOptions } = await import('./options');
		expect(loadOptions().keybindings.inventory).toBe('KeyI');
	});
```

- [ ] **Step 2: Run** `npx vitest run src/data/blocks.data.test.ts src/persistence/options.test.ts` → the new tests FAIL (`group` undefined, `DEFAULT_HOTBAR` undefined, `kidMode` present, `inventory` undefined).

- [ ] **Step 3: Create `src/data/blocks.base.data.ts`.** Move everything above `BLOCK_BY_NAME` out of `blocks.data.ts` into it, renaming the array `BASE_BLOCKS`, deleting `kidMode: true,` from every row, adding `translucent: false, group: 'basics',` to every row, and appending:

```ts
export type BlockGroup =
	| 'basics' | 'wood' | 'stone' | 'earth' | 'sand' | 'ore' | 'metal' | 'wool'
	| 'concrete' | 'terracotta' | 'glazed' | 'glass' | 'light' | 'nether' | 'end'
	| 'deepslate' | 'coral' | 'utility' | 'other';

/** Inventory display order. */
export const GROUP_ORDER: BlockGroup[] = [
	'basics', 'wood', 'stone', 'earth', 'sand', 'ore', 'metal', 'wool', 'concrete',
	'terracotta', 'glazed', 'glass', 'light', 'nether', 'end', 'deepslate', 'coral',
	'utility', 'other',
];

/** First id the generator may assign. A constant, never BASE_BLOCKS.length. */
export const GENERATED_ID_START = 20;
export const HOTBAR_SIZE = 9;

/** What a new world starts with. Names must exist in BASE_BLOCKS. */
export const DEFAULT_HOTBAR: BlockId[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];
```

`BlockDef` gains `translucent: boolean; group: BlockGroup; retired?: true;` and loses `kidMode`.

- [ ] **Step 4: Rewrite `src/data/blocks.data.ts`:**

```ts
import { BASE_BLOCKS, type BlockDef, type BlockId, type Face } from './blocks.base.data';
import { CATALOG_BLOCKS } from './blocks.catalog.data';

export * from './blocks.base.data';

/** A retired id keeps its slot so every later BLOCKS[id] lookup stays aligned. */
function tombstone(id: BlockId): BlockDef {
	return {
		id, name: `retired_${id}`, label: `Retired ${id}`, solid: false, transparent: true,
		translucent: false, hardness: 0, lightLevel: 0, lightFilter: 0, liquid: 'none',
		textures: null, group: 'other', retired: true,
	};
}

function dense(rows: BlockDef[]): BlockDef[] {
	const max = rows.reduce((m, r) => Math.max(m, r.id), 0);
	const out: BlockDef[] = [];
	for (let i = 0; i <= max; i++) out.push(tombstone(i));
	for (const r of rows) {
		if (!out[r.id].retired) throw new Error(`Duplicate block id ${r.id} (${out[r.id].name}, ${r.name})`);
		out[r.id] = r;
	}
	return out;
}

export const BLOCKS: BlockDef[] = dense([...BASE_BLOCKS, ...CATALOG_BLOCKS]);

export const BLOCK_BY_NAME: Record<string, BlockDef> = Object.fromEntries(
	BLOCKS.filter((b) => !b.retired).map((b) => [b.name, b]),
);

export function isTranslucent(id: BlockId): boolean {
	return BLOCKS[id]?.translucent ?? false;
}
```

then keep the existing `isSolid`, `isTransparent`, `isLiquid`, `faceTexture`, and any other helpers/constants below `BLOCK_BY_NAME` exactly as they are (they reference `BLOCKS`, which now exists above). Create a placeholder `src/data/blocks.catalog.data.ts` so the import resolves (Task 3 overwrites it):

```ts
// GENERATED by scripts/gen-catalog.ts — do not edit by hand.
import type { BlockDef } from './blocks.base.data';

export const CATALOG_BLOCKS: BlockDef[] = [];
```

and `src/data/blocks.catalog.ids.json` containing `{ "ids": {}, "retired": [] }`.

- [ ] **Step 5: Kid mode and the inventory action.** In `src/data/keybindings.data.ts`: add `'inventory'` to `Action` and `ACTIONS` (after `pickLightColor`), `inventory: 'Open Inventory'` to `ACTION_LABEL`, `inventory: 'KeyI'` to `DEFAULT_KEYBINDINGS`; delete `kidMode: boolean;` from `Options`. In `src/persistence/options.ts`: delete `kidMode: true,` from `defaults()` and `kidMode: parsed.kidMode ?? true,` from `loadOptions`. In `src/ui/options.ts`: delete the `kidRow`/`kidLabel`/`kidCheck` block (lines 30–42, from `const kidRow` through `card.appendChild(kidRow);`). In `src/main.ts` replace the two lines

```ts
		const pool = BLOCKS.filter((b) => b.id !== 0 && (opts.kidMode ? b.kidMode : true));
		player.hotbar = pool.map((b) => b.id);
```

with

```ts
		const pool = BLOCKS.filter((b) => b.id !== 0 && !b.retired);
		player.hotbar = pool.map((b) => b.id);
```

(Task 10 replaces this whole block; this keeps the build green meanwhile.) In `docs/liquids.md` remove `kidMode: true,` from the two example rows. Also in `src/ui/hud.ts` change the one `tileRect(id, 'px')` to `tileRect(id, 'nz')` so the hotbar and the inventory show the same face for furnace-type blocks.

- [ ] **Step 6: Run** `npx vitest run && npx tsc -b && npm run lint` → all green.

---

### Task 2: Pure catalog rules

**Files:**
- Create: `src/data/catalog-rules.ts`, `src/data/catalog-rules.test.ts`

**Interfaces (produces):**
```ts
export type ModelJson = { parent?: string; textures?: Record<string, string>; elements?: Array<{ from: number[]; to: number[]; faces: Record<string, { texture: string }> }> };
export type BlockstateJson = { variants?: Record<string, { model: string } | { model: string }[]>; multipart?: unknown };
export type Models = Record<string, ModelJson>;           // keyed by bare model name, e.g. 'cube_all'
export type SixFaces = { px: string; nx: string; py: string; ny: string; pz: string; nz: string };
export function modelKey(ref: string): string;
export function isFullCube(models: Models, model: string): boolean;
export function firstVariantModel(bs: BlockstateJson): string | null;   // prefers axis=y, then facing=north, then file order
export function resolveFaces(models: Models, model: string): SixFaces;   // throws Error(`unresolved face …`)
export function facesToTextures(f: SixFaces): BlockFaceTextures;
export function textureNames(t: BlockFaceTextures): string[];
export function dedupeKey(t: BlockFaceTextures): string;
export function isExcluded(name: string): boolean;
export const LOOK_OVERRIDES: Record<string, string>;        // block name → model name
export const LIGHT_LEVELS: Record<string, number>;
export function groupOf(name: string): BlockGroup;
export function hardnessFor(group: BlockGroup): number;
export function labelFor(name: string): string;
export function classifyAlpha(alpha: ArrayLike<number>): { transparent: boolean; translucent: boolean };
export type Candidate = { name: string; textures: BlockFaceTextures };
export function selectCandidates(blockstates: Record<string, BlockstateJson>, models: Models, base: BlockDef[]): { candidates: Candidate[]; dropped: { name: string; reason: string }[] };
export type IdMap = { ids: Record<string, number>; retired: string[] };   // the committed blocks.catalog.ids.json
export function assignIds(existing: IdMap, names: string[], retire: string[]): IdMap;   // throws on a frozen, non-retired name that is absent
export function makeRows(candidates: Candidate[], map: IdMap, alphaOf: (texture: string) => { transparent: boolean; translucent: boolean }): BlockDef[];  // tombstones for retired ids, sorted by id
```

- [ ] **Step 1: Failing tests** — create `src/data/catalog-rules.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
	assignIds, classifyAlpha, dedupeKey, facesToTextures, firstVariantModel, groupOf,
	hardnessFor, isExcluded, isFullCube, labelFor, makeRows, modelKey, resolveFaces,
	selectCandidates, type Models, type BlockstateJson,
} from './catalog-rules';
import { BASE_BLOCKS } from './blocks.base.data';

// Trimmed copies of the real 1.21.6 models.
const models: Models = {
	block: {},
	cube: { parent: 'block/block', elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: {
		down: { texture: '#down' }, up: { texture: '#up' }, north: { texture: '#north' },
		south: { texture: '#south' }, west: { texture: '#west' }, east: { texture: '#east' } } }] },
	cube_all: { parent: 'block/cube', textures: { particle: '#all', down: '#all', up: '#all', north: '#all', east: '#all', south: '#all', west: '#all' } },
	cube_column: { parent: 'block/cube', textures: { particle: '#side', down: '#end', up: '#end', north: '#side', east: '#side', south: '#side', west: '#side' } },
	cube_bottom_top: { parent: 'block/cube', textures: { particle: '#side', down: '#bottom', up: '#top', north: '#side', east: '#side', south: '#side', west: '#side' } },
	orientable_with_bottom: { parent: 'block/cube', textures: { particle: '#front', down: '#bottom', up: '#top', north: '#front', east: '#side', south: '#side', west: '#side' } },
	orientable: { parent: 'block/orientable_with_bottom', textures: { bottom: '#top' } },
	orientable_vertical: { parent: 'block/cube', textures: { particle: '#side', down: '#side', up: '#front', north: '#side', east: '#side', south: '#side', west: '#side' } },
	template_glazed_terracotta: { parent: 'block/cube', textures: { particle: '#pattern' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: {
		down: { texture: '#pattern' }, up: { texture: '#pattern' }, north: { texture: '#pattern' },
		south: { texture: '#pattern' }, west: { texture: '#pattern' }, east: { texture: '#pattern' } } }] },
	stairs: { parent: 'block/block', elements: [{ from: [0, 0, 0], to: [16, 8, 16], faces: { up: { texture: '#top' } } }, { from: [8, 8, 0], to: [16, 16, 16], faces: { up: { texture: '#top' } } }] },
	stone: { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/stone' } },
	oak_log: { parent: 'minecraft:block/cube_column', textures: { end: 'minecraft:block/oak_log_top', side: 'minecraft:block/oak_log' } },
	sandstone: { parent: 'minecraft:block/cube_bottom_top', textures: { bottom: 'minecraft:block/sandstone_bottom', side: 'minecraft:block/sandstone', top: 'minecraft:block/sandstone_top' } },
	furnace: { parent: 'minecraft:block/orientable', textures: { front: 'minecraft:block/furnace_front', side: 'minecraft:block/furnace_side', top: 'minecraft:block/furnace_top' } },
	furnace_on: { parent: 'minecraft:block/orientable', textures: { front: 'minecraft:block/furnace_front_on', side: 'minecraft:block/furnace_side', top: 'minecraft:block/furnace_top' } },
	dispenser: { parent: 'minecraft:block/orientable', textures: { front: 'minecraft:block/dispenser_front', side: 'minecraft:block/furnace_side', top: 'minecraft:block/furnace_top' } },
	dispenser_vertical: { parent: 'minecraft:block/orientable_vertical', textures: { front: 'minecraft:block/dispenser_front_vertical', side: 'minecraft:block/furnace_top' } },
	cyan_glazed_terracotta: { parent: 'minecraft:block/template_glazed_terracotta', textures: { pattern: 'minecraft:block/cyan_glazed_terracotta' } },
	stone_stairs: { parent: 'minecraft:block/stairs', textures: { bottom: 'minecraft:block/stone', side: 'minecraft:block/stone', top: 'minecraft:block/stone' } },
	infested_stone: { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/stone' } },
	stone_bricks: { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/stone_bricks' } },
	infested_stone_bricks: { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/stone_bricks' } },
	glowstone: { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/glowstone' } },
	broken: { parent: 'minecraft:block/cube_all', textures: {} },
	redstone_lamp: { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/redstone_lamp' } },
	redstone_lamp_on: { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/redstone_lamp_on' } },
};

const bs = (model: string, extra: Record<string, { model: string }> = {}): BlockstateJson => ({
	variants: { '': { model: `minecraft:block/${model}` }, ...extra },
});

describe('modelKey', () => {
	it('strips namespace and block/ prefix', () => {
		expect(modelKey('minecraft:block/cube_all')).toBe('cube_all');
		expect(modelKey('block/cube')).toBe('cube');
		expect(modelKey('cube')).toBe('cube');
	});
});

describe('isFullCube', () => {
	it('accepts cube_all, template chains, and rejects stairs', () => {
		expect(isFullCube(models, 'stone')).toBe(true);
		expect(isFullCube(models, 'cyan_glazed_terracotta')).toBe(true);
		expect(isFullCube(models, 'stone_stairs')).toBe(false);
		expect(isFullCube(models, 'block')).toBe(false);
	});
});

describe('firstVariantModel', () => {
	it('takes the first variant in file order, array form included', () => {
		expect(firstVariantModel(bs('stone'))).toBe('stone');
		expect(firstVariantModel({ variants: { 'lit=false': [{ model: 'minecraft:block/furnace' }], 'lit=true': { model: 'minecraft:block/furnace_on' } } })).toBe('furnace');
		expect(firstVariantModel({ multipart: [] })).toBeNull();
	});
	it('prefers axis=y (upright logs) and facing=north (front on north) over file order', () => {
		// cherry_log lists axis=x first; its x model has a sideways element.
		expect(firstVariantModel({ variants: {
			'axis=x': { model: 'minecraft:block/cherry_log_horizontal' },
			'axis=y': { model: 'minecraft:block/cherry_log' },
			'axis=z': { model: 'minecraft:block/cherry_log_horizontal' } } })).toBe('cherry_log');
		expect(firstVariantModel({ variants: {
			'facing=down': { model: 'minecraft:block/dispenser_vertical' },
			'facing=north': { model: 'minecraft:block/dispenser' } } })).toBe('dispenser');
	});
});

describe('resolveFaces / facesToTextures', () => {
	it('resolves #var indirection through the chain', () => {
		expect(facesToTextures(resolveFaces(models, 'stone'))).toEqual({ kind: 'uniform', all: 'stone' });
		expect(facesToTextures(resolveFaces(models, 'oak_log'))).toEqual({ kind: 'columnar', top: 'oak_log_top', bottom: 'oak_log_top', sides: 'oak_log' });
		expect(facesToTextures(resolveFaces(models, 'sandstone'))).toEqual({ kind: 'top-bottom-side', top: 'sandstone_top', bottom: 'sandstone_bottom', side: 'sandstone' });
	});
	it('keeps the front of orientable blocks on nz (north) as a six-kind', () => {
		expect(facesToTextures(resolveFaces(models, 'furnace'))).toEqual({
			kind: 'six', px: 'furnace_side', nx: 'furnace_side', py: 'furnace_top', ny: 'furnace_top',
			pz: 'furnace_side', nz: 'furnace_front',
		});
	});
	it('resolves orientable_vertical (dispenser) with front on top', () => {
		const t = facesToTextures(resolveFaces(models, 'dispenser_vertical'));
		expect(t).toEqual({ kind: 'top-bottom-side', top: 'dispenser_front_vertical', bottom: 'furnace_top', side: 'furnace_top' });
	});
	it('resolves glazed terracotta through its template element', () => {
		expect(facesToTextures(resolveFaces(models, 'cyan_glazed_terracotta'))).toEqual({ kind: 'uniform', all: 'cyan_glazed_terracotta' });
	});
	it('throws on an unresolved face', () => {
		expect(() => resolveFaces(models, 'broken')).toThrow(/unresolved/);
	});
});

describe('isExcluded / groupOf / hardnessFor / labelFor', () => {
	it('excludes dev blocks and waxed/infested prefixes', () => {
		for (const n of ['jigsaw', 'structure_block', 'spawner', 'waxed_copper_block', 'infested_stone', 'respawn_anchor', 'barrier'])
			expect(isExcluded(n)).toBe(true);
		expect(isExcluded('copper_block')).toBe(false);
	});
	it.each([
		['cyan_glazed_terracotta', 'glazed'], ['blue_stained_glass', 'glass'], ['tinted_glass', 'glass'], ['ice', 'glass'],
		['pink_wool', 'wool'], ['red_concrete', 'concrete'], ['red_concrete_powder', 'concrete'], ['orange_terracotta', 'terracotta'],
		['brain_coral_block', 'coral'], ['sea_lantern', 'light'], ['redstone_lamp', 'light'], ['jack_o_lantern', 'light'],
		['deepslate', 'deepslate'], ['deepslate_gold_ore', 'deepslate'], ['tuff', 'deepslate'], ['sculk', 'deepslate'],
		['end_stone', 'end'], ['purpur_block', 'end'], ['netherrack', 'nether'], ['nether_bricks', 'nether'], ['blackstone', 'nether'],
		['ancient_debris', 'nether'], ['warped_planks', 'nether'], ['iron_ore', 'ore'], ['raw_gold_block', 'ore'],
		['copper_block', 'metal'], ['redstone_block', 'metal'], ['amethyst_block', 'metal'],
		['oak_planks', 'wood'], ['birch_log', 'wood'], ['acacia_leaves', 'wood'], ['bookshelf', 'wood'], ['bamboo_block', 'wood'],
		['furnace', 'utility'], ['crafting_table', 'utility'], ['note_block', 'utility'], ['bone_block', 'utility'], ['bee_nest', 'utility'],
		['sandstone', 'stone'], ['mossy_cobblestone', 'stone'], ['packed_mud', 'stone'], ['resin_bricks', 'stone'], ['bricks', 'stone'],
		['quartz_block', 'stone'], ['calcite', 'stone'], ['sand', 'sand'], ['gravel', 'sand'], ['clay', 'sand'],
		['coarse_dirt', 'earth'], ['moss_block', 'earth'], ['mycelium', 'earth'], ['snow_block', 'earth'], ['hay_block', 'earth'],
		['pumpkin', 'earth'], ['honey_block', 'earth'], ['slime_block', 'earth'], ['dried_kelp_block', 'earth'],
		['target', 'utility'], ['budding_amethyst', 'metal'], ['creaking_heart', 'other'],
	])('groups %s as %s', (name, group) => {
		expect(groupOf(name)).toBe(group);
	});
	it('assigns hardness by group', () => {
		expect(hardnessFor('wool')).toBe(0.3);
		expect(hardnessFor('wood')).toBe(0.8);
		expect(hardnessFor('stone')).toBe(1.2);
		expect(hardnessFor('metal')).toBe(1.5);
	});
	it('title-cases labels', () => {
		expect(labelFor('dark_oak_planks')).toBe('Dark Oak Planks');
		expect(labelFor('jack_o_lantern')).toBe('Jack O Lantern');
	});
});

describe('classifyAlpha', () => {
	it('distinguishes opaque, cutout, translucent', () => {
		expect(classifyAlpha([255, 255])).toEqual({ transparent: false, translucent: false });
		expect(classifyAlpha([255, 0])).toEqual({ transparent: true, translucent: false });
		expect(classifyAlpha([255, 102])).toEqual({ transparent: true, translucent: true });
	});
});

describe('selectCandidates', () => {
	const blockstates: Record<string, BlockstateJson> = {
		stone: bs('stone'),                      // in base → skipped by name
		stone_bricks: bs('stone_bricks'),
		infested_stone_bricks: bs('infested_stone_bricks'),   // excluded by prefix
		infested_stone: bs('infested_stone'),
		glowstone: bs('glowstone'),              // same look as base lamp → dropped
		furnace: { variants: { 'facing=north,lit=false': { model: 'minecraft:block/furnace' }, 'facing=north,lit=true': { model: 'minecraft:block/furnace_on' } } },
		dispenser: { variants: { 'facing=north': { model: 'minecraft:block/dispenser' }, 'facing=up': { model: 'minecraft:block/dispenser_vertical' } } },
		cyan_glazed_terracotta: bs('cyan_glazed_terracotta'),
		stone_stairs: bs('stone_stairs'),
		oak_fence: { multipart: [] },
		redstone_lamp: { variants: { 'lit=false': { model: 'minecraft:block/redstone_lamp' }, 'lit=true': { model: 'minecraft:block/redstone_lamp_on' } } },
		broken: bs('broken'),
	};
	it('keeps full cubes, applies exclusions, dedupes against base and shortest name, applies overrides', () => {
		const { candidates, dropped } = selectCandidates(blockstates, models, BASE_BLOCKS);
		const names = candidates.map((c) => c.name);
		expect(names).toEqual(['cyan_glazed_terracotta', 'dispenser', 'furnace', 'redstone_lamp', 'stone_bricks']);
		expect(candidates.find((c) => c.name === 'redstone_lamp')!.textures).toEqual({ kind: 'uniform', all: 'redstone_lamp_on' });
		expect(candidates.find((c) => c.name === 'furnace')!.textures.kind).toBe('six');
		const reasons = Object.fromEntries(dropped.map((d) => [d.name, d.reason]));
		expect(reasons.stone).toMatch(/base/);
		expect(reasons.infested_stone_bricks).toMatch(/excluded/);
		expect(reasons.glowstone).toMatch(/duplicate of lamp/);
		expect(reasons.stone_stairs).toMatch(/not a full cube/);
		expect(reasons.oak_fence).toMatch(/multipart|not a full cube/);
		expect(reasons.broken).toMatch(/unresolved/);
	});
});

describe('assignIds', () => {
	const empty = { ids: {}, retired: [] };
	it('keeps existing ids, appends new names in name order from max+1, starts at 20', () => {
		expect(assignIds(empty, ['b', 'a'], [])).toEqual({ ids: { a: 20, b: 21 }, retired: [] });
		expect(assignIds({ ids: { a: 20, b: 21 }, retired: [] }, ['b', 'a', 'c'], [])).toEqual({ ids: { a: 20, b: 21, c: 22 }, retired: [] });
	});
	it('records a retirement, never reuses the id, and needs no flag on later runs', () => {
		const once = assignIds({ ids: { a: 20, b: 21 }, retired: [] }, ['a', 'c'], ['b']);
		expect(once).toEqual({ ids: { a: 20, b: 21, c: 22 }, retired: ['b'] });
		expect(assignIds(once, ['a', 'c'], [])).toEqual(once);
	});
	it('throws when a frozen name disappears without --retire', () => {
		expect(() => assignIds({ ids: { a: 20, b: 21 }, retired: [] }, ['a'], [])).toThrow(/b/);
	});
	it('un-retires a name that resolves again, keeping its id', () => {
		expect(assignIds({ ids: { a: 20, b: 21 }, retired: ['b'] }, ['a', 'b'], [])).toEqual({ ids: { a: 20, b: 21 }, retired: [] });
	});
});

describe('makeRows', () => {
	it('emits rows in id order with tombstones for retired ids', () => {
		const map = { ids: { blue_stained_glass: 20, gone: 21, c: 22 }, retired: ['gone'] };
		const rows = makeRows(
			[{ name: 'c', textures: { kind: 'uniform', all: 'c' } }, { name: 'blue_stained_glass', textures: { kind: 'uniform', all: 'blue_stained_glass' } }],
			map,
			(t) => (t === 'blue_stained_glass' ? { transparent: true, translucent: true } : { transparent: false, translucent: false }),
		);
		expect(rows.map((r) => r.id)).toEqual([20, 21, 22]);
		expect(rows[1].retired).toBe(true);
		expect(rows[1].textures).toBeNull();
		expect(rows[0]).toMatchObject({ name: 'blue_stained_glass', transparent: true, translucent: true, lightFilter: 0, group: 'glass', hardness: 0.3 });
		expect(rows[2]).toMatchObject({ name: 'c', transparent: false, lightFilter: 15, group: 'other', hardness: 0.8, lightLevel: 0 });
	});
	it('applies LIGHT_LEVELS', () => {
		const rows = makeRows([{ name: 'sea_lantern', textures: { kind: 'uniform', all: 'sea_lantern' } }], { ids: { sea_lantern: 20 }, retired: [] }, () => ({ transparent: false, translucent: false }));
		expect(rows[0].lightLevel).toBe(15);
	});
});
```

- [ ] **Step 2: Run** `npx vitest run src/data/catalog-rules.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/data/catalog-rules.ts`:**

```ts
import { type BlockDef, type BlockFaceTextures, type BlockGroup, GENERATED_ID_START } from './blocks.base.data';

export type ModelJson = {
	parent?: string;
	textures?: Record<string, string>;
	elements?: Array<{ from: number[]; to: number[]; faces: Record<string, { texture: string }> }>;
};
export type BlockstateJson = {
	variants?: Record<string, { model: string } | { model: string }[]>;
	multipart?: unknown;
};
export type Models = Record<string, ModelJson>;
export type SixFaces = { px: string; nx: string; py: string; ny: string; pz: string; nz: string };

export function modelKey(ref: string): string {
	return ref.replace(/^minecraft:/, '').replace(/^block\//, '');
}

/** The model and its ancestors, nearest first. */
function chain(models: Models, model: string): ModelJson[] {
	const out: ModelJson[] = [];
	let cur: string | undefined = model;
	const seen = new Set<string>();
	while (cur && !seen.has(cur)) {
		seen.add(cur);
		const m = models[cur];
		if (!m) break;
		out.push(m);
		cur = m.parent ? modelKey(m.parent) : undefined;
	}
	return out;
}

function isUnit(v: number[], expect: number): boolean {
	return v.length === 3 && v.every((n) => n === expect);
}

/** True when the nearest ancestor with elements has exactly one 0..16 cube. */
export function isFullCube(models: Models, model: string): boolean {
	const withElements = chain(models, model).find((m) => m.elements);
	if (!withElements || !withElements.elements) return false;
	const els = withElements.elements;
	return els.length === 1 && isUnit(els[0].from, 0) && isUnit(els[0].to, 16);
}

/**
 * The variant that gives the block its "resting" look: upright for logs
 * (axis=y; the axis=x model of cherry/bamboo logs carries a sideways element),
 * front on north for furnaces and dispensers, else the first in file order.
 */
export function firstVariantModel(bs: BlockstateJson): string | null {
	if (!bs.variants) return null;
	const keys = Object.keys(bs.variants);
	if (keys.length === 0) return null;
	const pick =
		keys.find((k) => k.split(',').includes('axis=y')) ??
		keys.find((k) => k.split(',').includes('facing=north')) ??
		keys[0];
	const entry = bs.variants[pick];
	const v = Array.isArray(entry) ? entry[0] : entry;
	return v ? modelKey(v.model) : null;
}

const FACE_MAP: Record<string, keyof SixFaces> = { north: 'nz', south: 'pz', east: 'px', west: 'nx', up: 'py', down: 'ny' };

export function resolveFaces(models: Models, model: string): SixFaces {
	const ch = chain(models, model);
	const withElements = ch.find((m) => m.elements);
	if (!withElements?.elements?.[0]) throw new Error(`unresolved faces for ${model}: no elements`);
	// Nearest definition wins.
	const vars: Record<string, string> = {};
	for (let i = ch.length - 1; i >= 0; i--) Object.assign(vars, ch[i].textures ?? {});
	const deref = (ref: string, face: string): string => {
		let cur = ref;
		for (let hops = 0; hops < 16; hops++) {
			if (!cur.startsWith('#')) return modelKey(cur);
			const next = vars[cur.slice(1)];
			if (next === undefined) throw new Error(`unresolved face ${face} (${ref}) for ${model}`);
			cur = next;
		}
		throw new Error(`unresolved face ${face} for ${model}: reference loop`);
	};
	const out: Partial<SixFaces> = {};
	for (const [mcFace, ours] of Object.entries(FACE_MAP)) {
		const f = withElements.elements[0].faces[mcFace];
		if (!f) throw new Error(`unresolved face ${mcFace} for ${model}: missing`);
		out[ours] = deref(f.texture, mcFace);
	}
	return out as SixFaces;
}

export function facesToTextures(f: SixFaces): BlockFaceTextures {
	const sides = [f.px, f.nx, f.pz, f.nz];
	const sidesEqual = sides.every((s) => s === f.px);
	if (sidesEqual && f.py === f.px && f.ny === f.px) return { kind: 'uniform', all: f.px };
	if (sidesEqual && f.py === f.ny) return { kind: 'columnar', top: f.py, bottom: f.ny, sides: f.px };
	if (sidesEqual) return { kind: 'top-bottom-side', top: f.py, bottom: f.ny, side: f.px };
	return { kind: 'six', px: f.px, nx: f.nx, py: f.py, ny: f.ny, pz: f.pz, nz: f.nz };
}

export function textureNames(t: BlockFaceTextures): string[] {
	switch (t.kind) {
		case 'uniform': return [t.all];
		case 'top-bottom-side': return [t.top, t.bottom, t.side];
		case 'columnar': return [t.top, t.bottom, t.sides];
		case 'six': return [t.px, t.nx, t.py, t.ny, t.pz, t.nz];
	}
}

export function dedupeKey(t: BlockFaceTextures): string {
	return `${t.kind}:${textureNames(t).join(',')}`;
}

const EXCLUDED_NAMES = new Set([
	'command_block', 'chain_command_block', 'repeating_command_block', 'structure_block', 'jigsaw',
	'test_block', 'test_instance_block', 'barrier', 'light', 'spawner', 'trial_spawner', 'vault',
	'respawn_anchor', 'frosted_ice', 'reinforced_deepslate',
]);
const EXCLUDED_PREFIXES = ['waxed_', 'infested_'];

export function isExcluded(name: string): boolean {
	return EXCLUDED_NAMES.has(name) || EXCLUDED_PREFIXES.some((p) => name.startsWith(p));
}

/** Block name → model to use instead of the first variant. */
export const LOOK_OVERRIDES: Record<string, string> = { redstone_lamp: 'redstone_lamp_on' };

export const LIGHT_LEVELS: Record<string, number> = {
	sea_lantern: 15, shroomlight: 15, jack_o_lantern: 15, ochre_froglight: 15, verdant_froglight: 15,
	pearlescent_froglight: 15, magma_block: 3, crying_obsidian: 10, redstone_lamp: 15,
};

// Order matters: first matching token wins.
const GROUP_RULES: Array<[BlockGroup, string[]]> = [
	['glazed', ['glazed']],
	['glass', ['stained_glass', 'glass', 'ice']],
	['wool', ['_wool']],
	['concrete', ['_concrete']],
	['terracotta', ['terracotta']],
	['coral', ['coral']],
	['light', ['glowstone', 'sea_lantern', 'froglight', 'jack_o_lantern', 'redstone_lamp']],
	['deepslate', ['deepslate', 'tuff', 'sculk']],
	['end', ['end_', 'purpur', 'chorus']],
	['nether', ['netherrack', 'nether_', 'soul_', 'basalt', 'blackstone', 'magma', 'shroomlight', 'warped', 'crimson', 'ancient_debris']],
	['ore', ['_ore', 'raw_']],
	['metal', ['copper', 'iron_block', 'gold_block', 'diamond_block', 'emerald_block', 'netherite', 'lapis_block', 'redstone_block', 'coal_block', 'amethyst']],
	['wood', ['_planks', '_log', '_wood', '_stem', '_hyphae', '_leaves', 'bookshelf', 'bamboo']],
	['utility', ['furnace', 'smoker', '_table', 'loom', 'barrel', 'jukebox', 'note_block', 'target', 'bone_block', 'beehive', 'bee_nest', 'dispenser', 'dropper', 'observer', 'composter', 'lodestone', 'crafter']],
	['stone', ['stone', 'brick', 'andesite', 'diorite', 'granite', 'cobble', 'prismarine', 'quartz', 'calcite', 'dripstone', 'obsidian', 'bedrock', 'packed_mud', 'resin']],
	['sand', ['sand', 'gravel', 'clay']],
	['earth', ['dirt', 'grass', 'mud', 'moss', 'mycelium', 'podzol', 'snow', 'hay', 'melon', 'pumpkin', 'sponge', 'honey', 'slime', 'dried_kelp']],
];

export function groupOf(name: string): BlockGroup {
	for (const [group, tokens] of GROUP_RULES) if (tokens.some((t) => name.includes(t))) return group;
	return 'other';
}

const HARDNESS: Record<BlockGroup, number> = {
	basics: 0.8, wool: 0.3, glass: 0.3, glazed: 0.3, earth: 0.3, sand: 0.3, coral: 0.3,
	wood: 0.8, concrete: 0.8, terracotta: 0.8, utility: 0.8, light: 0.8, other: 0.8,
	stone: 1.2, deepslate: 1.2, nether: 1.2, end: 1.2, metal: 1.5, ore: 1.5,
};
export function hardnessFor(group: BlockGroup): number {
	return HARDNESS[group];
}

export function labelFor(name: string): string {
	return name.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export function classifyAlpha(alpha: ArrayLike<number>): { transparent: boolean; translucent: boolean } {
	let transparent = false, translucent = false;
	for (let i = 0; i < alpha.length; i++) {
		const a = alpha[i];
		if (a < 255) transparent = true;
		if (a > 0 && a < 255) translucent = true;
	}
	return { transparent, translucent };
}

export type Candidate = { name: string; textures: BlockFaceTextures };

export function selectCandidates(
	blockstates: Record<string, BlockstateJson>,
	models: Models,
	base: BlockDef[],
): { candidates: Candidate[]; dropped: { name: string; reason: string }[] } {
	const dropped: { name: string; reason: string }[] = [];
	const baseNames = new Set(base.map((b) => b.name));
	const seen = new Map<string, string>();
	for (const b of base) if (b.textures) seen.set(dedupeKey(b.textures), b.name);

	const resolved: Candidate[] = [];
	for (const name of Object.keys(blockstates).sort()) {
		if (baseNames.has(name)) { dropped.push({ name, reason: 'already a base block' }); continue; }
		if (isExcluded(name)) { dropped.push({ name, reason: 'excluded by name' }); continue; }
		const model = LOOK_OVERRIDES[name] ?? firstVariantModel(blockstates[name]);
		if (!model) { dropped.push({ name, reason: 'multipart or no variants (not a full cube)' }); continue; }
		const bs = blockstates[name];
		const allModels = Object.values(bs.variants ?? {}).flatMap((v) => (Array.isArray(v) ? v : [v])).map((v) => modelKey(v.model));
		if (!allModels.every((m) => isFullCube(models, m))) { dropped.push({ name, reason: 'not a full cube' }); continue; }
		try {
			resolved.push({ name, textures: facesToTextures(resolveFaces(models, model)) });
		} catch (e) {
			dropped.push({ name, reason: String((e as Error).message) });
		}
	}
	// Shortest name wins, then alphabetical.
	resolved.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
	const candidates: Candidate[] = [];
	for (const c of resolved) {
		const key = dedupeKey(c.textures);
		const winner = seen.get(key);
		if (winner) { dropped.push({ name: c.name, reason: `duplicate of ${winner}` }); continue; }
		seen.set(key, c.name);
		candidates.push(c);
	}
	candidates.sort((a, b) => a.name.localeCompare(b.name));
	return { candidates, dropped };
}

/** The committed blocks.catalog.ids.json: frozen name→id plus which names are tombstoned. */
export type IdMap = { ids: Record<string, number>; retired: string[] };

export function assignIds(existing: IdMap, names: string[], retire: string[]): IdMap {
	const ids: Record<string, number> = { ...existing.ids };
	const present = new Set(names);
	const retired = new Set(existing.retired.filter((n) => !present.has(n)));
	for (const n of retire) retired.add(n);
	for (const name of Object.keys(existing.ids)) {
		if (!present.has(name) && !retired.has(name)) {
			throw new Error(`frozen block "${name}" (id ${existing.ids[name]}) no longer resolves; pass --retire ${name} to tombstone it`);
		}
	}
	let next = Math.max(GENERATED_ID_START - 1, ...Object.values(ids)) + 1;
	for (const name of [...names].sort()) {
		if (ids[name] === undefined) ids[name] = next++;
	}
	return { ids, retired: [...retired].sort() };
}

export function makeRows(
	candidates: Candidate[],
	map: IdMap,
	alphaOf: (texture: string) => { transparent: boolean; translucent: boolean },
): BlockDef[] {
	const byName = new Map(candidates.map((c) => [c.name, c]));
	const rows: BlockDef[] = [];
	for (const [name, id] of Object.entries(map.ids).sort((a, b) => a[1] - b[1])) {
		const c = byName.get(name);
		if (!c) {
			rows.push({
				id, name: `retired_${id}`, label: `Retired ${id}`, solid: false, transparent: true,
				translucent: false, hardness: 0, lightLevel: 0, lightFilter: 0, liquid: 'none',
				textures: null, group: 'other', retired: true,
			});
			continue;
		}
		let transparent = false, translucent = false;
		for (const t of textureNames(c.textures)) {
			const a = alphaOf(t);
			transparent ||= a.transparent;
			translucent ||= a.translucent;
		}
		const group = groupOf(name);
		rows.push({
			id, name, label: labelFor(name), solid: true, transparent, translucent,
			hardness: hardnessFor(group), lightLevel: LIGHT_LEVELS[name] ?? 0,
			lightFilter: transparent ? 0 : 15, liquid: 'none', textures: c.textures, group,
		});
	}
	return rows;
}
```

- [ ] **Step 4: Run** `npx vitest run src/data/catalog-rules.test.ts && npx tsc -b` → all PASS. If `groups %s` cases fail, fix the rule ORDER or tokens, not the test, unless the test's expectation contradicts the spec's rule 8.

---

### Task 3: Generator script and the committed catalog

**Files:**
- Create: `scripts/gen-catalog.ts`, `src/data/blocks.catalog.test.ts`
- Modify: `package.json` (script), overwrite `src/data/blocks.catalog.data.ts` and `src/data/blocks.catalog.ids.json` by running the generator

**Interfaces:**
- Consumes: everything in Task 2; `BASE_BLOCKS`, `GENERATED_ID_START` (Task 1).
- Produces: `CATALOG_BLOCKS: BlockDef[]` (generated file), `blocks.catalog.ids.json`.

- [ ] **Step 1: Failing invariant test** — create `src/data/blocks.catalog.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { BLOCKS, BLOCK_BY_NAME, DEFAULT_HOTBAR, GENERATED_ID_START, GROUP_ORDER } from './blocks.data';
import { CATALOG_BLOCKS } from './blocks.catalog.data';
import { textureNames } from './catalog-rules';
import idMap from './blocks.catalog.ids.json';

const ids = idMap.ids as Record<string, number>;

describe('generated catalog', () => {
	it('has been generated (hundreds of rows)', () => {
		expect(CATALOG_BLOCKS.length).toBeGreaterThan(300);
	});
	it('is dense and id-aligned', () => {
		for (let i = 0; i < BLOCKS.length; i++) expect(BLOCKS[i].id).toBe(i);
	});
	it('keeps base ids 0-19 exactly', () => {
		expect(BLOCKS.slice(0, 20).map((b) => b.name)).toEqual([
			'air', 'grass_block', 'dirt', 'stone', 'cobblestone', 'sand', 'oak_planks', 'oak_log', 'glass',
			'white_wool', 'red_wool', 'blue_wool', 'green_wool', 'yellow_wool', 'black_wool', 'tnt', 'lamp',
			'water', 'lava', 'obsidian',
		]);
	});
	it('matches the frozen id map', () => {
		for (const [name, id] of Object.entries(ids as Record<string, number>)) {
			const row = BLOCKS[id];
			expect(row.retired ? true : row.name === name).toBe(true);
			expect(id).toBeGreaterThanOrEqual(GENERATED_ID_START);
		}
		expect(CATALOG_BLOCKS.length).toBe(Object.keys(ids).length);
	});
	it('has unique names and every texture file', () => {
		const names = new Set<string>();
		for (const b of CATALOG_BLOCKS) {
			if (b.retired) continue;
			expect(names.has(b.name)).toBe(false);
			names.add(b.name);
			for (const t of textureNames(b.textures!)) expect(existsSync(`src/assets/blocks/${t}.png`)).toBe(true);
			expect(GROUP_ORDER).toContain(b.group);
		}
	});
	it('contains the blocks the kid will look for, with the right shape', () => {
		expect(BLOCK_BY_NAME['jack_o_lantern'].textures!.kind).toBe('six');
		expect(BLOCK_BY_NAME['jack_o_lantern'].lightLevel).toBe(15);
		expect(BLOCK_BY_NAME['cyan_glazed_terracotta'].group).toBe('glazed');
		expect(BLOCK_BY_NAME['blue_stained_glass'].translucent).toBe(true);
		expect(BLOCK_BY_NAME['oak_leaves']).toMatchObject({ transparent: true, translucent: false, lightFilter: 0 });
		expect(BLOCK_BY_NAME['stone_bricks']).toBeDefined();
		expect(BLOCK_BY_NAME['infested_stone_bricks']).toBeUndefined();
		expect(BLOCK_BY_NAME['waxed_copper_block']).toBeUndefined();
		expect(BLOCK_BY_NAME['glowstone']).toBeUndefined(); // same look as lamp
		expect(BLOCK_BY_NAME['redstone_lamp'].textures).toEqual({ kind: 'uniform', all: 'redstone_lamp_on' });
		expect(BLOCK_BY_NAME['dropper']).toBeDefined();
	});
	it('pins a few ids so a regeneration cannot renumber silently', () => {
		// Filled in from the first generated ids.json; see Step 5.
		const pinned: Record<string, number> = { /* FILL: e.g. acacia_leaves: 20, acacia_log: 21 */ };
		expect(Object.keys(pinned).length).toBeGreaterThanOrEqual(3);
		expect(ids).toMatchObject(pinned);
	});
	it('DEFAULT_HOTBAR names all exist', () => {
		for (const id of DEFAULT_HOTBAR) expect(BLOCKS[id].retired).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run** `npx vitest run src/data/blocks.catalog.test.ts` → FAIL at "has been generated" (0 rows).

- [ ] **Step 3: Create `scripts/gen-catalog.ts`:**

```ts
/**
 * Reads the local Minecraft jar and writes src/data/blocks.catalog.data.ts and
 * src/data/blocks.catalog.ids.json. Run by hand: `npm run gen-catalog [-- --retire name]`.
 * Textures are NOT extracted here; they already live in src/assets/blocks/.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argv, env, exit } from 'node:process';
import { format } from 'prettier';
import sharp from 'sharp';
import { BASE_BLOCKS } from '../src/data/blocks.base.data.js';
import {
	assignIds, classifyAlpha, makeRows, selectCandidates, textureNames,
	type BlockstateJson, type IdMap, type Models,
} from '../src/data/catalog-rules.js';

const JAR = env.MINECRAFT_JAR ?? join(env.HOME ?? '', '.minecraft/versions/1.21.6/1.21.6.jar');
const ASSETS = 'src/assets/blocks';
const OUT_TS = 'src/data/blocks.catalog.data.ts';
const OUT_IDS = 'src/data/blocks.catalog.ids.json';

function readJsonDir<T>(dir: string): Record<string, T> {
	const out: Record<string, T> = {};
	for (const f of readdirSync(dir)) if (f.endsWith('.json')) out[f.slice(0, -5)] = JSON.parse(readFileSync(join(dir, f), 'utf8')) as T;
	return out;
}

async function alphaOfTexture(name: string): Promise<{ transparent: boolean; translucent: boolean }> {
	const img = sharp(join(ASSETS, `${name}.png`)).ensureAlpha();
	const meta = await img.metadata();
	const w = meta.width ?? 16;
	// Animated strips are taller than wide; frame 0 is what the atlas uses.
	const frame = meta.height && meta.height > w ? img.extract({ left: 0, top: 0, width: w, height: w }) : img;
	const { data } = await frame.raw().toBuffer({ resolveWithObject: true });
	const alpha: number[] = [];
	for (let i = 3; i < data.length; i += 4) alpha.push(data[i]);
	return classifyAlpha(alpha);
}

async function main() {
	if (!existsSync(JAR)) {
		console.error(`Minecraft jar not found at ${JAR}. Set MINECRAFT_JAR.`);
		exit(1);
	}
	const retire = argv.slice(2).flatMap((a, i, all) => (a === '--retire' && all[i + 1] ? [all[i + 1]] : []));

	const tmp = mkdtempSync(join(tmpdir(), 'minicraft-jar-'));
	try {
		execFileSync('unzip', ['-oq', JAR, 'assets/minecraft/models/block/*', 'assets/minecraft/blockstates/*', '-d', tmp]);
		const models = readJsonDir<Models[string]>(join(tmp, 'assets/minecraft/models/block'));
		const blockstates = readJsonDir<BlockstateJson>(join(tmp, 'assets/minecraft/blockstates'));

		const { candidates, dropped } = selectCandidates(blockstates, models, BASE_BLOCKS);
		const missingTexture = candidates.filter((c) => textureNames(c.textures).some((t) => !existsSync(join(ASSETS, `${t}.png`))));
		for (const c of missingTexture) dropped.push({ name: c.name, reason: 'texture file missing from src/assets/blocks' });
		const usable = candidates.filter((c) => !missingTexture.includes(c));

		const existing: IdMap = existsSync(OUT_IDS)
			? (JSON.parse(readFileSync(OUT_IDS, 'utf8')) as IdMap)
			: { ids: {}, retired: [] };
		const map = assignIds(existing, usable.map((c) => c.name), retire);

		const alphaCache = new Map<string, { transparent: boolean; translucent: boolean }>();
		for (const c of usable) for (const t of textureNames(c.textures)) if (!alphaCache.has(t)) alphaCache.set(t, await alphaOfTexture(t));
		const rows = makeRows(usable, map, (t) => alphaCache.get(t)!);

		const header = [
			'// GENERATED by scripts/gen-catalog.ts — do not edit by hand. Regenerate with `npm run gen-catalog`.',
			`// Source: ${JAR.replace(env.HOME ?? '', '~')}`,
			`// ${rows.filter((r) => !r.retired).length} blocks, ${rows.filter((r) => r.retired).length} retired.`,
			'// Dropped (name: reason):',
			...dropped.sort((a, b) => a.name.localeCompare(b.name)).map((d) => `//   ${d.name}: ${d.reason}`),
			"import type { BlockDef } from './blocks.base.data';",
			'',
			'export const CATALOG_BLOCKS: BlockDef[] = [',
		];
		const body = rows.map((r) => `\t${JSON.stringify(r)},`);
		// Format through the project's prettier config so the committed file is
		// stable across runs and `npm run format` never rewrites it.
		const src = await format([...header, ...body, '];', ''].join('\n'), { filepath: OUT_TS });
		writeFileSync(OUT_TS, src);
		writeFileSync(OUT_IDS, JSON.stringify(map, null, '\t') + '\n');

		const newNames = usable.filter((c) => existing.ids[c.name] === undefined).map((c) => c.name);
		console.log(`kept ${usable.length}, dropped ${dropped.length}, new ${newNames.length}, retired ${map.retired.length}`);
		if (newNames.length) console.log(`new: ${newNames.join(' ')}`);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

main().catch((err) => {
	console.error(err);
	exit(1);
});
```

Add to `package.json` scripts: `"gen-catalog": "tsx scripts/gen-catalog.ts"`.

- [ ] **Step 4: Run the generator:** `npm run gen-catalog`. Expected (the engine reviewer ran these rules over the real jar): `kept 354, dropped ~750, new 354, retired 0`; ids 20–373; the two files written and already prettier-formatted. Skim the dropped list in the file header: `glowstone: duplicate of lamp`, `stone: already a base block`, `waxed_*: excluded by name`, `*_stairs: not a full cube`. Confirm there is no `unresolved` entry and that `cherry_log`, `bamboo_block` are `columnar` (not `six`) and `dispenser`/`furnace`/`jack_o_lantern` are `six` with `nz` = their front texture. If any name is `unresolved` or a log is `six`, stop and report it.

- [ ] **Step 5: Fill the pinned ids.** Open `blocks.catalog.ids.json`, take the first two entries by id (they will be the alphabetically first names, ids 20 and 21) and one from the middle, and put them in the `toMatchObject` of the pin test.

- [ ] **Step 6: Run** `npx vitest run src/data && npx tsc -b && npm run lint && npx prettier --check src/data/blocks.catalog.data.ts` → all PASS. Then `md5sum src/data/blocks.catalog.*`, run the generator a second time, `md5sum` again: identical (ids frozen, output byte-stable).

---

### Task 4: Atlas builder

**Files:**
- Modify: `scripts/build-atlas.ts`

- [ ] **Step 1: Change constants and add the crop.** At the top:

```ts
const ATLAS_SIZE = 1024;
const TILE = 16;
const PADDING = 8;                       // POT cell keeps mip 1–3 inside the tile's own padding
const CELL = TILE + PADDING * 2;         // 32
const TILES_PER_ROW = Math.floor(ATLAS_SIZE / CELL); // 32
```

Extend `TEXTURE_TINTS`:

```ts
	oak_leaves: [0x77, 0xab, 0x2f],
	jungle_leaves: [0x77, 0xab, 0x2f],
	acacia_leaves: [0x77, 0xab, 0x2f],
	dark_oak_leaves: [0x77, 0xab, 0x2f],
	mangrove_leaves: [0x77, 0xab, 0x2f],
	birch_leaves: [0x80, 0xa7, 0x55],
	spruce_leaves: [0x61, 0x99, 0x61],
```

Replace the `sharp(tilePath).resize(...)` line with:

```ts
		// Animated textures are vertical strips of frames; take frame 0 rather than
		// squashing every frame into one tile (which is what water and lava did).
		const meta = await sharp(tilePath).metadata();
		const w = meta.width ?? TILE;
		let img = sharp(tilePath);
		if ((meta.height ?? w) > w) img = img.extract({ left: 0, top: 0, width: w, height: w });
		img = img.resize(TILE, TILE, { kernel: 'nearest' }).ensureAlpha();
```

Also collect texture names with `textureNames()` from `../src/data/catalog-rules.js` instead of the hand-rolled `if/else` chain (same result, one source of truth), and skip rows with `textures === null`.

- [ ] **Step 2: Run** `npm run build-atlas` → `Wrote ~410 tiles to public/atlas.png (1024x1024)`. Then `npx tsc -b && npm run lint`.

- [ ] **Step 3: Eyeball** `public/atlas.png` (Read it as an image): leaves are green, water is a clean blue tile, no squashed stripes.

---

### Task 5: 16-bit block ids (client)

**Files:**
- Modify: `src/engine/world/chunk.ts`, `src/persistence/codec.ts`, `src/persistence/codec.test.ts`, `src/persistence/adapter.ts`, `src/persistence/localStorage.ts`, `src/persistence/localStorage.test.ts`, `src/persistence/cloud.test.ts`, `src/persistence/dual.test.ts`, `src/engine/world/generation.test.ts`

- [ ] **Step 1: Failing tests.** In `src/persistence/codec.test.ts` change every `new Uint8Array(` to `new Uint16Array(` and append inside `describe('codec')`:

```ts
	it('round-trips ids above 255', () => {
		const blocks = new Uint16Array(BLOCKS_PER_CHUNK);
		[200, 255, 256, 353, 65535].forEach((v, i) => { blocks[i] = v; });
		blocks[5000] = 300;
		expect(decodeChunk(encodeChunk(blocks))).toEqual(blocks);
	});

	// Captured from the pre-16-bit codec: 100 × id 5, then id 0, one id 19 at 200, then 0.
	const LEGACY_B64 = 'eJxjTWFIEWZk2F4HAAf9Ahc=';
	const LEGACY_RLE = [5, 100, 0, 100, 19, 1, 0, 183, 126];

	function legacyBlocks(): Uint16Array {
		const b = new Uint16Array(BLOCKS_PER_CHUNK);
		for (let i = 0; i < 100; i++) b[i] = 5;
		b[200] = 19;
		return b;
	}

	it('decodes a chunk written by the old byte-value codec', () => {
		expect(decodeChunk(LEGACY_B64)).toEqual(legacyBlocks());
	});

	it('writes the same RLE byte stream as the old codec for ids below 128', () => {
		const bin = atob(encodeChunk(legacyBlocks()));
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		expect(Array.from(inflate(bytes))).toEqual(LEGACY_RLE);
	});

	// Each guard gets its own message-specific matcher: a bare toThrow() would be
	// satisfied by the pre-existing "wrong length" check and could not tell a
	// removed guard from a present one (the over-long run burns 240 ms before
	// that check fires, which is the DoS the guard exists to prevent).
	const b64 = (rle: number[]) => btoa(String.fromCharCode(...deflate(new Uint8Array(rle))));

	it('rejects a value above 0xffff before storing it', () => {
		// value 70000 = varint [0xf0, 0xa2, 0x04], run 16384 = [0x80, 0x80, 0x01]
		expect(() => decodeChunk(b64([0xf0, 0xa2, 0x04, 0x80, 0x80, 0x01]))).toThrow(/out of range/);
	});

	it('rejects a run that overruns the chunk before filling it', () => {
		// value 1, run 0x0ffffff0
		expect(() => decodeChunk(b64([1, 0xf0, 0xff, 0xff, 0x7f]))).toThrow(/overruns/);
	});

	it('rejects a varint longer than four bytes', () => {
		expect(() => decodeChunk(b64([0xff, 0xff, 0xff, 0xff, 0x7f, 1]))).toThrow(/varint too long/);
	});
```

with `import { deflate, inflate } from 'pako';` at the top.

In `src/persistence/localStorage.test.ts` add (the file's `MemStorage` exposes only the Storage API: `key(i)`, `length`, `getItem`, `setItem`; iterate with those, and use the file's existing save-fixture helper and world id constant in place of `makeSave()` / `ID` below):

```ts
	it('surfaces the decode error, not atob, when a JSON chunk payload is corrupt', async () => {
		const storage = new MemStorage();
		const adapter = new LocalStorageAdapter(storage);
		await adapter.saveWorld(makeSave());
		let key: string | null = null;
		for (let i = 0; i < storage.length; i++) if (storage.key(i)!.includes(':chunk:')) key = storage.key(i);
		const payload = JSON.parse(storage.getItem(key!)!);
		payload.blocks = 'eJxjZQQAAA0ABw==';   // deflate of RLE [5, 1]: valid stream, wrong length
		storage.setItem(key!, JSON.stringify(payload));
		await expect(adapter.loadWorld(ID)).rejects.toThrow(/wrong length/);
	});
```

- [ ] **Step 2: Run** `npx vitest run src/persistence/codec.test.ts src/persistence/localStorage.test.ts` → the high-id round trip FAILS (values wrap to bytes); the legacy-decode and RLE-bytes tests FAIL on `Uint8Array` vs `Uint16Array`; all three rejection tests FAIL with `Decoded chunk has wrong length` instead of the expected message (the current codec throws from its length check, after 240 ms for the overrun case); the localStorage test FAILS with `Invalid character`. If a rejection test is green here, its matcher is too loose.

- [ ] **Step 3: Implement.**

`src/engine/world/chunk.ts`: `readonly blocks: Uint16Array;` and `this.blocks = new Uint16Array(BLOCKS_PER_CHUNK);`.

`src/persistence/adapter.ts`: `blocks: Uint16Array;` in `RawChunk`.

`src/persistence/codec.ts`:

```ts
export function encodeChunk(blocks: Uint16Array): string {
	if (blocks.length !== BLOCKS_PER_CHUNK) throw new Error('Unexpected chunk length');
	const rle: number[] = [];
	let i = 0;
	while (i < blocks.length) {
		const val = blocks[i];
		let run = 1;
		while (i + run < blocks.length && blocks[i + run] === val && run < 0x0fffffff) run++;
		// Value is a varint: ids < 128 stay one byte, identical to the old byte codec.
		writeVarInt(rle, val);
		writeVarInt(rle, run);
		i += run;
	}
	const deflated = deflate(new Uint8Array(rle));
	return btoa(String.fromCharCode(...deflated));
}

export function decodeChunk(encoded: string): Uint16Array {
	const bin = atob(encoded);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	const rle = inflate(bytes);
	const out = new Uint16Array(BLOCKS_PER_CHUNK);
	let oi = 0,
		ri = 0;
	while (ri < rle.length) {
		const v = readVarInt(rle, ri);
		ri = v.next;
		// Bound the value BEFORE the typed-array store: after it, 70000 is 4464.
		if (v.value > 0xffff) throw new Error(`Block id ${v.value} out of range`);
		const r = readVarInt(rle, ri);
		ri = r.next;
		if (oi + r.value > BLOCKS_PER_CHUNK) throw new Error('Decoded chunk overruns its length');
		for (let k = 0; k < r.value; k++) out[oi++] = v.value;
	}
	if (oi !== BLOCKS_PER_CHUNK) throw new Error(`Decoded chunk has wrong length: ${oi}`);
	return out;
}
```

and in `readVarInt`, inside the loop **before reading each byte**: `if (shift >= 28) throw new Error('varint too long');` (four bytes carry 28 bits, enough for the 0x0fffffff run cap; a fifth byte would shift into the sign bit and come back negative, which the `> 0xffff` bound would not catch).

`src/persistence/localStorage.ts` `parseChunkPayload`:

```ts
function parseChunkPayload(cx: number, cz: number, data: string): RawChunk {
	let parsed: ChunkPayload | null = null;
	try {
		parsed = JSON.parse(data) as ChunkPayload;
	} catch {
		parsed = null;
	}
	// Pre-Task-6 saves stored the bare base64 blocks blob with no JSON envelope.
	// Only that case falls back; a decode failure inside a JSON payload must
	// surface as itself, not as atob choking on the envelope.
	if (!parsed) return { cx, cz, blocks: decodeChunk(data) };
	const blocks = decodeChunk(parsed.blocks);
	const fluidMeta = parsed.fluidMeta ? decodeFluidMeta(parsed.fluidMeta) : undefined;
	return { cx, cz, blocks, fluidMeta };
}
```

Any v1 legacy read path that produces a `Uint8Array` (grep `decodeChunk(` and `Uint8Array` in `localStorage.ts`) now returns the `Uint16Array` from `decodeChunk` directly; if a v1 path builds bytes itself, wrap with `Uint16Array.from(bytes)`.

Fixture churn: change `new Uint8Array(BLOCKS_PER_CHUNK)` to `new Uint16Array(BLOCKS_PER_CHUNK)` in `localStorage.test.ts` (6 sites), `dual.test.ts` (5 sites), `cloud.test.ts:9`; change `cloud.test.ts:144` to `toBeInstanceOf(Uint16Array)`; change `generation.test.ts` `hashBytes(bytes: Uint8Array)` to `hashBytes(bytes: ArrayLike<number>)`.

- [ ] **Step 4: Run** `npx vitest run && npx tsc -b && npm run lint` → all green. `src/main.ts:110` (`c.blocks.set(rc.blocks)`) needs no change.

---

### Task 6: 16-bit block ids (API)

**Files:**
- Modify: `api/src/codec.ts`, `api/src/codec.parity.test.ts`, `api/src/handlers.ts`, `api/src/handlers.test.ts` (the `/health` expectation at ~line 189), `api/src/testFixtures.ts`, `deploy.sh`

**Checklist (nothing type-checks `api/` tests, so tick each by hand):**
- [ ] `api/src/codec.ts` `encodeChunk(blocks: Uint16Array)`, `decodeChunk(): Uint16Array`, varint value, the three bounds, `shift >= 28` guard — a verbatim copy of the client codec's chunk functions (fluid functions unchanged).
- [ ] `api/src/testFixtures.ts:7` `new Uint16Array(BLOCKS_PER_CHUNK)`.
- [ ] `api/src/codec.parity.test.ts`: both `new Uint8Array(` → `new Uint16Array(`; add

```ts
	it('server decodes ids above 255 from the client', () => {
		const blocks = new Uint16Array(BLOCKS_PER_CHUNK);
		[200, 255, 256, 353, 65535].forEach((v, i) => { blocks[i] = v; });
		expect(decodeChunk(clientEncode(blocks))).toEqual(blocks);
	});

	it('server decodes a legacy byte-codec chunk identically', () => {
		const b = new Uint16Array(BLOCKS_PER_CHUNK);
		for (let i = 0; i < 100; i++) b[i] = 5;
		b[200] = 19;
		expect(decodeChunk('eJxjTWFIEWZk2F4HAAf9Ahc=')).toEqual(b);
	});
```

- [ ] `api/src/handlers.ts`: `let blocks: Uint16Array;` in `validateChunks`; `/health` → `res.json({ ok: true, codec: 2 });`; the handlers test expectation → `.expect(200, { ok: true, codec: 2 })`.
- [ ] `deploy.sh` `verify()`: replace the `/health` block with

```bash
		local body
		body=$(curl -s "${uri}/health" || true)
		if echo "${body}" | grep -q '"codec":2'; then
			echo "  ok: ${uri}/health -> codec 2"
		else
			echo "  FAIL: ${uri}/health -> '${body}' (expected {\"ok\":true,\"codec\":2}; old codec still deployed?)"
			failures=$((failures + 1))
		fi
```

- [ ] **Run** `cd api && npx vitest run` (or the root `npx vitest run`, which includes `api/src`) → all PASS, including the two new parity cases which FAIL before the server codec is updated (run them first to see red). `npx tsc -p api` clean.

---

### Task 7: Translucent mesh pass

**Files:**
- Modify: `src/engine/world/mesher.ts`, `src/engine/world/mesher.test.ts`, `src/engine/render/renderer.ts`

**Interfaces (produces):** `ChunkMeshResult.translucent: ChunkMesh | null`; `Renderer.translucentMaterial`.

- [ ] **Step 1: Failing tests** — append to `src/engine/world/mesher.test.ts`:

```ts
describe('translucent pass', () => {
	const glass = BLOCK_BY_NAME['blue_stained_glass'].id;
	it('emits a translucent block in its own bucket, not the opaque one', () => {
		const c = new Chunk(0, 0);
		c.set(5, 5, 5, glass);
		const r = meshChunk(c, {}, uvStub);
		expect(r.opaque.indices.length).toBe(0);
		expect(r.translucent!.indices.length).toBe(36);
	});
	it('an opaque neighbour still emits its face toward stained glass', () => {
		const c = new Chunk(0, 0);
		c.set(5, 5, 5, glass);
		c.set(6, 5, 5, stone);
		const r = meshChunk(c, {}, uvStub);
		expect(r.opaque.indices.length).toBe(36);      // all six stone faces (glass is see-through)
		expect(r.translucent!.indices.length).toBe(30); // glass hides its face against stone
	});
	it('two adjacent identical stained glass blocks share no face', () => {
		const c = new Chunk(0, 0);
		c.set(5, 5, 5, glass);
		c.set(6, 5, 5, glass);
		const r = meshChunk(c, {}, uvStub);
		expect(r.translucent!.indices.length).toBe(60);
	});
});
```

- [ ] **Step 2: Run** `npx vitest run src/engine/world/mesher.test.ts` → FAIL (`translucent` undefined; glass lands in opaque).

- [ ] **Step 3: Implement.** In `mesher.ts`: add `translucent: ChunkMesh | null;` to `ChunkMeshResult`; import `isTranslucent`; rename `buildOpaqueMesh` to `buildSolidMesh(chunk, neighbors, uvFor, select: (id: BlockId) => boolean)` and change its filter line to `if (!isSolid(id) || !select(id)) continue;`; then

```ts
export function meshChunk(chunk: Chunk, neighbors: Neighbors, uvFor: UvFn): ChunkMeshResult {
	const translucent = buildSolidMesh(chunk, neighbors, uvFor, (id) => isTranslucent(id));
	return {
		opaque: buildSolidMesh(chunk, neighbors, uvFor, (id) => !isTranslucent(id)),
		liquid: buildLiquidMesh(chunk, neighbors, uvFor),
		translucent: translucent.indices.length > 0 ? translucent : null,
	};
}
```

`shouldEmitFace` is unchanged (glass vs stone: stone is not transparent → no glass face; stone vs glass: glass is transparent and different → stone face).

In `renderer.ts`: add `private translucentMeshes = new Map<string, THREE.Mesh>();` and `readonly translucentMaterial: THREE.Material;`, construct after `liquidMaterial`:

```ts
		// Full-cube translucent blocks (stained glass, ice). FrontSide + depthWrite so a
		// cube's inner faces are not drawn through its outer ones (the liquid material
		// is DoubleSide/no-depth-write and double-blends a closed cube).
		this.translucentMaterial = new THREE.MeshBasicMaterial({
			map: atlas.texture,
			vertexColors: true,
			transparent: true,
			depthWrite: true,
			side: THREE.FrontSide,
			alphaTest: 0.01,
		});
```

and in `mountChunkMesh` add a third block identical to the liquid one but reading `meshResult.translucent`, using `this.translucentMeshes` and `this.translucentMaterial`. Extract the repeated geometry build into a private `buildGeometry(mesh: ChunkMesh): THREE.BufferGeometry` helper so the three blocks are three calls. Set `m.renderOrder = 1` on every **liquid** mesh (three sorts transparent meshes by chunk centroid, so without this a water mesh from one chunk can draw before a glass mesh from another; glass writes depth, so drawing it first is correct).

- [ ] **Step 4: Run** `npx vitest run src/engine && npx tsc -b && npm run lint` → green.

---

### Task 8: `resolveHotbar`

**Files:**
- Create: `src/game/hotbar.ts`, `src/game/hotbar.test.ts`

**Interfaces (produces):** `resolveHotbar(saved: BlockId[] | undefined, savedSelected: number, blocks: BlockDef[]): { hotbar: BlockId[]; selected: number }`.

- [ ] **Step 1: Failing tests:**

```ts
import { describe, it, expect } from 'vitest';
import { resolveHotbar } from './hotbar';
import { AIR, BLOCKS, DEFAULT_HOTBAR, HOTBAR_SIZE } from '../data/blocks.data';

describe('resolveHotbar', () => {
	it('gives the default hotbar when nothing is saved', () => {
		const r = resolveHotbar(undefined, 0, BLOCKS);
		expect(r).toEqual({ hotbar: DEFAULT_HOTBAR, selected: 0 });
		expect(r.hotbar).toHaveLength(HOTBAR_SIZE);
		expect(r.hotbar).not.toBe(DEFAULT_HOTBAR); // a copy, never the shared constant
	});
	it('replaces a legacy pool with the default and keeps the selected BLOCK, not the index', () => {
		// Deliberately not [1..19]: on that pool the block lookup is an identity map
		// and a plain index clamp would pass. Here index 0 holds white wool (id 9),
		// which sits at index 8 of the default bar.
		const pool = [9, 8, 7, 6, 5, 4, 3, 2, 1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
		expect(resolveHotbar(pool, 0, BLOCKS)).toEqual({ hotbar: DEFAULT_HOTBAR, selected: 8 });
		expect(resolveHotbar(pool, 18, BLOCKS).selected).toBe(0); // obsidian: not in the default bar
	});
	it('keeps a 9-entry hotbar, blanking ids that are not live blocks', () => {
		const saved = [1, 2, 3, 99999, AIR, 6, 7, 8, 9];
		const r = resolveHotbar(saved, 4, BLOCKS);
		expect(r.hotbar).toEqual([1, 2, 3, AIR, AIR, 6, 7, 8, 9]);
		expect(r.selected).toBe(4);
		expect(r.hotbar).toHaveLength(HOTBAR_SIZE);
	});
	it('clamps an out-of-range selection to 0', () => {
		expect(resolveHotbar(DEFAULT_HOTBAR, 9, BLOCKS).selected).toBe(0);
		expect(resolveHotbar(DEFAULT_HOTBAR, -1, BLOCKS).selected).toBe(0);
		expect(resolveHotbar(DEFAULT_HOTBAR, 1.5, BLOCKS).selected).toBe(0);
	});
});
```

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement `src/game/hotbar.ts`:**

```ts
import { AIR, DEFAULT_HOTBAR, HOTBAR_SIZE, type BlockDef, type BlockId } from '../data/blocks.data';

/**
 * Turns whatever a save holds into a 9-slot hotbar. Saves written before the
 * inventory hold the whole block pool (19 entries); those get the default bar.
 */
export function resolveHotbar(
	saved: BlockId[] | undefined,
	savedSelected: number,
	blocks: BlockDef[],
): { hotbar: BlockId[]; selected: number } {
	const live = (id: BlockId) => id !== AIR && !!blocks[id] && !blocks[id].retired;
	if (!saved || saved.length !== HOTBAR_SIZE) {
		const hotbar = [...DEFAULT_HOTBAR];
		const prev = saved?.[savedSelected];
		const idx = prev === undefined ? -1 : hotbar.indexOf(prev);
		return { hotbar, selected: idx >= 0 ? idx : 0 };
	}
	const hotbar = saved.map((id) => (live(id) ? id : AIR));
	const selected =
		Number.isInteger(savedSelected) && savedSelected >= 0 && savedSelected < HOTBAR_SIZE
			? savedSelected
			: 0;
	return { hotbar, selected };
}
```

- [ ] **Step 4: Run** `npx vitest run src/game/hotbar.test.ts && npx tsc -b` → PASS.

---

### Task 9: Inventory overlay

**Files:**
- Create: `src/ui/inventory.ts`
- Modify: `src/ui/ui.css` (append)

**Interfaces (produces):** the `Inventory` class exactly as in the spec (`onPick`, `onSelectSlot`, `onClose`, `open`, `close`, `isOpen`, `setHotbar(ids, selected, flashSlot?)`).

- [ ] **Step 1: Create `src/ui/inventory.ts`:**

```ts
import { AIR, GROUP_ORDER, type BlockDef, type BlockId } from '../data/blocks.data';
import type { LoadedAtlas } from '../engine/render/atlas';

const TILE_PX = 48;

/**
 * Full-screen block picker. Click a tile → onPick(id) for the selected slot;
 * the strip at the bottom mirrors the HUD hotbar. Built once; scroll position
 * survives open/close so "back to the pink ones" is fast.
 */
export class Inventory {
	private root: HTMLDivElement;
	private grid: HTMLDivElement;
	private nameEl: HTMLDivElement;
	private strip: HTMLDivElement;
	private slotEls: HTMLDivElement[] = [];
	private labels = new Map<BlockId, string>();
	onPick: ((id: BlockId) => void) | null = null;
	onSelectSlot: ((slot: number) => void) | null = null;
	onClose: (() => void) | null = null;

	constructor(container: HTMLElement, private atlas: LoadedAtlas, blocks: BlockDef[]) {
		this.root = document.createElement('div');
		this.root.id = 'inventory-root';
		this.root.classList.add('hidden');

		const card = document.createElement('div');
		card.className = 'inventory-card';

		for (const b of blocks) this.labels.set(b.id, b.label);
		this.grid = document.createElement('div');
		this.grid.className = 'inventory-grid';
		for (const group of GROUP_ORDER) {
			const rows = blocks.filter((b) => b.group === group && b.id !== AIR && !b.retired);
			// BASICS keeps hand order (grass, dirt, stone…); generated groups sort by
			// label so a regeneration that appends ids does not land new blocks at the end.
			if (group !== 'basics') rows.sort((a, b) => a.label.localeCompare(b.label));
			if (rows.length === 0) continue;
			const h = document.createElement('div');
			h.className = 'inventory-group';
			h.textContent = group.toUpperCase();
			this.grid.appendChild(h);
			for (const b of rows) {
				const tile = document.createElement('button');
				tile.className = 'inventory-tile';
				tile.title = b.label;
				tile.tabIndex = -1; // a focused tile would re-fire on Space (his jump reflex)
				this.paintTile(tile, b.id);
				tile.addEventListener('mouseenter', () => { this.nameEl.textContent = b.label; });
				tile.addEventListener('click', (e) => {
					e.stopPropagation();
					tile.blur();
					this.onPick?.(b.id);
				});
				this.grid.appendChild(tile);
			}
		}
		card.appendChild(this.grid);

		this.nameEl = document.createElement('div');
		this.nameEl.className = 'inventory-name';
		this.nameEl.textContent = ' ';
		card.appendChild(this.nameEl);

		this.strip = document.createElement('div');
		this.strip.className = 'inventory-strip';
		card.appendChild(this.strip);

		this.root.appendChild(card);
		this.root.addEventListener('click', (e) => e.stopPropagation());
		window.addEventListener('keydown', (e) => {
			if (!this.isOpen || e.code !== 'Escape') return;
			e.preventDefault();
			this.onClose?.();
		});
		container.appendChild(this.root);
	}

	private paintTile(el: HTMLElement, id: BlockId) {
		const rect = id === AIR ? null : this.atlas.tileRect(id, 'nz');
		if (!rect) {
			el.style.backgroundImage = '';
			return;
		}
		const scale = TILE_PX / this.atlas.tileSize;
		el.style.backgroundImage = `url(${this.atlas.pngUrl})`;
		el.style.backgroundSize = `${this.atlas.size * scale}px ${this.atlas.size * scale}px`;
		el.style.backgroundPosition = `-${rect.u * scale}px -${rect.v * scale}px`;
	}

	get isOpen(): boolean {
		return !this.root.classList.contains('hidden');
	}

	open(): void {
		this.root.classList.remove('hidden');
	}

	close(): void {
		this.root.classList.add('hidden');
	}

	/** Mirrors Hud.setHotbar; `flashSlot` pulses that slot (every pick, even a repeat). */
	setHotbar(ids: BlockId[], selected: number, flashSlot?: number): void {
		while (this.slotEls.length < ids.length) {
			const i = this.slotEls.length;
			const el = document.createElement('div');
			el.className = 'hotbar-slot';
			el.addEventListener('click', (e) => {
				e.stopPropagation();
				this.onSelectSlot?.(i);
			});
			this.strip.appendChild(el);
			this.slotEls.push(el);
		}
		for (let i = 0; i < ids.length; i++) {
			const el = this.slotEls[i];
			el.classList.toggle('selected', i === selected);
			el.title = ids[i] === AIR ? '' : (this.labels.get(ids[i]) ?? '');
			this.paintTile(el, ids[i]);
			if (i === flashSlot) {
				el.classList.remove('flash');
				void el.offsetWidth; // restart the animation
				el.classList.add('flash');
			}
		}
	}
}
```

- [ ] **Step 2: Append to `src/ui/ui.css`:**

```css
/* Block inventory (I). Above the HUD, below the colour picker (20) and the play-time freeze (30). */
#inventory-root {
	position: fixed;
	inset: 0;
	background: rgba(0, 0, 0, 0.7);
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 15;
}
#inventory-root.hidden {
	display: none;
}
.inventory-card {
	background: #2a2a2a;
	border-radius: 8px;
	padding: 12px;
	max-width: 92vw;
	box-shadow: 0 4px 24px rgba(0, 0, 0, 0.6);
	display: flex;
	flex-direction: column;
	gap: 8px;
}
.inventory-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, 48px);
	gap: 4px;
	max-height: 72vh;
	overflow-y: auto;
	width: min(88vw, 1300px);
}
.inventory-group {
	grid-column: 1 / -1;
	font: bold 18px system-ui, sans-serif;
	letter-spacing: 0.06em;
	color: #fff;
	margin: 10px 0 2px;
}
.inventory-tile {
	width: 48px;
	height: 48px;
	padding: 0;
	background-color: #1b1b1b;
	background-repeat: no-repeat;
	image-rendering: pixelated;
	border: 2px solid rgba(255, 255, 255, 0.15);
	border-radius: 4px;
	cursor: pointer;
}
.inventory-tile:hover {
	border-color: #fff;
}
.inventory-name {
	min-height: 20px;
	color: #fff;
	font: 16px system-ui, sans-serif;
	text-align: center;
}
.inventory-strip {
	display: flex;
	gap: 4px;
	justify-content: center;
	background: rgba(0, 0, 0, 0.35);
	padding: 4px;
	border-radius: 6px;
}
.inventory-strip .hotbar-slot {
	cursor: pointer;
}
.hotbar-slot.flash {
	animation: slot-flash 0.3s ease-out;
}
/* Scale + brightness, not box-shadow: the flashed slot is always the selected one,
   whose own box-shadow would hide a shadow-based pulse. */
@keyframes slot-flash {
	0% { transform: scale(1.25); filter: brightness(1.8); }
	100% { transform: scale(1); filter: brightness(1); }
}
```

- [ ] **Step 3:** `npx tsc -b && npm run lint` clean.

---

### Task 10: Input gate and wiring in `main.ts`

**Files:**
- Create: `src/game/input-gate.ts`, `src/game/input-gate.test.ts`
- Modify: `src/main.ts`

- [ ] **Step 0a: Failing gate tests** — `src/game/input-gate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { shouldHandleKey } from './input-gate';

const free = { frozen: false, inventoryOpen: false, pickerOpen: false };

describe('shouldHandleKey', () => {
	it('processes every keyup in every state so held keys never stick', () => {
		for (const state of [free, { ...free, frozen: true }, { ...free, inventoryOpen: true }, { ...free, pickerOpen: true }])
			for (const a of ['forward', 'jump', 'inventory', 'slot3', 'ignite'] as const)
				expect(shouldHandleKey(false, a, state)).toBe(true);
	});
	it('drops every keydown while frozen', () => {
		for (const a of ['forward', 'inventory', 'slot1', 'toggleFly'] as const)
			expect(shouldHandleKey(true, a, { ...free, frozen: true })).toBe(false);
	});
	it('allows only inventory and slot keys while the inventory is open', () => {
		const s = { ...free, inventoryOpen: true };
		expect(shouldHandleKey(true, 'inventory', s)).toBe(true);
		expect(shouldHandleKey(true, 'slot7', s)).toBe(true);
		for (const a of ['forward', 'jump', 'ignite', 'toggleFly', 'pickLightColor'] as const)
			expect(shouldHandleKey(true, a, s)).toBe(false);
	});
	it('ignores the inventory key while the colour picker is open, nothing else', () => {
		const s = { ...free, pickerOpen: true };
		expect(shouldHandleKey(true, 'inventory', s)).toBe(false);
		expect(shouldHandleKey(true, 'forward', s)).toBe(true);
	});
	it('handles everything when free', () => {
		for (const a of ['forward', 'inventory', 'slot1', 'ignite'] as const) expect(shouldHandleKey(true, a, free)).toBe(true);
	});
});
```

- [ ] **Step 0b: Run** → FAIL (module missing). **Implement `src/game/input-gate.ts`:**

```ts
import type { Action } from '../data/keybindings.data';

export type GateState = { frozen: boolean; inventoryOpen: boolean; pickerOpen: boolean };

/**
 * Which key events main.ts acts on. Keyup is always processed so the held-key
 * flags stay truthful; keydown is gated by which overlay owns the screen.
 */
export function shouldHandleKey(down: boolean, action: Action, s: GateState): boolean {
	if (!down) return true;
	if (s.frozen) return false;
	if (s.inventoryOpen) return action === 'inventory' || action.startsWith('slot');
	if (s.pickerOpen && action === 'inventory') return false;
	return true;
}
```

Run → PASS.

**Interfaces (consumes):** `resolveHotbar` (8), `Inventory` (9), `isTranslucent` not needed here, `AIR`, `HOTBAR_SIZE` (1), `colorPicker.isOpen` (exists), everything from the play-time block.

- [ ] **Step 1: Imports.** Add `import { Inventory } from './ui/inventory';`, `import { resolveHotbar } from './game/hotbar';`, `import { shouldHandleKey } from './game/input-gate';`, and `AIR` to the `blocks.data` import. Remove `loadOptions`'s `opts.kidMode` use (Task 1 did).

- [ ] **Step 2: Hotbar resolution.** Replace the block from `// Hotbar is always derived …` through `hud.setHotbar(player.hotbar, player.selected);` with:

```ts
		// Nine slots, saved per world. Saves from before the inventory hold the
		// whole block pool and get the default bar (see resolveHotbar).
		const opts = loadOptions();
		const resolved = resolveHotbar(savedHotbar, savedSelected, BLOCKS);
		player.hotbar = resolved.hotbar;
		player.selected = resolved.selected;
		hud.setHotbar(player.hotbar, player.selected);
```

and, where the save is read, replace `let savedSelectedBlockId: BlockId | null = null;` with `let savedHotbar: BlockId[] | undefined; let savedSelected = 0;`, and `savedSelectedBlockId = save.player.hotbar[save.player.selected] ?? null;` with `savedHotbar = save.player.hotbar; savedSelected = save.player.selected;`.

- [ ] **Step 3: Pause ownership and the inventory**, placed right after the `keys` object is created (before `keyToAction`):

```ts
		// One `paused` with two owners. `loop` is declared below; these closures
		// run only after it exists (same pattern as the ignite handler).
		let frozen = false;
		let inventoryOpen = false;
		const updatePaused = () => {
			loop.paused = frozen || inventoryOpen;
		};
		const resetKeys = () => {
			keys.forward = keys.back = keys.left = keys.right = keys.jump = false;
		};
		const inventory = new Inventory(app, atlas, BLOCKS);
		const syncHotbar = () => {
			hud.setHotbar(player.hotbar, player.selected);
			inventory.setHotbar(player.hotbar, player.selected);
		};
		const openInventory = () => {
			if (inventoryOpen || frozen || colorPicker.isOpen) return;
			inventoryOpen = true;
			updatePaused();
			loop.setLeftMouseDown(false);
			hud.setMiningProgress(0);
			if (document.pointerLockElement) document.exitPointerLock();
			syncHotbar();
			inventory.open();
		};
		const closeInventory = () => {
			if (!inventoryOpen) return;
			inventory.close();
			inventoryOpen = false;
			updatePaused();
			resetKeys();
		};
		inventory.onClose = closeInventory;
		inventory.onPick = (id) => {
			player.hotbar[player.selected] = id;
			hud.setHotbar(player.hotbar, player.selected);
			inventory.setHotbar(player.hotbar, player.selected, player.selected);
			autosave.markDirty();
		};
		inventory.onSelectSlot = (slot) => {
			player.selected = slot;
			syncHotbar();
		};
```

`syncHotbar()` must also replace the two existing `hud.setHotbar(player.hotbar, player.selected);` calls in the slot-key case and the Tab handler.

- [ ] **Step 4: Input gating.** Rewrite the top of `onKey` and add the inventory case:

```ts
		const onKey = (down: boolean) => (e: KeyboardEvent) => {
			const a = keyToAction[e.code];
			if (!a) return;
			if (!shouldHandleKey(down, a, { frozen, inventoryOpen, pickerOpen: colorPicker.isOpen })) return;
			switch (a) {
				…existing cases…
				case 'inventory':
					if (down && !e.repeat) {
						if (inventoryOpen) closeInventory();
						else openInventory();
					}
					break;
```

The old `if (down && loop.paused) return;` line is removed. The Tab listener's `if (loop.paused) return;` becomes `if (frozen) return;`. The `mousedown` listener keeps `if (loop.paused) return;` and additionally, in the `e.button === 2` branch, after `const id = player.hotbar[player.selected];` add `if (id === undefined || id === AIR) return;` (replacing the existing `if (id === undefined) return;`).

- [ ] **Step 5: Play-time callbacks.** Inside the `if (opts.playLimitMin !== null)` block delete the local `resetKeys` (now hoisted) and change:

```ts
				freeze: () => {
					closeInventory();
					loop.setLeftMouseDown(false);
					frozen = true;
					updatePaused();
					resetKeys();
					hud.setMiningProgress(0);
					if (document.pointerLockElement) document.exitPointerLock();
					void autosave.flush();
				},
				resume: () => {
					resetKeys();
					frozen = false;
					updatePaused();
					const p = renderer.gl.domElement.requestPointerLock() as unknown;
					if (p instanceof Promise) p.catch(() => {});
				},
```

- [ ] **Step 6: Run** `npx tsc -b && npm run lint && npx vitest run` → green.

---

### Task 11: Docs

**Files:**
- Create: `docs/inventory.md`
- Modify: `docs/lighting.md` (leaves note), `README.md`, `docs/specs.md`, `CLAUDE.md`

- [ ] **Step 1: `docs/inventory.md`:**

```markdown
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
```

- [ ] **Step 2: `docs/lighting.md`** — add a short section "Leaves and other cutouts" stating: cutout blocks keep `lightFilter: 0` because any filter ≥ 1 attenuates by `max(2, filter)` per block and disables the straight-down skylight case, which makes the ground under a tree cave-dark; tree shadows would need `shadows.ts` to treat cutouts as casters.

- [ ] **Step 3: `README.md`** — line 9's intro (`… with a "kid mode" filter that hides …`) → `… about 350 solid-cube blocks from Minecraft 1.21.6, picked from an I-key inventory (whole cubes only — no stairs, slabs, doors or flowers)`; in Features: replace the "Hotbar as inventory" bullet with `- **Block inventory** (I): every solid-cube block from Minecraft 1.21.6 (~350), grouped; click to fill the selected hotbar slot. Whole cubes only — no stairs, slabs, doors, flowers. 9-slot hotbar saved per world. See [docs/inventory.md](docs/inventory.md).`; delete the "Kid mode" bullet; in "Textures" add leaves to the tinted list; in "Project layout" add `scripts/gen-catalog.ts` and the three catalog files; in "How to play" add `- **I** — open / close the block inventory.`; in Extensibility change "Adding a block is one row in `src/data/blocks.data.ts`" to "…one row in `src/data/blocks.base.data.ts` (hand rows) or a regeneration via `npm run gen-catalog` (Minecraft blocks)"; update the Tests line count from `npx vitest run`.

- [ ] **Step 4: `CLAUDE.md`** — replace the line `Keep the "basic blocks" vs "all blocks" kid-mode toggle as a filter over the same catalog, not a parallel set.` with `The block catalog is a hand-written base (\`blocks.base.data.ts\`, ids 0–19 frozen) plus a generated, committed catalog (\`npm run gen-catalog\`) with frozen ids; never renumber.` `docs/specs.md`: in §7 Phase 1, change "**Hotbar IS the inventory** in Phase 1" to "Hotbar is filled from the I-key inventory (added 2026-09)"; also remove the kid-mode mentions at lines 146 (`options.ts # keybinding + kid-mode UI`), 171 (`Options (kid-mode toggle, keybindings)`) and 245 (`Options: kid-mode toggle persists across reloads`).

- [ ] **Step 5:** `npm run lint` (prettier on md is not enforced; just confirm nothing else changed).

---

### Task 12: Deploy the API, then verify in the browser

**Files:** none.

- [ ] **Step 1:** `./deploy.sh` then `./deploy.sh --verify` → `ok: … /health -> codec 2`, `All checks passed`. (Pre-authorised. Do NOT deploy the site.)
- [ ] **Step 2:** `npm run dev` in the background; open `http://localhost:5173` with the browser tool, foreground the tab.
- [ ] **Step 3: Inventory.** Pick or create a world. Press I: `#inventory-root` visible, first header text `BASICS`, `document.querySelectorAll('.inventory-tile').length > 300`, `document.pointerLockElement === null`. Screenshot the `Jack O Lantern` and `Furnace` tiles: the face is visible; and assert the tile's `background-position` equals the scaled `atlas.tileRect(id,'nz')` (compute `-${u*3}px -${v*3}px` from `/atlas.json` for a 48 px tile on a 16 px texture). Click `Oak Planks`: the HUD's selected slot background changed; within 100 ms `getComputedStyle(stripSlot).animationName === 'slot-flash'`; click the same tile again after 400 ms: the animation restarts. Press `Digit5`, click `Blue Stained Glass`: slot 5 filled. **Stuck key, both ways:** hold W, press I, release W while open, press I, wait 1 s → position unchanged (two screenshots identical); then hold W, press I, press I, keep holding 1 s → the player moves, release → stops. Press Escape: root hidden. Press I: visible again with the same `scrollTop` after scrolling first. Reload, continue: HUD shows the same two picks.
- [ ] **Step 4: Blocks.** Place (right-click) with slot 5 (blue stained glass) twice stacked, then Lamp, Oak Leaves, Oak Log, Cherry Log, Jack O Lantern, Cyan Glazed Terracotta, Red Concrete from the inventory. Screenshot: glass is see-through and single-shaded where stacked, leaves green and see-through, both logs have bark sides and rings on top, jack o'lantern shows a face and lights the area, glazed terracotta shows a pattern. Reload: identical screenshot. `#save-status` is not red (with `.env.local` pointing at the redeployed API the cloud leg must succeed; without it only the local leg is checked, say which).
- [ ] **Step 5: Legacy save, deterministically.** Build one by hand: in the console, `localStorage.setItem` a v2 meta record and one chunk record for a fresh uuid, copying the key names and JSON shape from an existing world in this browser, with `player.hotbar` = the 19-entry pool `[1..19]`, `selected: 2`, and a chunk whose `blocks` is the legacy literal `eJxjTWFIEWZk2F4HAAf9Ahc=` (100 × id 5 = sand, then one id 19 = obsidian). Continue that world: hotbar shows the 9 defaults with slot 3 (stone) selected; the sand run and the obsidian block are present in the world. **AIR guard:** write a second world whose hotbar is `[1,2,3,0,5,6,7,8,9]`, `selected: 3`; continue; right-click a block: nothing is placed, no console error.
- [ ] **Step 6: Overlays.** Press C (colour picker) then I: `#inventory-root` stays hidden. Escape, then I: opens. Set a play limit with `playedMs` 30 s short of the limit, open the inventory, wait: on freeze the inventory is hidden and `#playtime-freeze` shows.
- [ ] **Step 7:** Report each step PASS/FAIL with the observed values and screenshot paths under the scratchpad. Stop the dev server.
