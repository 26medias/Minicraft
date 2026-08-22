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
- Run `npx vitest run` before every commit. Baseline is **178 passing**; it must never go down.

---

### Task 1: Make AutoSave survivable — tests first

`src/persistence/autosave.ts` has zero tests and three bugs that each lose data once saves can fail. This must land before any network code exists (spec §10 sequencing).

**Files:**
- Modify: `src/persistence/autosave.ts`
- Test: `src/persistence/autosave.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `AutoSave` with `markDirty()`, `flush(): Promise<void>`, constructor unchanged except `onQuotaExceeded` becomes advisory (no latch).

- [ ] **Step 1: Write the failing tests**

`AutoSave` touches `window`/`document` in its constructor and the vitest env is `node`, so stub them first.

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AutoSave } from './autosave';
import type { PersistenceAdapter, WorldSave } from './adapter';
import type { World } from '../engine/world/world';

function stubDom() {
	const listeners = new Map<string, () => void>();
	vi.stubGlobal('window', { addEventListener: (e: string, f: () => void) => listeners.set(e, f) });
	vi.stubGlobal('document', {
		addEventListener: (e: string, f: () => void) => listeners.set(e, f),
		visibilityState: 'visible',
	});
	return listeners;
}

function fakeWorld(): World {
	return { seed: 1, modifiedChunks: () => [] } as unknown as World;
}

function fakeAdapter(saveWorld: (s: WorldSave) => Promise<void>): PersistenceAdapter {
	return {
		saveWorld,
		loadWorld: async () => null,
		listWorlds: async () => [],
		deleteWorld: async () => {},
	} as unknown as PersistenceAdapter;
}

const PLAYER = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, hotbar: [], selected: 0 };

describe('AutoSave failure handling', () => {
	beforeEach(() => { stubDom(); vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

	it('keeps the world dirty when a save fails, so the next flush retries', async () => {
		let calls = 0;
		const adapter = fakeAdapter(async () => { calls++; if (calls === 1) throw new Error('NETWORK'); });
		const a = new AutoSave(adapter, fakeWorld(), () => PLAYER, { name: 'w', createdAt: 0 });
		a.markDirty();
		await a.flush().catch(() => {});
		expect(calls).toBe(1);
		await a.flush();
		expect(calls).toBe(2);
	});

	it('does not permanently disable saving after a quota error', async () => {
		let calls = 0;
		const adapter = fakeAdapter(async () => { calls++; if (calls === 1) throw new Error('QUOTA_EXCEEDED'); });
		const a = new AutoSave(adapter, fakeWorld(), () => PLAYER, { name: 'w', createdAt: 0 });
		a.markDirty();
		await a.flush();
		a.markDirty();
		await a.flush();
		expect(calls).toBe(2);
	});

	it('coalesces overlapping flushes without dropping the follow-up save', async () => {
		const seen: number[] = [];
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		let n = 0;
		const adapter = fakeAdapter(async () => { const id = ++n; seen.push(id); if (id === 1) await gate; });
		const a = new AutoSave(adapter, fakeWorld(), () => PLAYER, { name: 'w', createdAt: 0 });
		a.markDirty();
		const first = a.flush();
		a.markDirty();
		const second = a.flush();
		release();
		await Promise.all([first, second]);
		expect(seen.length).toBe(2);
	});
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/persistence/autosave.test.ts`
Expected: FAIL — test 1 gets `calls === 1` on the retry (dirty was cleared before the await), test 2 gets `calls === 1` (quota latch), test 3 sees only one save.

- [ ] **Step 3: Implement**

In `src/persistence/autosave.ts`: delete the `quotaHit` field and both its guards. Replace `flush()` so `dirty` is cleared only on success, and add an in-flight guard that queues exactly one follow-up.

