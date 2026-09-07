# Scheduled Play Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A PIN-guarded daily schedule: one world, N minutes per local day, not before a start time; a locked single-button menu for the kid.

**Architecture:** Pure time rules in `src/game/schedule.ts`; a three-valued fail-closed loader in `src/persistence/schedule.ts` (schedule + PIN keys); a pure `menuModel` that maps storage + clock to what the menu shows; `menu.ts` renders the locked card and a staged Grown-ups section; `main.ts` gates `startGame` in the menu callback and feeds schedule limits into the existing play-time controller. Sessions gain `startedAt`; under a schedule a session is in force only on the local day it started.

**Tech Stack:** TypeScript, vitest (node, `TZ` pinned to `America/Toronto`).

**Spec:** `docs/superpowers/specs/2026-09-07-scheduled-play-design.md`

## Global Constraints

- Indent with tabs (1 tab = 4 spaces).
- Stage explicit paths; never `git add -A`. Delete stray `zz-*`/`*probe*` files under `src/` before starting a task.
- Commit trailer on every commit:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` then
  `Claude-Session: https://claude.ai/code/session_013iT9aEJFRZmSuCLmrCcEBz`.
- Never test against `https://noah.leap-forward.ca`; use `localhost:5173`.
- Every test is run red first. Where a task names a wrong build, run it and show the test red before restoring.
- `npx vitest run` and `npm run build` (which type-checks tests too) green at the end of every task.
- Dates in tests: local constructor `new Date(y, m, d, h, mi)`; never `Date.UTC`, never ISO strings with `Z`.

---

### Task 1: TZ pin and `startedAt` on sessions

**Files:**
- Modify: `vitest.config.ts`
- Modify: `src/game/playtime.ts` (type), `src/persistence/playtime.ts` (loader), `src/game/playtime-controller.ts` (fresh sessions)
- Test: `src/persistence/playtime.test.ts`, `src/game/playtime-controller.test.ts`

**Interfaces:**
- Produces: `PlaytimeSession.startedAt: number` (required); `loadSession` defaults it to `updatedAt` for legacy records and rejects a non-finite one; `resolveSession` and `playAgain` set `startedAt = now`.

- [ ] **Step 1: Pin the timezone** — `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts', 'api/src/**/*.test.ts'],
		globals: false,
		// Local-time rules (schedule gate, day rollover) must be tested in a zone
		// where local and UTC dates differ, or a UTC-getter build passes in CI.
		env: { TZ: 'America/Toronto' },
	},
});
```

Confirm: `npx vitest run src/persistence/uuid.test.ts` still passes and `node -e "process.env.TZ='America/Toronto'; console.log(new Date(2026,8,7,20,30).getUTCDate())"` prints 8.

- [ ] **Step 2: Write the failing tests.** In `src/persistence/playtime.test.ts`, change `valid()` to include `startedAt: 1` and add:

```ts
	it('defaults startedAt to updatedAt for a legacy record', async () => {
		const { loadSession } = await import('./playtime');
		const legacy = { limitMs: 1_800_000, breakMs: null, playedMs: 5, frozenAt: null, updatedAt: 77 };
		localStorage.setItem(KEY, JSON.stringify(legacy));
		expect(loadSession()).toEqual({ ...legacy, startedAt: 77 });
	});

	it('rejects a record whose startedAt is not a finite number', async () => {
		const { loadSession } = await import('./playtime');
		localStorage.setItem(KEY, JSON.stringify(valid({ startedAt: 'x' as unknown as number })));
		expect(loadSession()).toBeNull();
	});
```

In `src/game/playtime-controller.test.ts`, change `session()` to include `startedAt: T0`, and add to the `resolveSession` block:

```ts
	it('stamps startedAt = now on a fresh session', () => {
		expect(resolveSession(null, 30, 20, T0 + 5).startedAt).toBe(T0 + 5);
	});
```

and in the controller block (near the existing PLAY AGAIN test; reuse its harness pattern):

```ts
	it('playAgain stamps startedAt = now', () => {
		const h = harness(session({ playedMs: 30 * MIN, frozenAt: T0 }), T0 + 21 * MIN);
		h.ctl.tick();
		h.offered!();
		expect(h.saved.at(-1)!.startedAt).toBe(T0 + 21 * MIN);
	});
```

- [ ] **Step 3: Run red** — `npx vitest run src/persistence/playtime.test.ts src/game/playtime-controller.test.ts`. Expected: the legacy-default test fails (no `startedAt` key in the result), the fresh/playAgain tests fail (`undefined`), the `'x'` test passes trivially now (it is a regression guard).

- [ ] **Step 4: Implement.**

`src/game/playtime.ts`, in `PlaytimeSession` after `frozenAt`:
```ts
	/** Wall clock when this session was created; under a schedule, the day it belongs to. */
	startedAt: number;
```

`src/persistence/playtime.ts`: in `isSession` add `(o.startedAt === undefined || isFiniteNumber(o.startedAt)) &&` before the `isFiniteNumber(o.updatedAt)` line; in `loadSession` destructure `startedAt` too and return `{ limitMs, breakMs, playedMs, frozenAt, updatedAt, startedAt: isFiniteNumber(startedAt) ? startedAt : updatedAt }`. (`isSession` is a type guard on `PlaytimeSession`; since `startedAt` may be absent at that point, type the destructure as `parsed as PlaytimeSession & { startedAt?: number }`.)

`src/game/playtime-controller.ts`: in `resolveSession`'s fresh object and in `playAgain`'s `fresh`, add `startedAt: now,`.

- [ ] **Step 5: Fix every other literal.** `npm run build` will list each test file that builds a `PlaytimeSession` without `startedAt` (e.g. `src/game/playtime.test.ts`, any `toEqual` with a literal in the controller test). Add `startedAt` to each helper/literal so the type checks; for `toEqual` expectations of fresh sessions, expect `startedAt: now`. Do not weaken assertions to `toMatchObject`.

- [ ] **Step 6: Green** — `npx vitest run && npm run build`.

- [ ] **Step 7: Commit**

```bash
git add vitest.config.ts src/game/playtime.ts src/persistence/playtime.ts src/persistence/playtime.test.ts src/game/playtime-controller.ts src/game/playtime-controller.test.ts src/game/playtime.test.ts
git commit -m "feat(playtime): sessions record startedAt; tests run in America/Toronto"
```
(Stage only the files you actually changed.)

---

### Task 2: Time rules in `src/game/schedule.ts`

**Files:**
- Create: `src/game/schedule.ts`, `src/game/schedule.test.ts`

**Interfaces:**
- Consumes: `PlaytimeSession.startedAt` (Task 1); `isStale` from `./playtime`; `MAX_TICK_CREDIT_MS`; `isLegacyId`, `seedFromLegacyId` from `../persistence/uuid`; `WorldSummary` from `../persistence/adapter`; `PLAY_LIMIT_CHOICES_MIN`.
- Produces:
  ```ts
  export type Schedule = { worldId: string; seed: number; name: string; limitMin: number; startMin: number };
  export type LoadedSchedule = { kind: 'none' } | { kind: 'broken' } | { kind: 'armed'; schedule: Schedule };
  export function minutesSinceMidnight(now: number): number;
  export function gateOpen(startMin: number, now: number): boolean;
  export function sameLocalDay(a: number, b: number): boolean;
  export function sessionInForce(session: PlaytimeSession, schedule: Schedule | null, now: number): boolean;
  export function activeLimits(schedule: Schedule | null, opts: { playLimitMin: number | null; playBreakMin: number | null }): { limitMin: number | null; breakMin: number | null };
  export function formatStartTime(startMin: number): string;
  export function resolveWorld(schedule: Schedule, worlds: WorldSummary[]): WorldSummary | null;
  export function canStartNow(loaded: LoadedSchedule, session: PlaytimeSession | null, now: number): boolean;
  ```

