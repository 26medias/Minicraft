# Performance (smooth movement in v3 worlds) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Moving through a generator-v3 world stops stuttering: walking produces no frame over 50 ms, tier-5 flight at most a handful, placing a block costs under 20 ms, and the JS heap stays bounded — with world data byte-identical, `sunlit` identical to a fully-loaded reference, and every change gated by a test that can go red.

**Architecture:** Seven changes in the spec's order A → C → G → B → D → E → F. A replaces the string-keyed chunk map with a bounds-checked flat array; C rewrites the shadow caster as a constant relative-path DDA over 3×3 chunk references with a per-start-column early-out and makes it load-order independent; G removes per-corner allocations from the mesher behind a byte golden; B replaces "2 chunks per frame" with a pure scheduler (`src/game/chunk-scheduler.ts`: edit lane first, nearest-first stream set, adaptive 30/6 ms budget, dirty-until-applied); D moves shadows + meshing into one Web Worker (`src/engine/world/chunk.worker.ts`) behind an injectable factory, with `Chunk.rev` and object identity guarding stale replies; E evicts meshes beyond `UNMOUNT_RADIUS` and unmodified data beyond `DATA_RADIUS`, hashes `sunlit` so neighbours re-mesh only when their shadows changed, and skips the liquid rescan on dry chunks; F adds the F3 overlay. A Playwright bench (`scripts/perf-bench.ts`) is the exit criterion.

**Tech Stack:** TypeScript strict, Vite 5 (module workers via `new Worker(new URL(...), {type:'module'})`), vitest 4 (node env — no `Worker` global), Three.js 0.164 untouched except fog and geometry disposal, Playwright (new devDependency) + CDP for the bench.

