# Cloud Saves Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store Minicraft worlds in a GCS bucket behind an unauthenticated Cloud Function, so a seven-year-old's worlds survive a cleared browser cache, while every existing `localStorage` world stays loadable forever.

**Architecture:** One JSON object per world at `worlds/{uuid}.json`; the world list is derived from GCS custom metadata via a prefix listing, so a save is a single atomic write with no index to fall out of sync. The client composes two independent adapters (local + cloud) behind the existing `PersistenceAdapter` interface — neither leg's failure blocks the other, and no code path ever discards a copy that has edits the other lacks.

**Tech Stack:** TypeScript, Vite, vitest, `@google-cloud/storage`, `zod`, Express via `@google-cloud/functions-framework`, Cloud Functions gen2 (nodejs22), GCS.

**Spec:** `docs/superpowers/specs/2026-08-21-cloud-saves-design.md`

## Global Constraints

- **Indentation: 1 tab = 4 spaces.** Every file.
- `strict: true`; no `any` without an eslint-disable **and a stated reason**.
- No comments explaining *what* code does — only *why*, when the why is non-obvious.
- Conventional commits scoped by subsystem: `feat(persistence):`, `test(api):`, `fix(ui):`.
- **GCP project `qs-trading`. Bucket `gs://minicraft-worlds`, `us-central1`.** Function `minicraft-api`, gen2, `nodejs22`, 512 MiB, 60 s, `--max-instances=3`, `--allow-unauthenticated`.
- **Request body cap: 32 MB**, checked from `content-length` as the **first statement** in the handler. `express.json({limit})` is a no-op under functions-framework (it body-parses at `1024mb` first).
- **Never deploy the website.** `deploy.sh` touches the function only. Nothing in this change writes to `gs://noah.leap-forward.ca`.
- **Never test against `https://noah.leap-forward.ca/minicraft/`.** Browser testing is `http://localhost:5173` only, pointed at the deployed API.
- **v1 `localStorage` keys (`minicraft:v1:...`) are read-only, forever.** No task writes or deletes one.
- **Never issue a generation-targeted GCS delete.** Use `ifGenerationMatch` as a precondition on a plain delete of the live object.
- Run `npx vitest run` before every commit. Baseline at plan time is **178 passing in 19 files** (verified on a clean tree). The gate is **"no previously-passing test fails"** — do not assert absolute counts in later tasks, because review agents leave untracked probe files that inflate the number.
- **Stage explicit file paths in every commit. Never `git add <directory>`** — review agents leave throwaway probes in the tree, and directory adds sweep them in.
- **No intermediate commit is ever deployed.** Tasks 4–12 ship a v2 local writer before the cloud legs exist, which roughly doubles the local footprint with none of the durability payoff. The production cutover happens only after Task 13 passes, and Julien performs it.
- The kid's real worlds live in the localStorage of origin `https://noah.leap-forward.ca`. **`http://localhost:5173` is a different origin with a different, empty store**, so nothing in this plan can reach or damage them. That is also why Task 0 exists: without importing a real export, the migration tests rehearse on synthetic data.

---

### Task 0: Back up the real worlds, and make the migration testable

Gate 2's verdict, and it was unambiguous: **require the export.** It is both the only artifact that survives a browser "clear site data" or a quota eviction, and the only way to make Task 13's migration step test anything real rather than a synthetic world the tester just made.

This task is **run by Julien**, not by an agent — it touches the production origin, which agents must not.

**Files:**
- Create: `scripts/export-worlds.js` (a console snippet, not a build script)
- Create: `scripts/import-worlds.js`

- [ ] **Step 1: Export, on the production origin**

Open `https://noah.leap-forward.ca/minicraft/`, **stay on the main menu — do not open a world**, and run this in the DevTools console. It only reads.

```js
copy(JSON.stringify(Object.fromEntries(
	Object.entries(localStorage).filter(([k]) => k.startsWith('minicraft:'))
)));
```

Paste into `~/minicraft-worlds-backup-YYYY-MM-DD.json`, **store it off this machine**, and record the world count and each world's name.

- [ ] **Step 2: Import into the dev origin**

With `npm run dev` running, open `http://localhost:5173`, and in its console:

```js
const backup = /* paste the JSON */;
for (const [k, v] of Object.entries(backup)) localStorage.setItem(k, v);
location.reload();
```

Now the legacy worlds are real, and Tasks 4 and 13 test the actual migration.

- [ ] **Step 3: Record the baseline**

Note the exact world count and per-world chunk counts. Task 13 asserts these are unchanged at the end.

---

### Task 1: Make AutoSave survivable — tests first ✅ DONE (`ab9d4cd`)

Implemented ahead of the rest, since it gates every network task. Landed with gate-2's findings already folded in: the coalescing test was replaced with an overlap detector (`maxActive`), because the original version asserted the *buggy* code's own output and passed against it. A `dirtySeq` edit counter was added so an edit made during an in-flight save keeps its dirty flag — the fix as originally written would have dropped it.

Result: 6 new tests, **184 passing**, lint and `tsc -b` clean.

---

### Task 2: TNT and liquids must arm autosave

Live data-loss bug: `markDirty()` is called from only `src/main.ts:172`, `:236`, `:276`. `detonateAt` (`src/game/loop.ts:221`) and the liquid tick mutate chunks with no notification, so a crater or a water spread is lost on tab close. Gate 2 reproduced both in real wiring: after a TNT fuse tick the neighbour stone is AIR, after a 1 s tick water has spread — with **0** notifications.

**Files:**
- Modify: `src/game/loop.ts`, `src/game/liquid-scheduler.ts`, `src/main.ts`
- Test: `src/game/loop.test.ts` (create — it does **not** exist today)

**Interfaces:**
- Produces: `GameLoop.onWorldMutated: (() => void) | null`; `GameLoop.simulate(dt: number): void` (new public seam); `LiquidScheduler.tick(dt: number): boolean` (was `void`).

Two facts gate 2 established by running code, which this task depends on:
- `GameLoop.tick` is **private** and only reachable via `start()` → `renderer.onTick(...)`, and `Renderer` cannot be constructed under `environment: 'node'` (it needs WebGL, `window.devicePixelRatio`, `container.appendChild`). So a public seam is required.
- **"The scheduler already knows" whether a tick changed a block is false.** `LiquidScheduler.tick(dt)` returns `void`; `applySpreadStep` and `applyReactionStep` return `void`; only `applyDrainStep` returns anything. The signal has to be added.

Firing on every tick regardless of change is **not** a stuck-timer bug — it re-encodes and re-uploads the entire world every 5 s forever (137 ms/full-world encode per leg, plus ~1 MB per cloud PUT). Hence the no-op guard test below.

- [ ] **Step 1: Write the failing tests**

`GameLoop`'s constructor only builds the `LiquidScheduler`; it never dereferences the renderer, camera or player, so a stub renderer works.

```ts
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { GameLoop } from './loop';
import { World } from '../engine/world/world';
import { FpCamera } from '../engine/render/camera';
import { Player } from './player';
import type { Renderer } from '../engine/render/renderer';

function makeLoop() {
	const world = new World(1);
	const rendererStub = {
		camera: new THREE.PerspectiveCamera(),
		mountChunkMesh: () => {},
		onTick: () => {},
	} as unknown as Renderer;
	const loop = new GameLoop(
		world,
		rendererStub,
		new FpCamera(),
		new Player([260, 40, 260]),
		{} as never,
		{} as never,
	);
	return { loop, world };
}
```