- [ ] **Step 1: Write the failing tests** — `src/game/schedule.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
	activeLimits, canStartNow, gateOpen, minutesSinceMidnight, resolveWorld, sameLocalDay, sessionInForce,
	type Schedule,
} from './schedule';
import type { PlaytimeSession } from './playtime';
import type { WorldSummary } from '../persistence/adapter';
import { legacyId } from '../persistence/uuid';

const MIN = 60_000;
const H = 60 * MIN;
const at = (d: number, h: number, mi: number, mo = 8) => new Date(2026, mo, d, h, mi).getTime();
const sched = (over: Partial<Schedule> = {}): Schedule => ({
	worldId: 'w1', seed: 42, name: "Noah's World", limitMin: 45, startMin: 420, ...over,
});
const sess = (over: Partial<PlaytimeSession> = {}): PlaytimeSession => ({
	limitMs: 45 * MIN, breakMs: null, playedMs: 0, frozenAt: null, startedAt: at(7, 7, 10), updatedAt: at(7, 7, 10), ...over,
});
const world = (over: Partial<WorldSummary> = {}): WorldSummary => ({
	id: 'w1', seed: 42, name: 'W', createdAt: 0, updatedAt: 0, origin: 'local', ...over,
});

describe('gate', () => {
	it('1. opens exactly at the start minute', () => {
		expect(gateOpen(420, at(7, 6, 59))).toBe(false);
		expect(gateOpen(420, at(7, 7, 0))).toBe(true);
	});
	it('2. uses local time (20:30 Toronto is 00:30 UTC next day)', () => {
		expect(gateOpen(420, at(7, 20, 30))).toBe(true);
		expect(minutesSinceMidnight(at(7, 20, 30))).toBe(1230);
	});
	it('11. spring-forward day still opens at 07:00 local', () => {
		expect(gateOpen(420, new Date(2026, 2, 8, 6, 59).getTime())).toBe(false);
		expect(gateOpen(420, new Date(2026, 2, 8, 7, 0).getTime())).toBe(true);
		expect(minutesSinceMidnight(new Date(2026, 2, 8, 3, 0).getTime())).toBe(180);
	});
});

describe('sameLocalDay', () => {
	it('3. 19:30 and 20:30 Toronto are one local day (two UTC dates)', () => {
		expect(sameLocalDay(at(7, 19, 30), at(7, 20, 30))).toBe(true);
	});
	it('4. 23:59 and 00:01 are different days', () => {
		expect(sameLocalDay(at(7, 23, 59), at(8, 0, 1))).toBe(false);
	});
});

describe('sessionInForce', () => {
	it('5. without a schedule, mirrors the 12-hour stale rule', () => {
		const s = sess();
		expect(sessionInForce(s, null, s.updatedAt + 12 * H - MIN)).toBe(true);
		expect(sessionInForce(s, null, s.updatedAt + 12 * H + MIN)).toBe(false);
	});
	it('6. with a schedule, a 13-hour-old session from today is still in force', () => {
		const s = sess({ playedMs: 45 * MIN, frozenAt: at(7, 7, 55), updatedAt: at(7, 7, 55) });
		expect(sessionInForce(s, sched(), at(7, 20, 55))).toBe(true);
	});
	it("7. with a schedule, yesterday's session is not in force", () => {
		const s = sess();
		expect(sessionInForce(s, sched(), at(8, 5, 0))).toBe(false);
	});
	it('8. a record written in the future is never in force', () => {
		const s = sess({ updatedAt: at(7, 7, 10) + 10_000 });
		expect(sessionInForce(s, sched(), at(7, 7, 10))).toBe(false);
		expect(sessionInForce(s, null, at(7, 7, 10))).toBe(false);
	});
});

describe('activeLimits', () => {
	it('9. schedule wins and never has a break; options otherwise', () => {
		expect(activeLimits(sched({ limitMin: 30 }), { playLimitMin: 90, playBreakMin: 20 })).toEqual({ limitMin: 30, breakMin: null });
		expect(activeLimits(null, { playLimitMin: null, playBreakMin: 20 })).toEqual({ limitMin: null, breakMin: 20 });
		expect(activeLimits(null, { playLimitMin: 15, playBreakMin: null })).toEqual({ limitMin: 15, breakMin: null });
	});
});

describe('resolveWorld', () => {
	it('10. exact id, legacy id by local seed, not cloud seed, else null', () => {
		expect(resolveWorld(sched(), [world()])?.id).toBe('w1');
		const leg = sched({ worldId: legacyId(42) });
		expect(resolveWorld(leg, [world({ id: 'uuid-9' })])?.id).toBe('uuid-9');
		expect(resolveWorld(leg, [world({ id: 'uuid-9', origin: 'cloud' })])).toBeNull();
		expect(resolveWorld(sched({ worldId: 'nope' }), [world()])).toBeNull();
	});
});

describe('canStartNow', () => {
	it('broken is never startable; closed gate is not; frozen today is not; else yes', () => {
		expect(canStartNow({ kind: 'broken' }, null, at(7, 9, 0))).toBe(false);
		const armed = { kind: 'armed' as const, schedule: sched() };
		expect(canStartNow(armed, null, at(7, 6, 59))).toBe(false);
		expect(canStartNow(armed, null, at(7, 7, 0))).toBe(true);
		const frozen = sess({ playedMs: 45 * MIN, frozenAt: at(7, 7, 55), updatedAt: at(7, 7, 55) });
		expect(canStartNow(armed, frozen, at(7, 9, 0))).toBe(false);
		expect(canStartNow(armed, frozen, at(8, 7, 0))).toBe(true);
		expect(canStartNow({ kind: 'none' }, frozen, at(7, 9, 0))).toBe(true);
	});
});
```

- [ ] **Step 2: Run red** — `npx vitest run src/game/schedule.test.ts`. Expected: module not found.

- [ ] **Step 3: Implement** — `src/game/schedule.ts`:

