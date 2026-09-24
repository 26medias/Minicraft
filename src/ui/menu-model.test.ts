import { describe, it, expect } from 'vitest';
import { menuModel, newWorldFields, planSave, type MenuInput } from './menu-model';
import type { Schedule } from '../game/schedule';
import type { PlaytimeSession } from '../game/playtime';
import type { WorldSummary } from '../persistence/adapter';

const MIN = 60_000;
const at = (d: number, h: number, mi: number) => new Date(2026, 8, d, h, mi).getTime();
const schedule: Schedule = { worldId: 'w1', seed: 42, name: "Noah's World", limitMin: 45, startMin: 420 };
const w1: WorldSummary = { id: 'w1', seed: 42, name: "Noah's World", createdAt: 0, updatedAt: 0, origin: 'local', version: 2 };
const base = (over: Partial<MenuInput> = {}): MenuInput => ({
	schedule: { kind: 'armed', schedule }, session: null, worlds: [w1], offline: false, now: at(7, 9, 0), notice: null, ...over,
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
		expect(menuModel(base({ schedule: { kind: 'none' } }))).toEqual({ mode: 'full', notice: null });
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
	it('row order: loading beats a closed gate', () => {
		expect(card(base({ worlds: null, now: at(7, 6, 0) })).line).toBe('Loading…');
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
		expect(m.world).toEqual({ id: 'w1', seed: 42, name: "Noah's World" });
	});
	it('frozen today: all done, disabled', () => {
		const m = card(base({ session: sess({ playedMs: 45 * MIN, frozenAt: at(7, 7, 55), updatedAt: at(7, 7, 55) }) }));
		expect(m.line.startsWith('All done for today · play again at ')).toBe(true);
		expect(m.line.endsWith(' tomorrow')).toBe(true);
		expect(m.playEnabled).toBe(false);
	});
	it('a frozen session hours later (no break ever ends it) still reads all done', () => {
		const over = sess({ playedMs: 45 * MIN, frozenAt: at(7, 7, 55), updatedAt: at(7, 7, 55) });
		const m = card(base({ session: over, now: at(7, 9, 0) }));
		expect(m.line.startsWith('All done for today')).toBe(true);
		expect(m.playEnabled).toBe(false);
	});
	it('canStartNow agrees with playEnabled across the day matrix', async () => {
		const { canStartNow } = await import('../game/schedule');
		const sessions = [null, sess(), sess({ playedMs: 45 * MIN, frozenAt: at(7, 7, 55), updatedAt: at(7, 7, 55) }),
			sess({ startedAt: at(6, 7, 10), playedMs: 45 * MIN, frozenAt: at(6, 7, 55), updatedAt: at(6, 7, 55) })];
		for (const session of sessions) for (const now of [at(7, 5, 0), at(7, 7, 0), at(7, 20, 0), at(8, 5, 0), at(8, 7, 0)]) {
			const i = base({ session, now });
			expect(card(i).playEnabled, `${session?.startedAt} @ ${now}`).toBe(canStartNow(i.schedule, session, now));
		}
	});
	it("frozen yesterday, today at 07:00: fresh day", () => {
		const y = sess({ startedAt: at(6, 7, 10), playedMs: 45 * MIN, frozenAt: at(6, 7, 55), updatedAt: at(6, 7, 55) });
		const m = card(base({ session: y, now: at(7, 7, 0) }));
		expect(m.line).toBe('45 minutes today');
		expect(m.playEnabled).toBe(true);
	});
	it('planSave: schedule after the start time writes a done-for-today session', () => {
		const p = planSave({ worldId: 'w1', limitMin: 45, startRaw: '07:00' }, [w1], at(7, 22, 0));
		expect(p.kind).toBe('schedule');
		if (p.kind !== 'schedule') return;
		expect(p.schedule).toEqual({ worldId: 'w1', seed: 42, name: "Noah's World", limitMin: 45, startMin: 420 });
		expect(p.session?.frozenAt).toBe(at(7, 22, 0));
	});
	it('planSave: schedule before the start time writes no session', () => {
		const p = planSave({ worldId: 'w1', limitMin: 45, startRaw: '07:00' }, [w1], at(7, 6, 0));
		expect(p.kind === 'schedule' && p.session).toBeNull();
	});
	it('planSave: no schedule passes the maximum through (no break); bad inputs are errors', () => {
		expect(planSave({ worldId: '', limitMin: 30, startRaw: '' }, [w1], at(7, 6, 0))).toEqual({ kind: 'none', limitMin: 30 });
		expect(planSave({ worldId: '', limitMin: null, startRaw: '' }, [w1], at(7, 6, 0))).toEqual({ kind: 'none', limitMin: null });
		expect(planSave({ worldId: 'nope', limitMin: 30, startRaw: '07:00' }, [w1], at(7, 6, 0))).toEqual({ kind: 'error', message: 'Pick a world' });
		expect(planSave({ worldId: 'w1', limitMin: 30, startRaw: '' }, [w1], at(7, 6, 0))).toEqual({ kind: 'error', message: 'Pick a start time' });
		expect(planSave({ worldId: 'w1', limitMin: null, startRaw: '07:00' }, [w1], at(7, 6, 0))).toEqual({ kind: 'error', message: 'Pick a play time' });
	});
	it('legacy id resolves to the adopted uuid and Play carries it', () => {
		const leg = { ...schedule, worldId: 'legacy:42' };
		const m = card(base({ schedule: { kind: 'armed', schedule: leg }, worlds: [{ ...w1, id: 'uuid-9' }] }));
		expect(m.world).toEqual({ id: 'uuid-9', seed: 42, name: "Noah's World" });
		expect(m.playEnabled).toBe(true);
	});
});

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
describe('newWorldFields (spec §3 New World checkbox)', () => {
	it('carries the checkbox into mustMine; unchecked is false', () => {
		// Catches the checkbox being drawn but never read (every new world unlimited).
		expect(newWorldFields({ nameRaw: 'Cave', seedRaw: '42', mustMine: true })).toEqual({ name: 'Cave', seed: 42, mustMine: true });
		expect(newWorldFields({ nameRaw: 'Cave', seedRaw: '42', mustMine: false }).mustMine).toBe(false);
	});
	it("keeps today's defaults for a blank name and a junk seed", () => {
		// Catches the refactor changing what Create did before (blank name → "My World", NaN seed → 0).
		expect(newWorldFields({ nameRaw: '   ', seedRaw: 'abc', mustMine: false })).toEqual({ name: 'My World', seed: 0, mustMine: false });
	});
});