Match the real `GameLoop` constructor arity when writing this — read `src/game/loop.ts:49` rather than trusting the stub list above.

```ts
it('notifies onWorldMutated when primed TNT detonates', () => {
	const { loop, world } = makeLoop();
	let mutations = 0;
	loop.onWorldMutated = () => { mutations++; };
	// place TNT, ignite via the public loop.ignite(hit), then run the fuse out
	loop.simulate(TNT_PRIME_FUSE + 0.1);
	expect(mutations).toBeGreaterThan(0);
});

it('notifies onWorldMutated when liquid spreads', () => {
	const { loop, world } = makeLoop();
	let mutations = 0;
	loop.onWorldMutated = () => { mutations++; };
	// pour water via world.setBlockFlow at (260,40,260)
	loop.simulate(1.0);
	expect(mutations).toBeGreaterThan(0);
});

it('does not notify on ticks that change nothing', () => {
	const { loop } = makeLoop();
	let mutations = 0;
	loop.onWorldMutated = () => { mutations++; };
	for (let i = 0; i < 20; i++) loop.simulate(0.016);
	expect(mutations).toBe(0);
});
```

The third test is the one that stops the fix from becoming a permanent full-world re-upload. `liquid-scheduler.test.ts` already has a `freshWorld()` helper — reuse it for a settled pool fixture.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/game/loop.test.ts`
Expected: FAIL — `simulate` does not exist; once it does, `mutations` stays 0 for the first two.

- [ ] **Step 3: Implement**

1. Extract a public `simulate(dt: number): void` on `GameLoop` containing just `scheduler.tick(dt)` + `updatePrimedTnt(dt)`; the private `tick(dt)` calls it and keeps the per-tick meshing. This keeps the test off worldgen and meshing.
2. Add `onWorldMutated: (() => void) | null = null;`.
3. `LiquidScheduler`: add `private changed = false`, reset at the top of `tick()`, set `true` at **every** `world.setBlockFlow` / `world.setBlock` call site in the scheduler, and change the signature to `tick(dt: number): boolean`. Existing liquid-scheduler tests ignore the return value, so this is backward compatible.
4. In `simulate`, fire `this.onWorldMutated?.()` if the scheduler reported a change **or** if `updatePrimedTnt` detonated anything. Also fire at the end of `detonateAt`.
5. `src/main.ts`, beside `loop.onBlockBroken` (~line 236):

```ts
loop.onWorldMutated = () => autosave.markDirty();
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run` — no previously-passing test may fail.

- [ ] **Step 5: Commit**

```bash
git add src/game/loop.ts src/game/liquid-scheduler.ts src/game/loop.test.ts src/main.ts
git commit -m "fix(game): arm autosave on TNT detonation and liquid spread"
```

---

### Task 3: Write chunks before meta

The worst corruption path in the design. Today `saveWorld` writes meta first (`src/persistence/localStorage.ts:53`); a quota error mid-chunk-loop leaves **new** meta with a fresh `updatedAt` over **mixed** old/new chunks. Every chunk still decodes, so server validation would pass and the fresh timestamp would win arbitration — uploading a Frankenstein world over the good cloud copy.

**Files:**
- Modify: `src/persistence/localStorage.ts`
- Test: `src/persistence/localStorage.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('leaves the old updatedAt when a save is interrupted by quota', async () => {
	const storage = new MemStorage();
	const adapter = new LocalStorageAdapter(storage as unknown as Storage);
	const first = sampleSave(7);
	first.updatedAt = 1000;
	await adapter.saveWorld(first);

	let writes = 0;
	const realSet = storage.setItem.bind(storage);
	storage.setItem = (k: string, v: string) => {
		if (++writes > 1) {
			const e = new DOMException('full', 'QuotaExceededError');
			throw e;
		}
		realSet(k, v);
	};

	const second = { ...sampleSave(7), updatedAt: 2000 };
	await expect(adapter.saveWorld(second)).rejects.toThrow('QUOTA_EXCEEDED');

	storage.setItem = realSet;
	const loaded = await adapter.loadWorld(7);
	expect(loaded?.updatedAt).toBe(1000);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/persistence/localStorage.test.ts`
Expected: FAIL — `updatedAt` is 2000, because meta was written first.

- [ ] **Step 3: Implement**

Reorder `saveWorld`: encode all chunks, write every chunk key, run the prune sweep, and write the meta key **last**. Keep the `QuotaExceededError → 'QUOTA_EXCEEDED'` normalization exactly as-is.

**Correct the rationale before implementing.** §5 now arbitrates by GCS generation and demotes `updatedAt` to display-only, so "the fresh timestamp wins arbitration" no longer describes the system. The fix still matters for a different reason: it keeps the *local* store self-consistent. And note the residual it leaves — chunks-first means a torn save has **newer chunks under an older meta**, and for a local-only world (the §9 default when the env var is absent) there is no cloud copy to arbitrate against, so that mixed world is simply what loads. That is strictly better than the reverse, but it is not nothing.

**Strengthen the fixture.** Gate 2 ran the test above verbatim and confirmed it goes red correctly — but with a 1-chunk `sampleSave` it works by coincidence of write-counting and proves only the timestamp. Add an ordering-agnostic variant: 4 chunks with distinguishable fills, throw on the 3rd write whose key matches `:chunk:`, and assert **both** `updatedAt === 1000` **and** that the on-disk chunk fills are not all from the same generation (`new Set(fills).size > 1` against current code, proving the mixture is real).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run`

- [ ] **Step 5: Commit**

```bash
git add src/persistence/localStorage.ts src/persistence/localStorage.test.ts
git commit -m "fix(persistence): write chunks before meta so torn saves keep the old timestamp"
```

---

### Task 4: v2 world format — uuid identity

**Files:**
- Modify: `src/persistence/adapter.ts`, `src/persistence/localStorage.ts`, `src/persistence/autosave.ts`, `src/ui/menu.ts`, `src/main.ts`
- Create: `src/persistence/uuid.ts`
- Test: `src/persistence/localStorage.test.ts`, `src/persistence/uuid.test.ts`

**Interfaces:**
- Produces: `WorldSave.version: 2` + `id: string`; `WorldSummary.{id, origin, sizeBytes?, degraded?}`; `SaveResult`; `PersistenceAdapter.loadWorld(id: string)` / `deleteWorld(id: string)`; `newWorldId(): string`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/persistence/uuid.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { newWorldId } from './uuid';

const RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newWorldId', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('produces a v4 uuid', () => {
		expect(newWorldId()).toMatch(RE);
	});

	it('works without crypto.randomUUID (insecure LAN dev origin)', () => {
		vi.stubGlobal('crypto', {});
		expect(newWorldId()).toMatch(RE);
	});
});
```

```ts
// src/persistence/localStorage.test.ts — additions
it('normalizes a legacy v1 world to v2 on load', async () => {
	// write raw v1 keys exactly as the existing legacy test at :147 does
	const loaded = await adapter.loadWorld('legacy:42');
	expect(loaded?.version).toBe(2);
	expect(loaded?.id).toBe('legacy:42');
	expect(loaded?.seed).toBe(42);
});