```ts
import { MAX_TICK_CREDIT_MS } from '../data/playtime.data';
import { isStale, phaseOf, type PlaytimeSession } from './playtime';
import type { WorldSummary } from '../persistence/adapter';
import { isLegacyId, seedFromLegacyId } from '../persistence/uuid';

/** The parent's saved daily schedule. No break: the limit ends play for the day. */
export type Schedule = {
	worldId: string;
	seed: number;
	name: string;
	limitMin: number;
	/** Minutes after local midnight, 0..1439. */
	startMin: number;
};

/** A parental control fails closed: a present-but-invalid record is `broken`, not `none`. */
export type LoadedSchedule =
	| { kind: 'none' }
	| { kind: 'broken' }
	| { kind: 'armed'; schedule: Schedule };

export function minutesSinceMidnight(now: number): number {
	const d = new Date(now);
	return d.getHours() * 60 + d.getMinutes();
}

export function gateOpen(startMin: number, now: number): boolean {
	return minutesSinceMidnight(now) >= startMin;
}

export function sameLocalDay(a: number, b: number): boolean {
	const x = new Date(a);
	const y = new Date(b);
	return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/**
 * Without a schedule: the 12-hour stale rule. With one: the session belongs to
 * the local day it started on, however long ago it was touched, so a lock
 * reached at 07:45 holds until tomorrow's start time.
 */
export function sessionInForce(session: PlaytimeSession, schedule: Schedule | null, now: number): boolean {
	if (session.updatedAt > now + MAX_TICK_CREDIT_MS) return false;
	if (schedule === null) return !isStale(session, now);
	return sameLocalDay(session.startedAt, now);
}

export function activeLimits(
	schedule: Schedule | null,
	opts: { playLimitMin: number | null; playBreakMin: number | null },
): { limitMin: number | null; breakMin: number | null } {
	if (schedule) return { limitMin: schedule.limitMin, breakMin: null };
	return { limitMin: opts.playLimitMin, breakMin: opts.playBreakMin };
}

export function formatStartTime(startMin: number): string {
	const d = new Date();
	d.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
	return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** A legacy world is re-listed under a fresh uuid after its first play; match it by seed. */
export function resolveWorld(schedule: Schedule, worlds: WorldSummary[]): WorldSummary | null {
	const exact = worlds.find((w) => w.id === schedule.worldId);
	if (exact) return exact;
	if (!isLegacyId(schedule.worldId)) return null;
	const seed = seedFromLegacyId(schedule.worldId);
	return worlds.find((w) => w.origin === 'local' && w.seed === seed) ?? null;
}

/** The gate the menu callback checks before startGame; the menu model agrees with it. */
export function canStartNow(loaded: LoadedSchedule, session: PlaytimeSession | null, now: number): boolean {
	if (loaded.kind === 'none') return true;
	if (loaded.kind === 'broken') return false;
	const s = loaded.schedule;
	if (!gateOpen(s.startMin, now)) return false;
	if (session && sessionInForce(session, s, now) && phaseOf(session, now) !== 'playing') return false;
	return true;
}
```

- [ ] **Step 4: Green**, then prove the instruments: (a) change `getHours`/`getMinutes` to `getUTCHours`/`getUTCMinutes` → tests 2 and 11 red; restore. (b) change `sameLocalDay` to compare `getUTCDate` etc. → test 3 red; restore. (c) delete the `schedule === null` branch's `!isStale` (return true) → test 5 red. (d) make the schedule branch `return !isStale(session, now)` → test 6 red. (e) drop the future-`updatedAt` guard → test 8 red. Record each one-line red in the commit body.

- [ ] **Step 5: Suite + build** — `npx vitest run && npm run build`.

- [ ] **Step 6: Commit**

```bash
git add src/game/schedule.ts src/game/schedule.test.ts
git commit -m "feat(schedule): daily gate, per-day sessions, world resolution"
```

---

### Task 3: Storage for the schedule and PIN

**Files:**
- Create: `src/persistence/schedule.ts`, `src/persistence/schedule.test.ts`

**Interfaces:**
- Produces: `SCHEDULE_KEY = 'minicraft:v1:schedule'`, `PIN_KEY = 'minicraft:v1:pin'`, `loadSchedule(): LoadedSchedule`, `saveSchedule(s): boolean`, `clearSchedule(): boolean`, `loadPin(): string | null`, `savePin(pin): boolean`, `clearPin(): boolean`.

- [ ] **Step 1: Write the failing tests** — `src/persistence/schedule.test.ts` (copy the `localStorageMock` + `beforeEach`/`afterEach` block from `src/persistence/playtime.test.ts`):

```ts
const good = { worldId: 'w1', seed: 42, name: 'N', limitMin: 45, startMin: 420 };

describe('schedule storage', () => {
	it('absent → none', async () => {
		const { loadSchedule } = await import('./schedule');
		expect(loadSchedule()).toEqual({ kind: 'none' });
	});
	it('round trip → armed, and save reports success', async () => {
		const { loadSchedule, saveSchedule } = await import('./schedule');
		expect(saveSchedule(good)).toBe(true);
		expect(loadSchedule()).toEqual({ kind: 'armed', schedule: good });
	});
	it.each([
		['bad json', 'nope'],
		['empty object', '{}'],
		['limit not a choice', JSON.stringify({ ...good, limitMin: 7 })],
		['startMin 1440', JSON.stringify({ ...good, startMin: 1440 })],
		['startMin fractional', JSON.stringify({ ...good, startMin: 7.5 })],
		['seed NaN', JSON.stringify({ ...good, seed: 'x' })],
		['name missing', JSON.stringify({ ...good, name: undefined })],
	])('present but invalid → broken (%s)', async (_label, raw) => {
		const { loadSchedule } = await import('./schedule');
		localStorage.setItem('minicraft:v1:schedule', raw);
		expect(loadSchedule()).toEqual({ kind: 'broken' });
	});
	it('save returns false when storage throws', async () => {
		const { saveSchedule } = await import('./schedule');
		vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
		expect(saveSchedule(good)).toBe(false);
	});
	it('clear reports whether the key is gone', async () => {
		const { saveSchedule, clearSchedule, loadSchedule } = await import('./schedule');
		saveSchedule(good);
		expect(clearSchedule()).toBe(true);
		expect(loadSchedule()).toEqual({ kind: 'none' });
	});
});

describe('pin storage', () => {
	it('round-trips four digits', async () => {
		const { loadPin, savePin } = await import('./schedule');
		expect(savePin('1234')).toBe(true);
		expect(loadPin()).toBe('1234');
	});
	it.each(['12', '12345', 'abcd', ' 1234', '1234\n'])('rejects %j on load', async (bad) => {
		const { loadPin } = await import('./schedule');
		localStorage.setItem('minicraft:v1:pin', bad);
		expect(loadPin()).toBeNull();
	});
	it('refuses to save a bad pin', async () => {
		const { savePin, loadPin } = await import('./schedule');
		expect(savePin('12')).toBe(false);
		expect(loadPin()).toBeNull();
	});
	it('clearPin', async () => {
		const { savePin, clearPin, loadPin } = await import('./schedule');
		savePin('1234');
		expect(clearPin()).toBe(true);
		expect(loadPin()).toBeNull();
	});
});
```

Note the mock's `setItem` is a plain property; `vi.spyOn(localStorage, 'setItem')` works on the stubbed object. `import { vi } from 'vitest'` is needed.

- [ ] **Step 2: Run red** — module not found.

- [ ] **Step 3: Implement** — `src/persistence/schedule.ts`:

