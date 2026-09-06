# Play-Time Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A parent sets "Play for N minutes, then break for M" on the main menu; the game warns at 5 and 2 minutes, freezes at the limit, counts the break down, and offers PLAY AGAIN.

**Architecture:** A pure state machine (`src/game/playtime.ts`) counts visible play time and wall-clock break time from a persisted `{limitMs, breakMs, playedMs, frozenAt, updatedAt}` record. Storage (`src/persistence/playtime.ts`), the DOM overlay (`src/ui/playtime-overlay.ts`), and the menu section are separate units; `src/main.ts` composes them and gates input while `GameLoop.paused` is set.

**Tech Stack:** TypeScript (strict), Vite, Three.js, vitest (node environment: no DOM tests possible), plain DOM for UI.

**Spec:** `docs/superpowers/specs/2026-09-06-play-time-limit-design.md` — read it first; the plan argues from it.

## Global Constraints

- Indentation: 1 tab = 4 spaces (tabs in source, as the repo already uses).
- vitest runs in `environment: 'node'`. DOM modules (`ui/*`) get no unit tests; they are checked by `npx tsc -b` and the manual pass in Task 9.
- Never point anything at `https://noah.leap-forward.ca`. Manual tests use `localhost:5173` only.
- Copy, verbatim: `END IN 5 MINUTES`, `END IN 1 MINUTE`, `TIME'S UP`, `PLAY AGAIN IN 20 MINUTES`, `PLAY AGAIN IN 1 MINUTE`, `ASK A GROWN-UP`, `PLAY AGAIN`. Menu labels: `Play time`, `Play for`, `Then break for`, `Off`, `Until a grown-up unlocks`, `Start fresh`, `Unlock`.
- Storage keys: options `minicraft:v1:options` (existing), session `minicraft:v1:playtime` (new).
- Every new test must be run and seen to FAIL before the implementation that makes it pass is written.
- Stage explicit paths on every commit (`git add <paths>`); never `git add -A`.
- Do not modify the world save format, `PersistenceAdapter`, or anything under `api/`.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_013iT9aEJFRZmSuCLmrCcEBz
  ```

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/data/playtime.data.ts` | choices, thresholds, durations (pure data) | 1 |
| `src/data/keybindings.data.ts` | `Options` gains `playLimitMin`, `playBreakMin` | 1 |
| `src/persistence/options.ts` (+test) | default/validate the two fields | 1 |
| `src/game/playtime.ts` (+test) | `PlaytimeSession`, `PlayTimer`, `phaseOf`, `isStale` | 2 |
| `src/persistence/playtime.ts` (+test) | load/save/clear session, `applyPlaytimeSetting` | 3 |
| `src/game/loop.ts` (+test) | `paused` | 4 |
| `src/ui/playtime-overlay.ts`, `src/ui/ui.css` | warning band, freeze overlay, `<select>` style | 5 |
| `src/ui/menu.ts` | Play time section + status row | 6 |
| `src/game/playtime-controller.ts` (+test) | `resolveSession`, `PlaytimeController` (event dispatch, save, play-again) | 7 |
| `src/main.ts` | DOM/loop callbacks, input gating | 8 |
| `docs/playtime.md`, `docs/persistence.md`, `README.md` | docs | 9 |
| (none) | manual browser verification | 10 |