**Spec:** `docs/superpowers/specs/2026-09-22-performance-design.md` — read the header (radii constants), §2 (baseline numbers), §3 (the seven changes), §6 (every test and the mutant that turns it red), §8 (finding → action). Gate-1 probe code to port from: `/tmp/claude-1000/-home-julien-Projects-Minicraft/594fd67c-59b0-4080-aef3-997231966f29/scratchpad/perf-gate1/{probe-dda,probe-worker,worker,probe-evict,common}.ts` (working code; if the scratchpad is gone, the spec's formulas are sufficient).

## Global Constraints

- Branch `perf` (cut from `worldgen`). Indentation: tabs (1 tab = 4 spaces per repo rule). `npm test` (vitest, `src/**` + `api/src/**`) **and** `npx tsc --noEmit` **and** `npm run lint` must be green after **every** task; `npm run build` after Tasks 1, 5, 7.
- **World data never changes.** `EXPECTED_HASH`, `EXPECTED_HASH_V2`, `EXPECTED_HASH_V3` in `src/engine/world/generation.test.ts` are untouched and green after every task. The mesh golden (Task 3) is recorded ONCE at the base commit and never re-recorded.
- Radii are the three named constants from the spec header, defined ONCE in `src/engine/world/radii.ts` (created in Task 4; engine home so `render` and `game` both import it and engine never imports `game`), re-exported by `src/game/chunk-scheduler.ts`, and never written as `VIEW_RADIUS + n`: `MESH_RADIUS = 5`, `UNMOUNT_RADIUS = 6`, `DATA_RADIUS = 7`. `VIEW_RADIUS = 4` stays in `loop.ts` as the walk/physics ring only. (There is no eslint import-boundary rule in this repo — lint will not enforce the direction; the file placement does.)
- The chunk index is exactly `cx * WORLD_CHUNKS_Z + cz` with a mandatory bounds check (`0 ≤ cx < WORLD_CHUNKS_X && 0 ≤ cz < WORLD_CHUNKS_Z`, else `undefined`). No other formula anywhere.
- `meshChunk`, `computeChunkShadows`, `Chunk`, `coords`, `blocks.data` stay free of THREE, DOM and `import.meta`, and `shadows.ts`/`mesher.ts` never value-import `world.ts` (which carries `import.meta.env` from Task 1 and pulls generation/lighting/simplex-noise): `chunkIndexOrNeg` lives in `coords.ts`. Task 5 step 0 verifies this with a TRANSITIVE trace of the built worker chunk, not a one-level grep.
- Commit after every task with explicit paths (`git add <paths>`, never `git add -A`). Trailer on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WkqJrcc2U5KmXWvtU969AW
  ```
- Any dev server runs as `VITE_MINICRAFT_API_URL=http://127.0.0.1:9099 npm run dev -- --port 5174` (the env var on the command line beats `.env.local`, which points at the **production** save API), started with `run_in_background` and polled with `curl`, and stopped **by port only**: `fuser -k 5174/tcp`. Never `pkill` by name. Never edit `.env.local`; never touch `https://noah.leap-forward.ca`.
- Throwaway probe files (`*.probe.test.ts`, scratch scripts) live in the session scratchpad, never in `src/`; `git status` must be clean apart from the task's own files before each commit. `noUnusedLocals` and eslint `no-unused-vars` (error) are on: an unused import or destructured binding fails the exit criterion — the snippets below have been scrubbed, keep them so.
- **Never `git stash`.** Before/after micro-benchmarks run in a `git archive HEAD` scratch copy under the session scratchpad with `node_modules` and `api/node_modules` symlinked in (that is how every gate reviewer did it).
- `public/atlas.json` is gitignored and generated by `prebuild`: run `npm run build-atlas` in every worktree before running tests. The atlas-reading tests (Tasks 5, 8) throw a clear `Error('public/atlas.json missing: run npm run build-atlas')` when it is absent — they never skip.
- Task 1's `ensureChunk` RangeError guard is LIVE under vitest (`import.meta.env` is an object with `DEV === true` in vitest 4, verified) — it is an assertion the suite runs, not dead code; do not delete it when a later test trips it, fix the caller.

## Dependency table

| Task | Depends on | Can run in parallel with |
|---|---|---|
| 1 A: numeric chunk index + bench baseline | — | 7, 8 (scaffold) |
| 2 C: shadow early-out + load-order independence + `sunlitHash` | 1 | 7, 8 (scaffold) |
| 3 G: no-allocation mesher (golden recorded first) | 1 only (`shadows.brute.ts` and the indexed World both come from Task 1; the golden is recorded BEFORE Task 2/3 code — see Task 3 step 0) | 2, 7, 8a |
| 4 B: scheduler + loop wiring + `MESH_RADIUS` ring + edit lane | 2, 3 | 7 |
| 5 D: worker for shadows + mesh | 4 | 7 |
| 6 E: eviction, fog, `hasLiquid`, re-entry fixture | 5 | 7 |
| 7 F: F3 overlay | 1 (reads `loop.stats`, which Task 4 fills — the overlay renders zeros until then) | 2–6 |
| 8 Bench: Playwright + `scripts/perf-bench.ts`; final run | 8a (scaffold + baseline of the still/walk/fly/load phases): 1 — Task 1's `stats` stub provides `streamQueue`; the edit and memory phases need `lastEditMs` (Task 4) and `mounted`/`data` (Task 6) and are recorded only at 8b; 8b (final run, exit criterion): 6, 7 | 8a with 2–6 |
| 9 Docs | 8 | — |

Tasks 1–6 are sequential on `loop.ts` / `world.ts` / `shadows.ts` / `mesher.ts` (Task 3 may run in a worktree in parallel with Task 2: it touches only `mesher.ts` and its golden test). Task 7 touches only `src/ui/perf-overlay.ts`, `src/ui/ui.css`, `src/main.ts` (one handler) and `src/game/loop.ts` (one `stats` field it shares with Task 4 — Task 4 defines the field, Task 7 only reads it; if Task 7 lands first it defines the field and Task 4 fills it). Task 8's scaffold (devDependency, script skeleton, the **baseline run** recorded into the spec) runs right after Task 1 in a worktree; its final run is the exit criterion after Task 7.

**Execution note.** Every task's exit criterion is the FULL `npm test` + `npx tsc --noEmit` + `npm run lint`, so two tasks cannot share a working tree. Parallel tasks run in separate `git worktree`s on their own branches (`task/perf-N`, cut from `perf` at the point their dependencies have merged). A merge step (parent) merges each branch into `perf` in dependency order and re-runs the three commands after every merge. Worktrees have been cut from a stale commit before: `git reset --hard perf` on the fresh branch first, then `npm run build-atlas` (atlas.json is gitignored). Root `package-lock.json` is out of sync with `package.json` (`npm ci` fails on `@emnapi/*`): symlink the main checkout's `node_modules` **and** `api/node_modules` into a worktree instead of installing; never touch the lock file. Task 8 adds `playwright` to `devDependencies` — run `npm install playwright` (not `ci`) in the main checkout and `npx playwright install chromium` once; worktrees inherit through the symlink. `vitest.config.ts` already caps `maxWorkers: 2`.

## Shared definitions (repeated where used)

```ts
// src/engine/world/coords.ts (Task 1)
export function chunkIndex(cx: number, cz: number): number;          // cx * WORLD_CHUNKS_Z + cz; NO bounds check (callers check)
export function chunkIndexOrNeg(cx: number, cz: number): number;     // -1 when out of the world (pure; lives in coords so shadows.ts/mesher.ts never import world.ts)
// src/engine/world/world.ts (Task 1)
class World { getChunk(cx, cz): Chunk | undefined /* bounds-checked */; getChunkByIndex(i): Chunk | undefined; dropChunk(cx, cz): boolean; get chunkCount(): number; }
// src/engine/world/shadows.brute.ts (Task 1): export function computeChunkShadowsBrute(world, chunk): void  // verbatim copy of today's caster; tests only

// src/engine/world/chunk.ts (Task 2 adds sunlitHash, Task 5 adds rev + Chunk.over, Task 6 adds hasLiquid)
class Chunk { rev = 0; sunlitHash = 0; hasLiquid = false; static over(cx, cz, height, blocks: Uint16Array, lights: Uint16Array, sunlit: Uint8Array): Chunk /* no allocation */ }

// src/engine/world/shadows.ts (Task 2)
export function computeChunkShadows(world: World, chunk: Chunk): void;   // same signature; requires the 3×3 present (world edge excepted)
export function hashSunlit(sunlit: Uint8Array): number;                  // FNV-1a over bytes
export const SHADOW_STATS: { rays: number };                              // test-only counter, reset by tests
export function ensureShadowNeighbourhood(world: World, chunk: Chunk): void;

// src/engine/world/radii.ts (Task 4) — the ONLY definition site
export const MESH_RADIUS = 5, UNMOUNT_RADIUS = 6, DATA_RADIUS = 7;

// src/game/chunk-scheduler.ts (Task 4) — re-exports the radii
export const BUDGET_STILL_MS = 30, BUDGET_MOVING_MS = 6;
export function budgetFor(moving: boolean, initialLoad: boolean): number;                 // initialLoad || !moving ? 30 : 6
export function chebyshev(index: number, playerCx: number, playerCz: number): number;
export function orderStream(stream: Iterable<number>, playerCx: number, playerCz: number): number[]; // stable by chebyshev, ties by iteration (insertion) order
export type FrameInput = { editLane: Set<number>; stream: Set<number>; playerCx: number; playerCz: number; moving: boolean; initialLoad: boolean };
export type FrameResult = { edits: number[]; mounts: number[]; elapsedMs: number };
export function planFrame(input: FrameInput, now: () => number, mount: (index: number) => boolean | void): FrameResult;  // mount returns false to signal "worker full: stop this frame" (Task 5)

// src/game/loop.ts fields
//   Task 1: stats = { streamQueue: 0, editQueue: 0, lastEditMs: -1, mounted: 0, data: 0, workerInFlight: 0 }   (stub; filled by Tasks 4/5/6)
//   Task 4: streamSet: Set<number>; editLane: Set<number>; shadowOnly: Set<number>; moving: boolean; initialLoad: boolean; lastPlayerChunk: number; editStartedAt: number
//   Task 5: inFlightIndex: Set<number>; jobs: ChunkJobs | null
//   Task 7: onFrame: ((dt: number, tickMs: number, frameMs: number) => void) | null

// src/engine/world/chunk-jobs.ts (Task 5)
export type WorkerLike = { postMessage(msg: unknown, transfer?: Transferable[]): void; onmessage: ((e: { data: unknown }) => void) | null; terminate(): void };
export type WorkerFactory = () => WorkerLike;
export type ChunkJob = { id: number; cx: number; cz: number; chunk: Chunk; rev: number };
export class ChunkJobs { constructor(factory: WorkerFactory, uvTable: Float32Array, maxInFlight = 2); post(world: World, chunk: Chunk): boolean; onReply: (job: ChunkJob, sunlit: Uint8Array, mesh: ChunkMeshResult) => void; onDropped: (job: ChunkJob) => void; inFlight(): number; }
// src/engine/world/chunk-jobs.test-utils.ts (Task 5, TEST ONLY — never imported by chunk-jobs.ts): export function inlineWorkerFactory(): WorkerFactory
// src/engine/render/uv-table.ts (Task 5): export function buildUvTable(atlas: AtlasJson): Float32Array; export function uvFromTable(table: Float32Array): UvFn
```

---

### Task 1: A — numeric chunk index with a bounds check; numeric sets in the loop

Implements spec §3.A. Tests: §6.1 (hashes unchanged), the edge test (mutant: drop the bounds check → (1,−1) returns (0,31)), an informational micro-benchmark.

**Files:**
- Modify: `src/engine/world/world.ts` (the `chunks` map → flat array; `getChunk`, `ensureChunk`, `allChunks`, `modifiedChunks`, `neighbors`, new `chunkIndex`, `getChunkByIndex`, `dropChunk`)
- Modify: `src/engine/world/coords.ts` (`chunkIndex`, `chunkIndexOrNeg` — pure, no world import)
- Modify: `src/game/loop.ts:38-39, 77-79, 306-355` (`dirtyChunks`/`mountedChunks` → `Set<number>`; `markChunkDirty` keys by index; `loadNearbyChunks`/`flushDirtyChunks` iterate indices; add the `stats` stub)
- Create: `src/engine/world/shadows.brute.ts` (verbatim copy of today's `computeChunkShadows` + helpers as `computeChunkShadowsBrute`; test-only reference — Tasks 2 and 3 both need it, so it lands here)
- Create: `src/engine/world/world-index.test.ts`
- Test: `src/engine/world/generation.test.ts` (unchanged, must stay green)

**Interfaces:**
- Produces: `chunkIndex(cx, cz)`, `chunkIndexOrNeg(cx, cz)` (in `coords.ts`), `World.getChunkByIndex(i)`, `World.dropChunk(cx, cz): boolean` (removes from the array; returns whether it existed — Task 6 uses it), `World.chunkCount`, `World.getChunk` bounds-checked, `computeChunkShadowsBrute` (`shadows.brute.ts`), `GameLoop.stats` stub `{ streamQueue: 0, editQueue: 0, lastEditMs: -1, mounted: 0, data: 0, workerInFlight: 0 }` (Task 8a's `newWorld()` waits on `streamQueue === 0`; Task 1 keeps it equal to `dirtyChunks.size`).
- Consumes: `WORLD_CHUNKS_X/Z` from `coords.ts`.

- [ ] **Step 1: Write the failing edge test**

```ts
// src/engine/world/world-index.test.ts
import { describe, it, expect } from 'vitest';
import { World } from './world';
import { Chunk } from './chunk';
import { chunkIndex, chunkIndexOrNeg, WORLD_CHUNKS_Z } from './coords';

/** Test-local string-keyed reference: the semantics `getChunk` had before this task. */
class StringKeyedRef {
	private m = new Map<string, Chunk>();
	put(c: Chunk) { this.m.set(`${c.cx},${c.cz}`, c); }
	get(cx: number, cz: number) { return this.m.get(`${cx},${cz}`); }
}

describe('World chunk index (spec §3.A)', () => {
	it('chunkIndex is exactly cx * WORLD_CHUNKS_Z + cz', () => {
		expect(chunkIndex(0, 0)).toBe(0);
		expect(chunkIndex(1, 0)).toBe(WORLD_CHUNKS_Z);
		expect(chunkIndex(31, 31)).toBe(31 * WORLD_CHUNKS_Z + 31);
		expect(chunkIndexOrNeg(-1, 0)).toBe(-1);
		expect(chunkIndexOrNeg(0, WORLD_CHUNKS_Z)).toBe(-1);
	});

	it('edge chunks and out-of-range inputs agree with a string-keyed reference (mutant: drop the bounds check → (1,-1) aliases (0,31))', () => {
		const w = new World(7, { height: 64 });
		const ref = new StringKeyedRef();
		for (const [cx, cz] of [[0, 0], [0, 31], [31, 0], [31, 31], [1, 0], [0, 1], [5, 0], [4, 31]] as [number, number][]) {
			ref.put(w.ensureChunk(cx, cz));
		}
		const probes: [number, number][] = [];
		for (const cx of [-1, 0, 1, 4, 5, 31, 32]) for (const cz of [-1, 0, 1, 31, 32, 33]) probes.push([cx, cz]);
		for (const [cx, cz] of probes) {
			expect(w.getChunk(cx, cz), `getChunk(${cx},${cz})`).toBe(ref.get(cx, cz));
		}
		// The two aliasing cases the spec names, stated explicitly.
		expect(w.getChunk(1, -1)).toBeUndefined();
		expect(w.getChunk(0, 33)).toBeUndefined();
	});

	it('iteration and modifiedChunks see exactly the ensured chunks', () => {
		const w = new World(7, { height: 64 });
		w.ensureChunk(3, 4); w.ensureChunk(0, 31);
		w.getChunk(0, 31)!.modified = true;
		expect([...w.allChunks()].map((c) => `${c.cx},${c.cz}`).sort()).toEqual(['0,31', '3,4']);
		expect(w.modifiedChunks().map((c) => `${c.cx},${c.cz}`)).toEqual(['0,31']);
		expect(w.dropChunk(3, 4)).toBe(true);
		expect(w.dropChunk(3, 4)).toBe(false);
		expect(w.getChunk(3, 4)).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/engine/world/world-index.test.ts`
Expected: FAIL — `chunkIndex` / `chunkIndexOrNeg` / `dropChunk` are not exported.

- [ ] **Step 3: Implement the index in `world.ts`**

Add to `coords.ts` (pure — `shadows.ts`, `mesher.ts` and the worker may import it; `world.ts` may not be imported by them):

```ts
/** Flat index; NO bounds check — callers that may be out of range use chunkIndexOrNeg. */
export function chunkIndex(cx: number, cz: number): number {
	return cx * WORLD_CHUNKS_Z + cz;
}
/** -1 when (cx, cz) is outside the world. An unguarded cx*32+cz aliases (1,-1) onto (0,31). */
export function chunkIndexOrNeg(cx: number, cz: number): number {
	if (cx < 0 || cx >= WORLD_CHUNKS_X || cz < 0 || cz >= WORLD_CHUNKS_Z) return -1;
	return cx * WORLD_CHUNKS_Z + cz;
}
```

Replace the `key` helper and the `Map` in `world.ts` with:

```ts
import { WORLD_CHUNKS_X, WORLD_CHUNKS_Z, LEGACY_HEIGHT, inBounds, worldToChunk, indexOf, chunkIndexOrNeg, type WorldHeight } from './coords';

export class World {
	// ...seed/height/genVersion/saveVersion unchanged
	private chunks: (Chunk | undefined)[] = new Array(WORLD_CHUNKS_X * WORLD_CHUNKS_Z);
	private count = 0;

	getChunk(cx: number, cz: number): Chunk | undefined {
		if (cx < 0 || cx >= WORLD_CHUNKS_X || cz < 0 || cz >= WORLD_CHUNKS_Z) return undefined;
		return this.chunks[cx * WORLD_CHUNKS_Z + cz];
	}
	getChunkByIndex(i: number): Chunk | undefined {
		return i < 0 || i >= this.chunks.length ? undefined : this.chunks[i];
	}
	ensureChunk(cx: number, cz: number): Chunk {
		const i = cx * WORLD_CHUNKS_Z + cz;
		let c = this.chunks[i];
		if (!c) {
			c = new Chunk(cx, cz, this.height);
			generateChunk(c, this.seed, this.genVersion);
			this.chunks[i] = c;
			this.count++;
			fillChunkLights(this, c);
		}
		return c;
	}
	/** Task 6 eviction. Returns false when nothing was there. */
	dropChunk(cx: number, cz: number): boolean {
		const i = chunkIndexOrNeg(cx, cz);
		if (i < 0 || !this.chunks[i]) return false;
		this.chunks[i] = undefined;
		this.count--;
		return true;
	}
	get chunkCount(): number { return this.count; }
	*allChunks(): Iterable<Chunk> {
		for (const c of this.chunks) if (c) yield c;
	}
	modifiedChunks(): Chunk[] {
		const out: Chunk[] = [];
		for (const c of this.chunks) if (c && c.modified) out.push(c);
		return out;
	}
	// getBlock/setBlock/setBlockFlow/markLiquidFrontier/neighbors/chunkInWorld/inBounds: unchanged bodies.
}
```

`ensureChunk` keeps the unchecked index on purpose: every caller already passes `chunkInWorld`; add `if (import.meta.env?.DEV && (cx < 0 || cx >= WORLD_CHUNKS_X || cz < 0 || cz >= WORLD_CHUNKS_Z)) throw new RangeError(...)`. Under vitest 4 `import.meta.env` is an object with `DEV === true` (verified at gate 2), so this guard is LIVE in the whole suite — `w.ensureChunk(-1, 0)` throws in tests. That is intended: it is an assertion, not dead code.

Then copy today's `computeChunkShadows` + `rayHitsSolidInLoadedChunks` + `neighbourhoodMaxOpaqueY` verbatim into `src/engine/world/shadows.brute.ts` as `export function computeChunkShadowsBrute(world: World, chunk: Chunk): void` (private helpers renamed; header comment "Reference implementation for the equivalence tests. Never called by the game."). No test uses it yet in this task; Tasks 2 and 3 import it.

- [ ] **Step 4: Loop sets become numeric**

In `src/game/loop.ts`:

```ts
import { chunkIndexOrNeg, WORLD_CHUNKS_Z } from '../engine/world/coords';
// ...
private dirtyChunks = new Set<number>();
private mountedChunks = new Set<number>();
/** Read by the F3 overlay (Task 7) and the bench (Task 8). Stub in this task; Tasks 4/5/6 fill the fields. */
stats = { streamQueue: 0, editQueue: 0, lastEditMs: -1, mounted: 0, data: 0, workerInFlight: 0 };

markChunkDirty(cx: number, cz: number) {
	const i = chunkIndexOrNeg(cx, cz);
	if (i >= 0) this.dirtyChunks.add(i);
}

private loadNearbyChunks() {
	const pcx = Math.floor(this.player.position[0] / 16);
	const pcz = Math.floor(this.player.position[2] / 16);
	for (let dx = -VIEW_RADIUS; dx <= VIEW_RADIUS; dx++) {
		for (let dz = -VIEW_RADIUS; dz <= VIEW_RADIUS; dz++) {
			const i = chunkIndexOrNeg(pcx + dx, pcz + dz);
			if (i < 0 || this.mountedChunks.has(i)) continue;
			this.dirtyChunks.add(i);
		}
	}
}

private flushDirtyChunks() {
	if (this.dirtyChunks.size === 0) return;
	let budget = 2;
	for (const i of this.dirtyChunks) {
		if (budget-- <= 0) break;
		const cx = Math.floor(i / WORLD_CHUNKS_Z), cz = i % WORLD_CHUNKS_Z;
		const c = this.world.ensureChunk(cx, cz);
		// ...liquid frontier scan, shadows, neighbours, mesh, mount: unchanged...
		this.mountedChunks.add(i);
		this.dirtyChunks.delete(i);
	}
	this.stats.streamQueue = this.dirtyChunks.size; this.stats.mounted = this.mountedChunks.size;
}
```

(`WORLD_CHUNKS_Z` and `chunkIndexOrNeg` imported from `coords`.) The `chunkInWorld` check inside the loop is now redundant because indices are only ever created through `chunkIndexOrNeg`; remove it.

- [ ] **Step 5: Run the suite, hashes, typecheck, lint**

Run: `npx vitest run src/engine/world/world-index.test.ts && npm test && npx tsc --noEmit && npm run lint`
Expected: all green; `generation.test.ts` reports the three hash tests passing unchanged.

- [ ] **Step 6: Informational micro-benchmark (not committed as a CI test)**

In the scratchpad, `tsx` a script that builds seed 3's 81 chunks (`World.create(3)`, `spawnV3(3)`, ensure the 9×9 + neighbours, `computeChunkShadows` + `fillChunkLights` on each) and prints ms/chunk for shadows and lights, run once against a `git archive HEAD` scratch copy of the base commit (node_modules symlinked; never `git stash`) and once against the working tree. Record both lines in the commit body. Expected order of magnitude: shadows 16 → ~11 ms, lights 9.7 → ~5 ms (spec §2).

- [ ] **Step 7: Commit**

```bash
git add src/engine/world/coords.ts src/engine/world/world.ts src/engine/world/shadows.brute.ts src/engine/world/world-index.test.ts src/game/loop.ts
git commit -m "perf(world): flat bounds-checked chunk index; numeric dirty/mounted sets; stats stub; brute shadow reference

<before/after micro-benchmark lines>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WkqJrcc2U5KmXWvtU969AW"
```

---

### Task 2: C — shadow ray early-out, in-chunk DDA, load-order independence, `sunlitHash`

Implements spec §3.C and the `sunlitHash` of §3.E (the hash lives with the shadow computation; the compare that uses it is Task 4/6). Tests: §6.1 shadow equivalence (byte-identical, plus the ray counter falling to ≤ 2 % of candidates — mutant: drop the per-start-column early-out → 11.7 %, measured); **stream-equivalence** (red at HEAD by 5 CHUNKS on the 7×7 fixture — the spec's 632 is voxels; mutant: shadow a chunk without ensuring its 3×3). The eviction / re-entry fixture needs `dropChunk` plus the re-dirty on drop and is written in **Task 6**, where the drop happens. The three big fixture tests each take 6–7 s in Node: they carry explicit `30_000` timeouts (vitest default 5 s) and add ≈ 14 s to `npm test` — accepted.

**Files:**
- Modify: `src/engine/world/shadows.ts` (rewrite `computeChunkShadows`; keep `maxOpaqueY` exported for its existing test; add `hashSunlit`, `SHADOW_STATS`, `ensureShadowNeighbourhood`)
- Modify: `src/engine/world/chunk.ts` (add `sunlitHash = 0`)
- Modify: `src/game/loop.ts:345-349` (call `ensureShadowNeighbourhood` before shadowing; re-dirty shadows of the 3×3 when a chunk is first generated)
- Modify: `src/engine/world/shadows.test.ts` (add the equivalence + counter + stream tests; existing tests unchanged)
- Consumes (created in Task 1): `src/engine/world/shadows.brute.ts` (`computeChunkShadowsBrute`)

**Interfaces:**
- Produces: `computeChunkShadows(world, chunk)` (same signature, requires the 3×3 present except at the world edge), `hashSunlit(sunlit)`, `SHADOW_STATS.rays`, `ensureShadowNeighbourhood(world, chunk): void` (ensures the 8 neighbours that are inside the world), `Chunk.sunlitHash`.
- Consumes: `World.getChunk` bounds-checked (Task 1).

- [ ] **Step 0: The brute-force reference already exists** (`shadows.brute.ts`, Task 1). Confirm `git log --oneline -1 -- src/engine/world/shadows.brute.ts` shows Task 1's commit before starting.

- [ ] **Step 1: Write the failing tests**

Append to `src/engine/world/shadows.test.ts`:

```ts
import { computeChunkShadowsBrute } from './shadows.brute';
import { hashSunlit, SHADOW_STATS, ensureShadowNeighbourhood } from './shadows';
import { spawnV3 } from './v3/spawn';
import type { Chunk } from './chunk';

function fnv8(a: Uint8Array): number { let h = 2166136261 >>> 0; for (let i = 0; i < a.length; i++) { h ^= a[i]; h = Math.imul(h, 16777619) >>> 0; } return h; }

/** Fully-loaded reference: every chunk of the (radius+1) square exists before any shadow is cast. */
function fullyLoaded(seed: number, radius: number) {
	const w = World.create(seed);
	const s = spawnV3(seed);
	const pcx = Math.floor(s.x / 16), pcz = Math.floor(s.z / 16);
	const order: [number, number][] = [];
	for (let dx = -radius - 1; dx <= radius + 1; dx++) for (let dz = -radius - 1; dz <= radius + 1; dz++) {
		const cx = pcx + dx, cz = pcz + dz;
		if (w.chunkInWorld(cx, cz)) { w.ensureChunk(cx, cz); if (Math.max(Math.abs(dx), Math.abs(dz)) <= radius) order.push([cx, cz]); }
	}
	return { w, pcx, pcz, order };
}

describe('computeChunkShadows — §3.C early-out and in-chunk walk', () => {
	it('is byte-identical to the brute-force caster on a fully-loaded 3×3 (v2 fixtures + v3 seeds 1–3)', { timeout: 30_000 }, () => {
		for (const seed of [1, 2, 3]) {
			const { w, order } = fullyLoaded(seed, 2);
			for (const [cx, cz] of order) {
				const c = w.getChunk(cx, cz)!;
				computeChunkShadowsBrute(w, c); const ref = fnv8(c.sunlit);
				c.shadowsDirty = true; computeChunkShadows(w, c);
				expect(fnv8(c.sunlit), `seed ${seed} chunk ${cx},${cz}`).toBe(ref);
			}
		}
	});

	it('casts at most 2 % of the candidate rays (measured 0.72 %; mutant: drop the per-start-column early-out → 11.7 %)', { timeout: 30_000 }, () => {
		const { w, order } = fullyLoaded(3, 1);
		let candidates = 0;
		for (const [cx, cz] of order) {
			const c = w.getChunk(cx, cz)!;
			for (let i = 0; i < c.blocks.length; i++) { const d = BLOCKS[c.blocks[i]]; const opaque = !!d && d.lightFilter >= 15 && d.liquid === 'none'; if (!opaque && ((c.lights[i] >> 12) & 0xf) !== 0) candidates++; }
		}
		SHADOW_STATS.rays = 0;
		for (const [cx, cz] of order) { const c = w.getChunk(cx, cz)!; c.shadowsDirty = true; computeChunkShadows(w, c); }
		expect(SHADOW_STATS.rays).toBeLessThan(candidates * 0.02);
	});

	it('hashSunlit is FNV-1a over the bytes and changes when one voxel flips', () => {
		const a = new Uint8Array(16).fill(1); const h = hashSunlit(a); a[7] = 0;
		expect(hashSunlit(a)).not.toBe(h);
		expect(hashSunlit(new Uint8Array(0))).toBe(2166136261);
	});
});

describe('shadows are independent of load order (spec §3.C.1; red at HEAD: 5 of 49 chunks differ on this fixture)', () => {
	it('a simulated nearest-first stream of seed 3 ends with the same sunlit as the fully-loaded reference (mutant: shadow without ensuring the 3×3)', { timeout: 30_000 }, () => {
		const ref = fullyLoaded(3, 3);
		const refHash = new Map<string, number>();
		for (const [cx, cz] of ref.order) { const c = ref.w.getChunk(cx, cz)!; computeChunkShadowsBrute(ref.w, c); refHash.set(`${cx},${cz}`, fnv8(c.sunlit)); }

		const w = World.create(3);
		const { pcx, pcz } = ref;
		// nearest-first stream, exactly what the scheduler will do: ensure the chunk, ensure its 3×3, shadow, and re-dirty the 3×3 neighbours already shadowed.
		const stream = [...ref.order].sort((a, b) => Math.max(Math.abs(a[0] - pcx), Math.abs(a[1] - pcz)) - Math.max(Math.abs(b[0] - pcx), Math.abs(b[1] - pcz)));
		const shadowed: Chunk[] = [];
		for (const [cx, cz] of stream) {
			const c = w.ensureChunk(cx, cz);
			ensureShadowNeighbourhood(w, c);
			computeChunkShadows(w, c);
			shadowed.push(c);
			// any already-shadowed chunk whose 3×3 just gained a member is stale: the loop re-dirties it
			for (const s of shadowed) if (s !== c && Math.abs(s.cx - cx) <= 1 && Math.abs(s.cz - cz) <= 1) s.shadowsDirty = true;
			for (const s of shadowed) if (s.shadowsDirty) computeChunkShadows(w, s);
		}
		let diff = 0;
		for (const [cx, cz] of ref.order) if (fnv8(w.getChunk(cx, cz)!.sunlit) !== refHash.get(`${cx},${cz}`)) diff++;
		expect(diff).toBe(0);
	});
});
```

- [ ] **Step 2: Run to verify red**

Run: `npx vitest run src/engine/world/shadows.test.ts`
Expected: FAIL — `hashSunlit`/`SHADOW_STATS`/`ensureShadowNeighbourhood` not exported; once stubbed, the stream test fails with `diff > 0` and the counter test with rays ≈ candidates.

- [ ] **Step 3: Implement (port of the gate-1 `probe-dda.ts`, variant 2)**

Replace `computeChunkShadows` in `shadows.ts`:

```ts
// NOTE: no import from './world' — shadows.ts must stay free of world.ts (import.meta, generation, lighting) for the worker bundle.
export const SHADOW_STATS = { rays: 0 };

const OPAQUE = new Uint8Array(BLOCKS.length);
for (const b of BLOCKS) OPAQUE[b.id] = b.lightFilter >= 15 && b.liquid === 'none' ? 1 : 0;

/** Relative voxel path of the sun ray from any voxel centre: one constant table (51 steps, spans −14 x, −9 z, +28 y). */
const PATH: Int8Array[] = (() => {
	const len = Math.hypot(...SUN_DIR_RAW);
	const dx = SUN_DIR_RAW[0] / len, dy = SUN_DIR_RAW[1] / len, dz = SUN_DIR_RAW[2] / len;
	let ix = 0, iy = 0, iz = 0;
	const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
	const tdx = Math.abs(1 / dx), tdy = Math.abs(1 / dy), tdz = Math.abs(1 / dz);
	let tmx = (sx > 0 ? 1 - 0.5 : 0.5) * tdx, tmy = 0.5 * tdy, tmz = (sz > 0 ? 1 - 0.5 : 0.5) * tdz;
	const out: Int8Array[] = []; let t = 0;
	while (t < MAX_SHADOW_DIST) {
		if (tmx < tmy && tmx < tmz) { ix += sx; t = tmx; tmx += tdx; }
		else if (tmy < tmz) { iy += 1; t = tmy; tmy += tdy; }
		else { iz += sz; t = tmz; tmz += tdz; }
		out.push(Int8Array.of(ix, iy, iz));
	}
	return out;
})();

export function hashSunlit(sunlit: Uint8Array): number {
	let h = 2166136261 >>> 0;
	for (let i = 0; i < sunlit.length; i++) { h ^= sunlit[i]; h = Math.imul(h, 16777619) >>> 0; }
	return h;
}

/** §3.C.1 precondition: the 8 neighbours inside the world exist (generated + lit) before a chunk is shadowed. */
export function ensureShadowNeighbourhood(world: World, chunk: Chunk): void {
	for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
		if (dx === 0 && dz === 0) continue;
		if (world.chunkInWorld(chunk.cx + dx, chunk.cz + dz)) world.ensureChunk(chunk.cx + dx, chunk.cz + dz);
	}
}

function colMaxInto(c: Chunk, out: Int16Array, gx0: number, gz0: number): void {
	const b = c.blocks;
	for (let z = 0; z < CHUNK_SIZE_Z; z++) for (let x = 0; x < CHUNK_SIZE_X; x++) {
		let m = -1;
		for (let y = c.height - 1; y >= 0; y--) if (OPAQUE[b[indexOf(x, y, z)]]) { m = y; break; }
		out[(gz0 + z) * 48 + gx0 + x] = m;
	}
}

const COL = new Int16Array(48 * 48);
const START_MAX = new Int16Array(256);

export function computeChunkShadows(world: World, chunk: Chunk): void {
	const H = chunk.height;
	const grid: (Chunk | undefined)[] = new Array(9);
	for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) grid[(dx + 1) * 3 + dz + 1] = world.getChunk(chunk.cx + dx, chunk.cz + dz);
	COL.fill(-1);
	let skyFrom = 0;
	for (let i = 0; i < 9; i++) { const c = grid[i]; if (!c) continue; colMaxInto(c, COL, Math.floor(i / 3) * 16, (i % 3) * 16); }
	for (let i = 0; i < COL.length; i++) if (COL[i] + 1 > skyFrom) skyFrom = COL[i] + 1;
	for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
		let m = -1;
		for (let k = 0; k < PATH.length; k++) {
			const p = PATH[k]; const gx = 16 + x + p[0], gz = 16 + z + p[2];
			if (gx < 0 || gx >= 48 || gz < 0 || gz >= 48) break;
			const v = COL[gz * 48 + gx] - p[1]; if (v > m) m = v;
		}
		START_MAX[z * 16 + x] = m;
	}
	const sunlit = chunk.sunlit, blocks = chunk.blocks, lights = chunk.lights;
	for (let y = 0; y < H; y++) for (let z = 0; z < CHUNK_SIZE_Z; z++) for (let x = 0; x < CHUNK_SIZE_X; x++) {
		const idx = indexOf(x, y, z);
		if (OPAQUE[blocks[idx]]) { sunlit[idx] = 0; continue; }
		if (((lights[idx] >> 12) & 0xf) === 0) { sunlit[idx] = 0; continue; }
		if (y >= skyFrom || y > START_MAX[z * 16 + x]) { sunlit[idx] = 1; continue; }
		SHADOW_STATS.rays++;
		let hit = 0;
		for (let k = 0; k < PATH.length; k++) {
			const p = PATH[k]; const wy = y + p[1]; if (wy >= H) break;
			const gx = x + p[0], gz = z + p[2];
			const c = grid[((gx >> 4) + 1) * 3 + (gz >> 4) + 1];
			if (!c) break; // world edge only (precondition) → sunlit
			if (OPAQUE[c.blocks[indexOf(gx & 15, wy, gz & 15)]]) { hit = 1; break; }
		}
		sunlit[idx] = hit ? 0 : 1;
	}
	chunk.shadowsDirty = false;
	chunk.sunlitHash = hashSunlit(sunlit);
}
```

`maxOpaqueY` stays exported (its own test). `chunk.ts` gains `sunlitHash = 0;`.

- [ ] **Step 4: Loop precondition and arrival re-dirty**

In `loop.ts` `flushDirtyChunks`, before `if (c.shadowsDirty) computeChunkShadows(...)`:

```ts
ensureShadowNeighbourhood(this.world, c);
```

and in **`loop.ts`** (NOT in `World.ensureChunk` — `world.neighbors()` calls `ensureChunk` from inside `mountIndex`'s own neighbour loop and would re-dirty mid-mount), right after `mountIndex` ensures a chunk that did not exist before (`const existed = !!this.world.getChunk(cx, cz); const c = this.world.ensureChunk(cx, cz); if (!existed) { ... }`), mark the 3×3 neighbours' shadows dirty (spec §3.C.1 — dead for pure streaming because the precondition already ensures the 3×3, live for edits/re-entry):

```ts
for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const n = this.world.getChunk(cx + dx, cz + dz); if (n && n !== c) { n.shadowsDirty = true; /* Task 5 adds: n.rev++ — safe: a posted chunk's 3×3 already exists so an arrival can never hit an in-flight job (spec §3.D parity note) */ } }
```

The same hook is also called from `ensureShadowNeighbourhood`'s caller for every neighbour that was newly created by it. (`ensureShadowNeighbourhood` is imported from `shadows.ts`, which imports `World` as a type only — no cycle at runtime.)

- [ ] **Step 5: Run everything**

Run: `npx vitest run src/engine/world/shadows.test.ts && npm test && npx tsc --noEmit && npm run lint`
Expected: green; the equivalence test covers seeds 1–3; the stream test passes with `diff 0`. Record the counter ratio in the commit body.

- [ ] **Step 6: Commit**

```bash
git add src/engine/world/shadows.ts src/engine/world/shadows.test.ts src/engine/world/chunk.ts src/game/loop.ts
git commit -m "perf(shadows): constant-path DDA with per-column early-out; load-order independent; sunlitHash

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WkqJrcc2U5KmXWvtU969AW"
```

---

### Task 3: G — no-allocation mesher behind a byte golden

Implements spec §3.G. Test: §6.1 mesh golden (mutant: emit one face in a different order → red). **This task carries the plan's one hash bootstrap**: the golden is recorded from the mesher as it is at the `perf` base commit, BEFORE Task 2 or Task 3 code (Task 2 does not change mesh output, but the fixture pins `sunlit` from the brute caster to remove any doubt).

**Files:**
- Create: `src/engine/world/mesher.golden.test.ts`
- Modify: `src/engine/world/mesher.ts` (rewrite `buildSolidMesh`, `buildLiquidMesh`, `sampleCornerLight`, `aoFactorForCorner`, `sampleCornerShadow`, `readLight` without per-corner allocation)

**Interfaces:**
- Produces: `meshChunk(chunk, neighbors, uvFor)` unchanged signature and output.
- Consumes: `computeChunkShadowsBrute` (`shadows.brute.ts`, Task 1) for fixture pinning; depends on Task 1 only.

- [ ] **Step 0: Record the golden at the base commit (bootstrap procedure)**

1. Do not `git stash`. The mesher is unchanged since the perf base commit, so simply run this step before touching `mesher.ts` (if Task 2 has already merged, that is fine: Task 2 does not change mesh output, and the fixture pins `sunlit` from the brute caster anyway).
2. Write the test file with `EXPECTED: Record<string, number> = {}` (empty) and a recording branch:

```ts
// src/engine/world/mesher.golden.test.ts
import { describe, it, expect } from 'vitest';
import { World } from './world';
import { meshChunk, type ChunkMesh } from './mesher';
import { computeChunkShadowsBrute } from './shadows.brute';
import { spawnV3 } from './v3/spawn';
import { BLOCK_BY_NAME } from '../../data/blocks.data';
import { indexOf } from './coords';

const uvFor = (id: number, face: string) => { const fi = { px: 0, nx: 1, py: 2, ny: 3, pz: 4, nz: 5 }[face as 'px']; const t = (id * 6 + fi) % 4096; const u = (t % 64) / 64, v = Math.floor(t / 64) / 64; return [u, v, u + 1 / 64, v + 1 / 64] as [number, number, number, number]; };

function fnvBytes(a: ArrayBufferView): number { const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); let h = 2166136261 >>> 0; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619) >>> 0; } return h; }
function hashMesh(m: ChunkMesh | null): number[] { return m ? [fnvBytes(m.positions), fnvBytes(m.normals), fnvBytes(m.uvs), fnvBytes(m.colors), fnvBytes(m.indices)] : [0, 0, 0, 0, 0]; }

/** Pinned construction (spec §6.1): ensure the 5×5 around each fixture chunk, brute-shadow every chunk, then mesh. */
function fixture() {
	const w = World.create(3); const s = spawnV3(3);
	const pcx = Math.floor(s.x / 16), pcz = Math.floor(s.z / 16);
	const picks: [number, number][] = [[pcx, pcz], [pcx + 2, pcz - 1], [pcx - 1, pcz + 3]];
	for (const [cx, cz] of picks) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (w.chunkInWorld(cx + dx, cz + dz)) w.ensureChunk(cx + dx, cz + dz);
	// A fourth pick with a translucent block so the translucent pass is byte-gated too (gate 2: the three natural picks hash translucent to [0,0,0,0,0]).
	const g = w.getChunk(pcx, pcz)!; const glass = BLOCK_BY_NAME['white_stained_glass'].id;
	for (let x = 4; x < 8; x++) for (let z = 4; z < 8; z++) for (let y = 130; y < 133; y++) g.blocks[indexOf(x, y, z)] = glass;
	for (const c of w.allChunks()) computeChunkShadowsBrute(w, c);
	return { w, picks };
}

// Recorded ONCE at the perf base commit (step 0); never re-recorded. Empty until then.
const EXPECTED: Record<string, number[]> = {};

describe('meshChunk byte golden (spec §6.1)', () => {
	it('three v3 chunks of seed 3 (one with stained glass) hash to the recorded bytes (mutant: any vertex, colour or index change → red)', { timeout: 30_000 }, () => {
		const { w, picks } = fixture();
		const got: Record<string, number[]> = {};
		for (const [cx, cz] of picks) {
			const c = w.getChunk(cx, cz)!; const r = meshChunk(c, w.neighbors(c), uvFor);
			got[`${cx},${cz}`] = [...hashMesh(r.opaque), ...hashMesh(r.liquid), ...hashMesh(r.translucent)];
		}
		if (Object.keys(EXPECTED).length === 0) { console.log('GOLDEN', JSON.stringify(got)); throw new Error('golden not recorded: paste the GOLDEN line into EXPECTED'); }
		expect(got).toEqual(EXPECTED);
	});
});
```

3. Run `npx vitest run src/engine/world/mesher.golden.test.ts` — it throws and prints `GOLDEN {...}`. Paste that object into `EXPECTED`. Run again → green, and a third time → identical (deterministic; verified at gate 2). Check the `pcx,pcz` entry's translucent hashes are non-zero. Commit **only the test file** now: `git add src/engine/world/mesher.golden.test.ts && git commit -m "test(mesher): byte golden recorded at the perf base commit (never re-record)" ...trailers`.
4. Do NOT re-record after this point. If the golden ever goes red, the mesher output changed — that is the finding.

- [ ] **Step 1: The golden IS the failing test for the refactor**

There is no separate red step for a pure refactor: the golden must stay green throughout. To prove it CAN go red, before refactoring, temporarily swap two entries of `FACE_ORDER` and run the golden → red; revert. Note the red output in the commit body.

- [ ] **Step 2: Rewrite the mesher without per-corner allocation**

Principles (the shape; the executor writes the full file):
- Module-level scratch: `const OPAQUE = new Uint8Array(BLOCKS.length)` filled once; growable typed buffers `class GrowBuf { f32: Float32Array; len: number; push3(a,b,c) ...; toFloat32(): Float32Array }` for positions/normals/uvs/colors and a `Uint32` one for indices, reset per `buildSolidMesh` call (do not share between opaque/translucent/liquid passes — three instances).
- `readLight` returns nothing: it writes into four module-level numbers (`L_SKY, L_R, L_G, L_B`) or a 4-entry `Float32Array`; `sampleCornerLight` sums into locals; `lightSampleToRGB` takes four numbers and writes into a 3-entry scratch.
- `aoFactorForCorner`: the four outward voxels of a corner are a fixed pattern per normal; precompute for each of the 6 faces the 4 `(dx,dy,dz,kind)` tuples in a `const AO_PATTERN: Int8Array[6]` at module load; iterate without pushing objects.
- `neighborBlock`, `readBlockId`, `readSunlit`: unchanged logic, no allocation already.
- Emission order `y → z → x → FACE_ORDER → corner 0..3` and the index pattern `(v, v+1, v+2, v, v+2, v+3)` untouched.
- Final `new Float32Array(buf.subarray(0, len))` copies are allowed (one per array per mesh).

- [ ] **Step 3: Run the golden, the existing mesher tests, the suite**

Run: `npx vitest run src/engine/world/mesher.golden.test.ts src/engine/world/mesher.test.ts && npm test && npx tsc --noEmit && npm run lint`
Expected: green. Micro-benchmark (scratchpad, informational): `meshChunk` on the 81 chunks of seed 3 before/after; expect ≈ 11 → 4–6 ms. Record in the commit body.

- [ ] **Step 4: Commit**

```bash
git add src/engine/world/mesher.ts
git commit -m "perf(mesher): typed scratch buffers, no per-corner allocation (byte golden unchanged)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WkqJrcc2U5KmXWvtU969AW"
```

---

### Task 4: B — pure chunk scheduler, edit lane, `MESH_RADIUS` ring, `loop.stats`

Implements spec §3.B (and the `sunlitHash` compare on the edit path, §3.E third bullet — the hash exists since Task 2). Tests: §6.2 with every named mutant; the **interior**-edit `sunlitHash` test of §6.4 (mutant: skip the compare → 4 re-meshed). Gate 2 measured why it must be interior: `markChunkDirtyAround` on a chunk CORNER marks 3 chunks (lx=0 and lz=0 both fire), all budget-exempt in the edit lane, and `planFrame` returns early on edits, so one tick after a corner edit mounts exactly 3 with or without the compare — that fixture cannot discriminate. An interior edit marks 1; its 3 SE shadow neighbours go `shadowOnly` to the stream lane and are decided by the compare on the SECOND tick.

**Files:**
- Create: `src/engine/world/radii.ts` (the three constants — engine home, see Global Constraints), `src/game/chunk-scheduler.ts` (re-exports them), `src/game/chunk-scheduler.test.ts`
- Modify: `src/game/loop.ts` (replace `dirtyChunks`/`flushDirtyChunks`/`loadNearbyChunks` with the scheduler; add `streamSet`, `editLane`, `shadowOnly`, `moving`, `initialLoad`, `lastPlayerChunk`, `editStartedAt`; fill the Task 1 `stats` stub; `applyLightUpdate` routes the edited chunk to the edit lane and SE neighbours to the stream set with `shadowOnly = true`)
- Modify: `src/game/loop.test.ts` (existing tests keep passing; add the corner-edit test)

**Interfaces:**
- Produces (`chunk-scheduler.ts`):
  ```ts
  export { MESH_RADIUS, UNMOUNT_RADIUS, DATA_RADIUS } from '../engine/world/radii';   // defined ONCE in radii.ts
  export const BUDGET_STILL_MS = 30, BUDGET_MOVING_MS = 6;
  export function budgetFor(moving: boolean, initialLoad: boolean): number;            // initialLoad || !moving ? 30 : 6
  export function chebyshev(i: number, playerCx: number, playerCz: number): number;   // index → distance
  export function orderStream(stream: Iterable<number>, playerCx: number, playerCz: number): number[]; // stable sort by chebyshev, ties keep iteration (insertion) order
  export type FrameInput = { editLane: Set<number>; stream: Set<number>; playerCx: number; playerCz: number; moving: boolean; initialLoad: boolean };
  export type FrameResult = { edits: number[]; mounts: number[]; elapsedMs: number };
  /** Runs the edit lane fully (budget-exempt), then, only if no edit ran, streams nearest-first while now()-start < budget, min one. `mount(i)` does the work and returns void; the scheduler reads the clock around it so neighbour ensureChunk inside mount() is counted. */
  /** mount() may return false to say "stop streaming this frame" (Task 5's worker-full signal); void/true continue. */
  export function planFrame(input: FrameInput, now: () => number, mount: (index: number) => boolean | void): FrameResult;
  ```
- Produces (`loop.ts`): the Task 1 `stats` stub is now live (`streamQueue`, `editQueue`, `lastEditMs`, `mounted`; `workerInFlight` filled by Task 5, `data` by Task 6), fields `streamSet`, `editLane`, `shadowOnly: Set<number>`, `moving: boolean`, `initialLoad: boolean`, `lastPlayerChunk: number`, `editStartedAt: number`, and `markChunkDirty(cx, cz, opts?: { edit?: boolean; shadowOnly?: boolean })`.
- Consumes: `chunkIndexOrNeg`, `World.chunkCount`, `computeChunkShadows`, `ensureShadowNeighbourhood`, `Chunk.sunlitHash`.

- [ ] **Step 1: Write the failing scheduler tests (each names its mutant)**

```ts
// src/game/chunk-scheduler.test.ts
import { describe, it, expect } from 'vitest';
import { planFrame, orderStream, budgetFor, chebyshev, MESH_RADIUS, UNMOUNT_RADIUS, DATA_RADIUS, type FrameInput } from './chunk-scheduler';
import { chunkIndex } from '../engine/world/coords';

const I = (cx: number, cz: number) => chunkIndex(cx, cz);
function clock(costs: number[]) { let t = 0, k = 0; return { now: () => t, mount: (_i: number) => { t += costs[k++ % costs.length]; } }; }
function input(p: Partial<FrameInput>): FrameInput { return { editLane: new Set(), stream: new Set(), playerCx: 10, playerCz: 10, moving: true, initialLoad: false, ...p }; }

describe('chunk scheduler (spec §6.2)', () => {
	it('radii are the named constants', () => { expect([MESH_RADIUS, UNMOUNT_RADIUS, DATA_RADIUS]).toEqual([5, 6, 7]); });

	it('nearest-first is Chebyshev inside orderStream: (3,3) precedes (4,0) (mutant: Euclidean distance inside orderStream — Cheb 3<4 but Eucl 4.24>4.0 would put (4,0) first)', () => {
		const s = new Set([I(14, 10), I(13, 13)]); // (4,0) inserted first, (3,3) second
		expect(orderStream(s, 10, 10)).toEqual([I(13, 13), I(14, 10)]);
		expect(chebyshev(I(13, 13), 10, 10)).toBe(3);
	});

	it('ties keep insertion order, with same-ring chunks inserted non-lexicographically (mutant: sort by (d, cx, cz))', () => {
		const s = new Set([I(11, 9), I(9, 11), I(11, 11), I(9, 9)]); // all ring 1
		expect(orderStream(s, 10, 10)).toEqual([I(11, 9), I(9, 11), I(11, 11), I(9, 9)]);
	});

	it('budget is honoured across two budgets × two costs and a non-uniform sequence (mutants: ignore the budget; precompute floor(budget/cost))', () => {
		for (const [moving, budget] of [[true, 6], [false, 30]] as [boolean, number][]) {
			for (const cost of [2, 5]) {
				const c = clock([cost]);
				const stream = new Set(Array.from({ length: 40 }, (_, k) => I(10 + (k % 6), 10 + Math.floor(k / 6))));
				const r = planFrame(input({ stream, moving }), c.now, c.mount);
				// mounts while elapsed < budget, checked before each mount: ceil(budget/cost) mounts, never fewer than 1
				expect(r.mounts.length).toBe(Math.max(1, Math.ceil(budget / cost)));
			}
		}
		const c = clock([2, 2, 10, 2]); // 2+2=4 < 6 → third mount runs (10) → 14 ≥ 6 → stop: 3 mounts, not floor(6/2)=3 by luck — so also check the 30 budget: 2,2,10,2,2,2,10 → 30 → stop at 7
		const r = planFrame(input({ stream: new Set(Array.from({ length: 20 }, (_, k) => I(10, 10 + k))), moving: false }), c.now, c.mount);
		expect(r.mounts.length).toBe(7);
	});

	it('mounts at least one chunk when the clock is already past budget (mutant: while (elapsed < budget))', () => {
		let t = 100; const now = () => t; const mount = () => { t += 50; };
		const r = planFrame(input({ stream: new Set([I(10, 11), I(10, 12)]) }), now, mount);
		expect(r.mounts.length).toBe(1);
	});

	it('neighbour work is counted: a mount that costs 40 ms (4 absent neighbours) is the only mount that frame (mutant: neighbour work not counted)', () => {
		const c = clock([40, 1, 1]);
		const r = planFrame(input({ stream: new Set([I(10, 11), I(10, 12), I(10, 13)]), moving: false }), c.now, c.mount);
		expect(r.mounts.length).toBe(1);
	});

	it('edit lane runs first, in full, and suppresses streaming that frame (mutant: edits appended to the stream set)', () => {
		const c = clock([25, 25, 1]);
		const r = planFrame(input({ editLane: new Set([I(3, 3), I(3, 4)]), stream: new Set([I(10, 11)]), moving: false }), c.now, c.mount);
		expect(r.edits).toEqual([I(3, 3), I(3, 4)]);
		expect(r.mounts).toEqual([]);
	});

	it('adaptive budget: 30 ms while still or loading, 6 ms while moving (mutant: constant 6 → initial-load fixture needs > 20 frames)', () => {
		expect(budgetFor(true, false)).toBe(6); expect(budgetFor(false, false)).toBe(30); expect(budgetFor(true, true)).toBe(30);
		const stream = new Set(Array.from({ length: 121 }, (_, k) => I(k % 11, Math.floor(k / 11))));
		let frames = 0;
		while (stream.size > 0 && frames < 200) { const c = clock([9]); const r = planFrame(input({ stream, moving: true, initialLoad: true, playerCx: 5, playerCz: 5 }), c.now, c.mount); for (const i of r.mounts) stream.delete(i); frames++; }
		expect(frames).toBeLessThanOrEqual(31); // 121 chunks / 4 per frame at 9 ms under a 30 ms budget
	});
});
```

- [ ] **Step 2: Run to verify red**

Run: `npx vitest run src/game/chunk-scheduler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the scheduler**

```ts
// src/engine/world/radii.ts — the ONLY definition site (engine home: render and game import it; engine never imports game)
/** Chebyshev rings in chunks around the player's chunk (spec header). Never derive one from another. */
export const MESH_RADIUS = 5;
export const UNMOUNT_RADIUS = 6;
export const DATA_RADIUS = 7;

// src/game/chunk-scheduler.ts
import { WORLD_CHUNKS_Z } from '../engine/world/coords';
export { MESH_RADIUS, UNMOUNT_RADIUS, DATA_RADIUS } from '../engine/world/radii';
import { MESH_RADIUS } from '../engine/world/radii';
void MESH_RADIUS; // (only if nothing below uses it; otherwise drop this line — noUnusedLocals)
export const BUDGET_STILL_MS = 30;
export const BUDGET_MOVING_MS = 6;

export function budgetFor(moving: boolean, initialLoad: boolean): number {
	return initialLoad || !moving ? BUDGET_STILL_MS : BUDGET_MOVING_MS;
}
export function chebyshev(index: number, playerCx: number, playerCz: number): number {
	const cx = Math.floor(index / WORLD_CHUNKS_Z), cz = index % WORLD_CHUNKS_Z;
	return Math.max(Math.abs(cx - playerCx), Math.abs(cz - playerCz));
}
export function orderStream(stream: Iterable<number>, playerCx: number, playerCz: number): number[] {
	const items: { i: number; d: number; k: number }[] = []; let k = 0;
	for (const i of stream) items.push({ i, d: chebyshev(i, playerCx, playerCz), k: k++ });
	items.sort((a, b) => a.d - b.d || a.k - b.k); // explicit tie-break on insertion, not on cx/cz
	return items.map((x) => x.i);
}
export type FrameInput = { editLane: Set<number>; stream: Set<number>; playerCx: number; playerCz: number; moving: boolean; initialLoad: boolean };
export type FrameResult = { edits: number[]; mounts: number[]; elapsedMs: number };

export function planFrame(input: FrameInput, now: () => number, mount: (index: number) => boolean | void): FrameResult {
	const start = now();
	const edits: number[] = [];
	for (const i of input.editLane) { mount(i); edits.push(i); }
	if (edits.length > 0) return { edits, mounts: [], elapsedMs: now() - start }; // edit lane suppresses the stream budget this frame
	const budget = budgetFor(input.moving, input.initialLoad);
	const mounts: number[] = [];
	for (const i of orderStream(input.stream, input.playerCx, input.playerCz)) {
		if (mounts.length > 0 && now() - start >= budget) break; // checked before each mount; the first always runs (a cold mount overshoots the 6 ms budget: that IS the winning 1-chunk/frame probe)
		const r = mount(i); mounts.push(i);
		if (r === false) break; // Task 5: worker at capacity — do not generate more 3×3 halos this frame
	}
	return { edits, mounts, elapsedMs: now() - start };
}
```

- [ ] **Step 4: Wire the loop**

In `loop.ts`:
- Fields (all declared, `noUnusedLocals`): `private streamSet = new Set<number>(); private editLane = new Set<number>(); private shadowOnly = new Set<number>(); private mountedChunks = new Set<number>(); private lastPlayerChunk = -1; private initialLoad = true; private moving = false; private editStartedAt = 0;` — `stats` already exists from Task 1 (keep `lastEditMs` initialised to `-1`: the bench asserts it went `> 0` after an edit).
- `markChunkDirty(cx, cz, opts?: { edit?: boolean; shadowOnly?: boolean })`: `const i = chunkIndexOrNeg(cx, cz); if (i < 0) return; if (opts?.edit) { this.editLane.add(i); if (!this.editStartedAt) this.editStartedAt = performance.now(); } else { this.streamSet.add(i); if (opts?.shadowOnly) this.shadowOnly.add(i); }` — `shadowOnly = new Set<number>()` records chunks dirtied only by shadow invalidation.
- `markChunkDirtyAround(wx, wz)` calls `markChunkDirty(..., { edit: true })` for all its marks (the edited chunk and, on an edge, the axis neighbour that shares the face — both must re-mesh for the face to appear).
- `applyLightUpdate`: `touched` chunks → `markChunkDirty(c.cx, c.cz, { edit: true })`; the three SE neighbours → `n.shadowsDirty = true; markChunkDirty(n.cx, n.cz, { shadowOnly: true })`.
- `loadNearbyChunks`: ring `MESH_RADIUS`; `const pc = chunkIndexOrNeg(pcx, pcz); this.moving = pc !== this.lastPlayerChunk || playerSpeed > 0.5; this.lastPlayerChunk = pc;` (moving = the player's horizontal speed from `player.position` delta per tick > 0.5 b/s, computed in `tick`); `initialLoad` stays true until the stream set first drains.
- `flushDirtyChunks` → `planFrame({ editLane, stream: streamSet, playerCx, playerCz, moving, initialLoad }, () => performance.now(), (i) => this.mountIndex(i))`, then delete mounted indices from both sets, update `stats` (`streamQueue = streamSet.size`, `editQueue = editLane.size`, `mounted = mountedChunks.size`), and when `edits.length > 0`: `this.stats.lastEditMs = performance.now() - this.editStartedAt; this.editStartedAt = 0`. The edit lane consumes the whole frame's chunk budget (spec §3.B): no stream mount happens in a frame that ran an edit.
- `mountIndex(i)`: `const cx = Math.floor(i / WORLD_CHUNKS_Z), cz = i % WORLD_CHUNKS_Z; const c = this.world.ensureChunk(cx, cz); ensureShadowNeighbourhood(this.world, c); /* liquid frontier scan unchanged until Task 6 */ if (c.shadowsDirty) { const before = c.sunlitHash; computeChunkShadows(this.world, c); if (this.shadowOnly.has(i) && before === c.sunlitHash && this.mountedChunks.has(i)) { this.shadowOnly.delete(i); return; /* shadows unchanged: no re-mesh (spec §3.E compare) */ } } this.shadowOnly.delete(i); for (const n of Object.values(this.world.neighbors(c))) if (n && n.shadowsDirty) computeChunkShadows(this.world, n); const result = meshChunk(c, this.world.neighbors(c), this.uvFor); this.renderer.mountChunkMesh(c, result); this.mountedChunks.add(i);`
- Keep `VIEW_RADIUS = 4` with its comment changed to "walk/physics ring; the mesh ring is MESH_RADIUS".

- [ ] **Step 5: Interior-edit test in `loop.test.ts`**

```ts
it('§6.4 sunlitHash compare: an interior edit dirties 4 chunks (1 edit + 3 SE shadowOnly) and re-meshes exactly 1 over two ticks (mutant: skip the compare → 4)', () => {
	const { loop, world, tick, mounts } = makeLoop();
	// interior-flat fixture: 3×3 chunks of flat stone at y 20, player above chunk (16,16)
	for (let cx = 15; cx <= 17; cx++) for (let cz = 15; cz <= 17; cz++) { const c = world.ensureChunk(cx, cz); c.blocks.fill(AIR); for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) c.blocks[indexOf(x, 20, z)] = stone; c.lights.fill(0); c.liquidFrontier.clear(); }
	for (let cx = 15; cx <= 17; cx++) for (let cz = 15; cz <= 17; cz++) fillChunkLights(world, world.getChunk(cx, cz)!);
	for (let k = 0; k < 40; k++) tick(1 / 60); // stream everything in
	const before = mounts();
	// interior voxel (264, 21, 264): lx = lz = 8 → markChunkDirtyAround marks exactly one chunk
	world.setBlock(264, 21, 264, stone); loop.markChunkDirtyAround(264, 264); loop.applyLightUpdate(264, 21, 264);
	tick(1 / 60); // edit lane: the edited chunk re-meshes (1)
	tick(1 / 60); // stream lane: the 3 SE shadowOnly chunks are shadowed; a single block on a flat plain changes no neighbour's sunlit → 0 re-meshes
	expect(mounts() - before).toBe(1);
	expect(loop.stats.lastEditMs).toBeGreaterThan(0);
});
```

(A stone block on flat ground casts its shadow within its own chunk here; if a future fixture puts it on a chunk edge the SE neighbour legitimately re-meshes — keep the block interior.)

(`makeLoop` already stubs `mountChunkMesh` with a counter; import `fillChunkLights`.)

- [ ] **Step 6: Run everything**

Run: `npx vitest run src/game && npm test && npx tsc --noEmit && npm run lint`
Expected: green. The existing `loop.test.ts` tests that tick 1–3 frames to mount a chunk still pass because the first stream mount always runs.

- [ ] **Step 7: Commit**

```bash
git add src/engine/world/radii.ts src/game/chunk-scheduler.ts src/game/chunk-scheduler.test.ts src/game/loop.ts src/game/loop.test.ts
git commit -m "perf(loop): pure chunk scheduler — edit lane, nearest-first stream, adaptive budget, MESH_RADIUS ring, stats

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WkqJrcc2U5KmXWvtU969AW"
```

---

### Task 5: D — worker for shadows + mesh

Implements spec §3.D. Tests: §6.3 (identical bytes; detachment; stale dropped + fresh applied; dropped reply re-dirties; UV table equals `uvFor`). Port of the gate-1 `probe-worker.ts` / `worker.ts`.

**Files:**
- Create: `src/engine/render/uv-table.ts` (pure `buildUvTable(atlas: AtlasJson): Float32Array`, `uvFromTable(table): UvFn`), `src/engine/render/uv-table.test.ts`
- Modify: `src/engine/render/atlas.ts` (export `AtlasJson`; `loadAtlas` builds its `uvFor` via `buildUvTable` + `uvFromTable`; also returns `uvTable`)
- Create: `src/engine/world/chunk.worker.ts` (worker entry: receives `{uvTable}` once, then jobs; rebuilds `Chunk` instances over received buffers; runs `computeChunkShadows` + `meshChunk`; posts back with transfer)
- Create: `src/engine/world/chunk-jobs.ts`, `src/engine/world/chunk-jobs.test-utils.ts` (the inline factory — TEST ONLY; `chunk-jobs.ts` must not import it or the worker module, or the worker code is bundled into the main chunk), `src/engine/world/chunk-jobs.test.ts`
- Modify: `src/engine/world/chunk.ts` (`rev = 0`; `set()` increments `rev`; `static over(cx, cz, height, blocks, lights, sunlit)` builds a Chunk over received buffers WITHOUT allocating the three arrays)
- Modify: `src/engine/world/lighting.ts` (`updateLightsForBlockChange` increments `rev` of every touched chunk), `src/engine/world/shadows.ts` (`computeChunkShadows` does NOT bump rev; shadow *invalidation* sites in `loop.ts` do: `n.shadowsDirty = true; n.rev++`)
- Modify: `src/game/loop.ts` (streaming mounts post to `ChunkJobs`; replies mount; edits stay synchronous; `stats.workerInFlight`; new fields `inFlightIndex: Set<number>`, `jobs: ChunkJobs | null`; `loadNearbyChunks` skips in-flight indices)
- Modify: `src/main.ts` (construct `ChunkJobs` with the Vite factory and `atlas.uvTable`, pass to `GameLoop`)

**Interfaces:**
- Produces:
  ```ts
  // uv-table.ts
  export type AtlasJson = { size: number; tileSize: number; tiles: Record<string, { u: number; v: number; w: number; h: number }> };
  export function buildUvTable(atlas: AtlasJson): Float32Array;     // BLOCKS.length*6*4, NaN where a face has no texture
  export function uvFromTable(table: Float32Array): UvFn;
  // chunk-jobs.ts
  export type WorkerLike = { postMessage(msg: unknown, transfer?: Transferable[]): void; onmessage: ((e: { data: unknown }) => void) | null; terminate(): void };
  export type WorkerFactory = () => WorkerLike;
  export type ChunkJob = { id: number; cx: number; cz: number; chunk: Chunk; rev: number };
  export type JobPayload = { id: number; cx: number; cz: number; height: number; blocks: (Uint16Array | null)[]; lights: (Uint16Array | null)[]; sunlit: (Uint8Array | null)[] };
  export type JobReply = { id: number; sunlit: Uint8Array; mesh: ChunkMeshResult };
  export function snapshotFor(world: World, chunk: Chunk): { payload: JobPayload; transfer: ArrayBuffer[] };   // slice() copies of blocks×9, lights×5, sunlit×4 (+ centre sunlit not sent)
  export class ChunkJobs {
    constructor(factory: WorkerFactory, uvTable: Float32Array, maxInFlight = 2);
    post(world: World, chunk: Chunk): boolean;        // false if at capacity; records {chunk, rev: chunk.rev}
    inFlight(): number;
    onReply: ((job: ChunkJob, sunlit: Uint8Array, mesh: ChunkMeshResult) => void) | null;  // called only when world.getChunk(cx,cz) === job.chunk && chunk.rev === job.rev
    onDropped: ((job: ChunkJob) => void) | null;      // stale reply: the loop re-dirties
    terminate(): void;
  }
  // chunk-jobs.test-utils.ts (TEST ONLY)
  export function inlineWorkerFactory(): WorkerFactory;  // runs the worker module's handler in-process, routing every message through structuredClone(msg, { transfer })
  ```
- Consumes: `Chunk`, `computeChunkShadows` (Task 2), `meshChunk` (Task 3), `World.getChunk` (Task 1).

- [ ] **Step 0: Prove the import closure is pure (transitively)**

A one-level grep misses a value import of `world.ts` (which carries `import.meta.env` and pulls generation/lighting/simplex-noise). After Step 4, run `npm run build` and check the emitted worker chunk: `grep -cE "import\.meta|three|document\.|window\." dist/assets/chunk.worker-*.js` → expected `0`, and its size ≈ 90 KB (gate 2 measured 92 KB THREE-free). Also trace before building: `npx tsx -e "..."` is unnecessary — the build output is the proof. Record both in the commit body. If `world.ts` appears, the offending import is in `shadows.ts`/`mesher.ts`/`chunk.ts` (must use `coords.ts` only).

- [ ] **Step 1: Failing UV-table test**

```ts
// src/engine/render/uv-table.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildUvTable, uvFromTable, type AtlasJson } from './uv-table';
import { BLOCKS, faceTexture, type Face } from '../../data/blocks.data';

import { existsSync } from 'node:fs';
if (!existsSync('public/atlas.json')) throw new Error('public/atlas.json missing: run npm run build-atlas (it is gitignored)');
const atlas = JSON.parse(readFileSync('public/atlas.json', 'utf8')) as AtlasJson;
const FACES: Face[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

describe('uv table (spec §6.3)', () => {
	it('equals the reference formula for every textured block face (mutant: swap two faces)', () => {
		const t = buildUvTable(atlas); const uv = uvFromTable(t);
		for (const b of BLOCKS) for (const face of FACES) {
			const name = faceTexture(b.id, face); if (!name) continue;
			const r = atlas.tiles[name];
			expect(uv(b.id, face)).toEqual([r.u / atlas.size, 1 - (r.v + r.h) / atlas.size, (r.u + r.w) / atlas.size, 1 - r.v / atlas.size]);
		}
		expect(t.length).toBe(BLOCKS.length * 6 * 4);
	});
});
```

- [ ] **Step 2: Failing job-manager tests**

```ts
// src/engine/world/chunk-jobs.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { World } from './world';
import { computeChunkShadows, ensureShadowNeighbourhood } from './shadows';
import { meshChunk, type ChunkMeshResult } from './mesher';
import { ChunkJobs, snapshotFor } from './chunk-jobs';
import { inlineWorkerFactory } from './chunk-jobs.test-utils';
import { buildUvTable, uvFromTable, type AtlasJson } from '../render/uv-table';
import { spawnV3 } from './v3/spawn';
import { existsSync } from 'node:fs';

if (!existsSync('public/atlas.json')) throw new Error('public/atlas.json missing: run npm run build-atlas (it is gitignored)');
const atlas = JSON.parse(readFileSync('public/atlas.json', 'utf8')) as AtlasJson;
const table = buildUvTable(atlas); const uvFor = uvFromTable(table);
function fnvBytes(a: ArrayBufferView): number { const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); let h = 2166136261 >>> 0; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619) >>> 0; } return h; }
const meshHash = (m: ChunkMeshResult) => [m.opaque, m.liquid, m.translucent].map((x) => x ? [fnvBytes(x.positions), fnvBytes(x.colors), fnvBytes(x.uvs), fnvBytes(x.indices)] : null);

function world12() {
	const w = World.create(3); const s = spawnV3(3); const pcx = Math.floor(s.x / 16), pcz = Math.floor(s.z / 16);
	const picks: [number, number][] = [];
	for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) { w.ensureChunk(pcx + dx, pcz + dz); if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1 && picks.length < 12) picks.push([pcx + dx, pcz + dz]); }
	for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) w.getChunk(pcx + dx, pcz + dz)!.shadowsDirty = true;
	return { w, picks };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('ChunkJobs (spec §6.3)', () => {
	it('worker output is byte-identical to the synchronous path for 9 chunks (mutant: omit sunlit×4 → 0/9)', { timeout: 30_000 }, async () => {
		const { w, picks } = world12();
		// sync reference
		const ref = new Map<string, { s: number; m: unknown }>();
		for (const [cx, cz] of picks) { const c = w.getChunk(cx, cz)!; ensureShadowNeighbourhood(w, c); }
		for (const c of w.allChunks()) computeChunkShadows(w, c);
		for (const [cx, cz] of picks) { const c = w.getChunk(cx, cz)!; ref.set(`${cx},${cz}`, { s: fnvBytes(c.sunlit), m: meshHash(meshChunk(c, w.neighbors(c), uvFor)) }); }
		const jobs = new ChunkJobs(inlineWorkerFactory(), table, 2);
		let ok = 0; const got: Promise<void>[] = [];
		jobs.onReply = (job, sunlit, mesh) => { const r = ref.get(`${job.cx},${job.cz}`)!; if (fnvBytes(sunlit) === r.s && JSON.stringify(meshHash(mesh)) === JSON.stringify(r.m)) ok++; };
		for (const [cx, cz] of picks) { while (!jobs.post(w, w.getChunk(cx, cz)!)) await flush(); }
		while (jobs.inFlight() > 0) await flush();
		expect(ok).toBe(picks.length);
	});

	it('the sender\'s snapshot buffers are detached after post (mutant: stub calls the function directly → not detached)', () => {
		const { w, picks } = world12(); const c = w.getChunk(...picks[0])!;
		const { payload, transfer } = snapshotFor(w, c);
		const clone = structuredClone(payload, { transfer });
		expect(payload.blocks[4]!.byteLength).toBe(0);
		expect(clone.blocks[4]!.byteLength).toBe(c.blocks.byteLength);
		expect(c.blocks.byteLength).toBeGreaterThan(0); // the World's own arrays are untouched
	});

	it('a stale reply (rev moved or chunk replaced) is dropped and re-dirties; a fresh reply is applied (mutants: drop all replies; drop without re-dirty)', async () => {
		const { w, picks } = world12(); const c = w.getChunk(...picks[0])!;
		const jobs = new ChunkJobs(inlineWorkerFactory(), table, 2);
		const applied: number[] = [], dropped: number[] = [];
		jobs.onReply = (j) => applied.push(j.id); jobs.onDropped = (j) => dropped.push(j.id);
		jobs.post(w, c); c.rev++;                       // stale by rev
		while (jobs.inFlight() > 0) await flush();
		expect(dropped.length).toBe(1); expect(applied.length).toBe(0);
		jobs.post(w, c);                                 // fresh
		while (jobs.inFlight() > 0) await flush();
		expect(applied.length).toBe(1);
		jobs.post(w, c); w.dropChunk(c.cx, c.cz); w.ensureChunk(c.cx, c.cz); // stale by identity
		while (jobs.inFlight() > 0) await flush();
		expect(dropped.length).toBe(2);
	});

	it('at most 2 jobs in flight', () => {
		const { w, picks } = world12(); const jobs = new ChunkJobs(inlineWorkerFactory(), table, 2);
		expect(jobs.post(w, w.getChunk(...picks[0])!)).toBe(true); expect(jobs.post(w, w.getChunk(...picks[1])!)).toBe(true); expect(jobs.post(w, w.getChunk(...picks[2])!)).toBe(false);
	});

	it('neighbour seams: a centre posted while its axis neighbours are still unshadowed meshes identically to the sync path (mutant: skip the axis-neighbour shadow pass in mountStream → 0/9 identical)', { timeout: 30_000 }, async () => {
		// Same as the first test but the reference is built by the LOOP's mountStream order: neighbours unshadowed at post time.
		// Build via the loop helper of Task 4/5 (makeLoop with jobs) on the 5×5 fixture: mount the 9 picks through the loop with the inline factory, then compare every mounted mesh's colour bytes with the sync path where every neighbour was shadowed first. With the pass present: 9/9; without: 0/9 (gate 2 measured 81/81 chunks differing on a real stream).
		const { loop, world, tick, meshes } = makeLoop({ jobs: new ChunkJobs(inlineWorkerFactory(), table, 2), seed: 3 });
		// ...drive tick until the 9 picks are mounted; meshes() returns the last mesh per index from the renderer stub; compare fnvBytes(colors) with the sync reference computed as in the first test.
		void loop; void world; void tick; void meshes; // executor: fill in per the comment; the assertion is expect(identical).toBe(9)
	});
});