```ts
import { PLAY_LIMIT_CHOICES_MIN } from '../data/playtime.data';
import type { LoadedSchedule, Schedule } from '../game/schedule';

export const SCHEDULE_KEY = 'minicraft:v1:schedule';
export const PIN_KEY = 'minicraft:v1:pin';

const PIN_RE = /^\d{4}$/;

function isSchedule(v: unknown): v is Schedule {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.worldId === 'string' && o.worldId.length > 0 &&
		typeof o.seed === 'number' && Number.isFinite(o.seed) &&
		typeof o.name === 'string' &&
		typeof o.limitMin === 'number' && PLAY_LIMIT_CHOICES_MIN.includes(o.limitMin) &&
		typeof o.startMin === 'number' && Number.isInteger(o.startMin) && o.startMin >= 0 && o.startMin < 1440
	);
}

function read(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

/** Write, then read back; a parental control must not report success it cannot prove. */
function writeVerified(key: string, value: string): boolean {
	try {
		localStorage.setItem(key, value);
		return localStorage.getItem(key) === value;
	} catch {
		return false;
	}
}

function removeVerified(key: string): boolean {
	try {
		localStorage.removeItem(key);
		return localStorage.getItem(key) === null;
	} catch {
		return false;
	}
}

/** Absent → none. Present but invalid → broken (fails closed). */
export function loadSchedule(): LoadedSchedule {
	const raw = read(SCHEDULE_KEY);
	if (raw === null) return { kind: 'none' };
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isSchedule(parsed)) return { kind: 'broken' };
		const { worldId, seed, name, limitMin, startMin } = parsed;
		return { kind: 'armed', schedule: { worldId, seed, name, limitMin, startMin } };
	} catch {
		return { kind: 'broken' };
	}
}

export function saveSchedule(s: Schedule): boolean {
	if (!isSchedule(s)) return false;
	return writeVerified(SCHEDULE_KEY, JSON.stringify(s));
}

export function clearSchedule(): boolean {
	return removeVerified(SCHEDULE_KEY);
}

export function loadPin(): string | null {
	const raw = read(PIN_KEY);
	return raw !== null && PIN_RE.test(raw) ? raw : null;
}

export function savePin(pin: string): boolean {
	if (!PIN_RE.test(pin)) return false;
	return writeVerified(PIN_KEY, pin);
}

export function clearPin(): boolean {
	return removeVerified(PIN_KEY);
}
```

- [ ] **Step 4: Green; prove the instruments.** (a) make `loadSchedule` return `{ kind: 'none' }` on invalid → every `broken` row red. (b) make `writeVerified` return `true` without reading back and have the storage spy swallow instead of throw (`mockImplementation(() => {})`) → add this test and keep it: `'save returns false when the write does not stick'` (spy `setItem` to no-op, expect `saveSchedule(good)` false). It must be red under (b) and green after restoring.

- [ ] **Step 5: Suite + build; commit**

```bash
git add src/persistence/schedule.ts src/persistence/schedule.test.ts
git commit -m "feat(persistence): fail-closed schedule record and grown-ups PIN"
```

---

### Task 4: Controller takes the schedule; overlay gets `lockedText`

**Files:**
- Modify: `src/game/playtime-controller.ts`, `src/game/playtime-controller.test.ts`

**Interfaces:**
- Produces: `resolveSession(stored, limitMin, breakMin, now, schedule: Schedule | null = null)`; `PlaytimeOverlayLike.freeze(breakEndsAt: number | null, lockedText?: string)`; `PlaytimeDeps.lockedText?: string`.

- [ ] **Step 1: Write the failing tests** — in the `resolveSession` block:

```ts
	it("with a schedule, keeps today's 13-hour-old playing session", () => {
		const day = new Date(2026, 8, 7, 7, 10).getTime();
		const stored = session({ startedAt: day, updatedAt: day, playedMs: 5 * MIN });
		const s = { worldId: 'w', seed: 1, name: 'n', limitMin: 45, startMin: 420 };
		expect(resolveSession(stored, 45, null, day + 13 * 60 * MIN, s)).toEqual(stored);
	});
	it("with a schedule, discards yesterday's session", () => {
		const yday = new Date(2026, 8, 6, 7, 10).getTime();
		const now = new Date(2026, 8, 7, 7, 0).getTime();
		const stored = session({ startedAt: yday, updatedAt: yday + 5 * MIN, playedMs: 5 * MIN });
		const s = { worldId: 'w', seed: 1, name: 'n', limitMin: 45, startMin: 420 };
		expect(resolveSession(stored, 45, null, now, s)).toEqual({
			limitMs: 45 * MIN, breakMs: null, playedMs: 0, frozenAt: null, startedAt: now, updatedAt: now,
		});
	});
```

and in the controller block (extend `harness` to accept `lockedText` and record it: `freeze: (b, t) => calls.push(\`overlay.freeze:${b}:${t ?? ''}\`)`, updating the existing freeze expectations to the new string):

```ts
	it('passes lockedText through to the overlay on a no-break freeze', () => {
		const h = harness(session({ breakMs: null, playedMs: 30 * MIN }), T0, 'PLAY AGAIN AT 7:00 AM TOMORROW');
		h.ctl.tick();
		expect(h.calls).toContain('overlay.freeze:null:PLAY AGAIN AT 7:00 AM TOMORROW');
	});
```

- [ ] **Step 2: Run red.** The schedule tests fail on argument count/behaviour (the 13-hour session is replaced as stale); the lockedText test fails.

- [ ] **Step 3: Implement.** In `playtime-controller.ts`:
  - `import { sessionInForce, type Schedule } from './schedule';`
  - `resolveSession(stored, limitMin, breakMin, now, schedule: Schedule | null = null)`; replace the `isStale` check with `if (stored && sessionInForce(stored, schedule, now) && phaseOf(stored, now) !== 'over') return stored;` and drop the now-unused `isStale` import.
  - `PlaytimeOverlayLike.freeze(breakEndsAt: number | null, lockedText?: string): void;`
  - `PlaytimeDeps` gains `/** Shown instead of ASK A GROWN-UP on a no-break freeze (schedule mode). */ lockedText?: string;`
  - In `tickUnsafe`: `overlay.freeze(ev.breakEndsAt, this.deps.lockedText);`

- [ ] **Step 4: Green; prove**: revert the `resolveSession` body to `isStale` → the 13-hour test red. Restore.

- [ ] **Step 5: Suite + build; commit**

```bash
git add src/game/playtime-controller.ts src/game/playtime-controller.test.ts
git commit -m "feat(playtime): resolveSession honours the schedule; lockedText on freeze"
```

---

### Task 5: Menu model

**Files:**
- Create: `src/ui/menu-model.ts`, `src/ui/menu-model.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type MenuInput = { schedule: LoadedSchedule; session: PlaytimeSession | null; worlds: WorldSummary[] | null; offline: boolean; now: number };
  export type CardModel = { mode: 'card'; title: string; line: string; playEnabled: boolean; world: { id: string; seed: number } | null };
  export type MenuModel = { mode: 'full' } | CardModel;
  export function menuModel(i: MenuInput): MenuModel;
  ```