Dependency order: **Task 1 → Task 2 → Task 3** (Task 2 imports Task 1's data file; Task 3 imports Task 2's type and Task 1's `Options` fields and `loadOptions` behaviour, so neither can reach its green step without its predecessor). Tasks 4 and 5 are independent of everything and of each other. Task 6 depends on 1–3. Task 7 (controller) depends on 1–2 and 5's interface. Task 8 (wiring) depends on 1–7. Tasks 9 and 10 depend on 8.

---

### Task 1: Data file and Options fields

**Files:**
- Create: `src/data/playtime.data.ts`
- Modify: `src/data/keybindings.data.ts` (the `Options` type at the bottom)
- Modify: `src/persistence/options.ts`
- Test: `src/persistence/options.test.ts`

**Interfaces:**
- Produces: `PLAY_LIMIT_CHOICES_MIN`, `PLAY_BREAK_CHOICES_MIN`, `WARNING_THRESHOLDS_MS`, `WARNING_SHOW_MS`, `STALE_SESSION_MS`, `MAX_TICK_CREDIT_MS`, `TICK_MS` (all `number` / `number[]`); `Options.playLimitMin: number | null`, `Options.playBreakMin: number | null`.

- [ ] **Step 1: Write the failing tests** — append to `src/persistence/options.test.ts` inside the existing `describe('loadOptions', …)` block (it already stubs `localStorage` in `beforeEach`):

```ts
	it('defaults play-time fields to null when absent', async () => {
		const { loadOptions } = await import('./options');
		const opts = loadOptions();
		expect(opts.playLimitMin).toBeNull();
		expect(opts.playBreakMin).toBeNull();
	});

	it('round-trips play-time fields', async () => {
		const { loadOptions, saveOptions } = await import('./options');
		const opts = loadOptions();
		opts.playLimitMin = 30;
		opts.playBreakMin = 20;
		saveOptions(opts);
		const back = loadOptions();
		expect(back.playLimitMin).toBe(30);
		expect(back.playBreakMin).toBe(20);
	});

	it('rejects play-time values that are not in the choice lists', async () => {
		store['minicraft:v1:options'] = JSON.stringify({
			kidMode: true,
			keybindings: DEFAULT_KEYBINDINGS,
			playLimitMin: '30',
			playBreakMin: 7,
		});
		const { loadOptions } = await import('./options');
		const opts = loadOptions();
		expect(opts.playLimitMin).toBeNull();
		expect(opts.playBreakMin).toBeNull();
	});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/persistence/options.test.ts`
Expected: the first two FAIL (`expected undefined to be null`, `expected undefined to be 30`); the third FAILS with a TypeScript-free runtime `expected undefined to be null`. If any of the three passes, the test is wrong; stop and fix it.

- [ ] **Step 3: Create `src/data/playtime.data.ts`**

```ts
/** Choices offered on the main menu, in minutes. Order is display order. */
export const PLAY_LIMIT_CHOICES_MIN = [15, 20, 30, 45, 60, 90];
export const PLAY_BREAK_CHOICES_MIN = [10, 15, 20, 30, 60];

/** Play-time-remaining thresholds at which a warning fires, descending. */
export const WARNING_THRESHOLDS_MS = [5 * 60_000, 2 * 60_000];
export const WARNING_SHOW_MS = 10_000;

/** A session untouched for this long is discarded; a no-break lock clears itself. */
export const STALE_SESSION_MS = 12 * 3_600_000;

/** Longest gap one tick may add to playedMs; caps throttled or slept intervals. */
export const MAX_TICK_CREDIT_MS = 2_000;
export const TICK_MS = 1_000;
```

- [ ] **Step 4: Extend `Options`** in `src/data/keybindings.data.ts`:

```ts
export type Options = {
	kidMode: boolean;
	keybindings: Record<Action, string>;
	currentLightColor: string;
	/** Minutes of play per session; null = Off. */
	playLimitMin: number | null;
	/** Minutes of break after the limit; null = until a grown-up unlocks. */
	playBreakMin: number | null;
};
```

- [ ] **Step 5: Update `src/persistence/options.ts`**

Add the import and a validator, extend `defaults()` and the return of `loadOptions()`:

```ts
import { ACTIONS, DEFAULT_KEYBINDINGS, type Action, type Options } from '../data/keybindings.data';
import { PLAY_BREAK_CHOICES_MIN, PLAY_LIMIT_CHOICES_MIN } from '../data/playtime.data';

const KEY = 'minicraft:v1:options';
const DEFAULT_LIGHT_COLOR = '#FFF5E0'; // warm white

/** Only a member of the choice list gets through; a string "30" must not reach the timer arithmetic. */
function choiceOrNull(value: unknown, choices: number[]): number | null {
	return typeof value === 'number' && choices.includes(value) ? value : null;
}

function defaults(): Options {
	return {
		kidMode: true,
		keybindings: { ...DEFAULT_KEYBINDINGS },
		currentLightColor: DEFAULT_LIGHT_COLOR,
		playLimitMin: null,
		playBreakMin: null,
	};
}
```

and in `loadOptions()` replace the `return { … }` with:

```ts
		return {
			kidMode: parsed.kidMode ?? true,
			keybindings: filteredBindings,
			currentLightColor: parsed.currentLightColor ?? DEFAULT_LIGHT_COLOR,
			playLimitMin: choiceOrNull(parsed.playLimitMin, PLAY_LIMIT_CHOICES_MIN),
			playBreakMin: choiceOrNull(parsed.playBreakMin, PLAY_BREAK_CHOICES_MIN),
		};
```

- [ ] **Step 6: Run tests and type-check**

Run: `npx vitest run src/persistence/options.test.ts && npx tsc -b`
Expected: 7 tests PASS; tsc clean. (`ui/options.ts` builds `this.current` from `loadOptions()`, so it needs no change.)

- [ ] **Step 7: Commit**

```bash
git add src/data/playtime.data.ts src/data/keybindings.data.ts src/persistence/options.ts src/persistence/options.test.ts
git commit -m "feat(playtime): data file and play-time option fields"
```

---

### Task 2: `PlayTimer` state machine

**Files:**
- Create: `src/game/playtime.ts`
- Test: `src/game/playtime.test.ts`

**Interfaces:**
- Consumes: constants from `src/data/playtime.data.ts` (Task 1).
- Produces:
  ```ts
  export type PlaytimeSession = { limitMs: number; breakMs: number | null; playedMs: number; frozenAt: number | null; updatedAt: number };
  export type PlaytimePhase = 'playing' | 'break' | 'over';
  export type PlaytimeEvent = { type: 'warn'; minutesLeft: number } | { type: 'freeze'; breakEndsAt: number | null } | { type: 'break-over' };
  export function phaseOf(session: PlaytimeSession, now: number): PlaytimePhase;
  export function isStale(session: PlaytimeSession, now: number): boolean;
  export class PlayTimer { constructor(session: PlaytimeSession, now: number); readonly session: PlaytimeSession; dirty: boolean; tick(now: number, visible: boolean): PlaytimeEvent[]; phase(): PlaytimePhase; remainingMs(): number; breakRemainingMs(): number; }
  ```

- [ ] **Step 1: Write the failing tests** — create `src/game/playtime.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PlayTimer, phaseOf, isStale, type PlaytimeSession } from './playtime';
import { MAX_TICK_CREDIT_MS, STALE_SESSION_MS } from '../data/playtime.data';

const MIN = 60_000;
const T0 = 1_700_000_000_000;

function session(over: Partial<PlaytimeSession> = {}): PlaytimeSession {
	return { limitMs: 30 * MIN, breakMs: 20 * MIN, playedMs: 0, frozenAt: null, updatedAt: T0, ...over };
}

/** Drive one visible tick per second from `from` to `to` (exclusive), collecting events. */
function play(timer: PlayTimer, from: number, to: number, visible = true) {
	const events = [];
	for (let t = from; t < to; t += 1000) events.push(...timer.tick(t, visible));
	return events;
}

describe('phaseOf', () => {
	it('is playing while not frozen', () => {
		expect(phaseOf(session(), T0)).toBe('playing');
	});
	it('is break forever when frozen with no break', () => {
		const s = session({ breakMs: null, frozenAt: T0 });
		expect(phaseOf(s, T0 + 100 * 3_600_000)).toBe('break');
	});
	it('is break until frozenAt + breakMs, then over', () => {
		const s = session({ frozenAt: T0 });
		expect(phaseOf(s, T0 + 20 * MIN - 1)).toBe('break');
		expect(phaseOf(s, T0 + 20 * MIN)).toBe('over');
	});
});

describe('isStale', () => {
	it('is stale after STALE_SESSION_MS since updatedAt', () => {
		expect(isStale(session(), T0 + STALE_SESSION_MS)).toBe(false);
		expect(isStale(session(), T0 + STALE_SESSION_MS + 1)).toBe(true);
	});
	it('is stale when updatedAt is in the future beyond one tick credit', () => {
		expect(isStale(session({ updatedAt: T0 + MAX_TICK_CREDIT_MS }), T0)).toBe(false);
		expect(isStale(session({ updatedAt: T0 + MAX_TICK_CREDIT_MS + 1 }), T0)).toBe(true);
	});
});

describe('PlayTimer play phase', () => {
	it('accrues play time only on visible ticks', () => {
		const timer = new PlayTimer(session(), T0);
		play(timer, T0 + 1000, T0 + 11_000);
		expect(timer.session.playedMs).toBe(10_000);
		play(timer, T0 + 11_000, T0 + 21_000, false);
		expect(timer.session.playedMs).toBe(10_000);
	});

	it('credits at most MAX_TICK_CREDIT_MS for one tick', () => {
		const timer = new PlayTimer(session(), T0);
		timer.tick(T0 + 10 * MIN, true);
		expect(timer.session.playedMs).toBe(MAX_TICK_CREDIT_MS);
	});

	it('adds nothing when the clock goes backwards', () => {
		const timer = new PlayTimer(session(), T0);
		timer.tick(T0 + 1000, true);
		timer.tick(T0 - 5 * MIN, true);
		expect(timer.session.playedMs).toBe(1000);
		// Ticks resume from the new clock; the next second credits one second.
		timer.tick(T0 - 5 * MIN + 1000, true);
		expect(timer.session.playedMs).toBe(2000);
	});

	it('sets dirty and updatedAt only on ticks that changed something', () => {
		const timer = new PlayTimer(session(), T0);
		timer.tick(T0, true);
		expect(timer.dirty).toBe(false);
		timer.tick(T0 + 1000, true);
		expect(timer.dirty).toBe(true);
		expect(timer.session.updatedAt).toBe(T0 + 1000);
		timer.tick(T0 + 2000, false);
		expect(timer.dirty).toBe(false);
	});

	it('remainingMs never goes below zero', () => {
		const timer = new PlayTimer(session({ playedMs: 31 * MIN }), T0);
		expect(timer.remainingMs()).toBe(0);
	});
});

describe('PlayTimer warnings', () => {
	it('fires warn(5) then warn(2) once each at the thresholds', () => {
		const timer = new PlayTimer(session({ playedMs: 24 * MIN }), T0);
		const events = play(timer, T0, T0 + 5 * MIN);
		expect(events).toEqual([
			{ type: 'warn', minutesLeft: 5 },
			{ type: 'warn', minutesLeft: 2 },
		]);
	});

	it('fires only the lowest crossed threshold on the first tick', () => {
		const timer = new PlayTimer(session({ playedMs: 30 * MIN - 90_000 }), T0);
		expect(timer.tick(T0, true)).toEqual([{ type: 'warn', minutesLeft: 2 }]);
		expect(play(timer, T0 + 1000, T0 + 60_000)).toEqual([]);
	});

	it('announces once when both thresholds are crossed by the same tick', () => {
		// Reachable only on a resume (each tick credits at most 2 s); the session is
		// mutated directly to reach the state, which is what a resume looks like.
		const timer = new PlayTimer(session({ playedMs: 24 * MIN }), T0);
		timer.session.playedMs = 29 * MIN;
		expect(timer.tick(T0 + 1000, false)).toEqual([{ type: 'warn', minutesLeft: 1 }]);
		expect(play(timer, T0 + 2000, T0 + 30_000)).toEqual([]);
	});

	it('rounds up: 3 min 20 s left says 4', () => {
		const timer = new PlayTimer(session({ playedMs: 30 * MIN - 200_000 }), T0);
		expect(timer.tick(T0, true)).toEqual([{ type: 'warn', minutesLeft: 4 }]);
	});

	it('reports at least 1 minute', () => {
		const timer = new PlayTimer(session({ playedMs: 30 * MIN - 500 }), T0);
		expect(timer.tick(T0, true)).toEqual([{ type: 'warn', minutesLeft: 1 }]);
	});
});

describe('PlayTimer freeze and break', () => {
	it('fires freeze exactly once when play time reaches the limit, with no warn on that tick', () => {
		const timer = new PlayTimer(session({ playedMs: 30 * MIN - 1000 }), T0);
		timer.tick(T0, true); // warn(1)
		const events = timer.tick(T0 + 1000, true);
		expect(events).toEqual([{ type: 'freeze', breakEndsAt: T0 + 1000 + 20 * MIN }]);
		expect(timer.session.frozenAt).toBe(T0 + 1000);
		expect(timer.dirty).toBe(true);
		expect(timer.tick(T0 + 2000, true)).toEqual([]);
		expect(timer.phase()).toBe('break');
	});

	it('fires freeze on the first tick when constructed already frozen', () => {
		const timer = new PlayTimer(session({ playedMs: 30 * MIN, frozenAt: T0 - 5 * MIN }), T0);
		expect(timer.tick(T0, true)).toEqual([{ type: 'freeze', breakEndsAt: T0 + 15 * MIN }]);
		expect(timer.breakRemainingMs()).toBe(15 * MIN);
	});

	it('freezes with breakEndsAt null and never fires break-over when there is no break', () => {
		const timer = new PlayTimer(session({ breakMs: null, playedMs: 30 * MIN }), T0);
		expect(timer.tick(T0, true)).toEqual([{ type: 'freeze', breakEndsAt: null }]);
		expect(play(timer, T0 + 1000, T0 + 2 * 3_600_000)).toEqual([]);
		expect(timer.phase()).toBe('break');
		expect(timer.breakRemainingMs()).toBe(Infinity);
	});

	it('fires break-over exactly once when the break ends', () => {
		const timer = new PlayTimer(session({ playedMs: 30 * MIN, frozenAt: T0 }), T0);
		timer.tick(T0, true);
		expect(play(timer, T0 + 1000, T0 + 20 * MIN)).toEqual([]);
		expect(timer.tick(T0 + 20 * MIN, true)).toEqual([{ type: 'break-over' }]);
		expect(timer.tick(T0 + 20 * MIN + 1000, true)).toEqual([]);
		expect(timer.phase()).toBe('over');
	});

	it('fires [freeze, break-over] in one tick when constructed past the break end', () => {
		const timer = new PlayTimer(session({ playedMs: 30 * MIN, frozenAt: T0 - 25 * MIN }), T0);
		expect(timer.tick(T0, true)).toEqual([
			{ type: 'freeze', breakEndsAt: T0 - 5 * MIN },
			{ type: 'break-over' },
		]);
	});

	it('does not accrue play time while frozen', () => {
		const timer = new PlayTimer(session({ playedMs: 30 * MIN, frozenAt: T0 }), T0);
		play(timer, T0, T0 + 10_000);
		expect(timer.session.playedMs).toBe(30 * MIN);
	});

	it('re-anchors the break when the clock is set back so the countdown stays honest', () => {
		const timer = new PlayTimer(session({ playedMs: 30 * MIN, frozenAt: T0 }), T0);
		timer.tick(T0, true);
		timer.tick(T0 + 19 * MIN, true);
		expect(timer.breakRemainingMs()).toBe(1 * MIN);
		timer.tick(T0 + 5 * MIN, true); // clock set back 14 minutes
		expect(timer.breakRemainingMs()).toBe(1 * MIN);
		expect(timer.session.frozenAt).toBe(T0 - 14 * MIN);
		expect(timer.dirty).toBe(true);
		expect(timer.phase()).toBe('break');
		// One more minute on the new clock and the break is over, not 15 minutes later.
		expect(play(timer, T0 + 5 * MIN + 1000, T0 + 6 * MIN)).toEqual([]);
		expect(timer.tick(T0 + 6 * MIN, true)).toEqual([{ type: 'break-over' }]);
	});
});

describe('PlayTimer full sequence', () => {
	it('warns at 25 and 28 minutes, freezes at 30, break-over at 50', () => {
		const timer = new PlayTimer(session(), T0);
		const events = play(timer, T0, T0 + 51 * MIN);
		expect(events).toEqual([
			{ type: 'warn', minutesLeft: 5 },
			{ type: 'warn', minutesLeft: 2 },
			{ type: 'freeze', breakEndsAt: T0 + 30 * MIN + 20 * MIN },
			{ type: 'break-over' },
		]);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/game/playtime.test.ts`
Expected: FAIL, "Failed to resolve import './playtime'".

- [ ] **Step 3: Implement `src/game/playtime.ts`**

```ts
import {
	MAX_TICK_CREDIT_MS,
	STALE_SESSION_MS,
	WARNING_THRESHOLDS_MS,
} from '../data/playtime.data';

/**
 * The persisted play-time session. Phase is derived from these fields and
 * `now`, never stored. Play time (`playedMs`) counts only visible ticks; the
 * break (`frozenAt + breakMs`) is wall clock so closing the tab cannot shorten it.
 */
export type PlaytimeSession = {
	limitMs: number;
	/** null = until a grown-up presses Unlock on the menu. */
	breakMs: number | null;
	playedMs: number;
	/** Wall clock when the limit was hit; null while playing. */
	frozenAt: number | null;
	/** Wall clock of the last write; drives staleness. */
	updatedAt: number;
};

export type PlaytimePhase = 'playing' | 'break' | 'over';

export type PlaytimeEvent =
	| { type: 'warn'; minutesLeft: number }
	| { type: 'freeze'; breakEndsAt: number | null }
	| { type: 'break-over' };

export function phaseOf(session: PlaytimeSession, now: number): PlaytimePhase {
	if (session.frozenAt === null) return 'playing';
	if (session.breakMs === null) return 'break';
	return now < session.frozenAt + session.breakMs ? 'break' : 'over';
}

/**
 * A session untouched for STALE_SESSION_MS is discarded so a no-break lock
 * from last night does not need re-arming every morning. A session written
 * under a clock that has since been set back is garbage too.
 */
export function isStale(session: PlaytimeSession, now: number): boolean {
	return now - session.updatedAt > STALE_SESSION_MS || session.updatedAt > now + MAX_TICK_CREDIT_MS;
}

export class PlayTimer {
	readonly session: PlaytimeSession;
	/** True when the last tick changed something worth persisting. */
	dirty = false;
	private lastNow: number;
	private firedThreshold: boolean[];
	private freezeFired = false;
	private breakOverFired = false;

	constructor(session: PlaytimeSession, now: number) {
		this.session = { ...session };
		this.lastNow = now;
		this.firedThreshold = WARNING_THRESHOLDS_MS.map(() => false);
	}

	/**
	 * Advance to `now`. Play time accrues only when `visible`, by at most
	 * MAX_TICK_CREDIT_MS per call. A `now` earlier than the previous one (clock
	 * set back by Δ) adds nothing and never un-fires anything; a running break
	 * is re-anchored by Δ so its remaining time is unchanged and keeps counting
	 * down. Returns the events that fired, in order.
	 */
	tick(now: number, visible: boolean): PlaytimeEvent[] {
		const events: PlaytimeEvent[] = [];
		this.dirty = false;
		const s = this.session;
		const raw = now - this.lastNow;
		const delta = Math.max(0, Math.min(raw, MAX_TICK_CREDIT_MS));
		if (raw < 0 && s.frozenAt !== null) {
			// Clock went back: shift the break anchor with it. A monotonic clamp
			// would instead freeze the countdown for as long as the jump.
			s.frozenAt += raw;
			s.updatedAt = now;
			this.dirty = true;
		}
		this.lastNow = now;

		if (s.frozenAt === null) {
			if (visible && delta > 0) {
				s.playedMs = Math.min(s.limitMs, s.playedMs + delta);
				s.updatedAt = now;
				this.dirty = true;
			}
			if (s.playedMs >= s.limitMs) {
				s.frozenAt = now;
				s.updatedAt = now;
				this.dirty = true;
			}
		}

		if (s.frozenAt !== null) {
			if (!this.freezeFired) {
				this.freezeFired = true;
				events.push({
					type: 'freeze',
					breakEndsAt: s.breakMs === null ? null : s.frozenAt + s.breakMs,
				});
			}
			if (s.breakMs !== null && !this.breakOverFired && now >= s.frozenAt + s.breakMs) {
				this.breakOverFired = true;
				events.push({ type: 'break-over' });
			}
			return events;
		}

		// Warnings: mark every crossed threshold fired, announce once if any was new.
		const remaining = this.remainingMs();
		let fired = false;
		for (let i = 0; i < WARNING_THRESHOLDS_MS.length; i++) {
			if (remaining <= WARNING_THRESHOLDS_MS[i] && !this.firedThreshold[i]) {
				this.firedThreshold[i] = true;
				fired = true;
			}
		}
		if (fired) {
			events.push({ type: 'warn', minutesLeft: Math.max(1, Math.ceil(remaining / 60_000)) });
		}
		return events;
	}

	phase(): PlaytimePhase {
		return phaseOf(this.session, this.lastNow);
	}

	remainingMs(): number {
		return Math.max(0, this.session.limitMs - this.session.playedMs);
	}

	/** Break time left as of the last tick; Infinity when there is no break or no freeze yet. */
	breakRemainingMs(): number {
		const s = this.session;
		if (s.frozenAt === null || s.breakMs === null) return Infinity;
		return Math.max(0, s.frozenAt + s.breakMs - this.lastNow);
	}
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/game/playtime.test.ts`
Expected: all PASS. The constructor does not tick, so in "announces once when both thresholds are crossed" the first `tick` crosses both and exactly one `warn(1)` must come out.

- [ ] **Step 5: Commit**

```bash
git add src/game/playtime.ts src/game/playtime.test.ts
git commit -m "feat(playtime): PlayTimer state machine"
```

---

### Task 3: Session storage and the menu helper

**Files:**
- Create: `src/persistence/playtime.ts`
- Test: `src/persistence/playtime.test.ts`

**Interfaces:**
- Consumes: `PlaytimeSession` (Task 2), `loadOptions`/`saveOptions` and `Options` (Task 1).
- Produces:
  ```ts
  export const PLAYTIME_KEY = 'minicraft:v1:playtime';
  export function loadSession(): PlaytimeSession | null;
  export function saveSession(s: PlaytimeSession): void;
  export function clearSession(): void;
  export function applyPlaytimeSetting(patch: Partial<Pick<Options, 'playLimitMin' | 'playBreakMin'>>): Options;
  ```

- [ ] **Step 1: Write the failing tests** — create `src/persistence/playtime.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PlaytimeSession } from '../game/playtime';

const store: Record<string, string> = {};
const localStorageMock = {
	getItem: (k: string) => store[k] ?? null,
	setItem: (k: string, v: string) => {
		store[k] = v;
	},
	removeItem: (k: string) => {
		delete store[k];
	},
	clear: () => {
		for (const k of Object.keys(store)) delete store[k];
	},
};

beforeEach(() => {
	vi.stubGlobal('localStorage', localStorageMock);
	localStorageMock.clear();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const KEY = 'minicraft:v1:playtime';

function valid(over: Partial<PlaytimeSession> = {}): PlaytimeSession {
	return { limitMs: 1_800_000, breakMs: 1_200_000, playedMs: 0, frozenAt: null, updatedAt: 1, ...over };
}

describe('playtime session storage', () => {
	it('returns null when nothing is stored', async () => {
		const { loadSession } = await import('./playtime');
		expect(loadSession()).toBeNull();
	});

	it('round-trips a session', async () => {
		const { loadSession, saveSession } = await import('./playtime');
		const s = valid({ playedMs: 5000, frozenAt: 99, updatedAt: 100 });
		saveSession(s);
		expect(loadSession()).toEqual(s);
	});

	it('round-trips a no-break session', async () => {
		const { loadSession, saveSession } = await import('./playtime');
		saveSession(valid({ breakMs: null }));
		expect(loadSession()?.breakMs).toBeNull();
	});

	it('returns null for garbage JSON', async () => {
		store[KEY] = 'not-json{{{';
		const { loadSession } = await import('./playtime');
		expect(loadSession()).toBeNull();
	});

	it.each([
		['limitMs zero', { limitMs: 0 }],
		['limitMs string', { limitMs: '1800000' }],
		['breakMs zero', { breakMs: 0 }],
		['breakMs absent (JSON drops undefined)', { breakMs: undefined }],
		['playedMs negative', { playedMs: -1 }],
		['playedMs null (what JSON makes of NaN)', { playedMs: null }],
		['frozenAt string', { frozenAt: 'now' }],
		['updatedAt absent (JSON drops undefined)', { updatedAt: undefined }],
	])('returns null for wrong shape: %s', async (_name, over) => {
		store[KEY] = JSON.stringify({ ...valid(), ...over });
		const { loadSession } = await import('./playtime');
		expect(loadSession()).toBeNull();
	});

	it('clearSession removes the key', async () => {
		const { saveSession, clearSession } = await import('./playtime');
		saveSession(valid());
		clearSession();
		expect(store[KEY]).toBeUndefined();
	});

	it('saveSession swallows storage errors', async () => {
		const { saveSession } = await import('./playtime');
		// Restore in `finally`: the mock object is shared across tests and
		// vi.unstubAllGlobals() does not undo a mutation of it.
		const real = localStorageMock.setItem;
		localStorageMock.setItem = () => {
			throw new Error('quota');
		};
		try {
			expect(() => saveSession(valid())).not.toThrow();
		} finally {
			localStorageMock.setItem = real;
		}
	});

	it('saving the Options screen does not remove the session', async () => {
		const { saveSession } = await import('./playtime');
		const { loadOptions, saveOptions } = await import('./options');
		saveSession(valid());
		saveOptions(loadOptions());
		expect(store[KEY]).toBeDefined();
	});
});

describe('applyPlaytimeSetting', () => {
	it('saves the patched options and clears the session', async () => {
		const { applyPlaytimeSetting, saveSession } = await import('./playtime');
		const { loadOptions } = await import('./options');
		saveSession(valid());
		const result = applyPlaytimeSetting({ playLimitMin: 30 });
		expect(result.playLimitMin).toBe(30);
		expect(loadOptions().playLimitMin).toBe(30);
		expect(store[KEY]).toBeUndefined();
	});

	it('keeps playBreakMin when playLimitMin is set to Off', async () => {
		const { applyPlaytimeSetting } = await import('./playtime');
		const { loadOptions } = await import('./options');
		applyPlaytimeSetting({ playLimitMin: 30, playBreakMin: 20 });
		applyPlaytimeSetting({ playLimitMin: null });
		expect(loadOptions().playBreakMin).toBe(20);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/persistence/playtime.test.ts`
Expected: FAIL, "Failed to resolve import './playtime'".

- [ ] **Step 3: Implement `src/persistence/playtime.ts`**

```ts
import type { PlaytimeSession } from '../game/playtime';
import type { Options } from '../data/keybindings.data';
import { loadOptions, saveOptions } from './options';

export const PLAYTIME_KEY = 'minicraft:v1:playtime';

function isFiniteNumber(v: unknown): v is number {
	return typeof v === 'number' && Number.isFinite(v);
}

function isSession(v: unknown): v is PlaytimeSession {
	if (typeof v !== 'object' || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		isFiniteNumber(o.limitMs) &&
		o.limitMs > 0 &&
		(o.breakMs === null || (isFiniteNumber(o.breakMs) && o.breakMs > 0)) &&
		isFiniteNumber(o.playedMs) &&
		o.playedMs >= 0 &&
		(o.frozenAt === null || isFiniteNumber(o.frozenAt)) &&
		isFiniteNumber(o.updatedAt)
	);
}

/** null for a missing key, unparseable JSON, or a wrong-shaped record. */
export function loadSession(): PlaytimeSession | null {
	let raw: string | null;
	try {
		raw = localStorage.getItem(PLAYTIME_KEY);
	} catch {
		return null;
	}
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isSession(parsed)) return null;
		const { limitMs, breakMs, playedMs, frozenAt, updatedAt } = parsed;
		return { limitMs, breakMs, playedMs, frozenAt, updatedAt };
	} catch {
		return null;
	}
}

/** Storage errors (quota, private mode) are swallowed: the in-memory timer still enforces the limit. */
export function saveSession(s: PlaytimeSession): void {
	try {
		localStorage.setItem(PLAYTIME_KEY, JSON.stringify(s));
	} catch {
		// Nothing useful to do; the timer keeps running in memory.
	}
}

export function clearSession(): void {
	try {
		localStorage.removeItem(PLAYTIME_KEY);
	} catch {
		// Same as above.
	}
}

/**
 * Menu helper: patch the play-time options, persist them, and drop any stored
 * session. Both dropdowns and both buttons on the menu go through here or
 * through clearSession(), so "the parent changed something" always unlocks.
 */
export function applyPlaytimeSetting(
	patch: Partial<Pick<Options, 'playLimitMin' | 'playBreakMin'>>,
): Options {
	const opts = loadOptions();
	if ('playLimitMin' in patch) opts.playLimitMin = patch.playLimitMin ?? null;
	if ('playBreakMin' in patch) opts.playBreakMin = patch.playBreakMin ?? null;
	saveOptions(opts);
	clearSession();
	return opts;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/persistence/playtime.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/persistence/playtime.ts src/persistence/playtime.test.ts
git commit -m "feat(playtime): session storage and menu helper"
```

---

### Task 4: `GameLoop.paused`

**Files:**
- Modify: `src/game/loop.ts` (fields near line 41, `setLeftMouseDown` ~line 111, `tick` ~line 132)
- Test: `src/game/loop.test.ts`

**Interfaces:**
- Produces: `GameLoop.paused: boolean` (public, default `false`).

- [ ] **Step 1: Rewrite the test stub and add the failing test.** In `src/game/loop.test.ts`, replace `makeLoop()` so the renderer stub **captures** the tick function and counts chunk mounts, and `keys` is a real `Keys` object:

```ts
// GameLoop's constructor only builds the LiquidScheduler; it never dereferences
// the renderer, so a stub keeps this test out of WebGL and off the DOM. The stub
// captures the tick callback so tests can drive a full tick() headlessly.
function makeLoop() {
	const world = new World(1);
	const chunk = world.ensureChunk(16, 16);
	chunk.blocks.fill(AIR);
	chunk.lights.fill(0);
	chunk.liquidFrontier.clear();

	let tickFn: ((dt: number) => void) | null = null;
	let mounts = 0;
	const renderer = {
		camera: new THREE.PerspectiveCamera(),
		mountChunkMesh: () => {
			mounts++;
		},
		onTick: (fn: (dt: number) => void) => {
			tickFn = fn;
		},
	} as unknown as Renderer;

	const keys: Keys = { forward: false, back: false, left: false, right: false, jump: false };
	const player = new Player([260, 40, 260]);

	const loop = new GameLoop(world, renderer, new FpCamera(), player, keys, () => [0, 0, 1, 1]);
	loop.start();
	const tick = (dt: number) => tickFn!(dt);
	return { loop, world, player, keys, tick, mounts: () => mounts };
}
```

Then append a new `describe` block:

```ts
describe('GameLoop.paused', () => {
	it('stops physics and simulation but keeps loading chunks', () => {
		const { loop, world, player, keys, tick, mounts } = makeLoop();
		world.setBlock(260, 30, 260, tnt);
		world.setBlock(261, 30, 260, stone);
		let mutations = 0;
		loop.onWorldMutated = () => {
			mutations++;
		};
		expect(loop.ignite({ x: 260, y: 30, z: 260 } as never)).toBe(true);

		keys.forward = true;
		loop.paused = true;
		const before = [...player.position];
		// Each tick loads/meshes chunks (~50 ms), so use few, long ticks:
		// Player.update sub-steps internally and 3 × 1 s > TNT_PRIME_FUSE (2.5 s).
		for (let i = 0; i < 3; i++) tick(1.0);
		expect(player.position).toEqual(before);
		expect(mutations).toBe(0);
		expect(world.getBlock(261, 30, 260)).toBe(stone);
		expect(mounts()).toBeGreaterThan(0);

		loop.paused = false;
		for (let i = 0; i < 3; i++) tick(1.0);
		expect(player.position).not.toEqual(before);
		expect(mutations).toBeGreaterThan(0);
		expect(world.getBlock(261, 30, 260)).toBe(AIR);
	}, 30_000);
});
```

(The three existing tests keep calling `loop.simulate(...)` and are unchanged.
`setLeftMouseDown` gating has no observable effect without a tick that hits a
block in the look direction, so it is not unit-tested here; Task 9 step 3
checks it in the browser. Do not add a test that asserts `miningProgress() === 0`
without a tick: it passes with or without the gate.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/game/loop.test.ts`
Expected: the new test FAILS at `expect(player.position).toEqual(before)` (gravity moved the player to about y = -24) in well under 5 s; TypeScript may also complain that `paused` does not exist. The three existing tests still PASS. If instead you see "Test timed out", the tick count or dt was changed; 3 ticks of 1.0 s were measured at 0.6 s red / 1.0 s green.

- [ ] **Step 3: Implement**

In `src/game/loop.ts`, add a public field next to the callbacks:

```ts
	/**
	 * Set by the play-time limit. While true, tick() only syncs the camera and
	 * keeps loading/meshing chunks: no physics, mining, particles, or simulation.
	 * Chunks keep loading so a world opened straight into a break is not empty sky.
	 */
	paused = false;
```

Change `setLeftMouseDown`:

```ts
	setLeftMouseDown(down: boolean) {
		// A press is ignored while paused; a release is always honoured so a
		// freeze can clear in-progress mining.
		if (down && this.paused) return;
		this.leftMouseDown = down;
		if (!down) this.mining = null;
	}
```

Make the guard the **first statement** of `tick()` (before `getLookDir`/`player.update`, so gravity does not run through a break):

```ts
	private tick(dt: number) {
		if (this.paused) {
			this.cam.sync(this.renderer.camera);
			this.loadNearbyChunks();
			this.flushDirtyChunks();
			return;
		}
		// Use getLookDir() …
```

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run src/game/loop.test.ts && npx tsc -b`
Expected: 4 PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/game/loop.ts src/game/loop.test.ts
git commit -m "feat(loop): paused flag that keeps chunks loading"
```

---

### Task 5: Overlay and CSS

**Files:**
- Create: `src/ui/playtime-overlay.ts`
- Modify: `src/ui/ui.css` (append; also add `z-index: 40` to `#save-status`)

**Interfaces:**
- Produces:
  ```ts
  export class PlaytimeOverlay {
  	constructor(container: HTMLElement);
  	warn(text: string, ms: number): void;
  	freeze(breakEndsAt: number | null): void;
  	setBreakRemaining(ms: number): void;
  	offerPlayAgain(onClick: () => void): void;
  	unfreeze(): void;
  }
  ```
- No unit test (node env). Verified by `npx tsc -b` here and the browser pass in Task 9.

- [ ] **Step 1: Create `src/ui/playtime-overlay.ts`**

```ts
/**
 * Two overlays for the play-time limit. The warning band sits in the upper
 * third with pointer-events none so the kid keeps playing through it. The
 * freeze overlay covers everything and swallows clicks so the canvas cannot
 * re-acquire pointer lock.
 */
export class PlaytimeOverlay {
	private warning: HTMLDivElement;
	private warningTimer: ReturnType<typeof setTimeout> | null = null;
	private freezeEl: HTMLDivElement;
	private countdown: HTMLDivElement | null = null;

	constructor(container: HTMLElement) {
		this.warning = document.createElement('div');
		this.warning.id = 'playtime-warning';
		container.appendChild(this.warning);

		this.freezeEl = document.createElement('div');
		this.freezeEl.id = 'playtime-freeze';
		this.freezeEl.classList.add('hidden');
		container.appendChild(this.freezeEl);
	}

	warn(text: string, ms: number): void {
		this.warning.textContent = text;
		this.warning.classList.add('visible');
		if (this.warningTimer) clearTimeout(this.warningTimer);
		this.warningTimer = setTimeout(() => {
			this.warning.classList.remove('visible');
			this.warningTimer = null;
		}, ms);
	}

	private hideWarning(): void {
		if (this.warningTimer) clearTimeout(this.warningTimer);
		this.warningTimer = null;
		this.warning.classList.remove('visible');
	}

	freeze(breakEndsAt: number | null): void {
		this.hideWarning();
		this.freezeEl.innerHTML = '';
		const title = document.createElement('div');
		title.className = 'playtime-title';
		title.textContent = "TIME'S UP";
		this.freezeEl.appendChild(title);

		const line = document.createElement('div');
		line.className = 'playtime-line';
		if (breakEndsAt === null) {
			line.textContent = 'ASK A GROWN-UP';
			this.countdown = null;
		} else {
			this.countdown = line;
		}
		this.freezeEl.appendChild(line);
		this.freezeEl.classList.remove('hidden');
	}

	/** No-op when the overlay has no countdown (no-break freeze) or `ms` is not finite. */
	setBreakRemaining(ms: number): void {
		if (!this.countdown || !Number.isFinite(ms)) return;
		const n = Math.max(1, Math.ceil(ms / 60_000));
		this.countdown.textContent = `PLAY AGAIN IN ${n} MINUTE${n === 1 ? '' : 'S'}`;
	}

	offerPlayAgain(onClick: () => void): void {
		if (!this.countdown) return;
		const btn = document.createElement('button');
		btn.className = 'playtime-button';
		btn.textContent = 'PLAY AGAIN';
		btn.onclick = onClick;
		this.countdown.replaceWith(btn);
		this.countdown = null;
	}

	unfreeze(): void {
		this.freezeEl.classList.add('hidden');
		this.freezeEl.innerHTML = '';
		this.countdown = null;
	}
}
```

- [ ] **Step 2: Append to `src/ui/ui.css`** and add `z-index: 40;` inside the existing `#save-status` rule:

```css
/* Play-time limit. Warning: upper third, click-through. Freeze: covers all. */
#playtime-warning {
	position: fixed;
	top: 18vh;
	left: 50%;
	transform: translateX(-50%);
	max-width: 92vw;
	box-sizing: border-box;
	padding: 2vh 4vw;
	background: rgba(0, 0, 0, 0.6);
	color: #fff;
	font: bold 8vw/1.1 system-ui, sans-serif;
	letter-spacing: 0.04em;
	text-align: center;
	text-transform: uppercase;
	border-radius: 12px;
	pointer-events: none;
	opacity: 0;
	transition: opacity 0.4s;
	z-index: 25;
}
#playtime-warning.visible {
	opacity: 1;
}
#playtime-freeze {
	position: fixed;
	inset: 0;
	background: rgba(0, 0, 0, 0.75);
	color: #fff;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 4vh;
	text-align: center;
	text-transform: uppercase;
	pointer-events: auto;
	z-index: 30;
}
#playtime-freeze.hidden {
	display: none;
}
.playtime-title {
	font: bold 12vw/1.05 system-ui, sans-serif;
	max-width: 92vw;
	letter-spacing: 0.04em;
}
.playtime-line {
	font: bold 5vw/1.2 system-ui, sans-serif;
	max-width: 92vw;
	opacity: 0.9;
}
.playtime-button {
	font: bold 6vw/1 system-ui, sans-serif;
	padding: 3vh 8vw;
	background: #3c9a3c;
	color: #fff;
	border: none;
	border-radius: 16px;
	cursor: pointer;
	text-transform: uppercase;
}
.playtime-button:hover {
	background: #4cb54c;
}
.menu-card select {
	width: 100%;
	padding: 8px;
	font-size: 14px;
	background: #1b1b1b;
	border: 1px solid #4a4a4a;
	color: #fff;
	border-radius: 4px;
	box-sizing: border-box;
}
.playtime-row {
	margin: 8px 0;
}
.playtime-status {
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 8px;
	margin: 8px 0;
	padding: 8px;
	background: #1b1b1b;
	border-radius: 4px;
	color: #f0c070;
	font-size: 13px;
}
.playtime-status button {
	width: auto;
	margin: 0;
	padding: 6px 12px;
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc -b`
Expected: clean (the class is not yet imported anywhere; that is fine).

- [ ] **Step 4: Commit**

```bash
git add src/ui/playtime-overlay.ts src/ui/ui.css
git commit -m "feat(playtime): warning and freeze overlays"
```

---

### Task 6: Main-menu "Play time" section

**Files:**
- Modify: `src/ui/menu.ts` (`renderHome`, add `renderPlaytime`)

**Interfaces:**
- Consumes: `loadOptions` (Task 1); `PLAY_LIMIT_CHOICES_MIN`, `PLAY_BREAK_CHOICES_MIN` (Task 1); `applyPlaytimeSetting`, `clearSession`, `loadSession` (Task 3); `phaseOf`, `isStale` (Task 2).
- Produces: nothing new for other tasks; the menu writes options and the session directly.

- [ ] **Step 1: Add imports** at the top of `src/ui/menu.ts`:

```ts
import { loadOptions } from '../persistence/options';
import { PLAY_BREAK_CHOICES_MIN, PLAY_LIMIT_CHOICES_MIN } from '../data/playtime.data';
import { applyPlaytimeSetting, clearSession, loadSession } from '../persistence/playtime';
import { isStale, phaseOf } from '../game/playtime';
```

- [ ] **Step 2: Render the section before and after the world-list await.** In `renderHome()`, right after the first `this.root.appendChild(card);` (the "Loading worlds…" card), add:

```ts
		this.renderPlaytime(card);
```

and after `this.renderSection(card, 'On this device', local);` and before the Options button, add:

```ts
		this.renderPlaytime(card);
```

- [ ] **Step 3: Add the method** to `MainMenu` (after `renderSection`):

```ts
	/**
	 * Parent controls. Every change and both buttons clear the stored session,
	 * which is the unlock path: re-selecting a dropdown at its current value
	 * fires no change event, so the buttons must exist for that case.
	 */
	private renderPlaytime(card: HTMLElement) {
		const opts = loadOptions();
		const section = document.createElement('div');
		section.className = 'playtime-section';

		const h = document.createElement('div');
		h.className = 'menu-section';
		h.textContent = 'Play time';
		section.appendChild(h);

		const limitRow = document.createElement('div');
		limitRow.className = 'playtime-row';
		const limitLabel = document.createElement('label');
		limitLabel.textContent = 'Play for';
		const limit = document.createElement('select');
		limit.id = 'playtime-limit';
		const off = document.createElement('option');
		off.value = '';
		off.textContent = 'Off';
		limit.appendChild(off);
		for (const m of PLAY_LIMIT_CHOICES_MIN) {
			const o = document.createElement('option');
			o.value = String(m);
			o.textContent = `${m} minutes`;
			limit.appendChild(o);
		}
		limit.value = opts.playLimitMin === null ? '' : String(opts.playLimitMin);
		limit.onchange = () => {
			applyPlaytimeSetting({ playLimitMin: limit.value === '' ? null : Number(limit.value) });
			this.rerenderPlaytime(card, section);
		};
		limitLabel.appendChild(document.createElement('br'));
		limitLabel.appendChild(limit);
		limitRow.appendChild(limitLabel);
		section.appendChild(limitRow);

		if (opts.playLimitMin !== null) {
			const breakRow = document.createElement('div');
			breakRow.className = 'playtime-row';
			const breakLabel = document.createElement('label');
			breakLabel.textContent = 'Then break for';
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
			brk.value = opts.playBreakMin === null ? '' : String(opts.playBreakMin);
			brk.onchange = () => {
				applyPlaytimeSetting({ playBreakMin: brk.value === '' ? null : Number(brk.value) });
				this.rerenderPlaytime(card, section);
			};
			breakLabel.appendChild(document.createElement('br'));
			breakLabel.appendChild(brk);
			breakRow.appendChild(breakLabel);
			section.appendChild(breakRow);
		}

		const now = Date.now();
		const session = loadSession();
		if (session && !isStale(session, now)) {
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
					text.textContent = 'Locked — ask a grown-up';
					btn.textContent = 'Unlock';
				} else {
					const left = Math.max(
						1,
						Math.ceil((session.frozenAt! + session.breakMs - now) / 60_000),
					);
					text.textContent = `Break, ${left} minute${left === 1 ? '' : 's'} left`;
					btn.textContent = 'Unlock';
				}
				btn.onclick = () => {
					clearSession();
					this.rerenderPlaytime(card, section);
				};
				status.appendChild(text);
				status.appendChild(btn);
				section.appendChild(status);
			}
		}

		card.appendChild(section);
	}

	private rerenderPlaytime(card: HTMLElement, old: HTMLElement) {
		const marker = document.createElement('div');
		old.replaceWith(marker);
		this.renderPlaytime(card);
		// renderPlaytime appended at the end; move the fresh section to where the old one was.
		marker.replaceWith(card.lastElementChild!);
	}
```

- [ ] **Step 4: Type-check and run the whole suite**

Run: `npx tsc -b && npx vitest run`
Expected: clean; all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/menu.ts
git commit -m "feat(menu): play-time section with unlock"
```

---

### Task 7: `PlaytimeController` (testable wiring)

**Files:**
- Create: `src/game/playtime-controller.ts`
- Test: `src/game/playtime-controller.test.ts`

**Interfaces:**
- Consumes: `PlayTimer`, `PlaytimeSession`, `phaseOf`, `isStale` (Task 2); `WARNING_SHOW_MS` (Task 1); the five-method shape of `PlaytimeOverlay` (Task 5, type-only).
- Produces:
  ```ts
  export function resolveSession(stored: PlaytimeSession | null, limitMin: number, breakMin: number | null, now: number): PlaytimeSession;
  export type PlaytimeOverlayLike = { warn(text: string, ms: number): void; freeze(breakEndsAt: number | null): void; setBreakRemaining(ms: number): void; offerPlayAgain(onClick: () => void): void; unfreeze(): void };
  export type PlaytimeDeps = { overlay: PlaytimeOverlayLike; freeze(): void; resume(): void; save(s: PlaytimeSession): void; now(): number; visible(): boolean };
  export class PlaytimeController { constructor(session: PlaytimeSession, deps: PlaytimeDeps); tick(): void; playAgain(): void; }
  ```

- [ ] **Step 1: Write the failing tests** — create `src/game/playtime-controller.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { PlaytimeController, resolveSession, type PlaytimeDeps } from './playtime-controller';
import type { PlaytimeSession } from './playtime';
import { STALE_SESSION_MS, WARNING_SHOW_MS } from '../data/playtime.data';

const MIN = 60_000;
const T0 = 1_700_000_000_000;

function session(over: Partial<PlaytimeSession> = {}): PlaytimeSession {
	return { limitMs: 30 * MIN, breakMs: 20 * MIN, playedMs: 0, frozenAt: null, updatedAt: T0, ...over };
}

describe('resolveSession', () => {
	it('creates a fresh session from the options when nothing is stored', () => {
		expect(resolveSession(null, 30, 20, T0)).toEqual(session());
	});
	it('creates a fresh no-break session when breakMin is null', () => {
		expect(resolveSession(null, 15, null, T0)).toEqual({
			limitMs: 15 * MIN, breakMs: null, playedMs: 0, frozenAt: null, updatedAt: T0,
		});
	});
	it('resumes a playing session unchanged, ignoring the current options', () => {
		const stored = session({ playedMs: 10 * MIN });
		expect(resolveSession(stored, 15, null, T0 + MIN)).toEqual(stored);
	});
	it('keeps a session in its break', () => {
		const stored = session({ playedMs: 30 * MIN, frozenAt: T0 });
		expect(resolveSession(stored, 30, 20, T0 + 5 * MIN)).toEqual(stored);
	});
	it('replaces a session that is over', () => {
		const stored = session({ playedMs: 30 * MIN, frozenAt: T0 });
		const now = T0 + 25 * MIN;
		expect(resolveSession(stored, 30, 20, now)).toEqual(session({ updatedAt: now }));
	});
	it('replaces a stale session', () => {
		const stored = session({ playedMs: 5 * MIN });
		const now = T0 + STALE_SESSION_MS + 1;
		expect(resolveSession(stored, 30, 20, now)).toEqual(session({ updatedAt: now }));
	});
});

type Harness = {
	ctl: PlaytimeController;
	calls: string[];
	saved: PlaytimeSession[];
	clock: { now: number; visible: boolean };
	offered: (() => void) | null;
};

function harness(s: PlaytimeSession, now = T0): Harness {
	const calls: string[] = [];
	const saved: PlaytimeSession[] = [];
	const clock = { now, visible: true };
	const h: Partial<Harness> = { calls, saved, clock, offered: null };
	const deps: PlaytimeDeps = {
		overlay: {
			warn: (text, ms) => calls.push(`warn:${text}:${ms}`),
			freeze: (b) => calls.push(`overlay.freeze:${b}`),
			setBreakRemaining: (ms) => calls.push(`remaining:${ms}`),
			offerPlayAgain: (cb) => {
				h.offered = cb;
				calls.push('offer');
			},
			unfreeze: () => calls.push('unfreeze'),
		},
		freeze: () => calls.push('deps.freeze'),
		resume: () => calls.push('deps.resume'),
		save: (x) => saved.push({ ...x }),
		now: () => clock.now,
		visible: () => clock.visible,
	};
	h.ctl = new PlaytimeController(s, deps);
	return h as Harness;
}

function advance(h: Harness, ms: number) {
	for (let t = 1000; t <= ms; t += 1000) {
		h.clock.now += 1000;
		h.ctl.tick();
	}
}

describe('PlaytimeController.tick', () => {
	it('shows the warning text with the display duration', () => {
		const h = harness(session({ playedMs: 30 * MIN - 90_000 }));
		h.ctl.tick();
		expect(h.calls).toEqual([`warn:END IN 2 MINUTES:${WARNING_SHOW_MS}`]);
		const h1 = harness(session({ playedMs: 30 * MIN - 30_000 }));
		h1.ctl.tick();
		expect(h1.calls).toEqual([`warn:END IN 1 MINUTE:${WARNING_SHOW_MS}`]);
	});

	it('on freeze calls deps.freeze, then overlay.freeze, then starts the countdown', () => {
		const h = harness(session({ playedMs: 30 * MIN - 1000 }));
		h.ctl.tick();
		h.calls.length = 0;
		advance(h, 1000);
		expect(h.calls).toEqual([
			'deps.freeze',
			`overlay.freeze:${T0 + 1000 + 20 * MIN}`,
			`remaining:${20 * MIN}`,
		]);
	});

	it('never calls setBreakRemaining for a no-break freeze', () => {
		const h = harness(session({ breakMs: null, playedMs: 30 * MIN }));
		h.ctl.tick();
		advance(h, 5000);
		expect(h.calls).toEqual(['deps.freeze', 'overlay.freeze:null']);
	});

	it('runs overlay.freeze before offerPlayAgain when both fire in one tick', () => {
		const h = harness(session({ playedMs: 30 * MIN, frozenAt: T0 - 25 * MIN }));
		h.ctl.tick();
		expect(h.calls).toEqual(['deps.freeze', `overlay.freeze:${T0 - 5 * MIN}`, 'offer']);
	});

	it('saves exactly on dirty ticks', () => {
		const h = harness(session());
		h.ctl.tick(); // first tick, nothing changed
		expect(h.saved).toEqual([]);
		advance(h, 2000);
		expect(h.saved.map((x) => x.playedMs)).toEqual([1000, 2000]);
		h.clock.visible = false;
		advance(h, 2000);
		expect(h.saved.length).toBe(2);
	});

	it('does not propagate an overlay exception', () => {
		const h = harness(session({ playedMs: 30 * MIN - 60_000 }));
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		(h.ctl as unknown as { deps: PlaytimeDeps }).deps.overlay.warn = () => {
			throw new Error('boom');
		};
		expect(() => h.ctl.tick()).not.toThrow();
		expect(err).toHaveBeenCalled();
		err.mockRestore();
	});
});

describe('PlaytimeController.playAgain', () => {
	it('saves a fresh session, unfreezes, resumes, and accrues from zero', () => {
		const h = harness(session({ playedMs: 30 * MIN, frozenAt: T0 - 20 * MIN }));
		h.ctl.tick();
		expect(h.offered).not.toBeNull();
		h.calls.length = 0;
		h.clock.now += 1000;
		h.offered!();
		expect(h.calls).toEqual(['unfreeze', 'deps.resume']);
		expect(h.saved.at(-1)).toEqual({
			limitMs: 30 * MIN, breakMs: 20 * MIN, playedMs: 0, frozenAt: null, updatedAt: h.clock.now,
		});
		advance(h, 3000);
		expect(h.saved.at(-1)!.playedMs).toBe(3000);
		expect(h.calls.filter((c) => c.startsWith('deps.freeze'))).toEqual([]);
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/game/playtime-controller.test.ts`
Expected: FAIL, "Failed to resolve import './playtime-controller'".

- [ ] **Step 3: Implement `src/game/playtime-controller.ts`**

```ts
import { WARNING_SHOW_MS } from '../data/playtime.data';
import { PlayTimer, isStale, phaseOf, type PlaytimeSession } from './playtime';

/** The stored session if it is still in force, otherwise a fresh one from the options. */
export function resolveSession(
	stored: PlaytimeSession | null,
	limitMin: number,
	breakMin: number | null,
	now: number,
): PlaytimeSession {
	if (stored && !isStale(stored, now) && phaseOf(stored, now) !== 'over') return stored;
	return {
		limitMs: limitMin * 60_000,
		breakMs: breakMin === null ? null : breakMin * 60_000,
		playedMs: 0,
		frozenAt: null,
		updatedAt: now,
	};
}

export type PlaytimeOverlayLike = {
	warn(text: string, ms: number): void;
	freeze(breakEndsAt: number | null): void;
	setBreakRemaining(ms: number): void;
	offerPlayAgain(onClick: () => void): void;
	unfreeze(): void;
};

export type PlaytimeDeps = {
	overlay: PlaytimeOverlayLike;
	/** Pause the loop, clear input, release pointer lock, flush autosave. */
	freeze(): void;
	/** Unpause the loop, clear input, request pointer lock. */
	resume(): void;
	save(s: PlaytimeSession): void;
	now(): number;
	visible(): boolean;
};

/**
 * Drives a PlayTimer from a 1 s interval and turns its events into overlay
 * and game calls. Pure orchestration: no DOM, no storage, so the dispatch
 * rules can be unit-tested with fake deps.
 */
export class PlaytimeController {
	private timer: PlayTimer;

	constructor(
		session: PlaytimeSession,
		private deps: PlaytimeDeps,
	) {
		this.timer = new PlayTimer(session, deps.now());
	}

	/** Never throws: an exception would kill the interval and the whole limit. */
	tick(): void {
		try {
			this.tickUnsafe();
		} catch (e) {
			console.error('playtime tick failed', e);
		}
	}

	private tickUnsafe(): void {
		const { overlay } = this.deps;
		const events = this.timer.tick(this.deps.now(), this.deps.visible());
		if (this.timer.dirty) this.deps.save(this.timer.session);
		for (const ev of events) {
			if (ev.type === 'warn') {
				overlay.warn(`END IN ${ev.minutesLeft} MINUTE${ev.minutesLeft === 1 ? '' : 'S'}`, WARNING_SHOW_MS);
			} else if (ev.type === 'freeze') {
				this.deps.freeze();
				overlay.freeze(ev.breakEndsAt);
			} else {
				overlay.offerPlayAgain(() => this.playAgain());
			}
		}
		// Only a real break has a countdown; a no-break freeze shows ASK A GROWN-UP.
		if (this.timer.phase() === 'break' && this.timer.session.breakMs !== null) {
			overlay.setBreakRemaining(this.timer.breakRemainingMs());
		}
	}

	playAgain(): void {
		const now = this.deps.now();
		const fresh: PlaytimeSession = {
			limitMs: this.timer.session.limitMs,
			breakMs: this.timer.session.breakMs,
			playedMs: 0,
			frozenAt: null,
			updatedAt: now,
		};
		this.deps.save(fresh);
		this.timer = new PlayTimer(fresh, now);
		this.deps.overlay.unfreeze();
		this.deps.resume();
	}
}
```

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run src/game/playtime-controller.test.ts && npx tsc -b`
Expected: all PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/game/playtime-controller.ts src/game/playtime-controller.test.ts
git commit -m "feat(playtime): controller for event dispatch and play-again"
```

---

### Task 8: Wiring in `main.ts`

**Files:**
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `resolveSession`, `PlaytimeController` (Task 7); `loadSession`, `saveSession` (Task 3); `PlaytimeOverlay` (Task 5); `loop.paused` (Task 4); `TICK_MS` (Task 1); existing `hud.setMiningProgress`, `autosave.flush`, `renderer.gl.domElement`.

- [ ] **Step 1: Imports** — add to the import block at the top of `src/main.ts`:

```ts
import { PlaytimeController, resolveSession } from './game/playtime-controller';
import { loadSession, saveSession } from './persistence/playtime';
import { PlaytimeOverlay } from './ui/playtime-overlay';
import { TICK_MS } from './data/playtime.data';
```

- [ ] **Step 2: Gate the window-level input handlers.** These reference `loop`, which is declared later in `startGame` with `const`; the handlers only run after `loop` exists (no `await` sits between the listener registration and the `const loop`), and the existing `ignite` case already relies on this.

In `onKey`, make the first line of the returned handler:

```ts
		const onKey = (down: boolean) => (e: KeyboardEvent) => {
			// While frozen, no keydown reaches the player, hotbar, TNT, or colour
			// picker. Keyup still runs so `keys` stays truthful.
			if (down && loop.paused) return;
			const a = keyToAction[e.code];
```

In the Tab listener, after `if (e.code !== 'Tab') return;` add:

```ts
			if (loop.paused) return;
```

In the `mousedown` listener, make the first line:

```ts
		window.addEventListener('mousedown', (e) => {
			if (loop.paused) return;
			if (document.pointerLockElement !== renderer.gl.domElement) return;
```

- [ ] **Step 3: Insert the play-time block** immediately **before** `loop.start();` (after `loop.onFlyStateChange = …`):

```ts
		// --- Play-time limit -------------------------------------------------
		// startGame runs at most once per page load (the menu is only reachable
		// at boot and from Options before a game starts; unlock is by reload),
		// so the interval and listener below need no owner, like the window
		// listeners above. The first tick runs before loop.start() on purpose:
		// a session already in its break must freeze before the first frame.
		if (opts.playLimitMin !== null) {
			const resetKeys = () => {
				keys.forward = keys.back = keys.left = keys.right = keys.jump = false;
			};
			const session = resolveSession(loadSession(), opts.playLimitMin, opts.playBreakMin, Date.now());
			saveSession(session);
			const playtime = new PlaytimeController(session, {
				overlay: new PlaytimeOverlay(app),
				freeze: () => {
					loop.setLeftMouseDown(false);
					loop.paused = true;
					resetKeys();
					hud.setMiningProgress(0);
					if (document.pointerLockElement) document.exitPointerLock();
					void autosave.flush();
				},
				resume: () => {
					resetKeys();
					loop.paused = false;
					// Called from the PLAY AGAIN click, a user gesture, so the kid
					// does not need a second click on the canvas. Chrome returns a
					// promise that can reject; that is not an error worth surfacing.
					const p = renderer.gl.domElement.requestPointerLock() as unknown;
					if (p instanceof Promise) p.catch(() => {});
				},
				save: saveSession,
				now: () => Date.now(),
				visible: () => document.visibilityState === 'visible',
			});
			playtime.tick();
			setInterval(() => playtime.tick(), TICK_MS);
			document.addEventListener('visibilitychange', () => playtime.tick());
		}
		// ----------------------------------------------------------------------
		loop.start();
```

`keys`, `hud`, `app`, and `autosave` are already in scope; `autosave` is declared above `loop` in the existing code.

- [ ] **Step 4: Type-check, lint, full suite**

Run: `npx tsc -b && npx eslint src && npx vitest run`
Expected: all clean and green. If `tsc` rejects `requestPointerLock() as unknown` because the lib types it as `void`, keep the cast; it exists precisely because the DOM lib lags Chrome here.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat(playtime): wire controller, overlay, and input gating"
```

---

### Task 9: Docs

**Files:**
- Create: `docs/playtime.md`
- Modify: `docs/persistence.md` (rule 5 under "Durability layers")
- Modify: `README.md` ("Features" list, and the Vitest count in "Tech Stack")

- [ ] **Step 1: Create `docs/playtime.md`**

```markdown
# Play-time limit

A parent sets **Play for** N minutes and optionally **Then break for** M on the
main menu. The game warns at 5 and 2 minutes of play time left
(`END IN 5 MINUTES`, ten seconds, click-through), then freezes under
`TIME'S UP`. With a break it shows `PLAY AGAIN IN 20 MINUTES`, counting down
by the minute, then a `PLAY AGAIN` button that starts a fresh session. Without
a break it shows `ASK A GROWN-UP` and stays frozen until a grown-up reloads and
presses **Unlock** on the menu.

## Semantics

- **Play time** counts only while the page is visible and awake. A closed lid,
  a hidden tab, or a sleeping laptop does not count. Each 1 s tick credits at
  most 2 s, so a throttled or slept interval cannot dump an hour into the count.
- **Break time** is wall clock, so closing the tab does not shorten it.
- The session is **per browser**, not per world.
- A lock always clears itself 12 hours after the game was last touched.
- **No PIN.** The Unlock and Start fresh buttons sit on the same menu the kid
  uses, so a kid who reloads and presses one is through. This limits an honest
  seven-year-old, not a determined one.

## How to unlock

Reload the game's own tab (F5), press **Unlock** (or **Start fresh**) in the
Play time section, then pick the world. Pressing Unlock in a different tab
clears the stored session but does not wake the frozen tab.

## Pieces

| File | Role |
|---|---|
| `src/data/playtime.data.ts` | choices, thresholds, durations |
| `src/game/playtime.ts` | `PlayTimer` state machine; `phaseOf`, `isStale` |
| `src/game/playtime-controller.ts` | `resolveSession`; `PlaytimeController` turns timer events into overlay/game calls |
| `src/persistence/playtime.ts` | `minicraft:v1:playtime` load/save/clear; `applyPlaytimeSetting` |
| `src/ui/playtime-overlay.ts` | warning band and freeze overlay |
| `src/ui/menu.ts` | Play time section with the status row and Unlock / Start fresh |
| `src/main.ts` | 1 s `setInterval` + `visibilitychange` → `controller.tick()`; the freeze/resume callbacks; input gating on `loop.paused` |

Stored record: `{ limitMs, breakMs | null, playedMs, frozenAt | null, updatedAt }`.
Phase is derived: not frozen → playing; frozen with no break → break; before
`frozenAt + breakMs` → break; after → over (a new session may start).

## Freeze

`GameLoop.paused` is checked first thing in `tick()`: no physics, mining,
particles, or simulation, but chunks keep loading and meshing so a world
opened straight into a break is not empty sky. `main.ts` also gates the
window-level keydown, Tab, and mousedown handlers on `loop.paused`, otherwise
fly toggles, hotbar keys, ignite, and the colour picker would act under the
overlay. The overlay swallows clicks so the canvas cannot re-acquire pointer
lock. Autosave is flushed at the freeze (it writes only if something is dirty).

## Testing a freeze without waiting

At `localhost:5173`, set a limit on the menu, then in devtools:

    localStorage.setItem('minicraft:v1:playtime', JSON.stringify({
    	limitMs: 900000, breakMs: 600000, playedMs: 870000, frozenAt: null, updatedAt: Date.now() }))

Reload and pick a world: `END IN 1 MINUTE` at once, freeze after 30 s of
visible play. Never do this on the production site.
```

- [ ] **Step 2: Amend `docs/persistence.md`** rule 5:

```markdown
5. **v1 world keys are read-only, forever.** Nothing in this subsystem writes or
   deletes a `minicraft:v1:world:*` key. (Options and the play-time limit are
   separate subsystems with their own `minicraft:v1:options` and
   `minicraft:v1:playtime` keys, which they do write.)
```

- [ ] **Step 3: README** — add to the "Features" list after the "Rebindable keys" bullet:

```markdown
- **Play-time limit** for grown-ups: on the main menu, *Play for* 15–90 minutes, optionally *Then break for* 10–60 minutes. Large `END IN 5 MINUTES` / `END IN 2 MINUTES` warnings, then `TIME'S UP` freezes the game; a break counts down to a `PLAY AGAIN` button, or without a break the game stays locked until a grown-up presses *Unlock* on the menu. Only visible play counts (a closed lid is not play time); breaks are wall-clock. There is no PIN: the Unlock button is on the same menu the kid uses, so this limits an honest kid, not a determined one. A lock always clears itself 12 hours after the game was last touched. To unlock early: reload the game's tab, press *Unlock*, pick the world. See [`docs/playtime.md`](docs/playtime.md).
```

Also update the test count in the "Tests:" line of "Tech Stack" to the number printed by `npx vitest run`, and add "the play-time timer" to its list.

- [ ] **Step 4: Commit**

```bash
git add docs/playtime.md docs/persistence.md README.md
git commit -m "docs(playtime): subsystem doc, README, persistence note"
```

---

### Task 10: Manual browser verification

**Files:** none. Uses the dev server and a browser automation tool (Playwright MCP or Chrome DevTools MCP), against `http://localhost:5173` only.

- [ ] **Step 1: Start the dev server** in the background: `npm run dev` and wait for `Local: http://localhost:5173/`.

- [ ] **Step 2: Menu.** Open the page. Confirm the "Play time" section shows a "Play for" select with Off selected and no "Then break for" row. Select 15 minutes: the "Then break for" row appears with "Until a grown-up unlocks". Set it to 20 minutes, set "Play for" back to Off (row disappears), then to 15 again: the row comes back still showing 20 minutes. Reload: both selections persist.

Keep the automated tab in the **foreground** for every step below; play time accrues only while `document.visibilityState === 'visible'`, so a backgrounded tab never freezes and looks like a timer bug.

- [ ] **Step 3: No-break freeze.** In the page console:

```js
localStorage.setItem('minicraft:v1:playtime', JSON.stringify({ limitMs: 900000, breakMs: null, playedMs: 870000, frozenAt: null, updatedAt: Date.now() }));
```

Reload. The menu shows `1 minute left [Start fresh]`. Press **Start fresh**: the row disappears and the key is gone. Re-run the `setItem` above and reload. Pick a world. Within a second `END IN 1 MINUTE` appears and the game keeps running behind it. While the band is visible, assert:
- `document.querySelector('#playtime-warning').getBoundingClientRect().bottom < innerHeight * 0.45` (clear of the crosshair),
- click the canvas: `document.pointerLockElement` is set and stays set while the band is up,
- hold left-click on a block for its hardness: the block breaks (mining works under the warning).
The band fades after ~10 s. After ~30 s of the tab being visible, `TIME'S UP / ASK A GROWN-UP` covers the screen. Verify with the tool:
- `document.querySelector('#playtime-freeze').classList.contains('hidden') === false`
- pressing W / F / C / 1 / Tab changes nothing (`#color-picker-root` stays hidden; the hotbar selection is unchanged).
- clicking the centre of the screen does not set `document.pointerLockElement`.
- `JSON.parse(localStorage.getItem('minicraft:v1:playtime')).frozenAt` is a number.

Reload. The menu shows `Locked — ask a grown-up [Unlock]`. Pick the world **without** pressing Unlock: the freeze overlay is visible on the very first frame (check `#playtime-freeze` is not hidden immediately after the menu hides) and terrain renders behind it. Reload, press Unlock, confirm `localStorage.getItem('minicraft:v1:playtime') === null`, pick the world: normal play, no overlay.

- [ ] **Step 4: Break and PLAY AGAIN.** Set "Then break for" to 10 minutes, then in the console:

```js
localStorage.setItem('minicraft:v1:playtime', JSON.stringify({ limitMs: 900000, breakMs: 600000, playedMs: 900000, frozenAt: Date.now() - 595000, updatedAt: Date.now() }));
```

Reload, pick the world: `TIME'S UP / PLAY AGAIN IN 1 MINUTE` immediately, world visible behind. Within ~6 s the line becomes a `PLAY AGAIN` button. Click it: overlay gone, **`document.pointerLockElement` is the canvas immediately after the click** (no second click; if the automation tool cannot grant pointer lock, a human does this one click and reports), the player can move, `playedMs` in storage restarts from 0 and climbs by ~1000 per second while the tab is visible.

- [ ] **Step 4b: A real threshold at game speed.** Set `playedMs: 900000 - 5*60000 - 5000` (15-minute limit, 5 min 5 s left) with `frozenAt: null`, reload, pick the world: after ~5 s of visible play `END IN 5 MINUTES` appears, fades after 10 s, and the game keeps running.

- [ ] **Step 5: Hidden tab does not count.** With a session playing, note `playedMs`, switch to another tab for 20 s, come back: `playedMs` advanced by at most ~2 s.

- [ ] **Step 6: Report** the outcome of each step verbatim (pass/fail with the observed text). Do not deploy.