```ts
private inFlight: Promise<void> | null = null;
private pending = false;

async flush(): Promise<void> {
	if (!this.dirty) return;
	if (this.inFlight) {
		this.pending = true;
		await this.inFlight;
		if (!this.pending) return;
		this.pending = false;
	}
	const run = this.doSave();
	this.inFlight = run.finally(() => { this.inFlight = null; });
	await this.inFlight;
}

private async doSave(): Promise<void> {
	const save: WorldSave = { /* unchanged body from the current flush() */ };
	try {
		await this.adapter.saveWorld(save);
		this.dirty = false;
	} catch (err) {
		if ((err as Error).message === 'QUOTA_EXCEEDED') {
			this.onQuotaExceeded();
			return;
		}
		throw err;
	}
}
```

`markDirty()` loses its `quotaHit` early-return.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run` — expect the 3 new tests passing and 178 prior tests still green (181 total).

- [ ] **Step 5: Commit**

```bash
git add src/persistence/autosave.ts src/persistence/autosave.test.ts
git commit -m "fix(persistence): autosave retries failed saves and drops the quota latch"
```

---

### Task 2: TNT and liquids must arm autosave

Live data-loss bug: `markDirty()` is called from only `src/main.ts:172`, `:236`, `:276`. `detonateAt` (`src/game/loop.ts:221`) and the liquid tick mutate chunks with no notification, so a crater or a water spread is lost on tab close.

**Files:**
- Modify: `src/game/loop.ts`, `src/main.ts`
- Test: `src/game/loop.test.ts` (create or extend)

**Interfaces:**
- Produces: `GameLoop.onWorldMutated: (() => void) | null`, invoked after any simulation-driven block change.

- [ ] **Step 1: Write the failing test**

```ts
it('notifies onWorldMutated when primed TNT detonates', () => {
	const { loop, world } = makeLoop();   // follow the existing harness in this file
	let mutations = 0;
	loop.onWorldMutated = () => { mutations++; };
	const hit = placeTntAndIgnite(loop, world);
	expect(hit).toBe(true);
	loop.update(TNT_PRIME_FUSE + 0.1);
	expect(mutations).toBeGreaterThan(0);
});

it('notifies onWorldMutated when liquid spreads', () => {
	const { loop, world } = makeLoop();
	let mutations = 0;
	loop.onWorldMutated = () => { mutations++; };
	pourWater(world, 260, 40, 260);
	loop.update(1.0);
	expect(mutations).toBeGreaterThan(0);
});
```

If `src/game/loop.test.ts` has no `makeLoop`/`pourWater` helpers, write them against the real `World` and `GameLoop` constructors rather than mocking — the point is to catch a missing notification in real wiring.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/game/loop.test.ts`
Expected: FAIL — `mutations` stays 0.

- [ ] **Step 3: Implement**

Add `onWorldMutated: (() => void) | null = null;` to `GameLoop`. Call `this.onWorldMutated?.()` at the end of `detonateAt(...)`, and once per tick in the liquid update **only when the tick actually changed a block** (the scheduler already knows; do not fire on a no-op tick or the 5 s debounce becomes a permanent 5 s timer).

In `src/main.ts`, next to `loop.onBlockBroken = () => autosave.markDirty();` (line ~236) add:

```ts
loop.onWorldMutated = () => autosave.markDirty();
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run`

- [ ] **Step 5: Commit**

```bash
git add src/game/loop.ts src/main.ts src/game/loop.test.ts
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

`api/package.json` with `@google-cloud/storage`, `zod`, `express`, `@google-cloud/functions-framework`. Copy `src/persistence/codec.ts` to `api/src/codec.ts` and add `BLOCKS_PER_CHUNK = 16 * 64 * 16` (do not import across the boundary — the function deploys from `api/` alone).

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
		await request(app).get('/worlds/../../etc/passwd').expect(400);
		expect(bucket.calls).toBe(0);
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
8. Write with `ifGenerationMatch` (from the `If-Match` header, or `0` when the client says the world is new); GCS 412 → **409**.
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

echo "==> Enabling versioning and soft delete"
gcloud storage buckets update "gs://${BUCKET}" --project="${PROJECT}" --versioning

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

- [ ] **Step 2: Grant the bucket-scoped role and deploy**

```bash
SA=$(gcloud projects describe qs-trading --format="value(projectNumber)")-compute@developer.gserviceaccount.com
gcloud storage buckets add-iam-policy-binding gs://minicraft-worlds \
	--project=qs-trading --member="serviceAccount:${SA}" --role=roles/storage.objectAdmin