- [ ] **Step 1: Write the failing tests** — `src/ui/menu-model.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { menuModel, type MenuInput } from './menu-model';
import type { Schedule } from '../game/schedule';
import type { PlaytimeSession } from '../game/playtime';
import type { WorldSummary } from '../persistence/adapter';

const MIN = 60_000;
const at = (d: number, h: number, mi: number) => new Date(2026, 8, d, h, mi).getTime();
const schedule: Schedule = { worldId: 'w1', seed: 42, name: "Noah's World", limitMin: 45, startMin: 420 };
const w1: WorldSummary = { id: 'w1', seed: 42, name: "Noah's World", createdAt: 0, updatedAt: 0, origin: 'local' };
const base = (over: Partial<MenuInput> = {}): MenuInput => ({
	schedule: { kind: 'armed', schedule }, session: null, worlds: [w1], offline: false, now: at(7, 9, 0), ...over,
});
const sess = (over: Partial<PlaytimeSession> = {}): PlaytimeSession => ({
	limitMs: 45 * MIN, breakMs: null, playedMs: 0, frozenAt: null, startedAt: at(7, 7, 10), updatedAt: at(7, 7, 10), ...over,
});
const card = (i: MenuInput) => {
	const m = menuModel(i);
	if (m.mode !== 'card') throw new Error('expected card');
	return m;
};

describe('menuModel', () => {
	it('no schedule → full menu', () => {
		expect(menuModel(base({ schedule: { kind: 'none' } }))).toEqual({ mode: 'full' });
	});
	it('broken beats everything, even with the gate open and a world present', () => {
		const m = card(base({ schedule: { kind: 'broken' } }));
		expect(m.line).toBe("Something's wrong · ask a grown-up");
		expect(m.playEnabled).toBe(false);
	});
	it('worlds still loading', () => {
		const m = card(base({ worlds: null }));
		expect(m.line).toBe('Loading…');
		expect(m.playEnabled).toBe(false);
	});
	it('world missing while offline', () => {
		const m = card(base({ worlds: [], offline: true }));
		expect(m.line).toBe("Can't reach cloud saves · try again later");
		expect(m.playEnabled).toBe(false);
	});
	it('world missing while online', () => {
		const m = card(base({ worlds: [] }));
		expect(m.line).toBe('World not found · ask a grown-up');
		expect(m.playEnabled).toBe(false);
	});
	it('gate closed: Play at <time>, disabled; opens exactly at startMin', () => {
		const closed = card(base({ now: at(7, 6, 59) }));
		expect(closed.line.startsWith('Play at ')).toBe(true);
		expect(closed.playEnabled).toBe(false);
		expect(card(base({ now: at(7, 7, 0) })).playEnabled).toBe(true);
	});
	it('playing session: minutes left, enabled, resolved world', () => {
		const m = card(base({ session: sess({ playedMs: 33 * MIN }) }));
		expect(m.line).toBe('12 minutes left');
		expect(m.playEnabled).toBe(true);
		expect(m.world).toEqual({ id: 'w1', seed: 42 });
	});
	it('frozen today: all done, disabled', () => {
		const m = card(base({ session: sess({ playedMs: 45 * MIN, frozenAt: at(7, 7, 55), updatedAt: at(7, 7, 55) }) }));
		expect(m.line.startsWith('All done for today')).toBe(true);
		expect(m.playEnabled).toBe(false);
	});
	it("frozen yesterday, today at 07:00: fresh day", () => {
		const y = sess({ startedAt: at(6, 7, 10), playedMs: 45 * MIN, frozenAt: at(6, 7, 55), updatedAt: at(6, 7, 55) });
		const m = card(base({ session: y, now: at(7, 7, 0) }));
		expect(m.line).toBe('45 minutes today');
		expect(m.playEnabled).toBe(true);
	});
	it('legacy id resolves to the adopted uuid and Play carries it', () => {
		const leg = { ...schedule, worldId: 'legacy:42' };
		const m = card(base({ schedule: { kind: 'armed', schedule: leg }, worlds: [{ ...w1, id: 'uuid-9' }] }));
		expect(m.world).toEqual({ id: 'uuid-9', seed: 42 });
		expect(m.playEnabled).toBe(true);
	});
});
```

(Check `legacyId(42)` in `src/persistence/uuid.ts` really produces `legacy:42`; if the format differs, build the id with `legacyId(42)` instead of the literal.)

- [ ] **Step 2: Run red** — module not found.

- [ ] **Step 3: Implement** — `src/ui/menu-model.ts`:

```ts
import { phaseOf, type PlaytimeSession } from '../game/playtime';
import {
	formatStartTime, gateOpen, resolveWorld, sessionInForce, type LoadedSchedule,
} from '../game/schedule';
import type { WorldSummary } from '../persistence/adapter';

export type MenuInput = {
	schedule: LoadedSchedule;
	session: PlaytimeSession | null;
	/** null while the world list is still loading. */
	worlds: WorldSummary[] | null;
	offline: boolean;
	now: number;
};

export type CardModel = {
	mode: 'card';
	title: string;
	line: string;
	playEnabled: boolean;
	world: { id: string; seed: number } | null;
};

export type MenuModel = { mode: 'full' } | CardModel;

function card(title: string, line: string, playEnabled: boolean, world: CardModel['world']): CardModel {
	return { mode: 'card', title, line, playEnabled, world };
}

/** What the menu shows. Rows are checked in the spec's order; the first match wins. */
export function menuModel(i: MenuInput): MenuModel {
	if (i.schedule.kind === 'none') return { mode: 'full' };
	if (i.schedule.kind === 'broken') return card('Locked', "Something's wrong · ask a grown-up", false, null);
	const s = i.schedule.schedule;
	if (i.worlds === null) return card(s.name, 'Loading…', false, null);
	const found = resolveWorld(s, i.worlds);
	if (!found) {
		return card(s.name, i.offline ? "Can't reach cloud saves · try again later" : 'World not found · ask a grown-up', false, null);
	}
	const world = { id: found.id, seed: found.seed };
	const time = formatStartTime(s.startMin);
	if (!gateOpen(s.startMin, i.now)) return card(s.name, `Play at ${time}`, false, world);
	const live = i.session && sessionInForce(i.session, s, i.now) ? i.session : null;
	if (live && phaseOf(live, i.now) === 'playing') {
		const left = Math.max(1, Math.ceil((live.limitMs - live.playedMs) / 60_000));
		return card(s.name, `${left} minute${left === 1 ? '' : 's'} left`, true, world);
	}
	if (live) return card(s.name, `All done for today · play again at ${time} tomorrow`, false, world);
	return card(s.name, `${s.limitMin} minutes today`, true, world);
}
```

- [ ] **Step 4: Green; prove**: (a) swap the `broken` check below the `worlds === null` check → the broken test still passes (both disabled) — so instead mutate `broken` to return `{ mode: 'full' }` → broken test red. (b) change `gateOpen` call to `>` semantics by passing `i.now - 60_000` → the "opens exactly at startMin" assertion red. (c) drop `sessionInForce` (use `i.session` directly) → the "frozen yesterday" test red. Restore each.

- [ ] **Step 5: Suite + build; commit**

```bash
git add src/ui/menu-model.ts src/ui/menu-model.test.ts
git commit -m "feat(menu): pure model for the locked card"
```

---

### Task 6: Overlay `lockedText` + MENU button; menu CSS

**Files:**
- Modify: `src/ui/playtime-overlay.ts`, `src/ui/ui.css`

No unit tests (DOM). Verified in Task 10.

- [ ] **Step 1: Overlay.** Change `freeze` to `freeze(breakEndsAt: number | null, lockedText?: string): void` and the no-break branch to:

```ts
		if (breakEndsAt === null) {
			line.textContent = lockedText ?? 'ASK A GROWN-UP';
			this.countdown = null;
			const menuBtn = document.createElement('button');
			menuBtn.className = 'playtime-button';
			menuBtn.textContent = 'MENU';
			// A frozen tab left open overnight has no other way back to the Play button.
			menuBtn.onclick = () => location.reload();
			this.freezeEl.appendChild(line);
			this.freezeEl.appendChild(menuBtn);
			this.freezeEl.classList.remove('hidden');
			return;
		}
```
(keep the existing tail for the timed-break branch).