it('leaves v1 keys untouched when the same world is saved as v2', async () => {
	// seed raw v1 keys, then save a v2 world with a fresh uuid
	await adapter.saveWorld({ ...sampleSave(42), version: 2, id: 'a-uuid' } as WorldSave);
	expect(storage.getItem('minicraft:v1:world:42:meta')).not.toBeNull();
});

it('lists both namespaces with an origin', async () => {
	const list = await adapter.listWorlds();
	expect(list.every((w) => w.origin === 'local')).toBe(true);
	expect(list.map((w) => w.id)).toContain('legacy:42');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/persistence/`
Expected: FAIL — `newWorldId` does not exist; `loadWorld` takes a number.

- [ ] **Step 3: Implement**

```ts
// src/persistence/uuid.ts
// crypto.randomUUID is undefined outside a secure context — a tablet hitting the
// LAN dev server over plain http is exactly that case.
export function newWorldId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	const b = new Uint8Array(16);
	if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
		crypto.getRandomValues(b);
	} else {
		for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
	}
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	const h = [...b].map((x) => x.toString(16).padStart(2, '0'));
	return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
}
```

In `adapter.ts` apply the type changes from spec §4 verbatim, including:

```ts
export type SaveResult = {
	local: 'ok' | 'quota' | 'error';
	cloud: 'ok' | 'failed' | 'skipped';
};
```

In `localStorage.ts`: add the `minicraft:v2:world:{id}:...` key scheme; keep v1 read paths; `loadWorld(id)` accepts both a uuid and `legacy:{seed}`; **stamp `{version: 2, id}` on the returned object** (it currently spreads stored meta, so a v1 world would carry `version: 1, id: undefined`); `listWorlds()` scans both namespaces and sets `origin: 'local'`; `saveWorld` returns `SaveResult`.

> **The compiler will not help you here.** `loadWorld` does `JSON.parse(metaRaw) as Omit<WorldSave,'chunks'>` and then returns `{...meta, chunks}`. That cast makes tsc believe `id` exists, so adding a required `id` produces errors in 3 files but **not** in `localStorage.ts`. The "normalizes a legacy v1 world to v2 on load" test is the only thing standing between you and a world that loads with `id: undefined`.

> **Do not bump the 4th `version: 1`.** Three typed sites (`localStorage.test.ts` 31/109/132) plus `autosave.ts:43` must become `2`. The occurrence near `localStorage.test.ts:158` is a **raw JSON string inside the pre-Task-6 legacy on-disk fixture** — tsc cannot see it and it must stay `1`, or the legacy-format regression test is silently gutted.

**Legacy worlds mint a UUID on first play** — this is the highest-severity finding of gate 2 and it belongs here, not in Task 11. Because v1 keys are write-forbidden, continuing world seed 42 would otherwise save under `minicraft:v2:world:legacy:42:*`. On the next launch `listWorlds()` yields **two rows with the same id** `legacy:42`, `loadWorld('legacy:42')` returns the **v1** copy, and the whole previous session is invisible. Worse, `main.ts:82` then marks every loaded (v1) chunk modified, the first autosave writes that set back, and the v2 prune sweep deletes the newer session's chunk keys — the rollback becomes permanent. Since every one of the kid's worlds is v1 and "continue without pressing Upload" is the default action, this would hit on first contact.

So: the first time a legacy world is played, mint a UUID immediately, record it in `minicraft:v2:legacy-map:{seed}`, and **never write a v2 record under a `legacy:` id**. Required tests: *"playing a legacy world twice does not roll back"* and *"listWorlds never returns two rows with the same id"*.

**Two fields the later tasks depend on, defined here or nowhere:**

```ts
export type EncodedChunk = { cx: number; cz: number; blocks: string; fluidMeta?: string };

// saveWorld may receive chunks already encoded, so DualAdapter encodes once for both legs.
saveWorld(save: WorldSave, pre?: EncodedChunk[]): Promise<SaveResult>;
```

and `lastSyncedGeneration: string | null` persisted in the v2 meta record — written on every successful PUT and on every load that adopts the cloud copy. §5's whole ancestor test reads this field; without it Task 9's divergence check has nowhere to live, and an implementer either drops the check (silent overwrite) or forks a "copy from this device" world on **every** launch.

`autosave.ts` builds `version: 2` and carries the world id. `menu.ts`'s `MenuAction` becomes `{type:'continue'; id: string}` and `renderNew` mints the id with `newWorldId()`. `main.ts` routes by id.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run` — all prior tests must still pass; update the 4 test sites that assert `version: 1`.

- [ ] **Step 5: Commit**

```bash
git add src/persistence src/ui/menu.ts src/main.ts
git commit -m "feat(persistence): v2 world format with uuid identity"
```

---

### Task 5: API scaffold, codec copy, and schema

**Files:**
- Create: `api/package.json`, `api/tsconfig.json`, `api/.gcloudignore`, `api/src/codec.ts`, `api/src/schema.ts`, `api/src/codec.parity.test.ts`, `api/src/schema.test.ts`

**Interfaces:**
- Produces: `worldSaveWireSchema` (zod), `decodeChunk`, `decodeFluidMeta`, `BLOCKS_PER_CHUNK`.

- [ ] **Step 1: Write the failing tests**

```ts
// api/src/codec.parity.test.ts
import { describe, it, expect } from 'vitest';
import { encodeChunk as clientEncode } from '../../src/persistence/codec';
import { decodeChunk as serverDecode, BLOCKS_PER_CHUNK } from './codec';

describe('codec parity', () => {
	it('server decodes what the client encodes', () => {
		const blocks = new Uint8Array(BLOCKS_PER_CHUNK);
		for (let i = 0; i < BLOCKS_PER_CHUNK; i++) blocks[i] = i % 19;
		expect(serverDecode(clientEncode(blocks))).toEqual(blocks);
	});
});
```

```ts
// api/src/schema.test.ts
import { describe, it, expect } from 'vitest';
import { worldSaveWireSchema } from './schema';
import { validWire } from './testFixtures';

describe('worldSaveWireSchema', () => {
	it('accepts a negative seed', () => {
		expect(worldSaveWireSchema.safeParse({ ...validWire(), seed: -12345 }).success).toBe(true);
	});
	it('accepts negative float player coordinates', () => {
		const w = validWire();
		w.player = { ...w.player, x: -3.5, y: 61.25, z: -0.001, yaw: -3.1, pitch: 0.2 };
		expect(worldSaveWireSchema.safeParse(w).success).toBe(true);
	});
	it('accepts zero chunks', () => {
		expect(worldSaveWireSchema.safeParse({ ...validWire(), chunks: [] }).success).toBe(true);
	});
	it('rejects duplicate chunk coordinates', () => {
		const w = validWire();
		w.chunks = [w.chunks[0], { ...w.chunks[0] }];
		expect(worldSaveWireSchema.safeParse(w).success).toBe(false);
	});
	it('rejects out-of-range chunk coordinates', () => {
		const w = validWire();
		w.chunks = [{ ...w.chunks[0], cx: 32 }];
		expect(worldSaveWireSchema.safeParse(w).success).toBe(false);
	});
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run api/`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement**

