import { describe, it, expect, vi } from 'vitest';
import { PlaytimeController, resolveSession, type PlaytimeDeps } from './playtime-controller';
import type { PlaytimeSession } from './playtime';
import { STALE_SESSION_MS, WARNING_SHOW_MS } from '../data/playtime.data';

const MIN = 60_000;
const T0 = 1_700_000_000_000;

function session(over: Partial<PlaytimeSession> = {}): PlaytimeSession {
	return { limitMs: 30 * MIN, breakMs: null, playedMs: 0, frozenAt: null, updatedAt: T0, startedAt: T0, ...over };
}

describe('resolveSession', () => {
	const sched = { worldId: 'w', seed: 1, name: 'n', limitMin: 45, startMin: 420 };
	it('creates a fresh no-break session from the chosen duration when nothing is stored', () => {
		expect(resolveSession(null, 30, T0)).toEqual(session());
		expect(resolveSession(null, 15, T0)).toEqual({
			limitMs: 15 * MIN, breakMs: null, playedMs: 0, frozenAt: null, startedAt: T0, updatedAt: T0,
		});
	});
	it('returns null (no controller) when nothing is in force and the duration is No limit', () => {
		expect(resolveSession(null, null, T0)).toBeNull();
		const stale = session({ playedMs: 5 * MIN });
		expect(resolveSession(stale, null, T0 + STALE_SESSION_MS + 1)).toBeNull();
	});
	it('resumes a playing session unchanged, ignoring the chosen duration', () => {
		const stored = session({ playedMs: 10 * MIN });
		expect(resolveSession(stored, 15, T0 + MIN)).toEqual(stored);
	});
	it('an in-force session wins even over No limit', () => {
		const stored = session({ playedMs: 10 * MIN });
		expect(resolveSession(stored, null, T0 + MIN)).toEqual(stored);
	});
	it('a stored frozen session plus No limit → the frozen session', () => {
		const stored = session({ playedMs: 30 * MIN, frozenAt: T0 });
		expect(resolveSession(stored, null, T0 + 5 * MIN)).toEqual(stored);
	});
	it('keeps a frozen session long after (no break ever ends it), until it goes stale', () => {
		const stored = session({ playedMs: 30 * MIN, frozenAt: T0 });
		expect(resolveSession(stored, 30, T0 + 25 * MIN)).toEqual(stored);
		expect(resolveSession(stored, 30, T0 + 3 * 60 * MIN)).toEqual(stored);
	});
	it('replaces a stale session', () => {
		const stored = session({ playedMs: 5 * MIN });
		const now = T0 + STALE_SESSION_MS + 1;
		expect(resolveSession(stored, 30, now)).toEqual(session({ updatedAt: now, startedAt: now }));
	});
	it('stamps startedAt = now on a fresh session', () => {
		expect(resolveSession(null, 30, T0 + 5)!.startedAt).toBe(T0 + 5);
	});
	it("with a schedule, keeps today's 13-hour-old playing session", () => {
		const day = new Date(2026, 8, 7, 7, 10).getTime();
		const stored = session({ startedAt: day, updatedAt: day, playedMs: 5 * MIN });
		expect(resolveSession(stored, 45, day + 13 * 60 * MIN, sched)).toEqual(stored);
	});
	it('with a schedule, a frozen session from today stays locked', () => {
		const day = new Date(2026, 8, 7, 7, 10).getTime();
		const over = session({ startedAt: day, updatedAt: day + 45 * MIN, playedMs: 45 * MIN, frozenAt: day + 45 * MIN });
		const got = resolveSession(over, 45, day + 2 * 60 * MIN, sched);
		expect(got).toEqual(over);
	});
	it("with a schedule, discards yesterday's session", () => {
		const yday = new Date(2026, 8, 6, 7, 10).getTime();
		const now = new Date(2026, 8, 7, 7, 0).getTime();
		const stored = session({ startedAt: yday, updatedAt: yday + 5 * MIN, playedMs: 5 * MIN });
		expect(resolveSession(stored, 45, now, sched)).toEqual({
			limitMs: 45 * MIN, breakMs: null, playedMs: 0, frozenAt: null, startedAt: now, updatedAt: now,
		});
	});
});

type Harness = {
	ctl: PlaytimeController;
	calls: string[];
	saved: PlaytimeSession[];
	clock: { now: number; visible: boolean };
};

function harness(s: PlaytimeSession, now = T0, lockedText?: string): Harness {
	const calls: string[] = [];
	const saved: PlaytimeSession[] = [];
	const clock = { now, visible: true };
	const h: Partial<Harness> = { calls, saved, clock };
	const deps: PlaytimeDeps = {
		overlay: {
			warn: (text, ms) => calls.push(`warn:${text}:${ms}`),
			freeze: (t) => calls.push(`overlay.freeze:${t ?? ''}`),
			unfreeze: () => calls.push('unfreeze'),
		},
		freeze: () => calls.push('deps.freeze'),
		resume: () => calls.push('deps.resume'),
		save: (x) => saved.push({ ...x }),
		now: () => clock.now,
		visible: () => clock.visible,
		lockedText,
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

	it('on freeze calls deps.freeze, then overlay.freeze, and nothing more while frozen', () => {
		const h = harness(session({ playedMs: 30 * MIN - 1000 }));
		h.ctl.tick();
		h.calls.length = 0;
		advance(h, 1000);
		expect(h.calls).toEqual(['deps.freeze', 'overlay.freeze:']);
		h.calls.length = 0;
		advance(h, 60 * 60_000);
		expect(h.calls).toEqual([]);
	});

	it('a session constructed frozen long ago freezes once and never resumes', () => {
		const h = harness(session({ playedMs: 30 * MIN, frozenAt: T0 - 25 * MIN }));
		h.ctl.tick();
		advance(h, 5000);
		expect(h.calls).toEqual(['deps.freeze', 'overlay.freeze:']);
		expect(h.calls).not.toContain('deps.resume');
		expect(h.calls).not.toContain('unfreeze');
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

	it('passes lockedText through to the overlay on a freeze', () => {
		const h = harness(session({ playedMs: 30 * MIN }), T0, 'PLAY AGAIN AT 7:00 AM TOMORROW');
		h.ctl.tick();
		expect(h.calls).toContain('overlay.freeze:PLAY AGAIN AT 7:00 AM TOMORROW');
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

describe('PlaytimeController without break time', () => {
	it('has no playAgain: nothing ends a freeze', () => {
		const h = harness(session({ playedMs: 30 * MIN, frozenAt: T0 - 20 * MIN }));
		expect('playAgain' in h.ctl).toBe(false);
	});
});