// src/game/loop.test.ts (Task 5 adds): dropped reply → chunk re-enters the stream set and is re-mounted
it('a reply dropped for a rev bump re-dirties the chunk and the next reply is applied (mutant: drop without re-dirty → stale geometry forever)', async () => {
	const { loop, world, tick, mounts } = makeLoop({ jobs: new ChunkJobs(inlineWorkerFactory(), table, 2), seed: 3 });
	for (let k = 0; k < 20; k++) { tick(1 / 60); await new Promise((r) => setTimeout(r, 0)); }
	const c = world.getChunk(21, 12)!; const before = mounts();
	c.rev++;                                    // invalidate while (possibly) in flight; then dirty it via the stream lane
	loop.markChunkDirty(21, 12);
	for (let k = 0; k < 20; k++) { tick(1 / 60); await new Promise((r) => setTimeout(r, 0)); }
	expect(mounts()).toBeGreaterThan(before);   // a fresh reply was applied after the dropped one
	expect(loop.stats.streamQueue).toBe(0);
});
```

- [ ] **Step 3: Run to verify red**

Run: `npx vitest run src/engine/render/uv-table.test.ts src/engine/world/chunk-jobs.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

`uv-table.ts` — move the loop from `loadAtlas` (atlas.ts:33-53) into `buildUvTable` writing `[u0,v0,u1,v1]` at `(id*6+fi)*4` (NaN for untextured); `uvFromTable` returns the 4-tuple (allocating a fresh tuple per call is fine — the mesher of Task 3 reads it immediately; or return a shared scratch tuple and document that callers do not retain it). `loadAtlas` uses them and adds `uvTable` to `LoadedAtlas`.

