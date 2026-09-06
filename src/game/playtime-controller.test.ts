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