- [ ] **Step 2: CSS.** In `ui.css`, `#menu-root`: remove `align-items: center;`, add `overflow-y: auto;`. `.menu-card`: add `margin: auto;`. Append:

```css
.menu-card button:disabled {
	opacity: 0.4;
	cursor: default;
}
.card-world {
	font-size: 22px;
	margin: 4px 0;
}
.play-line {
	margin: 0 0 12px;
	opacity: 0.85;
}
.pin-row input {
	width: 5em;
	font-size: 18px;
	letter-spacing: 0.3em;
	text-align: center;
	margin-right: 8px;
}
.menu-hint {
	opacity: 0.6;
	font-size: 13px;
	margin: 4px 0 8px;
}
.menu-error {
	color: #ff7070;
	margin: 8px 0;
}
```

- [ ] **Step 3: Build; commit**

```bash
git add src/ui/playtime-overlay.ts src/ui/ui.css
git commit -m "feat(ui): MENU button and lockedText on the freeze overlay; scrolling menu"
```

---

### Task 7: Menu: locked card, Grown-ups section, staged Save, refresh

**Files:**
- Modify: `src/ui/menu.ts`

**Interfaces:**
- Consumes: `menuModel`, `loadSchedule`/`saveSchedule`/`clearSchedule`/`loadPin`/`savePin`/`clearPin`, `applyPlaytimeSetting`/`clearSession`/`loadSession`, `PLAY_LIMIT_CHOICES_MIN`/`PLAY_BREAK_CHOICES_MIN`, `phaseOf`/`isStale`, `formatStartTime`.
- Produces: no new exports. `renderPlaytime`/`rerenderPlaytime` are replaced by `renderGrownUps`.

- [ ] **Step 1: Fields and lifecycle.** Add to `MainMenu`:

```ts
	private refresh: ReturnType<typeof setInterval> | null = null;
	private grownUpsOpen = false;
	/** Staged Grown-ups edits; written only by Save. */
	private staged: { worldId: string; limitMin: number | null; breakMin: number | null; startMin: number } | null = null;

	private stopRefresh(): void {
		if (this.refresh !== null) clearInterval(this.refresh);
		this.refresh = null;
	}
```
`show()`: set `this.grownUpsOpen = false; this.staged = null;` before rendering. `hide()`: call `this.stopRefresh()`. First line of `renderHome` and `renderNew`: `this.stopRefresh();`.

- [ ] **Step 2: `renderHome`.** Keep the loading render (without the old `renderPlaytime` call). After the world list resolves, replace the body from `card.innerHTML = '<h1>Minicraft</h1>'` onward with:

```ts
		card.innerHTML = `<h1>Minicraft</h1>`;
		const model = this.model(worlds, offline);
		if (model.mode === 'card') {
			this.renderCard(card, model, worlds, offline);
		} else {
			// (existing: New World button, offline warning, both world sections)
		}
		this.renderGrownUps(card, worlds);
		// (existing: Options button)
```
with

```ts
	private model(worlds: WorldSummary[] | null, offline: boolean) {
		return menuModel({ schedule: loadSchedule(), session: loadSession(), worlds, offline, now: Date.now() });
	}
```

- [ ] **Step 3: `renderCard`.**

```ts
	private renderCard(card: HTMLElement, first: CardModel, worlds: WorldSummary[], offline: boolean): void {
		let current = first;
		const title = document.createElement('div');
		title.className = 'card-world';
		title.textContent = current.title;
		const line = document.createElement('div');
		line.className = 'play-line';
		line.id = 'play-line';
		line.textContent = current.line;
		const play = document.createElement('button');
		play.id = 'play-button';
		play.textContent = '▶ Play';
		play.disabled = !current.playEnabled;
		play.onclick = () => {
			if (current.playEnabled && current.world) {
				this.onAction?.({ type: 'continue', id: current.world.id, seed: current.world.seed });
			}
		};
		card.append(title, line, play);
		// Only the line and the button change; a full re-render would wipe a PIN
		// being typed in the Grown-ups section below.
		this.stopRefresh();
		this.refresh = setInterval(() => {
			const m = this.model(worlds, offline);
			if (m.mode !== 'card') return;
			current = m;
			line.textContent = m.line;
			play.disabled = !m.playEnabled;
		}, 30_000);
	}
```

- [ ] **Step 4: `renderGrownUps`** (replaces `renderPlaytime`/`rerenderPlaytime`; delete those two methods and the now-unused imports):

```ts
	private renderGrownUps(card: HTMLElement, worlds: WorldSummary[]): void {
		const section = document.createElement('div');
		section.className = 'playtime-section';
		const h = document.createElement('div');
		h.className = 'menu-section';
		h.textContent = 'Grown-ups';
		section.appendChild(h);
		const body = document.createElement('div');
		section.appendChild(body);
		card.appendChild(section);

		if (this.grownUpsOpen) {
			this.renderGrownUpsBody(body, worlds);
			return;
		}
		const pin = loadPin();
		const open = document.createElement('button');
		open.id = 'grownups-open';
		open.textContent = 'Grown-ups';
		open.onclick = () => {
			open.remove();
			if (pin === null) {
				this.grownUpsOpen = true;
				this.renderGrownUpsBody(body, worlds);
				return;
			}
			const row = document.createElement('div');
			row.className = 'pin-row';
			const label = document.createElement('label');
			label.textContent = 'Grown-ups PIN ';
			const input = document.createElement('input');
			input.type = 'password';
			input.inputMode = 'numeric';
			input.maxLength = 4;
			input.autocomplete = 'off';
			input.id = 'pin-input';
			const go = document.createElement('button');
			go.textContent = 'Open';
			const err = document.createElement('div');
			err.className = 'menu-error';
			go.onclick = () => {
				if (input.value === loadPin()) {
					this.grownUpsOpen = true;
					row.remove();
					this.renderGrownUpsBody(body, worlds);
				} else {
					err.textContent = 'Wrong PIN';
					input.value = '';
					input.focus();
				}
			};
			input.onkeydown = (e) => { if (e.key === 'Enter') go.onclick!(e as unknown as MouseEvent); };
			label.appendChild(input);
			row.append(label, go, err);
			body.appendChild(row);
			input.focus();
		};
		body.appendChild(open);
	}
```

- [ ] **Step 5: `renderGrownUpsBody`** (staged form; re-renders itself from `this.staged` on every change):

