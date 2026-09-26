import { describe, it, expect, vi } from 'vitest';
import { PlaytimeController, type PlaytimeDeps } from './playtime-controller';
import type { PlaytimeSession } from './playtime';
import { WARNING_SHOW_MS } from '../data/playtime.data';

const MIN = 60_000;
const T0 = 1_700_000_000_000;

function session(over: Partial<PlaytimeSession> = {}): PlaytimeSession {
	return { limitMs: 30 * MIN, breakMs: null, playedMs: 0, frozenAt: null, updatedAt: T0, startedAt: T0, ...over };
}

type Harness = {
	ctl: PlaytimeController;
	calls: string[];
	saved: PlaytimeSession[];
	clock: { now: number; visible: boolean };
};

function harness(s: PlaytimeSession, now = T0, lockedText?: string, expired?: () => { title: string; text: string } | null, load?: () => PlaytimeSession | null): Harness {
	const calls: string[] = [];
	const saved: PlaytimeSession[] = [];
	const clock = { now, visible: true };
	const h: Partial<Harness> = { calls, saved, clock };
	const deps: PlaytimeDeps = {
		overlay: {
			warn: (text, ms) => calls.push(`warn:${text}:${ms}`),
			freeze: (t, title) => calls.push(`overlay.freeze:${t ?? ''}${title ? `:${title}` : ''}`),
			unfreeze: () => calls.push('unfreeze'),
		},
		freeze: () => calls.push('deps.freeze'),
		resume: () => calls.push('deps.resume'),
		save: (x) => saved.push({ ...x }),
		now: () => clock.now,
		visible: () => clock.visible,
		lockedText,
		expired,
		load,
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

describe('PlaytimeController expiry (the day changed)', () => {
	it('freezes once with the expiry text, then does nothing more', () => {
		let stop: { title: string; text: string } | null = null;
		const h = harness(session({ playedMs: 0, limitMs: 24 * 60 * MIN }), T0, undefined, () => stop);
		advance(h, 5_000);
		expect(h.calls).toEqual([]);
		stop = { title: 'TIME TO STOP', text: 'A PARENT CHANGED THE PLAN' };
		advance(h, 1_000);
		expect(h.calls).toEqual(['deps.freeze', 'overlay.freeze:A PARENT CHANGED THE PLAN:TIME TO STOP']);
		h.calls.length = 0;
		advance(h, 60_000);
		expect(h.calls).toEqual([]);
	});
	it('a session already frozen by its limit is not frozen twice', () => {
		const h = harness(session({ playedMs: 30 * MIN, frozenAt: T0 }), T0, undefined, () => ({ title: 'TIME TO STOP', text: 'X' }));
		h.ctl.tick();
		// The limit's own freeze (TIME'S UP, ASK A PARENT), not the new-day one.
		expect(h.calls).toEqual(['deps.freeze', 'overlay.freeze:']);
		h.calls.length = 0;
		advance(h, 5_000);
		expect(h.calls).toEqual([]);
	});
});

describe('PlaytimeController two tabs', () => {
	it("adopts another tab's higher played time for the same session, and freezes on it", () => {
		const mine = session({ playedMs: 5 * MIN });
		let stored: PlaytimeSession | null = { ...mine, playedMs: 30 * MIN };
		const h = harness(mine, T0, undefined, undefined, () => stored);
		h.ctl.tick();
		expect(h.calls).toEqual(['deps.freeze', 'overlay.freeze:']);
		// A different session in storage (another plan, a reset) is not adopted.
		const h2 = harness(session({ playedMs: 5 * MIN }), T0, undefined, undefined, () => stored);
		stored = session({ playedMs: 29 * MIN, startedAt: T0 + 1 });
		h2.ctl.tick();
		expect(h2.ctl.remainingMs()).toBe(25 * MIN);
	});
	it("does not adopt another plan's session, and never past the limit", () => {
		const mine = session({ playedMs: 5 * MIN, planId: 'p1' });
		const other = { ...mine, playedMs: 20 * MIN, planId: 'p2' };
		const h = harness(mine, T0, undefined, undefined, () => other);
		h.ctl.tick();
		expect(h.ctl.remainingMs()).toBe(25 * MIN);
		const over = { ...mine, playedMs: 90 * MIN };
		const h2 = harness({ ...mine }, T0, undefined, undefined, () => over);
		h2.ctl.tick();
		expect(h2.saved.at(-1)!.playedMs).toBe(30 * MIN);
	});
});