**There must be a build, or the deployed function will not start.** Gate 2 reproduced the plan's original `api/` layout and ran functions-framework against it: `Provided code location ... is not a loadable module. Could not load the function, shutting down.` `gcloud functions deploy` still exits 0, so the deploy looks green and every request 500s. Two causes: the GCP Node buildpack runs `npm run build` only if that script exists, and functions-framework resolves its target through `package.json` `main`. Both were missing.

`api/package.json` — the verified-working shape:

```json
{
	"name": "minicraft-api",
	"main": "build/index.js",
	"scripts": { "build": "tsc" },
	"dependencies": {
		"@google-cloud/functions-framework": "^3.4.0",
		"@google-cloud/storage": "^7.0.0",
		"express": "^4.19.0",
		"pako": "^2.1.0",
		"zod": "^3.23.0"
	},
	"devDependencies": {
		"@types/express": "^4.17.21",
		"@types/node": "^22.0.0",
		"@types/pako": "^2.0.3",
		"supertest": "^7.0.0",
		"@types/supertest": "^6.0.2",
		"typescript": "~5.6.0"
	}
}
```

**`pako` is a runtime dependency, not a dev one** — `src/persistence/codec.ts:1` is `import { deflate, inflate } from 'pako'`, and this task copies that file. Unit tests would never catch its absence because the root `node_modules` hoists it; the failure appears only after the buildpack prunes devDependencies, as a 500 on the first PUT.

`api/tsconfig.json` must be **separate** from the root one (which is `noEmit: true` and does not include `api/`): `"module": "commonjs"`, `"outDir": "build"`, `"rootDir": "src"`, `"exclude": ["src/**/*.test.ts"]`.

`api/.gcloudignore` must exclude `node_modules/` and `*.test.ts`, and must **not** exclude `src/` (the buildpack compiles in the cloud). With no `.gcloudignore` gcloud falls back to `.gitignore`, which ignores `dist` — hence `build/` as the `outDir`, to sidestep the collision. Note `api/src/codec.parity.test.ts` imports `../../src/persistence/codec`, a path outside the upload root, so it must be excluded.

Then: `cd api && npm install` (nothing else in the plan installs these, and Task 5 Step 4 runs vitest over `api/src/**/*.test.ts`, which imports `zod` and `supertest`).

Copy `src/persistence/codec.ts` to `api/src/codec.ts` and add `BLOCKS_PER_CHUNK = 16 * 64 * 16` (do not import across the boundary — the function deploys from `api/` alone).

`api/src/schema.ts`:

```ts
import { z } from 'zod';

const int = z.number().int();

export const worldSaveWireSchema = z
	.object({
		version: z.literal(2),
		id: z.string().uuid(),
		seed: int,                                  // int32, may be negative
		name: z.string().min(1).max(64),
		createdAt: int.nonnegative(),
		updatedAt: int.nonnegative(),
		player: z.object({
			x: z.number(), y: z.number(), z: z.number(),
			yaw: z.number(), pitch: z.number(),
			hotbar: z.array(int).max(64),
			selected: int.nonnegative(),
		}),
		chunks: z
			.array(z.object({
				cx: int.min(0).max(31),
				cz: int.min(0).max(31),
				blocks: z.string(),
				fluidMeta: z.string().optional(),
			}))
			.max(1024),
		lights: z.array(z.object({
			x: int, y: int, z: int, color: z.string().max(32),
		})).max(4096).optional(),
	})
	.superRefine((w, ctx) => {
		const seen = new Set<string>();
		for (const c of w.chunks) {
			const k = `${c.cx},${c.cz}`;
			if (seen.has(k)) ctx.addIssue({ code: 'custom', message: `duplicate chunk ${k}` });
			seen.add(k);
		}
	});

export type WorldSaveWire = z.infer<typeof worldSaveWireSchema>;
```

Add `api/src/testFixtures.ts` exporting `validWire()`.

Add `api/` to the root `vitest.config.ts` `include` so one command runs everything:
`include: ['src/**/*.test.ts', 'api/src/**/*.test.ts']`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run`

- [ ] **Step 5: Commit**

```bash
git add api vitest.config.ts
git commit -m "feat(api): scaffold cloud function with codec copy and zod schema"
```

---

### Task 6: API handlers

**Files:**
- Create: `api/src/handlers.ts`, `api/src/index.ts`, `api/src/fakeStorage.ts`, `api/src/handlers.test.ts`

**Interfaces:**
- Consumes: `worldSaveWireSchema`, `decodeChunk`, `decodeFluidMeta` (Task 5).
- Produces: `createApp(bucket: BucketLike): express.Express`.

- [ ] **Step 1: Write the failing tests**

Cover every rule in spec §2/§3. At minimum:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from './handlers';
import { FakeBucket } from './fakeStorage';
import { validWire } from './testFixtures';

describe('worlds API', () => {
	let bucket: FakeBucket;
	let app: ReturnType<typeof createApp>;
	beforeEach(() => { bucket = new FakeBucket(); app = createApp(bucket); });

	it('round-trips a world', async () => {
		const w = validWire();
		await request(app).put(`/worlds/${w.id}`).send(w).expect(200);
		const got = await request(app).get(`/worlds/${w.id}`).expect(200);
		expect(got.body).toEqual(w);
	});

	it('lists worlds from metadata without reading bodies', async () => {
		const w = validWire();
		await request(app).put(`/worlds/${w.id}`).send(w).expect(200);
		bucket.failOnDownload = true;
		const list = await request(app).get('/worlds').expect(200);
		expect(list.body[0]).toMatchObject({ id: w.id, name: w.name, seed: w.seed });
	});

	it('rejects a non-uuid id before touching storage', async () => {
		// NOT '/worlds/../../etc/passwd' — supertest normalizes that to /etc/passwd
		// before it leaves the client, so the route never matches and the server
		// returns 404. The test would be unpassable on any correct implementation.
		for (const bad of [
			'/worlds/not-a-uuid',
			'/worlds/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd',
			`/worlds/${'a'.repeat(500)}`,
		]) {
			await request(app).get(bad).expect(400);
		}
		expect(bucket.calls).toBe(0);
	});

	it('sets CORS headers on error responses too', async () => {
		const r = await request(app).get('/worlds/not-a-uuid').expect(400);
		expect(r.headers['access-control-allow-origin']).toBeTruthy();
		const n = await request(app).get('/worlds/33333333-3333-4333-8333-333333333333').expect(404);
		expect(n.headers['access-control-allow-origin']).toBeTruthy();
	});

	it('returns the generation in the PUT response body', async () => {
		const w = validWire();
		const r = await request(app).put(`/worlds/${w.id}`).send(w).expect(200);
		expect(r.body.generation).toBeTruthy();
		expect(r.body.updatedAt).toBe(w.updatedAt);
	});

	it('rejects a body whose id disagrees with the path', async () => {
		const w = validWire();
		await request(app).put('/worlds/11111111-1111-4111-8111-111111111111').send(w).expect(400);
	});

	it('leaves the stored object unchanged when a chunk is corrupt', async () => {
		const w = validWire();
		await request(app).put(`/worlds/${w.id}`).send(w).expect(200);
		const bad = { ...w, chunks: [{ ...w.chunks[0], blocks: 'not-base64!!' }] };
		await request(app).put(`/worlds/${w.id}`).send(bad).expect(400);
		const got = await request(app).get(`/worlds/${w.id}`).expect(200);
		expect(got.body).toEqual(w);
	});

	it('rejects a suspicious shrink', async () => {
		const w = { ...validWire(), chunks: manyChunks(10) };
		await request(app).put(`/worlds/${w.id}`).send(w).expect(200);
		await request(app).put(`/worlds/${w.id}`).send({ ...w, chunks: manyChunks(2) }).expect(400);
	});

	it('returns 409 on a generation mismatch', async () => {
		const w = validWire();
		await request(app).put(`/worlds/${w.id}`).send(w).expect(200);
		await request(app).put(`/worlds/${w.id}`).set('If-Match', '999').send(w).expect(409);
	});

	it('never skips a world whose metadata is unreadable', async () => {
		bucket.putRaw('worlds/22222222-2222-4222-8222-222222222222.json', '{}', {});
		const list = await request(app).get('/worlds').expect(200);
		expect(list.body).toHaveLength(1);
		expect(list.body[0].degraded).toBe(true);
	});

	it('answers CORS preflight', async () => {
		const r = await request(app).options('/worlds').expect(204);
		expect(r.headers['access-control-allow-origin']).toBeTruthy();
	});

	it('404s a missing world', async () => {
		await request(app).get('/worlds/33333333-3333-4333-8333-333333333333').expect(404);
	});
});
```

