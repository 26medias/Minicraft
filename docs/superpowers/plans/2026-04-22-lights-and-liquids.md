# Voxel Light Propagation + Liquids Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace sun shadow mapping with voxel light propagation (skylight + RGB block light), and add water + lava blocks with simple discrete-step flow, swim mode, and flatter terrain.

**Architecture:** Each chunk gains a `Uint16Array` lightmap with 4×4-bit packed channels (sky + blockR/G/B), flood-filled by BFS and consumed as a per-vertex color attribute on the chunk mesh. `MeshLambertMaterial` + `DirectionalLight` + shadow map are deleted; illumination is baked into vertex colors. Water and lava are non-solid blocks in the catalog; a `LiquidScheduler` ticks at 2 Hz applying a fall-or-spread-sideways rule. World-gen produces flatter terrain and fills below-sea-level air with water.

**Tech Stack:** TypeScript (strict), Three.js, Vitest, existing Vite build.

**Spec:** `docs/superpowers/specs/2026-04-22-lights-and-liquids-design.md`
**Branch:** `feat-lights-and-liquids` (already created)

---

## File Map

**New files:**
- `src/engine/world/lighting.ts` — `fillChunkLights`, `updateLightsForBlockChange`, BFS helpers, AO helper.
- `src/engine/world/lighting.test.ts` — unit tests for the lighting module.
- `src/game/liquid-scheduler.ts` — `LiquidScheduler` class; tick accumulator; fall/spread rules.
- `src/game/liquid-scheduler.test.ts` — unit tests for flow rules.

**Modified files:**
- `src/data/blocks.data.ts` — extend `BlockDef` with `lightLevel`, `lightFilter`, `liquid`; add `water` (id 17), `lava` (id 18); add `isLiquid`, `WATER`, `LAVA` exports.
- `src/data/blocks.data.test.ts` — new cases for the new fields.
- `src/data/keybindings.data.ts` — remove `flyUp`, `flyDown`.
- `src/engine/world/chunk.ts` — add `lights: Uint16Array`; packed getters/setters; `liquidFrontier: Set<number>`.
- `src/engine/world/chunk.test.ts` — tests for lightmap helpers + frontier.
- `src/engine/world/generation.ts` — flatter constants; sea-level water fill; shoreline sand.
- `src/engine/world/generation.test.ts` — new cases.
- `src/engine/world/mesher.ts` — per-vertex colors via lightmap; AO; split return into `{opaque, liquid}`; emit liquid face pass.
- `src/engine/world/mesher.test.ts` — new cases for colors attribute, AO, liquid split.
- `src/engine/world/world.ts` — call `fillChunkLights` in `ensureChunk`; add `markLiquidFrontier`.
- `src/engine/render/renderer.ts` — swap to `MeshBasicMaterial` + vertexColors; remove sun/ambient/shadow; add liquid material; mount both meshes.
- `src/game/player.ts` — `swimming` state; 3D cursor-directed movement in fly/swim; remove `flyUp`/`flyDown` from `Keys`.
- `src/game/player.test.ts` — update existing fly tests (flyUp/flyDown removed); add swim and cursor-direction tests.
- `src/game/loop.ts` — instantiate `LiquidScheduler`; tick it; call `updateLightsForBlockChange` on block edits; enqueue returned chunks for re-mesh.
- `src/main.ts` — remove `flyUp`/`flyDown` cases from key dispatcher; delete `sun`-related calls.

---

## Conventions

- **Indentation:** tabs, rendered 4-wide.
- **Commit messages:** conventional-commits style (`feat:`, `fix:`, `refactor:`, `test:`). Always include the `Co-Authored-By` trailer:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Run tests:** `npm test` (Vitest one-shot). Lint: `npm run lint`.
- **After every commit:** `npm test` must pass.
- **If a step says "run and expect FAIL"**, the test must actually fail at that point (TDD). Don't implement-then-test.

---

## Task 1 — Extend `BlockDef` schema + fill existing rows

**Files:**
- Modify: `src/data/blocks.data.ts`
- Modify: `src/data/blocks.data.test.ts`

**Context:** The `BlockDef` type currently has `{ id, name, label, solid, transparent, kidMode, hardness, textures }`. We add three fields: `lightLevel` (emission 0-15), `lightFilter` (attenuation 0-15), and `liquid: 'none' | 'water' | 'lava'`. All 17 existing rows get defaults filled. No behavior change yet — just data.

- [ ] **Step 1: Write failing tests for the new schema fields**

Add to `src/data/blocks.data.test.ts`, at the bottom of the existing `describe` block (or at the end of the file if the file uses top-level `it`s):

```ts
import { BLOCKS, BLOCK_BY_NAME, isLiquid, isSolid, AIR, WATER, LAVA } from './blocks.data';

describe('BlockDef light + liquid fields', () => {
	it('every block defines lightLevel, lightFilter, liquid', () => {
		for (const b of BLOCKS) {
			expect(typeof b.lightLevel).toBe('number');
			expect(typeof b.lightFilter).toBe('number');
			expect(['none', 'water', 'lava']).toContain(b.liquid);
			expect(b.lightLevel).toBeGreaterThanOrEqual(0);
			expect(b.lightLevel).toBeLessThanOrEqual(15);
			expect(b.lightFilter).toBeGreaterThanOrEqual(0);
			expect(b.lightFilter).toBeLessThanOrEqual(15);
		}
	});

	it('air has filter 0 and emits nothing', () => {
		const air = BLOCKS[AIR];
		expect(air.lightFilter).toBe(0);
		expect(air.lightLevel).toBe(0);
		expect(air.liquid).toBe('none');
	});

	it('glass is fully transparent to light (filter 0)', () => {
		expect(BLOCK_BY_NAME['glass'].lightFilter).toBe(0);
		expect(BLOCK_BY_NAME['glass'].lightLevel).toBe(0);
	});

	it('lamp emits max light (15) and blocks transmitted light (filter 15)', () => {
		expect(BLOCK_BY_NAME['lamp'].lightLevel).toBe(15);
		expect(BLOCK_BY_NAME['lamp'].lightFilter).toBe(15);
	});

	it('all non-lamp non-glass solid blocks have filter 15 and lightLevel 0', () => {
		const exceptions = new Set(['air', 'glass', 'lamp', 'water', 'lava']);
		for (const b of BLOCKS) {
			if (exceptions.has(b.name)) continue;
			expect(b.lightFilter).toBe(15);
			expect(b.lightLevel).toBe(0);
			expect(b.liquid).toBe('none');
		}
	});

	it('isLiquid returns false for air and solids, true for water/lava (once added)', () => {
		expect(isLiquid(AIR)).toBe(false);
		expect(isLiquid(BLOCK_BY_NAME['stone'].id)).toBe(false);
		// water/lava assertions land in Task 2.
	});
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -- src/data/blocks.data.test.ts`
Expected: FAIL (type errors about missing fields + undefined imports `WATER`, `LAVA`, `isLiquid`).

- [ ] **Step 3: Extend `BlockDef` type**

In `src/data/blocks.data.ts`, replace the existing `BlockDef` type with:

```ts
export type BlockDef = {
	id: BlockId;
	name: string;
	label: string;
	solid: boolean;
	transparent: boolean;
	kidMode: boolean;
	hardness: number;
	lightLevel: number;   // 0-15, emission
	lightFilter: number;  // 0-15, attenuation for light passing through
	liquid: 'none' | 'water' | 'lava';
	textures: BlockFaceTextures | null;
};
```

- [ ] **Step 4: Fill the new fields on every existing row**

Update all entries in `export const BLOCKS: BlockDef[] = [ ... ]`. Pattern: every existing row gets `lightLevel: 0, lightFilter: 15, liquid: 'none'` added, with these exceptions:

- `air` (id 0): `lightLevel: 0, lightFilter: 0, liquid: 'none'`.
- `glass` (id 8): `lightLevel: 0, lightFilter: 0, liquid: 'none'`.
- `lamp` (id 16): `lightLevel: 15, lightFilter: 15, liquid: 'none'`.

Everything else (grass_block, dirt, stone, cobblestone, sand, oak_planks, oak_log, all wool variants, tnt) uses `lightLevel: 0, lightFilter: 15, liquid: 'none'`.

Example for the stone row (the rest follow the same pattern):

```ts
{ id: 3, name: 'stone', label: 'Stone', solid: true, transparent: false, kidMode: true, hardness: 1.2,
	lightLevel: 0, lightFilter: 15, liquid: 'none',
	textures: { kind: 'uniform', all: 'stone' } },
```

- [ ] **Step 5: Add the `isLiquid` helper + placeholder `WATER`/`LAVA` exports**

At the bottom of `src/data/blocks.data.ts`, add:

```ts
export function isLiquid(id: BlockId): boolean {
	return BLOCKS[id]?.liquid !== 'none' && BLOCKS[id] !== undefined;
}

// WATER and LAVA are declared here (resolved once their rows are added in Task 2) so
// that external callers can import stable symbol names.
export const WATER: BlockId = 17;
export const LAVA: BlockId = 18;
```

- [ ] **Step 6: Run test to confirm pass**

Run: `npm test -- src/data/blocks.data.test.ts`
Expected: PASS.

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: all tests pass (existing 88 + ~5 new).

- [ ] **Step 8: Commit**