```ts
	private renderGrownUpsBody(body: HTMLElement, worlds: WorldSummary[]): void {
		body.innerHTML = '';
		const pin = loadPin();
		const loaded = loadSchedule();
		const opts = loadOptions();
		if (this.staged === null) {
			const armed = loaded.kind === 'armed' ? loaded.schedule : null;
			this.staged = {
				worldId: armed?.worldId ?? '',
				limitMin: armed ? armed.limitMin : opts.playLimitMin,
				breakMin: opts.playBreakMin,
				startMin: armed?.startMin ?? 420,
			};
		}
		const st = this.staged;
		const rerender = () => this.renderGrownUpsBody(body, worlds);
		const error = document.createElement('div');
		error.className = 'menu-error';
		error.id = 'grownups-error';

		// 1. PIN row
		const pinRow = document.createElement('div');
		pinRow.className = 'pin-row';
		if (pin === null) {
			const hint = document.createElement('div');
			hint.className = 'menu-hint';
			hint.textContent = 'Set a PIN so only grown-ups can change this';
			pinRow.appendChild(hint);
		}
		const pinInput = document.createElement('input');
		pinInput.type = 'password';
		pinInput.inputMode = 'numeric';
		pinInput.maxLength = 4;
		pinInput.autocomplete = 'off';
		pinInput.id = 'pin-set-input';
		const setPin = document.createElement('button');
		setPin.textContent = 'Set PIN';
		setPin.onclick = () => {
			if (!/^\d{4}$/.test(pinInput.value)) { error.textContent = 'PIN must be 4 digits'; return; }
			if (!savePin(pinInput.value)) { error.textContent = "Couldn't save — try again"; return; }
			rerender();
		};
		pinRow.append(pinInput, setPin);
		if (pin !== null) {
			const remove = document.createElement('button');
			remove.textContent = 'Remove PIN';
			remove.onclick = () => { if (!clearPin()) { error.textContent = "Couldn't save — try again"; return; } rerender(); };
			pinRow.appendChild(remove);
		}
		body.appendChild(pinRow);

		// 2. World
		const worldSel = document.createElement('select');
		worldSel.id = 'sched-world';
		const none = document.createElement('option');
		none.value = '';
		none.textContent = 'No schedule';
		worldSel.appendChild(none);
		for (const w of worlds) {
			if (w.degraded) continue;
			const o = document.createElement('option');
			o.value = w.id;
			o.textContent = `${w.name} (${w.seed})`;
			worldSel.appendChild(o);
		}
		worldSel.value = worlds.some((w) => w.id === st.worldId) ? st.worldId : '';
		worldSel.disabled = pin === null;
		worldSel.onchange = () => {
			st.worldId = worldSel.value;
			if (st.worldId !== '' && st.limitMin === null) st.limitMin = 45;
			rerender();
		};
		body.appendChild(this.labelled('Lock to world', worldSel));
		if (pin === null) {
			const hint = document.createElement('div');
			hint.className = 'menu-hint';
			hint.textContent = 'Set a PIN to lock to a world';
			body.appendChild(hint);
		}

		// 3. Play for
		const limit = document.createElement('select');
		limit.id = 'playtime-limit';
		if (st.worldId === '') {
			const off = document.createElement('option');
			off.value = '';
			off.textContent = 'Off';
			limit.appendChild(off);
		}
		for (const m of PLAY_LIMIT_CHOICES_MIN) {
			const o = document.createElement('option');
			o.value = String(m);
			o.textContent = `${m} minutes`;
			limit.appendChild(o);
		}
		limit.value = st.limitMin === null ? '' : String(st.limitMin);
		limit.onchange = () => { st.limitMin = limit.value === '' ? null : Number(limit.value); rerender(); };
		body.appendChild(this.labelled('Play for', limit));

		// 4. Then break for (no-schedule mode only)
		if (st.worldId === '' && st.limitMin !== null) {
			const brk = document.createElement('select');
			brk.id = 'playtime-break';
			const untilUnlock = document.createElement('option');
			untilUnlock.value = '';
			untilUnlock.textContent = 'Until a grown-up unlocks';
			brk.appendChild(untilUnlock);
			for (const m of PLAY_BREAK_CHOICES_MIN) {
				const o = document.createElement('option');
				o.value = String(m);
				o.textContent = `${m} minutes`;
				brk.appendChild(o);
			}
			brk.value = st.breakMin === null ? '' : String(st.breakMin);
			brk.onchange = () => { st.breakMin = brk.value === '' ? null : Number(brk.value); };
			body.appendChild(this.labelled('Then break for', brk));
		}

		// 5. Not before (schedule mode only)
		if (st.worldId !== '') {
			const time = document.createElement('input');
			time.type = 'time';
			time.id = 'sched-start';
			time.value = `${String(Math.floor(st.startMin / 60)).padStart(2, '0')}:${String(st.startMin % 60).padStart(2, '0')}`;
			time.onchange = () => {
				const m = /^(\d{2}):(\d{2})$/.exec(time.value);
				if (m) st.startMin = Number(m[1]) * 60 + Number(m[2]);
			};
			body.appendChild(this.labelled('Not before', time));
		}

		// 6. Save / Turn off
		const save = document.createElement('button');
		save.id = 'sched-save';
		save.textContent = 'Save';
		save.onclick = () => {
			let ok: boolean;
			if (st.worldId === '') {
				applyPlaytimeSetting({ playLimitMin: st.limitMin, playBreakMin: st.breakMin });
				ok = clearSchedule();
			} else {
				const w = worlds.find((x) => x.id === st.worldId);
				if (!w) { error.textContent = 'Pick a world'; return; }
				ok = saveSchedule({ worldId: w.id, seed: w.seed, name: w.name, limitMin: st.limitMin ?? 45, startMin: st.startMin });
				clearSession();
			}
			if (!ok) { error.textContent = "Couldn't save — try again"; return; }
			this.staged = null;
			void this.renderHome();
		};
		body.appendChild(save);
		if (loaded.kind !== 'none') {
			const off = document.createElement('button');
			off.id = 'sched-off';
			off.textContent = 'Turn off';
			off.onclick = () => {
				clearSession();
				if (!clearSchedule()) { error.textContent = "Couldn't save — try again"; return; }
				this.staged = null;
				void this.renderHome();
			};
			body.appendChild(off);
		}

		// 7. Status row + Unlock / Start fresh (existing logic, moved here)
		const now = Date.now();
		const session = loadSession();
		const sched = loaded.kind === 'armed' ? loaded.schedule : null;
		if (session && sessionInForce(session, sched, now)) {
			const phase = phaseOf(session, now);
			if (phase !== 'over') {
				const status = document.createElement('div');
				status.className = 'playtime-status';
				const text = document.createElement('span');
				const btn = document.createElement('button');
				if (phase === 'playing') {
					const left = Math.max(1, Math.ceil((session.limitMs - session.playedMs) / 60_000));
					text.textContent = `${left} minute${left === 1 ? '' : 's'} left`;
					btn.textContent = 'Start fresh';
				} else if (session.breakMs === null) {
					text.textContent = sched ? 'All done for today' : 'Locked — ask a grown-up';
					btn.textContent = sched ? `Unlock · fresh ${sched.limitMin} minutes now` : 'Unlock';
				} else {
					const left = Math.max(1, Math.ceil((session.frozenAt! + session.breakMs - now) / 60_000));
					text.textContent = `Break, ${left} minute${left === 1 ? '' : 's'} left`;
					btn.textContent = 'Unlock';
				}
				btn.onclick = () => { clearSession(); void this.renderHome(); };
				status.append(text, btn);
				body.appendChild(status);
			}
		}
		body.appendChild(error);
	}

	private labelled(text: string, control: HTMLElement): HTMLElement {
		const row = document.createElement('div');
		row.className = 'playtime-row';
		const label = document.createElement('label');
		label.textContent = text;
		label.appendChild(document.createElement('br'));
		label.appendChild(control);
		row.appendChild(label);
		return row;
	}
```