Add `supertest` + `@types/supertest` to `api` devDependencies.

- [ ] **Step 1b: The 413 test must run through the real server**

Spec line 146 is explicit and the original plan dropped it. `createApp` under supertest is a **bare Express app** — the very instrument the spec says is insufficient, because under functions-framework the body is already buffered at `limit: '1024mb'` before the handler runs. A 413 test against the bare app proves nothing about production.

Write it against the built output driven by functions-framework (`npx functions-framework --target=minicraftApi --source=api/build` on an ephemeral port, or FF's exported `getServer`), sending an over-cap `content-length`. Under FF the guard is a **policy** check, not a resource guard; the real ceiling is the platform's 32 MB gen2 request limit.

**`FakeBucket` must implement `ifGenerationMatch` semantics**, including `0` meaning "must not exist" — otherwise the 409 test passes vacuously. Specify: `save(name, contents, {ifGenerationMatch})` throws a 412-shaped error on mismatch; each successful save increments a monotonic generation. Also define `validWire()` (fixed uuid, 1 chunk) and `manyChunks(n)` (n distinct `(cx,cz)` pairs), since the shrink-guard test is only meaningful when the stored object has more than 4 chunks.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run api/src/handlers.test.ts`
Expected: FAIL — `createApp` does not exist.

- [ ] **Step 3: Implement**

`api/src/handlers.ts`. Order matters:

1. CORS middleware first, applied to **every** response including errors; `OPTIONS` → 204.
2. A `content-length` guard as the **first** thing in the PUT path — over 32 MB → 413 before reading `req.body`.
3. UUID regex check → 400.
4. zod parse → 400.
5. `id` in body vs path → 400.
6. Decode **every** `blocks` and **every** present `fluidMeta` (reject any `fluidMeta` index ≥ 16384) → 400.
7. Shrink guard: stored chunk count > 4 and incoming < 50% of it → 400.
8. Write with `ifGenerationMatch`: the `If-Match` header when present, `0` when the client sends `If-None-Match: *` (its way of saying "this world is new"), and **reject a PUT that carries neither with 428** — no precondition means no protection, and silently allowing it is how the concurrency design gets bypassed. GCS 412 → **409** (412 is never returned to the client; the contract in spec §2 lists only 400/409/413/500).
9. Set custom metadata `{name, seed, createdAt, updatedAt}` and `Cache-Control: no-store` on the write.

`GET /worlds` prefix-lists `worlds/`, filters to keys matching exactly `worlds/{uuid}.json`, and builds summaries from custom metadata + object `generation` and `size`. **A world with missing or unparseable metadata is returned with `degraded: true` and a synthesized name, never skipped.**

`DELETE` uses `ifGenerationMatch` as a precondition on a plain delete — never a generation-targeted delete.

`api/src/index.ts` registers the app with functions-framework:

```ts
import * as ff from '@google-cloud/functions-framework';
import { Storage } from '@google-cloud/storage';
import { createApp } from './handlers';

const bucket = new Storage().bucket(process.env.WORLDS_BUCKET ?? 'minicraft-worlds');
ff.http('minicraftApi', createApp(bucket));
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run`

- [ ] **Step 5: Commit**

```bash
git add api
git commit -m "feat(api): worlds list/get/put/delete with validation and shrink guard"
```

---

### Task 7: Provision, deploy.sh, and smoke test

**Files:**
- Create: `deploy.sh`, `api/scripts/smoke.ts`, `.env.example`

- [ ] **Step 1: Write `deploy.sh`**

```bash
#!/usr/bin/env bash
# Deploys the Minicraft save API only. It must never touch the website bucket
# gs://noah.leap-forward.ca — Julien deploys the front end himself.
set -euo pipefail

PROJECT="qs-trading"
REGION="us-central1"
BUCKET="minicraft-worlds"
FUNCTION="minicraft-api"

echo "==> Ensuring bucket gs://${BUCKET}"
if ! gcloud storage buckets describe "gs://${BUCKET}" --project="${PROJECT}" >/dev/null 2>&1; then
	gcloud storage buckets create "gs://${BUCKET}" \
		--project="${PROJECT}" --location="${REGION}" --uniform-bucket-level-access
fi

echo "==> Enabling versioning and a 90-day soft-delete net"
gcloud storage buckets update "gs://${BUCKET}" --project="${PROJECT}" \
	--versioning --soft-delete-duration=90d

echo "==> Granting the runtime SA object access (idempotent, must follow bucket creation)"
SA="$(gcloud projects describe "${PROJECT}" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
	--project="${PROJECT}" --member="serviceAccount:${SA}" --role=roles/storage.objectAdmin >/dev/null

echo "==> Applying lifecycle (ONE rule: conditions AND together)"
LIFECYCLE=$(mktemp)
cat > "${LIFECYCLE}" <<'JSON'
{"lifecycle":{"rule":[{"action":{"type":"Delete"},
  "condition":{"daysSinceNoncurrentTime":90,"numNewerVersions":10}}]}}
JSON
gcloud storage buckets update "gs://${BUCKET}" --project="${PROJECT}" --lifecycle-file="${LIFECYCLE}"
rm -f "${LIFECYCLE}"

echo "==> Deploying ${FUNCTION}"
gcloud functions deploy "${FUNCTION}" \
	--project="${PROJECT}" --region="${REGION}" --gen2 \
	--runtime=nodejs22 --source=api --entry-point=minicraftApi \
	--trigger-http --allow-unauthenticated \
	--memory=512Mi --timeout=60s --max-instances=3 \
	--set-env-vars="WORLDS_BUCKET=${BUCKET}"

URL=$(gcloud functions describe "${FUNCTION}" --project="${PROJECT}" --region="${REGION}" \
	--format="value(serviceConfig.uri)")
echo "==> Deployed: ${URL}"
echo "Set VITE_MINICRAFT_API_URL=${URL} in .env.local for local dev."
```

`chmod +x deploy.sh`.

The IAM binding lives **inside** `deploy.sh`, after the bucket is created. The original plan ran it as a separate step beforehand — and `gs://minicraft-worlds` does not exist yet, so on the only run that matters, the first one, that command fails. If an operator shrugs past it the function deploys with no bucket permission, every request 500s, and `CloudAdapter` maps 500 → `SERVER` and retries with backoff forever. No data lost, but it looks like a network blip rather than a misconfiguration.

- [ ] **Step 2: Deploy, then verify the deployed state matches the spec**

```bash
./deploy.sh
./deploy.sh --verify
```

`--verify` reads back and asserts, exiting non-zero on any mismatch:
- versioning is enabled,
- the lifecycle has **exactly one rule with both conditions** (`daysSinceNoncurrentTime: 90` **and** `numNewerVersions: 10`) — the two-rule OR form silently purges a deleted world's only backup at day 90,
- the IAM binding is present,
- `GET /health` returns 200 (this is what catches the missing-build failure, which `gcloud functions deploy` reports as success).

Nothing else in this plan ever checks that the safety net is actually configured.

- [ ] **Step 3: Write and run the smoke test**

`api/scripts/smoke.ts` runs against `$MINICRAFT_API_URL` with **throwaway uuids only**: PUT → GET (assert byte-identical) → LIST (assert present) → DELETE → GET (assert 404). Include one world with an emoji name (`'Château 🏰 Noah'`) and one near-maximum-size PUT.

Run: `MINICRAFT_API_URL=<url> npx tsx api/scripts/smoke.ts`
Expected: every assertion passes.

- [ ] **Step 4: Verify the site bucket was not touched**

```bash
gcloud storage ls gs://noah.leap-forward.ca/minicraft/ | head
```
Expected: unchanged — `index.html`, `atlas.json`, `atlas.png`, `assets/`.

- [ ] **Step 5: Commit**

```bash
git add deploy.sh api/scripts/smoke.ts .env.example
git commit -m "feat(api): deploy script, bucket provisioning, and smoke test"
```

---

### Task 8: CloudAdapter

**Files:**
- Create: `src/persistence/cloud.ts`, `src/persistence/cloud.test.ts`

**Interfaces:**
- Produces: `CloudAdapter implements PersistenceAdapter`, plus `CloudError` with `code: 'NETWORK' | 'CONFLICT' | 'TOO_LARGE' | 'SERVER' | 'NOT_FOUND'`.

- [ ] **Step 1: Write the failing tests**

Against a `fetch` stub. Critical case — the 412 self-write check:

```ts
it('treats a 412 whose stored updatedAt matches our attempt as our own committed write', async () => {
	const save = { ...v2Save(), updatedAt: 5000 };
	const fetchStub = vi.fn()
		// 409, not 412: Task 6 maps the GCS 412 to 409 and the API contract in spec
		// §2 never exposes 412. Stubbing 412 builds an adapter whose recovery path
		// never fires in production.
		.mockResolvedValueOnce({ ok: false, status: 409 })
		.mockResolvedValueOnce({
			ok: true, status: 200,
			headers: new Headers({ 'X-Generation': '77' }),
			json: async () => ({ ...save, updatedAt: 5000 }),
		});
	vi.stubGlobal('fetch', fetchStub);
	const a = new CloudAdapter('https://api.test');
	await expect(a.saveWorld(save)).resolves.toBeDefined();   // success, not CONFLICT
	expect(a.generationFor(save.id)).toBe('77');
});

it('reports CONFLICT when the stored updatedAt differs', async () => { /* 409 then a different updatedAt */ });
it('maps 413 to TOO_LARGE and does not retry', async () => {});
it('maps a thrown fetch to NETWORK', async () => {});
it('maps 404 to NOT_FOUND', async () => {});

it('uses ifGenerationMatch:0 for the first PUT of a world loaded offline', async () => {
	// The tablet loaded this world from local storage with the cloud unreachable,
	// so it never adopted a cloud generation. Fetching the CURRENT generation here
	// would match whatever the desktop wrote in the meantime and overwrite it with
	// no 409 and no conflict copy.
	const a = new CloudAdapter('https://api.test');
	a.markUnsynced(save.id);
	await a.saveWorld(save).catch(() => {});
	expect(sentHeaders()['If-None-Match']).toBe('*');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/persistence/cloud.test.ts`

- [ ] **Step 3: Implement**

Encode chunks with the client codec. Keep an in-memory `Map<id, generation>` populated on load and on successful PUT. **The generation sent as `If-Match` is the one the world was loaded from — a comparison fetch must never refresh it.** A confirmed self-write (the 409 recovery above) counts as a successful PUT and does adopt the new generation; state that explicitly, because otherwise the two rules read as contradictory.

**A world that was loaded without adopting a cloud copy is `unsynced`, and its first PUT sends `If-None-Match: *`, never a freshly-fetched generation.** The original rule — "when no generation is cached, GET the current one and PUT with it" — reopens the exact hole the loaded-from rule was written to close: a tablet that played offline comes back, fetches the generation the *desktop* just wrote, matches the precondition, and overwrites a month of building with a 200. Persist `lastSyncedGeneration` (Task 4) so this survives a page reload.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run`

- [ ] **Step 5: Commit**

```bash
git add src/persistence/cloud.ts src/persistence/cloud.test.ts
git commit -m "feat(persistence): cloud adapter with generation preconditions"
```

---

### Task 9: DualAdapter

**Files:**
- Create: `src/persistence/dual.ts`, `src/persistence/dual.test.ts`

**Interfaces:**
- Consumes: `LocalStorageAdapter`, `CloudAdapter`.
- Produces: `DualAdapter implements PersistenceAdapter`, `saveWorld(): Promise<SaveResult>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('still writes locally when the cloud leg fails', async () => {
	const r = await dual.saveWorld(save);
	expect(r).toEqual({ local: 'ok', cloud: 'failed' });
	expect(await local.loadWorld(save.id)).not.toBeNull();
});

it('still writes to the cloud when localStorage is full', async () => {
	local.saveWorld = async () => { throw new Error('QUOTA_EXCEEDED'); };
	const r = await dual.saveWorld(save);
	expect(r).toEqual({ local: 'quota', cloud: 'ok' });
});

it('skips the cloud leg for a legacy world', async () => {
	const r = await dual.saveWorld({ ...save, id: 'legacy:42' });
	expect(r.cloud).toBe('skipped');
});

it('encodes chunks once for both legs', async () => {
	// vi.spyOn on the codec module DOES intercept under Vitest's SSR transform —
	// verified. The trap is the interface: this is only reachable because Task 4
	// added `saveWorld(save, pre?: EncodedChunk[])`. Without that carrier both
	// adapters encode internally and 2N calls is the only legal outcome.
	const spy = vi.spyOn(codec, 'encodeChunk');
	await dual.saveWorld(save);
	expect(spy).toHaveBeenCalledTimes(save.chunks.length);
});

it('does not fork a copy when the local copy is an ancestor of the cloud copy', async () => {
	await seedLocal({ ...save, lastSyncedGeneration: '5' });
	await seedCloud(save, { generation: '5' });
	await dual.loadWorld(save.id);
	const list = await dual.listWorlds();
	expect(list.filter((w) => w.name.includes('copy from'))).toHaveLength(0);
});

it('keeps both copies exactly once when they genuinely diverge', async () => {
	// local was last synced at gen 5; the cloud has moved to gen 9 independently
	await seedLocal({ ...save, lastSyncedGeneration: '5', name: 'Castle' });
	await seedCloud({ ...save, name: 'Castle' }, { generation: '9' });
	await dual.loadWorld(save.id);
	await dual.loadWorld(save.id);
	await dual.loadWorld(save.id);
	const copies = (await dual.listWorlds()).filter((w) => w.name.includes('copy from'));
	expect(copies).toHaveLength(1);
});

it('falls back to the local copy on a cloud 404', async () => {
	cloud.loadWorld = async () => { throw new CloudError('NOT_FOUND'); };
	expect(await dual.loadWorld(save.id)).not.toBeNull();
});

it('does not delete locally when the cloud delete fails', async () => {
	cloud.deleteWorld = async () => { throw new CloudError('NETWORK'); };
	await expect(dual.deleteWorld(save.id)).rejects.toThrow();
	expect(await local.loadWorld(save.id)).not.toBeNull();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/persistence/dual.test.ts`

- [ ] **Step 3: Implement**

Both legs attempted independently via `Promise.allSettled`; neither short-circuits the other. Encode once and pass the `EncodedChunk[]` to both via the `pre` parameter Task 4 added.

The two divergence tests above must be able to go red **in both directions**: an implementation that never forks fails the second, and one that forks on every launch fails the first and the "exactly one" assertion. Three consecutive loads producing three "Castle (copy from this device)" rows is the realistic failure — and a menu full of near-identical worlds is how a seven-year-old deletes the real one. Arbitration by GCS generation, never by wall clock. On divergence, PUT the local copy as a **new visible world** named `<name> (copy from this device)` before loading the cloud copy. Cloud 404 with a local copy → load local and mark for upload. Delete: cloud first, local only on success; v1 keys never touched.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run`

- [ ] **Step 5: Commit**

```bash
git add src/persistence/dual.ts src/persistence/dual.test.ts
git commit -m "feat(persistence): dual adapter with independent legs and no-discard arbitration"
```

---

### Task 10: Autosave cloud cadence, retry, and unload

**Files:**
- Modify: `src/persistence/autosave.ts`
- Test: `src/persistence/autosave.test.ts`

**Interfaces:**
- Produces: `AutoSave.onStatus: (s: SaveStatus) => void`, `type SaveStatus = 'saved' | 'saving' | 'local-only' | 'error'`.

- [ ] **Step 1: Write the failing tests**

```ts
it('flushes locally on pagehide without attempting a cloud write', async () => {
	// keepalive fetch caps bodies at 64 KiB, so the cloud leg cannot run here
	listeners.get('pagehide')!();
	await vi.runAllTimersAsync();
	expect(local.saves).toBe(1);
	expect(cloud.saves).toBe(0);
	expect(needsUploadFlag(save.id)).toBe(true);
});

it('retries a NETWORK failure with backoff', async () => {
	cloudFailsOnce();
	a.markDirty();
	await a.flush().catch(() => {});
	await vi.advanceTimersByTimeAsync(1000);
	expect(cloud.saves).toBe(1);
});

it('does not retry TOO_LARGE', async () => {
	cloudFailsWith('TOO_LARGE');
	a.markDirty();
	await a.flush().catch(() => {});
	await vi.advanceTimersByTimeAsync(30_000);
	expect(cloud.saves).toBe(1);
	expect(status).toBe('error');
});

it('debounces the cloud leg at 30s while the local leg stays at 5s', async () => {
	a.markDirty();
	await vi.advanceTimersByTimeAsync(5_000);
	expect(local.saves).toBe(1);
	expect(cloud.saves).toBe(0);
	await vi.advanceTimersByTimeAsync(25_000);
	expect(cloud.saves).toBe(1);
});

it('reports local-only status when the cloud leg is failing', async () => {
	cloudFailsWith('NETWORK');
	a.markDirty();
	await a.flush().catch(() => {});
	expect(status).toBe('local-only');
});

it('maps a local-quota-but-cloud-ok save to a visible status', async () => {
	localFailsWith('QUOTA_EXCEEDED');
	a.markDirty();
	await a.flush();
	expect(status).not.toBe('saved');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/persistence/autosave.test.ts`

- [ ] **Step 3: Implement**

Local debounce stays 5 s; add a separate 30 s cloud debounce. **Correct the justification**: the spec's storage-cost figure has a unit error (it is ~720 MB per *hour*, not per day — and at ~$0.02/GB/month that is cents either way). The real argument is tablet uplink: 1.6 Mbps sustained at 5 s versus 267 kbps at 30 s. Fix the reasoning so a later reader does not "optimize" it back.

Backoff 1/2/4/8 s jittered for `NETWORK` and `SERVER` only.

**The unload path needs a synchronous local write.** `pagehide`'s handler is `() => void this.flush()`, and once the local leg is a `Promise.allSettled` arm inside an async `saveWorld`, nothing has been written by the time the handler returns — the document can be torn down immediately, taking both the local write and the `needsUpload` flag that the entire reconcile-on-next-launch story depends on. Add `saveLocalSync(save): void` to the adapter surface **in Task 4**, and have the `pagehide` handler call only that, writing `needsUpload` in the same synchronous block and awaiting nothing. Task 10's test asserting `cloud.saves === 0` requires this operation to exist; improvising it on the unload path is the worst possible place.

**No `keepalive` fetch and no `sendBeacon`** — both cap bodies at 64 KiB and a world is 3–16× that.

`visibilitychange → hidden` fires well before teardown on tablets, so attempt a **normal, non-keepalive** cloud flush there on a best-effort basis. Without it, a tab closed 29 s after the last cloud PUT leaves up to 30 s of edits reachable only via next-launch reconciliation *on that same device* — and "cache cleared before next launch" is precisely the scenario this feature exists for.

Drive `onStatus`. Map every `SaveResult` combination, including `{local:'quota', cloud:'ok'}`, which has no obvious home among the four status values.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run`

- [ ] **Step 5: Commit**

```bash
git add src/persistence/autosave.ts src/persistence/autosave.test.ts
git commit -m "feat(persistence): cloud save cadence, retry, and unload handling"
```

---

### Task 11: Menu and HUD

**Files:**
- Modify: `src/ui/menu.ts`, `src/ui/hud.ts`, `src/ui/ui.css`
- Test: `src/ui/menu.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Menu tests need a DOM. Add `// @vitest-environment jsdom` at the top of the file and `jsdom` to devDependencies.

```ts
it('shows cloud and legacy worlds in separate sections', async () => {});
it('shows an offline banner and still lists local worlds when the cloud list fails', async () => {});
it('disables the upload button while an upload is in flight', async () => {});
it('keeps the row and surfaces an error when delete fails', async () => {});
it('renders a degraded world with a recovered name', async () => {});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/ui/menu.test.ts`

- [ ] **Step 3: Implement**

Loading state; **Worlds** (cloud) and **On this device** (legacy/local-only, omitted when empty) sections; offline banner; per-legacy-row "Upload to cloud" button disabled while in flight; `try`/`catch` around delete (today there is none — a network throw would be an unhandled rejection plus a UI that re-renders as if the delete worked); `degraded` row rendering. Idempotent upload via the `minicraft:v2:legacy-map:{seed}` marker so a second press updates rather than forking. HUD save indicator bound to `onStatus`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run`

- [ ] **Step 5: Commit**

```bash
git add src/ui
git commit -m "feat(ui): cloud and legacy world sections with save status"
```

---

### Task 12: Wire it up and configure

**Files:**
- Modify: `src/main.ts`, `.env.example`
- Create: `.env.local` (gitignored, not committed)

- [ ] **Step 1: Implement**

`main.ts` builds `LocalStorageAdapter` always, and `CloudAdapter` only when `import.meta.env.VITE_MINICRAFT_API_URL` is set, composing them into a `DualAdapter`. With the var absent the game runs local-only and the menu shows "cloud saves not configured" — so `npm run dev` works for anyone without the URL and a mis-built bundle degrades instead of throwing. Pass the adapter into `startGame`/`AutoSave` instead of capturing the module-level one.

- [ ] **Step 2: Verify the full suite**

Run: `npx vitest run` and `npm run lint`

- [ ] **Step 3: Commit**

```bash
git add src/main.ts .env.example
git commit -m "feat(persistence): wire the dual adapter into the game"
```

---

### Task 13: Local browser verification against the deployed API

**Never** point any of this at `https://noah.leap-forward.ca/minicraft/`.

- [ ] **Step 0: Assert the deployed safety net**

```bash
./deploy.sh --verify
```
Expected: exit 0 — versioning on, one ANDed lifecycle rule, IAM bound, `/health` 200.

- [ ] **Step 1: Start the dev server against the deployed API**

```bash
echo "VITE_MINICRAFT_API_URL=<deployed url>" > .env.local
npm run dev
```

- [ ] **Step 2: Drive Chrome at `http://localhost:5173`**

Verify, in order:
0. Task 0's real exported worlds have been imported into the localhost origin. Without that, steps 5-6 rehearse on a synthetic world and prove nothing about the actual migration.
1. Menu loads; the imported legacy worlds appear under **On this device**, each with its correct name and world count matching Task 0 step 3.
2. Create a new world, dig several blocks, wait past the 30 s cloud debounce; the HUD shows `saved`.
3. `gcloud storage ls gs://minicraft-worlds/worlds/` shows the object.
4. Reload the page — the world appears under **Worlds** and loads with the edits intact.
5. Press **Upload to cloud** on a legacy world; confirm it appears in the bucket and **the v1 keys still exist** in DevTools → Application → Local Storage.
6. Press it a second time; confirm no duplicate world is created.
7. Ignite TNT, watch the crater resolve, and close the tab **within ~1 second** — waiting longer lets the 5 s local debounce save it anyway, so the test stops discriminating. Reopen and confirm the crater survived (Tasks 2 and 10).
7b. Play a legacy world **without** pressing Upload, dig a distinctive hole, return to the menu, reload, and reopen it. The hole must still be there, and the menu must show that world exactly once (Task 4's legacy-UUID rule — this is the rollback-and-prune failure).
8. Stop the dev server's network access (DevTools → Network → Offline); confirm the game keeps playing, the HUD reads `local only`, and edits persist locally. Restore the network and confirm the pending upload reconciles.

- [ ] **Step 3: Confirm the v1 keys and the site bucket are untouched**

In DevTools -> Application -> Local Storage, confirm every `minicraft:v1:*` key from Task 0's export is still present and byte-identical. Re-run Task 0's export snippet and diff it against the backup.

```bash
gcloud storage ls -L gs://noah.leap-forward.ca/minicraft/index.html | grep -i updated
```
Expected: the timestamp predates this work.

---

### Task 14: Documentation

**Files:**
- Create: `docs/persistence.md`
- Modify: `docs/specs.md`, `CLAUDE.md`, `README.md`

- [ ] **Step 1: Write `docs/persistence.md`**

Follow the per-subsystem convention of `lighting.md` / `liquids.md` / `movement.md`: the v1 and v2 formats, the adapter trio, the durability rule ("no code path discards a copy with edits the other lacks"), the API surface, and the 32 MB ceiling.

- [ ] **Step 2: Correct the stale docs**

- `docs/specs.md` §5/§7/§9: Phase 2 is a Cloud Function + GCS, not Cloud Run + Firestore; `zod` is now a real dependency.
- `CLAUDE.md`: delete the "pre-implementation / no `package.json` / no source code yet" claim — it is false and actively misleads agents.
- `README.md`: correct the test count (says 148).

- [ ] **Step 3: Commit**

```bash
git add docs CLAUDE.md README.md
git commit -m "docs(persistence): document cloud saves and correct stale claims"
```

---

## Self-Review

**Spec coverage.** §1 → Task 7. §2/§3 → Tasks 5–6. §4 → Task 4. §5 → Tasks 3, 4, 8, 9. §6 → Tasks 4, 11. §7 → Tasks 1, 2, 10. §8 → Task 11. §9 → Task 12. §10 → every task's tests plus Tasks 7 and 13. §11 risks are mitigated in Tasks 6, 7, 9. §12 → Task 14. The spec's `deploy:web` script is deliberately **dropped** — the user's instruction is that the website is never deployed by this work, so the script would be a footgun.

**Type consistency.** `SaveResult` is defined in Task 4 and consumed in Task 9; `CloudError.code` is defined in Task 8 and consumed in Tasks 9–10; `SaveStatus` is defined in Task 10 and consumed in Task 11; `newWorldId()` is defined in Task 4 and consumed in Task 11; `createApp(bucket)` is defined in Task 6 and consumed in Task 7.

**Ordering.** Task 0 backs up the real data before anything else. Task 1 (AutoSave tests) precedes every network task, per the spec's sequencing requirement. Task 7 deploys before Task 13 needs a URL.

**Gate 2 repairs incorporated.** Task 0 added (backup + import, gate 2's unanimous verdict). Task 1 landed early with the mid-save-edit fix. Task 2 rewritten against a harness that was actually built and run — the original referenced a non-existent test file, a private method, and an unconstructible `Renderer`. Task 4 gained `EncodedChunk`, `lastSyncedGeneration`, `saveLocalSync`, and the legacy-UUID-on-first-play rule that prevents a rollback-and-prune of the kid's worlds. Task 5 gained the build story (`main` + `build` script + commonjs tsconfig), without which the function deploys green and 500s on every request, plus the missing `pako` runtime dependency. Task 6's traversal test was unpassable and is replaced; the 413 test now runs through functions-framework; a PUT with no precondition is now a 428. Task 7 moved the IAM binding inside `deploy.sh` (it targeted a bucket that did not yet exist) and gained `--verify`. Task 8 stubs 409 rather than a 412 the API never returns, and adds the offline-cache-miss rule. Task 9's divergence test gained real fixtures so it can go red in both directions. Task 10's three empty test bodies are filled.

**Rejected from gate 2:** the claim that the test baseline is 182. Verified on a clean tree, `npx vitest run` reports **178 in 19 files**. That reviewer measured while its own probe files were in the tree — which is also why the plan now states the gate as "no previously-passing test fails" rather than an absolute count.
