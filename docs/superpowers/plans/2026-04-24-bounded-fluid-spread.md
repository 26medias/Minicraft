# Bounded Fluid Spread Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound water and lava spread to small radii from "source" voxels, drain orphaned flow when sources are removed, and react water + lava → obsidian + air. World-gen ocean stays free.

**Architecture:** Add a per-chunk sparse `fluidMeta: Map<number, number>` storing only **flow** voxels (sources are encoded by the absence of an entry — so the world-gen ocean has zero entries). Refactor the scheduler into three phases per tick: spread (with budget), reaction (water+lava → obsidian), drain (cascade orphaned flow). Add a new obsidian block to the catalog. Persistence gains an optional `fluidMeta` field per chunk.

**Tech Stack:** TypeScript, Vitest, Vite, custom voxel engine (no Three.js touched).

**Spec:** `docs/superpowers/specs/2026-04-24-bounded-fluid-spread-design.md`

---

## File Structure

**Modified:**
- `src/data/blocks.data.ts` — add `obsidian` block row (id 19).
- `src/data/blocks.data.test.ts` — assert obsidian row is well-formed.
- `src/engine/world/chunk.ts` — add `fluidMeta` field + meta accessors (`getFluidMeta`, `setFluidMeta`, `clearFluidMeta`).
- `src/engine/world/world.ts` — add `setBlockFlow(x, y, z, id, distance)` for scheduler use; have `setBlock` clear fluidMeta automatically (the "regular write = source / no flow state" rule).
- `src/game/liquid-scheduler.ts` — split into three private phases (`applySpreadStep`, `applyReactionStep`, `applyDrainStep`). Add per-chunk `pendingDrain: Set<number>` (purely runtime state).
- `src/game/liquid-scheduler.test.ts` — update existing source-vacates expectations; add new tests for budget, reaction, drain.
- `src/persistence/codec.ts` — add `encodeFluidMeta` / `decodeFluidMeta` helpers.
- `src/persistence/adapter.ts` — extend `RawChunk` with optional `fluidMeta` field.
- `src/persistence/localStorage.ts` — read/write the new field.
- `src/persistence/codec.test.ts` — round-trip tests for fluid meta encoding.
- `src/persistence/autosave.ts` — include fluidMeta in `WorldSave.chunks`.
- `src/main.ts` — restore fluidMeta when loading saved chunks.
- `docs/liquids.md` — rewrite to reflect source/flow model, three-phase tick, and reaction rule.

**Not touched:** mesher, renderer, atlas, lighting, generation. The visual identity of liquids does not change.

---

## Phase 0: Catalog

### Task 1: Add obsidian block row

**Files:**
- Modify: `src/data/blocks.data.ts`
- Modify: `src/data/blocks.data.test.ts`

**Context:** Texture exists at `src/assets/blocks/obsidian.png`. Block id 19 is the next free slot. We want obsidian to sit at the top of the existing hardness scale — currently the highest kid-mode hardness is `1.2` (stone, cobblestone). Use `1.2` for obsidian as well to avoid introducing a new hardness tier.

- [ ] **Step 1: Add the failing test**

In `src/data/blocks.data.test.ts`, add:

```ts
import { describe, it, expect } from 'vitest';
import { BLOCK_BY_NAME } from './blocks.data';

describe('obsidian block', () => {
    it('is defined and has expected properties', () => {
        const obsidian = BLOCK_BY_NAME['obsidian'];
        expect(obsidian).toBeDefined();
        expect(obsidian.solid).toBe(true);
        expect(obsidian.transparent).toBe(false);
        expect(obsidian.kidMode).toBe(true);
        expect(obsidian.liquid).toBe('none');
        expect(obsidian.hardness).toBe(1.2);
        expect(obsidian.lightLevel).toBe(0);
        expect(obsidian.lightFilter).toBe(15);
        expect(obsidian.textures).toEqual({ kind: 'uniform', all: 'obsidian' });
    });
});
```

(If a `describe` block already exists in the file, add this `it` inside it instead of creating a new `describe`.)

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/data/blocks.data.test.ts`
Expected: FAIL — `obsidian` is undefined in `BLOCK_BY_NAME`.

- [ ] **Step 3: Add the obsidian row to `BLOCKS`**

In `src/data/blocks.data.ts`, add after the existing `lava` row (id 18):

```ts
{ id: 19, name: 'obsidian', label: 'Obsidian', solid: true, transparent: false, kidMode: true, hardness: 1.2,
    lightLevel: 0, lightFilter: 15, liquid: 'none',
    textures: { kind: 'uniform', all: 'obsidian' } },
```

Then add a top-level export below the existing `WATER` / `LAVA` constants:

```ts
export const OBSIDIAN: BlockId = 19;
```

- [ ] **Step 4: Verify the test passes**

Run: `npx vitest run src/data/blocks.data.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full test suite to make sure nothing else regressed**

Run: `npx vitest run`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/data/blocks.data.ts src/data/blocks.data.test.ts
git commit -m "feat(blocks): add obsidian block (id 19)"
```

---

## Phase 1: Per-chunk fluid metadata

### Task 2: Add `fluidMeta` field and accessors to `Chunk`

**Files:**
- Modify: `src/engine/world/chunk.ts`
- Create: `src/engine/world/chunk.test.ts` (extend if it exists)

**Context:** The map is sparse — entries only exist for **flow** voxels. Absence of an entry means "source" (or "not a liquid", but the scheduler only cares about liquid cells). The packed byte layout is:

| Bit  | Meaning                               |
|------|---------------------------------------|
| 7    | always `1` (marker bit identifying this as a flow entry; reserved for future) |
| 4–6  | reserved (write 0)                    |
| 0–3  | `distance` from source (0–15)         |

We always set bit 7 because we're storing only flow voxels; if we ever read the byte without going through the helper and the byte happens to be 0, we'd incorrectly treat it as "distance 0 source" — bit 7 keeps the value non-zero and self-identifying.

- [ ] **Step 1: Write the failing test**

In `src/engine/world/chunk.test.ts` (create the file if it doesn't exist) add:

```ts
import { describe, it, expect } from 'vitest';
import { Chunk } from './chunk';