Imports to add: `menuModel, type CardModel` from `./menu-model`; `loadSchedule, saveSchedule, clearSchedule, loadPin, savePin, clearPin` from `../persistence/schedule`; `sessionInForce` from `../game/schedule`; `type WorldSummary` is already imported. Remove `isStale` if no longer used.

- [ ] **Step 6: Build and a smoke run.** `npx vitest run && npm run build`. Then `npm run dev` (if not running) and, with Playwright, load `localhost:5173`: the normal menu renders with a Grown-ups button; open it (no PIN) and confirm the form renders with the world dropdown disabled and the hint. Do not go further; Task 10 does the full check.

- [ ] **Step 7: Commit**

```bash
git add src/ui/menu.ts
git commit -m "feat(menu): locked card, PIN-guarded grown-ups section, staged save"
```

---

### Task 8: `main.ts` wiring

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Guard in the menu callback** (`showMenu`), before either `startGame` call:

```ts
			if (action.type === 'continue') {
				// Belt and braces under the menu model: never enter startGame (which
				// hides the menu and registers listeners) when the schedule says no.
				const loaded = loadSchedule();
				if (!canStartNow(loaded, loadSession(), Date.now())) {
					showMenu();
					return;
				}
			}
```
Imports: `loadSchedule` from `./persistence/schedule`; `canStartNow, activeLimits, formatStartTime` from `./game/schedule`.

- [ ] **Step 2: Play-time block.** Replace `if (opts.playLimitMin !== null) { const session = resolveSession(loadSession(), opts.playLimitMin, opts.playBreakMin, Date.now());` with:

```ts
		const loadedSchedule = loadSchedule();
		const schedule = loadedSchedule.kind === 'armed' ? loadedSchedule.schedule : null;
		const limits = activeLimits(schedule, opts);
		if (limits.limitMin !== null) {
			const session = resolveSession(loadSession(), limits.limitMin, limits.breakMin, Date.now(), schedule);
```
and add to the controller deps: `lockedText: schedule ? \`PLAY AGAIN AT ${formatStartTime(schedule.startMin).toUpperCase()} TOMORROW\` : undefined,`.

- [ ] **Step 3: Build; commit**

```bash
git add src/main.ts
git commit -m "feat(main): schedule gate before startGame; schedule limits feed the timer"
```

---

### Task 9: Documentation

**Files:**
- Modify: `docs/playtime.md`, `README.md`

- [ ] **Step 1: `docs/playtime.md`.** Replace the intro's "on the main menu" with "in the Grown-ups section of the main menu". In Semantics, replace the "A lock always clears itself 12 hours…" bullet with: "Without a schedule, a lock clears itself 12 hours after the game was last touched. With a schedule it holds until the next day's start time." Replace the "**No PIN.**" bullet with: "**Grown-ups PIN.** Four digits, stored under `minicraft:v1:pin`. Required to open the Grown-ups section once set. Forgotten: run `localStorage.removeItem('minicraft:v1:pin')` in the browser console on the game's tab; nothing else is lost." Add a section before "## How to unlock":

```markdown
## Schedule

In Grown-ups, *Lock to world* picks Noah's world, *Play for* the daily
minutes, *Not before* the earliest start (local time). Save. From then on the
menu shows only that world with a Play button: disabled with `Play at 7:00`
before the start time, `45 minutes today` after it, `N minutes left` if he
quit early, and `All done for today` once the limit is reached. There is no
break under a schedule; the limit ends play for the day and the freeze screen
says `PLAY AGAIN AT 7:00 AM TOMORROW` with a MENU button. A session belongs to
the local day it started on; tomorrow is a fresh one.

Ten more minutes today: Grown-ups → PIN → *Unlock*, which clears the session
(a fresh full limit, not ten minutes). To play a grown-up's own world: *Turn
off*, play, then set it up again.

A game already running does not notice a Save or Turn off made in another
tab; it keeps its old session until it reloads. The schedule record is
`minicraft:v1:schedule`; a present but unreadable record locks the menu
(`Something's wrong · ask a grown-up`) rather than opening it.
```

Update the Pieces table with `src/game/schedule.ts`, `src/persistence/schedule.ts`, `src/ui/menu-model.ts` rows and the stored record line (`startedAt`). In "How to unlock", add "or press MENU on the freeze screen".

- [ ] **Step 2: README.** Rewrite the play-time bullet (line ~118):

```markdown
- **Play-time limit and schedule** for grown-ups, behind a 4-digit PIN in the menu's *Grown-ups* section. Either *Play for* 15–90 minutes with an optional *Then break for*, or lock the menu to one world with a daily *Play for* and *Not before* time: before that time the kid sees only `Play at 7:00` and a disabled button; after it, one session per day. Large `END IN 5 MINUTES` / `END IN 2 MINUTES` warnings, then `TIME'S UP`. Only visible play counts. Forgot the PIN: `localStorage.removeItem('minicraft:v1:pin')` in the browser console on the game's tab. See [`docs/playtime.md`](docs/playtime.md).
```

- [ ] **Step 3: Commit**

```bash
git add docs/playtime.md README.md
git commit -m "docs: schedule and grown-ups PIN"
```

---

### Task 10: Manual check at localhost

No files. Use a local-only world at `localhost:5173`, never production. Playwright MCP tools; the pointer-lock stub from `docs/superpowers/plans/2026-09-06-sponge.md` Task 6 when in game. Read storage with `localStorage.getItem(...)` on the menu and `window.__mc` in game. Screenshots to the scratchpad.

1. No PIN: Grown-ups opens at once; `#sched-world` is disabled with the hint. Set PIN 1234. Reload: Grown-ups asks for the PIN; 0000 → `Wrong PIN`; 1234 opens.
2. Viewport 1280×800 with the real world list: open Grown-ups, pick the local world, Play for 15, Not before = two minutes from now (type into `#sched-start`), scroll to Save (the page must scroll), Save. The locked card shows `Play at H:MM`, `#play-button` disabled, no world list. Wait ≤ 2.5 min without reloading: the button enables (30 s refresh).
3. Play: world loads; `minicraft:v1:playtime` has `startedAt` and `limitMs: 900000`.
4. Set the stored session to 14.5 minutes played with today's `startedAt`, reload, Play: `END IN 1 MINUTE`, freeze, `PLAY AGAIN AT H:MM TOMORROW`, MENU button. Press MENU: card says `All done for today`, Play disabled. Set `updatedAt` to 13 h ago (same day), reload: still locked. Set `startedAt` to yesterday, reload: Play enabled, `15 minutes today`.
5. Grown-ups → PIN → `Unlock · fresh 15 minutes now`: card shows `15 minutes today`, Play enabled.
6. Grown-ups → Turn off: normal menu with world lists and New World.
7. `localStorage.setItem('minicraft:v1:schedule', '{}')`, reload: `Something's wrong · ask a grown-up`, Play disabled, Grown-ups opens, Turn off recovers.
8. `npm run build`; `grep -c "minicraft:v1:pin" dist/assets/*.js` ≥ 1; `grep -c __mc dist/assets/*.js` is 0.
9. Report pass/fail per step with the storage readings and screenshots. Leave the local storage clean (Turn off, Remove PIN) at the end.
