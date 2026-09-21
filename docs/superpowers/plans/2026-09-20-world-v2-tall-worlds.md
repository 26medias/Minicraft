# World v2 (256-tall worlds) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** New worlds are 256 blocks tall (surface ≈ 120, bedrock at 0); every existing 64-tall world keeps loading, rendering and saving exactly as today.

**Architecture:** The chunk stays a flat 16×H×16 column, with H a per-world value (`World.height`, `Chunk.height`) instead of a constant. World generation is versioned per world (`genVersion` 1 = today's code, verbatim; 2 = tall placeholder). Tall worlds are a new, additive save format (v3) under new localStorage keys (`minicraft:v3:*`), a new GCS prefix (`worlds3/`) and new API routes (`/v3/worlds*`); every v1/v2 reader and writer path is left byte-for-byte alone. Load fails closed: a record that cannot be fully parsed is never opened and never autosaved.

**Tech Stack:** TypeScript strict, Vite, Three.js (untouched), vitest, zod (API), express (API), pako.

**Spec:** `docs/superpowers/specs/2026-09-20-world-v2-tall-worlds-design.md` — read it first; §2 lists every baked-height site, §4 the fail-closed policy, §7 the tests each task must turn red-then-green.

## Global Constraints

- Branch `v2`. Indentation: tabs (1 tab = 4 spaces per repo rule). `npm test` (vitest, covers `src/**` and `api/src/**`) must be green after **every** task; `npm run build` (tsc -b + vite) must pass after Tasks 1, 7, 11.
- Heights are exactly `64 | 256` (`WorldHeight`). `indexOf(x, y, z) = y*256 + z*16 + x` is height-independent and is NOT changed.
- **Never** edit the v1/v2 storage key formats, the old `/worlds*` API routes' behaviour, or `worldSaveWireSchema` (v2, `z.literal(2)`). Never migrate a record between versions; a world's `version` is fixed for life.
- **Never** re-record `EXPECTED_HASH` in `generation.test.ts` (gen v1 must stay byte-identical). The gen v2 hash is recorded once, in Task 4, and never again.
- Commit after every task with explicit paths (`git add <paths>`, never `git add -A`). Commit trailer on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WkqJrcc2U5KmXWvtU969AW
  ```
- Browser verification (Task 13) runs ONLY against `http://localhost:5173` with the save API intercepted. Never touch `https://noah.leap-forward.ca`. The local dev server also talks to the **production** save API unless intercepted — always intercept.
- Throwaway probe files must be deleted before a task's commit.

## Dependency table

| Task | Depends on | Can run in parallel with |
|---|---|---|
| 1 Height plumbing | — | — (everything waits on it) |
| 2 Lighting cursor queue | 1 | 4, 5, 6 |
| 3 Shadows early-out | 1, **2** (its 256 fixture lights 9 chunks; on the shift() queue that is ~1.8 s each and the test times out) | 4, 5, 6 |
| 4 Generation dispatch + bedrock | 1 | 2, 3, 6 |
| 5 Player / TNT / loop + engine tests at 256 | 1, 4 | 2, 3, 6 |
| 6 Codec expectedLength (client + API) + parity | 1 | 2, 3, 4, 5 |
| 7 Persistence records: types, World meta, autosave, localStorage v3 | 1, 6 | 10 |
| 8 Cloud adapter v3 | 7 | 10 |
| 9 Dual adapter fail-closed | 8 | 10 |
| 10 API v3 routes + deploy.sh | 6 | 7, 8, 9 |
| 11 Start-up fail-closed + menu | 4, 5, 9 | — |
| 12 Docs | 11 | 13 |
| 13 Browser verification | 10, 11 | 12 |

Parallel tasks touch disjoint files; each commits only its own paths.

**Execution note.** Every task's exit criterion is the FULL `npm test` (src + api) plus `npx tsc --noEmit`, so two tasks cannot share a working tree. Parallel tasks run in separate `git worktree`s on their own branches (`task/N`, cut from `v2` at the point their dependencies have merged). A merge step (parent) fast-forwards or merges each `task/N` into `v2` in dependency order and re-runs `npm test && npx tsc --noEmit && (cd api && npx tsc --noEmit)` on `v2` after every merge; a red merge is fixed on `v2` before the next one. Timing tests in Tasks 2 and 3 have thresholds sized for a loaded machine (several agents running at once); do not tighten them.

## Shared definitions (repeated in each task that uses them)

```ts
// src/engine/world/coords.ts (after Task 1)
export type WorldHeight = 64 | 256;
export const LEGACY_HEIGHT: WorldHeight = 64;
export function blocksPerChunk(height: number): number;        // throws unless 64 | 256
export function inBounds(x: number, y: number, z: number, height: number): boolean;

// src/engine/world/chunk.ts
class Chunk { constructor(cx: number, cz: number, height: WorldHeight = LEGACY_HEIGHT); readonly height: WorldHeight; }

// src/engine/world/world.ts
type WorldOptions = { height?: WorldHeight; genVersion?: number; saveVersion?: 2 | 3 };
class World {
	constructor(seed: number, opts?: WorldOptions);   // defaults: height 64, genVersion derived from height (64 -> 1, 256 -> 2), saveVersion 2. The constructor NEVER validates height vs genVersion (spec §4: a stored record's height is authoritative); World.create (Task 4) and applySave (Task 11) are where the pair is checked.
	readonly height: WorldHeight; readonly genVersion: number; readonly saveVersion: 2 | 3;
	inBounds(x: number, y: number, z: number): boolean;
	static create(seed: number): World;                // newest genVersion, its profile height, saveVersion 3 (Task 4)
}

// src/persistence/errors.ts (Task 7)
export class SaveCorrupt extends Error { name = 'SaveCorrupt' }
export class SaveMismatch extends Error { name = 'SaveMismatch' }
```

---

### Task 1: Per-world height plumbing (behaviour unchanged at 64)

**Files:**
- Modify: `src/engine/world/coords.ts` (remove `CHUNK_SIZE_Y`, `BLOCKS_PER_CHUNK`; change `inBounds`)
- Modify: `src/engine/world/chunk.ts:1-22`
- Modify: `src/engine/world/world.ts:1-16, 39, 46, 69, 86`
- Modify: `src/engine/world/lighting.ts:4, 62, 96, 136, 226, 359, 432, 452`
- Modify: `src/engine/world/shadows.ts:4, 19, 93`
- Modify: `src/engine/world/mesher.ts:4, 163, 191, 229, 354, 416, 494`
- Modify: `src/game/loop.ts:336`
- Modify: `src/game/tnt.ts:3, 37, 49`
- Modify: `src/persistence/codec.ts:2, 5, 26, 36, 39` (temporary: a local `LEGACY_BLOCKS_PER_CHUNK = 16384`; Task 6 replaces it)
- Modify: `src/engine/world/generation.ts` (signature only: accept and ignore a third `genVersion` argument so Task 4's dispatch is a drop-in)
- Modify tests: `src/engine/world/coords.test.ts`, `chunk.test.ts`, `generation.test.ts:5,48`, `lighting.test.ts:5,24`, `src/persistence/localStorage.test.ts:4`, `cloud.test.ts:4`, `dual.test.ts:6`, **`src/persistence/codec.test.ts:4`** (imports `BLOCKS_PER_CHUNK` from coords — vitest gives NO import error when a named export disappears, the binding is silently `undefined` and `new Uint16Array(undefined)` is length 0, so the suite goes 6 red if this file is missed), `api/src/codec.parity.test.ts` (unchanged — see step 6); cosmetic: `world.test.ts:23`, `player.test.ts:97,184,235`, `raycast.test.ts:11` get an explicit `{ height: 64 }` world

**Interfaces:**
- Produces:
  ```ts
  // coords.ts
  export type WorldHeight = 64 | 256;
  export const LEGACY_HEIGHT: WorldHeight = 64;
  export function blocksPerChunk(height: number): number; // 16*height*16; throws RangeError unless height is 64 or 256
  export function inBounds(x: number, y: number, z: number, height: number): boolean;
  // chunk.ts
  new Chunk(cx, cz, height: WorldHeight = LEGACY_HEIGHT); chunk.height
  // world.ts
  new World(seed, { height?, genVersion?, saveVersion? }); world.height; world.genVersion; world.saveVersion; world.inBounds(x,y,z)
  // genVersion defaults from height: 64 -> 1, 256 -> 2. No validation in the constructor.
  // generation.ts (this task): export function generateChunk(chunk: Chunk, seed: number, genVersion = 1): void  -- genVersion is ACCEPTED AND IGNORED here (v1 body runs at any height; 256 fixtures overwrite the blocks). Task 4 turns it into the dispatcher.
  ```
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests** — replace `src/engine/world/coords.test.ts` entirely:

```ts
import { describe, it, expect } from 'vitest';
import {
	CHUNK_SIZE_X, CHUNK_SIZE_Z, WORLD_CHUNKS_X, LEGACY_HEIGHT,
	blocksPerChunk, indexOf, worldToChunk, inBounds,
} from './coords';

describe('coords', () => {
	it('has the documented chunk footprint', () => {
		expect(CHUNK_SIZE_X).toBe(16);
		expect(CHUNK_SIZE_Z).toBe(16);
		expect(LEGACY_HEIGHT).toBe(64);
	});

	it('blocksPerChunk accepts exactly the two world heights', () => {
		expect(blocksPerChunk(64)).toBe(16384);
		expect(blocksPerChunk(256)).toBe(65536);
		expect(() => blocksPerChunk(128)).toThrow(RangeError);
		expect(() => blocksPerChunk(Number.NaN)).toThrow(RangeError);
		expect(() => blocksPerChunk(undefined as unknown as number)).toThrow(RangeError);
	});

	it('indexOf is bijective within a chunk at both heights', () => {
		for (const h of [64, 256]) {
			const seen = new Set<number>();
			for (let y = 0; y < h; y++)
				for (let z = 0; z < CHUNK_SIZE_Z; z++)
					for (let x = 0; x < CHUNK_SIZE_X; x++) {
						const i = indexOf(x, y, z);
						expect(i).toBeGreaterThanOrEqual(0);
						expect(i).toBeLessThan(blocksPerChunk(h));
						expect(seen.has(i)).toBe(false);
						seen.add(i);
					}
			expect(seen.size).toBe(blocksPerChunk(h));
		}
	});

	it('worldToChunk splits into chunk + local coords', () => {
		expect(worldToChunk(0, 0)).toEqual({ cx: 0, cz: 0, lx: 0, lz: 0 });
		expect(worldToChunk(15, 15)).toEqual({ cx: 0, cz: 0, lx: 15, lz: 15 });
		expect(worldToChunk(16, 0)).toEqual({ cx: 1, cz: 0, lx: 0, lz: 0 });
		expect(worldToChunk(17, 32)).toEqual({ cx: 1, cz: 2, lx: 1, lz: 0 });
	});

	it('inBounds respects the finite world at the given height', () => {
		expect(inBounds(0, 0, 0, 64)).toBe(true);
		expect(inBounds(CHUNK_SIZE_X * WORLD_CHUNKS_X - 1, 0, 0, 64)).toBe(true);
		expect(inBounds(CHUNK_SIZE_X * WORLD_CHUNKS_X, 0, 0, 64)).toBe(false);
		expect(inBounds(0, -1, 0, 64)).toBe(false);
		expect(inBounds(0, 64, 0, 64)).toBe(false);
		expect(inBounds(0, 64, 0, 256)).toBe(true);
		expect(inBounds(0, 255, 0, 256)).toBe(true);
		expect(inBounds(0, 256, 0, 256)).toBe(false);
	});
});
```

Add to `src/engine/world/chunk.test.ts` (replace the two `BLOCKS_PER_CHUNK` uses with `blocksPerChunk(64)` via `import { blocksPerChunk } from './coords';`) and append:

```ts
describe('Chunk height', () => {
	it('defaults to the legacy 64 and sizes every array from it', () => {
		const c = new Chunk(0, 0);
		expect(c.height).toBe(64);
		expect(c.blocks.length).toBe(16 * 64 * 16);
		expect(c.lights.length).toBe(16 * 64 * 16);
		expect(c.sunlit.length).toBe(16 * 64 * 16);
	});
	it('allocates 65536 entries at height 256', () => {
		const c = new Chunk(2, 3, 256);
		expect(c.height).toBe(256);
		expect(c.blocks.length).toBe(65536);
		expect(c.lights.length).toBe(65536);
		expect(c.sunlit.length).toBe(65536);
		c.set(5, 250, 5, 3);
		expect(c.get(5, 250, 5)).toBe(3);
	});
});
```

Add to `src/engine/world/world.test.ts` (append; imports already include `World`, `AIR`, `BLOCK_BY_NAME`):

```ts
describe('World height', () => {
	it('defaults to 64 / genVersion 1 / saveVersion 2', () => {
		const w = new World(1);
		expect(w.height).toBe(64);
		expect(w.genVersion).toBe(1);
		expect(w.saveVersion).toBe(2);
		expect(w.inBounds(0, 63, 0)).toBe(true);
		expect(w.inBounds(0, 64, 0)).toBe(false);
	});
	it('derives genVersion 2 from height 256 unless told otherwise', () => {
		expect(new World(1, { height: 256 }).genVersion).toBe(2);
		expect(new World(1, { height: 256, genVersion: 7 }).genVersion).toBe(7); // stored records win; no validation here
	});
	it('creates 256-tall chunks when told to and bounds y by it', () => {
		const w = new World(1, { height: 256, saveVersion: 3 });
		const c = w.ensureChunk(0, 0);
		expect(c.height).toBe(256);
		expect(w.inBounds(0, 255, 0)).toBe(true);
		expect(w.inBounds(0, 256, 0)).toBe(false);
		const stone = BLOCK_BY_NAME['stone'].id;
		w.setBlock(3, 250, 3, stone);
		expect(w.getBlock(3, 250, 3)).toBe(stone);
		expect(w.getBlock(3, 256, 3)).toBe(AIR);
	});
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/engine/world/coords.test.ts src/engine/world/chunk.test.ts src/engine/world/world.test.ts`
Expected: FAIL — `blocksPerChunk`/`LEGACY_HEIGHT` not exported; `c.height` undefined.

- [ ] **Step 3: Implement coords.ts**

Replace the file's first 4 lines and `inBounds` with:

```ts
export const CHUNK_SIZE_X = 16;
export const CHUNK_SIZE_Z = 16;

/** The only two column heights that exist. 64 is every world saved before v3. */
export type WorldHeight = 64 | 256;
export const LEGACY_HEIGHT: WorldHeight = 64;

export function isWorldHeight(h: unknown): h is WorldHeight {
	return h === 64 || h === 256;
}

/** Fails closed: an undefined/NaN height must never size an array (that gives length 0). */
export function blocksPerChunk(height: number): number {
	if (!isWorldHeight(height)) throw new RangeError(`Unsupported world height: ${String(height)}`);
	return CHUNK_SIZE_X * height * CHUNK_SIZE_Z;
}
```

(keep `WORLD_CHUNKS_X/Z`, `WORLD_SIZE_X/Z`, `indexOf`, `worldToChunk` as they are) and:

```ts
export function inBounds(x: number, y: number, z: number, height: number): boolean {
	return x >= 0 && x < WORLD_SIZE_X && y >= 0 && y < height && z >= 0 && z < WORLD_SIZE_Z;
}
```

- [ ] **Step 4: Implement chunk.ts and world.ts**

`chunk.ts` head:

```ts
import type { BlockId } from '../../data/blocks.data';
import { LEGACY_HEIGHT, blocksPerChunk, indexOf, type WorldHeight } from './coords';

export class Chunk {
	readonly cx: number;
	readonly cz: number;
	readonly height: WorldHeight;
	readonly blocks: Uint16Array;
	readonly lights: Uint16Array;
	readonly sunlit: Uint8Array;
	// ... (liquidFrontier, fluidMeta, dirty, modified, shadowsDirty unchanged)

	constructor(cx: number, cz: number, height: WorldHeight = LEGACY_HEIGHT) {
		this.cx = cx;
		this.cz = cz;
		this.height = height;
		const n = blocksPerChunk(height);
		this.blocks = new Uint16Array(n);
		this.lights = new Uint16Array(n);
		this.sunlit = new Uint8Array(n);
	}
```

`world.ts`:

```ts
import { WORLD_CHUNKS_X, WORLD_CHUNKS_Z, LEGACY_HEIGHT, inBounds, worldToChunk, indexOf, type WorldHeight } from './coords';

export type WorldOptions = { height?: WorldHeight; genVersion?: number; saveVersion?: 2 | 3 };

export class World {
	readonly seed: number;
	readonly height: WorldHeight;
	readonly genVersion: number;
	readonly saveVersion: 2 | 3;
	private chunks = new Map<string, Chunk>();

	constructor(seed: number, opts: WorldOptions = {}) {
		this.seed = seed;
		this.height = opts.height ?? LEGACY_HEIGHT;
		// Derived, not validated: a loaded record's own height is authoritative (spec §4).
		this.genVersion = opts.genVersion ?? (this.height === 256 ? 2 : 1);
		this.saveVersion = opts.saveVersion ?? 2;
	}

	inBounds(x: number, y: number, z: number): boolean {
		return inBounds(x, y, z, this.height);
	}
```

In `ensureChunk`: `c = new Chunk(cx, cz, this.height);` and `generateChunk(c, this.seed, this.genVersion);`. In `generation.ts` change the signature to `export function generateChunk(chunk: Chunk, seed: number, _genVersion = 1): void` — the body is untouched and still writes v1 terrain (y 24–34) into whatever height the chunk has; every 256 fixture in Tasks 2/3/5 does `blocks.fill(AIR)` right after `ensureChunk`, and Task 4 replaces this stub with the real dispatcher. (Without this stub Task 4's dispatcher would throw for every `new World(seed, { height: 256 })` fixture written in Tasks 2/3/5, which are developed in parallel with it.) Replace the four bare `inBounds(x, y, z)` calls (getBlock, setBlock, setBlockFlow, markLiquidFrontier) with `this.inBounds(x, y, z)`.

- [ ] **Step 5: Fix every other engine site (no behaviour change at 64)**

`lighting.ts`: import `{ CHUNK_SIZE_X, CHUNK_SIZE_Z, indexOf }` only. Replace:
- :62 `for (let y = CHUNK_SIZE_Y - 1; ...)` → `for (let y = chunk.height - 1; ...)`
- :96, :226, :359, :432 `if (ny < 0 || ny >= CHUNK_SIZE_Y) continue;` → `if (ny < 0 || ny >= world.height) continue;`
- :136 `for (let y = 0; y < CHUNK_SIZE_Y; y++)` → `for (let y = 0; y < chunk.height; y++)`
- :452 `for (let y = CHUNK_SIZE_Y - 1; ...)` → `for (let y = chunk.height - 1; ...)`

`shadows.ts`: import `{ CHUNK_SIZE_X, CHUNK_SIZE_Z, indexOf }`; :19 `y < CHUNK_SIZE_Y` → `y < chunk.height`; :93 `if (iy >= CHUNK_SIZE_Y) return false;` → `if (iy >= world.height) return false;`.

`mesher.ts`: import `{ CHUNK_SIZE_X, CHUNK_SIZE_Z, indexOf }`; :163, :191, :229, :354 `y >= CHUNK_SIZE_Y` → `y >= chunk.height`; :416 and :494 loop bounds → `y < chunk.height`.

`loop.ts:336` `for (let y = 0; y < 64; y++)` → `for (let y = 0; y < c.height; y++)`.

`tnt.ts`: delete the `import { inBounds } from '../engine/world/coords';` line; :37 `inBounds(ox, oy, oz)` → `world.inBounds(ox, oy, oz)`; :49 `!inBounds(x, y, z)` → `!world.inBounds(x, y, z)`.

`codec.ts` (temporary, Task 6 finishes it): replace `import { BLOCKS_PER_CHUNK } from '../engine/world/coords';` with `const BLOCKS_PER_CHUNK = 16 * 64 * 16; // Task 6 parameterises this`.

- [ ] **Step 6: Fix the tests that imported the deleted constants**

- `generation.test.ts:5` → `import { CHUNK_SIZE_X, CHUNK_SIZE_Z } from './coords';` and :48 `CHUNK_SIZE_Y - 1` → `63` (it is a v1 test; the literal is its meaning).
- `lighting.test.ts:5` → `import { indexOf } from './coords';` and :24 `y < CHUNK_SIZE_Y` → `y < 64`.
- `localStorage.test.ts:4`, `cloud.test.ts:4`, `dual.test.ts:6`, **`codec.test.ts:4`**: replace `import { BLOCKS_PER_CHUNK } from '../engine/world/coords';` with `const BLOCKS_PER_CHUNK = 16 * 64 * 16;`.
- Cosmetic, per spec §2: `world.test.ts:23`, `player.test.ts:97,184,235`, `raycast.test.ts:11` — where those tests build a `new World(seed)` and then rely on a literal 63/64, pass `{ height: 64 }` explicitly so the test states the height it encodes. No assertion changes.
- `api/src/codec.parity.test.ts`: unchanged (it imports `BLOCKS_PER_CHUNK` from `./codec`, the API copy, which Task 6 handles).

- [ ] **Step 7: Run the whole suite and the build**

Run: `npm test && npm run build`
Expected: all 38+ files green (the 3 new describes included); build passes; `npx tsc --noEmit` clean (vitest does not type-check — a missed import shows up only here or as a silent `undefined`). `grep -rn "CHUNK_SIZE_Y\|BLOCKS_PER_CHUNK" src api/src --include=*.ts` must list ONLY `src/persistence/codec.ts` (local const), the four test-local consts (localStorage/cloud/dual/codec tests), and `api/src/codec*.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/engine/world/coords.ts src/engine/world/chunk.ts src/engine/world/world.ts src/engine/world/generation.ts src/engine/world/lighting.ts src/engine/world/shadows.ts src/engine/world/mesher.ts src/game/loop.ts src/game/tnt.ts src/persistence/codec.ts src/engine/world/coords.test.ts src/engine/world/chunk.test.ts src/engine/world/world.test.ts src/engine/world/generation.test.ts src/engine/world/lighting.test.ts src/persistence/localStorage.test.ts src/persistence/cloud.test.ts src/persistence/dual.test.ts src/persistence/codec.test.ts src/game/player.test.ts src/engine/input/raycast.test.ts
git commit -m "refactor(world): per-world height on World and Chunk; drop CHUNK_SIZE_Y

Behaviour unchanged: every world is still 64 tall. Prepares v3 tall worlds.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WkqJrcc2U5KmXWvtU969AW"
```

---

### Task 2: Lighting BFS cursor queue + 256-high skylight tests

**Files:**
- Modify: `src/engine/world/lighting.ts` — `propagateSkylight` (:74), `propagateBlockLight` (:214), `removeAndReflood` (:354)
- Test: `src/engine/world/lighting.test.ts` (append)

**Interfaces:**
- Consumes: `new World(seed, { height: 256 })`, `Chunk.height` (Task 1); `fillChunkLights(world, chunk)`, `updateLightsForBlockChange(world, x, y, z)` (existing, unchanged signatures).
- Produces: nothing new; same exports.

- [ ] **Step 1: Write the failing tests** — append to `lighting.test.ts`:

```ts
function tallEmptyWorld(): World {
	const w = new World(1, { height: 256 });
	const c = w.ensureChunk(0, 0);
	c.blocks.fill(AIR);
	c.lights.fill(0);
	c.liquidFrontier.clear();
	return w;
}

describe('skylight at height 256', () => {
	it('lights an all-air column to 15 at y 255, 200, 64 and 0', () => {
		const w = tallEmptyWorld();
		const c = w.getChunk(0, 0)!;
		fillChunkLights(w, c);
		for (const y of [255, 200, 64, 0]) expect(c.getSky(3, y, 3)).toBe(15);
	});

	it('re-seeding a column under a roof at y=200 does not light y 0..63 from a stale 63 start', () => {
		// A roof across the whole chunk at y=200 and one stone at (5,100,5). Removing the
		// stone triggers reSeedSkylightColumn for column (5,5). A correct re-seed walks
		// from height-1, hits the roof at 200 and seeds nothing below it. A re-seed that
		// still starts at y=63 begins UNDER the roof and wrongly lights y 0..63 to 15.
		// (Removing a roof block instead does not discriminate: refloodFromNeighbors
		// already refills that column from the sky-15 voxel above it.)
		const w = tallEmptyWorld();
		const c = w.getChunk(0, 0)!;
		for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) c.blocks[indexOf(x, 200, z)] = stone;
		c.blocks[indexOf(5, 100, 5)] = stone;
		fillChunkLights(w, c);
		expect(c.getSky(5, 30, 5)).toBe(0);
		w.setBlock(5, 100, 5, AIR);
		updateLightsForBlockChange(w, 5, 100, 5);
		expect(c.getSky(5, 30, 5)).toBe(0);   // "expected 15 to be 0" on a stale 63
		expect(c.getSky(5, 150, 5)).toBe(0);
	});

	it('fills an all-air 256 chunk in under 250 ms (shift() queue measured ~1800 ms)', () => {
		// Threshold is loose on purpose: the suite runs alongside other agents.
		// Cursor queue measured 2.4 ms; the gap to 250 ms is contention headroom.
		const w = tallEmptyWorld();
		const c = w.getChunk(0, 0)!;
		fillChunkLights(w, c); // warm-up
		const t0 = performance.now();
		fillChunkLights(w, c);
		expect(performance.now() - t0).toBeLessThan(250);
	});
});
```

- [ ] **Step 2: Run to verify the perf test fails**

Run: `npx vitest run src/engine/world/lighting.test.ts -t "height 256"`
Expected: the first two pass (Task 1 already made the sites height-aware; the roof test goes red only on an implementation that regresses :452 to 63), the perf test FAILS (~1800 ms).

- [ ] **Step 3: Replace `queue.shift()` with a head cursor** in all three BFS loops. Pattern (apply identically in `propagateSkylight`, `propagateBlockLight`, and the `remQueue` loop of `removeAndReflood`):

```ts
function propagateSkylight(world: World, queue: Coord[], touched: Set<Chunk>): void {
	// Head-index cursor instead of Array.shift(): shift is O(n) and V8's fast
	// path dies past ~8k entries; a 256-high air column seeds 32k. Measured
	// 492 ms -> 2.4 ms per chunk.
	for (let head = 0; head < queue.length; head++) {
		const { x, y, z } = queue[head];
		// ... body unchanged; pushes still append to `queue`
	}
}
```

- [ ] **Step 4: Run the lighting suite**

Run: `npx vitest run src/engine/world/lighting.test.ts`
Expected: PASS (all, including the < 250 ms test).

- [ ] **Step 5: Full suite, then commit**

Run: `npm test` → green.

```bash
git add src/engine/world/lighting.ts src/engine/world/lighting.test.ts
git commit -m "perf(lighting): cursor queue for the light BFS; skylight tests at 256

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WkqJrcc2U5KmXWvtU969AW"
```

---

### Task 3: Shadow heightmap early-out with brute-force equivalence

**Files:**
- Modify: `src/engine/world/shadows.ts`
- Test: `src/engine/world/shadows.test.ts` (append)

**Interfaces:**
- Consumes: `World.height`, `World.getChunk`, `Chunk.height` (Task 1); the cursor-queue `fillChunkLights` (Task 2 — REQUIRED: the 256 fixture lights 9 chunks, ~1.8 s each on the old queue, and the test times out at 5 s).
- Produces: `computeChunkShadows(world, chunk)` unchanged signature; new exported helper `maxOpaqueY(chunk: Chunk): number` (-1 for an all-passable chunk).

- [ ] **Step 1: Write the failing test** — append to `shadows.test.ts`:

```ts
import { computeChunkShadows, maxOpaqueY } from './shadows';   // replace the existing import line
import { BLOCKS } from '../../data/blocks.data';

/** The pre-early-out algorithm, kept verbatim so the optimised one is checked against it. */
function bruteShadows(w: World, chunk: ReturnType<World['ensureChunk']>): Uint8Array {
	const out = new Uint8Array(chunk.sunlit.length);
	const raw: [number, number, number] = [-0.5, 1.0, -0.3];
	const len = Math.hypot(...raw);
	const dx = raw[0] / len, dy = raw[1] / len, dz = raw[2] / len;
	const baseX = chunk.cx * 16, baseZ = chunk.cz * 16;
	const opaque = (id: number) => { const d = BLOCKS[id]; return !!d && d.lightFilter >= 15 && d.liquid === 'none'; };
	const hits = (ox: number, oy: number, oz: number): boolean => {
		let ix = Math.floor(ox), iy = Math.floor(oy), iz = Math.floor(oz);
		const sx = dx > 0 ? 1 : -1, sy = 1, sz = dz > 0 ? 1 : -1;
		const tdx = Math.abs(1 / dx), tdy = Math.abs(1 / dy), tdz = Math.abs(1 / dz);
		let tmx = (sx > 0 ? ix + 1 - ox : ox - ix) * tdx;
		let tmy = (iy + 1 - oy) * tdy;
		let tmz = (sz > 0 ? iz + 1 - oz : oz - iz) * tdz;
		let t = 0;
		while (t < 32) {
			if (tmx < tmy && tmx < tmz) { ix += sx; t = tmx; tmx += tdx; }
			else if (tmy < tmz) { iy += sy; t = tmy; tmy += tdy; }
			else { iz += sz; t = tmz; tmz += tdz; }
			if (iy >= w.height || iy < 0) return false;
			const c = w.getChunk(Math.floor(ix / 16), Math.floor(iz / 16));
			if (!c) return false;
			const lx = ((ix % 16) + 16) % 16, lz = ((iz % 16) + 16) % 16;
			if (opaque(c.blocks[indexOf(lx, iy, lz)])) return true;
		}
		return false;
	};
	for (let y = 0; y < chunk.height; y++)
		for (let z = 0; z < 16; z++)
			for (let x = 0; x < 16; x++) {
				const i = indexOf(x, y, z);
				if (opaque(chunk.blocks[i])) { out[i] = 0; continue; }
				if (chunk.getSky(x, y, z) === 0) { out[i] = 0; continue; }
				out[i] = hits(baseX + x + 0.5, y + 0.5, baseZ + z + 0.5) ? 0 : 1;
			}
	return out;
}

/** 3x3 loaded chunks around (1,1): flat stone floor at `floorY`, a 6x1x6 stone plate at `plateY` in the NW neighbour (0,0). */
function terrainFixture(height: 64 | 256, floorY: number, plateY: number): World {
	const w = new World(7, { height });
	for (let cx = 0; cx <= 2; cx++)
		for (let cz = 0; cz <= 2; cz++) {
			const c = w.ensureChunk(cx, cz);
			c.blocks.fill(AIR);
			c.lights.fill(0);
			c.liquidFrontier.clear();
			for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) c.blocks[indexOf(x, floorY, z)] = stone;
		}
	const nw = w.getChunk(0, 0)!;
	for (let x = 10; x < 16; x++) for (let z = 10; z < 16; z++) nw.blocks[indexOf(x, plateY, z)] = stone;
	for (let cx = 0; cx <= 2; cx++) for (let cz = 0; cz <= 2; cz++) fillChunkLights(w, w.getChunk(cx, cz)!);
	return w;
}

describe('computeChunkShadows — heightmap early-out equivalence', () => {
	for (const [height, floorY, plateY] of [[64, 30, 50], [256, 120, 200]] as const) {
		it(`matches the brute-force result byte for byte at height ${height}`, () => {
			const w = terrainFixture(height, floorY, plateY);
			const c = w.getChunk(1, 1)!;
			const expected = bruteShadows(w, c);
			computeChunkShadows(w, c);
			expect(c.sunlit).toEqual(expected);
			// The fixture must exercise the cross-chunk case: some voxel of (1,1)
			// between the floor and the plate is shaded by the plate in (0,0).
			let shaded = 0;
			for (let y = floorY + 1; y < plateY; y++)
				for (let z = 0; z < 16; z++)
					for (let x = 0; x < 16; x++) if (c.sunlit[indexOf(x, y, z)] === 0 && c.getSky(x, y, z) > 0) shaded++;
			expect(shaded).toBeGreaterThan(0);
		});
	}

	it('maxOpaqueY reports the highest opaque voxel or -1', () => {
		const w = new World(1, { height: 256 });
		const c = w.ensureChunk(0, 0);
		c.blocks.fill(AIR);
		expect(maxOpaqueY(c)).toBe(-1);
		c.blocks[indexOf(4, 130, 4)] = stone;
		expect(maxOpaqueY(c)).toBe(130);
	});

	it('is fast on a 256 column with only a floor (sky voxels skip the raycast)', () => {
		// Floor-only fixture: plateY = floorY puts the "plate" inside the floor, so the
		// neighbourhood max is 120 and every voxel above skips the ray. Measured ~19 ms
		// with the early-out vs ~465 ms brute force. With a plate at 200 the 80 air
		// layers between floor and plate still raycast (~100 ms) — that fixture is for
		// the equivalence test, not this one. 150 ms leaves headroom for a loaded box.
		const w = terrainFixture(256, 120, 120);
		const c = w.getChunk(1, 1)!;
		computeChunkShadows(w, c);
		const t0 = performance.now();
		computeChunkShadows(w, c);
		expect(performance.now() - t0).toBeLessThan(150);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/engine/world/shadows.test.ts`
Expected: FAIL — `maxOpaqueY` not exported; the perf test fails (~465 ms).

- [ ] **Step 3: Implement the early-out** in `shadows.ts`:

```ts
/** Highest y holding an opaque, non-liquid block, or -1. Scanned from blocks on every call: a cached value goes stale the moment a block is placed at y=250. */
export function maxOpaqueY(chunk: Chunk): number {
	for (let y = chunk.height - 1; y >= 0; y--) {
		const base = y * CHUNK_SIZE_X * CHUNK_SIZE_Z;
		for (let i = 0; i < CHUNK_SIZE_X * CHUNK_SIZE_Z; i++) {
			const def = BLOCKS[chunk.blocks[base + i]];
			if (def && def.lightFilter >= 15 && def.liquid === 'none') return y;
		}
	}
	return -1;
}

function neighbourhoodMaxOpaqueY(world: World, chunk: Chunk): number {
	let m = -1;
	for (let dx = -1; dx <= 1; dx++)
		for (let dz = -1; dz <= 1; dz++) {
			const c = world.getChunk(chunk.cx + dx, chunk.cz + dz);
			if (c) m = Math.max(m, maxOpaqueY(c));
		}
	return m;
}
```

In `computeChunkShadows`, before the loops: `const skyFrom = neighbourhoodMaxOpaqueY(world, chunk) + 1;` and inside the loop, after the `getSky === 0` check:

```ts
				// The sun ray only goes up (dy > 0) and, within MAX_SHADOW_DIST, at most
				// one chunk sideways. Above every opaque block of the 3x3 neighbourhood
				// there is nothing to hit. Measured: 1.47M ray steps -> 10.6k at 256.
				if (y >= skyFrom) {
					chunk.sunlit[idx] = 1;
					continue;
				}
```

- [ ] **Step 4: Run, then the full suite**

Run: `npx vitest run src/engine/world/shadows.test.ts && npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/world/shadows.ts src/engine/world/shadows.test.ts
git commit -m "perf(shadows): skip the sun raycast above the 3x3 opaque heightmap

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WkqJrcc2U5KmXWvtU969AW"
```

---

### Task 4: Versioned generation (v1 verbatim, v2 tall placeholder), world profile, unbreakable bedrock

**Files:**
- Create: `src/engine/world/generation.v1.ts` (today's `generation.ts` body, moved verbatim)
- Create: `src/engine/world/generation.v2.ts`
- Modify: `src/engine/world/generation.ts` (Task 1 left it as the v1 body with an ignored `_genVersion` argument; it becomes the dispatcher + profile table)
- Modify: `src/engine/world/world.ts` (`ensureChunk` passes `this.genVersion`; add `static create`)
- Modify: `src/data/catalog-rules.ts:281` (+ new `HARDNESS_OVERRIDES`), regenerate `src/data/blocks.catalog.data.ts` via `npm run gen-catalog`
- Modify: `src/game/tnt.ts` (TNT must not destroy hardness-0 blocks)
- Test: `src/engine/world/generation.test.ts` (imports + new describe), `src/data/catalog-rules.test.ts`, `src/game/tnt.test.ts`

**Interfaces:**
- Consumes: `Chunk.height`, `World(seed, opts)` (Task 1).
- Produces:
  ```ts
  // generation.ts
  export const NEWEST_GEN_VERSION = 2;
  export function worldProfile(genVersion: number): { height: WorldHeight };   // 1 -> 64, 2 -> 256, else throws RangeError
  export function generateChunk(chunk: Chunk, seed: number, genVersion = 1): void; // dispatch; throws if chunk.height !== worldProfile(genVersion).height. World's default genVersion is derived from height (Task 1), so `new World(seed, { height: 256 })` dispatches to v2 and `new World(seed)` to v1 without anyone naming a version.
  export const SEA_LEVEL = 28;            // re-exported from v1 for compatibility
  // generation.v1.ts:  export function generateChunkV1(chunk, seed): void;  export const SEA_LEVEL_V1 = 28;
  // generation.v2.ts:  export function generateChunkV2(chunk, seed): void;  export const SEA_LEVEL_V2 = 120;  MIN_H 114, MAX_H 130, bedrock at y=0
  // world.ts:          static create(seed: number): World  -> new World(seed, { height: worldProfile(NEWEST_GEN_VERSION).height, genVersion: NEWEST_GEN_VERSION, saveVersion: 3 })
  // catalog-rules.ts:  export const HARDNESS_OVERRIDES: Record<string, number> = { bedrock: 0 };
  ```

- [ ] **Step 1: Write the failing tests**

In `generation.test.ts`, change the import to `import { generateChunk, worldProfile, NEWEST_GEN_VERSION } from './generation';` (the existing tests keep calling `generateChunk(c, seed)` — the default `genVersion = 1` is what guards the verbatim move AND the dispatch). Append:

```ts
describe('world profile', () => {
	it('maps generator versions to heights and rejects unknown ones', () => {
		expect(worldProfile(1)).toEqual({ height: 64 });
		expect(worldProfile(2)).toEqual({ height: 256 });
		expect(NEWEST_GEN_VERSION).toBe(2);
		expect(() => worldProfile(3)).toThrow(RangeError);
	});
	it('refuses to run a generator on a chunk of the wrong height', () => {
		expect(() => generateChunk(new Chunk(0, 0, 256), 1, 1)).toThrow();
		expect(() => generateChunk(new Chunk(0, 0, 64), 1, 2)).toThrow();
	});
});

const EXPECTED_HASH_V2 = 0; // recorded ONCE in Task 4 step 5 by running this test; never re-recorded

describe('generateChunk v2 (tall)', () => {
	const BEDROCK = BLOCK_BY_NAME['bedrock'].id;
	const WATER = BLOCK_BY_NAME['water'].id;

	it('puts bedrock at y=0 in every column and nothing but air above y=131', () => {
		const c = new Chunk(4, 7, 256);
		generateChunk(c, 42, 2);
		for (let lz = 0; lz < 16; lz++)
			for (let lx = 0; lx < 16; lx++) {
				expect(c.get(lx, 0, lz)).toBe(BEDROCK);
				for (let y = 132; y < 256; y++) expect(c.get(lx, y, lz)).toBe(0);
			}
		expect(c.modified).toBe(false);
	});

	it('keeps the surface (top non-water block) within 114..130', () => {
		for (const [cx, cz] of [[0, 0], [5, 5], [31, 31]] as const) {
			const c = new Chunk(cx, cz, 256);
			generateChunk(c, 42, 2);
			for (let lz = 0; lz < 16; lz++)
				for (let lx = 0; lx < 16; lx++) {
					let top = -1;
					for (let y = 255; y >= 0; y--) {
						const id = c.get(lx, y, lz);
						if (id !== 0 && id !== WATER) { top = y; break; }
					}
					expect(top).toBeGreaterThanOrEqual(114);
					expect(top).toBeLessThanOrEqual(130);
				}
		}
	});

	it('fills water from the surface up to sea level 120 where the land is low', () => {
		let found = false;
		for (let cx = 0; cx < 8 && !found; cx++) {
			const c = new Chunk(cx, 1, 256);
			generateChunk(c, 42, 2);
			for (let lx = 0; lx < 16 && !found; lx++)
				for (let lz = 0; lz < 16 && !found; lz++) {
					let h = -1;
					for (let y = 255; y >= 0; y--) { const id = c.get(lx, y, lz); if (id !== 0 && id !== WATER) { h = y; break; } }
					if (h < 120) {
						found = true;
						for (let y = h + 1; y <= 120; y++) expect(c.get(lx, y, lz)).toBe(WATER);
						expect(c.get(lx, 121, lz)).toBe(0);
					}
				}
		}
		expect(found).toBe(true);
	});

	it('hashes a fixed seed+coord to a stable value', () => {
		const c = new Chunk(3, 5, 256);
		generateChunk(c, 12345, 2);
		expect(hashBytes(c.blocks)).toBe(EXPECTED_HASH_V2);
	});
});
```

In `catalog-rules.test.ts` add inside the `'isExcluded / groupOf / hardnessFor / labelFor'` describe:

```ts
	it('bedrock is unbreakable through HARDNESS_OVERRIDES', () => {
		expect(HARDNESS_OVERRIDES).toEqual({ bedrock: 0 });
	});
```
and a `makeRows` case next to the existing one at :224: build candidates including `{ name: 'bedrock', textures: { kind: 'uniform', all: 'bedrock' } }` with an id map entry and assert `rows.find((r) => r.name === 'bedrock')).toMatchObject({ hardness: 0, group: 'stone' })`. (Import `HARDNESS_OVERRIDES` from `./catalog-rules`.)

In `tnt.test.ts` append:

```ts
	it('does not destroy unbreakable (hardness 0) blocks', () => {
		const w = new World(1);
		const bedrock = BLOCK_BY_NAME['bedrock'].id;
		w.setBlock(100, 60, 100, tntId);
		w.setBlock(101, 60, 100, bedrock);
		const r = detonate(w, 100, 60, 100, neverPrimed);
		expect(r.destroyed).not.toContainEqual({ x: 101, y: 60, z: 100 });
	});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/engine/world/generation.test.ts src/data/catalog-rules.test.ts src/game/tnt.test.ts`
Expected: FAIL — `worldProfile`/`HARDNESS_OVERRIDES` missing; bedrock currently destroyed; hash test fails (hash 0).

- [ ] **Step 3: Move v1 verbatim, add v2, dispatcher, profile**

`generation.v1.ts`: the current `generation.ts` content with `export function generateChunk` renamed `generateChunkV1`, `export const SEA_LEVEL` renamed `SEA_LEVEL_V1`, and this guard as the first line of the function: `if (chunk.height !== 64) throw new RangeError('generator v1 needs a 64-high chunk');`. Nothing else changes.

`generation.v2.ts`:

```ts
import { createNoise2D } from 'simplex-noise';
import alea from 'alea';
import type { Chunk } from './chunk';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z } from './coords';
import { BLOCK_BY_NAME } from '../../data/blocks.data';

const GRASS = BLOCK_BY_NAME['grass_block'].id;
const DIRT = BLOCK_BY_NAME['dirt'].id;
const STONE = BLOCK_BY_NAME['stone'].id;
const SAND = BLOCK_BY_NAME['sand'].id;
const WATER = BLOCK_BY_NAME['water'].id;
const BEDROCK = BLOCK_BY_NAME['bedrock'].id;
const MIN_H = 114;
const MAX_H = 130;
const NOISE_SCALE = 1 / 64;
export const SEA_LEVEL_V2 = 120;
const DIRT_BAND = 3;

/** Placeholder tall generator: v1's terrain lifted to a 256 column, plus a bedrock floor. The worldgen project replaces it with v3. */
export function generateChunkV2(chunk: Chunk, seed: number): void {
	if (chunk.height !== 256) throw new RangeError('generator v2 needs a 256-high chunk');
	const rng = alea(`minicraft:${seed}`);
	const noise = createNoise2D(rng);
	const baseX = chunk.cx * CHUNK_SIZE_X;
	const baseZ = chunk.cz * CHUNK_SIZE_Z;
	const col = (lx: number, y: number, lz: number) => y * CHUNK_SIZE_X * CHUNK_SIZE_Z + lz * CHUNK_SIZE_X + lx;

	for (let lz = 0; lz < CHUNK_SIZE_Z; lz++) {
		for (let lx = 0; lx < CHUNK_SIZE_X; lx++) {
			const n = noise((baseX + lx) * NOISE_SCALE, (baseZ + lz) * NOISE_SCALE);
			const h = Math.floor(MIN_H + (n * 0.5 + 0.5) * (MAX_H - MIN_H));
			chunk.blocks[col(lx, 0, lz)] = BEDROCK;
			for (let y = 1; y <= h; y++) {
				let id: number;
				if (y === h) id = h < SEA_LEVEL_V2 ? SAND : GRASS;
				else if (y >= h - DIRT_BAND) id = DIRT;
				else id = STONE;
				chunk.blocks[col(lx, y, lz)] = id;
			}
			if (h < SEA_LEVEL_V2) for (let y = h + 1; y <= SEA_LEVEL_V2; y++) chunk.blocks[col(lx, y, lz)] = WATER;
		}
	}
	chunk.dirty = true;
	chunk.modified = false;
}
```

`generation.ts` (whole file):

```ts
import type { Chunk } from './chunk';
import type { WorldHeight } from './coords';
import { generateChunkV1, SEA_LEVEL_V1 } from './generation.v1';
import { generateChunkV2 } from './generation.v2';

/** Kept for callers of the old name; v1 sea level. */
export const SEA_LEVEL = SEA_LEVEL_V1;

export const NEWEST_GEN_VERSION = 2;

/** Consulted ONLY at world creation. A stored record's own `height` is authoritative afterwards. */
export function worldProfile(genVersion: number): { height: WorldHeight } {
	if (genVersion === 1) return { height: 64 };
	if (genVersion === 2) return { height: 256 };
	throw new RangeError(`Unknown generator version ${genVersion}`);
}

export function generateChunk(chunk: Chunk, seed: number, genVersion = 1): void {
	const { height } = worldProfile(genVersion);
	if (chunk.height !== height) throw new RangeError(`generator v${genVersion} needs a ${height}-high chunk, got ${chunk.height}`);
	if (genVersion === 1) generateChunkV1(chunk, seed);
	else generateChunkV2(chunk, seed);
}
```

`world.ts` (the `generateChunk(c, this.seed, this.genVersion)` call already exists from Task 1): add

```ts
	/** A brand-new world: newest generator, its height, saved as v3. This is the ONE place height and genVersion are checked against each other (spec §4: a stored record's height is authoritative, so the constructor never validates). */
	static create(seed: number): World {
		const { height } = worldProfile(NEWEST_GEN_VERSION);
		return new World(seed, { height, genVersion: NEWEST_GEN_VERSION, saveVersion: 3 });
	}
```
(import `worldProfile, NEWEST_GEN_VERSION` from `./generation`). Add to `world.test.ts`: `it('World.create is tall, newest generator, v3', () => { const w = World.create(1); expect(w).toMatchObject({ height: 256, genVersion: 2, saveVersion: 3 }); });`.

`catalog-rules.ts`: after `hardnessFor`, add `export const HARDNESS_OVERRIDES: Record<string, number> = { bedrock: 0 };` and at :281 use `hardness: HARDNESS_OVERRIDES[name] ?? hardnessFor(group),`. Then run `npm run gen-catalog` (the jar is at `~/.minecraft/versions/1.21.6/1.21.6.jar`) and check `git diff --stat src/data/` shows ONLY the bedrock row's `hardness: 1.2` → `hardness: 0` in `blocks.catalog.data.ts` and no change to `blocks.catalog.ids.json`. If gen-catalog cannot run, hand-edit that one row and say so in the commit body.

`tnt.ts`: in the radius loop, `} else if (isSolid(id)) {` → `} else if (isSolid(id) && (BLOCKS[id]?.hardness ?? 0) > 0) {` (import `BLOCKS` from `../data/blocks.data`). Mining already refuses hardness ≤ 0 (`loop.ts:239`, `actions.ts:49`).

- [ ] **Step 4: Run the generation tests; record the v2 hash once**

Run: `npx vitest run src/engine/world/generation.test.ts`
Expected: everything green except the v2 hash test, which prints `expected <number> to be 0`. Paste that number into `EXPECTED_HASH_V2`. Re-run: PASS. The v1 `EXPECTED_HASH = 4166549171` must still pass untouched.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` → green.

```bash
git add src/engine/world/generation.ts src/engine/world/generation.v1.ts src/engine/world/generation.v2.ts src/engine/world/world.ts src/engine/world/world.test.ts src/engine/world/generation.test.ts src/data/catalog-rules.ts src/data/catalog-rules.test.ts src/data/blocks.catalog.data.ts src/game/tnt.ts src/game/tnt.test.ts
git commit -m "feat(worldgen): versioned generators (v1 verbatim, v2 tall placeholder), unbreakable bedrock

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WkqJrcc2U5KmXWvtU969AW"
```

---

### Task 5: Player limits from height; engine tests at 256 (raycast, liquids, TNT, player, mesher)

**Files:**
- Modify: `src/game/player.ts:18-25, 34-41, 66, 71, 88, 93, 224` (the `sanitizeSpawn(this.position)` call in `update` is at :224)
- Modify: `src/main.ts:100` is NOT touched here (Task 11 owns main.ts); nothing else constructs `Player` with a height.
- Test: `src/game/player.test.ts` (replace the `SKY_CEILING_Y` uses; append), `src/engine/input/raycast.test.ts`, `src/game/liquid-scheduler.test.ts`, `src/game/tnt.test.ts`, `src/engine/world/mesher.test.ts` (append each)

**Interfaces:**
- Consumes: `World.height`, `World.inBounds` (Task 1).
- Produces:
  ```ts
  export const VOID_FLOOR_Y = -24;
  export function skyCeilingY(height: number): number;                 // height + 56  (64 -> 120, unchanged today)
  export function sanitizeSpawn(pos, height = 64): [number, number, number];
  export function findSafeSpawn(world, desired): [number, number, number]; // ground search from world.height - 1; fallback y = world.height / 2
  class Player { constructor(spawn, height: number = 64); readonly height; ... }  // update() clamps with the World it is given
  ```

- [ ] **Step 1: Write the failing tests**

`player.test.ts`: change the import to `VOID_FLOOR_Y, skyCeilingY, sanitizeSpawn, findSafeSpawn` and in the existing ceiling test replace `SKY_CEILING_Y` with `skyCeilingY(64)`. Append:

```ts
describe('Player at height 256', () => {
	it('ceiling scales with world height', () => {
		expect(skyCeilingY(64)).toBe(120);
		expect(skyCeilingY(256)).toBe(312);
	});
	it('sanitizeSpawn clamps y to the ceiling for the given height', () => {
		expect(sanitizeSpawn([10, 1000, 10], 256)[1]).toBe(312);
		expect(sanitizeSpawn([10, 1000, 10])[1]).toBe(120);
	});
	it('a flying player in a tall world is stopped at 312, not 120', () => {
		const w = new World(1, { height: 256 });
		const c = w.ensureChunk(16, 16); c.blocks.fill(AIR); c.lights.fill(0); c.liquidFrontier.clear();
		const p = new Player([260, 200, 260], 256);
		p.toggleFly();
		const keys = noKeys();
		keys.jump = true;
		for (let i = 0; i < 400; i++) p.update(0.05, w, keys, FWD, RIGHT);
		expect(p.position[1]).toBeGreaterThan(200);
		expect(p.position[1]).toBeLessThanOrEqual(skyCeilingY(256));
	});
	it('findSafeSpawn searches the whole 256 column and lands on a platform at y=200', () => {
		const w = new World(1, { height: 256 });
		const c = w.ensureChunk(16, 16); c.blocks.fill(AIR); c.lights.fill(0); c.liquidFrontier.clear();
		w.setBlock(260, 200, 260, stone);
		expect(findSafeSpawn(w, [260.5, 250, 260.5])).toEqual([260.5, 201, 260.5]);
		// From below the platform with nothing under: search from the top of the column finds it too.
		expect(findSafeSpawn(w, [260.5, 5, 260.5])[1]).toBe(201);
	});
	it('spawn on a fresh v2 world lands on the generated surface, not y=60', () => {
		const w = World.create(99);
		const [, y] = findSafeSpawn(w, [256.5, w.height - 1, 256.5]);
		expect(y).toBeGreaterThanOrEqual(115);
		expect(y).toBeLessThanOrEqual(131);
	});
});
```

`raycast.test.ts` append:

```ts
	it('hits the v2 surface (y >= 64) looking straight down from y=140', () => {
		const w = World.create(5);
		const hit = raycastVoxel(w, [200.5, 140, 200.5], [0, -1, 0], 40);
		expect(hit).not.toBeNull();
		expect(hit!.y).toBeGreaterThanOrEqual(64);
		expect(hit!.y).toBeLessThanOrEqual(130);
	});
```

`liquid-scheduler.test.ts` append (uses the file's `isSourceAt`/`floor` helpers and constructor pattern `new LiquidScheduler(w, () => {}, () => {})` — copy whichever the file already uses):

```ts
describe('liquids at height 256', () => {
	it('a source at y=240 falls to a floor at y=121', () => {
		const w = new World(1, { height: 256 });
		const c = w.ensureChunk(16, 16); c.blocks.fill(AIR); c.lights.fill(0); c.liquidFrontier.clear();
		floor(w, 258, 262, 258, 262, 121);
		w.setBlock(260, 240, 260, water);
		const s = new LiquidScheduler(w, () => {}, () => {});
		// The scheduler advances one block per 0.5 s flow step; tick until the water
		// lands or we give up. 2000 ticks is ~10x the 118-block fall.
		let ticks = 0;
		while (w.getBlock(260, 122, 260) !== water && ticks < 2000) { s.tick(0.5); ticks++; }
		expect(ticks).toBeLessThan(2000);
		expect(w.getBlock(260, 122, 260)).toBe(water);
		expect(w.getBlock(260, 121, 260)).toBe(stone);
	});
});
```

`tnt.test.ts` append:

```ts
	it('detonates near the top and the bottom of a 256 world without throwing', () => {
		const w = new World(1, { height: 256 });
		for (const y of [250, 1]) {
			w.setBlock(100, y, 100, tntId);
			w.setBlock(100, y + 1, 100, stoneId);
			const r = detonate(w, 100, y, 100, neverPrimed);
			expect(r.destroyed).toContainEqual({ x: 100, y: y + 1, z: 100 });
			for (const d of r.destroyed) expect(w.inBounds(d.x, d.y, d.z)).toBe(true);
		}
	});
```

`mesher.test.ts` append:

```ts
	it('meshes a lone block at y=250 in a 256 chunk (6 faces)', () => {
		const c = new Chunk(0, 0, 256);
		c.set(5, 250, 5, stone);
		const result = meshChunk(c, {}, uvStub);
		expect(result.opaque.indices.length).toBe(36);
	});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/game/player.test.ts src/engine/input/raycast.test.ts src/game/liquid-scheduler.test.ts src/game/tnt.test.ts src/engine/world/mesher.test.ts`
Expected: player tests FAIL (`skyCeilingY` missing; spawn 63 cap); raycast/mesher/tnt/liquid pass already (Task 1) — that is fine, they pin the behaviour.

- [ ] **Step 3: Implement player.ts**

```ts
/**
 * Vertical bounds scale with the world: the void floor is fixed (Noah likes to
 * drop into it), the ceiling sits 56 blocks above the top of the column so a
 * 64-high world keeps today's 120. Before these existed one world was saved at
 * y = -193917 and loaded as an empty blue screen.
 */
export const VOID_FLOOR_Y = -24;
export function skyCeilingY(height: number): number {
	return height + 56;
}

export function sanitizeSpawn(pos: [number, number, number], height = 64): [number, number, number] {
	return [
		clamp(pos[0], WORLD_MIN_XZ, WORLD_MAX_XZ),
		clamp(pos[1], VOID_FLOOR_Y, skyCeilingY(height)),
		clamp(pos[2], WORLD_MIN_XZ, WORLD_MAX_XZ),
	];
}
```

`findSafeSpawn`: `const top = world.height - 1;` then `sanitizeSpawn(desired, world.height)`; `:66` `Math.min(..., top)`; `:71` `for (let y = top; y > start; y--)`; `:88` `groundAt(nx + 0.5, nz + 0.5, top)`; `:93` `return [dx, Math.max(dy, world.height / 2), dz];`.

`Player`: add `readonly height: number;` set in `constructor(spawn, height = 64)` with `this.position = sanitizeSpawn(spawn, height)`; at `:224` (inside `update`) use `sanitizeSpawn(this.position, world.height)`.

- [ ] **Step 4: Run, then full suite, then commit**

Run: `npm test` → green.

```bash
git add src/game/player.ts src/game/player.test.ts src/engine/input/raycast.test.ts src/game/liquid-scheduler.test.ts src/game/tnt.test.ts src/engine/world/mesher.test.ts
git commit -m "feat(player): vertical limits from world height; engine tests at 256

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WkqJrcc2U5KmXWvtU969AW"
```

---

### Task 6: Codec takes an expected length (client + API) and parity at both lengths

**Files:**
- Modify: `src/persistence/codec.ts`, `api/src/codec.ts`, `api/src/testFixtures.ts`, `api/src/handlers.ts:2,68,75` (call sites only), `src/persistence/localStorage.ts:96` (encodeChunk) and `:236-237` (the two decodeChunk calls), `src/persistence/cloud.ts:74,84`
- Test: `src/persistence/codec.test.ts`, `api/src/codec.parity.test.ts`

**Interfaces:**
- Produces (identical in both copies):
  ```ts
  export function encodeChunk(blocks: Uint16Array, expectedLength: number): string;   // throws Error('Unexpected chunk length') on mismatch or bad expectedLength
  export function decodeChunk(encoded: string, expectedLength: number): Uint16Array; // throws on mismatch / overrun / bad expectedLength
  export const LEGACY_BLOCKS_PER_CHUNK = 16 * 64 * 16;   // api/src/codec.ts only (the v2 route's fixed length)
  ```
- Consumes: nothing new. Task 7/8/10 pass real heights; this task threads `16 * 64 * 16` at every call site so behaviour is unchanged.

- [ ] **Step 1: Write the failing tests** — append to `src/persistence/codec.test.ts`:

```ts
describe('codec with an explicit length', () => {
	it('round-trips a 65536-entry chunk', () => {
		const b = new Uint16Array(65536);
		b[0] = 3; b[65535] = 353;
		expect(decodeChunk(encodeChunk(b, 65536), 65536)).toEqual(b);
	});
	it('refuses to encode an array whose length is not the expected one', () => {
		expect(() => encodeChunk(new Uint16Array(16384), 65536)).toThrow('Unexpected chunk length');
		expect(() => encodeChunk(new Uint16Array(65536), 16384)).toThrow('Unexpected chunk length');
	});
	it('refuses to decode a payload into the wrong length', () => {
		const tall = encodeChunk(new Uint16Array(65536), 65536);
		expect(() => decodeChunk(tall, 16384)).toThrow();
		const short = encodeChunk(new Uint16Array(16384), 16384);
		expect(() => decodeChunk(short, 65536)).toThrow();
	});
	it('refuses a non-integer expected length instead of allocating length 0', () => {
		const short = encodeChunk(new Uint16Array(16384), 16384);
		expect(() => decodeChunk(short, undefined as unknown as number)).toThrow();
		expect(() => decodeChunk(short, Number.NaN)).toThrow();
		expect(() => encodeChunk(new Uint16Array(16384), Number.NaN)).toThrow();
	});
});
```

Rewrite `api/src/codec.parity.test.ts` so every case runs for `[16384, 65536]` (`for (const N of [16384, 65536] as const) describe(`codec parity at ${N}`, ...)`), calling `clientEncode(blocks, N)` / `decodeChunk(str, N)`; keep the legacy byte-codec case at 16384 with `decodeChunk('eJxjTWFIEWZk2F4HAAf9Ahc=', 16384)`; replace the `'agrees that BLOCKS_PER_CHUNK is 16384'` case with `it('legacy length is 16384', () => expect(LEGACY_BLOCKS_PER_CHUNK).toBe(16384))`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/persistence/codec.test.ts api/src/codec.parity.test.ts`
Expected: FAIL (encode ignores the second argument today; 65536 throws).

- [ ] **Step 3: Implement** (both `src/persistence/codec.ts` and `api/src/codec.ts` — keep them textually identical apart from the `LEGACY_BLOCKS_PER_CHUNK` export in the API copy):

```ts
function checkLength(n: number): void {
	if (!Number.isInteger(n) || n <= 0) throw new Error(`Unexpected chunk length: ${String(n)}`);
}

export function encodeChunk(blocks: Uint16Array, expectedLength: number): string {
	checkLength(expectedLength);
	if (blocks.length !== expectedLength) throw new Error('Unexpected chunk length');
	// ... unchanged RLE body
}

export function decodeChunk(encoded: string, expectedLength: number): Uint16Array {
	checkLength(expectedLength);
	// ... same body with every BLOCKS_PER_CHUNK replaced by expectedLength
}
```

Call sites, all with the legacy length for now: `localStorage.ts` `encodeChunk(c.blocks, 16 * 64 * 16)` (:96) and `decodeChunk(..., 16 * 64 * 16)` (:236 and :237); `cloud.ts` likewise (:74, :84); `api/src/handlers.ts` `decodeChunk(c.blocks, LEGACY_BLOCKS_PER_CHUNK)` and the two `BLOCKS_PER_CHUNK` comparisons → `LEGACY_BLOCKS_PER_CHUNK`; `api/src/testFixtures.ts` `chunkBlocks(fill, len = LEGACY_BLOCKS_PER_CHUNK)` → `encodeChunk(b, len)`. Existing `codec.test.ts` cases: add `, 16384` to every encode/decode call. Delete the temporary `const BLOCKS_PER_CHUNK` from `src/persistence/codec.ts`.

- [ ] **Step 4: Full suite + commit**

Run: `npm test` → green.

```bash
git add src/persistence/codec.ts src/persistence/codec.test.ts src/persistence/localStorage.ts src/persistence/cloud.ts api/src/codec.ts api/src/codec.parity.test.ts api/src/testFixtures.ts api/src/handlers.ts
git commit -m "refactor(codec): explicit expected length on encode and decode, both copies

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WkqJrcc2U5KmXWvtU969AW"
```

---

### Task 7: Save records carry height/genVersion; autosave reads the World; localStorage v3 namespace, probe order, shrink guard

**Files:**
- Create: `src/persistence/errors.ts`
- Modify: `src/persistence/adapter.ts` (`WorldSave`, `WorldSummary`)
- Modify: `src/persistence/autosave.ts:113-130`
- Modify: `src/persistence/localStorage.ts` (whole adapter)
- Test: `src/persistence/autosave.test.ts`, `src/persistence/localStorage.test.ts`, `src/persistence/cloud.test.ts` + `dual.test.ts` (fixture helpers only: add `height: 64, genVersion: 1` so they compile)

**Interfaces:**
- Consumes: `blocksPerChunk`, `isWorldHeight`, `WorldHeight` (Task 1); `encodeChunk(blocks, len)`, `decodeChunk(str, len)` (Task 6); `World.height / genVersion / saveVersion` (Task 1).
- Produces:
  ```ts
  // errors.ts
  export class SaveCorrupt extends Error { constructor(msg: string) { super(msg); this.name = 'SaveCorrupt'; } }
  export class SaveMismatch extends Error { constructor(msg: string) { super(msg); this.name = 'SaveMismatch'; } }
  // adapter.ts
  export type WorldSave = { version: 2 | 3; height: WorldHeight; genVersion: number; id; seed; name; createdAt; updatedAt; player; chunks; lights?; lastSyncedGeneration? };
  export type WorldSummary = { ...existing; version: 2 | 3; height?: WorldHeight };
  // localStorage.ts
  loadWorld(id): probes v3 keys, then v2, then legacy; a v3 meta without a valid height/genVersion throws SaveCorrupt; any chunk that fails to decode throws SaveCorrupt
  saveLocalSync(save): version 2 -> v2 keys and today's meta payload (no new fields); version 3 -> v3 keys, meta gains height+genVersion. Both: shrink guard.
  Error('SUSPICIOUS_SHRINK') thrown by saveLocalSync when stored chunk keys > 4 and incoming < stored/2 (incoming chunks are still written; nothing is pruned; meta untouched)
  saveWorld(): maps SUSPICIOUS_SHRINK to { local: 'error', cloud: 'skipped' }
  listWorlds(): v3 rows { version: 3, height }, v2 rows { version: 2, height: 64 }, legacy rows { version: 2, height: 64 }. A v3 meta whose height is NOT 64|256 is still LISTED (height: undefined) — listing never throws — and refuses to open later via loadV3's SaveCorrupt. The menu keeps showing it rather than making it "disappear".
  deleteWorld(id): removes v3 AND v2 keys for the id (legacy untouched as today)
  setSyncedGeneration(id, gen): writes whichever of v3/v2 meta exists
  ```

- [ ] **Step 1: Write the failing tests**

`autosave.test.ts`: change `fakeWorld()` to `{ seed: 1, height: 64, genVersion: 1, saveVersion: 2, modifiedChunks: () => [] }` and append:

```ts
describe('AutoSave snapshot carries the world profile', () => {
	beforeEach(() => stubDom());
	afterEach(() => vi.unstubAllGlobals());
	it('writes version 3 / height 256 / genVersion 2 for a tall world', async () => {
		let seen: WorldSave | null = null;
		const adapter = makeAdapter(async (s) => { seen = s; });
		const world = { seed: 9, height: 256, genVersion: 2, saveVersion: 3, modifiedChunks: () => [] } as unknown as World;
		const a = new AutoSave(adapter, world, () => PLAYER, { id: WORLD_ID, name: 'w', createdAt: 0 });
		a.markDirty();
		await a.flush();
		expect(seen).toMatchObject({ version: 3, height: 256, genVersion: 2 });
	});
	it('keeps version 2 with height 64 for an old world', async () => {
		let seen: WorldSave | null = null;
		const a = makeAutoSave(makeAdapter(async (s) => { seen = s; }));
		a.markDirty();
		await a.flush();
		expect(seen).toMatchObject({ version: 2, height: 64, genVersion: 1 });
	});
});
```

`localStorage.test.ts`: update `sampleSave` to include `height: 64, genVersion: 1`; add a `tallSave(seed)` helper (same shape, `version: 3, height: 256, genVersion: 2`, blocks `new Uint16Array(65536)` with `blocks[65000] = 3`). Append:

```ts
describe('LocalStorageAdapter — v3 namespace', () => {
	let storage: MemStorage;
	let adapter: LocalStorageAdapter;
	beforeEach(() => { storage = new MemStorage(); adapter = new LocalStorageAdapter(storage as unknown as Storage); });

	function keys(): string[] { const out: string[] = []; for (let i = 0; i < storage.length; i++) out.push(storage.key(i)!); return out; }

	it('round-trips a tall world under minicraft:v3 keys only', async () => {
		await adapter.saveWorld(tallSave(3));
		expect(keys().every((k) => k.startsWith('minicraft:v3:'))).toBe(true);
		const loaded = await adapter.loadWorld(idFor(3));
		expect(loaded).toMatchObject({ version: 3, height: 256, genVersion: 2 });
		expect(loaded!.chunks[0].blocks.length).toBe(65536);
		expect(loaded!.chunks[0].blocks[65000]).toBe(3);
	});

	it('a v2 fixture loads as version 2 / height 64 / genVersion 1 and re-saves only v2 keys', async () => {
		storage.setItem(`minicraft:v2:world:${idFor(4)}:meta`, JSON.stringify({ version: 2, id: idFor(4), seed: 4, name: 'Old', createdAt: 1, updatedAt: 2, player: { x: 0, y: 60, z: 0, yaw: 0, pitch: 0, hotbar: [1], selected: 0 }, lastSyncedGeneration: null }));
		storage.setItem(`minicraft:v2:world:${idFor(4)}:chunk:0:0`, JSON.stringify({ blocks: encodeChunk(new Uint16Array(16384), 16384) }));
		const loaded = await adapter.loadWorld(idFor(4));
		expect(loaded).toMatchObject({ version: 2, height: 64, genVersion: 1 });
		await adapter.saveWorld(loaded!);
		expect(keys().some((k) => k.startsWith('minicraft:v3:'))).toBe(false);
		const meta = JSON.parse(storage.getItem(`minicraft:v2:world:${idFor(4)}:meta`)!);
		expect('height' in meta).toBe(false);
	});

	it('listWorlds returns both namespaces with their versions and heights', async () => {
		await adapter.saveWorld(sampleSave(1));
		await adapter.saveWorld(tallSave(2));
		const list = await adapter.listWorlds();
		expect(list.find((w) => w.seed === 1)).toMatchObject({ version: 2, height: 64 });
		expect(list.find((w) => w.seed === 2)).toMatchObject({ version: 3, height: 256 });
	});

	it('deleteWorld removes exactly the namespace holding the id', async () => {
		await adapter.saveWorld(sampleSave(1));
		await adapter.saveWorld(tallSave(2));
		await adapter.deleteWorld(idFor(2));
		expect(await adapter.loadWorld(idFor(2))).toBeNull();
		expect(await adapter.loadWorld(idFor(1))).not.toBeNull();
		await adapter.deleteWorld(idFor(1));
		expect(keys()).toEqual([]);
	});

	it('refuses to open a v3 meta without a valid height', async () => {
		storage.setItem(`minicraft:v3:world:${idFor(5)}:meta`, JSON.stringify({ version: 3, id: idFor(5), seed: 5, name: 'x', createdAt: 1, updatedAt: 2, player: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hotbar: [], selected: 0 } }));
		await expect(adapter.loadWorld(idFor(5))).rejects.toThrow(SaveCorrupt);
	});

	it('refuses to open a tall world holding one chunk of the wrong length (no partial load)', async () => {
		// A garbage payload already throws today (atob's InvalidCharacterError), so it
		// would go green on a bare rethrow. A LENGTH mismatch is the case that only a
		// "decode at the record's height" implementation catches: a 16384-length encode
		// stored in a 256-high world must be refused, not decoded at its own length.
		await adapter.saveWorld({ ...tallSave(6), chunks: [{ cx: 0, cz: 0, blocks: new Uint16Array(65536) }, { cx: 1, cz: 0, blocks: new Uint16Array(65536) }] });
		storage.setItem(`minicraft:v3:world:${idFor(6)}:chunk:1:0`, JSON.stringify({ blocks: encodeChunk(new Uint16Array(16384), 16384) }));
		await expect(adapter.loadWorld(idFor(6))).rejects.toThrow(SaveCorrupt);
	});

	it('lists a v3 meta with an invalid height (height undefined) but refuses to open it', async () => {
		storage.setItem(`minicraft:v3:world:${idFor(7)}:meta`, JSON.stringify({ version: 3, id: idFor(7), seed: 7, name: 'Odd', height: 128, genVersion: 2, createdAt: 1, updatedAt: 2, player: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hotbar: [], selected: 0 } }));
		const list = await adapter.listWorlds();
		expect(list.find((w) => w.seed === 7)).toMatchObject({ version: 3, name: 'Odd' });
		expect(list.find((w) => w.seed === 7)!.height).toBeUndefined();
		await expect(adapter.loadWorld(idFor(7))).rejects.toThrow(SaveCorrupt);
	});

	it('shrink guard: 9 stored chunks, a 2-chunk snapshot keeps all 9 and reports local error', async () => {
		const nine = Array.from({ length: 9 }, (_, i) => ({ cx: i, cz: 0, blocks: new Uint16Array(16384) }));
		await adapter.saveWorld({ ...sampleSave(8), chunks: nine });
		const before = keys().filter((k) => k.includes(':chunk:')).length;
		expect(before).toBe(9);
		const result = await adapter.saveWorld({ ...sampleSave(8), updatedAt: 9999, chunks: nine.slice(0, 2) });
		expect(result.local).toBe('error');
		expect(keys().filter((k) => k.includes(':chunk:')).length).toBe(9);
		const meta = JSON.parse(storage.getItem(`minicraft:v2:world:${idFor(8)}:meta`)!);
		expect(meta.updatedAt).toBe(2000); // meta untouched by the refused save
	});
});
```

(`import { SaveCorrupt } from './errors';` at the top.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/persistence/autosave.test.ts src/persistence/localStorage.test.ts`
Expected: FAIL / compile errors on the new fields and `./errors`.

- [ ] **Step 3: Implement types, errors, autosave**

`errors.ts` as in Interfaces. `adapter.ts`:

```ts
import type { WorldHeight } from '../engine/world/coords';
export type WorldSummary = { id; seed; name; createdAt; updatedAt; origin; sizeBytes?; degraded?; /** save format the record lives in */ version: 2 | 3; /** absent on a degraded cloud row */ height?: WorldHeight };
export type WorldSave = {
	/** Fixed for the life of a world. 2 = legacy 64-high namespace, 3 = tall. */
	version: 2 | 3;
	/** Authoritative for every array size. A v2 record is normalised to 64 on load. */
	height: WorldHeight;
	genVersion: number;
	// ... rest unchanged
};
```

`autosave.ts` `snapshot()`:

```ts
		return {
			version: this.world.saveVersion,
			height: this.world.height,
			genVersion: this.world.genVersion,
			id: this.id,
			// ... unchanged
```

- [ ] **Step 4: Implement localStorage.ts**

Add `const V3 = 'minicraft:v3';`, `v3MetaKey/v3ChunkKey/v3ChunkPrefix` mirroring v2. Then:

```ts
	async loadWorld(id: string): Promise<WorldSave | null> {
		if (isLegacyId(id)) { /* unchanged */ }
		return this.loadV3(id) ?? this.loadV2(id);
	}

	private loadV3(id: string): WorldSave | null {
		const metaRaw = this.storage.getItem(v3MetaKey(id));
		if (!metaRaw) return null;
		const meta = JSON.parse(metaRaw) as Partial<WorldSave>;
		if (!isWorldHeight(meta.height) || !Number.isInteger(meta.genVersion) || (meta.genVersion as number) < 1) {
			throw new SaveCorrupt(`v3 world ${id} has no valid height/genVersion`);
		}
		const chunks = this.readChunks(v3ChunkPrefix(id), blocksPerChunk(meta.height));
		return { ...(meta as WorldSave), version: 3, id, height: meta.height, genVersion: meta.genVersion as number, chunks };
	}
```

`loadV2`/`loadV1` return `{ ..., version: 2, height: 64, genVersion: 1, chunks }` using `readChunks(prefix, 16384)`. `readChunks(prefix, len)` is the existing scan loop with `parseChunkPayload(cx, cz, data, len)` wrapped: `try { ... } catch (err) { throw new SaveCorrupt(`chunk ${k}: ${(err as Error).message}`); }`. `parseChunkPayload(cx, cz, data, len)` passes `len` to both `decodeChunk` calls.

`encode(save)`: `encodeChunk(c.blocks, blocksPerChunk(save.height))`. Add the helper the write loop and the shrink guard both use (today the `{ blocks, fluidMeta? }` object is built inline at localStorage.ts:144-146 — move it here so both paths write the same shape):

```ts
function payloadOf(c: EncodedChunk): { blocks: string; fluidMeta?: string } {
	return c.fluidMeta === undefined ? { blocks: c.blocks } : { blocks: c.blocks, fluidMeta: c.fluidMeta };
}
```

`saveLocalSync(save, pre)`: keep the legacy guard; pick `const ns = save.version === 3 ? { meta: v3MetaKey, chunk: v3ChunkKey, prefix: v3ChunkPrefix } : { meta: v2MetaKey, chunk: v2ChunkKey, prefix: v2ChunkPrefix };` and the meta payload:

```ts
		const metaPayload: Record<string, unknown> = { version: save.version, id: save.id, seed: save.seed, name: save.name, createdAt: save.createdAt, updatedAt: save.updatedAt, player: save.player, lights: save.lights, lastSyncedGeneration: save.lastSyncedGeneration ?? null };
		if (save.version === 3) { metaPayload.height = save.height; metaPayload.genVersion = save.genVersion; }
```

(the v2 payload is therefore byte-identical to today's). Inside the try, before pruning:

```ts
			const prefix = ns.prefix(save.id);
			const existing: string[] = [];
			for (let i = 0; i < this.storage.length; i++) { const k = this.storage.key(i); if (k && k.startsWith(prefix)) existing.push(k); }
			// Mirror of the API's shrink guard. Chunk.modified is sticky, so a real
			// save never shrinks; a snapshot that does is a bug upstream and must not prune.
			if (existing.length > 4 && encoded.length < existing.length * 0.5) {
				for (const c of encoded) this.storage.setItem(ns.chunk(save.id, c.cx, c.cz), JSON.stringify(payloadOf(c)));
				throw new Error('SUSPICIOUS_SHRINK');
			}
```

then the existing prune + write + meta-last using `ns.*`, with the write loop also using `JSON.stringify(payloadOf(c))`. A refused save keeps reporting `local: 'error'` for the rest of the session (the incoming count never grows back until reload) and self-heals on the next launch, because the surviving chunks are all loaded and marked modified again; Task 12 documents that so a "Saved on this device: error" is not misread as data loss. `saveWorld`: `try { this.saveLocalSync(save, pre); return { local: 'ok', cloud: 'skipped' }; } catch (err) { if ((err as Error).message === 'SUSPICIOUS_SHRINK') return { local: 'error', cloud: 'skipped' }; throw err; }`.

`setSyncedGeneration`: try `v3MetaKey` first, else `v2MetaKey`. `listWorlds`: add a first loop over `${V3}:world:` metas pushing `{ ..., origin: 'local', version: 3, height: isWorldHeight(m.height) ? m.height : undefined }` (never throw while listing); the v2 loop pushes `version: 2, height: 64`; the legacy loop likewise. `deleteWorld`: remove `v3MetaKey(id)`, `v2MetaKey(id)` and both chunk prefixes.

Update `cloud.test.ts` and `dual.test.ts` `save()` helpers with `height: 64, genVersion: 1` so they compile (their behaviour is Tasks 8/9).

- [ ] **Step 5: Full suite + build + commit**

Run: `npm test && npm run build` → green.

```bash
git add src/persistence/errors.ts src/persistence/adapter.ts src/persistence/autosave.ts src/persistence/localStorage.ts src/persistence/autosave.test.ts src/persistence/localStorage.test.ts src/persistence/cloud.test.ts src/persistence/dual.test.ts
git commit -m "feat(persistence): v3 local namespace, height/genVersion on records, shrink guard, fail-closed load

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WkqJrcc2U5KmXWvtU969AW"
```

---

### Task 8: Cloud adapter — /v3 routes, namespace probe, merged list

**Files:**
- Modify: `src/persistence/cloud.ts`
- Test: `src/persistence/cloud.test.ts` (append)

**Interfaces:**
- Consumes: `WorldSave.version/height/genVersion`, `SaveCorrupt` (Task 7); `encodeChunk/decodeChunk(…, len)` (Task 6).
- Produces:
  ```ts
  // route prefix: version 3 -> '/v3/worlds', version 2 -> '/worlds'
  loadWorld(id): GET /v3/worlds/:id; on 404 GET /worlds/:id; 404 on both -> null. The BODY's own `wire.version` is what decode() trusts; the namespace that answered is never written over it (a v2 body answered from any route decodes as v2/64/1). A body with version 3 must carry a valid height/genVersion, else SaveCorrupt. If the /v3 route answers with a body whose version is not 3, throw SaveCorrupt (namespace/body disagreement).
  saveWorld(save): PUT to the prefix of save.version; v3 body adds height + genVersion; the 409 re-read uses the same prefix.
  listWorlds(): GET /v3/worlds and GET /worlds, concatenated; v3 rows { version: 3, height: row.height }, v2 rows { version: 2, height: 64 }; either failing throws CloudError.
  deleteWorld(id): DELETE /v3/worlds/:id then DELETE /worlds/:id (204 and 404 both fine).
  ```

- [ ] **Step 1: Write the failing tests** — append to `cloud.test.ts` (reusing its `res()` / `stubFetch()` helpers and `save()`; add `tallSave()` = `save({ version: 3, height: 256, genVersion: 2, chunks: [{ cx: 0, cz: 0, blocks: new Uint16Array(65536) }] })`):

```ts
describe('CloudAdapter v3 routing', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('loads a v3 world from /v3/worlds/:id', async () => {
		const a = new CloudAdapter('https://api');
		const wire = { ...tallSave(), chunks: a.encode(tallSave()) };
		const calls = stubFetch(res(200, wire, 'g1'));
		const loaded = await a.loadWorld(ID);
		expect(calls[0].url).toBe(`https://api/v3/worlds/${ID}`);
		expect(loaded).toMatchObject({ version: 3, height: 256, genVersion: 2 });
		expect(loaded!.chunks[0].blocks.length).toBe(65536);
	});

	it('falls through to /worlds/:id for a v2 world and normalises height 64', async () => {
		const a = new CloudAdapter('https://api');
		const wire = { ...save(), chunks: a.encode(save()) };
		const calls = stubFetch(res(404), res(200, wire, 'g2'));
		const loaded = await a.loadWorld(ID);
		expect(calls.map((c) => c.url)).toEqual([`https://api/v3/worlds/${ID}`, `https://api/worlds/${ID}`]);
		expect(loaded).toMatchObject({ version: 2, height: 64, genVersion: 1 });
	});

	it('returns null only when both namespaces 404', async () => {
		const a = new CloudAdapter('https://api');
		stubFetch(res(404), res(404));
		expect(await a.loadWorld(ID)).toBeNull();
	});

	it('refuses a v3 body without a valid height', async () => {
		const a = new CloudAdapter('https://api');
		const wire = { ...tallSave(), chunks: a.encode(tallSave()) } as Record<string, unknown>;
		delete wire.height;
		stubFetch(res(200, wire, 'g1'));
		await expect(a.loadWorld(ID)).rejects.toThrow(SaveCorrupt);
	});

	it('PUTs a tall world to /v3 with height and genVersion in the body', async () => {
		const a = new CloudAdapter('https://api');
		const calls = stubFetch(res(200, { generation: '5' }));
		await a.saveWorld(tallSave());
		expect(calls[0].url).toBe(`https://api/v3/worlds/${ID}`);
		expect(JSON.parse(calls[0].init!.body as string)).toMatchObject({ version: 3, height: 256, genVersion: 2 });
	});

	it('PUTs a v2 world to /worlds without the new fields', async () => {
		const a = new CloudAdapter('https://api');
		const calls = stubFetch(res(200, { generation: '5' }));
		await a.saveWorld(save());
		expect(calls[0].url).toBe(`https://api/worlds/${ID}`);
		const body = JSON.parse(calls[0].init!.body as string);
		expect('height' in body).toBe(false);
	});

	it('lists both namespaces', async () => {
		// stubFetch hands responses out POSITIONALLY: the implementation must issue the
		// /v3/worlds request FIRST (then /worlds), or the rows below swap and the
		// assertions fail in a confusing way.
		const a = new CloudAdapter('https://api');
		const calls = stubFetch(
			res(200, [{ id: ID, seed: 1, name: 'Tall', createdAt: 1, updatedAt: 3, height: 256, genVersion: 2 }]),
			res(200, [{ id: '22222222-2222-4222-8222-222222222222', seed: 2, name: 'Old', createdAt: 1, updatedAt: 2 }]),
		);
		const list = await a.listWorlds();
		expect(calls.map((c) => c.url).sort()).toEqual(['https://api/v3/worlds', 'https://api/worlds']);
		expect(list.find((w) => w.name === 'Tall')).toMatchObject({ version: 3, height: 256, origin: 'cloud' });
		expect(list.find((w) => w.name === 'Old')).toMatchObject({ version: 2, height: 64, origin: 'cloud' });
	});
});
```
(`import { SaveCorrupt } from './errors';`)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/persistence/cloud.test.ts` → FAIL (URLs are `/worlds/...`, no fallthrough, no fields).

- [ ] **Step 3: Implement**

```ts
type Wire = { version: 2 | 3; height?: number; genVersion?: number; id; seed; name; createdAt; updatedAt; player; chunks: EncodedChunk[]; lights?; generation? };
const prefixFor = (version: 2 | 3) => (version === 3 ? '/v3/worlds' : '/worlds');

	encode(save: WorldSave): EncodedChunk[] { /* encodeChunk(c.blocks, blocksPerChunk(save.height)) */ }

	private static decode(wire: Wire): WorldSave {
		let height: WorldHeight = 64, genVersion = 1;
		if (wire.version === 3) {
			if (!isWorldHeight(wire.height) || !Number.isInteger(wire.genVersion) || (wire.genVersion as number) < 1)
				throw new SaveCorrupt(`cloud v3 world ${wire.id} has no valid height/genVersion`);
			height = wire.height; genVersion = wire.genVersion as number;
		}
		const len = blocksPerChunk(height);
		let chunks: RawChunk[];
		try { chunks = wire.chunks.map((c) => ({ cx: c.cx, cz: c.cz, blocks: decodeChunk(c.blocks, len), fluidMeta: c.fluidMeta ? decodeFluidMeta(c.fluidMeta) : undefined })); }
		catch (err) { throw new SaveCorrupt(`cloud world ${wire.id}: ${(err as Error).message}`); }
		return { version: wire.version === 3 ? 3 : 2, height, genVersion, id: wire.id, /* ... rest unchanged */ };
	}

	async loadWorld(id: string): Promise<WorldSave | null> {
		for (const version of [3, 2] as const) {
			const res = await this.request(`${prefixFor(version)}/${id}`);
			if (res.status === 404) continue;
			if (!res.ok) throw new CloudError(CloudAdapter.classify(res.status));
			const wire = (await res.json()) as Wire;
			// The body's version wins. Overriding it with the probed namespace would
			// reinterpret a v2 body as v3 and reject it (and breaks the two existing
			// cloud tests that stub a single 200 without a 404 first).
			if (version === 3 && wire.version !== 3) throw new SaveCorrupt(`cloud /v3 returned a version ${String(wire.version)} body for ${id}`);
			const gen = res.headers?.get?.('X-Generation') ?? wire.generation;
			if (gen) { this.generations.set(id, gen); this.unsynced.delete(id); }
			return CloudAdapter.decode(wire);
		}
		return null;
	}
```

The two pre-existing tests "sends the generation it loaded from on a subsequent save" (cloud.test.ts:85) and "encodes chunks on the way out and decodes them on the way back" (:131) stub ONE 200 response, which the probe loop consumes as the `/v3` reply. They MUST stay green untouched: their v2 body decodes as v2 because `decode` trusts `wire.version`. If either goes red, the implementation is overriding the body's version — fix the adapter, not the tests.

`saveWorld`: `const prefix = prefixFor(save.version);` body gets `...(save.version === 3 ? { height: save.height, genVersion: save.genVersion } : {})`; both `request(...)` calls use `${prefix}/${save.id}`. `listWorlds`: two requests in the order `[GET /v3/worlds, GET /worlds]` (issue the v3 request first — the test's stubbed responses are positional), `Promise.all`, map v3 rows to `{ ...r, origin: 'cloud', version: 3, height: r.height }` and v2 rows to `{ ...r, origin: 'cloud', version: 2, height: 64 }`. `deleteWorld`: loop both prefixes; any status other than 204/404 throws.

- [ ] **Step 4: Full suite + commit**

Run: `npm test` → green.

```bash
git add src/persistence/cloud.ts src/persistence/cloud.test.ts
git commit -m "feat(cloud): v3 routes with namespace probe and merged listing

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WkqJrcc2U5KmXWvtU969AW"
```

---

### Task 9: Dual adapter — fall back per leg, refuse both-bad and cross-height

**Files:**
- Modify: `src/persistence/dual.ts` (`loadWorld`)
- Test: `src/persistence/dual.test.ts` (append)

**Interfaces:**
- Consumes: `SaveCorrupt`, `SaveMismatch` (Task 7); `CloudError` codes (existing); `LocalStorageAdapter.loadWorld` may now throw `SaveCorrupt` (Task 7).
- Produces: `DualAdapter.loadWorld(id)`:
  - local throws `SaveCorrupt` + cloud good → return cloud copy (no fork; `markUnsynced` NOT called).
  - cloud throws `SaveCorrupt` + local good → `markUnsynced(id)`, `needsUpload.add(id)`, return local.
  - both bad (throw or null+throw) → rethrow the local error if any, else the cloud one.
  - both good and `height` or `genVersion` differ → throw `SaveMismatch`.
  - Chunk COUNTS are deliberately not compared: differing chunk sets are what the existing `sameContent` / ancestor / fork arbitration is for. (A cloud copy with far fewer chunks than local can trip the local shrink guard for the session; that is the guard doing its job, and it self-heals next launch.)
  - Network errors keep today's offline behaviour.

- [ ] **Step 1: Write the failing tests** — append to `dual.test.ts` (uses its `MemStorage`, `save()`, `fakeCloud()`; add `import { SaveCorrupt, SaveMismatch } from './errors';`):

```ts
describe('DualAdapter fail-closed load', () => {
	function localWith(s: WorldSave | null, corrupt = false) {
		const storage = new MemStorage();
		const local = new LocalStorageAdapter(storage as unknown as Storage);
		if (s) void local.saveWorld(s);
		if (corrupt) storage.setItem(`minicraft:v2:world:${ID}:chunk:0:0`, JSON.stringify({ blocks: '!!!' }));
		return local;
	}

	it('uses the cloud copy when the local copy is corrupt', async () => {
		const cloud = fakeCloud({ loadWorld: async () => save({ name: 'FromCloud' }) });
		const d = new DualAdapter(localWith(save(), true), cloud);
		const got = await d.loadWorld(ID);
		expect(got!.name).toBe('FromCloud');
	});

	it('uses the local copy when the cloud copy is corrupt, and flags it for upload', async () => {
		const cloud = fakeCloud({ loadWorld: async () => { throw new SaveCorrupt('bad'); } });
		const d = new DualAdapter(localWith(save({ name: 'Local' })), cloud);
		const got = await d.loadWorld(ID);
		expect(got!.name).toBe('Local');
		expect(d.takeNeedsUpload()).toContain(ID);
	});

	it('throws when both copies are unusable', async () => {
		const cloud = fakeCloud({ loadWorld: async () => { throw new SaveCorrupt('bad'); } });
		const d = new DualAdapter(localWith(save(), true), cloud);
		await expect(d.loadWorld(ID)).rejects.toThrow(SaveCorrupt);
	});

	it('throws SaveMismatch when the copies disagree on height', async () => {
		const tall = save({ version: 3, height: 256, genVersion: 2, chunks: [{ cx: 0, cz: 0, blocks: new Uint16Array(65536) }] });
		const cloud = fakeCloud({ loadWorld: async () => tall });
		const d = new DualAdapter(localWith(save()), cloud);
		await expect(d.loadWorld(ID)).rejects.toThrow(SaveMismatch);
	});
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/persistence/dual.test.ts` → FAIL (local corrupt propagates as a raw error; mismatch forks instead of throwing — the un-guarded path reaches `forkLocalCopy`, writing a 256-tall fork into the v2 local namespace and PUTting it). Note: this expectation holds only at this task's place in the sequence (after Tasks 6–8); against pre-Task-6 code the mismatch test is red for the wrong reason (`Unexpected chunk length` from `sameContent`'s encode).

- [ ] **Step 3: Implement** — top of `loadWorld`:

```ts
	async loadWorld(id: string): Promise<WorldSave | null> {
		let localCopy: WorldSave | null = null;
		let localError: Error | null = null;
		try { localCopy = await this.local.loadWorld(id); } catch (err) { localError = err as Error; }

		if (!this.cloud || isLegacyId(id)) {
			if (localError) throw localError;
			return localCopy;
		}

		let cloudCopy: WorldSave | null = null;
		try {
			cloudCopy = await this.cloud.loadWorld(id);
		} catch (err) {
			if (err instanceof SaveCorrupt) {
				// The cloud object is unreadable; the local copy (if any) is what we have.
				if (localError) throw localError;
				if (localCopy) { this.cloud.markUnsynced(id); this.needsUpload.add(id); return localCopy; }
				throw err;
			}
			// Offline: unchanged behaviour.
			if (localError) throw localError;
			if (localCopy) { this.cloud.markUnsynced(id); this.needsUpload.add(id); }
			return localCopy;
		}

		if (localError) {
			if (cloudCopy) return cloudCopy;     // the good copy wins; nothing is forked from a corrupt one
			throw localError;
		}
		// ... existing: !cloudCopy branch, !localCopy branch, then before the ancestor check:
		if (localCopy.height !== cloudCopy.height || localCopy.genVersion !== cloudCopy.genVersion) {
			throw new SaveMismatch(`world ${id}: local is ${localCopy.height}/gen${localCopy.genVersion}, cloud is ${cloudCopy.height}/gen${cloudCopy.genVersion}`);
		}
```

- [ ] **Step 4: Full suite + commit**

Run: `npm test` → green.

```bash
git add src/persistence/dual.ts src/persistence/dual.test.ts
git commit -m "feat(dual): per-leg fallback on corrupt copies; refuse cross-height loads

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WkqJrcc2U5KmXWvtU969AW"
```

---

### Task 10: API — /v3 routes, strict v3 schema, metadata, health codec 3, deploy.sh

**Files:**
- Modify: `api/src/schema.ts` (add `worldSaveWireSchemaV3`, `WorldSaveWireV3`)
- Modify: `api/src/handlers.ts` (parameterise the four route handlers; keep `/worlds*` behaviour identical)
- Modify: `deploy.sh:105-108` (`"codec":3`)
- Test: `api/src/handlers.test.ts` (append), `api/src/schema.test.ts` (append), `api/src/testFixtures.ts` (add `validWireV3`)

**Interfaces:**
- Consumes: `decodeChunk(str, len)`, `LEGACY_BLOCKS_PER_CHUNK` (Task 6).
- Produces:
  ```ts
  // schema.ts
  export const worldSaveWireSchemaV3: z.ZodType<WorldSaveWireV3>; // .strict(); version: literal(3); height: 64 | 256; genVersion: int >= 1; same chunk/player/lights/dup rules as v2
  export type WorldSaveWireV3 = z.infer<typeof worldSaveWireSchemaV3>;   // NOT an intersection with WorldSaveWire — `version: 2 & 3` is uninhabitable
  export type WireBase = Omit<WorldSaveWire, 'version'> & { version: 2 | 3 };  // handlers.ts; the common shape both namespaces are typed against
  // handlers.ts routes
  GET  /v3/worlds            -> rows { id, seed, name, createdAt, updatedAt, origin:'cloud', sizeBytes, generation, height, genVersion } (degraded rows: no height/genVersion, degraded: true)
  GET  /v3/worlds/:id, PUT /v3/worlds/:id, DELETE /v3/worlds/:id  -> same contract as /worlds, objects under worlds3/{id}.json, chunk length 16*height*16, custom metadata gains height + genVersion
  GET  /health               -> { ok: true, codec: 3 }
  ```

- [ ] **Step 1: Write the failing tests**

`testFixtures.ts`: add

```ts
export function validWireV3(over: Partial<WorldSaveWireV3> = {}): WorldSaveWireV3 {
	return { ...validWire(), version: 3, height: 256, genVersion: 2, chunks: [{ cx: 0, cz: 0, blocks: chunkBlocks(3, 65536) }], ...over } as WorldSaveWireV3;
}
```

`handlers.test.ts` — update the health test to `{ ok: true, codec: 3 }` and append:

```ts
describe('worlds API v3', () => {
	let bucket: FakeBucket;
	let app: ReturnType<typeof createApp>;
	beforeEach(() => { bucket = new FakeBucket(); app = createApp(bucket as unknown as BucketLike); });
	const put3 = (w = validWireV3(), headers: Record<string, string> = NEW) => request(app).put(`/v3/worlds/${w.id}`).set(headers).send(w);

	it('round-trips a 256 world under worlds3/ and lists it with its height', async () => {
		const w = validWireV3();
		await put3(w).expect(200);
		expect([...bucket.entries.keys()]).toEqual([`worlds3/${w.id}.json`]);
		const got = await request(app).get(`/v3/worlds/${w.id}`).expect(200);
		expect(got.body).toMatchObject({ version: 3, height: 256, genVersion: 2 });
		const list = await request(app).get('/v3/worlds').expect(200);
		expect(list.body[0]).toMatchObject({ id: w.id, height: 256, genVersion: 2 });
	});

	it('rejects a 65536-length chunk claimed as height 64, and a 16384 chunk claimed as 256', async () => {
		await put3(validWireV3({ height: 64 })).expect(400).then((r) => expect(r.body.code).toBe('BAD_CHUNK'));
		await put3(validWireV3({ chunks: [{ cx: 0, cz: 0, blocks: chunkBlocks(3, 16384) }] })).expect(400).then((r) => expect(r.body.code).toBe('BAD_CHUNK'));
	});

	it('rejects a v3 body missing height (strict schema)', async () => {
		const w = validWireV3() as Record<string, unknown>;
		delete w.height;
		await request(app).put(`/v3/worlds/${validWireV3().id}`).set(NEW).send(w).expect(400);
	});

	it('rejects unknown keys instead of stripping them', async () => {
		await put3({ ...validWireV3(), bogus: 1 } as unknown as WorldSaveWireV3).expect(400);
	});

	it('stores height and genVersion in object metadata (the list reads only metadata)', async () => {
		const w = validWireV3();
		await put3(w).expect(200);
		bucket.failOnDownload = true;
		const list = await request(app).get('/v3/worlds').expect(200);
		expect(list.body[0]).toMatchObject({ height: 256, genVersion: 2 });
	});

	it('old /worlds list does not see worlds3/ objects and /v3 list does not see worlds/', async () => {
		await put3(validWireV3()).expect(200);
		await request(app).put(`/worlds/${FIXTURE_ID}`).set(NEW).send(validWire()).expect(200);
		expect((await request(app).get('/worlds').expect(200)).body).toHaveLength(1);
		expect((await request(app).get('/v3/worlds').expect(200)).body).toHaveLength(1);
	});

	it('applies the shrink guard on /v3', async () => {
		const w = validWireV3({ chunks: Array.from({ length: 10 }, (_, i) => ({ cx: i, cz: 0, blocks: chunkBlocks(3, 65536) })) });
		const first = await put3(w).expect(200);
		await put3({ ...w, chunks: w.chunks.slice(0, 2) }, { 'If-Match': first.body.generation }).expect(400).then((r) => expect(r.body.code).toBe('SUSPICIOUS_SHRINK'));
	});
});
```

`schema.test.ts` append: `worldSaveWireSchemaV3.safeParse(validWireV3()).success === true`; `.safeParse({ ...validWireV3(), height: 128 }).success === false`; `.safeParse({ ...validWireV3(), version: 2 }).success === false`; and `worldSaveWireSchema.safeParse(validWireV3()).success === false` (the frozen v2 schema still refuses v3).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run api/src` → FAIL (404 on `/v3/*`; health codec 2).

- [ ] **Step 3: Implement**

`schema.ts`: extract the v2 object's shape into `const baseShape = { id, seed, name, createdAt, updatedAt, player, chunks, lights, lastSyncedGeneration }` and the dup-check into `function noDuplicateChunks(w, ctx)`; keep `export const worldSaveWireSchema = z.object({ version: z.literal(2), ...baseShape }).superRefine(noDuplicateChunks);` (same behaviour as today — verify the existing schema tests still pass) and add:

```ts
export const worldSaveWireSchemaV3 = z
	.object({ version: z.literal(3), height: z.union([z.literal(64), z.literal(256)]), genVersion: int.min(1), ...baseShape })
	.strict()
	.superRefine(noDuplicateChunks);
export type WorldSaveWireV3 = z.infer<typeof worldSaveWireSchemaV3>;
```

`handlers.ts`: introduce

```ts
/** `WorldSaveWire.version` is `literal(2)`, so `WorldSaveWireV3 extends WorldSaveWire` is FALSE and a
 *  generic bounded by WorldSaveWire does not typecheck (TS2322 on the schema, TS2339 on .height).
 *  vitest never type-checks, so this only surfaces in `cd api && npx tsc --noEmit` — run it. */
export type WireBase = Omit<WorldSaveWire, 'version'> & { version: 2 | 3 };

type Namespace<W extends WireBase> = {
	routePrefix: string;          // '/worlds' | '/v3/worlds'
	objectPrefix: string;         // 'worlds/' | 'worlds3/'
	schema: z.ZodType<W>;
	blocksPerChunk: (w: W) => number;
	extraMetadata: (w: W) => Record<string, string>;           // {} | { height, genVersion }
	extraSummary: (custom: Record<string, string>) => Record<string, unknown>; // {} | { height: Number(custom.height), genVersion: Number(custom.genVersion) }
};
function registerWorldRoutes<W extends WireBase>(app: Express, bucket: BucketLike, ns: Namespace<W>): void { /* the four handlers, using ns.* wherever 'worlds/', OBJECT_RE, worldSaveWireSchema, BLOCKS_PER_CHUNK appeared */ }
```

`validateChunks(world: WireBase, len: number)` and the shrink guard take `WireBase`. `objectName`/`OBJECT_RE` become functions of `ns.objectPrefix`, keeping the FULL anchored uuid group exactly as today (`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`), not a laxer `[0-9a-f-]{36}` — the old namespace must stay byte-for-byte:

```ts
const UUID_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
function objectRe(prefix: string): RegExp { return new RegExp(`^${prefix.replace(/\//g, '\\/')}(${UUID_SRC})\\.json$`); }
``` In `createApp`: `registerWorldRoutes(app, bucket, { routePrefix: '/worlds', objectPrefix: 'worlds/', schema: worldSaveWireSchema, blocksPerChunk: () => LEGACY_BLOCKS_PER_CHUNK, extraMetadata: () => ({}), extraSummary: () => ({}) })` and the v3 twin (`blocksPerChunk: (w) => 16 * w.height * 16`, metadata `{ height: String(w.height), genVersion: String(w.genVersion) }`, summary parses them back; a degraded row (unreadable metadata) omits both and keeps `degraded: true`). Health: `codec: 3`. Every existing `/worlds` test must pass unchanged — that is the "byte-for-byte" guarantee.

`deploy.sh`: `'"codec":2'` → `'"codec":3'` and the two messages to say 3.

- [ ] **Step 4: Full suite, API type-check and build, commit**

Run: `npm test` → green (API and client). Then `cd api && npx tsc --noEmit && npm run build` → 0 errors (`api/package.json`'s `build` is `tsc`; this is what `./deploy.sh` ships, and vitest will not catch a generic-bound error).

```bash
git add api/src/schema.ts api/src/handlers.ts api/src/testFixtures.ts api/src/handlers.test.ts api/src/schema.test.ts deploy.sh
git commit -m "feat(api): /v3 worlds routes with strict schema, height metadata, codec 3

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WkqJrcc2U5KmXWvtU969AW"
```

---

### Task 11: Start-up fails closed; World built after load; new worlds are tall; menu notice

**Files:**
- Create: `src/game/apply-save.ts` (pure: validates and applies a `WorldSave` into a `World`)
- Create: `src/game/continue-policy.ts` (pure: the refuse-to-continue decision, so it is unit-tested and not only browser-checked)
- Modify: `src/main.ts:86-160` (`startGame`), `:66-85` (`showMenu(notice?)`)
- Modify: `src/ui/menu.ts:37-43` (`show(onAction, notice?)`), `renderHome` (:81 paint — the `card.innerHTML = '<h1>Minicraft</h1>'` AFTER the list resolves; the one at :65 is the "Loading worlds…" paint and gets overwritten)
- Modify: `src/ui/menu-model.ts` (`MenuInput.notice`, `MenuModel` carries `notice`) — there is no jsdom/happy-dom in this repo, so the notice lives in the pure model and is tested there
- Test: `src/game/apply-save.test.ts` (new), `src/game/continue-policy.test.ts` (new), `src/ui/menu-model.test.ts` (append)

**Interfaces:**
- Consumes: `World(seed, opts)`, `World.create(seed)` (Tasks 1, 4); `findSafeSpawn(world, pos)`, `new Player(spawn, height)` (Task 5); `adapter.loadWorld` throwing `SaveCorrupt | SaveMismatch | CloudError` (Tasks 7–9); `fillChunkLights` (existing).
- Produces:
  ```ts
  // apply-save.ts
  export function worldFromSave(save: WorldSave): World;                      // new World(save.seed, { height: save.height, genVersion: save.genVersion, saveVersion: save.version })
  export function applySave(world: World, save: WorldSave): void;             // pre-pass validates EVERY chunk: cx/cz integers in 0..WORLD_CHUNKS_X-1 / 0..WORLD_CHUNKS_Z-1 AND blocks.length === blocksPerChunk(world.height), before writing any; then the existing apply loop + fillChunkLights pass; throws SaveCorrupt
  // continue-policy.ts
  export type LoadOutcome = { save: WorldSave | null } | { error: unknown };
  export type ContinueDecision = { ok: true; save: WorldSave } | { ok: false; notice: string };
  export function resolveContinue(outcome: LoadOutcome, worldName: string): ContinueDecision;
  //   { save: null }            -> { ok: false, notice: `Couldn't find the save for ${worldName}. Nothing was changed.` }
  //   { error: SaveMismatch }   -> { ok: false, notice: `${worldName} has two different copies (this device and the cloud). Ask a grown-up. Nothing was changed.` }
  //   { error: anything else } -> { ok: false, notice: `Couldn't open ${worldName} (${err.name}). Nothing was changed.` }
  //   { save }                  -> { ok: true, save }
  // menu-model.ts
  MenuInput gains `notice: string | null`; both MenuModel variants gain `notice: string | null` (passed through unchanged)
  // menu.ts
  show(onAction: (a: MenuAction) => void, notice?: string): void;              // stored on the instance; renderHome passes it into the model ONCE and clears it, so the 15 s refresh re-render does not repeat it; rendered as a .menu-warning div under the title (class already exists in ui.css:213)
  ```

- [ ] **Step 1: Write the failing tests**

`src/game/continue-policy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveContinue } from './continue-policy';
import { SaveCorrupt, SaveMismatch } from '../persistence/errors';
import type { WorldSave } from '../persistence/adapter';

const save = { version: 2, height: 64, genVersion: 1, id: 'x', seed: 1, name: 'Castle', createdAt: 0, updatedAt: 0, player: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hotbar: [], selected: 0 }, chunks: [] } as WorldSave;

describe('resolveContinue', () => {
	it('continues on a loaded save', () => {
		expect(resolveContinue({ save }, 'Castle')).toEqual({ ok: true, save });
	});
	it('refuses a null load (today main.ts warns and starts a fresh world, whose first autosave prunes the local copy)', () => {
		const d = resolveContinue({ save: null }, 'Castle');
		expect(d.ok).toBe(false);
		if (!d.ok) expect(d.notice).toBe("Couldn't find the save for Castle. Nothing was changed.");
	});
	it('refuses a corrupt save and names the error', () => {
		const d = resolveContinue({ error: new SaveCorrupt('chunk 1,0 wrong length') }, 'Castle');
		expect(d.ok).toBe(false);
		if (!d.ok) expect(d.notice).toBe("Couldn't open Castle (SaveCorrupt). Nothing was changed.");
	});
	it('gives a mismatch its own wording', () => {
		const d = resolveContinue({ error: new SaveMismatch('64 vs 256') }, 'Castle');
		expect(d.ok).toBe(false);
		if (!d.ok) expect(d.notice).toBe('Castle has two different copies (this device and the cloud). Ask a grown-up. Nothing was changed.');
	});
	it('handles a non-Error throw', () => {
		const d = resolveContinue({ error: 'boom' }, 'Castle');
		expect(d.ok).toBe(false);
		if (!d.ok) expect(d.notice).toBe("Couldn't open Castle (Error). Nothing was changed.");
	});
});
```

`src/ui/menu-model.test.ts` — the `base()` helper gains `notice: null`; append:

```ts
describe('menuModel notice', () => {
	it('passes a notice through on the full menu', () => {
		expect(menuModel(base({ schedule: { kind: 'none' }, notice: 'Nope' }))).toEqual({ mode: 'full', notice: 'Nope' });
	});
	it('passes a notice through on the card', () => {
		expect(card(base({ notice: 'Nope' })).notice).toBe('Nope');
	});
	it('is null when there is nothing to say', () => {
		expect(menuModel(base({ schedule: { kind: 'none' } }))).toEqual({ mode: 'full', notice: null });
	});
});
```
(Existing `toEqual({ mode: 'full' })` assertions in that file become `toEqual({ mode: 'full', notice: null })`.)

`src/game/apply-save.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { applySave, worldFromSave } from './apply-save';
import { SaveCorrupt } from '../persistence/errors';
import type { WorldSave } from '../persistence/adapter';

const ID = '11111111-1111-4111-8111-111111111111';
function base(over: Partial<WorldSave>): WorldSave {
	return { version: 2, height: 64, genVersion: 1, id: ID, seed: 1, name: 'w', createdAt: 0, updatedAt: 0, player: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hotbar: [], selected: 0 }, chunks: [], ...over };
}

describe('worldFromSave / applySave', () => {
	it('builds a World from the record, not from any summary', () => {
		const w = worldFromSave(base({ version: 3, height: 256, genVersion: 2 }));
		expect(w.height).toBe(256); expect(w.genVersion).toBe(2); expect(w.saveVersion).toBe(3);
	});
	it('applies matching chunks and marks them modified', () => {
		const blocks = new Uint16Array(16384); blocks[5] = 3;
		const w = worldFromSave(base({ chunks: [{ cx: 0, cz: 0, blocks }] }));
		applySave(w, base({ chunks: [{ cx: 0, cz: 0, blocks }] }));
		expect(w.getChunk(0, 0)!.blocks[5]).toBe(3);
		expect(w.getChunk(0, 0)!.modified).toBe(true);
	});
	it('refuses a 16384 chunk in a 256 world before writing anything', () => {
		const w = worldFromSave(base({ version: 3, height: 256, genVersion: 2 }));
		const good = new Uint16Array(65536); good[7] = 3;
		const bad = new Uint16Array(16384);
		expect(() => applySave(w, base({ version: 3, height: 256, genVersion: 2, chunks: [{ cx: 0, cz: 0, blocks: good }, { cx: 1, cz: 0, blocks: bad }] }))).toThrow(SaveCorrupt);
		expect(w.getChunk(0, 0)).toBeUndefined(); // nothing applied
	});
	it('refuses a chunk whose coordinates are outside the world (a malformed key yields NaN)', () => {
		const w = worldFromSave(base({}));
		const blocks = new Uint16Array(16384);
		expect(() => applySave(w, base({ chunks: [{ cx: Number.NaN, cz: 0, blocks }] }))).toThrow(SaveCorrupt);
		expect(() => applySave(w, base({ chunks: [{ cx: 32, cz: 0, blocks }] }))).toThrow(SaveCorrupt);
		expect(() => applySave(w, base({ chunks: [{ cx: 1.5, cz: 0, blocks }] }))).toThrow(SaveCorrupt);
		expect(w.getChunk(0, 0)).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/game/apply-save.test.ts src/game/continue-policy.test.ts src/ui/menu-model.test.ts` → FAIL (modules missing; `notice` not in the model).

- [ ] **Step 3: Implement continue-policy.ts, menu-model.ts, apply-save.ts**

`src/game/continue-policy.ts`:

```ts
import type { WorldSave } from '../persistence/adapter';
import { SaveMismatch } from '../persistence/errors';

export type LoadOutcome = { save: WorldSave | null } | { error: unknown };
export type ContinueDecision = { ok: true; save: WorldSave } | { ok: false; notice: string };

/**
 * Whether "Continue" may start the game. Refusing is the whole point: starting
 * on a fresh world after a failed load makes the first autosave prune the local
 * copy to zero chunks (main.ts used to console.warn and carry on).
 */
export function resolveContinue(outcome: LoadOutcome, worldName: string): ContinueDecision {
	if ('error' in outcome) {
		const err = outcome.error;
		if (err instanceof SaveMismatch) {
			return { ok: false, notice: `${worldName} has two different copies (this device and the cloud). Ask a grown-up. Nothing was changed.` };
		}
		const name = err instanceof Error ? err.name : 'Error';
		return { ok: false, notice: `Couldn't open ${worldName} (${name}). Nothing was changed.` };
	}
	if (outcome.save === null) return { ok: false, notice: `Couldn't find the save for ${worldName}. Nothing was changed.` };
	return { ok: true, save: outcome.save };
}
```

`src/ui/menu-model.ts`: add `notice: string | null;` to `MenuInput`; change `export type MenuModel = { mode: 'full'; notice: string | null } | CardModel;` and add `notice: string | null;` to `CardModel`; `card(...)` takes `notice` as a first argument (`function card(notice, title, line, playEnabled, world)`) and every `return card(...)` in `menuModel` passes `i.notice`; the `{ mode: 'full' }` return becomes `{ mode: 'full', notice: i.notice }`.

`src/game/apply-save.ts`:

```ts
import { World } from '../engine/world/world';
import { blocksPerChunk, WORLD_CHUNKS_X, WORLD_CHUNKS_Z } from '../engine/world/coords';
import { fillChunkLights } from '../engine/world/lighting';
import type { WorldSave } from '../persistence/adapter';
import { SaveCorrupt } from '../persistence/errors';

export function worldFromSave(save: WorldSave): World {
	return new World(save.seed, { height: save.height, genVersion: save.genVersion, saveVersion: save.version });
}

/** All-or-nothing: a record that does not fit the world is never half-applied (and therefore never autosaved). */
export function applySave(world: World, save: WorldSave): void {
	const len = blocksPerChunk(world.height);
	for (const rc of save.chunks) {
		// localStorage builds cx/cz with Number() from the key; a malformed key gives NaN,
		// ensureChunk(NaN, NaN) makes a phantom chunk and the next save writes ":chunk:NaN:NaN".
		if (!Number.isInteger(rc.cx) || !Number.isInteger(rc.cz) || rc.cx < 0 || rc.cx >= WORLD_CHUNKS_X || rc.cz < 0 || rc.cz >= WORLD_CHUNKS_Z) {
			throw new SaveCorrupt(`chunk ${String(rc.cx)},${String(rc.cz)} is outside the world`);
		}
		if (rc.blocks.length !== len) throw new SaveCorrupt(`chunk ${rc.cx},${rc.cz} has ${rc.blocks.length} blocks, world height ${world.height} needs ${len}`);
	}
	for (const rc of save.chunks) {
		const c = world.ensureChunk(rc.cx, rc.cz);
		c.blocks.set(rc.blocks);
		c.fluidMeta.clear();
		if (rc.fluidMeta) for (const [idx, packed] of rc.fluidMeta) c.fluidMeta.set(idx, packed);
		c.modified = true;
		c.dirty = true;
	}
	// Lights were computed at ensureChunk from generated blocks; recompute on the saved ones.
	for (const rc of save.chunks) { const c = world.getChunk(rc.cx, rc.cz); if (c) fillChunkLights(world, c); }
}
```

- [ ] **Step 4: Rewire main.ts startGame**

```ts
	function showMenu(notice?: string) {
		menu.show((action) => { /* unchanged body */ }, notice);
	}

	async function startGame(worldId: string, seed: number, name: string, mode: null | 'continue') {
		menu.hide();
		for (const entry of [...lights.entries()]) lights.remove(entry.x, entry.y, entry.z);

		let save: WorldSave | null = null;
		if (mode === 'continue') {
			let outcome: LoadOutcome;
			try {
				outcome = { save: await adapter.loadWorld(worldId) };
			} catch (err) {
				console.error('loadWorld failed', err);
				outcome = { error: err };
			}
			const decision = resolveContinue(outcome, name || 'this world');
			if (!decision.ok) {
				showMenu(decision.notice);
				return;
			}
			save = decision.save;
		}

		// Legacy (v1) adoption runs only AFTER a successful load, so a legacy world that
		// refuses to open really has had "nothing changed" (the adoption map key included).
		let activeId = worldId;
		if (isLegacyId(worldId)) {
			const seedOfLegacy = seedFromLegacyId(worldId);
			activeId = localAdapter.adoptedId(seedOfLegacy) ?? newWorldId();
			localAdapter.adoptLegacy(seedOfLegacy, activeId);
		}

		const world = save ? worldFromSave(save) : World.create(seed);
		let createdAt = Date.now();
		let worldName = name;
		const player = new Player([256.5, world.height - 1, 256.5], world.height);

		let savedSpawn: [number, number, number] | null = null;
		let savedHotbar: BlockId[] | undefined;
		let savedSelected = 0;
		if (save) {
			worldName = save.name;
			createdAt = save.createdAt;
			try {
				applySave(world, save);
			} catch (err) {
				console.error('applySave failed', err);
				const d = resolveContinue({ error: err }, save.name);
				showMenu(d.ok ? 'Nothing was changed.' : d.notice);
				return;
			}
			savedSpawn = [save.player.x, save.player.y, save.player.z];
			cam.yaw = save.player.yaw; cam.pitch = save.player.pitch;
			savedHotbar = save.player.hotbar; savedSelected = save.player.selected;
			if (save.lights) for (const l of save.lights) lights.add(l.x, l.y, l.z, l.color);
		}
		// New worlds spawn on the generated surface (v2: ~120), saved ones near where they left off.
		player.position = findSafeSpawn(world, savedSpawn ?? [256.5, world.height - 1, 256.5]);
		// ... rest of startGame unchanged
```

Remove the old `new World(seed)` at :96, the old `new Player([256, 60, 256])` at :100, the old adoption block at :105-112 (it moved below the load), the old load/apply block (:116-147) and the `fillChunkLights` import if now unused. Import `worldFromSave, applySave` from `./game/apply-save`, `resolveContinue, type LoadOutcome` from `./game/continue-policy`, and `type WorldSave` from `./persistence/adapter`. The menu's `continue` action (`menu.ts:14`) is `{ type: 'continue'; id; seed }` — no name, so the notice could not say which world. Extend it to `{ type: 'continue'; id: string; seed: number; name: string }`; the full-menu list (`menu.ts:160`) passes `w.name`; the schedule card (`menu.ts:128`) passes `current.world.name`, which requires `CardModel.world` in `menu-model.ts` to become `{ id: string; seed: number; name: string } | null` with `menuModel` building it as `{ id: found.id, seed: found.seed, name: found.name }` (`resolveWorld` returns a `WorldSummary`, which has `name`). In `main.ts:81` the handler becomes `startGame(action.id, action.seed, action.name, 'continue')`. `menu-model.test.ts` has no assertion on the `world` object's exact shape (grep `world:` finds none), so no existing test changes for this.

`menu.ts`: `private notice: string | null = null;` `show(onAction, notice?: string) { ...; this.notice = notice ?? null; ... }`; `private model(worlds, offline)` passes `notice: this.notice` into `menuModel(...)`; in `renderHome`, at the SECOND `card.innerHTML = '<h1>Minicraft</h1>'` (:81, after the list resolved — the :65 one is the loading paint and is overwritten): `const model = this.model(worlds, offline); this.notice = null;` then `if (model.notice) { const n = document.createElement('div'); n.className = 'menu-warning'; n.textContent = model.notice; card.appendChild(n); }` before the `if (model.mode === 'card')` branch. Clearing `this.notice` right after building the model is what stops the 15 s refresh (`renderHome` is re-called by the interval) from repeating it.

- [ ] **Step 5: Verify**

Run: `npm test && npm run build && npm run lint` → green. Then a 60-second manual check: `VITE_MINICRAFT_API_URL=http://127.0.0.1:9099 npm run dev` (process env beats `.env.local` in Vite, and 127.0.0.1:9099 has nothing listening, so every save call fails closed instead of reaching the PRODUCTION API that `.env.local` points at — never edit `.env.local`), open `http://localhost:5173`, click New World, confirm the player stands on grass around y≈121 (`window.__mc.player.position` in the console), fly up past y=200, dig down — the console `__mc.world.height` is 256.

- [ ] **Step 6: Commit**

```bash
git add src/game/apply-save.ts src/game/apply-save.test.ts src/game/continue-policy.ts src/game/continue-policy.test.ts src/main.ts src/ui/menu.ts src/ui/menu-model.ts src/ui/menu-model.test.ts
git commit -m "feat(main): tall new worlds; continue fails closed with a menu notice

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WkqJrcc2U5KmXWvtU969AW"
```

---

### Task 12: Docs

**Files:**
- Modify: `docs/lighting.md:11, 46, 147`, `docs/persistence.md` (new `### v3 (tall worlds)` under "Storage formats", `## API` section), `docs/specs.md:49-56, 98`, `README.md:101-102`

**Interfaces:** none (prose).

- [ ] **Step 1: Edit**

- `docs/lighting.md:11`: "Each `Chunk` carries a `lights: Uint16Array` alongside its `blocks: Uint16Array`. Both are 16 × H × 16 entries where H is the world's height (64 for every world saved before v3, 256 for new worlds), indexed by the same `indexOf(x, y, z)`…". `:46`: "walk `y` from `height - 1` down". `:147`: replace the `Array.shift()` trade-off bullet with "**BFS queues use a head cursor** (not `Array.shift()`, whose V8 fast path dies past ~8k entries; a 256-high air column seeds 32k). Measured 492 ms → 2.4 ms per chunk." Add a bullet under the shadows section: "Voxels above the highest opaque block of the 3×3 chunk neighbourhood skip the sun raycast (`maxOpaqueY`, recomputed from `blocks` on every call so it can never go stale; the 9-chunk top-down scan costs ~12 ms per chunk on a 256 world, ~1 s over the initial 81-chunk view, and is the price of not caching)."
- `docs/persistence.md`: after `### v2 (current)` add:

  ```
  ### v3 (tall worlds)

  minicraft:v3:world:{uuid}:meta        (+ height, genVersion)
  minicraft:v3:world:{uuid}:chunk:{cx}:{cz}

  Same codec, chunk length 16 × height × 16. Cloud objects live under `worlds3/`
  behind `/v3/worlds*`; the old routes and prefix never see them, so a stale
  bundle cannot open a tall world. A world's version is fixed for life — nothing
  migrates. Load fails closed: a v3 meta without a valid height, any chunk that
  does not decode to the record's length, or local/cloud copies that disagree on
  height, refuse to open (the menu says so; nothing is written). localStorage now
  carries the same shrink guard as the API: a save with fewer than half the stored
  chunks (when more than 4 are stored) writes what it has, prunes nothing, and
  reports "Saved on this device: error" — and keeps reporting it for the rest of
  that session, because the snapshot never grows back until reload. It is not
  data loss: on the next launch every surviving chunk loads and is marked
  modified again, and saves go back to normal.
  ```
  and in `## API`: the `/v3` routes, `height`/`genVersion` custom metadata, `/health` → `codec 3`.
- `docs/specs.md:53`: "**16 × H × 16** blocks, H = 64 (worlds saved before v3) or 256 (new worlds; surface ≈ 120, bedrock at 0). `Uint16Array(16·H·16)` per chunk." `:98`: "`Uint16Array`".
- `README.md:101-102`: sea level 120 for new worlds, bedrock floor, "Chunks are 16×256×16 in new worlds (16×64×16 in worlds created before v3)".

- [ ] **Step 2: Commit**

```bash
git add docs/lighting.md docs/persistence.md docs/specs.md README.md
git commit -m "docs: per-world height, v3 save format and routes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WkqJrcc2U5KmXWvtU969AW"
```

---

### Task 13: Browser verification (spec §7.11) at localhost with the API intercepted

**Files:** none committed (a scratch Playwright script under the session scratchpad, or the Playwright MCP driven by hand).

**Interfaces:**
- Consumes: the dev server (`npm run dev` → `http://localhost:5173`), `window.__mc = { world, player, loop }` (DEV only), the localStorage key formats from Task 7, the API contract from Task 10.

- [ ] **Step 1: Point the dev server at a dead host FIRST, then stub it.** `.env.local` holds `VITE_MINICRAFT_API_URL=https://minicraft-api-uv67ojrpvq-uc.a.run.app` — PRODUCTION. Intercepting by glob and asserting "nothing reached prod" only at the end puts the safety net after the risk: one glob typo and a real PUT lands in `gs://minicraft-worlds` under a fresh uuid and shows up in the kid's menu. So: start the server as `VITE_MINICRAFT_API_URL=http://127.0.0.1:9099 npm run dev` in the background (a process env var beats `.env.local` in Vite; never edit `.env.local`). Nothing listens on 9099, so a missed route fails closed. In the browser session register a Playwright route for `http://127.0.0.1:9099/**` that (a) records every request (method, url, PUT body) and (b) responds from an in-memory map: GET `/v3/worlds` and `/worlds` → `[]` (or the served world below), GET id → 404 unless served, PUT → `200 { updatedAt, generation: "1" }`, DELETE → 204. Only THEN open the page. Belt and braces: at the end assert the recorded log contains only `127.0.0.1:9099` URLs and that `page.evaluate(() => performance.getEntriesByType('resource').map(e => e.name))` contains no `run.app` URL.

- [ ] **Step 2: Tall world round-trip.** Navigate to `http://localhost:5173/`, click New World, Create. Assert via `page.evaluate`:
  - `__mc.world.height === 256`, `__mc.world.genVersion === 2`, `__mc.world.saveVersion === 3`
  - `__mc.player.position[1]` between 115 and 132
  - fly: `__mc.player.position = [256.5, 250, 256.5]` then `__mc.world.setBlock(256, 250, 256, 3); __mc.loop.markChunkDirtyAround(256, 256); __mc.loop.onWorldMutated?.()` → `__mc.world.getBlock(256, 250, 256) === 3`
  - bedrock: `__mc.world.getBlock(256, 0, 256) === 33` (bedrock's catalog id; prefer looking it up by name if the console has the catalog) and `__mc.world.setBlock(256, 1, 256, 3)` → `getBlock === 3`
  - wait > 6 s for autosave; assert a PUT to `/v3/worlds/<id>` was recorded with `height: 256`, `genVersion: 2`, and that `localStorage` holds `minicraft:v3:world:<id>:meta` and NO `minicraft:v2:world:<id>:*` keys.
  - reload, click the world in the list, assert `getBlock(256, 250, 256) === 3` and `getBlock(256, 1, 256) === 3`.

- [ ] **Step 3: Old world untouched.** Clear localStorage; seed a v2 fixture by `localStorage.setItem` of a `minicraft:v2:world:<uuid>:meta` (version 2, seed 42, name "Old") and one `:chunk:0:0` with a 16384-block payload (encode it in Node with the client codec and paste the string). Reload, click "Old": assert `__mc.world.height === 64`, `saveVersion === 2`, the terrain renders (`__mc.player.position[1]` between 25 and 40), then place a block, wait for autosave, and assert every key still starts with `minicraft:v2:` and no `minicraft:v3:` key exists.

- [ ] **Step 4: The B2/B4 chain.** Clear localStorage. Make the stub serve one tall world (`version 3, height 256, genVersion 2`, 6 chunks of 65536, name "CloudTall") from `GET /v3/worlds` (row with `height: 256, genVersion: 2`) and `GET /v3/worlds/<id>`. Reload, click "CloudTall": assert `__mc.world.height === 256`, place a block, wait for autosave, assert the recorded PUT carries **all 6 chunks plus the edited one** (never fewer than 6) and went to `/v3/worlds/<id>`. Then make `GET /v3/worlds/<id>` and `GET /worlds/<id>` both 404 with localStorage cleared, click the world: assert the menu is shown again with a "Couldn't" notice and that **no PUT and no localStorage write** happened.

- [ ] **Step 5: Report.** Paste the assertion results (pass/fail per bullet) and the intercepted request log into the task report. Any failure here is a defect in Tasks 7–11, not in this task; fix there, re-run.

---

## Gate 2 changes (2026-09-20)

Both reviewers applied the plan's own edits to a scratch tree and ran vitest. What changed as a result:

- Task 1 now also fixes `src/persistence/codec.test.ts:4` (missed import → silent `undefined` → 6 red), gives `generateChunk` an ignored third argument, derives `World.genVersion` from height, and adds explicit `{ height: 64 }` to the literal-63 tests. `npx tsc --noEmit` is part of its exit criterion.
- Task 2's roof test replaced by the variant that actually goes red on a stale `y = 63` re-seed; perf threshold 50 → 250 ms (measured 1800 ms red / 2.4 ms green; headroom for a loaded box).
- Task 3 now depends on Task 2 (its fixture times out on the shift() queue); perf test uses a floor-only fixture with a 150 ms threshold (the plate fixture measured ~100 ms on the *correct* code).
- Task 4: `World.create` is the one place height/genVersion are cross-checked; constructor never validates.
- Task 5: liquid test ticks until the water lands (≤ 2000); `sanitizeSpawn` call is at :224.
- Task 6: line refs corrected (:96, :236-237, cloud :84).
- Task 7: `payloadOf` defined; corrupt-chunk test is a LENGTH mismatch (a garbage payload already throws today); invalid-height v3 rows are listed, not hidden; shrink-guard wedge documented.
- Task 8: the body's `version` wins over the probed namespace (the override broke two existing cloud tests); positional stub order stated.
- Task 9: chunk counts are not compared; red-for-the-right-reason only after Task 6.
- Task 10: `WireBase` generic bound (the `WorldSaveWire`-bounded generic does not compile — `version: 2` vs `3`); full uuid pattern kept; `cd api && npx tsc --noEmit && npm run build` in the exit criterion.
- Task 11: `resolveContinue` is a pure, unit-tested policy; the menu notice rides the pure `menuModel` (no jsdom in the repo); legacy adoption moved after a successful load; `applySave` validates cx/cz; the continue action carries the world name.
- Task 13: the dev server is pointed at an unroutable host on the command line BEFORE any stub, so a missed route fails closed instead of reaching production.
- Execution note added: parallel tasks need separate worktrees because every task's gate is the full suite.

## Self-review (done while writing)

- **Spec coverage.** §2 sites → Task 1 (every file:line listed), shadows early-out → Task 3, BFS cursor → Task 2, player fallback :93 → Task 5, tnt → Tasks 1/4, raycast not edited (Task 5 only tests it). §3 → Task 4 (v1 verbatim + dispatcher default 1, v2, profile, bedrock unbreakable incl. TNT). §4 → Task 7 (records, keys, probe order, codec length, fail-closed local, shrink guard), Task 8 (cloud probe/list/metadata decode), Task 9 (dual fallback + mismatch), Task 11 (World after load, apply length check, refuse-to-continue). §5 → Task 10 (+ deploy.sh, parity in Task 6). §6 → Task 11. §7.1–7.10 → Tasks 4, 4, 6, 7, 7, 8, 9, 11, 10, 2/3/5 respectively; §7.11 → Task 13. §8 rollout is operational (API deploy then site), not a code task — the parent runs `./deploy.sh --verify` after Task 10 lands and before the site goes up.
- **Placeholders.** None: every step has code or an exact edit. The only "recorded later" value is `EXPECTED_HASH_V2`, by design (spec §7.2), with the recording step spelled out.
- **Type consistency.** `blocksPerChunk(height)`, `isWorldHeight`, `WorldHeight`, `LEGACY_HEIGHT` (Task 1) are used with those names in Tasks 6–11. `World(seed, { height, genVersion, saveVersion })` and `World.create(seed)` (Tasks 1, 4) match Tasks 5, 11. `SaveCorrupt`/`SaveMismatch` (Task 7) match Tasks 8, 9, 11. `encodeChunk(blocks, len)` / `decodeChunk(str, len)` (Task 6) match Tasks 7, 8, 10. `skyCeilingY`, `sanitizeSpawn(pos, height)`, `Player(spawn, height)` (Task 5) match Task 11. `worldSaveWireSchemaV3`, `WorldSaveWireV3`, `validWireV3` (Task 10) are internal to the API.
- **Dependency correction found in review:** Task 5's player tests call `World.create`, so Task 5 depends on Tasks 1 **and 4** (table updated). Gate 2 added: Task 3 depends on Task 2.
- **Type consistency after gate 2:** `World(seed, { height?, genVersion?, saveVersion? })` with genVersion derived from height (Task 1) is what Tasks 2/3/5 fixtures rely on; `generateChunk(chunk, seed, genVersion = 1)` has the same signature in Task 1 (ignored) and Task 4 (dispatch); `WireBase` (Task 10) is only used inside `api/src`; `resolveContinue(outcome, worldName)` / `LoadOutcome` / `ContinueDecision` (Task 11) match their use in `startGame`; `MenuAction.continue.name`, `CardModel.world.name`, `MenuInput.notice`, `MenuModel.notice` are defined and consumed only in Task 11; `payloadOf(c: EncodedChunk)` (Task 7) uses the existing `EncodedChunk` type from `adapter.ts`.