describe('Chunk.fluidMeta', () => {
    it('starts empty', () => {
        const c = new Chunk(0, 0);
        expect(c.fluidMeta.size).toBe(0);
    });

    it('setFluidMeta(distance) stores a packed byte and isFlow returns true', () => {
        const c = new Chunk(0, 0);
        c.setFluidMeta(3, 4, 5, 2);
        expect(c.isFlow(3, 4, 5)).toBe(true);
        expect(c.getFlowDistance(3, 4, 5)).toBe(2);
    });

    it('without an entry, isFlow returns false (treated as source)', () => {
        const c = new Chunk(0, 0);
        expect(c.isFlow(3, 4, 5)).toBe(false);
    });

    it('clearFluidMeta removes the entry', () => {
        const c = new Chunk(0, 0);
        c.setFluidMeta(3, 4, 5, 2);
        c.clearFluidMeta(3, 4, 5);
        expect(c.isFlow(3, 4, 5)).toBe(false);
    });

    it('setFluidMeta marks the chunk modified', () => {
        const c = new Chunk(0, 0);
        c.modified = false;
        c.setFluidMeta(0, 0, 0, 0);
        expect(c.modified).toBe(true);
    });

    it('clearFluidMeta marks the chunk modified only if an entry existed', () => {
        const c = new Chunk(0, 0);
        c.setFluidMeta(0, 0, 0, 0);
        c.modified = false;
        c.clearFluidMeta(0, 0, 0);
        expect(c.modified).toBe(true);

        c.modified = false;
        c.clearFluidMeta(1, 1, 1); // no entry
        expect(c.modified).toBe(false);
    });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/engine/world/chunk.test.ts`
Expected: FAIL — `setFluidMeta` is not a function (or similar).

- [ ] **Step 3: Implement the field and accessors**

In `src/engine/world/chunk.ts`, modify the class. Add the field and methods (full file shown for clarity — preserve existing methods):

```ts
import type { BlockId } from '../../data/blocks.data';
import { BLOCKS_PER_CHUNK, indexOf } from './coords';

export class Chunk {
    readonly cx: number;
    readonly cz: number;
    readonly blocks: Uint8Array;
    readonly lights: Uint16Array;
    readonly sunlit: Uint8Array;
    readonly liquidFrontier: Set<number> = new Set();
    /** Packed flow metadata, sparse — only flow voxels have entries. Source = absence of entry. */
    readonly fluidMeta: Map<number, number> = new Map();
    /** Runtime-only set of voxel indices queued for drain on the next tick. Not persisted. */
    readonly pendingDrain: Set<number> = new Set();
    dirty = true;
    modified = false;
    shadowsDirty = true;

    constructor(cx: number, cz: number) {
        this.cx = cx;
        this.cz = cz;
        this.blocks = new Uint8Array(BLOCKS_PER_CHUNK);
        this.lights = new Uint16Array(BLOCKS_PER_CHUNK);
        this.sunlit = new Uint8Array(BLOCKS_PER_CHUNK);
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

    /** True if (x,y,z) has a flow entry. False for source voxels and non-liquid cells. */
    isFlow(x: number, y: number, z: number): boolean {
        return this.fluidMeta.has(indexOf(x, y, z));
    }

    /** Returns the flow distance for a flow voxel, or 0 for a source / no-entry cell. */
    getFlowDistance(x: number, y: number, z: number): number {
        const v = this.fluidMeta.get(indexOf(x, y, z));
        return v === undefined ? 0 : v & 0x0f;
    }

    /** Mark (x,y,z) as flow with the given distance (0–15). */
    setFluidMeta(x: number, y: number, z: number, distance: number): void {
        const i = indexOf(x, y, z);
        const packed = 0x80 | (distance & 0x0f);
        const existing = this.fluidMeta.get(i);
        if (existing === packed) return;
        this.fluidMeta.set(i, packed);
        this.modified = true;
    }

    /** Remove the flow entry at (x,y,z). After this, the cell is "source" by default. */
    clearFluidMeta(x: number, y: number, z: number): void {
        const i = indexOf(x, y, z);
        if (!this.fluidMeta.has(i)) return;
        this.fluidMeta.delete(i);
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

- [ ] **Step 4: Verify the test passes**

Run: `npx vitest run src/engine/world/chunk.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: all green (no behavior change yet).

- [ ] **Step 6: Commit**

```bash
git add src/engine/world/chunk.ts src/engine/world/chunk.test.ts
git commit -m "feat(world): add per-chunk fluidMeta map with flow accessors"
```

---

### Task 3: Add `setBlockFlow` to `World` and auto-clear meta on `setBlock`

**Files:**
- Modify: `src/engine/world/world.ts`
- Create or extend: `src/engine/world/world.test.ts`

**Context:** The "regular write = source" rule lives in `World.setBlock`: any write through the public API clears any stale fluidMeta entry. This means player placements and world-gen writes naturally produce sources, no extra wiring needed. The scheduler is the only caller that wants to write *flow*, so it gets a separate method `setBlockFlow(x, y, z, id, distance)`.

- [ ] **Step 1: Write the failing test**

In `src/engine/world/world.test.ts` (extend or create) add:

```ts
import { describe, it, expect } from 'vitest';
import { World } from './world';
import { AIR, BLOCK_BY_NAME } from '../../data/blocks.data';
import { worldToChunk } from './coords';

const water = BLOCK_BY_NAME['water'].id;

function freshWorld(): World {
    const w = new World(1);
    const c = w.ensureChunk(16, 16);
    c.blocks.fill(AIR);
    c.fluidMeta.clear();
    c.liquidFrontier.clear();
    return w;
}

describe('World.setBlock — fluidMeta interaction', () => {
    it('regular setBlock(water) clears any existing fluidMeta entry → cell is a source', () => {
        const w = freshWorld();
        const { cx, cz, lx, lz } = worldToChunk(260, 260);
        const c = w.getChunk(cx, cz)!;
        // Pretend a previous scheduler write left a flow entry here
        c.setFluidMeta(lx, 30, lz, 3);
        expect(c.isFlow(lx, 30, lz)).toBe(true);

        w.setBlock(260, 30, 260, water);

        expect(w.getBlock(260, 30, 260)).toBe(water);
        expect(c.isFlow(lx, 30, lz)).toBe(false);
    });

    it('regular setBlock(AIR) clears any existing fluidMeta entry', () => {
        const w = freshWorld();
        const { cx, cz, lx, lz } = worldToChunk(260, 260);
        const c = w.getChunk(cx, cz)!;
        c.set(lx, 30, lz, water);
        c.setFluidMeta(lx, 30, lz, 2);

        w.setBlock(260, 30, 260, AIR);

        expect(c.isFlow(lx, 30, lz)).toBe(false);
    });
});

describe('World.setBlockFlow', () => {
    it('writes the block id and a flow entry with the given distance', () => {
        const w = freshWorld();
        const { cx, cz, lx, lz } = worldToChunk(260, 260);
        const c = w.getChunk(cx, cz)!;

        w.setBlockFlow(260, 30, 260, water, 2);

        expect(w.getBlock(260, 30, 260)).toBe(water);
        expect(c.isFlow(lx, 30, lz)).toBe(true);
        expect(c.getFlowDistance(lx, 30, lz)).toBe(2);
    });

    it('overwrites a prior source with a flow entry', () => {
        const w = freshWorld();
        const { cx, cz, lx, lz } = worldToChunk(260, 260);
        const c = w.getChunk(cx, cz)!;
        w.setBlock(260, 30, 260, water); // source
        expect(c.isFlow(lx, 30, lz)).toBe(false);

        w.setBlockFlow(260, 30, 260, water, 1);

        expect(c.isFlow(lx, 30, lz)).toBe(true);
        expect(c.getFlowDistance(lx, 30, lz)).toBe(1);
    });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/engine/world/world.test.ts`
Expected: FAIL — `setBlockFlow` is not a function; auto-clear behaviour is not implemented.

- [ ] **Step 3: Modify `World.setBlock` to clear fluidMeta and add `setBlockFlow`**

In `src/engine/world/world.ts`, replace the existing `setBlock` method and add `setBlockFlow` after it:

```ts
setBlock(x: number, y: number, z: number, id: BlockId): void {
    if (!inBounds(x, y, z)) return;
    const { cx, cz, lx, lz } = worldToChunk(x, z);
    const c = this.ensureChunk(cx, cz);
    c.set(lx, y, lz, id);
    // Regular writes (player placement, world-gen, scheduler-AIR) carry no flow state:
    // any stale entry must go so the cell is treated as a source / non-liquid next tick.
    c.clearFluidMeta(lx, y, lz);
    c.modified = true;

    this.markLiquidFrontier(x, y, z);
    this.markLiquidFrontier(x + 1, y, z);
    this.markLiquidFrontier(x - 1, y, z);
    this.markLiquidFrontier(x, y + 1, z);
    this.markLiquidFrontier(x, y - 1, z);
    this.markLiquidFrontier(x, y, z + 1);
    this.markLiquidFrontier(x, y, z - 1);
}

/** Scheduler-only: write a liquid voxel as flow with the given distance from source. */
setBlockFlow(x: number, y: number, z: number, id: BlockId, distance: number): void {
    if (!inBounds(x, y, z)) return;
    const { cx, cz, lx, lz } = worldToChunk(x, z);
    const c = this.ensureChunk(cx, cz);
    c.set(lx, y, lz, id);
    c.setFluidMeta(lx, y, lz, distance);
    c.modified = true;

    this.markLiquidFrontier(x, y, z);
    this.markLiquidFrontier(x + 1, y, z);
    this.markLiquidFrontier(x - 1, y, z);
    this.markLiquidFrontier(x, y + 1, z);
    this.markLiquidFrontier(x, y - 1, z);
    this.markLiquidFrontier(x, y, z + 1);
    this.markLiquidFrontier(x, y, z - 1);
}
```

- [ ] **Step 4: Verify the test passes**

Run: `npx vitest run src/engine/world/world.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: all green. (The scheduler hasn't been changed yet, so its existing tests still pass — they place water as a source via `setBlock` and the old fall/spread code still runs without consulting fluidMeta.)

- [ ] **Step 6: Commit**

```bash
git add src/engine/world/world.ts src/engine/world/world.test.ts
git commit -m "feat(world): add setBlockFlow; setBlock auto-clears fluidMeta"
```

---

## Phase 2: New scheduler behaviour

### Task 4: Replace scheduler with three-phase tick (spread / reaction / drain) and update tests

**Files:**
- Modify: `src/game/liquid-scheduler.ts`
- Modify: `src/game/liquid-scheduler.test.ts`

**Context:** This is the largest task — we change the core algorithm and update three existing tests whose assumptions ("source vacates when it falls") no longer hold. Read the spec section "Algorithm" carefully before starting.

The scheduler now:

1. **Spread** — for each frontier voxel:
   - If source: fall creates flow below, source stays in place (does not vacate); else if budget remains (which for source is always — distance 0 < budget), spread sideways as flow at distance 1.
   - If flow: fall vacates self and creates flow below at same distance — UNLESS same-type liquid is above (column rule, prevents flicker); else if `distance < budget`, spread sideways as flow at `distance + 1`.

2. **Reaction** — scan *the snapshot* + its 6-axis neighbours. The snapshot is the frontier coords at the start of the tick — this covers both original adjacencies (e.g. water source placed next to lava source on a floor where neither can spread) and spread-created adjacencies (new flow cells are always neighbours of snapshot cells). For each lava voxel in that scan adjacent to ≥1 water voxel: write lava → `OBSIDIAN`, write each adjacent water → `AIR` (both via `world.setBlock`, which clears fluidMeta).

3. **Drain** — for each flow voxel in the frontier: if it has no valid feeder, add to its chunk's `pendingDrain`. Flush `pendingDrain` at the *start* of the next tick (so visible drain rate is 1 ring per 0.5s). Source voxels are never drained.

   Valid feeder for a flow at distance `d`:
   - same-type liquid directly above (column rule), OR
   - any horizontal neighbour is a same-type **source** (no fluidMeta entry + same liquid id), OR
   - any horizontal neighbour is a same-type flow with `distance < d`.

#### Existing tests that must change

- `'tick(0.6) fires once'` — currently asserts source vacates (`y=30 → AIR`, `y=29 → water`). Under new rules the source stays at y=30 and creates flow at y=29. Update to assert `y=30 === water` (still source) and `y=29 === water` (now flow).
- `'tick(1.2) fires once, not twice (no catch-up)'` — same fix to the y=30 assertion (it's currently implicit; the `y=29` and `y=28` assertions already work under the new model since one tick produces flow at y=29 and a second tick would have produced flow at y=28).
- `'unsupported liquid block falls by 1 voxel per tick'` — same fix: source stays at y=30, flow appears at y=29. Update both assertions.

The test `'liquid with same-type liquid below does not fall'` is unaffected (no air below → no fall).
The test `'fall takes priority over sideways-spread'` is unaffected (fall continues to short-circuit sideways spread; only the source-stays-in-place semantics differ, and that test already expects no sideways spread).

- [ ] **Step 1: Update three existing tests to match new source-stays semantics**

In `src/game/liquid-scheduler.test.ts`, change these assertions:

```ts
// Inside `'tick(0.6) fires once'`:
s.tick(0.6);
expect(w.getBlock(260, 30, 260)).toBe(water);  // source stays in place
expect(w.getBlock(260, 29, 260)).toBe(water);  // flow created below
```

```ts
// Inside `'tick(1.2) fires once, not twice (no catch-up)'`:
s.tick(1.2);
expect(w.getBlock(260, 30, 260)).toBe(water);  // source stays
expect(w.getBlock(260, 29, 260)).toBe(water);  // one flow voxel below
expect(w.getBlock(260, 28, 260)).toBe(AIR);    // not two
```

```ts
// Inside `'unsupported liquid block falls by 1 voxel per tick'`:
s.tick(0.6);
expect(w.getBlock(260, 29, 260)).toBe(water);  // flow created
expect(w.getBlock(260, 30, 260)).toBe(water);  // source stays
```

- [ ] **Step 2: Add new failing tests for the new behaviour**

Append to `src/game/liquid-scheduler.test.ts`:

```ts
import { LAVA, OBSIDIAN, WATER } from '../data/blocks.data';

describe('LiquidScheduler — bounded spread (water budget = 4)', () => {
    function flatGroundWorld(): World {
        const w = new World(1);
        const c = w.ensureChunk(16, 16);
        c.blocks.fill(AIR);
        c.lights.fill(0);
        c.fluidMeta.clear();
        c.liquidFrontier.clear();
        // Stone floor across the chunk at y=29
        for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
            c.set(lx, 29, lz, BLOCK_BY_NAME['stone'].id);
        }
        return w;
    }

    it('water source on flat ground spreads to distance 4 and stops', () => {
        const w = flatGroundWorld();
        w.setBlock(264, 30, 264, water); // source
        const s = new LiquidScheduler(w, () => {});
        // 5 ticks gives any 4-distance spread time to reach its limit (1 hop per tick)
        for (let i = 0; i < 5; i++) s.tick(0.6);

        // Distance 4 along +x should be water (flow), distance 5 should be air
        expect(w.getBlock(268, 30, 264)).toBe(water);
        expect(w.getBlock(269, 30, 264)).toBe(AIR);
        // Source is still water
        expect(w.getBlock(264, 30, 264)).toBe(water);
        // Diagonal-corner cell at Manhattan distance 4 should be water
        expect(w.getBlock(266, 30, 266)).toBe(water);
        // Manhattan-5 corner is air
        expect(w.getBlock(267, 30, 267)).toBe(AIR);
    });
});

describe('LiquidScheduler — bounded spread (lava budget = 2)', () => {
    function flatGroundWorld(): World {
        const w = new World(1);
        const c = w.ensureChunk(16, 16);
        c.blocks.fill(AIR);
        c.lights.fill(0);
        c.fluidMeta.clear();
        c.liquidFrontier.clear();
        for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
            c.set(lx, 29, lz, BLOCK_BY_NAME['stone'].id);
        }
        return w;
    }

    it('lava source on flat ground spreads to distance 2 and stops', () => {
        const w = flatGroundWorld();
        w.setBlock(264, 30, 264, LAVA);
        const s = new LiquidScheduler(w, () => {});
        for (let i = 0; i < 5; i++) s.tick(0.6);

        expect(w.getBlock(266, 30, 264)).toBe(LAVA);   // distance 2
        expect(w.getBlock(267, 30, 264)).toBe(AIR);    // distance 3
    });
});

describe('LiquidScheduler — vertical falls do not consume budget', () => {
    it('water falling from a tall cliff still spreads 4 hops at the bottom', () => {
        const w = new World(1);
        const c = w.ensureChunk(16, 16);
        c.blocks.fill(AIR);
        c.lights.fill(0);
        c.fluidMeta.clear();
        c.liquidFrontier.clear();
        // Stone floor at y=29, with a column of air above for the fall
        for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
            c.set(lx, 29, lz, BLOCK_BY_NAME['stone'].id);
        }
        // Source at the top of an 8-block fall
        w.setBlock(264, 38, 264, water);
        const s = new LiquidScheduler(w, () => {});
        // 8 ticks for the column to extend, then 4 more for the bottom to spread
        for (let i = 0; i < 13; i++) s.tick(0.6);

        // Column is water all the way down
        for (let y = 30; y <= 38; y++) {
            expect(w.getBlock(264, y, 264)).toBe(water);
        }
        // Bottom flow has spread the full 4 hops horizontally
        expect(w.getBlock(268, 30, 264)).toBe(water);
        expect(w.getBlock(269, 30, 264)).toBe(AIR);
    });
});

describe('LiquidScheduler — water + lava reaction', () => {
    it('water adjacent to lava → lava becomes obsidian, water becomes air', () => {
        const w = new World(1);
        const c = w.ensureChunk(16, 16);
        c.blocks.fill(AIR);
        c.fluidMeta.clear();
        c.liquidFrontier.clear();
        c.set(8, 29, 8, BLOCK_BY_NAME['stone'].id);
        c.set(9, 29, 8, BLOCK_BY_NAME['stone'].id);
        // Place sources side by side at y=30
        w.setBlock(264, 30, 264, water); // (lx 8)
        w.setBlock(265, 30, 264, LAVA);  // (lx 9)
        const s = new LiquidScheduler(w, () => {});
        s.tick(0.6);

        expect(w.getBlock(265, 30, 264)).toBe(OBSIDIAN);
        expect(w.getBlock(264, 30, 264)).toBe(AIR);
    });
});

describe('LiquidScheduler — drain when source removed', () => {
    function flatGroundWorld(): World {
        const w = new World(1);
        const c = w.ensureChunk(16, 16);
        c.blocks.fill(AIR);
        c.fluidMeta.clear();
        c.liquidFrontier.clear();
        for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
            c.set(lx, 29, lz, BLOCK_BY_NAME['stone'].id);
        }
        return w;
    }

    it('mining the source drains the puddle one ring per tick', () => {
        const w = flatGroundWorld();
        w.setBlock(264, 30, 264, water);
        const s = new LiquidScheduler(w, () => {});
        // Let it spread fully
        for (let i = 0; i < 5; i++) s.tick(0.6);
        expect(w.getBlock(268, 30, 264)).toBe(water);

        // Mine the source
        w.setBlock(264, 30, 264, AIR);

        // After one tick: the outermost ring (distance 4) drains first
        s.tick(0.6);
        expect(w.getBlock(268, 30, 264)).toBe(AIR);
        // Distance 3 is still present (drains next tick)
        expect(w.getBlock(267, 30, 264)).toBe(water);

        // After three more ticks, everything is gone
        s.tick(0.6);
        s.tick(0.6);
        s.tick(0.6);
        for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
            if (Math.abs(dx) + Math.abs(dz) === 0) continue;
            expect(w.getBlock(264 + dx, 30, 264 + dz)).toBe(AIR);
        }
    });

    it('two sources feeding the same puddle: removing one leaves the puddle', () => {
        const w = flatGroundWorld();
        w.setBlock(260, 30, 264, water);
        w.setBlock(268, 30, 264, water);
        const s = new LiquidScheduler(w, () => {});
        for (let i = 0; i < 6; i++) s.tick(0.6);
        // The strip between the two sources should be filled
        expect(w.getBlock(264, 30, 264)).toBe(water);

        // Remove one source
        w.setBlock(260, 30, 264, AIR);

        // After several ticks, the puddle still has water near the surviving source
        for (let i = 0; i < 6; i++) s.tick(0.6);
        expect(w.getBlock(268, 30, 264)).toBe(water);
        // The cell next to the surviving source (distance 1) is also water
        expect(w.getBlock(267, 30, 264)).toBe(water);
    });
});

describe('LiquidScheduler — generation ocean is free', () => {
    it('mining a cell from a sea of sources creates no fluidMeta entries', () => {
        const w = new World(1);
        const c = w.ensureChunk(16, 16);
        c.blocks.fill(AIR);
        c.fluidMeta.clear();
        c.liquidFrontier.clear();
        // 5x5 ocean of water sources at y=30 with stone floor
        for (let dx = 0; dx < 5; dx++) for (let dz = 0; dz < 5; dz++) {
            c.set(dx, 29, dz, BLOCK_BY_NAME['stone'].id);
            c.set(dx, 30, dz, water);
            c.liquidFrontier.add(indexOf(dx, 30, dz));
        }
        const s = new LiquidScheduler(w, () => {});
        // Mine a center cell
        w.setBlock(258, 30, 258, AIR);
        s.tick(0.6);

        // The hole was refilled by spreading neighbours — but spreading neighbours create FLOW,
        // not source, so the refilled cell is now flow. That's fine; the rest of the ocean
        // remains source-only.
        expect(w.getBlock(258, 30, 258)).toBe(water);
        // Outside-the-hole sources should still have no fluidMeta entries
        expect(c.isFlow(0, 30, 0)).toBe(false);
        expect(c.isFlow(4, 30, 4)).toBe(false);
    });
});
```

- [ ] **Step 3: Run the new tests, verify they fail**

Run: `npx vitest run src/game/liquid-scheduler.test.ts`
Expected: the new tests FAIL (current scheduler doesn't enforce budget, doesn't react, doesn't drain). The three updated existing tests also FAIL (because under the *current* code, sources still vacate).

- [ ] **Step 4: Replace `liquid-scheduler.ts` with the three-phase implementation**

Replace `src/game/liquid-scheduler.ts` entirely with:

```ts
import type { World } from '../engine/world/world';
import type { Chunk } from '../engine/world/chunk';
import { AIR, OBSIDIAN, WATER, LAVA, isLiquid } from '../data/blocks.data';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z } from '../engine/world/coords';

const TICK_INTERVAL = 0.5;
const WATER_BUDGET = 4;
const LAVA_BUDGET = 2;

function budgetFor(id: number): number {
    return id === LAVA ? LAVA_BUDGET : WATER_BUDGET;
}

type Coord = { x: number; y: number; z: number };
type PendingWrite = { x: number; y: number; z: number; id: number; flowDistance: number | null };
// flowDistance: null means "regular write" (clears fluidMeta — used for AIR and source-restoration);
// number means "write as flow with that distance".

export class LiquidScheduler {
    private accumulator = 0;

    constructor(
        private world: World,
        private onChunkDirty: (cx: number, cz: number) => void,
        private onBlockChanged: (x: number, y: number, z: number) => void = () => {},
    ) {}

    tick(dt: number): void {
        this.accumulator += dt;
        if (this.accumulator < TICK_INTERVAL) return;
        this.accumulator = 0;

        // Phase 0: flush any drains queued from the previous tick.
        this.flushPendingDrains();

        // Snapshot the frontier BEFORE spread mutates the world. We reuse this coord list
        // for Phase 2 so that reactions also fire on cells that Phase 1 did not touch
        // (e.g. water source placed next to an existing lava source where neither can spread).
        const snapshot = this.takeSnapshot();

        // Phase 1: spread.
        this.applySpreadStep(snapshot);

        // Phase 2: reaction — scan snapshot ∪ 6-axis-neighbours for water/lava contact.
        this.applyReactionStep(snapshot);

        // Phase 3: queue drains for the next tick.
        this.applyDrainStep();

        // Frontier maintenance — drop fully-enclosed pool interiors.
        this.decayFrontier();
    }

    private takeSnapshot(): Coord[] {
        const out: Coord[] = [];
        for (const c of this.world.allChunks()) this.collectFrontier(c, out);
        return out;
    }

    // -----------------------------------------------------------------------------------------

    private applySpreadStep(snapshot: Coord[]): void {
        const pending: PendingWrite[] = [];
        for (const { x, y, z } of snapshot) {
            const here = this.world.getBlock(x, y, z);
            if (!isLiquid(here)) continue;

            const isSource = !this.isFlowAt(x, y, z);
            const distance = isSource ? 0 : this.flowDistanceAt(x, y, z);
            const budget = budgetFor(here);

            // Fall rule: if the cell directly below is air, propagate downward.
            if (y > 0) {
                const below = this.world.getBlock(x, y - 1, z);
                if (below === AIR) {
                    const above = this.world.getBlock(x, y + 1, z);
                    const sameTypeAbove = above === here;
                    pending.push({ x, y: y - 1, z, id: here, flowDistance: distance });
                    // Source never vacates. Flow vacates UNLESS fed by a same-type column above
                    // (otherwise the column would flicker).
                    if (!isSource && !sameTypeAbove) {
                        pending.push({ x, y, z, id: AIR, flowDistance: null });
                    }
                    continue;
                }
            }

            // Sideways spread: only if budget remains.
            if (distance < budget) {
                const sideDirs: [number, number][] = [
                    [1, 0], [-1, 0], [0, 1], [0, -1],
                ];
                for (const [dx, dz] of sideDirs) {
                    const nx = x + dx, nz = z + dz;
                    if (this.world.getBlock(nx, y, nz) === AIR) {
                        pending.push({ x: nx, y, z: nz, id: here, flowDistance: distance + 1 });
                    }
                }
            }
        }

        this.commit(pending);
    }

    // -----------------------------------------------------------------------------------------

    private applyReactionStep(snapshot: Coord[]): void {
        if (snapshot.length === 0) return;
        // Visit each snapshot cell + 6-axis neighbours; for any lava cell with a water neighbour,
        // convert lava → obsidian and water → air.
        const visited = new Set<string>();
        const reactionWrites: { x: number; y: number; z: number; id: number }[] = [];

        const offsets: [number, number, number][] = [
            [0, 0, 0],
            [1, 0, 0], [-1, 0, 0],
            [0, 1, 0], [0, -1, 0],
            [0, 0, 1], [0, 0, -1],
        ];

        for (const t of snapshot) {
            for (const [dx, dy, dz] of offsets) {
                const x = t.x + dx, y = t.y + dy, z = t.z + dz;
                const k = `${x},${y},${z}`;
                if (visited.has(k)) continue;
                visited.add(k);

                if (this.world.getBlock(x, y, z) !== LAVA) continue;
                // Found lava: check for any adjacent water voxel.
                const lavaWaterPairs: Coord[] = [];
                for (const [ddx, ddy, ddz] of [
                    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
                ] as [number, number, number][]) {
                    const wx = x + ddx, wy = y + ddy, wz = z + ddz;
                    if (this.world.getBlock(wx, wy, wz) === WATER) {
                        lavaWaterPairs.push({ x: wx, y: wy, z: wz });
                    }
                }
                if (lavaWaterPairs.length === 0) continue;

                reactionWrites.push({ x, y, z, id: OBSIDIAN });
                for (const wp of lavaWaterPairs) reactionWrites.push({ x: wp.x, y: wp.y, z: wp.z, id: AIR });
            }
        }

        const touchedChunks = new Set<string>();
        for (const w of reactionWrites) {
            if (this.world.getBlock(w.x, w.y, w.z) === w.id) continue;
            this.world.setBlock(w.x, w.y, w.z, w.id);
            this.onBlockChanged(w.x, w.y, w.z);
            const cx = Math.floor(w.x / CHUNK_SIZE_X);
            const cz = Math.floor(w.z / CHUNK_SIZE_Z);
            touchedChunks.add(`${cx},${cz}`);
        }
        for (const ck of touchedChunks) {
            const [cxs, czs] = ck.split(',');
            this.onChunkDirty(Number(cxs), Number(czs));
        }
    }

    // -----------------------------------------------------------------------------------------

    private applyDrainStep(): void {
        for (const c of this.world.allChunks()) {
            const baseX = c.cx * CHUNK_SIZE_X;
            const baseZ = c.cz * CHUNK_SIZE_Z;
            for (const idx of c.liquidFrontier) {
                const { lx, y, lz } = unpackIndex(idx);
                const x = baseX + lx, z = baseZ + lz;
                if (!c.isFlow(lx, y, lz)) continue;             // sources never drain
                const here = c.get(lx, y, lz);
                if (!isLiquid(here)) continue;
                if (!this.hasValidFeeder(x, y, z, here)) {
                    c.pendingDrain.add(idx);
                }
            }
        }
    }

    private flushPendingDrains(): void {
        for (const c of this.world.allChunks()) {
            if (c.pendingDrain.size === 0) continue;
            const baseX = c.cx * CHUNK_SIZE_X;
            const baseZ = c.cz * CHUNK_SIZE_Z;
            const toDrain: number[] = [...c.pendingDrain];
            c.pendingDrain.clear();
            for (const idx of toDrain) {
                const { lx, y, lz } = unpackIndex(idx);
                const x = baseX + lx, z = baseZ + lz;
                if (!c.isFlow(lx, y, lz)) continue;             // re-check; source/non-liquid → skip
                if (!isLiquid(c.get(lx, y, lz))) continue;
                this.world.setBlock(x, y, z, AIR);
                this.onBlockChanged(x, y, z);
                this.onChunkDirty(c.cx, c.cz);
            }
        }
    }

    private hasValidFeeder(x: number, y: number, z: number, id: number): boolean {
        // Column rule: same-type liquid directly above.
        if (this.world.getBlock(x, y + 1, z) === id) return true;
        // Adjacent same-type source or lower-distance flow.
        const sideDirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const [dx, dz] of sideDirs) {
            const nx = x + dx, nz = z + dz;
            if (this.world.getBlock(nx, y, nz) !== id) continue;
            if (!this.isFlowAt(nx, y, nz)) return true;        // source neighbour
            if (this.flowDistanceAt(nx, y, nz) < this.flowDistanceAt(x, y, z)) return true;
        }
        return false;
    }

    // -----------------------------------------------------------------------------------------

    private decayFrontier(): void {
        for (const c of this.world.allChunks()) {
            const baseX = c.cx * CHUNK_SIZE_X;
            const baseZ = c.cz * CHUNK_SIZE_Z;
            const toRemove: number[] = [];
            for (const idx of c.liquidFrontier) {
                const { lx, y, lz } = unpackIndex(idx);
                const x = baseX + lx, z = baseZ + lz;
                if (!isLiquid(this.world.getBlock(x, y, z))) {
                    toRemove.push(idx);
                    continue;
                }
                const neighbours = [
                    this.world.getBlock(x + 1, y, z),
                    this.world.getBlock(x - 1, y, z),
                    this.world.getBlock(x, y - 1, z),
                    this.world.getBlock(x, y, z + 1),
                    this.world.getBlock(x, y, z - 1),
                ];
                const hasAir = neighbours.some((n) => n === AIR);
                if (!hasAir && c.pendingDrain.size === 0) toRemove.push(idx);
            }
            for (const i of toRemove) c.liquidFrontier.delete(i);
        }
    }

    // -----------------------------------------------------------------------------------------

    private commit(pending: PendingWrite[]): void {
        // Dedup: liquid beats AIR on the same coord; lower flowDistance wins among liquids.
        const map = new Map<string, PendingWrite>();
        for (const w of pending) {
            const k = `${w.x},${w.y},${w.z}`;
            const prev = map.get(k);
            if (prev === undefined) { map.set(k, w); continue; }
            if (prev.id === AIR && w.id !== AIR) { map.set(k, w); continue; }
            if (prev.id !== AIR && w.id !== AIR) {
                // Both liquids. Prefer the lower distance (closer to source).
                const a = prev.flowDistance ?? -1;
                const b = w.flowDistance ?? -1;
                if (b < a) map.set(k, w);
            }
        }

        const touchedChunks = new Set<string>();
        for (const [k, w] of map) {
            const [xs, ys, zs] = k.split(',');
            const x = Number(xs), y = Number(ys), z = Number(zs);
            const current = this.world.getBlock(x, y, z);
            if (current === w.id && !isLiquid(w.id)) continue;
            // For liquid writes we still apply, because the meta may need updating.
            if (w.flowDistance === null) {
                this.world.setBlock(x, y, z, w.id);
            } else {
                this.world.setBlockFlow(x, y, z, w.id, w.flowDistance);
            }
            this.onBlockChanged(x, y, z);
            const cx = Math.floor(x / CHUNK_SIZE_X);
            const cz = Math.floor(z / CHUNK_SIZE_Z);
            touchedChunks.add(`${cx},${cz}`);
        }
        for (const ck of touchedChunks) {
            const [cxs, czs] = ck.split(',');
            this.onChunkDirty(Number(cxs), Number(czs));
        }
    }

    private collectFrontier(c: Chunk, out: Coord[]): void {
        const baseX = c.cx * CHUNK_SIZE_X;
        const baseZ = c.cz * CHUNK_SIZE_Z;
        for (const idx of c.liquidFrontier) {
            const { lx, y, lz } = unpackIndex(idx);
            out.push({ x: baseX + lx, y, z: baseZ + lz });
        }
    }

    private isFlowAt(x: number, y: number, z: number): boolean {
        const cx = Math.floor(x / CHUNK_SIZE_X);
        const cz = Math.floor(z / CHUNK_SIZE_Z);
        const c = this.world.getChunk(cx, cz);
        if (!c) return false;
        const lx = ((x % CHUNK_SIZE_X) + CHUNK_SIZE_X) % CHUNK_SIZE_X;
        const lz = ((z % CHUNK_SIZE_Z) + CHUNK_SIZE_Z) % CHUNK_SIZE_Z;
        return c.isFlow(lx, y, lz);
    }

    private flowDistanceAt(x: number, y: number, z: number): number {
        const cx = Math.floor(x / CHUNK_SIZE_X);
        const cz = Math.floor(z / CHUNK_SIZE_Z);
        const c = this.world.getChunk(cx, cz);
        if (!c) return 0;
        const lx = ((x % CHUNK_SIZE_X) + CHUNK_SIZE_X) % CHUNK_SIZE_X;
        const lz = ((z % CHUNK_SIZE_Z) + CHUNK_SIZE_Z) % CHUNK_SIZE_Z;
        return c.getFlowDistance(lx, y, lz);
    }
}

function unpackIndex(idx: number): { lx: number; y: number; lz: number } {
    const y = Math.floor(idx / (CHUNK_SIZE_X * CHUNK_SIZE_Z));
    const rem = idx - y * CHUNK_SIZE_X * CHUNK_SIZE_Z;
    const lz = Math.floor(rem / CHUNK_SIZE_X);
    const lx = rem - lz * CHUNK_SIZE_X;
    return { lx, y, lz };
}
```

- [ ] **Step 5: Run the scheduler tests, verify all pass**

Run: `npx vitest run src/game/liquid-scheduler.test.ts`
Expected: PASS for all tests (updated old + new).

If a test fails:
- "spread reaches farther than expected" → check the `distance < budget` guard.
- "drain doesn't happen" → check `pendingDrain` is being flushed at the *start* of the tick, not the same tick it's queued in.
- "reaction doesn't fire" → check that `applyReactionStep` is called with the touched cells from `applySpreadStep`, not an empty list.
- "two-source test fails after removing one source" → check `hasValidFeeder` correctly recognises a source neighbour (no fluidMeta entry + same-type liquid).

- [ ] **Step 6: Run the full test suite to catch regressions**

Run: `npx vitest run`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/game/liquid-scheduler.ts src/game/liquid-scheduler.test.ts
git commit -m "feat(liquids): bounded spread with source/flow + reaction + drain"
```

---

## Phase 3: Persistence

### Task 5: Add fluidMeta encode/decode helpers

**Files:**
- Modify: `src/persistence/codec.ts`
- Modify: `src/persistence/codec.test.ts`

**Context:** We serialise the sparse map as a list of `[index, packedByte]` pairs, run-length-encoded? Not needed — the map is small (≤ a few hundred entries per chunk). Use a simple varint stream: pair count, then `varint(index), byte(packed)` per entry. Then deflate + base64 like the existing chunk encoding for consistency.

- [ ] **Step 1: Write the failing test**

Append to `src/persistence/codec.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { encodeFluidMeta, decodeFluidMeta } from './codec';

describe('encode/decodeFluidMeta', () => {
    it('round-trips an empty map', () => {
        const map = new Map<number, number>();
        const enc = encodeFluidMeta(map);
        const dec = decodeFluidMeta(enc);
        expect(dec.size).toBe(0);
    });

    it('round-trips a small map', () => {
        const map = new Map<number, number>([
            [0, 0x80],
            [123, 0x83],
            [9999, 0x8f],
        ]);
        const enc = encodeFluidMeta(map);
        const dec = decodeFluidMeta(enc);
        expect(dec.size).toBe(3);
        expect(dec.get(0)).toBe(0x80);
        expect(dec.get(123)).toBe(0x83);
        expect(dec.get(9999)).toBe(0x8f);
    });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run src/persistence/codec.test.ts`
Expected: FAIL — `encodeFluidMeta` not exported.

- [ ] **Step 3: Implement the helpers**

Append to `src/persistence/codec.ts`:

```ts
export function encodeFluidMeta(map: Map<number, number>): string {
    if (map.size === 0) return '';
    const out: number[] = [];
    writeVarInt(out, map.size);
    for (const [idx, packed] of map) {
        writeVarInt(out, idx);
        out.push(packed & 0xff);
    }
    const deflated = deflate(new Uint8Array(out));
    return btoa(String.fromCharCode(...deflated));
}

export function decodeFluidMeta(encoded: string): Map<number, number> {
    const map = new Map<number, number>();
    if (encoded === '') return map;
    const bin = atob(encoded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const buf = inflate(bytes);
    let i = 0;
    const { value: count, next: afterCount } = readVarInt(buf, i);
    i = afterCount;
    for (let k = 0; k < count; k++) {
        const { value: idx, next } = readVarInt(buf, i);
        i = next;
        const packed = buf[i++];
        map.set(idx, packed);
    }
    return map;
}
```

- [ ] **Step 4: Verify the test passes**

Run: `npx vitest run src/persistence/codec.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/persistence/codec.ts src/persistence/codec.test.ts
git commit -m "feat(persistence): add fluidMeta encode/decode"
```

---

### Task 6: Plumb fluidMeta through the persistence pipeline

**Files:**
- Modify: `src/persistence/adapter.ts`
- Modify: `src/persistence/localStorage.ts`
- Modify: `src/persistence/localStorage.test.ts`
- Modify: `src/persistence/autosave.ts`
- Modify: `src/main.ts`

**Context:** Wire `fluidMeta` end-to-end through the save/load round-trip. Keep the field optional so old saves load cleanly as "all-source" (correct interpretation).

- [ ] **Step 1: Write the failing test**

In `src/persistence/localStorage.test.ts`, add:

```ts
import { describe, it, expect } from 'vitest';
import { LocalStorageAdapter } from './localStorage';
import type { WorldSave } from './adapter';
import { BLOCKS_PER_CHUNK } from '../engine/world/coords';

class MemStorage implements Storage {
    private data = new Map<string, string>();
    get length() { return this.data.size; }
    clear() { this.data.clear(); }
    getItem(k: string) { return this.data.get(k) ?? null; }
    setItem(k: string, v: string) { this.data.set(k, v); }
    removeItem(k: string) { this.data.delete(k); }
    key(i: number) { return Array.from(this.data.keys())[i] ?? null; }
}

describe('LocalStorageAdapter — fluidMeta round-trip', () => {
    it('persists and restores per-chunk fluidMeta', async () => {
        const storage = new MemStorage();
        const adapter = new LocalStorageAdapter(storage);
        const blocks = new Uint8Array(BLOCKS_PER_CHUNK);
        const fluidMeta = new Map<number, number>([[42, 0x82], [777, 0x84]]);
        const save: WorldSave = {
            version: 1,
            seed: 999,
            name: 'test',
            createdAt: 1, updatedAt: 1,
            player: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hotbar: [], selected: 0 },
            chunks: [{ cx: 0, cz: 0, blocks, fluidMeta }],
        };
        await adapter.saveWorld(save);
        const loaded = await adapter.loadWorld(999);
        expect(loaded).not.toBeNull();
        const rc = loaded!.chunks.find((c) => c.cx === 0 && c.cz === 0)!;
        expect(rc.fluidMeta).toBeDefined();
        expect(rc.fluidMeta!.size).toBe(2);
        expect(rc.fluidMeta!.get(42)).toBe(0x82);
        expect(rc.fluidMeta!.get(777)).toBe(0x84);
    });

    it('loads chunks without fluidMeta (legacy save) as undefined', async () => {
        const storage = new MemStorage();
        const adapter = new LocalStorageAdapter(storage);
        const blocks = new Uint8Array(BLOCKS_PER_CHUNK);
        const save: WorldSave = {
            version: 1,
            seed: 999,
            name: 'test',
            createdAt: 1, updatedAt: 1,
            player: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hotbar: [], selected: 0 },
            chunks: [{ cx: 0, cz: 0, blocks }],  // no fluidMeta
        };
        await adapter.saveWorld(save);
        const loaded = await adapter.loadWorld(999);
        const rc = loaded!.chunks.find((c) => c.cx === 0 && c.cz === 0)!;
        expect(rc.fluidMeta).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run src/persistence/localStorage.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend `RawChunk`**

In `src/persistence/adapter.ts`, replace the `RawChunk` line with:

```ts
export type RawChunk = {
    cx: number;
    cz: number;
    blocks: Uint8Array;
    /** Optional sparse fluid metadata (flow voxels only). Absent on legacy saves. */
    fluidMeta?: Map<number, number>;
};
```

- [ ] **Step 4: Update the localStorage adapter to read/write `fluidMeta`**

In `src/persistence/localStorage.ts`, change the storage layout. We'll embed the fluid encoding into the existing per-chunk storage value so we don't add a second key per chunk. Format: store JSON `{ blocks: <oldBlobString>, fluidMeta: <encodedString> }` instead of the bare blob.

Replace the file with:

```ts
import type { PersistenceAdapter, RawChunk, WorldSave, WorldSummary } from './adapter';
import { decodeChunk, decodeFluidMeta, encodeChunk, encodeFluidMeta } from './codec';

type ChunkPayload = { blocks: string; fluidMeta?: string };

const NS = 'minicraft:v1';
const metaKey = (seed: number) => `${NS}:world:${seed}:meta`;
const chunkKey = (seed: number, cx: number, cz: number) => `${NS}:world:${seed}:chunk:${cx}:${cz}`;
const chunkPrefix = (seed: number) => `${NS}:world:${seed}:chunk:`;

export class LocalStorageAdapter implements PersistenceAdapter {
    constructor(private storage: Storage = localStorage) {}

    async loadWorld(seed: number): Promise<WorldSave | null> {
        const metaRaw = this.storage.getItem(metaKey(seed));
        if (!metaRaw) return null;
        const meta = JSON.parse(metaRaw) as Omit<WorldSave, 'chunks'>;

        const chunks: RawChunk[] = [];
        for (let i = 0; i < this.storage.length; i++) {
            const k = this.storage.key(i);
            if (!k || !k.startsWith(chunkPrefix(seed))) continue;
            const suffix = k.slice(chunkPrefix(seed).length);
            const [cxStr, czStr] = suffix.split(':');
            const data = this.storage.getItem(k);
            if (!data) continue;
            const rc = parseChunkPayload(Number(cxStr), Number(czStr), data);
            chunks.push(rc);
        }
        return { ...meta, chunks };
    }

    async saveWorld(save: WorldSave): Promise<void> {
        const metaPayload = {
            version: save.version,
            seed: save.seed,
            name: save.name,
            createdAt: save.createdAt,
            updatedAt: save.updatedAt,
            player: save.player,
            lights: save.lights,
        };

        const encoded: { cx: number; cz: number; data: string }[] = save.chunks.map((c) => {
            const payload: ChunkPayload = { blocks: encodeChunk(c.blocks) };
            if (c.fluidMeta && c.fluidMeta.size > 0) {
                payload.fluidMeta = encodeFluidMeta(c.fluidMeta);
            }
            return { cx: c.cx, cz: c.cz, data: JSON.stringify(payload) };
        });

        try {
            this.storage.setItem(metaKey(save.seed), JSON.stringify(metaPayload));
            const keep = new Set(encoded.map((c) => chunkKey(save.seed, c.cx, c.cz)));
            const toDelete: string[] = [];
            for (let i = 0; i < this.storage.length; i++) {
                const k = this.storage.key(i);
                if (k && k.startsWith(chunkPrefix(save.seed)) && !keep.has(k)) toDelete.push(k);
            }
            toDelete.forEach((k) => this.storage.removeItem(k));
            for (const c of encoded) this.storage.setItem(chunkKey(save.seed, c.cx, c.cz), c.data);
        } catch (err) {
            if (err instanceof DOMException && err.name === 'QuotaExceededError') {
                throw new Error('QUOTA_EXCEEDED');
            }
            throw err;
        }
    }

    async listWorlds(): Promise<WorldSummary[]> {
        const out: WorldSummary[] = [];
        for (let i = 0; i < this.storage.length; i++) {
            const k = this.storage.key(i);
            if (!k || !k.startsWith(`${NS}:world:`) || !k.endsWith(':meta')) continue;
            const raw = this.storage.getItem(k);
            if (!raw) continue;
            const m = JSON.parse(raw) as WorldSummary;
            out.push({
                seed: m.seed,
                name: m.name,
                createdAt: m.createdAt,
                updatedAt: m.updatedAt,
            });
        }
        return out.sort((a, b) => b.updatedAt - a.updatedAt);
    }

    async deleteWorld(seed: number): Promise<void> {
        this.storage.removeItem(metaKey(seed));
        const toDelete: string[] = [];
        for (let i = 0; i < this.storage.length; i++) {
            const k = this.storage.key(i);
            if (k && k.startsWith(chunkPrefix(seed))) toDelete.push(k);
        }
        toDelete.forEach((k) => this.storage.removeItem(k));
    }
}

function parseChunkPayload(cx: number, cz: number, data: string): RawChunk {
    // Legacy saves stored the bare encoded-blocks string here. Detect by trying to JSON.parse.
    try {
        const obj = JSON.parse(data) as ChunkPayload;
        if (obj && typeof obj.blocks === 'string') {
            const rc: RawChunk = { cx, cz, blocks: decodeChunk(obj.blocks) };
            if (obj.fluidMeta) rc.fluidMeta = decodeFluidMeta(obj.fluidMeta);
            return rc;
        }
    } catch {
        // Fall through — legacy format.
    }
    return { cx, cz, blocks: decodeChunk(data) };
}
```

- [ ] **Step 5: Verify the persistence tests pass**

Run: `npx vitest run src/persistence/`
Expected: PASS for the new round-trip test AND existing tests (legacy parse path keeps old saves working).

- [ ] **Step 6: Update autosave to include fluidMeta in `WorldSave.chunks`**

In `src/persistence/autosave.ts`, modify the `chunks` mapping inside `flush()`:

```ts
chunks: this.world
    .modifiedChunks()
    .map((c) => ({
        cx: c.cx,
        cz: c.cz,
        blocks: c.blocks,
        fluidMeta: c.fluidMeta.size > 0 ? new Map(c.fluidMeta) : undefined,
    })),
```

- [ ] **Step 7: Update `main.ts` chunk-load loop to restore fluidMeta**

In `src/main.ts`, find the loaded-chunks loop (around line 73) and change:

```ts
for (const rc of save.chunks) {
    const c = world.ensureChunk(rc.cx, rc.cz);
    c.blocks.set(rc.blocks);
    c.fluidMeta.clear();
    if (rc.fluidMeta) {
        for (const [idx, packed] of rc.fluidMeta) c.fluidMeta.set(idx, packed);
    }
    c.modified = true;
    c.dirty = true;
}
```

- [ ] **Step 8: Run the full test suite**

Run: `npx vitest run`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/persistence/adapter.ts src/persistence/localStorage.ts src/persistence/localStorage.test.ts src/persistence/autosave.ts src/main.ts
git commit -m "feat(persistence): persist per-chunk fluidMeta through save/load"
```

---

## Phase 4: Documentation

### Task 7: Rewrite `docs/liquids.md` to match the new model

**Files:**
- Modify: `docs/liquids.md`

**Context:** The doc currently says fluid spread is unbounded and lists "water-on-lava → obsidian / stone conversion" as an explicit non-goal. Both are now wrong.

- [ ] **Step 1: Edit `docs/liquids.md`**

Apply these changes:

1. In the **Philosophy** section, remove the bullet `Water-on-lava → obsidian / stone conversion.` Keep the other non-goals (partial fill, swimming physics, buckets, animated textures).

2. Add a new **Source vs flow** section after "Block rows" and before "Rendering":

```markdown
## Source vs flow

Every liquid voxel is one of two kinds:

- **Source** — permanent. Created by player placement and by world-gen (the ocean fills with sources). Spreads horizontally up to its budget (water 4, lava 2 hops) and falls vertically with no limit. Removed only by player mining.
- **Flow** — created by spread or fall. Carries an integer `distance` (0–15) = number of *horizontal* hops from the nearest source. Falls do not increment distance. A flow voxel exists only as long as it has a "feeder" each tick (column above, adjacent source, or adjacent flow with lower distance).

Storage: each chunk holds a sparse `fluidMeta: Map<number, number>` of packed bytes (bit 7 = flow marker, bits 0–3 = distance). Sources have **no entry** — so the world-gen ocean has zero entries and zero per-tick cost. The map only grows for flow voxels, which are bounded by the spread radii.

Persistence: the chunk save format gains an optional `fluidMeta` field. Legacy saves with no field load as "all liquid is source", which is correct (any liquid in an old save was either world-gen ocean or player-placed, both source-equivalent under the old rules).
```

3. Replace the **Flow scheduler** section (everything from `## Flow scheduler` through the end of `### Commit phase`) with:

```markdown
## Flow scheduler

Lives in `src/game/liquid-scheduler.ts`. Instantiated by `GameLoop` and ticked each frame with `dt`. Three phases per tick.

### Tick accumulator

```ts
accumulator += dt
if (accumulator < 0.5) return
accumulator = 0   // no catch-up; discard overflow
```

### Phase 1 — spread

For every liquid voxel in each chunk's `liquidFrontier`:

- **Source.** If air below, create flow voxel below at distance 0 (source stays in place). Else if there are air horizontal neighbours, create flow voxels at distance 1.
- **Flow.** If air below, create flow below at same distance and vacate self (UNLESS same-type liquid is above — column rule prevents flicker). Else if `distance < budget`, create flow at horizontal air neighbours at `distance + 1`.

Budgets: water = 4 hops, lava = 2 hops.

Reads are atomic (snapshot of frontier-cell coords). Writes go through `world.setBlockFlow` (for flow) or `world.setBlock` (for AIR), which keep `fluidMeta` and chunk dirtiness in sync.

### Phase 2 — reaction

Scan touched cells + their 6-axis neighbours. For each lava voxel adjacent to ≥1 water voxel: lava → `OBSIDIAN`, each adjacent water → `AIR`. Single pass; reactions don't chain.

### Phase 3 — drain

For each flow voxel in the frontier, check for a valid feeder:

- Same-type liquid directly above (column rule), OR
- Adjacent same-type **source**, OR
- Adjacent same-type **flow** with `distance < this.distance`.

If no feeder, queue the voxel in `chunk.pendingDrain`. Drains are flushed at the *start* of the next tick — so the visible drain rate is one ring per 0.5 s. Sources are never drained.

### Frontier decay

At the end of each tick, frontier entries whose 5 neighbours (±x, ±z, −y) are all non-air drop out of the active set. Stable pool interiors stop costing CPU within a tick of being enclosed.
```

4. In the **Interaction with other systems** section, replace the `Mining` bullet with:

```markdown
- **Mining a flow voxel:** instant delete; neighbour liquids may also drain (cascade) over subsequent ticks if the mined cell was their feeder.
- **Mining a source:** instant delete; downstream flow drains one ring per tick over the next 1–4 seconds.
```

5. In the **Code map** section, update the scheduler line and add the new files:

```markdown
- `src/game/liquid-scheduler.ts` — three-phase tick: `applySpreadStep`, `applyReactionStep`, `applyDrainStep`. Source-vs-flow logic; reads `chunk.fluidMeta`; writes via `world.setBlockFlow` and `world.setBlock`.
- `src/game/liquid-scheduler.test.ts` — covers tick accumulator, fall, spread, budget bounding, reaction, source-removal cascade, two-source redundancy, frontier decay.
- `src/engine/world/chunk.ts` — `liquidFrontier`, `fluidMeta`, `pendingDrain` fields; `isFlow` / `getFlowDistance` / `setFluidMeta` / `clearFluidMeta` accessors.
- `src/engine/world/world.ts` — `setBlock` clears fluidMeta; `setBlockFlow` writes flow with distance.
- `src/persistence/codec.ts` — `encodeFluidMeta` / `decodeFluidMeta`.
- `src/persistence/localStorage.ts` — chunk payload now stores `{ blocks, fluidMeta? }` JSON; legacy bare-blob format still parsed.
```

- [ ] **Step 2: Verify the doc reads well end-to-end**

Open `docs/liquids.md` and read it through. Fix any leftover references to the old behaviour.

- [ ] **Step 3: Commit**

```bash
git add docs/liquids.md
git commit -m "docs(liquids): document source/flow model and three-phase tick"
```

---

## Phase 5: Manual verification (no test, but DO IT)

### Task 8: Browser-test the feature

**Files:** none — this is hands-on validation.

- [ ] **Step 1: Build and serve**

```bash
npm run dev
```

Open the printed local URL in a browser.

- [ ] **Step 2: Test bounded spread**

1. Create a flat patch and place a single water source. Confirm it spreads to a ~9-wide diamond and stops.
2. Place a single lava source. Confirm it spreads to ~5-wide and stops.
3. Drop a lava block on the unmodified terrain (the original bug repro). Confirm framerate stays stable and the lava forms a small puddle, not a sheet.

- [ ] **Step 3: Test reaction**

1. Place lava. Place water adjacent to it. Confirm the lava becomes obsidian and the water disappears within ~1 tick (≤ 0.5 s).
2. Try the reverse order. Same outcome.

- [ ] **Step 4: Test waterfall**

1. Build a 10-block-tall pillar. Place water on top.
2. Confirm the water flows down the column and pools 4-wide at the bottom.

- [ ] **Step 5: Test cascade drain**

1. After the waterfall pools, mine the source on top. Confirm the column and pool drain visibly over a few seconds.

- [ ] **Step 6: Test persistence**

1. Make a small puddle. Wait ~6 s for the autosave debounce.
2. Reload the page and "Continue" the world. Confirm the puddle is intact and (e.g. by mining the source) drain still works.

- [ ] **Step 7: If anything misbehaves, capture details and stop**

Don't paper over failures with quick fixes. Report what you saw and check the relevant phase logic against the spec.

- [ ] **Step 8: If everything looks correct, mark the feature done**

```bash
git status   # confirm working tree clean
```

---

## Out of scope for this plan (per spec)

- Two-source-merge → infinite water (Minecraft rule).
- Cobblestone-from-flowing-lava-meets-water and stone-from-lava-flowing-into-water (the softer Minecraft reactions).
- Sloped surface geometry / partial-fill rendering.
- Buckets / fluid pickup / fluid-as-item.
- Pressure, current, entity displacement.