`chunk.worker.ts` (Vite worker entry, `self.onmessage`):

```ts
import { Chunk } from './chunk';
import { computeChunkShadows } from './shadows';
import { meshChunk } from './mesher';
import { uvFromTable } from '../render/uv-table';
import type { JobPayload, JobReply } from './chunk-jobs';
import type { WorldHeight } from './coords';

let uvFor: ReturnType<typeof uvFromTable> | null = null;
export function handleMessage(data: unknown, post: (reply: JobReply, transfer: ArrayBuffer[]) => void): void {
	const m = data as { uvTable?: Float32Array } & Partial<JobPayload>;
	if (m.uvTable) { uvFor = uvFromTable(m.uvTable); return; }
	const job = m as JobPayload;
	const grid: (Chunk | undefined)[] = new Array(9);
	for (let i = 0; i < 9; i++) {
		const b = job.blocks[i]; if (!b) continue;
		const dx = Math.floor(i / 3) - 1, dz = (i % 3) - 1;
		const c = new Chunk(job.cx + dx, job.cz + dz, job.height as WorldHeight);
		(c as { blocks: Uint16Array }).blocks = b; // readonly at the type level; the worker owns these buffers
		const li = i === 4 ? 0 : dx === 1 && dz === 0 ? 1 : dx === -1 && dz === 0 ? 2 : dx === 0 && dz === 1 ? 3 : dx === 0 && dz === -1 ? 4 : -1;
		if (li >= 0 && job.lights[li]) (c as { lights: Uint16Array }).lights = job.lights[li]!;
		if (li > 0 && job.sunlit[li - 1]) (c as { sunlit: Uint8Array }).sunlit = job.sunlit[li - 1]!;
		grid[i] = c;
	}
	const centre = grid[4]!;
	const world = { height: job.height, getChunk: (cx: number, cz: number) => { const dx = cx - job.cx, dz = cz - job.cz; return dx < -1 || dx > 1 || dz < -1 || dz > 1 ? undefined : grid[(dx + 1) * 3 + dz + 1]; }, chunkInWorld: () => true, ensureChunk: (cx: number, cz: number) => grid[(cx - job.cx + 1) * 3 + (cz - job.cz + 1)]! } as unknown as import('./world').World;
	computeChunkShadows(world, centre);
	const mesh = meshChunk(centre, { px: grid[7], nx: grid[1], pz: grid[5], nz: grid[3] }, uvFor!);
	const transfer: ArrayBuffer[] = [centre.sunlit.buffer as ArrayBuffer];
	for (const m2 of [mesh.opaque, mesh.liquid, mesh.translucent]) if (m2) transfer.push(m2.positions.buffer as ArrayBuffer, m2.normals.buffer as ArrayBuffer, m2.uvs.buffer as ArrayBuffer, m2.colors.buffer as ArrayBuffer, m2.indices.buffer as ArrayBuffer);
	post({ id: job.id, sunlit: centre.sunlit, mesh }, transfer);
}
if (typeof self !== 'undefined' && 'postMessage' in self && typeof window === 'undefined') {
	self.onmessage = (e: MessageEvent) => handleMessage(e.data, (reply, transfer) => (self as unknown as Worker).postMessage(reply, transfer));
}
```