```bash
git add src/data/blocks.data.ts src/data/blocks.data.test.ts
git commit -m "$(cat <<'EOF'
feat(blocks): extend BlockDef with lightLevel, lightFilter, liquid fields

Adds three new fields to the BlockDef schema and fills them in on all
17 existing rows. No behavior change yet — just the schema + isLiquid
helper + WATER/LAVA block id constants (rows come next).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 — Add `water` and `lava` block rows

**Files:**
- Modify: `src/data/blocks.data.ts`
- Modify: `src/data/blocks.data.test.ts`
- Verify: `src/assets/blocks/water_still.png` and `src/assets/blocks/lava_still.png` exist (already confirmed present).

**Context:** Two new block rows. Water is non-solid, translucent, blue; lava is non-solid, translucent, orange-red, emits light. Both are kid-mode enabled. Atlas builder scans the blocks dir automatically, so no changes to `scripts/build-atlas.ts` needed.

- [ ] **Step 1: Write failing tests**

Append to `src/data/blocks.data.test.ts`:

```ts
describe('water and lava', () => {
	it('water has id 17, is non-solid, translucent, liquid=water, filter 2, emit 0', () => {
		const w = BLOCK_BY_NAME['water'];
		expect(w.id).toBe(17);
		expect(w.solid).toBe(false);
		expect(w.transparent).toBe(true);
		expect(w.kidMode).toBe(true);
		expect(w.liquid).toBe('water');
		expect(w.lightFilter).toBe(2);
		expect(w.lightLevel).toBe(0);
		expect(w.hardness).toBe(0);
	});

	it('lava has id 18, is non-solid, translucent, liquid=lava, filter 3, emit 12', () => {
		const l = BLOCK_BY_NAME['lava'];
		expect(l.id).toBe(18);
		expect(l.solid).toBe(false);
		expect(l.transparent).toBe(true);
		expect(l.kidMode).toBe(true);
		expect(l.liquid).toBe('lava');
		expect(l.lightFilter).toBe(3);
		expect(l.lightLevel).toBe(12);
		expect(l.hardness).toBe(0);
	});

	it('WATER and LAVA constants match the block rows', () => {
		expect(BLOCKS[WATER].name).toBe('water');
		expect(BLOCKS[LAVA].name).toBe('lava');
	});

	it('isLiquid is true for water and lava', () => {
		expect(isLiquid(WATER)).toBe(true);
		expect(isLiquid(LAVA)).toBe(true);
	});
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -- src/data/blocks.data.test.ts`
Expected: FAIL (BLOCK_BY_NAME['water'] is undefined).

- [ ] **Step 3: Add the two new rows**

In `src/data/blocks.data.ts`, append to the `BLOCKS` array (after the lamp row):

```ts
{ id: 17, name: 'water', label: 'Water', solid: false, transparent: true, kidMode: true, hardness: 0,
	lightLevel: 0, lightFilter: 2, liquid: 'water',
	textures: { kind: 'uniform', all: 'water_still' } },
{ id: 18, name: 'lava', label: 'Lava', solid: false, transparent: true, kidMode: true, hardness: 0,
	lightLevel: 12, lightFilter: 3, liquid: 'lava',
	textures: { kind: 'uniform', all: 'lava_still' } },
```

- [ ] **Step 4: Rebuild atlas to pick up the new textures**

Run: `npm run build-atlas`
Expected: output mentions `water_still` and `lava_still` tiles added.

- [ ] **Step 5: Run tests to confirm pass**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Sanity-check the build**

Run: `npm run build`
Expected: success, no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add src/data/blocks.data.ts src/data/blocks.data.test.ts public/atlas.png public/atlas.json
# (the atlas outputs may live at different paths — check `git status` and add what build-atlas touched)
git commit -m "$(cat <<'EOF'
feat(blocks): add water (id 17) and lava (id 18) block rows

Water: non-solid, lightFilter 2, lightLevel 0. Lava: non-solid,
lightFilter 3, lightLevel 12 (emits orange-red glow). Both kid-mode
enabled and hardness 0 (mining deletes instantly). Textures pulled
from existing water_still.png and lava_still.png atlas tiles.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3 — Add per-voxel lightmap to `Chunk`

**Files:**
- Modify: `src/engine/world/chunk.ts`
- Modify: `src/engine/world/chunk.test.ts`

**Context:** Each chunk gets a `lights: Uint16Array` alongside `blocks`. 16 bits per voxel, packed as 4 nibbles: bits 12–15 = skylight, 8–11 = blockR, 4–7 = blockG, 0–3 = blockB. Helpers: `getSky`, `getBlockR/G/B`, `setSky`, `setBlockRGB`.

- [ ] **Step 1: Write failing tests**

Append to `src/engine/world/chunk.test.ts`:

```ts
describe('Chunk lightmap', () => {
	it('lights array is allocated and initially all zero', () => {
		const c = new Chunk(0, 0);
		expect(c.lights.length).toBe(BLOCKS_PER_CHUNK);
		for (let i = 0; i < BLOCKS_PER_CHUNK; i++) {
			expect(c.lights[i]).toBe(0);
		}
	});

	it('setSky / getSky round-trip for values 0-15', () => {
		const c = new Chunk(0, 0);
		for (let v = 0; v <= 15; v++) {
			c.setSky(1, 2, 3, v);
			expect(c.getSky(1, 2, 3)).toBe(v);
		}
	});

	it('setBlockRGB / getBlockR/G/B round-trip independently', () => {
		const c = new Chunk(0, 0);
		c.setBlockRGB(5, 6, 7, 15, 10, 3);
		expect(c.getBlockR(5, 6, 7)).toBe(15);
		expect(c.getBlockG(5, 6, 7)).toBe(10);
		expect(c.getBlockB(5, 6, 7)).toBe(3);
	});

	it('setting one channel does not affect the others', () => {
		const c = new Chunk(0, 0);
		c.setBlockRGB(5, 6, 7, 15, 10, 3);
		c.setSky(5, 6, 7, 7);
		expect(c.getSky(5, 6, 7)).toBe(7);
		expect(c.getBlockR(5, 6, 7)).toBe(15);
		expect(c.getBlockG(5, 6, 7)).toBe(10);
		expect(c.getBlockB(5, 6, 7)).toBe(3);
	});

	it('values above 15 are masked to 4 bits', () => {
		const c = new Chunk(0, 0);
		c.setSky(0, 0, 0, 31);
		expect(c.getSky(0, 0, 0)).toBe(15);
	});
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -- src/engine/world/chunk.test.ts`
Expected: FAIL (no `lights`, no `setSky`, etc.).

- [ ] **Step 3: Add lightmap to `Chunk`**

In `src/engine/world/chunk.ts`, extend the class:

```ts
import type { BlockId } from '../../data/blocks.data';
import { BLOCKS_PER_CHUNK, indexOf } from './coords';

export class Chunk {
	readonly cx: number;
	readonly cz: number;
	readonly blocks: Uint8Array;
	readonly lights: Uint16Array;
	dirty = true;
	modified = false;

	constructor(cx: number, cz: number) {
		this.cx = cx;
		this.cz = cz;
		this.blocks = new Uint8Array(BLOCKS_PER_CHUNK);
		this.lights = new Uint16Array(BLOCKS_PER_CHUNK);
	}

	get(x: number, y: number, z: number): BlockId {
		return this.blocks[indexOf(x, y, z)];
	}

	set(x: number, y: number, z: number, id: BlockId): void {
		const i = indexOf(x, y, z);
		if (this.blocks[i] === id) return;
		this.blocks[i] = id;
		this.dirty = true;
		this.modified = true;
	}

	getSky(x: number, y: number, z: number): number {
		return (this.lights[indexOf(x, y, z)] >> 12) & 0xf;
	}

	setSky(x: number, y: number, z: number, v: number): void {
		const i = indexOf(x, y, z);
		const masked = Math.min(15, Math.max(0, v)) & 0xf;
		this.lights[i] = (this.lights[i] & 0x0fff) | (masked << 12);
	}

	getBlockR(x: number, y: number, z: number): number {
		return (this.lights[indexOf(x, y, z)] >> 8) & 0xf;
	}

	getBlockG(x: number, y: number, z: number): number {
		return (this.lights[indexOf(x, y, z)] >> 4) & 0xf;
	}

	getBlockB(x: number, y: number, z: number): number {
		return this.lights[indexOf(x, y, z)] & 0xf;
	}

	setBlockRGB(x: number, y: number, z: number, r: number, g: number, b: number): void {
		const i = indexOf(x, y, z);
		const rm = Math.min(15, Math.max(0, r)) & 0xf;
		const gm = Math.min(15, Math.max(0, g)) & 0xf;
		const bm = Math.min(15, Math.max(0, b)) & 0xf;
		this.lights[i] = (this.lights[i] & 0xf000) | (rm << 8) | (gm << 4) | bm;
	}
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- src/engine/world/chunk.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/engine/world/chunk.ts src/engine/world/chunk.test.ts
git commit -m "$(cat <<'EOF'
feat(chunk): add per-voxel lightmap (skyLight + blockLight RGB, packed)

Each chunk now carries a Uint16Array alongside its blocks array.
Each voxel packs 4×4-bit channels: bits 12-15 skyLight, 8-11 blockR,
4-7 blockG, 0-3 blockB. Helpers getSky/setSky/getBlockR/G/B and
setBlockRGB operate on individual channels without touching others.
Storage only — flood-fill population lands in a later task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4 — Add `liquidFrontier` set to `Chunk` + `markLiquidFrontier` on `World`

**Files:**
- Modify: `src/engine/world/chunk.ts`
- Modify: `src/engine/world/chunk.test.ts`
- Modify: `src/engine/world/world.ts`
- Modify: `src/engine/world/world.test.ts`

**Context:** `Chunk.liquidFrontier` is a `Set<number>` of local voxel indices flagged as "may change next liquid tick." Maintenance is driven from `World`, not from `Chunk.set` — because frontier maintenance needs to read neighbor chunks, which `Chunk` can't. `World.setBlock` gets a post-set helper that adds the written voxel + 6 neighbors to the appropriate frontiers if any of them are liquid.

- [ ] **Step 1: Write failing `Chunk` tests**

Append to `src/engine/world/chunk.test.ts`:

```ts
describe('Chunk.liquidFrontier', () => {
	it('is an empty Set on a fresh chunk', () => {
		const c = new Chunk(0, 0);
		expect(c.liquidFrontier.size).toBe(0);
	});
});
```

- [ ] **Step 2: Write failing `World` tests**

Append to `src/engine/world/world.test.ts` (create if it doesn't exist; model the imports after other test files):

```ts
import { describe, it, expect } from 'vitest';
import { World } from './world';
import { BLOCK_BY_NAME } from '../../data/blocks.data';
import { indexOf } from './coords';

const water = BLOCK_BY_NAME['water'].id;
const stone = BLOCK_BY_NAME['stone'].id;

describe('World.markLiquidFrontier', () => {
	it('setting a liquid block adds it to that chunk\'s frontier', () => {
		const w = new World(1);
		w.setBlock(100, 30, 100, water);
		const { cx, cz, lx, lz } = { cx: Math.floor(100 / 16), cz: Math.floor(100 / 16), lx: 100 - Math.floor(100 / 16) * 16, lz: 100 - Math.floor(100 / 16) * 16 };
		const c = w.getChunk(cx, cz)!;
		expect(c.liquidFrontier.has(indexOf(lx, 30, lz))).toBe(true);
	});

	it('setting a non-liquid next to an existing liquid adds the liquid to the frontier', () => {
		const w = new World(1);
		w.setBlock(100, 30, 100, water);
		// Pretend we already processed the initial set — clear frontier to isolate the neighbor trigger.
		const c = w.getChunk(Math.floor(100 / 16), Math.floor(100 / 16))!;
		c.liquidFrontier.clear();
		w.setBlock(101, 30, 100, stone); // new solid neighbor
		expect(c.liquidFrontier.size).toBeGreaterThan(0);
	});

	it('setting a block at chunk boundary adds liquid to the neighbor chunk\'s frontier', () => {
		const w = new World(1);
		// Place a water at (15, 30, 5) in chunk (0, 0); then set (16, 30, 5) in chunk (1, 0).
		w.setBlock(15, 30, 5, water);
		const c0 = w.getChunk(0, 0)!;
		c0.liquidFrontier.clear();
		w.setBlock(16, 30, 5, stone); // other side of the chunk boundary
		expect(c0.liquidFrontier.size).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `npm test -- src/engine/world/`
Expected: FAIL.

- [ ] **Step 4: Add `liquidFrontier` to `Chunk`**

In `src/engine/world/chunk.ts`, add a field:

```ts
	readonly liquidFrontier: Set<number> = new Set();
```

Put it next to the other `readonly` field declarations (after `blocks` and `lights`).

- [ ] **Step 5: Add `markLiquidFrontier` to `World`**

In `src/engine/world/world.ts`, add an import for `isLiquid` and `indexOf`:

```ts
import { isLiquid } from '../../data/blocks.data';
// indexOf already imported via existing import path if present; otherwise add:
import { WORLD_CHUNKS_X, WORLD_CHUNKS_Z, inBounds, worldToChunk, indexOf } from './coords';
```

Extend `setBlock` to call the frontier helper for the written voxel and each of the 6 neighbors:

```ts
	setBlock(x: number, y: number, z: number, id: BlockId): void {
		if (!inBounds(x, y, z)) return;
		const { cx, cz, lx, lz } = worldToChunk(x, z);
		const c = this.ensureChunk(cx, cz);
		c.set(lx, y, lz, id);
		c.modified = true;

		this.markLiquidFrontier(x, y, z);
		this.markLiquidFrontier(x + 1, y, z);
		this.markLiquidFrontier(x - 1, y, z);
		this.markLiquidFrontier(x, y + 1, z);
		this.markLiquidFrontier(x, y - 1, z);
		this.markLiquidFrontier(x, y, z + 1);
		this.markLiquidFrontier(x, y, z - 1);
	}

	markLiquidFrontier(x: number, y: number, z: number): void {
		if (!inBounds(x, y, z)) return;
		const { cx, cz, lx, lz } = worldToChunk(x, z);
		const c = this.getChunk(cx, cz);
		if (!c) return;
		const id = c.get(lx, y, lz);
		if (isLiquid(id)) {
			c.liquidFrontier.add(indexOf(lx, y, lz));
		}
	}
```

- [ ] **Step 6: Run tests**

Run: `npm test -- src/engine/world/`
Expected: PASS.

- [ ] **Step 7: Run full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/engine/world/chunk.ts src/engine/world/chunk.test.ts src/engine/world/world.ts src/engine/world/world.test.ts
git commit -m "$(cat <<'EOF'
feat(chunk): track liquid voxels in a per-chunk frontier set

Chunk.liquidFrontier holds local voxel indices that may change on the
next liquid-flow tick. World.setBlock maintains it: on every write,
the written voxel and its 6 axis-aligned neighbors are examined, and
any that are liquid join the appropriate chunk's frontier. Cross-chunk
neighbors are handled via worldToChunk lookup.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5 — Lighting module: skylight flood-fill

**Files:**
- Create: `src/engine/world/lighting.ts`
- Create: `src/engine/world/lighting.test.ts`

**Context:** First piece of the lighting module. Skylight is seeded from y=63 downward: each (x, z) column gets `skyLight = 15` from the top until it hits a block with `lightFilter >= 15`. Then BFS propagates: horizontally with attenuation `max(1, targetFilter)`, and downward-through-zero-filter voxels **without** decrement (so sunlight streams down open shafts at full strength). This task handles skylight only; block light comes next.

- [ ] **Step 1: Write failing tests**

Create `src/engine/world/lighting.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Chunk } from './chunk';
import { World } from './world';
import { BLOCK_BY_NAME, AIR } from '../../data/blocks.data';
import { fillChunkLights } from './lighting';
import { CHUNK_SIZE_Y } from './coords';

const stone = BLOCK_BY_NAME['stone'].id;
const glass = BLOCK_BY_NAME['glass'].id;

// Helper: build a chunk manually to avoid world-gen noise.
function emptyWorld(): World {
	const w = new World(1);
	// Force the chunk (0, 0) to exist but empty. ensureChunk runs generation — we'll
	// overwrite the blocks array to all-air afterward.
	const c = w.ensureChunk(0, 0);
	c.blocks.fill(AIR);
	c.lights.fill(0);
	c.liquidFrontier.clear();
	return w;
}

describe('fillChunkLights — skylight', () => {
	it('fills a fully-open column with skyLight=15 all the way down', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		fillChunkLights(w, c);
		for (let y = 0; y < CHUNK_SIZE_Y; y++) {
			expect(c.getSky(0, y, 0)).toBe(15);
		}
	});

	it('drops skyLight to 0 directly below an opaque ceiling with no side path', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		// Build a 3x3 roof of stone at y=40, centred at (5,5); inside from (4..6, 4..6) at y<40 is dark.
		for (let dx = 4; dx <= 6; dx++) for (let dz = 4; dz <= 6; dz++) c.blocks[(40) * 16 * 16 + dz * 16 + dx] = stone;
		// Enclose the sides too to fully seal the volume from horizontal skylight.
		// Box: x 4..6, z 4..6, y 37..40 top, walls at y 37..39 on boundaries.
		for (let y = 37; y <= 40; y++) {
			for (let dx = 4; dx <= 6; dx++) {
				c.blocks[y * 16 * 16 + 4 * 16 + dx] = stone;
				c.blocks[y * 16 * 16 + 6 * 16 + dx] = stone;
			}
			for (let dz = 4; dz <= 6; dz++) {
				c.blocks[y * 16 * 16 + dz * 16 + 4] = stone;
				c.blocks[y * 16 * 16 + dz * 16 + 6] = stone;
			}
		}
		// Set the roof solid too so the inside (5,5,5..39) has no direct skylight path.
		fillChunkLights(w, c);
		expect(c.getSky(5, 39, 5)).toBe(0);
		expect(c.getSky(5, 38, 5)).toBe(0);
	});

	it('skylight passes through glass unchanged (filter 0)', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		// Glass roof at y=40 over (5,5). The column below should still see full sunlight.
		c.blocks[40 * 16 * 16 + 5 * 16 + 5] = glass;
		fillChunkLights(w, c);
		expect(c.getSky(5, 39, 5)).toBe(15);
	});

	it('skylight attenuates by 1 per block horizontally under an overhang', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		// Overhang roof at y=40 covering x=0..7, z=0..15. Open sky at x=8..15.
		for (let dx = 0; dx <= 7; dx++) for (let dz = 0; dz < 16; dz++) c.blocks[40 * 16 * 16 + dz * 16 + dx] = stone;
		fillChunkLights(w, c);
		// At y=39, x=7 is immediately under the overhang edge — adjacent to x=8 which has sky=15.
		// Walking left from the edge, skylight should attenuate by 1 per block.
		expect(c.getSky(8, 39, 5)).toBe(15); // just outside the overhang: full sky
		expect(c.getSky(7, 39, 5)).toBe(14); // one block under
		expect(c.getSky(6, 39, 5)).toBe(13);
		expect(c.getSky(5, 39, 5)).toBe(12);
	});
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -- src/engine/world/lighting.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create the lighting module**

Create `src/engine/world/lighting.ts`:

```ts
import type { World } from './world';
import type { Chunk } from './chunk';
import { BLOCKS, isLiquid } from '../../data/blocks.data';
import { CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z, indexOf } from './coords';

type Coord = { x: number; y: number; z: number };

function filterOf(id: number): number {
	return BLOCKS[id]?.lightFilter ?? 0;
}

/**
 * Computes the full lightmap for a chunk from scratch. Clears the existing lights
 * array first, then runs skylight flood-fill (in this task). Block-light fill is
 * layered on in Task 6.
 *
 * Returns the set of chunks whose lightmaps were touched (the target chunk plus
 * any neighbors reached by BFS propagation), so the caller can mark them dirty.
 */
export function fillChunkLights(world: World, chunk: Chunk): Set<Chunk> {
	chunk.lights.fill(0);
	const touched = new Set<Chunk>();
	touched.add(chunk);
	seedSkylight(world, chunk, touched);
	return touched;
}

/** Seed skylight by walking each column from the top and then BFS-propagating. */
function seedSkylight(world: World, chunk: Chunk, touched: Set<Chunk>): void {
	const queue: Coord[] = [];
	const baseX = chunk.cx * CHUNK_SIZE_X;
	const baseZ = chunk.cz * CHUNK_SIZE_Z;

	for (let lz = 0; lz < CHUNK_SIZE_Z; lz++) {
		for (let lx = 0; lx < CHUNK_SIZE_X; lx++) {
			for (let y = CHUNK_SIZE_Y - 1; y >= 0; y--) {
				const id = chunk.blocks[indexOf(lx, y, lz)];
				if (filterOf(id) >= 15) break;
				chunk.setSky(lx, y, lz, 15);
				queue.push({ x: baseX + lx, y, z: baseZ + lz });
			}
		}
	}

	propagateSkylight(world, queue, touched);
}

/** BFS propagate skylight outward. Downward-through-zero-filter preserves value (no attenuation). */
function propagateSkylight(world: World, queue: Coord[], touched: Set<Chunk>): void {
	while (queue.length) {
		const { x, y, z } = queue.shift()!;
		const chunk = chunkAtWorld(world, x, z);
		if (!chunk) continue;
		const lx = x - chunk.cx * CHUNK_SIZE_X;
		const lz = z - chunk.cz * CHUNK_SIZE_Z;
		const here = chunk.getSky(lx, y, lz);
		if (here <= 0) continue;

		const dirs: [number, number, number][] = [
			[1, 0, 0], [-1, 0, 0],
			[0, 1, 0], [0, -1, 0],
			[0, 0, 1], [0, 0, -1],
		];
		for (const [dx, dy, dz] of dirs) {
			const nx = x + dx, ny = y + dy, nz = z + dz;
			if (ny < 0 || ny >= CHUNK_SIZE_Y) continue;
			const nchunk = chunkAtWorld(world, nx, nz);
			if (!nchunk) continue;
			const nlx = nx - nchunk.cx * CHUNK_SIZE_X;
			const nlz = nz - nchunk.cz * CHUNK_SIZE_Z;
			const nid = nchunk.blocks[indexOf(nlx, ny, nlz)];
			const nFilter = filterOf(nid);
			if (nFilter >= 15) continue;
			// Special case: falling straight down through zero-filter preserves value.
			const attenuation = dy === -1 && nFilter === 0 && here === 15 ? 0 : Math.max(1, nFilter);
			const propagated = here - attenuation;
			if (propagated <= 0) continue;
			if (nchunk.getSky(nlx, ny, nlz) >= propagated) continue;
			nchunk.setSky(nlx, ny, nlz, propagated);
			touched.add(nchunk);
			queue.push({ x: nx, y: ny, z: nz });
		}
	}
}

/** Locate the chunk containing world coord (x, z). Returns undefined if not in bounds / not loaded. */
function chunkAtWorld(world: World, x: number, z: number): Chunk | undefined {
	const cx = Math.floor(x / CHUNK_SIZE_X);
	const cz = Math.floor(z / CHUNK_SIZE_Z);
	if (!world.chunkInWorld(cx, cz)) return undefined;
	return world.getChunk(cx, cz);
}
```

Note on unused imports: `isLiquid` is not used here yet but will be in Task 6. It's fine to add now — but if it causes a lint warning, prefix the import with the task that uses it or defer the import to that task.

- [ ] **Step 4: Run tests**

Run: `npm test -- src/engine/world/lighting.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/engine/world/lighting.ts src/engine/world/lighting.test.ts
git commit -m "$(cat <<'EOF'
feat(lighting): voxel skylight flood-fill (fillChunkLights)

BFS propagator: each (x, z) column seeds skyLight=15 from y=63 down
to the first opaque block; then horizontal/upward propagation
attenuates by max(1, neighborFilter). Downward propagation through
zero-filter voxels preserves value so sunlight streams through open
shafts unattenuated. Block-light RGB pass lands in the next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6 — Lighting module: block-light RGB flood-fill

**Files:**
- Modify: `src/engine/world/lighting.ts`
- Modify: `src/engine/world/lighting.test.ts`
- Read-only: `src/engine/render/light-registry.ts` (for lamp color lookup)

**Context:** Extend `fillChunkLights` with a second pass that seeds block-light from every voxel with `lightLevel > 0`. Lamps read their color from a `LightRegistry`; lava uses a fixed `LAVA_LIGHT_COLOR = '#FF8A3D'`. Each of R, G, B is flood-filled as a separate BFS with the same attenuation rule. Overlap uses per-channel max.

To avoid a compile-time dependency on `three.js` in the lighting module (unit tests use `Chunk` + `World` without rendering), the lamp color lookup is passed in as a function.

**API shape change:**

```ts
export type LampColorLookup = (x: number, y: number, z: number) => string | null;
export function fillChunkLights(world: World, chunk: Chunk, getLampColor?: LampColorLookup): Set<Chunk>;
```

Default behavior when `getLampColor` is undefined: treat lamps as emitting neutral `#FFFFFF`. Tests pass a stub; production calls pass `(x,y,z) => lightRegistry.getColor(x,y,z)`.

- [ ] **Step 1: Write failing tests**

Append to `src/engine/world/lighting.test.ts`:

```ts
import { fillChunkLights } from './lighting';  // already imported; keep
import { BLOCK_BY_NAME } from '../../data/blocks.data';  // already imported

const lamp = BLOCK_BY_NAME['lamp'].id;
const lava = BLOCK_BY_NAME['lava'].id;

describe('fillChunkLights — block light', () => {
	it('a lamp radiates outward with distance decay', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		// Roof on top so skylight doesn't confuse the test.
		for (let dx = 0; dx < 16; dx++) for (let dz = 0; dz < 16; dz++) c.blocks[63 * 16 * 16 + dz * 16 + dx] = stone;
		c.blocks[indexOf(5, 30, 5)] = lamp;
		fillChunkLights(w, c, () => '#FFFFFF');
		// Lamp position itself — any channel should register as emission source level.
		const r5 = c.getBlockR(5, 30, 5);
		expect(r5).toBeGreaterThanOrEqual(14);
		// One block away in any direction
		expect(c.getBlockR(6, 30, 5)).toBeGreaterThanOrEqual(13);
		expect(c.getBlockR(5, 30, 6)).toBeGreaterThanOrEqual(13);
		// Far away — out of range
		expect(c.getBlockR(15, 30, 5)).toBe(0);
	});

	it('a red lamp produces nonzero R and zero G/B', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		c.blocks[indexOf(5, 30, 5)] = lamp;
		fillChunkLights(w, c, () => '#FF0000');
		expect(c.getBlockR(6, 30, 5)).toBeGreaterThan(0);
		expect(c.getBlockG(6, 30, 5)).toBe(0);
		expect(c.getBlockB(6, 30, 5)).toBe(0);
	});

	it('two lamps of different colors blend per-channel via max, not sum', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		// Red lamp at (5, 30, 5), blue lamp at (7, 30, 5). Check the midpoint (6, 30, 5).
		c.blocks[indexOf(5, 30, 5)] = lamp;
		c.blocks[indexOf(7, 30, 5)] = lamp;
		fillChunkLights(w, c, (x, y, z) => {
			if (x === 5) return '#FF0000';
			if (x === 7) return '#0000FF';
			return '#FFFFFF';
		});
		const r = c.getBlockR(6, 30, 5);
		const b = c.getBlockB(6, 30, 5);
		expect(r).toBeGreaterThan(0);
		expect(b).toBeGreaterThan(0);
		// Neither channel is additive — each is bounded by its nearest source's BFS.
		expect(r).toBeLessThanOrEqual(15);
		expect(b).toBeLessThanOrEqual(15);
	});

	it('lava emits orange-red light at level 12', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		c.blocks[indexOf(5, 30, 5)] = lava;
		fillChunkLights(w, c, () => '#FFFFFF');
		// Source's own R channel should be near its seed value (~12).
		expect(c.getBlockR(5, 30, 5)).toBeGreaterThanOrEqual(11);
		// Source has more R than B (orange vs blue).
		expect(c.getBlockR(5, 30, 5)).toBeGreaterThan(c.getBlockB(5, 30, 5));
	});
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -- src/engine/world/lighting.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the block-light pass**

Extend `src/engine/world/lighting.ts`:

```ts
export type LampColorLookup = (x: number, y: number, z: number) => string | null;

const LAVA_LIGHT_COLOR = '#FF8A3D';
const LAMP_NAME_ID_CACHE: { lamp?: number; lava?: number } = {};

function lampId(): number {
	if (LAMP_NAME_ID_CACHE.lamp === undefined) {
		LAMP_NAME_ID_CACHE.lamp = BLOCKS.findIndex((b) => b.name === 'lamp');
	}
	return LAMP_NAME_ID_CACHE.lamp!;
}
function lavaId(): number {
	if (LAMP_NAME_ID_CACHE.lava === undefined) {
		LAMP_NAME_ID_CACHE.lava = BLOCKS.findIndex((b) => b.name === 'lava');
	}
	return LAMP_NAME_ID_CACHE.lava!;
}

/** Parse '#RRGGBB' to three 0..1 floats. Returns [1,1,1] on malformed input. */
function parseHex(hex: string): [number, number, number] {
	if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return [1, 1, 1];
	const r = parseInt(hex.slice(1, 3), 16) / 255;
	const g = parseInt(hex.slice(3, 5), 16) / 255;
	const b = parseInt(hex.slice(5, 7), 16) / 255;
	return [r, g, b];
}
```

Update the public `fillChunkLights` signature and call the new seeder:

```ts
export function fillChunkLights(world: World, chunk: Chunk, getLampColor?: LampColorLookup): Set<Chunk> {
	chunk.lights.fill(0);
	const touched = new Set<Chunk>();
	touched.add(chunk);
	seedSkylight(world, chunk, touched);
	seedBlockLight(world, chunk, touched, getLampColor);
	return touched;
}
```

Add the block-light seeder + propagator at the bottom of the file:

```ts
type RGBQueueEntry = { x: number; y: number; z: number; channel: 0 | 1 | 2 };

function seedBlockLight(world: World, chunk: Chunk, touched: Set<Chunk>, getLampColor?: LampColorLookup): void {
	const queue: RGBQueueEntry[] = [];
	const baseX = chunk.cx * CHUNK_SIZE_X;
	const baseZ = chunk.cz * CHUNK_SIZE_Z;

	for (let y = 0; y < CHUNK_SIZE_Y; y++) {
		for (let z = 0; z < CHUNK_SIZE_Z; z++) {
			for (let x = 0; x < CHUNK_SIZE_X; x++) {
				const id = chunk.blocks[indexOf(x, y, z)];
				const def = BLOCKS[id];
				if (!def || def.lightLevel <= 0) continue;
				let color: [number, number, number];
				if (id === lampId()) {
					const hex = getLampColor?.(baseX + x, y, baseZ + z) ?? '#FFFFFF';
					color = parseHex(hex);
				} else if (id === lavaId()) {
					color = parseHex(LAVA_LIGHT_COLOR);
				} else {
					color = [1, 1, 1];
				}
				const rSeed = Math.round(color[0] * def.lightLevel);
				const gSeed = Math.round(color[1] * def.lightLevel);
				const bSeed = Math.round(color[2] * def.lightLevel);
				if (rSeed > chunk.getBlockR(x, y, z)) {
					chunk.setBlockRGB(x, y, z, rSeed, chunk.getBlockG(x, y, z), chunk.getBlockB(x, y, z));
					queue.push({ x: baseX + x, y, z: baseZ + z, channel: 0 });
				}
				if (gSeed > chunk.getBlockG(x, y, z)) {
					chunk.setBlockRGB(x, y, z, chunk.getBlockR(x, y, z), gSeed, chunk.getBlockB(x, y, z));
					queue.push({ x: baseX + x, y, z: baseZ + z, channel: 1 });
				}
				if (bSeed > chunk.getBlockB(x, y, z)) {
					chunk.setBlockRGB(x, y, z, chunk.getBlockR(x, y, z), chunk.getBlockG(x, y, z), bSeed);
					queue.push({ x: baseX + x, y, z: baseZ + z, channel: 2 });
				}
			}
		}
	}

	propagateBlockLight(world, queue, touched);
}

function getChannel(chunk: Chunk, lx: number, y: number, lz: number, ch: 0 | 1 | 2): number {
	switch (ch) {
		case 0: return chunk.getBlockR(lx, y, lz);
		case 1: return chunk.getBlockG(lx, y, lz);
		case 2: return chunk.getBlockB(lx, y, lz);
	}
}

function setChannel(chunk: Chunk, lx: number, y: number, lz: number, ch: 0 | 1 | 2, v: number): void {
	const r = chunk.getBlockR(lx, y, lz);
	const g = chunk.getBlockG(lx, y, lz);
	const b = chunk.getBlockB(lx, y, lz);
	if (ch === 0) chunk.setBlockRGB(lx, y, lz, v, g, b);
	else if (ch === 1) chunk.setBlockRGB(lx, y, lz, r, v, b);
	else chunk.setBlockRGB(lx, y, lz, r, g, v);
}

function propagateBlockLight(world: World, queue: RGBQueueEntry[], touched: Set<Chunk>): void {
	const dirs: [number, number, number][] = [
		[1, 0, 0], [-1, 0, 0],
		[0, 1, 0], [0, -1, 0],
		[0, 0, 1], [0, 0, -1],
	];
	while (queue.length) {
		const { x, y, z, channel } = queue.shift()!;
		const chunk = chunkAtWorld(world, x, z);
		if (!chunk) continue;
		const lx = x - chunk.cx * CHUNK_SIZE_X;
		const lz = z - chunk.cz * CHUNK_SIZE_Z;
		const here = getChannel(chunk, lx, y, lz, channel);
		if (here <= 0) continue;

		for (const [dx, dy, dz] of dirs) {
			const nx = x + dx, ny = y + dy, nz = z + dz;
			if (ny < 0 || ny >= CHUNK_SIZE_Y) continue;
			const nchunk = chunkAtWorld(world, nx, nz);
			if (!nchunk) continue;
			const nlx = nx - nchunk.cx * CHUNK_SIZE_X;
			const nlz = nz - nchunk.cz * CHUNK_SIZE_Z;
			const nid = nchunk.blocks[indexOf(nlx, ny, nlz)];
			const nFilter = filterOf(nid);
			if (nFilter >= 15) continue;
			const propagated = here - Math.max(1, nFilter);
			if (propagated <= 0) continue;
			if (getChannel(nchunk, nlx, ny, nlz, channel) >= propagated) continue;
			setChannel(nchunk, nlx, ny, nlz, channel, propagated);
			touched.add(nchunk);
			queue.push({ x: nx, y: ny, z: nz, channel });
		}
	}
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- src/engine/world/lighting.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/engine/world/lighting.ts src/engine/world/lighting.test.ts
git commit -m "$(cat <<'EOF'
feat(lighting): block-light RGB flood-fill (lamps + lava)

Second flood-fill pass in fillChunkLights. Each block with
lightLevel > 0 seeds three per-channel BFS queues; each channel
propagates independently with the same attenuation rule. Lamp colors
come from an injected lookup (LightRegistry in production, stub in
tests). Lava uses fixed #FF8A3D. Overlapping sources combine via
per-channel max.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7 — Incremental light update on block change

**Files:**
- Modify: `src/engine/world/lighting.ts`
- Modify: `src/engine/world/lighting.test.ts`

**Context:** Placing or mining a single block shouldn't require re-flooding the whole chunk. `updateLightsForBlockChange(world, x, y, z, getLampColor?)` performs a removal BFS (clear any light whose value is ≤ what the changed voxel's old state contributed) followed by an addition BFS (re-seed from the voxel's new state and from any light still at the removal frontier). Returns the set of chunks whose lights changed.

**Important:** this is the trickiest algorithm in the plan. The removal phase must re-propagate light from unaffected bright voxels at the frontier, otherwise holes appear. Classic Mojang algorithm, plenty of references online.

- [ ] **Step 1: Write failing tests**

Append to `src/engine/world/lighting.test.ts`:

```ts
import { updateLightsForBlockChange } from './lighting';

describe('updateLightsForBlockChange', () => {
	it('mining a lamp clears its propagated light locally', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		c.blocks[indexOf(5, 30, 5)] = lamp;
		fillChunkLights(w, c, () => '#FFFFFF');
		expect(c.getBlockR(6, 30, 5)).toBeGreaterThan(0);

		c.blocks[indexOf(5, 30, 5)] = AIR;
		updateLightsForBlockChange(w, 5, 30, 5, () => '#FFFFFF');
		expect(c.getBlockR(5, 30, 5)).toBe(0);
		expect(c.getBlockR(6, 30, 5)).toBe(0);
	});

	it('breaking a wall between dark and lit re-floods light into the dark side', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		// Roof everywhere except under the wall region.
		for (let dx = 0; dx < 16; dx++) for (let dz = 0; dz < 16; dz++) c.blocks[63 * 16 * 16 + dz * 16 + dx] = stone;
		// Wall at x=8 blocking skylight intrusion horizontally for y=10..40.
		for (let y = 10; y <= 40; y++) for (let dz = 0; dz < 16; dz++) c.blocks[y * 16 * 16 + dz * 16 + 8] = stone;
		// Place a lamp at (4, 30, 5).
		c.blocks[indexOf(4, 30, 5)] = lamp;
		fillChunkLights(w, c, () => '#FFFFFF');
		expect(c.getBlockR(7, 30, 5)).toBeGreaterThan(0);
		expect(c.getBlockR(9, 30, 5)).toBe(0);

		// Now remove one block from the wall at (8, 30, 5).
		c.blocks[indexOf(8, 30, 5)] = AIR;
		updateLightsForBlockChange(w, 8, 30, 5, () => '#FFFFFF');
		expect(c.getBlockR(9, 30, 5)).toBeGreaterThan(0);
	});

	it('placing a lamp in a dark room lights it up', () => {
		const w = emptyWorld();
		const c = w.getChunk(0, 0)!;
		// Sealed box: walls at y=20..30, x=0..5, z=0..5 perimeter + roof at y=30 + floor at y=20.
		for (let y = 20; y <= 30; y++) {
			for (let dx = 0; dx <= 5; dx++) for (let dz = 0; dz <= 5; dz++) {
				if (y === 20 || y === 30 || dx === 0 || dx === 5 || dz === 0 || dz === 5) {
					c.blocks[y * 16 * 16 + dz * 16 + dx] = stone;
				}
			}
		}
		// Roof everywhere else too (to prevent skylight).
		for (let dx = 0; dx < 16; dx++) for (let dz = 0; dz < 16; dz++) c.blocks[63 * 16 * 16 + dz * 16 + dx] = stone;
		fillChunkLights(w, c, () => '#FFFFFF');
		expect(c.getBlockR(3, 25, 3)).toBe(0); // dark inside

		c.blocks[indexOf(3, 25, 3)] = lamp;
		updateLightsForBlockChange(w, 3, 25, 3, () => '#FFFFFF');
		expect(c.getBlockR(3, 25, 3)).toBeGreaterThan(0);
		expect(c.getBlockR(2, 25, 3)).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -- src/engine/world/lighting.test.ts`
Expected: FAIL (updateLightsForBlockChange not exported).

- [ ] **Step 3: Implement `updateLightsForBlockChange`**

Append to `src/engine/world/lighting.ts`:

```ts
/**
 * Incremental update after a single block has been written at (x, y, z).
 * Must be called AFTER world.setBlock has run. Re-floods skylight and each
 * block-light channel locally. Returns the set of chunks whose lights changed.
 */
export function updateLightsForBlockChange(
	world: World,
	x: number,
	y: number,
	z: number,
	getLampColor?: LampColorLookup,
): Set<Chunk> {
	const touched = new Set<Chunk>();
	const chunk = chunkAtWorld(world, x, z);
	if (!chunk) return touched;
	touched.add(chunk);

	// Snapshot the old lightmap values at (x,y,z) before we overwrite them.
	const lx = x - chunk.cx * CHUNK_SIZE_X;
	const lz = z - chunk.cz * CHUNK_SIZE_Z;
	const oldSky = chunk.getSky(lx, y, lz);
	const oldR = chunk.getBlockR(lx, y, lz);
	const oldG = chunk.getBlockG(lx, y, lz);
	const oldB = chunk.getBlockB(lx, y, lz);

	// Clear the voxel's light values (they will be re-propagated below if warranted).
	chunk.setSky(lx, y, lz, 0);
	chunk.setBlockRGB(lx, y, lz, 0, 0, 0);

	// Skylight removal BFS + re-propagate from unchanged bright neighbors.
	removeAndReflood(world, x, y, z, oldSky, touched, 'sky', getLampColor);
	removeAndReflood(world, x, y, z, oldR, touched, 'r', getLampColor);
	removeAndReflood(world, x, y, z, oldG, touched, 'g', getLampColor);
	removeAndReflood(world, x, y, z, oldB, touched, 'b', getLampColor);

	// Re-seed skylight in the column the change is in (block may have opened a new skylight path).
	reSeedSkylightColumn(world, x, z, touched);

	// If the new block is an emitter, seed block-light at this voxel.
	const newId = chunk.blocks[indexOf(lx, y, lz)];
	const def = BLOCKS[newId];
	if (def && def.lightLevel > 0) {
		let color: [number, number, number] = [1, 1, 1];
		if (newId === lampId()) {
			color = parseHex(getLampColor?.(x, y, z) ?? '#FFFFFF');
		} else if (newId === lavaId()) {
			color = parseHex(LAVA_LIGHT_COLOR);
		}
		const r = Math.round(color[0] * def.lightLevel);
		const g = Math.round(color[1] * def.lightLevel);
		const b = Math.round(color[2] * def.lightLevel);
		chunk.setBlockRGB(lx, y, lz, Math.max(r, chunk.getBlockR(lx, y, lz)),
			Math.max(g, chunk.getBlockG(lx, y, lz)),
			Math.max(b, chunk.getBlockB(lx, y, lz)));
		const q: RGBQueueEntry[] = [];
		if (r > 0) q.push({ x, y, z, channel: 0 });
		if (g > 0) q.push({ x, y, z, channel: 1 });
		if (b > 0) q.push({ x, y, z, channel: 2 });
		propagateBlockLight(world, q, touched);
	}

	return touched;
}

type Field = 'sky' | 'r' | 'g' | 'b';

function getField(chunk: Chunk, lx: number, y: number, lz: number, f: Field): number {
	if (f === 'sky') return chunk.getSky(lx, y, lz);
	if (f === 'r') return chunk.getBlockR(lx, y, lz);
	if (f === 'g') return chunk.getBlockG(lx, y, lz);
	return chunk.getBlockB(lx, y, lz);
}

function setField(chunk: Chunk, lx: number, y: number, lz: number, f: Field, v: number): void {
	if (f === 'sky') chunk.setSky(lx, y, lz, v);
	else if (f === 'r') chunk.setBlockRGB(lx, y, lz, v, chunk.getBlockG(lx, y, lz), chunk.getBlockB(lx, y, lz));
	else if (f === 'g') chunk.setBlockRGB(lx, y, lz, chunk.getBlockR(lx, y, lz), v, chunk.getBlockB(lx, y, lz));
	else chunk.setBlockRGB(lx, y, lz, chunk.getBlockR(lx, y, lz), chunk.getBlockG(lx, y, lz), v);
}

function removeAndReflood(
	world: World,
	ox: number, oy: number, oz: number,
	oldLight: number,
	touched: Set<Chunk>,
	field: Field,
	getLampColor?: LampColorLookup,
): void {
	if (oldLight <= 0) return;
	// Removal queue: voxels to zero if their current value <= the propagated value from origin.
	const remQueue: { x: number; y: number; z: number; value: number }[] = [{ x: ox, y: oy, z: oz, value: oldLight }];
	const addQueue: { x: number; y: number; z: number }[] = [];
	const dirs: [number, number, number][] = [
		[1, 0, 0], [-1, 0, 0],
		[0, 1, 0], [0, -1, 0],
		[0, 0, 1], [0, 0, -1],
	];

	while (remQueue.length) {
		const { x, y, z, value } = remQueue.shift()!;
		for (const [dx, dy, dz] of dirs) {
			const nx = x + dx, ny = y + dy, nz = z + dz;
			if (ny < 0 || ny >= CHUNK_SIZE_Y) continue;
			const nchunk = chunkAtWorld(world, nx, nz);
			if (!nchunk) continue;
			const nlx = nx - nchunk.cx * CHUNK_SIZE_X;
			const nlz = nz - nchunk.cz * CHUNK_SIZE_Z;
			const nValue = getField(nchunk, nlx, ny, nlz, field);
			if (nValue > 0 && nValue < value) {
				setField(nchunk, nlx, ny, nlz, field, 0);
				touched.add(nchunk);
				remQueue.push({ x: nx, y: ny, z: nz, value: nValue });
			} else if (nValue >= value) {
				// This neighbor is brighter than the removed source — it's a "frontier" that must
				// re-propagate light into the cleared area.
				addQueue.push({ x: nx, y: ny, z: nz });
			}
		}
	}

	// Re-flood from the frontier.
	if (field === 'sky') {
		const q: { x: number; y: number; z: number }[] = addQueue.map((c) => ({ ...c }));
		propagateSkylight(world, q, touched);
	} else {
		const ch = field === 'r' ? 0 : field === 'g' ? 1 : 2;
		const q: RGBQueueEntry[] = addQueue.map((c) => ({ x: c.x, y: c.y, z: c.z, channel: ch as 0 | 1 | 2 }));
		propagateBlockLight(world, q, touched);
	}
}

function reSeedSkylightColumn(world: World, wx: number, wz: number, touched: Set<Chunk>): void {
	const chunk = chunkAtWorld(world, wx, wz);
	if (!chunk) return;
	const lx = wx - chunk.cx * CHUNK_SIZE_X;
	const lz = wz - chunk.cz * CHUNK_SIZE_Z;
	const q: { x: number; y: number; z: number }[] = [];
	for (let y = CHUNK_SIZE_Y - 1; y >= 0; y--) {
		const id = chunk.blocks[indexOf(lx, y, lz)];
		if (filterOf(id) >= 15) break;
		if (chunk.getSky(lx, y, lz) < 15) {
			chunk.setSky(lx, y, lz, 15);
			q.push({ x: wx, y, z: wz });
		}
	}
	if (q.length) propagateSkylight(world, q, touched);
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- src/engine/world/lighting.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/engine/world/lighting.ts src/engine/world/lighting.test.ts
git commit -m "$(cat <<'EOF'
feat(lighting): incremental updateLightsForBlockChange

After a block write, performs per-field removal BFS to clear any
voxel whose light was downstream of the changed voxel, then re-floods
from the frontier of still-bright neighbors. Covers sky + blockR/G/B
independently. Re-seeds the affected column's skylight if the change
opened or closed a path to the sky. Seeds new emitter light if the
new block has lightLevel > 0.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8 — Mesher emits per-vertex colors from lightmap

**Files:**
- Modify: `src/engine/world/mesher.ts`
- Modify: `src/engine/world/mesher.test.ts`

**Context:** The mesher currently emits `{ positions, normals, uvs, indices }`. We add a `colors: Float32Array` attribute (3 floats per vertex) computed by sampling 4 voxels around each corner and combining their lightmap values. No AO yet (comes next), no liquid pass yet (comes in Task 10). The material can't yet read these colors (Task 11 swaps the material), so the effect is invisible in-game but verifiable in tests.

- [ ] **Step 1: Add failing tests**

Append to `src/engine/world/mesher.test.ts`:

```ts
import { fillChunkLights } from './lighting';

describe('meshChunk — per-vertex colors from lightmap', () => {
	it('mesh includes a colors attribute matching positions in length', () => {
		const w = new World(1);
		const c = w.ensureChunk(0, 0);
		// Ensure at least one face gets emitted.
		c.blocks[indexOf(1, 30, 1)] = BLOCK_BY_NAME['stone'].id;
		fillChunkLights(w, c);
		const mesh = meshChunk(c, w.neighbors(c), (id, face) => [0, 0, 1, 1]);
		// colors is Float32Array, 3 per vertex. positions is 3 per vertex. So lengths match.
		expect(mesh.colors).toBeInstanceOf(Float32Array);
		expect(mesh.colors.length).toBe(mesh.positions.length);
	});

	it('a fully-lit vertex (sky=15) has a bright RGB', () => {
		const w = new World(1);
		const c = w.ensureChunk(0, 0);
		c.blocks.fill(0);
		c.blocks[indexOf(5, 30, 5)] = BLOCK_BY_NAME['stone'].id;
		fillChunkLights(w, c);
		const mesh = meshChunk(c, w.neighbors(c), (id, face) => [0, 0, 1, 1]);
		// The top face of the block is under open sky → vertex colors should be bright.
		// Find any vertex with the top-face normal (0, 1, 0) and check its RGB.
		let foundBright = false;
		for (let i = 0; i < mesh.normals.length; i += 3) {
			if (mesh.normals[i + 1] > 0.9) {
				const r = mesh.colors[i];
				const g = mesh.colors[i + 1];
				const b = mesh.colors[i + 2];
				expect(r + g + b).toBeGreaterThan(1.5);
				foundBright = true;
				break;
			}
		}
		expect(foundBright).toBe(true);
	});
});
```

(Imports for `World`, `BLOCK_BY_NAME`, `indexOf`, `meshChunk` should already be present in the existing mesher test — confirm before running.)

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -- src/engine/world/mesher.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend `ChunkMesh` and add color computation**

In `src/engine/world/mesher.ts`:

a) Extend the `ChunkMesh` type:

```ts
export type ChunkMesh = {
	positions: Float32Array;
	normals: Float32Array;
	uvs: Float32Array;
	colors: Float32Array;
	indices: Uint32Array;
};
```

b) Add near the top of the file, below existing constants:

```ts
const SKY_COLOR: [number, number, number] = [0.9, 0.95, 1.0];
const MIN_AMBIENT = 0.08;
```

c) Add a helper that samples vertex light. Place this above `meshChunk`:

```ts
type LightSample = { sky: number; r: number; g: number; b: number };

/**
 * Sample the 4 voxels that meet at a corner of a cube face. Returns the averaged
 * (sky, r, g, b) light values of those 4 voxels. `cornerX/Y/Z` is the world position
 * of the corner itself (integer offsets for the corner of the cube grid). `normal`
 * points outward from the face.
 */
function sampleCornerLight(
	chunk: Chunk,
	neighbors: Neighbors,
	cornerX: number,
	cornerY: number,
	cornerZ: number,
	nx: number,
	ny: number,
	nz: number,
): LightSample {
	// The 4 voxels touching this corner are the 8 voxels around the corner, filtered
	// to those on the outward side of the face. For an axis-aligned cube face with
	// outward normal (nx, ny, nz), those are the 4 voxels at:
	//   corner + (-? * (1 - |nx|), -? * (1 - |ny|), -? * (1 - |nz|)) + (0 or -1 per non-normal axis)
	// Simpler expression: iterate all 8 voxels around the corner; keep those whose
	// relative offset along the normal axis is -1 (inside the neighbor of the face).
	let sumSky = 0, sumR = 0, sumG = 0, sumB = 0, count = 0;
	for (let dx = -1; dx <= 0; dx++) {
		for (let dy = -1; dy <= 0; dy++) {
			for (let dz = -1; dz <= 0; dz++) {
				// Skip the 4 voxels on the inside of the face (opposite to the normal).
				if (nx === 1 && dx !== 0) continue;
				if (nx === -1 && dx !== -1) continue;
				if (ny === 1 && dy !== 0) continue;
				if (ny === -1 && dy !== -1) continue;
				if (nz === 1 && dz !== 0) continue;
				if (nz === -1 && dz !== -1) continue;
				const vx = cornerX + dx;
				const vy = cornerY + dy;
				const vz = cornerZ + dz;
				const sample = readLight(chunk, neighbors, vx, vy, vz);
				sumSky += sample.sky;
				sumR += sample.r;
				sumG += sample.g;
				sumB += sample.b;
				count++;
			}
		}
	}
	if (count === 0) return { sky: 0, r: 0, g: 0, b: 0 };
	return {
		sky: sumSky / count,
		r: sumR / count,
		g: sumG / count,
		b: sumB / count,
	};
}

function readLight(chunk: Chunk, neighbors: Neighbors, x: number, y: number, z: number): LightSample {
	if (y < 0 || y >= CHUNK_SIZE_Y) return { sky: 0, r: 0, g: 0, b: 0 };
	const inX = x >= 0 && x < CHUNK_SIZE_X;
	const inZ = z >= 0 && z < CHUNK_SIZE_Z;
	if (inX && inZ) {
		return {
			sky: chunk.getSky(x, y, z),
			r: chunk.getBlockR(x, y, z),
			g: chunk.getBlockG(x, y, z),
			b: chunk.getBlockB(x, y, z),
		};
	}
	let target: Chunk | undefined;
	let lx = x, lz = z;
	if (x >= CHUNK_SIZE_X) { target = neighbors.px; lx = 0; }
	else if (x < 0) { target = neighbors.nx; lx = CHUNK_SIZE_X - 1; }
	else if (z >= CHUNK_SIZE_Z) { target = neighbors.pz; lz = 0; }
	else if (z < 0) { target = neighbors.nz; lz = CHUNK_SIZE_Z - 1; }
	if (!target) return { sky: 0, r: 0, g: 0, b: 0 };
	return {
		sky: target.getSky(lx, y, lz),
		r: target.getBlockR(lx, y, lz),
		g: target.getBlockG(lx, y, lz),
		b: target.getBlockB(lx, y, lz),
	};
}

function lightSampleToRGB(s: LightSample): [number, number, number] {
	const skyScale = s.sky / 15;
	const blockR = s.r / 15;
	const blockG = s.g / 15;
	const blockB = s.b / 15;
	let r = SKY_COLOR[0] * skyScale + blockR + MIN_AMBIENT;
	let g = SKY_COLOR[1] * skyScale + blockG + MIN_AMBIENT;
	let b = SKY_COLOR[2] * skyScale + blockB + MIN_AMBIENT;
	if (r > 1) r = 1;
	if (g > 1) g = 1;
	if (b > 1) b = 1;
	return [r, g, b];
}
```

d) In `meshChunk`, initialize a `colors: number[]` array alongside the others, and in the per-face-per-corner loop, compute and push color values. The existing per-corner loop writes positions and normals; add color writes:

```ts
	const positions: number[] = [];
	const normals: number[] = [];
	const uvs: number[] = [];
	const colors: number[] = [];
	const indices: number[] = [];
	let vcount = 0;
```

And inside `for (let i = 0; i < 4; i++) { ... }`:

```ts
	for (let i = 0; i < 4; i++) {
		const [ox, oy, oz] = f.corners[i];
		const [ui, vi] = f.uvs[i];
		positions.push(x + ox, y + oy, z + oz);
		normals.push(f.normal[0], f.normal[1], f.normal[2]);
		uvs.push(ui === 0 ? u0 : u1, vi === 0 ? v0 : v1);
		const sample = sampleCornerLight(chunk, neighbors, x + ox, y + oy, z + oz, f.normal[0], f.normal[1], f.normal[2]);
		const [cr, cg, cb] = lightSampleToRGB(sample);
		colors.push(cr, cg, cb);
	}
```

Update the return statement:

```ts
	return {
		positions: new Float32Array(positions),
		normals: new Float32Array(normals),
		uvs: new Float32Array(uvs),
		colors: new Float32Array(colors),
		indices: new Uint32Array(indices),
	};
```

Also ensure `import { CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z } from './coords';` exists (Y is needed by readLight).

- [ ] **Step 4: Update renderer to tolerate the new attribute**

In `src/engine/render/renderer.ts`, find the `mountChunkMesh` method. It currently only sets `position`, `normal`, `uv`, `index` on the buffer geometry. Add a color attribute write alongside them:

```ts
	g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
	g.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
	g.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2));
	g.setAttribute('color', new THREE.BufferAttribute(mesh.colors, 3));
	g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
```

(The material doesn't use `vertexColors: true` yet, so the color attribute is inert. Task 11 flips the switch.)

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/engine/world/mesher.ts src/engine/world/mesher.test.ts src/engine/render/renderer.ts
git commit -m "$(cat <<'EOF'
feat(mesher): per-vertex color attribute from chunk lightmap

Mesher now samples the 4 voxels around each face-corner and averages
their (skyLight, blockR, blockG, blockB) values. Combined with
SKY_COLOR (0.9, 0.95, 1.0) and MIN_AMBIENT (0.08), produces an RGB
per vertex written to a new `colors: Float32Array` attribute on
ChunkMesh. Renderer writes it to the BufferGeometry but the material
(still MeshLambertMaterial without vertexColors) does not yet consume
it. The material swap lands in a later task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9 — Mesher AO darkening

**Files:**
- Modify: `src/engine/world/mesher.ts`
- Modify: `src/engine/world/mesher.test.ts`

**Context:** For each face corner, inspect the two edge-adjacent voxels and the diagonal voxel on the outward side of the face. If both edge voxels are opaque (`lightFilter ≥ 15` and non-liquid), multiply the corner's computed color by 0.75. If the diagonal is also opaque, use 0.6 instead. Classic Minecraft AO.

- [ ] **Step 1: Write failing test**

Append to `src/engine/world/mesher.test.ts`:

```ts
describe('meshChunk — ambient occlusion', () => {
	it('vertex adjacent to two solid neighbors is darker than one with zero', () => {
		const w = new World(1);
		const c = w.ensureChunk(0, 0);
		c.blocks.fill(0);
		// Inner corner: a block at (5,30,5) with neighbors at (6,30,5) and (5,30,6).
		// The top face of (5,30,5) at corner (6,31,6) sees both outward-adjacent voxels solid.
		c.blocks[indexOf(5, 30, 5)] = BLOCK_BY_NAME['stone'].id;
		c.blocks[indexOf(6, 30, 5)] = BLOCK_BY_NAME['stone'].id;
		c.blocks[indexOf(5, 30, 6)] = BLOCK_BY_NAME['stone'].id;
		fillChunkLights(w, c);
		const mesh = meshChunk(c, w.neighbors(c), (id, face) => [0, 0, 1, 1]);
		// Top face of (5,30,5) has 4 corners; check each corner's RGB.
		// Find top-face vertices of (5,30,5) — those with position (5|6, 31, 5|6).
		const verts: { pos: [number, number, number]; rgb: [number, number, number] }[] = [];
		for (let i = 0; i < mesh.positions.length; i += 3) {
			const px = mesh.positions[i], py = mesh.positions[i + 1], pz = mesh.positions[i + 2];
			const ny = mesh.normals[i + 1];
			if (ny > 0.9 && Math.floor(px) >= 5 && Math.floor(px) <= 6 && py === 31 && Math.floor(pz) >= 5 && Math.floor(pz) <= 6) {
				verts.push({ pos: [px, py, pz], rgb: [mesh.colors[i], mesh.colors[i + 1], mesh.colors[i + 2]] });
			}
		}
		// Corner at (6, 31, 6) — both adjacent voxels (6,30,5) and (5,30,6) are solid — should be darkest.
		const cornerWithAO = verts.find((v) => v.pos[0] === 6 && v.pos[2] === 6);
		const cornerWithoutAO = verts.find((v) => v.pos[0] === 5 && v.pos[2] === 5);
		expect(cornerWithAO).toBeDefined();
		expect(cornerWithoutAO).toBeDefined();
		const sumAO = cornerWithAO!.rgb.reduce((a, b) => a + b, 0);
		const sumNoAO = cornerWithoutAO!.rgb.reduce((a, b) => a + b, 0);
		expect(sumAO).toBeLessThan(sumNoAO);
	});
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -- src/engine/world/mesher.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement AO darkening**

In `src/engine/world/mesher.ts`, update `sampleCornerLight` (or add a companion helper) to also compute an AO factor. Adjust `meshChunk` to multiply the final RGB by the AO factor. Minimal addition:

```ts
function aoFactorForCorner(
	chunk: Chunk,
	neighbors: Neighbors,
	cornerX: number,
	cornerY: number,
	cornerZ: number,
	nx: number,
	ny: number,
	nz: number,
): number {
	// For a face with outward normal (nx, ny, nz), the two "edge-adjacent" voxels for a
	// given corner are the two non-normal-axis neighbors on the outward side. The
	// "diagonal" voxel is the one neighbor that shares an edge with both. We inspect
	// whether each of these is opaque (filter >= 15 AND not a liquid).
	// Enumerate the 3 outward voxels by isolating the two non-normal axes.
	const axisNormal = Math.abs(nx) > 0 ? 0 : Math.abs(ny) > 0 ? 1 : 2;
	// The 2 edge-adjacent voxels live on the outward side, offset by -1 along ONE
	// non-normal axis (not both).
	const outSign = (nx + ny + nz) > 0 ? 0 : -1;
	const offsets: [number, number, number][] = [];
	for (let a = 0; a < 3; a++) {
		if (a === axisNormal) continue;
		// edge-adjacent voxel 1 (shift by -1 along axis a)
		// edge-adjacent voxel 2 (shift by 0 along axis a) — wait, we want corner's two adjacent voxels.
		// The correct voxels depend on the corner's position relative to the face's center.
		// Simpler: enumerate 4 voxels on the outward side of the corner (as in sampleCornerLight)
		// and classify them: exactly 1 is "diagonal" (offset from face cell by -1 on BOTH non-normal
		// axes). The other 2 are "edge-adjacent" (offset by -1 on ONE non-normal axis). The 4th is
		// the face cell's own outward neighbor.
	}
	// The deterministic listing:
	type V = { x: number; y: number; z: number; kind: 'edge' | 'diag' | 'face' };
	const vox: V[] = [];
	for (let dx = -1; dx <= 0; dx++) {
		for (let dy = -1; dy <= 0; dy++) {
			for (let dz = -1; dz <= 0; dz++) {
				if (nx === 1 && dx !== 0) continue;
				if (nx === -1 && dx !== -1) continue;
				if (ny === 1 && dy !== 0) continue;
				if (ny === -1 && dy !== -1) continue;
				if (nz === 1 && dz !== 0) continue;
				if (nz === -1 && dz !== -1) continue;
				// Classify by how many non-normal axes are shifted (-1) vs unshifted (0).
				let shiftedNonNormal = 0;
				if (axisNormal !== 0 && dx === -1) shiftedNonNormal++;
				if (axisNormal !== 1 && dy === -1) shiftedNonNormal++;
				if (axisNormal !== 2 && dz === -1) shiftedNonNormal++;
				let kind: V['kind'];
				if (shiftedNonNormal === 0) kind = 'face';
				else if (shiftedNonNormal === 1) kind = 'edge';
				else kind = 'diag';
				vox.push({ x: cornerX + dx, y: cornerY + dy, z: cornerZ + dz, kind });
			}
		}
	}
	const isOpaque = (v: V) => {
		const id = readBlockId(chunk, neighbors, v.x, v.y, v.z);
		const def = BLOCKS[id];
		return !!def && def.lightFilter >= 15 && def.liquid === 'none';
	};
	let edgeCount = 0;
	let diagOpaque = false;
	for (const v of vox) {
		if (v.kind === 'edge' && isOpaque(v)) edgeCount++;
		if (v.kind === 'diag' && isOpaque(v)) diagOpaque = true;
	}
	if (edgeCount >= 2) {
		return diagOpaque ? 0.6 : 0.75;
	}
	return 1.0;
}

function readBlockId(chunk: Chunk, neighbors: Neighbors, x: number, y: number, z: number): number {
	if (y < 0 || y >= CHUNK_SIZE_Y) return 0;
	const inX = x >= 0 && x < CHUNK_SIZE_X;
	const inZ = z >= 0 && z < CHUNK_SIZE_Z;
	if (inX && inZ) return chunk.blocks[indexOf(x, y, z)];
	if (x >= CHUNK_SIZE_X) return neighbors.px?.blocks[indexOf(0, y, z)] ?? 0;
	if (x < 0) return neighbors.nx?.blocks[indexOf(CHUNK_SIZE_X - 1, y, z)] ?? 0;
	if (z >= CHUNK_SIZE_Z) return neighbors.pz?.blocks[indexOf(x, y, 0)] ?? 0;
	if (z < 0) return neighbors.nz?.blocks[indexOf(x, y, CHUNK_SIZE_Z - 1)] ?? 0;
	return 0;
}
```

Then in `meshChunk`'s per-corner loop, multiply the RGB by the AO factor:

```ts
	const sample = sampleCornerLight(chunk, neighbors, x + ox, y + oy, z + oz, f.normal[0], f.normal[1], f.normal[2]);
	const [cr, cg, cb] = lightSampleToRGB(sample);
	const ao = aoFactorForCorner(chunk, neighbors, x + ox, y + oy, z + oz, f.normal[0], f.normal[1], f.normal[2]);
	colors.push(cr * ao, cg * ao, cb * ao);
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/world/mesher.ts src/engine/world/mesher.test.ts
git commit -m "$(cat <<'EOF'
feat(mesher): ambient occlusion darkening per vertex corner

Each face corner inspects the 4 voxels touching it. Edge-adjacent
opaque voxels (two of them) darken the corner by 0.75; if the
diagonal is also opaque, 0.6 instead. Produces the classic
Minecraft inset-corner look where blocks meet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10 — Split mesher output into opaque + liquid; emit liquid face pass

**Files:**
- Modify: `src/engine/world/mesher.ts`
- Modify: `src/engine/world/mesher.test.ts`
- Modify: `src/engine/render/renderer.ts`
- Modify: `src/game/loop.ts` (callers of mesh output)

**Context:** Mesher now returns `{ opaque: ChunkMesh, liquid: ChunkMesh | null }`. Renderer mounts BOTH meshes — opaque with the existing material (for now; Task 11 swaps it), liquid with a transparent material. The liquid pass only emits faces where neighbor is AIR or a different liquid (lower-id-wins rule prevents double-faced boundaries).

- [ ] **Step 1: Write failing test**

Append to `src/engine/world/mesher.test.ts`:

```ts
describe('meshChunk — opaque + liquid split', () => {
	it('returns an object with opaque and liquid meshes', () => {
		const w = new World(1);
		const c = w.ensureChunk(0, 0);
		c.blocks.fill(0);
		c.blocks[indexOf(5, 30, 5)] = BLOCK_BY_NAME['stone'].id;
		c.blocks[indexOf(5, 31, 5)] = BLOCK_BY_NAME['water'].id;
		fillChunkLights(w, c);
		const result = meshChunk(c, w.neighbors(c), (id, face) => [0, 0, 1, 1]);
		expect(result.opaque).toBeDefined();
		expect(result.liquid).toBeDefined();
		expect(result.opaque.positions.length).toBeGreaterThan(0);
		expect(result.liquid!.positions.length).toBeGreaterThan(0);
	});

	it('water-water adjacency emits no face; water-air emits the water face', () => {
		const w = new World(1);
		const c = w.ensureChunk(0, 0);
		c.blocks.fill(0);
		c.blocks[indexOf(5, 30, 5)] = BLOCK_BY_NAME['water'].id;
		c.blocks[indexOf(6, 30, 5)] = BLOCK_BY_NAME['water'].id;
		fillChunkLights(w, c);
		const result = meshChunk(c, w.neighbors(c), (id, face) => [0, 0, 1, 1]);
		// Water outer surface (facing air) renders; internal face (water-water) does not.
		// Total liquid faces should be: 2 blocks × 6 faces - 2 shared faces = 10 faces = 40 vertices = 120 position values.
		expect(result.liquid).not.toBeNull();
		expect(result.liquid!.positions.length).toBe(120);
	});
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -- src/engine/world/mesher.test.ts`
Expected: FAIL (return shape doesn't match).

- [ ] **Step 3: Update mesher return shape**

In `src/engine/world/mesher.ts`, rename the existing return shape and add the wrapper:

```ts
export type ChunkMeshResult = {
	opaque: ChunkMesh;
	liquid: ChunkMesh | null;
};

export function meshChunk(chunk: Chunk, neighbors: Neighbors, uvFor: UvFn): ChunkMeshResult {
	// ...existing opaque-pass code becomes the opaque mesh builder...
	const opaque = buildOpaqueMesh(chunk, neighbors, uvFor);
	const liquid = buildLiquidMesh(chunk, neighbors, uvFor);
	return { opaque, liquid };
}
```

Refactor the existing body into a `buildOpaqueMesh` function (same logic, returning `ChunkMesh`). The `shouldEmitFace` rule stays unchanged — it already correctly emits solid-adjacent-to-air faces and skips solid-adjacent-to-solid.

Add `buildLiquidMesh`:

```ts
function buildLiquidMesh(chunk: Chunk, neighbors: Neighbors, uvFor: UvFn): ChunkMesh | null {
	const positions: number[] = [];
	const normals: number[] = [];
	const uvs: number[] = [];
	const colors: number[] = [];
	const indices: number[] = [];
	let vcount = 0;

	for (let y = 0; y < CHUNK_SIZE_Y; y++) {
		for (let z = 0; z < CHUNK_SIZE_Z; z++) {
			for (let x = 0; x < CHUNK_SIZE_X; x++) {
				const here = chunk.get(x, y, z);
				if (!isLiquid(here)) continue;
				for (const face of FACE_ORDER) {
					const f = FACES[face];
					const there = readBlockId(chunk, neighbors, x + f.dx, y + f.dy, z + f.dz);
					let emit = false;
					if (there === 0) emit = true;
					else if (isLiquid(there) && there !== here && here < there) emit = true;
					if (!emit) continue;

					const [u0, v0, u1, v1] = uvFor(here, face);
					for (let i = 0; i < 4; i++) {
						const [ox, oy, oz] = f.corners[i];
						const [ui, vi] = f.uvs[i];
						positions.push(x + ox, y + oy, z + oz);
						normals.push(f.normal[0], f.normal[1], f.normal[2]);
						uvs.push(ui === 0 ? u0 : u1, vi === 0 ? v0 : v1);
						const sample = sampleCornerLight(chunk, neighbors, x + ox, y + oy, z + oz, f.normal[0], f.normal[1], f.normal[2]);
						const [cr, cg, cb] = lightSampleToRGB(sample);
						colors.push(cr, cg, cb);
					}
					indices.push(vcount, vcount + 1, vcount + 2, vcount, vcount + 2, vcount + 3);
					vcount += 4;
				}
			}
		}
	}

	if (indices.length === 0) return null;
	return {
		positions: new Float32Array(positions),
		normals: new Float32Array(normals),
		uvs: new Float32Array(uvs),
		colors: new Float32Array(colors),
		indices: new Uint32Array(indices),
	};
}
```

Add the `isLiquid` import at the top of the file:

```ts
import { isSolid, isTransparent, isLiquid } from '../../data/blocks.data';
```

- [ ] **Step 4: Update renderer's `mountChunkMesh`**

In `src/engine/render/renderer.ts`, change the method signature to accept the split. Also introduce a liquid material + a second registry:

```ts
	private chunkMeshes = new Map<string, THREE.Mesh>();          // opaque
	private liquidMeshes = new Map<string, THREE.Mesh>();         // liquid
	readonly material: THREE.Material;                            // opaque material
	readonly liquidMaterial: THREE.Material;                      // liquid material
```

In the constructor, after the existing `this.material = new THREE.MeshLambertMaterial(...)`:

```ts
	this.liquidMaterial = new THREE.MeshLambertMaterial({
		map: atlas.texture,
		transparent: true,
		depthWrite: false,
		side: THREE.DoubleSide,
		alphaTest: 0.01,  // tiny alphaTest so fully-transparent atlas padding doesn't render
	});
```

(Final swap to `MeshBasicMaterial` + `vertexColors: true` happens in Task 11.)

Replace `mountChunkMesh` signature and body:

```ts
	mountChunkMesh(chunk: Chunk, meshResult: ChunkMeshResult): void {
		const k = `${chunk.cx},${chunk.cz}`;

		// Opaque
		const existingOpaque = this.chunkMeshes.get(k);
		if (existingOpaque) {
			this.chunkGroup.remove(existingOpaque);
			(existingOpaque.geometry as THREE.BufferGeometry).dispose();
			this.chunkMeshes.delete(k);
		}
		if (meshResult.opaque.indices.length > 0) {
			const g = new THREE.BufferGeometry();
			g.setAttribute('position', new THREE.BufferAttribute(meshResult.opaque.positions, 3));
			g.setAttribute('normal', new THREE.BufferAttribute(meshResult.opaque.normals, 3));
			g.setAttribute('uv', new THREE.BufferAttribute(meshResult.opaque.uvs, 2));
			g.setAttribute('color', new THREE.BufferAttribute(meshResult.opaque.colors, 3));
			g.setIndex(new THREE.BufferAttribute(meshResult.opaque.indices, 1));
			g.computeBoundingSphere();
			const m = new THREE.Mesh(g, this.material);
			m.position.set(chunk.cx * 16, 0, chunk.cz * 16);
			m.castShadow = true;
			m.receiveShadow = true;
			this.chunkGroup.add(m);
			this.chunkMeshes.set(k, m);
		}

		// Liquid
		const existingLiquid = this.liquidMeshes.get(k);
		if (existingLiquid) {
			this.chunkGroup.remove(existingLiquid);
			(existingLiquid.geometry as THREE.BufferGeometry).dispose();
			this.liquidMeshes.delete(k);
		}
		if (meshResult.liquid && meshResult.liquid.indices.length > 0) {
			const g = new THREE.BufferGeometry();
			g.setAttribute('position', new THREE.BufferAttribute(meshResult.liquid.positions, 3));
			g.setAttribute('normal', new THREE.BufferAttribute(meshResult.liquid.normals, 3));
			g.setAttribute('uv', new THREE.BufferAttribute(meshResult.liquid.uvs, 2));
			g.setAttribute('color', new THREE.BufferAttribute(meshResult.liquid.colors, 3));
			g.setIndex(new THREE.BufferAttribute(meshResult.liquid.indices, 1));
			g.computeBoundingSphere();
			const m = new THREE.Mesh(g, this.liquidMaterial);
			m.position.set(chunk.cx * 16, 0, chunk.cz * 16);
			this.chunkGroup.add(m);
			this.liquidMeshes.set(k, m);
		}
	}
```

Add the import for `ChunkMeshResult` at the top:

```ts
import type { ChunkMeshResult } from '../world/mesher';
```

- [ ] **Step 5: Update loop caller**

In `src/game/loop.ts`, the `flushDirtyChunks` method currently calls `meshChunk(...)` and passes it to `mountChunkMesh`. Update to pass the whole result:

```ts
	const c = this.world.ensureChunk(cx, cz);
	const result = meshChunk(c, this.world.neighbors(c), this.uvFor);
	this.renderer.mountChunkMesh(c, result);
```

No other change — `meshChunk` already returns the new shape.

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Run build (type-check)**

Run: `npm run build`
Expected: success.

- [ ] **Step 8: Commit**

```bash
git add src/engine/world/mesher.ts src/engine/world/mesher.test.ts src/engine/render/renderer.ts src/game/loop.ts
git commit -m "$(cat <<'EOF'
feat(mesher): split output into opaque + liquid meshes

meshChunk now returns { opaque, liquid }. Opaque pass is unchanged.
Liquid pass emits faces only where neighbor is AIR or a different
liquid (lower-id side wins to prevent double-faced boundaries).
Renderer mounts both via a second liquid-material pass (transparent,
depthWrite: false). Opaque material still MeshLambertMaterial — the
vertex-color swap lands next.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11 — Swap to MeshBasicMaterial + vertexColors; delete sun/ambient/shadow

**Files:**
- Modify: `src/engine/render/renderer.ts`
- Modify: `src/game/loop.ts` (remove setSunTarget call)

**Context:** Flip the lighting source. The per-vertex color attribute already exists and already encodes the correct illumination. Swap opaque + liquid materials to `MeshBasicMaterial({ vertexColors: true })`. Delete the directional light, ambient light, shadow map config, `setSunTarget` method, and per-mesh `castShadow`/`receiveShadow`. After this task, the scene is lit entirely by voxel lights.

- [ ] **Step 1: Update `Renderer` constructor and material**

In `src/engine/render/renderer.ts`:

a) Remove sun-related code. Delete these lines / blocks:

```ts
// DELETE: the SUN_OFFSET constant at top
const SUN_OFFSET: [number, number, number] = [53, 80, 27];

// DELETE: private sun field
private sun: THREE.DirectionalLight;

// DELETE: shadowMap enabling + type setting
this.gl.shadowMap.enabled = true;
this.gl.shadowMap.type = THREE.PCFShadowMap;

// DELETE: the whole AmbientLight + DirectionalLight setup block (amb, sun, sun.shadow.*, scene.add(amb, sun, sun.target))

// DELETE: the setSunTarget method entirely
```

b) Replace materials with `MeshBasicMaterial`:

```ts
	this.material = new THREE.MeshBasicMaterial({
		map: atlas.texture,
		alphaTest: 0.5,
		vertexColors: true,
		side: THREE.FrontSide,
	});

	this.liquidMaterial = new THREE.MeshBasicMaterial({
		map: atlas.texture,
		vertexColors: true,
		transparent: true,
		depthWrite: false,
		side: THREE.DoubleSide,
		alphaTest: 0.01,
	});
```

c) In `mountChunkMesh`, remove `m.castShadow = true; m.receiveShadow = true;` lines.

- [ ] **Step 2: Remove sun-target call from loop**

In `src/game/loop.ts`, in the `tick` method, delete this line:

```ts
// DELETE:
this.renderer.setSunTarget(this.player.position[0], this.player.position[1], this.player.position[2]);
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: all pass (no test inspects sun/ambient state directly).

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: success.

- [ ] **Step 5: Manual smoke verification**

Run: `npm run dev`
Expected: game loads, the world is visible, lit by the vertex colors only. Sky is blue (still in the `scene.background`). Caves (if any) will be dark once world-gen places them later; for now, under any overhangs you'll see the attenuation from the skylight BFS. No runtime errors in the console about missing `sun` or undefined methods.

Close the dev server before moving on.

- [ ] **Step 6: Commit**

```bash
git add src/engine/render/renderer.ts src/game/loop.ts
git commit -m "$(cat <<'EOF'
refactor(render): replace shadow map + directional sun with voxel-light vertex colors

MeshBasicMaterial with vertexColors: true reads lighting directly from
the chunk mesh's color attribute. Sun, ambient, shadow map, and the
per-mesh castShadow/receiveShadow flags are deleted. setSunTarget
method removed. Scene background stays sky-blue via the existing
scene.background Color.

Caves can now genuinely go dark without the shadow-map seam artifacts
that motivated this rewrite.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12 — Flatter world-gen heightmap

**Files:**
- Modify: `src/engine/world/generation.ts`
- Modify: `src/engine/world/generation.test.ts`

**Context:** Change the heightmap constants: `MIN_H=24, MAX_H=34, NOISE_SCALE=1/64`. Introduce `SEA_LEVEL=28`. Water fill + sand shoreline come in Task 13.

- [ ] **Step 1: Write failing tests**

Append to `src/engine/world/generation.test.ts`:

```ts
describe('generateChunk — flatter terrain', () => {
	it('heightmap values fall within the new range [24, 34]', () => {
		const c = new Chunk(5, 5);
		generateChunk(c, 42);
		const tops = new Set<number>();
		for (let lx = 0; lx < 16; lx++) {
			for (let lz = 0; lz < 16; lz++) {
				for (let y = 63; y >= 0; y--) {
					if (c.blocks[y * 16 * 16 + lz * 16 + lx] !== 0) {
						tops.add(y);
						break;
					}
				}
			}
		}
		for (const t of tops) {
			expect(t).toBeGreaterThanOrEqual(24);
			expect(t).toBeLessThanOrEqual(34);
		}
	});
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -- src/engine/world/generation.test.ts`
Expected: FAIL (current range is [20, 50]).

- [ ] **Step 3: Update constants**

In `src/engine/world/generation.ts`, replace the constants at the top:

```ts
const MIN_H = 24;
const MAX_H = 34;
const NOISE_SCALE = 1 / 64;
export const SEA_LEVEL = 28;
const DIRT_BAND = 3;
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/world/generation.ts src/engine/world/generation.test.ts
git commit -m "$(cat <<'EOF'
feat(worldgen): flatter heightmap + SEA_LEVEL constant

Amplitude reduced from 30 to 10 (MIN_H 24, MAX_H 34). Noise scale
widened to 1/64. Exports SEA_LEVEL=28 for the upcoming water-fill
pass. No water yet — height change only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13 — Sea-level water fill + shoreline sand

**Files:**
- Modify: `src/engine/world/generation.ts`
- Modify: `src/engine/world/generation.test.ts`

**Context:** After the solid-column pass, fill all air voxels at y ∈ (h, SEA_LEVEL] with water when h < SEA_LEVEL. Also: the top block is sand (not grass) when h < SEA_LEVEL (shoreline + underwater flooring).

- [ ] **Step 1: Write failing tests**

Append to `src/engine/world/generation.test.ts`:

```ts
describe('generateChunk — sea-level water fill', () => {
	it('columns with h < SEA_LEVEL get water at y from h+1 to SEA_LEVEL', () => {
		const c = new Chunk(5, 5);
		generateChunk(c, 42);
		const WATER = BLOCK_BY_NAME['water'].id;
		// Find a column where h < SEA_LEVEL (with this new amplitude, many columns qualify).
		let foundLowColumn = false;
		for (let lx = 0; lx < 16 && !foundLowColumn; lx++) {
			for (let lz = 0; lz < 16 && !foundLowColumn; lz++) {
				let h = -1;
				for (let y = 63; y >= 0; y--) {
					const id = c.blocks[y * 16 * 16 + lz * 16 + lx];
					if (id !== 0 && id !== WATER) { h = y; break; }
				}
				if (h >= 0 && h < 28) {
					foundLowColumn = true;
					for (let y = h + 1; y <= 28; y++) {
						expect(c.blocks[y * 16 * 16 + lz * 16 + lx]).toBe(WATER);
					}
					// Above SEA_LEVEL is air.
					for (let y = 29; y < 64; y++) {
						expect(c.blocks[y * 16 * 16 + lz * 16 + lx]).toBe(0);
					}
				}
			}
		}
		expect(foundLowColumn).toBe(true);
	});

	it('columns with h >= SEA_LEVEL have no water', () => {
		const c = new Chunk(5, 5);
		generateChunk(c, 42);
		const WATER = BLOCK_BY_NAME['water'].id;
		for (let lx = 0; lx < 16; lx++) {
			for (let lz = 0; lz < 16; lz++) {
				let h = -1;
				for (let y = 63; y >= 0; y--) {
					const id = c.blocks[y * 16 * 16 + lz * 16 + lx];
					if (id !== 0 && id !== WATER) { h = y; break; }
				}
				if (h >= 28) {
					for (let y = 0; y < 64; y++) {
						expect(c.blocks[y * 16 * 16 + lz * 16 + lx]).not.toBe(WATER);
					}
				}
			}
		}
	});

	it('top block is sand for underwater/shoreline columns, grass otherwise', () => {
		const c = new Chunk(5, 5);
		generateChunk(c, 42);
		const GRASS = BLOCK_BY_NAME['grass_block'].id;
		const SAND = BLOCK_BY_NAME['sand'].id;
		const WATER = BLOCK_BY_NAME['water'].id;
		for (let lx = 0; lx < 16; lx++) {
			for (let lz = 0; lz < 16; lz++) {
				let h = -1;
				for (let y = 63; y >= 0; y--) {
					const id = c.blocks[y * 16 * 16 + lz * 16 + lx];
					if (id !== 0 && id !== WATER) { h = y; break; }
				}
				if (h < 0) continue;
				const top = c.blocks[h * 16 * 16 + lz * 16 + lx];
				if (h < 28) expect(top).toBe(SAND);
				else expect(top).toBe(GRASS);
			}
		}
	});
});
```

(Ensure `BLOCK_BY_NAME` and `Chunk`/`generateChunk` imports are at the top of the file — add if missing.)

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -- src/engine/world/generation.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add water + sand to generation**

In `src/engine/world/generation.ts`, update the imports:

```ts
import { BLOCK_BY_NAME } from '../../data/blocks.data';

const GRASS = BLOCK_BY_NAME['grass_block'].id;
const DIRT = BLOCK_BY_NAME['dirt'].id;
const STONE = BLOCK_BY_NAME['stone'].id;
const SAND = BLOCK_BY_NAME['sand'].id;
const WATER = BLOCK_BY_NAME['water'].id;
```

In the column loop, replace the grass/dirt/stone assignment and add the water-fill loop:

```ts
	for (let lz = 0; lz < CHUNK_SIZE_Z; lz++) {
		for (let lx = 0; lx < CHUNK_SIZE_X; lx++) {
			const wx = baseX + lx;
			const wz = baseZ + lz;
			const n = noise(wx * NOISE_SCALE, wz * NOISE_SCALE);
			const h = Math.floor(MIN_H + (n * 0.5 + 0.5) * (MAX_H - MIN_H));

			for (let y = 0; y <= h; y++) {
				let id: number;
				if (y === h) id = h < SEA_LEVEL ? SAND : GRASS;
				else if (y >= h - DIRT_BAND) id = DIRT;
				else id = STONE;
				chunk.blocks[y * CHUNK_SIZE_X * CHUNK_SIZE_Z + lz * CHUNK_SIZE_X + lx] = id;
			}

			if (h < SEA_LEVEL) {
				for (let y = h + 1; y <= SEA_LEVEL; y++) {
					chunk.blocks[y * CHUNK_SIZE_X * CHUNK_SIZE_Z + lz * CHUNK_SIZE_X + lx] = WATER;
				}
			}
		}
	}
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/engine/world/generation.ts src/engine/world/generation.test.ts
git commit -m "$(cat <<'EOF'
feat(worldgen): fill sub-sea-level air with water + sand shoreline

Columns where heightmap < SEA_LEVEL get water blocks from (h+1) to
SEA_LEVEL inclusive. Their top block is sand instead of grass (grass
doesn't grow underwater). Underground stone is never replaced with
water — solid material below the heightmap stays solid.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14 — Wire `fillChunkLights` into `World.ensureChunk`; update `GameLoop` for incremental light updates

**Files:**
- Modify: `src/engine/world/world.ts`
- Modify: `src/game/loop.ts`

**Context:** With lighting module complete, the world must actually call it. `ensureChunk` runs `fillChunkLights` after generation. `GameLoop.markChunkDirtyAround` gets the chunk set from `updateLightsForBlockChange` folded in. The lookup for lamp colors is injected from `GameLoop`'s `LightRegistry` reference.

- [ ] **Step 1: Extend World.ensureChunk**

In `src/engine/world/world.ts`, import + call `fillChunkLights`:

```ts
import { fillChunkLights } from './lighting';
```

Update `ensureChunk`:

```ts
	ensureChunk(cx: number, cz: number): Chunk {
		const k = key(cx, cz);
		let c = this.chunks.get(k);
		if (!c) {
			c = new Chunk(cx, cz);
			generateChunk(c, this.seed);
			this.chunks.set(k, c);
			fillChunkLights(this, c);   // no getLampColor arg here — lamps are placed AFTER gen.
		}
		return c;
	}
```

(Lamps are placed by the player at runtime; world-gen doesn't emit lamps. So `getLampColor` stays undefined for the gen-time fill. The incremental `updateLightsForBlockChange` call in GameLoop WILL pass a lookup, because by then lamps may exist.)

- [ ] **Step 2: Wire incremental updates in `GameLoop`**

In `src/game/loop.ts`:

a) Add imports:

```ts
import { updateLightsForBlockChange } from '../engine/world/lighting';
```

b) Add a helper method on `GameLoop`:

```ts
	private applyLightUpdate(x: number, y: number, z: number): void {
		const getLampColor = (lx: number, ly: number, lz: number): string | null =>
			this.lights?.getColor(lx, ly, lz) ?? null;
		const touched = updateLightsForBlockChange(this.world, x, y, z, getLampColor);
		for (const c of touched) this.markChunkDirty(c.cx, c.cz);
	}
```

c) Call `this.applyLightUpdate(...)` immediately after every `this.world.setBlock(...)` call in `updateMining` and `detonateAt`. For example, after:

```ts
	this.world.setBlock(target.x, target.y, target.z, AIR);
	this.markChunkDirtyAround(target.x, target.z);
	this.applyLightUpdate(target.x, target.y, target.z);   // NEW
```

And inside the `detonateAt` destroyed loop:

```ts
	for (const { x, y, z } of result.destroyed) {
		if (this.world.getBlock(x, y, z) === LAMP_ID) this.lights?.remove(x, y, z);
		this.world.setBlock(x, y, z, AIR);
		this.markChunkDirtyAround(x, z);
		this.applyLightUpdate(x, y, z);   // NEW
	}
```

d) **Also wire right-click placement** in `src/main.ts`. After `placeBlock(...)` returns `true`, call `loop.applyLightUpdate(...)` on the placed voxel. Search in main.ts for:

```ts
	loop.markChunkDirtyAround(hit.x, hit.z);
	autosave.markDirty();
```

Change to:

```ts
	// Compute the placed voxel (using the same FACE_OFFSET logic already in the file).
	const FACE_OFFSET: Record<string, [number, number, number]> = {
		px: [1, 0, 0], nx: [-1, 0, 0],
		py: [0, 1, 0], ny: [0, -1, 0],
		pz: [0, 0, 1], nz: [0, 0, -1],
	};
	const [dx, dy, dz] = FACE_OFFSET[hit.face];
	const placedX = hit.x + dx, placedY = hit.y + dy, placedZ = hit.z + dz;
	// ... keep the existing lamp-handling code that uses placedX/Y/Z ...
	loop.markChunkDirtyAround(hit.x, hit.z);
	loop.applyLightUpdate(placedX, placedY, placedZ);
	autosave.markDirty();
```

(Make `applyLightUpdate` a public method on `GameLoop` so main.ts can call it.)

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: success.

- [ ] **Step 5: Manual smoke verification**

Run: `npm run dev`
Expected: the world loads lit by voxel lights. Under a cliff, fewer skylight levels → slightly darker. Place a lamp → it illuminates a sphere of voxels. Mine the lamp → the illuminated region goes back to sky-lit (or dark, if underground). No console errors.

- [ ] **Step 6: Commit**

```bash
git add src/engine/world/world.ts src/game/loop.ts src/main.ts
git commit -m "$(cat <<'EOF'
feat(integration): call fillChunkLights on gen, incremental update on block change

World.ensureChunk now flood-fills lights right after generating a chunk.
GameLoop's mine/place/TNT paths call updateLightsForBlockChange and
enqueue the returned chunks for re-mesh so lighting stays consistent.
Lamp color lookup is piped through via a closure over the existing
LightRegistry. Placement path in main.ts similarly updates lights.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15 — `LiquidScheduler` skeleton + fall rule

**Files:**
- Create: `src/game/liquid-scheduler.ts`
- Create: `src/game/liquid-scheduler.test.ts`

**Context:** Scheduler class with `constructor(world, onChunkDirty)` and `tick(dt)`. Internal accumulator fires at 2 Hz. This task covers: class, tick accumulator, frontier iteration, and the fall rule only. Sideways-spread comes in Task 16.

- [ ] **Step 1: Write failing tests**

Create `src/game/liquid-scheduler.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { World } from '../engine/world/world';
import { BLOCK_BY_NAME, AIR } from '../data/blocks.data';
import { LiquidScheduler } from './liquid-scheduler';

const water = BLOCK_BY_NAME['water'].id;
const stone = BLOCK_BY_NAME['stone'].id;

function freshWorld(): World {
	const w = new World(1);
	const c = w.ensureChunk(16, 16); // a chunk near (256, 256) where we'll place test blocks
	c.blocks.fill(AIR);
	c.lights.fill(0);
	c.liquidFrontier.clear();
	return w;
}

describe('LiquidScheduler — tick accumulator', () => {
	it('tick(0.4) does not fire', () => {
		const w = freshWorld();
		w.setBlock(260, 30, 260, water);
		// Air below so the block would fall.
		const s = new LiquidScheduler(w, () => {});
		s.tick(0.4);
		expect(w.getBlock(260, 30, 260)).toBe(water);
		expect(w.getBlock(260, 29, 260)).toBe(AIR);
	});

	it('tick(0.6) fires once', () => {
		const w = freshWorld();
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		s.tick(0.6);
		expect(w.getBlock(260, 30, 260)).toBe(AIR);
		expect(w.getBlock(260, 29, 260)).toBe(water);
	});

	it('tick(1.2) fires once, not twice (no catch-up)', () => {
		const w = freshWorld();
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		s.tick(1.2);
		// Fell from 30 -> 29 in one fire. Should still be at 29, not 28.
		expect(w.getBlock(260, 29, 260)).toBe(water);
		expect(w.getBlock(260, 28, 260)).toBe(AIR);
	});
});

describe('LiquidScheduler — fall rule', () => {
	it('unsupported liquid block falls by 1 voxel per tick', () => {
		const w = freshWorld();
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		s.tick(0.6);
		expect(w.getBlock(260, 29, 260)).toBe(water);
		expect(w.getBlock(260, 30, 260)).toBe(AIR);
	});

	it('liquid with solid below does not fall', () => {
		const w = freshWorld();
		w.setBlock(260, 29, 260, stone);
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		s.tick(0.6);
		expect(w.getBlock(260, 30, 260)).toBe(water);
	});

	it('liquid with same-type liquid below does not fall', () => {
		const w = freshWorld();
		w.setBlock(260, 29, 260, water);
		w.setBlock(260, 30, 260, water);
		// For this test we need the top to not fall — but it wouldn't, since water-below supports.
		const s = new LiquidScheduler(w, () => {});
		s.tick(0.6);
		expect(w.getBlock(260, 30, 260)).toBe(water);
		expect(w.getBlock(260, 29, 260)).toBe(water);
	});
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -- src/game/liquid-scheduler.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create the scheduler module (fall-only for this task)**

Create `src/game/liquid-scheduler.ts`:

```ts
import type { World } from '../engine/world/world';
import type { Chunk } from '../engine/world/chunk';
import { AIR, isLiquid } from '../data/blocks.data';
import { CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z, indexOf } from '../engine/world/coords';

const TICK_INTERVAL = 0.5;

type PendingWrite = { x: number; y: number; z: number; id: number };

export class LiquidScheduler {
	private accumulator = 0;

	constructor(
		private world: World,
		private onChunkDirty: (cx: number, cz: number) => void,
	) {}

	tick(dt: number): void {
		this.accumulator += dt;
		if (this.accumulator < TICK_INTERVAL) return;
		this.accumulator = 0; // no catch-up; discard overflow
		this.applyFlowStep();
	}

	private applyFlowStep(): void {
		const chunks = this.loadedChunks();
		const snapshot: { x: number; y: number; z: number }[] = [];
		for (const c of chunks) {
			const baseX = c.cx * CHUNK_SIZE_X;
			const baseZ = c.cz * CHUNK_SIZE_Z;
			for (const idx of c.liquidFrontier) {
				const y = Math.floor(idx / (CHUNK_SIZE_X * CHUNK_SIZE_Z));
				const rem = idx - y * CHUNK_SIZE_X * CHUNK_SIZE_Z;
				const lz = Math.floor(rem / CHUNK_SIZE_X);
				const lx = rem - lz * CHUNK_SIZE_X;
				snapshot.push({ x: baseX + lx, y, z: baseZ + lz });
			}
		}

		const pending: PendingWrite[] = [];
		for (const { x, y, z } of snapshot) {
			const here = this.world.getBlock(x, y, z);
			if (!isLiquid(here)) continue;
			// Fall rule: if directly below is air, move down by 1.
			if (y > 0) {
				const below = this.world.getBlock(x, y - 1, z);
				if (below === AIR) {
					pending.push({ x, y, z, id: AIR });
					pending.push({ x, y: y - 1, z, id: here });
					continue;
				}
			}
		}

		this.commit(pending);
	}

	private commit(pending: PendingWrite[]): void {
		// Dedup: liquid beats air on the same coord.
		const map = new Map<string, number>();
		for (const w of pending) {
			const k = `${w.x},${w.y},${w.z}`;
			const existing = map.get(k);
			if (existing === undefined) map.set(k, w.id);
			else if (existing === AIR && w.id !== AIR) map.set(k, w.id);
		}
		const touchedChunks = new Set<string>();
		for (const [k, id] of map) {
			const [xs, ys, zs] = k.split(',');
			const x = Number(xs), y = Number(ys), z = Number(zs);
			if (this.world.getBlock(x, y, z) === id) continue;
			this.world.setBlock(x, y, z, id);
			const cx = Math.floor(x / CHUNK_SIZE_X);
			const cz = Math.floor(z / CHUNK_SIZE_Z);
			touchedChunks.add(`${cx},${cz}`);
		}
		for (const ck of touchedChunks) {
			const [cxs, czs] = ck.split(',');
			this.onChunkDirty(Number(cxs), Number(czs));
		}
	}

	private loadedChunks(): Chunk[] {
		const result: Chunk[] = [];
		// World doesn't expose iteration over chunks today. We add an iterator below.
		for (const c of this.world.allChunks()) result.push(c);
		return result;
	}
}
```

- [ ] **Step 4: Add `World.allChunks()` iterator**

In `src/engine/world/world.ts`, add:

```ts
	*allChunks(): Iterable<Chunk> {
		for (const c of this.chunks.values()) yield c;
	}
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/game/liquid-scheduler.ts src/game/liquid-scheduler.test.ts src/engine/world/world.ts
git commit -m "$(cat <<'EOF'
feat(liquid): LiquidScheduler with 2Hz tick + fall rule

Class ticks every 0.5s. Iterates loaded-chunk liquid frontier sets,
applies fall rule (if below is air, move down by 1), commits writes
with liquid-beats-air dedup. Sideways spread lands next.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16 — `LiquidScheduler` sideways spread + frontier decay

**Files:**
- Modify: `src/game/liquid-scheduler.ts`
- Modify: `src/game/liquid-scheduler.test.ts`

**Context:** Add the else-branch of the flow rule: if the liquid can't fall (below is not air), spread sideways to any air neighbor. Also add the frontier decay: if a liquid voxel didn't change this tick AND has no air neighbor, drop it from its chunk's frontier.

- [ ] **Step 1: Write failing tests**

Append to `src/game/liquid-scheduler.test.ts`:

```ts
describe('LiquidScheduler — sideways spread', () => {
	it('liquid with solid below spreads horizontally to adjacent air', () => {
		const w = freshWorld();
		w.setBlock(260, 29, 260, stone);
		w.setBlock(261, 29, 260, stone); // support for the neighbor too
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		s.tick(0.6);
		expect(w.getBlock(261, 30, 260)).toBe(water);
	});

	it('liquid does not spread upward', () => {
		const w = freshWorld();
		w.setBlock(260, 29, 260, stone);
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		s.tick(0.6);
		expect(w.getBlock(260, 31, 260)).toBe(AIR);
	});

	it('fall takes priority over sideways-spread', () => {
		const w = freshWorld();
		// Water mid-air, nothing below, air beside. Expect fall, not sideways.
		w.setBlock(260, 30, 260, water);
		const s = new LiquidScheduler(w, () => {});
		s.tick(0.6);
		expect(w.getBlock(260, 29, 260)).toBe(water);
		expect(w.getBlock(261, 30, 260)).toBe(AIR);
	});

	it('fully-enclosed liquid drops out of the active frontier', () => {
		const w = freshWorld();
		// Water surrounded by stone on all 6 sides.
		w.setBlock(260, 30, 260, water);
		w.setBlock(260, 29, 260, stone);
		w.setBlock(260, 31, 260, stone);
		w.setBlock(259, 30, 260, stone);
		w.setBlock(261, 30, 260, stone);
		w.setBlock(260, 30, 259, stone);
		w.setBlock(260, 30, 261, stone);
		const s = new LiquidScheduler(w, () => {});
		s.tick(0.6);
		const c = w.getChunk(Math.floor(260 / 16), Math.floor(260 / 16))!;
		const lx = 260 % 16, lz = 260 % 16;
		expect(c.liquidFrontier.has(indexOf(lx, 30, lz))).toBe(false);
	});
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -- src/game/liquid-scheduler.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend the scheduler**

In `src/game/liquid-scheduler.ts`, extend `applyFlowStep`:

```ts
	private applyFlowStep(): void {
		const chunks = this.loadedChunks();
		const snapshot: { x: number; y: number; z: number }[] = [];
		for (const c of chunks) {
			const baseX = c.cx * CHUNK_SIZE_X;
			const baseZ = c.cz * CHUNK_SIZE_Z;
			for (const idx of c.liquidFrontier) {
				const y = Math.floor(idx / (CHUNK_SIZE_X * CHUNK_SIZE_Z));
				const rem = idx - y * CHUNK_SIZE_X * CHUNK_SIZE_Z;
				const lz = Math.floor(rem / CHUNK_SIZE_X);
				const lx = rem - lz * CHUNK_SIZE_X;
				snapshot.push({ x: baseX + lx, y, z: baseZ + lz });
			}
		}

		const pending: PendingWrite[] = [];
		for (const { x, y, z } of snapshot) {
			const here = this.world.getBlock(x, y, z);
			if (!isLiquid(here)) continue;
			// Fall
			if (y > 0 && this.world.getBlock(x, y - 1, z) === AIR) {
				pending.push({ x, y, z, id: AIR });
				pending.push({ x, y: y - 1, z, id: here });
				continue;
			}
			// Sideways spread
			const sideDirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
			for (const [dx, dz] of sideDirs) {
				const nx = x + dx, nz = z + dz;
				if (this.world.getBlock(nx, y, nz) === AIR) {
					pending.push({ x: nx, y, z: nz, id: here });
				}
			}
		}

		this.commit(pending);
		this.decayFrontier(chunks);
	}

	private decayFrontier(chunks: Chunk[]): void {
		// Any frontier voxel whose 6 neighbors are all not-air has no available motion;
		// drop it from the frontier so we don't re-examine it next tick.
		for (const c of chunks) {
			const toRemove: number[] = [];
			const baseX = c.cx * CHUNK_SIZE_X;
			const baseZ = c.cz * CHUNK_SIZE_Z;
			for (const idx of c.liquidFrontier) {
				const y = Math.floor(idx / (CHUNK_SIZE_X * CHUNK_SIZE_Z));
				const rem = idx - y * CHUNK_SIZE_X * CHUNK_SIZE_Z;
				const lz = Math.floor(rem / CHUNK_SIZE_X);
				const lx = rem - lz * CHUNK_SIZE_X;
				const x = baseX + lx, z = baseZ + lz;
				if (!isLiquid(this.world.getBlock(x, y, z))) {
					toRemove.push(idx);
					continue;
				}
				const neighbors = [
					this.world.getBlock(x + 1, y, z),
					this.world.getBlock(x - 1, y, z),
					this.world.getBlock(x, y - 1, z),
					this.world.getBlock(x, y, z + 1),
					this.world.getBlock(x, y, z - 1),
				];
				const hasAir = neighbors.some((n) => n === AIR);
				if (!hasAir) toRemove.push(idx);
			}
			for (const i of toRemove) c.liquidFrontier.delete(i);
		}
	}
```

(Note: we don't check the +y neighbor for air because we never spread upward; a liquid with air above but air-filled horizontal/below neighbors is still in equilibrium.)

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/game/liquid-scheduler.ts src/game/liquid-scheduler.test.ts
git commit -m "$(cat <<'EOF'
feat(liquid): sideways spread rule + frontier decay

If a liquid can't fall (below is not air), each axis-aligned
horizontal neighbor that is air gets scheduled to become the same
liquid. Fully-enclosed liquids (no air in ±x, ±z, -y) drop out of
the active frontier at the end of the tick.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17 — Integrate `LiquidScheduler` into `GameLoop`

**Files:**
- Modify: `src/game/loop.ts`
- Modify: `src/main.ts`

**Context:** GameLoop constructs the scheduler and calls `scheduler.tick(dt)` in its tick. Scheduler's `onChunkDirty` callback funnels into `GameLoop.markChunkDirty`. Liquid writes also trigger light updates (water/lava change lightFilter values), so the scheduler's chunk-dirty callback needs to also request light re-flood — but since scheduler writes through `world.setBlock`, and we want incremental light updates on each flow-induced write, wire the light update into the scheduler's commit phase.

Cleanest approach: pass a `(x, y, z) => void` callback to the scheduler that's invoked per write, and hook it to `applyLightUpdate`.

- [ ] **Step 1: Extend scheduler with per-write callback**

In `src/game/liquid-scheduler.ts`:

```ts
	constructor(
		private world: World,
		private onChunkDirty: (cx: number, cz: number) => void,
		private onBlockChanged: (x: number, y: number, z: number) => void = () => {},
	) {}
```

In the `commit` method, after `this.world.setBlock(x, y, z, id);`, add:

```ts
	this.onBlockChanged(x, y, z);
```

- [ ] **Step 2: Instantiate in GameLoop**

In `src/game/loop.ts`:

a) Add import + field:

```ts
import { LiquidScheduler } from './liquid-scheduler';

// in the class:
private scheduler: LiquidScheduler;
```

b) In the constructor, after the existing fields are wired, instantiate:

```ts
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
	) {
		this.scheduler = new LiquidScheduler(
			this.world,
			(cx, cz) => this.markChunkDirty(cx, cz),
			(x, y, z) => this.applyLightUpdate(x, y, z),
		);
	}
```

c) In `tick`, add the scheduler tick call (after `this.player.update(...)` or near the other per-frame updates):

```ts
	this.scheduler.tick(dt);
```

- [ ] **Step 3: Populate liquid frontier on chunk load**

Also in `src/game/loop.ts`, when a chunk is first mounted (in `flushDirtyChunks`), scan its liquid voxels into the frontier. Add this after `this.world.ensureChunk(cx, cz)` and before meshing:

```ts
	const c = this.world.ensureChunk(cx, cz);
	// Ensure all gen-placed liquids are in the frontier for at least one tick's check.
	if (c.liquidFrontier.size === 0) {
		for (let y = 0; y < 64; y++) {
			for (let lz = 0; lz < 16; lz++) {
				for (let lx = 0; lx < 16; lx++) {
					if (isLiquid(c.blocks[y * 16 * 16 + lz * 16 + lx])) {
						c.liquidFrontier.add(y * 16 * 16 + lz * 16 + lx);
					}
				}
			}
		}
	}
```

Add the import at the top of loop.ts: `import { isLiquid } from '../data/blocks.data';` (if not already there).

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Run build**

Run: `npm run build`
Expected: success.

- [ ] **Step 6: Manual smoke verification**

Run: `npm run dev`
Expected: world loads with water pools in low-heightmap areas. The water is translucent blue; you can see through it. Skylight attenuates through water producing a subtly darker underwater color. Dig a channel out of a pool — water flows into the dug space over a few ticks.

- [ ] **Step 7: Commit**

```bash
git add src/game/loop.ts src/game/liquid-scheduler.ts
git commit -m "$(cat <<'EOF'
feat(liquid): integrate LiquidScheduler into GameLoop

Scheduler ticks each frame via GameLoop. Block-changed callback fires
per-write and invokes applyLightUpdate so water/lava moves trigger
incremental light re-flood. On first mount of each chunk, all
gen-placed liquid voxels enter the active frontier for one tick check
(most drop back out immediately as equilibrium ocean).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18 — Player swim state detection

**Files:**
- Modify: `src/game/player.ts`
- Modify: `src/game/player.test.ts`

**Context:** Add `swimming: boolean` to `Player`. Populate per tick by reading the eye voxel from the world. When swimming, gravity is skipped (same as flying). Speed change comes in Task 19.

- [ ] **Step 1: Write failing tests**

Append to `src/game/player.test.ts`:

```ts
describe('Player swim mode', () => {
	const water = BLOCK_BY_NAME['water'].id;

	it('swimming is false by default', () => {
		const p = new Player([100, 60, 100]);
		expect(p.swimming).toBe(false);
	});

	it('swimming activates when eye voxel is water', () => {
		const w = new World(1);
		const p = new Player([100, 60, 100]);
		// Place water where the player's eye is (position y=60 + EYE_HEIGHT≈1.6 → y=61).
		w.setBlock(100, 61, 100, water);
		p.update(0.01, w, noKeys(), FWD, RIGHT);
		expect(p.swimming).toBe(true);
	});

	it('swimming deactivates when eye leaves water', () => {
		const w = new World(1);
		const p = new Player([100, 60, 100]);
		w.setBlock(100, 61, 100, water);
		p.update(0.01, w, noKeys(), FWD, RIGHT);
		expect(p.swimming).toBe(true);
		// Remove the water.
		w.setBlock(100, 61, 100, 0);
		p.update(0.01, w, noKeys(), FWD, RIGHT);
		expect(p.swimming).toBe(false);
	});

	it('swimming disables gravity accumulation', () => {
		const w = new World(1);
		const p = new Player([100, 60, 100]);
		w.setBlock(100, 61, 100, water);
		p.vy = 0;
		p.update(0.1, w, noKeys(), FWD, RIGHT);
		expect(p.vy).toBe(0);
	});
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -- src/game/player.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add swim state to Player**

In `src/game/player.ts`:

a) Add imports:

```ts
import { BLOCKS, isLiquid } from '../data/blocks.data';
```

b) Add field:

```ts
	swimming = false;
```

c) In `update`, compute `swimming` at the top:

```ts
		const eye = this.eyePosition();
		const eyeBlock = world.getBlock(Math.floor(eye[0]), Math.floor(eye[1]), Math.floor(eye[2]));
		this.swimming = isLiquid(eyeBlock);
```

d) Gate gravity. Replace:

```ts
		let vyStep: number;
		if (this.flying) {
			// ...existing fly code...
		} else {
			this.vy -= GRAVITY * dt;
			// ...
		}
```

with:

```ts
		let vyStep: number;
		if (this.flying || this.swimming) {
			let vy = 0;
			if (this.flying) {
				if (keys.flyUp) vy += speed;
				if (keys.flyDown) vy -= speed;
			}
			this.vy = vy;
			vyStep = vy * dt;
		} else {
			this.vy -= GRAVITY * dt;
			if (keys.jump && this.grounded) this.vy = JUMP_SPEED;
			vyStep = this.vy * dt;
		}
```

(We'll rework `keys.flyUp`/`flyDown` out entirely in Task 20. For now swim just borrows the fly branch.)

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/game/player.ts src/game/player.test.ts
git commit -m "$(cat <<'EOF'
feat(player): swim state activates when eye voxel is liquid

Player.swimming is set per tick by reading the voxel at the eye
position. While swimming, gravity is skipped (same branch as flying).
Speed tuning and cursor-directed movement come next.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 19 — Cursor-directed 3D movement for fly + swim; swim speed = 0.6 × walk

**Files:**
- Modify: `src/game/player.ts`
- Modify: `src/game/player.test.ts`

**Context:** In fly OR swim, W uses the full 3D camera forward (including Y); strafe uses horizontal right (Y=0 by construction). Swim speed is `WALK_SPEED * 0.6`. Fly speed continues to multiply by the tier.

- [ ] **Step 1: Write failing tests**

Append to `src/game/player.test.ts`:

```ts
describe('Player cursor-directed movement', () => {
	const water = BLOCK_BY_NAME['water'].id;

	it('in fly mode, W uses full 3D camera forward (pitch down → descend)', () => {
		const w = new World(1);
		const p = new Player([100, 60, 100]);
		p.toggleFly();
		const fwd3D = new THREE.Vector3(0, -0.707, -0.707); // 45° down
		p.update(0.1, w, { ...noKeys(), forward: true }, fwd3D, RIGHT);
		expect(p.position[1]).toBeLessThan(60);
		expect(p.position[2]).toBeLessThan(100);
	});

	it('in fly mode, strafe is horizontal (no Y change)', () => {
		const w = new World(1);
		const p = new Player([100, 60, 100]);
		p.toggleFly();
		const fwd3D = new THREE.Vector3(0, -0.707, -0.707);
		const right = new THREE.Vector3(1, 0, 0);
		p.update(0.1, w, { ...noKeys(), right: true }, fwd3D, right);
		expect(p.position[1]).toBeCloseTo(60, 2);
	});

	it('swim speed is 60% of walk speed', () => {
		const w = new World(1);
		// Fill a tall column of water near the player's eye.
		for (let y = 58; y <= 63; y++) w.setBlock(100, y, 100, water);
		const p = new Player([100, 60, 100]);
		// Force swim state via update.
		p.update(0.01, w, noKeys(), FWD, RIGHT);
		expect(p.swimming).toBe(true);
		const before = p.position[2];
		p.update(1.0, w, { ...noKeys(), forward: true }, FWD, RIGHT);
		const dz = Math.abs(p.position[2] - before);
		// WALK_SPEED = 5 → expected swim dz ≈ 3.0. Allow some physics tolerance.
		expect(dz).toBeGreaterThan(2.5);
		expect(dz).toBeLessThan(3.5);
	});
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm test -- src/game/player.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement cursor-directed movement**

In `src/game/player.ts`, rewrite the body of `update` to branch on flying||swimming. Replace the existing input-and-velocity block with:

```ts
	update(
		dt: number,
		world: World,
		keys: Keys,
		forward: THREE.Vector3,
		right: THREE.Vector3,
	) {
		const eye = this.eyePosition();
		const eyeBlock = world.getBlock(Math.floor(eye[0]), Math.floor(eye[1]), Math.floor(eye[2]));
		this.swimming = isLiquid(eyeBlock);

		let ix = 0, iy = 0, iz = 0;
		if (this.flying || this.swimming) {
			if (keys.forward) { ix += forward.x; iy += forward.y; iz += forward.z; }
			if (keys.back) { ix -= forward.x; iy -= forward.y; iz -= forward.z; }
			if (keys.left) { ix -= right.x; iz -= right.z; } // right.y == 0
			if (keys.right) { ix += right.x; iz += right.z; }
		} else {
			if (keys.forward) { ix += forward.x; iz += forward.z; }
			if (keys.back) { ix -= forward.x; iz -= forward.z; }
			if (keys.left) { ix -= right.x; iz -= right.z; }
			if (keys.right) { ix += right.x; iz += right.z; }
		}

		const mag = Math.hypot(ix, iy, iz);
		if (mag > 0) { ix /= mag; iy /= mag; iz /= mag; }

		let speed: number;
		if (this.flying) speed = WALK_SPEED * this.flySpeedTier;
		else if (this.swimming) speed = WALK_SPEED * 0.6;
		else speed = WALK_SPEED;

		const vx = ix * speed * dt;
		const vz = iz * speed * dt;

		let vyStep: number;
		if (this.flying || this.swimming) {
			this.vy = iy * speed; // cursor-driven vertical; no gravity
			vyStep = this.vy * dt;
		} else {
			this.vy -= GRAVITY * dt;
			if (keys.jump && this.grounded) this.vy = JUMP_SPEED;
			vyStep = this.vy * dt;
		}

		const disp = Math.max(Math.abs(vx), Math.abs(vyStep), Math.abs(vz));
		const steps = Math.max(1, Math.ceil(disp / MAX_STEP));
		const sx = vx / steps, sy = vyStep / steps, sz = vz / steps;
		let grounded = false;
		for (let i = 0; i < steps; i++) {
			const r = moveWithCollisions(world, this.position, SIZE, [sx, sy, sz]);
			this.position = r.position;
			grounded = grounded || r.grounded;
			if (r.vy === 0) this.vy = 0;
			if (r.vx === 0 && r.vz === 0 && r.vy === 0) break;
		}
		this.grounded = grounded;
	}
```

Space/shift are now completely ignored while flying or swimming. `keys.flyUp`/`keys.flyDown` in the `Keys` type are dead (will be removed in Task 20).

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: all pass — BUT the existing fly tests that use `flyUp`/`flyDown` may now fail because space/shift are ignored in fly. That's expected; Task 20 removes those obsolete tests.

For now, if any existing test named like `'flyUp produces positive vy...'` fails, SKIP them temporarily by renaming the `it` to `it.skip` — they'll be deleted in Task 20.

- [ ] **Step 5: Commit**

```bash
git add src/game/player.ts src/game/player.test.ts
git commit -m "$(cat <<'EOF'
feat(player): cursor-directed 3D movement for fly + swim, swim speed 0.6x

In fly or swim mode, WASD uses the full 3D camera forward for forward/back
(pitch controls vertical); strafe stays horizontal. Swim speed is
WALK_SPEED * 0.6. Fly speed continues to use the tier multiplier.
Space/shift are effectively ignored for motion (keybindings still
defined; removal in next task).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 20 — Remove `flyUp` / `flyDown` keybindings + update callers

**Files:**
- Modify: `src/data/keybindings.data.ts`
- Modify: `src/game/player.ts`
- Modify: `src/game/player.test.ts`
- Modify: `src/main.ts`

**Context:** Clean up the obsolete keybindings. Remove from `Action`, `ACTIONS`, `ACTION_LABEL`, `DEFAULT_KEYBINDINGS`. Remove `flyUp`/`flyDown` from the `Keys` type and from the `onKey` dispatcher in main.ts. Delete the now-obsolete fly-vertical tests from player.test.ts.

- [ ] **Step 1: Update `keybindings.data.ts`**

Remove all mentions of `flyUp` and `flyDown`:

- From the `Action` union type, delete `| 'flyUp'` and `| 'flyDown'`.
- From `ACTIONS` array: remove `'flyUp'` and `'flyDown'`.
- From `ACTION_LABEL`: remove the `flyUp: '...'` and `flyDown: '...'` entries.
- From `DEFAULT_KEYBINDINGS`: remove the `flyUp: 'Space'` and `flyDown: 'ShiftLeft'` entries.

- [ ] **Step 2: Update `Keys` type and Player**

In `src/game/player.ts`, change the `Keys` type:

```ts
export type Keys = {
	forward: boolean;
	back: boolean;
	left: boolean;
	right: boolean;
	jump: boolean;
};
```

Remove the `flyUp`/`flyDown` references from the unused code in `update` (the old if-branch). The body already ignores them after Task 19; just make sure no unused reads remain.

- [ ] **Step 3: Update main.ts dispatcher**

In `src/main.ts`:

a) Remove `flyUp` and `flyDown` from the `keys` literal:

```ts
const keys: Keys = {
	forward: false,
	back: false,
	left: false,
	right: false,
	jump: false,
};
```

b) Remove the `case 'flyUp':` and `case 'flyDown':` branches from the dispatcher. Also remove the `keys.flyUp = down;` / `keys.flyDown = down;` inside `case 'jump':` — that hack is obsolete.