./deploy.sh
```

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
		.mockResolvedValueOnce({ ok: false, status: 412 })
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

it('reports CONFLICT when the stored updatedAt differs', async () => { /* 412 then a different updatedAt */ });
it('maps 413 to TOO_LARGE and does not retry', async () => {});
it('maps a thrown fetch to NETWORK', async () => {});
it('maps 404 to NOT_FOUND', async () => {});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/persistence/cloud.test.ts`

- [ ] **Step 3: Implement**

Encode chunks with the client codec. Keep an in-memory `Map<id, generation>` populated on load and on successful PUT. **The generation sent as `If-Match` is the one the world was loaded from — a comparison fetch must never refresh it.** When no generation is cached, do a metadata `GET` first rather than sending `0` for a world that may exist.

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
	const spy = vi.spyOn(codec, 'encodeChunk');
	await dual.saveWorld(save);
	expect(spy).toHaveBeenCalledTimes(save.chunks.length);
});

it('keeps both copies when they diverge instead of discarding one', async () => {
	// local has edits the cloud lacks and is not derived from the cloud generation
	const loaded = await dual.loadWorld(save.id);
	const list = await dual.listWorlds();
	expect(list.some((w) => w.name.includes('copy from this device'))).toBe(true);
	expect(loaded).not.toBeNull();
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

Both legs attempted independently via `Promise.allSettled`; neither short-circuits the other. Encode once and pass encoded chunks to both. Arbitration by GCS generation, never by wall clock. On divergence, PUT the local copy as a **new visible world** named `<name> (copy from this device)` before loading the cloud copy. Cloud 404 with a local copy → load local and mark for upload. Delete: cloud first, local only on success; v1 keys never touched.

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

it('does not retry TOO_LARGE', async () => {});
it('debounces the cloud leg at 30s while the local leg stays at 5s', async () => {});
it('reports local-only status when the cloud leg is failing', async () => {});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/persistence/autosave.test.ts`

- [ ] **Step 3: Implement**

Local debounce stays 5 s; add a separate 30 s cloud debounce (spec §7 — at 5 s with versioning on, an hour of play on a 1 MB world produces ~700 MB/day of noncurrent versions). Backoff 1/2/4/8 s jittered for `NETWORK` and `SERVER` only. `pagehide` and `visibilitychange` do the **local** write and set a `needsUpload` flag; **no `keepalive` fetch and no `sendBeacon`** — both cap bodies at 64 KiB and a world is 3–16× that. Drive `onStatus`.

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

- [ ] **Step 1: Start the dev server against the deployed API**

```bash
echo "VITE_MINICRAFT_API_URL=<deployed url>" > .env.local
npm run dev
```

- [ ] **Step 2: Drive Chrome at `http://localhost:5173`**

Verify, in order:
1. Menu loads; existing local worlds appear under **On this device**.
2. Create a new world, dig several blocks, wait past the 30 s cloud debounce; the HUD shows `saved`.
3. `gcloud storage ls gs://minicraft-worlds/worlds/` shows the object.
4. Reload the page — the world appears under **Worlds** and loads with the edits intact.
5. Press **Upload to cloud** on a legacy world; confirm it appears in the bucket and **the v1 keys still exist** in DevTools → Application → Local Storage.
6. Press it a second time; confirm no duplicate world is created.
7. Ignite TNT, watch the crater resolve, close the tab immediately; reopen and confirm the crater survived (Task 2's fix).
8. Stop the dev server's network access (DevTools → Network → Offline); confirm the game keeps playing, the HUD reads `local only`, and edits persist locally. Restore the network and confirm the pending upload reconciles.

- [ ] **Step 3: Confirm the site bucket is untouched**

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

**Ordering.** Task 1 (AutoSave tests) precedes every network task, per the spec's sequencing requirement. Task 7 deploys before Task 13 needs a live URL.