(`Chunk`'s arrays are `readonly` fields; the worker replaces them through a typed cast — alternatively add a `static over(cx, cz, height, blocks, lights, sunlit)` factory to `Chunk`; either is acceptable, the factory is cleaner — add it in `chunk.ts` and use it in both the worker and the test.) `ensureShadowNeighbourhood` is not called in the worker: the payload IS the 3×3.

`chunk-jobs.ts` — `snapshotFor` copies with `slice()` and lists the copies' buffers in `transfer` (measured 0.16–0.31 ms for the 2 MB payload); `ChunkJobs.post` builds the payload, records `{id, cx, cz, chunk, rev: chunk.rev}` in `pending`, posts with transfer; `onmessage` looks up the job, checks `world.getChunk(cx, cz) === job.chunk && job.chunk.rev === job.rev` (store `world` on the job at `post` time), calls `onReply` or `onDropped`, deletes from `pending`. **`chunk-jobs.test-utils.ts`** (test only) exports `inlineWorkerFactory`, which imports `handleMessage` from `chunk.worker.ts` and implements `postMessage(msg, transfer)` as `queueMicrotask(() => handleMessage(structuredClone(msg, { transfer }), (reply, t) => this.onmessage?.({ data: structuredClone(reply, { transfer: t }) })))`. `chunk-jobs.ts` itself never imports the worker module. The worker rebuilds chunks with `Chunk.over(...)` (no 320 KB × 9 allocation per job).

`chunk.ts`: `rev = 0;` and `set()` does `this.rev++` when it writes. `lighting.ts` `updateLightsForBlockChange`: after computing `touched`, `for (const c of touched) c.rev++`. In `loop.ts`, every `n.shadowsDirty = true` written by an edit also does `n.rev++`.

`loop.ts` streaming path — `mountStream(i)` (stream mounts when `this.jobs` is set; edits keep the synchronous `mountSync(i)` = Task 4's `mountIndex` body):
1. ensure the chunk + `ensureShadowNeighbourhood`, liquid scan (unchanged);
2. **shadow the axis neighbours first**: `for (const n of [px, nx, pz, nz] of world.neighbors(c)) if (n && n.shadowsDirty) computeChunkShadows(this.world, n);` — the worker computes only the CENTRE's sunlit and averages the neighbours' `sunlit` into border corners; without this pass a nearest-first stream sends all-zero neighbour sunlit and every chunk edge gets a dark seam (gate 2: 81/81 chunks' colours differ). ≈ 0.7 ms each after Task 2;
3. `if (this.jobs.post(this.world, c)) { this.inFlightIndex.add(i); this.streamSet.delete(i); return true; } return false;` — `false` tells `planFrame` the worker is full: stop generating halos this frame; the chunk stays in the stream set.
`loadNearbyChunks` and `orderStream`'s input skip `inFlightIndex` (otherwise a posted-but-unreplied chunk is nearest again next frame and gets posted twice, halving throughput — gate 2 B3). A posted chunk leaves the stream set at post and returns only via `onDropped` or a later `markChunkDirty`.
`jobs.onReply = (job, sunlit, mesh) => { const idx = chunkIndex(job.cx, job.cz); this.inFlightIndex.delete(idx); if (!this.wanted(idx)) return; /* player left: do not mount what the evictor would drop next frame */ job.chunk.sunlit.set(sunlit); job.chunk.sunlitHash = hashSunlit(sunlit); job.chunk.shadowsDirty = false; this.renderer.mountChunkMesh(job.chunk, mesh); this.mountedChunks.add(idx); /* seams (spec §3.D): mounted axis neighbours sample this chunk's final sunlit at their border corners → re-dirty them shadowOnly; the sunlitHash compare keeps most from re-meshing */ for (const n of axisNeighbours(job.chunk)) if (n && this.mountedChunks.has(chunkIndex(n.cx, n.cz))) { n.shadowsDirty = true; n.rev++; this.markChunkDirty(n.cx, n.cz, { shadowOnly: true }); } }`;
`jobs.onDropped = (job) => { const idx = chunkIndex(job.cx, job.cz); this.inFlightIndex.delete(idx); if (this.wanted(idx)) this.streamSet.add(idx); }` — **invariant: a chunk stays dirty until a reply is applied; a dropped reply re-dirties it** (spec §3.D). `wanted(idx)` = `chebyshev(idx, playerCx, playerCz) <= MESH_RADIUS` against the CURRENT player chunk (the enqueue ring — evicted ⇒ unwanted, but this is not the evictor's own predicate). `stats.workerInFlight = this.jobs.inFlight()` each frame. `GameLoop` constructor gains an optional `jobs: ChunkJobs | null = null` parameter (last); `main.ts` passes `new ChunkJobs(() => new Worker(new URL('./engine/world/chunk.worker.ts', import.meta.url), { type: 'module' }), atlas.uvTable)` — the URL is relative to `src/main.ts`, so `./engine/...`; `../engine/...` resolves outside `src/` and `npm run build` fails with "Could not resolve entry module" (gate 2 verified both).

- [ ] **Step 5: Run everything, build the worker**

Run: `npx vitest run src/engine/render/uv-table.test.ts src/engine/world/chunk-jobs.test.ts && npm test && npx tsc --noEmit && npm run lint && npm run build`
Expected: green; `dist/assets/` contains a `chunk.worker-*.js` of ≈ 90 KB with zero `three`/`import.meta`/`document.` occurrences (Step 0). Then a 60-second manual check on port 5174 (new world, fly around; console has no worker errors; `__mc.loop.stats.workerInFlight` moves between 0 and 2). Stop by port.

- [ ] **Step 6: Commit**

```bash
git add src/engine/render/uv-table.ts src/engine/render/uv-table.test.ts src/engine/render/atlas.ts src/engine/world/chunk.worker.ts src/engine/world/chunk-jobs.ts src/engine/world/chunk-jobs.test-utils.ts src/engine/world/chunk-jobs.test.ts src/engine/world/chunk.ts src/engine/world/lighting.ts src/game/loop.ts src/game/loop.test.ts src/main.ts
git commit -m "perf(worker): shadows + meshing off the main thread; Chunk.rev; dropped replies re-dirty

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WkqJrcc2U5KmXWvtU969AW"
```

---

### Task 6: E — eviction, fog, `hasLiquid`, re-entry fixture

Implements spec §3.E. Tests: §6.4 (paired modified/unmodified eviction — mutant: no-op evictor; re-entry byte-identical — mutant: different seed; sets cleared — mutant: leave the entry; eviction/re-entry shadows — mutant: skip the re-dirty on drop/arrival; fog formula; `hasLiquid` after `applySave` — mutant: flag from generation only).

**Files:**
- Modify: `src/game/loop.ts` (`evict()` after `simulate`; numeric set cleanup; `hasLiquid` gate on the frontier scan; `stats.data`)
- Modify: `src/engine/render/renderer.ts` (`unmountChunk(cx, cz)`; fog `new THREE.Fog(0x87ceeb, FOG_NEAR, FOG_FAR)` with `export const FOG_FAR = MESH_RADIUS * 16 - 8; export const FOG_NEAR = FOG_FAR - 8;` — 72 / 64: the gate-2 kid-lens pass measured that a 29-block fade (near 43) dissolves the summit of the one peak visible from spawn while an 8-block band keeps it legible and reads as Minecraft's render edge; `MESH_RADIUS` imported from `../world/radii` (engine → engine))
- Modify: `src/engine/world/world.ts` (`dropChunk` also re-dirties the 3×3 neighbours' shadows and bumps their `rev`; dev assertion helper `assertWithinData(cx, cz)` used by the loop's scheduler reads in DEV)
- Modify: `src/game/test-loop.ts` (created here by moving `makeLoop` out of `loop.test.ts`; its renderer stub gains `unmountChunk(cx, cz)` — without it the walk-away test throws `TypeError: unmountChunk is not a function`)
- Modify: `src/engine/world/chunk.ts` (`hasLiquid = false`), `src/engine/world/generation.ts` (set `chunk.hasLiquid` after generating: scan once), `src/engine/world/world.ts` (`setBlock`/`setBlockFlow` set `hasLiquid = true` when `isLiquid(id)`), `src/game/apply-save.ts` (recompute `hasLiquid` from `rc.blocks`)
- Modify: `src/game/liquid-scheduler.ts` (no change to logic; add a DEV assertion that `getBlock` reads stay within `DATA_RADIUS` of the player — pass a `withinData(x, z)` predicate in the constructor, default `() => true`)
- Create: `src/game/eviction.test.ts`; append to `src/engine/world/shadows.test.ts` the re-entry fixture

**Interfaces:**
- Produces: `GameLoop.evict()` (private, called in `tick` after `simulate`), `Renderer.unmountChunk(cx, cz): void`, `FOG_NEAR/FOG_FAR`, `Chunk.hasLiquid`, `World.dropChunk` re-dirtying.
- Consumes: `UNMOUNT_RADIUS`, `DATA_RADIUS` (`radii.ts`, Task 4), `World.dropChunk` (Task 1), `Chunk.rev` (Task 5). Liquid note (gate 2): `World.setBlockFlow` marks `modified`, so chunks liquids ever flowed through are retained for the session by design — the memory gate is therefore `data ≤ 225 + world.modifiedChunks().length` (Task 8), and the bench flies over land.

- [ ] **Step 1: Failing tests**

```ts
// src/game/eviction.test.ts
import { describe, it, expect } from 'vitest';
import { World } from '../engine/world/world';
import { UNMOUNT_RADIUS, DATA_RADIUS } from './chunk-scheduler';
import { FOG_FAR, FOG_NEAR } from '../engine/render/renderer';
import { applySave } from './apply-save';
import { BLOCK_BY_NAME } from '../data/blocks.data';
import { indexOf, blocksPerChunk } from '../engine/world/coords';
// makeLoop moved from loop.test.ts to src/game/test-loop.ts in this task (renderer stub gains unmountChunk)
import { makeLoop } from './test-loop';

const water = BLOCK_BY_NAME['water'].id;
function fnv(a: ArrayLike<number>) { let h = 2166136261 >>> 0; for (let i = 0; i < a.length; i++) { h ^= a[i]; h = Math.imul(h, 16777619) >>> 0; } return h; }

describe('eviction (spec §3.E, §6.4)', () => {
	it('drops the unmodified chunk and keeps the modified one at the same distance beyond DATA_RADIUS (mutant: no-op evictor)', () => {
		const { world, player, tick } = makeLoop();
		player.position = [16 * 16 + 8, 60, 16 * 16 + 8];
		const far = DATA_RADIUS + 1;
		const a = world.ensureChunk(16 + far, 16), b = world.ensureChunk(16, 16 + far);
		b.modified = true;
		tick(1 / 60);
		expect(world.getChunk(16 + far, 16)).toBeUndefined();
		expect(world.getChunk(16, 16 + far)).toBe(b);
		expect(a.modified).toBe(false);
	});

	it('re-entry regenerates byte-identical blocks (mutant: different seed)', () => {
		const w = World.create(3);
		const h = fnv(w.ensureChunk(10, 10).blocks);
		w.dropChunk(10, 10);
		expect(fnv(w.ensureChunk(10, 10).blocks)).toBe(h);
	});

	it('an evicted index leaves mountedChunks and a re-entered chunk is re-meshed (mutant: leave the entry)', () => {
		const { loop, player, tick, mounts } = makeLoop();
		player.position = [16 * 16 + 8, 60, 16 * 16 + 8];
		for (let k = 0; k < 400; k++) tick(1 / 60);             // fill the mesh ring
		const before = mounts();
		player.position = [(16 + UNMOUNT_RADIUS + 3) * 16 + 8, 60, 16 * 16 + 8]; // walk away past the unmount ring
		for (let k = 0; k < 400; k++) tick(1 / 60);
		player.position = [16 * 16 + 8, 60, 16 * 16 + 8];       // come back
		for (let k = 0; k < 400; k++) tick(1 / 60);
		expect(mounts()).toBeGreaterThan(before);                // the origin chunk was mounted again
		expect(loop.stats.mounted).toBeLessThanOrEqual((2 * UNMOUNT_RADIUS + 1) ** 2);
	});

	it('fog far is the formula MESH_RADIUS*16-8 = 72 and near is far - 8 = 64 (kid-lens gate 2: an 8-block band keeps the spawn summit legible)', () => {
		expect(FOG_FAR).toBe(5 * 16 - 8); expect(FOG_NEAR).toBe(FOG_FAR - 8);
	});

	it('hasLiquid is recomputed by applySave for a chunk with placed water (mutant: flag only from generation)', () => {
		const blocks = new Uint16Array(blocksPerChunk(256)); blocks[indexOf(3, 130, 3)] = water;
		const w2 = World.create(3);
		applySave(w2, { version: 3, id: '11111111-1111-4111-8111-111111111111', seed: 3, name: 'x', createdAt: 0, updatedAt: 0, height: 256, genVersion: 3, player: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hotbar: [], selected: 0 }, chunks: [{ cx: 12, cz: 12, blocks }] } as never);
		expect(w2.getChunk(12, 12)!.hasLiquid).toBe(true);
	});
});
```

Append to `shadows.test.ts`:

```ts
it('§6.4 eviction / re-entry: a retained chunk\'s sunlit equals the fully-loaded reference after a neighbour is dropped and re-entered (mutant: skip the re-dirty on drop/arrival)', () => {
	const ref = fullyLoaded(3, 2);
	const [cx, cz] = ref.order[0]; const c = ref.w.getChunk(cx, cz)!;
	computeChunkShadowsBrute(ref.w, c); const want = fnv8(c.sunlit);
	const w = World.create(3);
	for (const [x, z] of ref.order) w.ensureChunk(x, z);
	for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (w.chunkInWorld(cx + dx, cz + dz)) w.ensureChunk(cx + dx, cz + dz);
	const t = w.getChunk(cx, cz)!; computeChunkShadows(w, t);
	w.dropChunk(cx - 1, cz - 1);              // the NW neighbour the sun ray reaches
	expect(t.shadowsDirty).toBe(true);        // re-dirtied on drop
	if (t.shadowsDirty) computeChunkShadows(w, t); // partial answer while the neighbour is gone
	w.ensureChunk(cx - 1, cz - 1);            // re-entry
	expect(t.shadowsDirty).toBe(true);        // re-dirtied on arrival
	computeChunkShadows(w, t);
	expect(fnv8(t.sunlit)).toBe(want);
});
```

- [ ] **Step 2: Run to verify red**

Run: `npx vitest run src/game/eviction.test.ts src/engine/world/shadows.test.ts`
Expected: FAIL — `FOG_FAR` not exported, `hasLiquid` undefined, evictor absent (`getChunk(16+far,16)` defined), `shadowsDirty` false after `dropChunk`.

- [ ] **Step 3: Implement**

`loop.ts` `evict()` (called in `tick` right after `simulate` — i.e. after `scheduler.tick`, before `loadNearbyChunks`/`flushDirtyChunks` — and in the paused branch after `flushDirtyChunks`; same wording as spec §3.E):

```ts
private evict() {
	const pcx = Math.floor(this.player.position[0] / 16), pcz = Math.floor(this.player.position[2] / 16);
	for (const i of this.mountedChunks) {
		if (chebyshev(i, pcx, pcz) > UNMOUNT_RADIUS) { const cx = Math.floor(i / WORLD_CHUNKS_Z), cz = i % WORLD_CHUNKS_Z; this.renderer.unmountChunk(cx, cz); this.mountedChunks.delete(i); this.streamSet.delete(i); this.shadowOnly.delete(i); }
	}
	for (const c of this.world.allChunks()) {
		if (!c.modified && Math.max(Math.abs(c.cx - pcx), Math.abs(c.cz - pcz)) > DATA_RADIUS) { const i = chunkIndex(c.cx, c.cz); if (this.inFlightIndex.has(i)) continue; this.world.dropChunk(c.cx, c.cz); }
	}
	this.stats.mounted = this.mountedChunks.size; this.stats.data = this.world.chunkCount;
}
```

`renderer.ts` `unmountChunk(cx, cz)`: remove + dispose the three meshes for the key; `MESH_RADIUS` imported from `../world/radii` (created in Task 4; engine never imports `game`).

`world.ts` `dropChunk`: after clearing the slot, `for dx,dz in 3×3: const n = this.getChunk(cx+dx, cz+dz); if (n) { n.shadowsDirty = true; n.rev++; }`. The ARRIVAL re-dirty lives in `loop.ts` (Task 2), not in `ensureChunk`; Task 5 already made it bump `rev`.

`hasLiquid`: `generation.ts` `generateChunk` ends with a scan `chunk.hasLiquid = blocks.some(isLiquid)` (one pass over 65 k, ≈ 0.1 ms; or set it inside the v3 fill loop where water/lava are written — cheaper; v1/v2 do the scan); `World.setBlock`/`setBlockFlow` set it when `isLiquid(id)`; `applySave` sets `c.hasLiquid = rc.blocks.some(isLiquid)`. `loop.ts` frontier scan becomes `if (c.hasLiquid && c.liquidFrontier.size === 0) { ...scan... }`.

Liquid scheduler DEV assertion: constructor gains `withinData?: (x: number, z: number) => boolean`; `getBlock` reads in `tick` paths go through `private read(x, y, z)` that asserts in DEV. The loop passes `(x, z) => chebyshev(chunkIndex(x >> 4, z >> 4), pcx, pcz) <= DATA_RADIUS` bound to the current player chunk each tick.

`makeLoop` moves from `loop.test.ts` to `src/game/test-loop.ts` (exported; `loop.test.ts` imports it).

- [ ] **Step 4: Run everything; visual check of the fog**

Run: `npx vitest run src/game src/engine/world/shadows.test.ts && npm test && npx tsc --noEmit && npm run lint`
Expected: green. Then port 5174: new world, walk 200 blocks and back; the frontier is never visible; `__mc.loop.stats` shows `mounted ≤ 169`, `data ≤ 225 + modifiedChunks`. (The kid-lens fog pass already ran at gate 2 on live-set fog values: 64/72 accepted.) Stop by port.

- [ ] **Step 5: Commit**

```bash
git add src/game/loop.ts src/game/eviction.test.ts src/game/test-loop.ts src/game/loop.test.ts src/game/liquid-scheduler.ts src/game/apply-save.ts src/engine/render/renderer.ts src/engine/world/world.ts src/engine/world/chunk.ts src/engine/world/generation.ts src/engine/world/radii.ts src/game/chunk-scheduler.ts src/engine/world/shadows.test.ts
git commit -m "perf(memory): unmount beyond UNMOUNT_RADIUS, drop unmodified data beyond DATA_RADIUS, fog from MESH_RADIUS, hasLiquid

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WkqJrcc2U5KmXWvtU969AW"
```

---

### Task 7: F — F3 stats overlay

Implements spec §3.F. Tests: §6.6 (rolling aggregation — mutant: off-by-one window). Independent of Tasks 2–6; runs in a worktree.

**Files:**
- Create: `src/ui/perf-stats.ts` (pure aggregator), `src/ui/perf-stats.test.ts`, `src/ui/perf-overlay.ts` (DOM panel)
- Modify: `src/ui/ui.css` (`#perf-overlay`), `src/main.ts` (F3 handler next to the Tab handler; the `loop.onFrame` assignment placed AFTER `const loop = new GameLoop(...)` (main.ts:367) — the Tab handler at :318 precedes it and a TDZ ReferenceError follows otherwise), `src/game/loop.ts` (add `onFrame: ((dt: number, tickMs: number, frameMs: number) => void) | null` called at the end of `tick` AND in the paused branch — the overlay must not freeze with the inventory open; `frameMs` is a raw `performance.now()` delta kept by the loop, because `renderer.frame` clamps `dt` at 100 ms and a 400 ms hitch would read as 100). `stats` exists since Task 1.
- Modify: `src/engine/render/renderer.ts` (expose `info()` → `{ calls: this.gl.info.render.calls, triangles: this.gl.info.render.triangles, pixelRatio: this.gl.getPixelRatio(), width, height, gpu: string }`; the GPU string: `const ctx = this.gl.getContext(); const ext = ctx.getExtension('WEBGL_debug_renderer_info'); gpu = ext ? String(ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'n/a'`)

**Interfaces:**
- Produces:
  ```ts
  // perf-stats.ts
  export type FrameSample = { t: number; frameMs: number; tickMs: number };   // frameMs = raw performance.now() delta between ticks, never the clamped dt
  export class RollingStats { push(s: FrameSample): void; summary(now: number): { fps: number; avgMs: number; worstMs: number; over50In10s: number; tickShare: number }; }
  // last 1 s for fps/avg/worst (frames with t > now-1000), last 10 s for over50In10s; tickShare = Σtick/Σframe over the last second.
  // perf-overlay.ts
  export class PerfOverlay { constructor(container: HTMLElement); toggle(): void; readonly visible: boolean; tick(now: number, sample: FrameSample, live: () => Record<string, string | number>): void; /* re-renders at most twice a second */ }
  ```
- Consumes: `loop.stats` (Task 4), `renderer.info()`, `performance.memory` when present.

- [ ] **Step 1: Failing aggregator test**

```ts
// src/ui/perf-stats.test.ts
import { describe, it, expect } from 'vitest';
import { RollingStats } from './perf-stats';

describe('RollingStats (spec §6.6)', () => {
	it('fps/avg/worst over the last 1 s and >50 ms count over the last 10 s, with exact window edges (mutant: off-by-one window)', () => {
		const r = new RollingStats();
		// 60 frames at 16.7 ms ending at t=1000, one 60 ms frame at t=500 and one at t=-9500 (outside 10 s), tick 8 ms each
		for (let k = 0; k < 60; k++) r.push({ t: 1000 - k * 16.7, frameMs: 16.7, tickMs: 8 });
		r.push({ t: 500, frameMs: 60, tickMs: 50 });
		r.push({ t: -9500, frameMs: 60, tickMs: 50 });   // exactly 10.5 s before now=1000 → excluded
		r.push({ t: -8999, frameMs: 70, tickMs: 50 });   // 9.999 s before → included
		const s = r.summary(1000);
		expect(s.over50In10s).toBe(2);
		expect(s.worstMs).toBe(60);
		expect(s.fps).toBeGreaterThan(55);
		expect(s.tickShare).toBeGreaterThan(0.4);
		// a frame exactly 1000 ms old is outside the 1 s window
		const r2 = new RollingStats(); r2.push({ t: 0, frameMs: 90, tickMs: 1 }); r2.push({ t: 500, frameMs: 10, tickMs: 1 });
		expect(r2.summary(1000).worstMs).toBe(10);
	});
});
```

- [ ] **Step 2: Run to verify red** — `npx vitest run src/ui/perf-stats.test.ts` → module not found.

- [ ] **Step 3: Implement**

`RollingStats` keeps a ring buffer of 1 200 samples; `summary(now)` filters `t > now - 1000` and `t > now - 10000` (strict). `PerfOverlay` builds one `<pre id="perf-overlay">` (css: `position:fixed; top:8px; left:8px; font:12px/1.3 monospace; color:#fff; background:rgba(0,0,0,.45); padding:6px 8px; pointer-events:none; white-space:pre; z-index:30;` hidden by default) and prints, twice a second: `fps avgMs worstMs over50/10s tick% | calls tris | mounted data | stream edit worker | lastEdit ms | heap MB | dpr WxH | gpu`. Static facts (dpr, size, gpu) are read once on first show.

`main.ts` — the keydown handler next to the Tab handler (gated as the spec says: frozen / inventory / colour picker / an `<input>` such as `#pin-input` focused; this is stricter than Tab's `frozen`-only gate, deliberately), and the `onFrame` assignment AFTER the loop is constructed:

```ts
// next to the Tab handler (before `const loop`): only the key handler
const perfOverlay = new PerfOverlay(app);
window.addEventListener('keydown', (e) => {
	if (e.code !== 'F3') return;
	if (frozen || inventoryOpen || colorPicker.isOpen) return;
	if ((document.activeElement as HTMLElement | null)?.tagName === 'INPUT') return; // PIN input focused
	e.preventDefault();
	perfOverlay.toggle();
});

// AFTER `const loop = new GameLoop(...)` (main.ts:367) — before that line `loop` is in its temporal dead zone
loop.onFrame = (_dt, tickMs, frameMs) => perfOverlay.tick(performance.now(), { t: performance.now(), frameMs, tickMs }, () => ({ ...loop.stats, ...renderer.info(), heapMB: (performance as { memory?: { usedJSHeapSize: number } }).memory ? Math.round((performance as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize / 1048576) : 'n/a' }));
```

`loop.ts` `tick` keeps `lastFrameAt` and computes `frameMs = now - lastFrameAt` (raw), measures its own duration with `performance.now()` around its body and calls `this.onFrame?.(dt, tickMs, frameMs)` last — in both the active and the paused branch.

- [ ] **Step 4: Run** — `npx vitest run src/ui && npm test && npx tsc --noEmit && npm run lint && npm run build`; then port 5174: F3 shows/hides the panel; it does nothing while the inventory is open. Stop by port.

- [ ] **Step 5: Commit**

```bash
git add src/ui/perf-stats.ts src/ui/perf-stats.test.ts src/ui/perf-overlay.ts src/ui/ui.css src/main.ts src/game/loop.ts src/engine/render/renderer.ts
git commit -m "feat(ui): F3 performance overlay with rolling frame stats

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WkqJrcc2U5KmXWvtU969AW"
```

---

### Task 8: Browser benchmark — Playwright devDependency, `scripts/perf-bench.ts`, baseline and final runs

Implements spec §6.5 (mutant: a build that stalls 60 ms every 30th frame → walking row red). Two parts: **8a scaffold + baseline** right after Task 1 (worktree) — records the still / walk / fly / load phases only (Task 1's `stats.streamQueue` stub is enough for `newWorld()`; the edit phase needs `lastEditMs` from Task 4 and the memory phase needs `mounted`/`data` from Task 6, so those two rows of the baseline are recorded at 8b's first run, labelled as such); **8b final run** after Tasks 6 and 7 (main tree, exit criterion, all six phases).

**Files:**
- Modify: `package.json` (`"playwright": "^1.47.0"` in devDependencies; script `"perf:bench": "tsx scripts/perf-bench.ts"`), `.gitignore` (`bench-out/`)
- Create: `scripts/perf-bench.ts`
- Modify: `docs/superpowers/specs/2026-09-22-performance-design.md` §1 table (8a: fill the "Today" column with this machine's CDP-measured baseline; 8b: add an "After" column)

**Interfaces:**
- Produces: `npm run perf:bench [--reps 6] [--phases still,walk,fly,load,edit,memory] [--port 5174]` → prints the §1 table as markdown, writes `bench-out/<timestamp>.json`, exits 1 when a gated target is missed (walk long-task ms > 100 or frames > 50 ms > 0; fly > 400 ms or > 5; load: any task > 50 ms after the first frame; edit: any frame > 50 ms, any edge edit `lastEditMs` > 50, any interior edit > 20, or any edit that did not happen; memory: heap (`usedSize + backingStorageSize`) > 250 MB or mounted > 169 or data > 225 + modified; travel below the floor). The in-page API-URL assert aborts the whole run if the page is not pointed at `http://127.0.0.1`.
- Consumes: `window.__mc` (`{world, player, loop}`, DEV only), `loop.stats`, `loop.replaceBlock` (returns `boolean` via `canReplace`, which REFUSES air — aim at the solid surface block, not the air above it), `loop.markChunkDirtyAround`, `loop.applyLightUpdate`, `world.setBlock`, `spawnV3` (imported in the script to compute the edge and the expected spawn), `BLOCK_BY_NAME` for ids (stone is id **3**; id 1 is grass_block — never hardcode a guessed id).

- [ ] **Step 1 (8a): Install and write the script**

`npm install --save-dev playwright@^1.47 && npx playwright install chromium` (≈ 200 MB, explicit decision per spec). Script skeleton:

```ts
// scripts/perf-bench.ts
import { chromium, type Page, type CDPSession } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawnV3 } from '../src/engine/world/v3/spawn';

const PORT = Number(arg('--port', '5174')); const REPS = Number(arg('--reps', '6'));
const PHASES = arg('--phases', 'still,walk,fly,load,edit,memory').split(',');
const SEED = 3;
const GATES = { walkLongTaskMs: 100, walkOver50: 0, flyLongTaskMs: 400, flyOver50: 5, editInteriorMs: 20, editEdgeMs: 50, heapMB: 250, mounted: 169, data: 225 /* + modified, read at run time */, walkMinBlocks: 40, flyMinBlocks: 160 };
import { BLOCK_BY_NAME } from '../src/data/blocks.data';
const STONE = BLOCK_BY_NAME['stone'].id; // 3 in the frozen base catalog; never guess it

function arg(name: string, def: string) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; }
const median = (xs: number[]) => { if (xs.length === 0) throw new Error('median of nothing: --reps must be ≥ 2 (first repetition is warm-up)'); const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
if (REPS < 2) throw new Error('--reps must be ≥ 2');

async function startDev(): Promise<() => void> {
	const p = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { env: { ...process.env, VITE_MINICRAFT_API_URL: 'http://127.0.0.1:9099' }, stdio: 'ignore' });
	for (let i = 0; i < 60; i++) { try { await fetch(`http://localhost:${PORT}/`); return () => { spawn('fuser', ['-k', `${PORT}/tcp`]); p.kill(); }; } catch { await new Promise((r) => setTimeout(r, 500)); } }
	throw new Error('dev server did not start');
}

/** In-page instrumentation: rAF sampler + longtask observer. Returns a handle the phases read and reset. */
const INSTRUMENT = `(() => { const S = { frames: [], long: [] }; let last = performance.now(); const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) S.long.push({ t: e.startTime, ms: e.duration }); }); po.observe({ entryTypes: ['longtask'] }); function f() { const n = performance.now(); S.frames.push({ t: n, ms: n - last }); last = n; requestAnimationFrame(f); } requestAnimationFrame(f); window.__bench = { reset() { S.frames = []; S.long = []; }, take() { return { frames: S.frames.slice(), long: S.long.slice() }; } }; })()`;

/** Navigates ONCE, instruments, and returns nothing: every timestamp of a phase is taken inside this same document (performance.now() is per-document — gate 2 measured 1503 ms vs 302 ms across a navigation). */
/** Load-phase variant of newWorld: same single navigation, but t0/t1 are read in-page around the world creation and handed back with the raw samples. */
async function newWorldTimed(page: Page, cb: (t0: number, t1: number, raw: { frames: { t: number; ms: number }[]; long: { t: number; ms: number }[] }) => void) {
	await newWorld(page, true);
	const r = await page.evaluate(() => { const w = window as unknown as { __benchT0: number; __bench: { take(): { frames: { t: number; ms: number }[]; long: { t: number; ms: number }[] } } }; return { t0: w.__benchT0, t1: performance.now(), raw: w.__bench.take() }; });
	cb(r.t0, r.t1, r.raw);
}

async function newWorld(page: Page, timed = false) {
	await page.goto(`http://localhost:${PORT}/`);
	// Safety: a stray dev server on this port WITHOUT the env var would point at the production save API.
	const api = await page.evaluate(() => (import.meta as unknown as { env: Record<string, string> }).env?.VITE_MINICRAFT_API_URL ?? '');
	if (!api.startsWith('http://127.0.0.1')) throw new Error(`refusing to drive a page whose API is ${api || '(unset → .env.local → PRODUCTION)'}`);
	await page.evaluate(INSTRUMENT);
	if (timed) await page.evaluate(() => { (window as unknown as { __benchT0: number }).__benchT0 = performance.now(); });
	// menu: New world with seed 3 (ids from src/ui/menu.ts: #w-seed input, the New button)
	await page.click('text=New world'); await page.fill('#w-seed', String(SEED)); await page.click('text=Create');
	await page.waitForFunction(() => (window as unknown as { __mc?: unknown }).__mc !== undefined);
	await page.waitForFunction(() => { const mc = (window as unknown as { __mc: { loop: { stats: { streamQueue: number } } } }).__mc; return mc.loop.stats.streamQueue === 0; }, null, { timeout: 60_000 });
}

type PhaseResult = { longTaskMs: number; over50: number; frames: number; fps: number; p95: number; travelled?: number; extra?: Record<string, number> };
function summarise(raw: { frames: { t: number; ms: number }[]; long: { t: number; ms: number }[] }, t0: number, t1: number): PhaseResult {
	const fr = raw.frames.filter((f) => f.t >= t0 && f.t <= t1); const lt = raw.long.filter((l) => l.t >= t0 && l.t <= t1);
	const ms = fr.map((f) => f.ms).sort((a, b) => a - b);
	return { longTaskMs: lt.reduce((s, l) => s + l.ms, 0), over50: fr.filter((f) => f.ms > 50).length, frames: fr.length, fps: fr.length / ((t1 - t0) / 1000), p95: ms[Math.floor(ms.length * 0.95)] ?? 0 };
}

/** Drives player.position directly: the spec's answer to key events that moved 0 blocks. */
/** mode 'still': touch nothing. 'walk': flying=false, y tracks the surface (+1) so ground rendering is exercised. 'fly': flying=true, tier 5, y = 140 above the terrain (never inside stone — gate 2 found the old driver flew through rock, measuring streaming but not drawing). */
async function move(page: Page, mode: 'still' | 'walk' | 'fly', dirX: number, dirZ: number, bps: number, seconds: number): Promise<PhaseResult> {
	return page.evaluate(async ({ mode, dirX, dirZ, bps, seconds }) => {
		const mc = (window as unknown as { __mc: { world: { getBlock(x: number, y: number, z: number): number }; player: { position: number[]; flying: boolean; flySpeedTier: number } } }).__mc;
		const b = (window as unknown as { __bench: { reset(): void; take(): { frames: { t: number; ms: number }[]; long: { t: number; ms: number }[] } } }).__bench;
		const surfaceY = (x: number, z: number) => { for (let y = 255; y > 0; y--) if (mc.world.getBlock(Math.floor(x), y, Math.floor(z)) !== 0) return y; return 0; };
		if (mode === 'fly') { mc.player.flying = true; mc.player.flySpeedTier = 5; mc.player.position[1] = 140; }
		if (mode === 'walk') { mc.player.flying = false; }
		const start = mc.player.position.slice(); b.reset(); const t0 = performance.now(); let last = t0;
		await new Promise<void>((done) => { const step = () => { const n = performance.now(); const dt = (n - last) / 1000; last = n; if (mode !== 'still') { mc.player.position[0] += dirX * bps * dt; mc.player.position[2] += dirZ * bps * dt; if (mode === 'walk') mc.player.position[1] = surfaceY(mc.player.position[0], mc.player.position[2]) + 1; } if (n - t0 < seconds * 1000) requestAnimationFrame(step); else done(); }; requestAnimationFrame(step); });
		const t1 = performance.now(); const raw = b.take();
		const travelled = Math.hypot(mc.player.position[0] - start[0], mc.player.position[2] - start[2]);
		return { raw, t0, t1, travelled };
	}, { mode, dirX, dirZ, bps, seconds }).then(({ raw, t0, t1, travelled }) => ({ ...summarise(raw, t0, t1), travelled }));
}

async function still(page: Page, seconds: number): Promise<PhaseResult> { return move(page, 'still', 0, 0, 0, seconds); }

/** Direction with the most land (column top ≥ 121, i.e. above sea level) within 200 blocks of spawn, so the fly/walk/memory phases do not cross the ocean (liquid flow marks chunks modified and legitimately retains them). Printed with the results. */
async function landDirection(page: Page): Promise<{ dirX: number; dirZ: number; name: string }> {
	return page.evaluate(() => {
		const mc = (window as unknown as { __mc: { world: { getBlock(x: number, y: number, z: number): number }; player: { position: number[] } } }).__mc;
		const top = (x: number, z: number) => { for (let y = 255; y > 0; y--) if (mc.world.getBlock(x, y, z) !== 0) return y; return 0; };
		const [px, , pz] = mc.player.position.map(Math.floor);
		const dirs = [{ dirX: 1, dirZ: 0, name: '+x' }, { dirX: -1, dirZ: 0, name: '-x' }, { dirX: 0, dirZ: 1, name: '+z' }, { dirX: 0, dirZ: -1, name: '-z' }];
		let best = dirs[0], bestLand = -1;
		for (const d of dirs) { let land = 0; for (let s = 8; s <= 200; s += 8) { const x = px + d.dirX * s, z = pz + d.dirZ * s; if (x < 24 || x > 487 || z < 24 || z > 487) break; if (top(x, z) >= 121) land++; } if (land > bestLand) { bestLand = land; best = d; } }
		return best;
	});
}

async function edits(page: Page): Promise<PhaseResult & { edge: number[]; interior: number[] }> {
	const s = spawnV3(SEED); const edgeX = (Math.floor(s.x / 16) + 1) * 16; // chunk boundary nearest spawn in +x
	return page.evaluate(async ({ edgeX, z0, STONE }) => {
		const mc = (window as unknown as { __mc: { world: { getBlock(x: number, y: number, z: number): number; setBlock(x: number, y: number, z: number, id: number): void }; loop: { replaceBlock(hit: { x: number; y: number; z: number; face: string }, id: number, color: string): boolean; markChunkDirtyAround(x: number, z: number): void; applyLightUpdate(x: number, y: number, z: number): void; stats: { lastEditMs: number } } } }).__mc;
		const b = (window as unknown as { __bench: { reset(): void; take(): { frames: { t: number; ms: number }[]; long: { t: number; ms: number }[] } } }).__bench;
		const surfaceY = (x: number, z: number) => { for (let y = 255; y > 0; y--) if (mc.world.getBlock(x, y, z) !== 0) return y; return 0; };
		const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		// One edit = replace the SOLID surface block (canReplace refuses air), then break it. Each is asserted to have happened.
		const editAt = async (x: number, z: number, into: number[]) => {
			const y = surfaceY(x, z);
			mc.loop.stats.lastEditMs = -1;
			if (!mc.loop.replaceBlock({ x, y, z, face: 'py' }, STONE, '#ffffff')) throw new Error(`replaceBlock refused at ${x},${y},${z}`);
			await frame(); await frame(); if (!(mc.loop.stats.lastEditMs > 0)) throw new Error(`place at ${x},${z}: no edit mounted`); into.push(mc.loop.stats.lastEditMs);
			mc.loop.stats.lastEditMs = -1;
			mc.world.setBlock(x, y, z, 0); mc.loop.markChunkDirtyAround(x, z); mc.loop.applyLightUpdate(x, y, z);
			await frame(); await frame(); if (!(mc.loop.stats.lastEditMs > 0)) throw new Error(`break at ${x},${z}: no edit mounted`); into.push(mc.loop.stats.lastEditMs);
		};
		const edge: number[] = [], interior: number[] = []; b.reset(); const t0 = performance.now();
		for (let k = 0; k < 20; k++) await editAt(edgeX - 1, z0 + k, edge);            // 20 on the boundary column (lx = 15): place + break = 40 edits
		for (let k = 0; k < 10; k++) await editAt(edgeX - 8, z0 + 3 + k, interior);    // 10 interior (≥ 3 blocks from any boundary): 20 edits
		const t1 = performance.now(); return { raw: b.take(), t0, t1, edge, interior };
	}, { edgeX, z0: Math.floor(s.z), STONE }).then(({ raw, t0, t1, edge, interior }) => ({ ...summarise(raw, t0, t1), edge, interior }));
}

async function memory(page: Page, cdp: CDPSession, dir: { dirX: number; dirZ: number }): Promise<{ heapMB: number; mounted: number; data: number; modified: number }> {
	await move(page, 'fly', dir.dirX, dir.dirZ, 25, 30); await still(page, 2);
	await cdp.send('HeapProfiler.collectGarbage');
	// usedSize EXCLUDES typed-array backing stores — which is everything the radii bound (gate 2: 0.4 MB used vs 425 MB backing). Gate on both.
	const u = await cdp.send('Runtime.getHeapUsage') as { usedSize: number; backingStorageSize?: number };
	const st = await page.evaluate(() => { const mc = (window as unknown as { __mc: { world: { modifiedChunks(): unknown[] }; loop: { stats: { mounted: number; data: number } } } }).__mc; return { ...mc.loop.stats, modified: mc.world.modifiedChunks().length }; });
	return { heapMB: Math.round((u.usedSize + (u.backingStorageSize ?? 0)) / 1048576), mounted: st.mounted, data: st.data, modified: st.modified };
}

(async () => {
	const stop = await startDev();
	const browser = await chromium.launch({ headless: false, args: ['--use-gl=angle'] });
	const out: Record<string, PhaseResult[] | unknown[]> = {}; let failed = false;
	try {
		for (const phase of PHASES) {
			const runs: unknown[] = [];
			for (let rep = 0; rep < REPS; rep++) {
				const page = await browser.newPage({ viewport: { width: 1600, height: 900 } }); const cdp = await page.context().newCDPSession(page);
				if (phase === 'load') {
					// ONE navigation per repetition (fresh page + fresh world); t0 taken inside the final document, right after INSTRUMENT, before the menu clicks.
					await newWorldTimed(page, (t0, t1, raw) => { const r = summarise(raw, t0, t1); const afterFirst = raw.long.filter((l) => l.t > t0 + 100).map((l) => l.ms); runs.push({ ...r, wallMs: t1 - t0, worstAfterFirst: Math.max(0, ...afterFirst) }); });
				}
				else { await newWorld(page); const dir = await landDirection(page); if (rep === 0) console.log(`# ${phase}: land direction ${dir.name}`); if (phase === 'still') runs.push(await still(page, 10)); if (phase === 'walk') runs.push(await move(page, 'walk', dir.dirX, dir.dirZ, 5, 10)); if (phase === 'fly') runs.push(await move(page, 'fly', dir.dirX, dir.dirZ, 25, 8)); if (phase === 'edit') runs.push(await edits(page)); if (phase === 'memory') runs.push(await memory(page, cdp, dir)); }
				await page.close();
			}
			out[phase] = runs.slice(1); // first repetition is warm-up
		}
	} finally { await browser.close(); stop(); }
	mkdirSync('bench-out', { recursive: true }); writeFileSync(`bench-out/${Date.now()}.json`, JSON.stringify(out, null, 2));
	const med = (phase: string, key: string) => median((out[phase] as Record<string, number>[]).map((r) => r[key]));
	const rows: string[] = ['| Phase | long-task ms | frames > 50 ms | fps (info) | p95 ms (info) | gate |', '|---|---|---|---|---|---|'];
	const gate = (ok: boolean) => { if (!ok) failed = true; return ok ? 'ok' : 'FAIL'; };
	if (out.still) rows.push(`| still | ${med('still', 'longTaskMs').toFixed(0)} | ${med('still', 'over50')} | ${med('still', 'fps').toFixed(1)} | ${med('still', 'p95').toFixed(1)} | ${gate(med('still', 'over50') === 0)} |`);
	if (out.walk) { const trav = med('walk', 'travelled'); rows.push(`| walk 5 b/s 10 s (${trav.toFixed(0)} blocks) | ${med('walk', 'longTaskMs').toFixed(0)} | ${med('walk', 'over50')} | ${med('walk', 'fps').toFixed(1)} | ${med('walk', 'p95').toFixed(1)} | ${gate(trav >= GATES.walkMinBlocks && med('walk', 'longTaskMs') <= GATES.walkLongTaskMs && med('walk', 'over50') <= GATES.walkOver50)} |`); }
	if (out.fly) { const trav = med('fly', 'travelled'); rows.push(`| fly tier 5 8 s (${trav.toFixed(0)} blocks) | ${med('fly', 'longTaskMs').toFixed(0)} | ${med('fly', 'over50')} | ${med('fly', 'fps').toFixed(1)} | ${med('fly', 'p95').toFixed(1)} | ${gate(trav >= GATES.flyMinBlocks && med('fly', 'longTaskMs') <= GATES.flyLongTaskMs && med('fly', 'over50') <= GATES.flyOver50)} |`); }
	if (out.load) rows.push(`| initial load | ${med('load', 'longTaskMs').toFixed(0)} | ${med('load', 'over50')} | wall ${med('load', 'wallMs').toFixed(0)} ms | worst after first frame ${med('load', 'worstAfterFirst').toFixed(0)} | ${gate(med('load', 'worstAfterFirst') <= 50)} |`);
	if (out.edit) { const E = out.edit as { edge: number[]; interior: number[]; over50: number }[]; const edge = E.flatMap((r) => r.edge), interior = E.flatMap((r) => r.interior); rows.push(`| edits 40 edge + 20 interior | ${med('edit', 'longTaskMs').toFixed(0)} | ${med('edit', 'over50')} | max edge ${Math.max(...edge).toFixed(1)} ms / interior ${Math.max(...interior).toFixed(1)} ms | — | ${gate(med('edit', 'over50') === 0 && Math.max(...edge) <= GATES.editEdgeMs && Math.max(...interior) <= GATES.editInteriorMs)} |`); }
	if (out.memory) { const modified = med('memory', 'modified'); rows.push(`| memory after 30 s tier-5 flight | heap ${med('memory', 'heapMB')} MB (used + backing) | mounted ${med('memory', 'mounted')} | data ${med('memory', 'data')} (modified ${modified}) | — | ${gate(med('memory', 'heapMB') <= GATES.heapMB && med('memory', 'mounted') <= GATES.mounted && med('memory', 'data') <= GATES.data + modified)} |`); }
	console.log(rows.join('\n'));
	process.exit(failed ? 1 : 0);
})();
```

Notes for the executor: the menu selectors (`text=New world`, `#w-seed`, `text=Create`) must be checked against `src/ui/menu.ts` (the seed input id is `w-seed`; the button labels are what the menu renders — read `renderHome`/the new-world card and adjust). `STONE` comes from `BLOCK_BY_NAME` (id 3). `bench-out/` is gitignored. The script never touches `.env.local`; the API host is a dead port so autosave retries against it as it does offline; the in-page assert in `newWorld` refuses any page not pointed at `127.0.0.1`. `page.route` is available (standalone Playwright, not the MCP) but unnecessary. Phases `walk`, `fly`, `memory` follow the printed land direction so they stay over land.

- [ ] **Step 2 (8a): Prove the bench can go red**

Temporarily add to `loop.ts`: a field `private benchStall = 0;` and in `tick`: `if (++this.benchStall % 30 === 0) { const t = performance.now(); while (performance.now() - t < 60) {} }` (do not commit) and run `npm run perf:bench -- --phases walk --reps 3` → walk row `FAIL` with `over50 ≈ 20` and ≈ 1 200 long-task ms (gate 2 measured). Revert. Record the output in the commit body.

- [ ] **Step 3 (8a): Baseline run and spec update**

`npm run perf:bench -- --phases still,walk,fly,load` on the Task-1 tree (6 reps; ≈ 10 min). Paste the printed table into the spec's §1 as the "Today (this machine, CDP)" column values for those four rows, replacing the dev-box/desktop mixture with the one same-session baseline; keep the old numbers in §2; the edit and memory baseline rows are recorded at 8b's FIRST run before the final (after Task 6, on the same machine) and labelled "baseline recorded after Task 6". Commit `package.json`, `package-lock.json`, `.gitignore`, `scripts/perf-bench.ts`, the spec.

- [ ] **Step 4 (8b): Final run — the exit criterion**

After Tasks 6 and 7 are merged: `npm run perf:bench` (6 reps). Exit 0 required. Paste the table as the spec's §1 "After" column and into the commit body. If a gated row fails, it is a bug in Tasks 1–6 — fix there, never widen a gate. Commit the spec.

```bash
git add docs/superpowers/specs/2026-09-22-performance-design.md
git commit -m "perf: final benchmark — <one line per gated row>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WkqJrcc2U5KmXWvtU969AW"
```

---

### Task 9: Docs

**Files:**
- Modify: `docs/lighting.md` "Cast shadows" section (constant relative path, per-start-column early-out, 3×3 precondition, load-order independence, `sunlitHash`; measured 16 → 0.5 ms)
- Create: `docs/performance.md` (≤ 120 lines: the three radii and what each ring does; the scheduler — edit lane, nearest-first, adaptive 30/6 budget, min one, dirty-until-applied; the worker — payload shape incl. `sunlit × 4`, `Chunk.rev` + identity, 2 in flight, stale replies re-dirty; eviction — after `simulate`, modified never dropped, re-entry re-lights, faint light seams accepted; fog formula; `hasLiquid`; the bench protocol and gates with the final table; F3 overlay fields; what is out of scope)
- Modify: `README.md` (one line under the feature list: F3 overlay; docs pointer), `CLAUDE.md` (add `performance.md` to the per-subsystem docs line)

- [ ] **Step 1: Write the docs; verify every number against the final bench and the commit bodies of Tasks 1–3**
- [ ] **Step 2: `npm run lint` (markdown is not linted; just confirm the tree is clean)**
- [ ] **Step 3: Commit**

```bash
git add docs/lighting.md docs/performance.md README.md CLAUDE.md
git commit -m "docs: performance subsystem (scheduler, worker, eviction, bench) and shadow algorithm

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WkqJrcc2U5KmXWvtU969AW"
```

---

## Gate 1 changes reflected in this plan (spec §8 → task)

| Spec finding / decision | Where in the plan |
|---|---|
| R-B4 index aliasing at the world edge | Task 1 edge test with the string-keyed shim; `chunkIndexOrNeg` everywhere a coordinate may be out of range |
| R-B3 / C-B3 shadows depend on load order; stream mutant = shadow without the 3×3 | Task 2 `ensureShadowNeighbourhood` + stream-equivalence test; re-entry fixture in Task 6 |
| E-B4 per-start-column form, 16 → 0.5 ms | Task 2 implementation + ray counter test |
| R-N1 golden bytes, pinned fixture, recorded once | Task 3 step 0 bootstrap |
| E-B3 / C-B2 edit path + `sunlitHash` compare | Task 4 edit lane, `shadowOnly` compare, corner-edit test |
| R-N2 scheduler mutants | Task 4 tests (Chebyshev pair, non-lexicographic ties, 2×2 budgets + (2,2,10,2), min one, neighbour cost, edit lane first, adaptive budget) |
| E-B1 `sunlit × 4`; R-B5 injectable factory, `Chunk.rev`, structuredClone stub, real UV table, positive twin; C-B4 dropped reply re-dirties | Task 5 |
| C-B1 radii arithmetic; R-N3 no-op evictor pair, sets cleared; R-N4 `hasLiquid` on `applySave`; R-U1 fog formula | Task 6 |
| R-U7 F3 gating | Task 7 |
| R-B1 unstable targets → long-task ms + frames > 50, 6-keep-5; R-B2 position-driven with travel floors; C-B5 edit + heap instruments; R-N6 Playwright | Task 8 |
| §6.7 kid-lens fog pass | Gate 2 reviews this plan + Task 6's horizon screenshot; not a code test |

## Gate 2 changes (plan review, 3 lenses; finding → action)

| Finding | Action in this plan |
|---|---|
| R-B5 / R-B6 Task 3 needed `shadows.brute.ts` from Task 2; 8a needed `loop.stats` from Task 4 | Task 1 creates `shadows.brute.ts` and the `stats` stub; table rows 3 and 8a depend on 1 only; 8a records still/walk/fly/load, edit/memory at 8b |
| R-N `chunkIndexOrNeg` value-imported from `world.ts` pulls `import.meta`/generation into the worker bundle; one-level grep blind | `chunkIndexOrNeg` lives in `coords.ts`; Task 5 step 0 checks the BUILT worker chunk transitively |
| R-N radii home stated four ways; no eslint boundary rule | `src/engine/world/radii.ts` created in Task 4, the only definition; scheduler re-exports; renderer imports engine-side |
| R-N arrival re-dirty in `ensureChunk` would fire inside `mountIndex`'s neighbour loop | Arrival re-dirty lives in `loop.ts` (Task 2); Task 6 no longer says otherwise |
| R-N stale Shared definitions (`SchedulerInput`/`MountCost`); undeclared `moving`/`shadowOnly`/`inFlightIndex` | Shared block synced to `FrameInput`/`FrameResult`; every field declared in its task's field list |
| R-N `git stash` in Tasks 1/3; `public/atlas.json` absent in worktrees (E-B5); unused imports fail tsc/lint | Global Constraints: archive copies, `build-atlas` per worktree, throw-not-skip; snippets scrubbed |
| E-B4 Task 2 tests exceed vitest's 5 s | `30_000` timeouts on the big fixtures (also Task 3 golden, Task 5 world12) |
| E-N ray bound 10 % only 1.7 pts above the mutant | Bound 2 % (measured 0.72 %, mutant 11.7 %) |
| R-N golden blind to the translucent pass | Fourth pick with stained glass |
| R-B1 corner-edit test red on correct code and its mutant unreachable | Interior edit, two ticks: 1 vs 4 |
| R-N Chebyshev fixture (2,2)/(3,0) does not discriminate from Euclidean | (3,3) before (4,0) |
| E-B1 worker URL `../` breaks the build | `./engine/world/chunk.worker.ts` |
| E-B2 worker meshes with unshadowed neighbours → dark seams on every edge | `mountStream` shadows the 4 axis neighbours first; seam test variant |
| E-B3 in-flight chunks re-posted every frame | `inFlightIndex` skipped by `loadNearbyChunks`/`orderStream`; `mount()` returns `false` when the worker is full and `planFrame` stops |
| E-U1 border corners sample a neighbour's partial sunlit | On reply, mounted axis neighbours re-dirtied `shadowOnly` (compare limits re-meshes) |
| E-N inline factory bundles the worker into main; `Chunk` allocation per job; reply mounted for unwanted chunk; dropped-reply retry untested | `chunk-jobs.test-utils.ts`; `Chunk.over`; `wanted` check in `onReply`; loop retry test |
| R-N `unmountChunk` missing from the renderer stub; unused test bindings | `test-loop.ts` stub gains it; bindings scrubbed |
| R-N liquid flow marks `modified` → `data ≤ 225` red over water | Gate `data ≤ 225 + modifiedChunks`; phases follow the land direction |
| R-B2 heap gate blind to typed arrays | `usedSize + backingStorageSize` |
| R-B3 edits no-op (air refused; stone id wrong); interior row unmeasured | Solid-surface edits asserted to happen; `BLOCK_BY_NAME.stone`; 40 edge + 20 interior with both gates |
| R-B4 load phase mixes two documents' clocks | One navigation; `t0` set in-page after INSTRUMENT |
| R-N still() flew; fly through stone; `--reps 1` throws | `move(mode)`: still touches nothing, walk tracks the surface, fly at y 140; `--reps ≥ 2` enforced |
| R-N stray server on 5174 without the env var would drive production | In-page `VITE_MINICRAFT_API_URL` assert aborts the run |
| E-N `loop.onFrame` before `const loop` (TDZ); `dt` clamped at 100 ms; overlay frozen while paused; GPU string needs `getParameter` | Assignment after loop construction; raw `frameMs`; `onFrame` in the paused branch; `getParameter(UNMASKED_RENDERER_WEBGL)` |
| K fog 43/72 dissolves the spawn summit | `FOG_NEAR = FOG_FAR − 8` (64); spec §3.E/§6.4 updated |

## Self-review

**Spec coverage.** §3.A → Task 1; §3.C → Task 2 (+ Task 6 re-entry fixture); §3.G → Task 3; §3.B → Task 4; §3.D → Task 5; §3.E → Task 6 (+ `sunlitHash` computed in Task 2, compared in Task 4); §3.F → Task 7; §6.1 hashes (every task's exit), shadow equivalence (Task 2), mesh golden (Task 3); §6.2 → Task 4; §6.3 → Task 5; §6.4 → Tasks 4 (corner edit) and 6 (the rest); §6.5 → Task 8; §6.6 → Task 7; §6.7 → gate 2. No spec test is without a task.

**Placeholders.** None: every step has code or an exact command; the places an executor must look something up (menu selectors in Task 8; the seam-test body in Task 5, whose assertion and construction are stated) name the file and the alternative.

**Type consistency.** `chunkIndex`/`chunkIndexOrNeg` live in `coords.ts` (Task 1) and are imported from there by Tasks 2, 4, 5, 6 and the tests (never from `world.ts`); `Chunk.sunlitHash` (Task 2), `Chunk.rev` + `Chunk.over` (Task 5), `Chunk.hasLiquid` (Task 6) match the shared block; `planFrame(input, now, mount: (i) => boolean | void)` in Task 4's test and implementation agree (`FrameInput`/`FrameResult`), and Task 5's `mountStream` returns the boolean; `ChunkJobs` constructor `(factory, uvTable, maxInFlight)` and `post(world, chunk): boolean` are the same in test and loop wiring; `inlineWorkerFactory` is only ever imported from `chunk-jobs.test-utils.ts`; radii are defined once in `src/engine/world/radii.ts` (Task 4), re-exported by `chunk-scheduler.ts`, imported by `renderer.ts` engine-side; `loop.stats` is created in Task 1 with the field set `{ streamQueue, editQueue, lastEditMs (-1), mounted, data, workerInFlight }` that Tasks 4/5/6 fill and Tasks 7/8 read — no task adds a field; `onFrame(dt, tickMs, frameMs)` has three arguments in loop and main; `FOG_NEAR = FOG_FAR - 8` in renderer, eviction test and spec; `computeChunkShadows(world, chunk)` keeps its signature through Tasks 2 and 5 (the worker passes a duck-typed world with `getChunk`/`chunkInWorld`/`ensureChunk`/`height`).