```ts
	case 'jump':
		keys.jump = down;
		break;
```

- [ ] **Step 4: Delete obsolete tests in `player.test.ts`**

Delete these `it` blocks (they're no longer correct):

- `'flyUp produces positive vy, flyDown negative, neither zero'`
- `'flyUp and flyDown held together cancel to zero vy'`

The remaining tests (walking gravity, toggleFly, fly-speed tier, fly-speed-clamp, fly-wall-collision) still apply; update any that reference `flyUp`/`flyDown` in their `Keys` literal. Replace `{ ...noKeys(), flyUp: true }` with an appropriate setup using cursor-directed forward-down motion if the test is still relevant; otherwise delete.

Update `noKeys` in the test file:

```ts
function noKeys(): Keys {
	return {
		forward: false,
		back: false,
		left: false,
		right: false,
		jump: false,
	};
}
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Run build**

Run: `npm run build`
Expected: success.

- [ ] **Step 7: Manual smoke verification**

Run: `npm run dev`
Expected:
- F toggles fly.
- W flies forward in the look direction (pitch up → ascend, pitch down → descend).
- Space and shift have no effect while flying or swimming.
- Dive head-first into a water pool — swim state activates, W swims downward if looking down.
- Surface out of the pool — gravity resumes.

- [ ] **Step 8: Commit**

```bash
git add src/data/keybindings.data.ts src/game/player.ts src/game/player.test.ts src/main.ts
git commit -m "$(cat <<'EOF'
refactor(input): remove flyUp/flyDown keybindings, prune Keys type

Fly and swim are now fully cursor-driven. Space still jumps on the
ground; shift has no game-layer effect. Options menu auto-drops the
two rows because it reads from ACTIONS. Removed obsolete fly-vertical
unit tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 21 — End-to-end smoke + test suite green

**Files:**
- (verification only)

**Context:** Final sanity sweep. Run full test suite, lint, and a manual playtest of the critical paths.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all pass. Record the count (expected ~128).

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no errors. Fix any warnings that are easy; note any that are acceptable (e.g., unused imports introduced across tasks).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: success, no TypeScript errors.

- [ ] **Step 4: Manual playtest checklist**

Run: `npm run dev`. Click to lock pointer.

Verify each of these in a fresh world with a new seed (click "New World" if necessary):

- [ ] **Voxel lighting baseline**: scene is lit, sky is blue, no shadow-map leaks visible at block seams.
- [ ] **Under-overhang darkening**: fly under a cliff or build an overhang — the underside is noticeably darker than the surface.
- [ ] **Lamp color**: place a lamp with `C` (default warm white). The lamp lights a sphere of nearby voxels in its color.
- [ ] **Two-lamp blend**: place two lamps of different colors (e.g., red and blue) near each other. The overlap region blends toward purple.
- [ ] **Lamp-underground darkness**: dig a small room underground; before placing a lamp it should be near-black. Place a lamp to light it.
- [ ] **World-gen water**: see a pool of blue water at low spots. The water is translucent — you can see stone/sand below through it.
- [ ] **Water physics**: dig a solid block adjacent to a pool from below. Water flows into the dug space over a few ticks.
- [ ] **Water placement in mid-air**: fly up high, point at air, right-click with water selected. The water block should fall down one voxel per 0.5s until it lands on something.
- [ ] **Water waterfall**: build a small ledge with water on top and no support over the edge. Water spreads off the edge and falls as a continuous stream.
- [ ] **Swim activation**: walk into a pool until head goes under. Movement shifts to cursor-directed with no gravity. Look down and press W — you descend. Look up and press W — you rise to the surface. Head above water — gravity resumes.
- [ ] **Lava**: place a lava block on a dry surface. It emits an orange glow (visible on surrounding blocks' vertex colors). Attempt to swim in it — same floaty behavior as water. Dig a channel so the lava flows.
- [ ] **TNT + water/lava**: place TNT near water, ignite with E. The explosion clears blocks; water flows into the crater over subsequent ticks.
- [ ] **Save/load**: close the browser tab. Reopen, continue the world. All water, lava, lamps, and placed blocks persist. Lighting looks correct on first frame.
- [ ] **No console errors**: check devtools console for runtime errors or warnings from Three.js about removed APIs.

- [ ] **Step 5: Commit (if any tweaks were needed)**

If you made no code changes, skip. Otherwise commit any fixes with a descriptive message.

---

## Self-Review Summary (controller-facing)

After all 21 tasks, the codebase has:

- Voxel-per-voxel skylight + RGB block-light flood-fill driving all illumination via per-vertex colors (with AO).
- MeshBasicMaterial + vertexColors replacing MeshLambertMaterial + DirectionalLight + shadow map. Sun shadow mapping is gone.
- Water (id 17) and lava (id 18) blocks with simple fall-or-spread-sideways flow at 2 Hz.
- Flatter world-gen with sea-level water fill and shoreline sand.
- Swim mode (eye-in-liquid → floaty + cursor-directed + 0.6× walk speed).
- Cursor-directed 3D fly movement; flyUp/flyDown keybindings removed.
- Incremental light updates on every block edit (mine, place, TNT, liquid flow).

**Total new unit tests:** ~35-40. **Test count target:** 88 (before) + ~40 (new) = ~128.

**Out-of-scope reminders** (not in this plan, explicitly deferred):
- No save-format migration — old worlds will reshape around existing builds.
- No water-on-lava → stone conversion.
- No fluid levels / partial fill / pressure.
- No bucket item.
- No underwater fog/tint or breathing mechanics.
- No gen-time lava pockets.
