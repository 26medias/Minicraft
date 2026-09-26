import { describe, expect, it } from 'vitest';
import { judgeSafety, Tripwire, type SafetyCtx } from '../../src/brain2/safety.js';
import { Ownership } from '../../src/brain2/ownership.js';
import { StopSignal } from '../../src/body/stop-signal.js';
import { FakeWorld } from '../fake-port.js';

// Gate 2: seed 12345's surface is at y≈104–138, so these tests work in open air at y 200–212, well above it.
import { seededRng } from '../../src/bots/companion.js';
import type { Action } from '../../src/brain2/types.js';

function ctx(over: Partial<SafetyCtx> = {}): SafetyCtx {
	const world = over.world ?? new FakeWorld();
	return {
		world, own: new Ownership(world, () => ({})), kids: [], stop: new StopSignal(600_000), now: 100_000, lastEditT: null,
		noEdits: false, inventory: { stone: 5 }, halted: null, helpBuild: false, planOwns: () => true, ...over,
	};
}
const place = (x: number, y: number, z: number): Action => ({ kind: 'place', cell: { x, y, z }, block: 'stone' });
const brk = (x: number, y: number, z: number): Action => ({ kind: 'break', cell: { x, y, z } });

describe('judgeSafety (spec §7.1)', () => {
	it('non-edit actions always pass', () => {
		expect(judgeSafety({ kind: 'walk', to: { x: 1, z: 1 }, speed: 1 }, ctx({ noEdits: true })).ok).toBe(true);
	});
	it('refuses edits when halted, with --no-edits, inside the edit gap, or with nothing to place', () => {
		expect(judgeSafety(place(5, 210, 5), ctx({ halted: 'rate' })).ok).toBe(false);
		expect(judgeSafety(place(5, 210, 5), ctx({ noEdits: true })).ok).toBe(false);
		expect(judgeSafety(place(5, 210, 5), ctx({ lastEditT: 99_700 })).ok).toBe(false);
		expect(judgeSafety(place(5, 210, 5), ctx({ inventory: {} })).ok).toBe(false);
		expect(judgeSafety({ ...place(5, 210, 5), free: true } as Action, ctx({ inventory: {}, helpBuild: true })).ok).toBe(true);
	});
	it('refuses a kid cell and its buffer; Help-build may place next to kid cells', () => {
		const w = new FakeWorld();
		w.set(10, 210, 10, 'dirt');
		expect(judgeSafety(place(11, 210, 10), ctx({ world: w })).ok).toBe(false);
		expect(judgeSafety(place(11, 210, 10), ctx({ world: w, helpBuild: true })).ok).toBe(true);
		expect(judgeSafety(brk(10, 210, 10), ctx({ world: w, helpBuild: true })).ok).toBe(false);
	});
	// Red if the liquid loop is removed. The cells are set with setNatural, which isn't an edit, so they classify
	// as natural, and the kid-cell buffer can't refuse first (gate 2: with w.set, the kid buffer masked the rule).
	it('refuses a break touching liquid', () => {
		const w = new FakeWorld();
		w.setNatural(20, 200, 20, 'stone');
		w.setNatural(21, 200, 20, 'water');
		expect(judgeSafety(brk(20, 200, 20), ctx({ world: w })).ok).toBe(false);
		w.setNatural(21, 200, 20, 'stone');
		expect(judgeSafety(brk(20, 200, 20), ctx({ world: w })).ok).toBe(true);
	});
	// Red if the 2-block kid-air rule is removed: a kid's dug air 2 cells away forbids breaking.
	it('refuses a break 2 cells from kid-made air', () => {
		const w = new FakeWorld();
		w.setNatural(40, 200, 40, 'stone');
		w.setNatural(42, 200, 40, 'stone');
		w.set(42, 200, 40, 0); // a kid dug it: an edit, so a kid cell, and air
		expect(judgeSafety(brk(40, 200, 40), ctx({ world: w })).ok).toBe(false);
	});
	it('refuses anything inside a kid\'s body buffer', () => {
		expect(judgeSafety(place(30, 211, 30), ctx({ kids: [{ name: 'Noah', x: 30.5, y: 210, z: 30.5 }] })).ok).toBe(false);
	});
	// Red on the rev 3.2 wording (buffer only): a stop must keep every edit 16 blocks away from that kid. ("No Help-build
	// for him" at any distance is Help-build's own rule: help-build.test.ts, which goes red without it.)
	it('stop signal: no edit within STOP_RADIUS of that kid', () => {
		const stop = new StopSignal(600_000);
		stop.onEdit({ by: 7, byName: 'Noah', byBot: false, opCount: 1, cells: [{ x: 1, y: 1, z: 1, oldId: 1, newId: 0 }] }, [{ x: 1, y: 1, z: 1, oldId: 0, newId: 1, t: 0 }], 100_000);
		const kids = [{ name: 'Noah', x: 40, y: 210, z: 40 }];
		expect(judgeSafety(place(50, 210, 40), ctx({ kids, stop })).ok).toBe(false);
		expect(judgeSafety(place(57, 210, 40), ctx({ kids, stop })).ok).toBe(true);
		expect(judgeSafety({ ...place(50, 210, 40), free: true } as Action, ctx({ kids, stop, helpBuild: true, inventory: {} })).ok).toBe(false); // the radius binds Help-build too
	});
	it('a plan veto is marked so the tripwire can count it', () => {
		const v = judgeSafety(place(5, 210, 5), ctx({ planOwns: () => false }));
		expect(v).toMatchObject({ ok: false, planVeto: true });
	});
	// Criterion 4, property: random worlds, kid cells, kids and actions; no accepted edit ever lands on/near a kid cell,
	// touching liquid (breaks), or in a kid's body buffer. Red if the kid-cell buffer, the liquid rule or the body buffer is
	// removed (the 2-block kid-air rule and the stop radius have their own unit tests: the generator makes neither).
	it('property: accepted edits respect every kid-safety rule', { timeout: 30_000 }, () => {
		const rng = seededRng(7);
		for (let i = 0; i < 3000; i++) {
			const w = new FakeWorld();
			const ri = (n: number) => Math.floor(rng() * n);
			for (let k = 0; k < 6; k++) {
				const [kx, ky, kz] = [100 + ri(8), 210 + ri(3), 100 + ri(8)];
				const r = rng();
				if (r < 0.33) w.set(kx, ky, kz, 'dirt');            // a kid-placed block
				else if (r < 0.66) w.setNatural(kx, ky, kz, 'water'); // natural water (the liquid rule must catch it)
				else w.setNatural(kx, ky, kz, 'stone');                // natural stone to break
			}
			const kids = rng() < 0.5 ? [{ name: 'Noah', x: 100 + ri(8) + 0.5, y: 210, z: 100 + ri(8) + 0.5 }] : [];
			const a = rng() < 0.5 ? place(100 + ri(8), 210 + ri(3), 100 + ri(8)) : brk(100 + ri(8), 210 + ri(3), 100 + ri(8));
			const c = ctx({ world: w, kids });
			if (!judgeSafety(a, c).ok) continue;
			const { x, y, z } = (a as { cell: { x: number; y: number; z: number } }).cell;
			expect(c.own.classify(x, y, z)).not.toBe('kid');
			expect(c.own.kidNeighbour(x, y, z, 1)).toBe(false);
			if (a.kind === 'break') for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) expect(w.isLiquid(w.getBlock(x+dx, y+dy, z+dz))).toBe(false);
			for (const k of kids) expect(Math.abs(x - Math.floor(k.x)) > 1 || Math.abs(z - Math.floor(k.z)) > 1).toBe(true);
			if (a.kind === 'break') expect(c.own.kidNeighbour(x, y, z, 2, true)).toBe(false);
		}
	});
});

describe('Tripwire (spec §7.2)', () => {
	// Criterion 8 building block. Red on rev 1's 30/60 s limit: the fastest legal pace (600 ms) never trips.
	it('the fastest legal pace for 10 minutes never trips the rate', () => {
		const t = new Tripwire(600);
		t.resetPlan(10_000);
		for (let i = 0; i < 1000; i++) t.recordEdit({ x: i, y: 0, z: 0 }, i * 600);
		expect(t.halted).toBeNull();
	});
	it('twice the legal pace trips the rate', () => {
		const t = new Tripwire(600);
		t.resetPlan(10_000);
		for (let i = 0; i < 200; i++) t.recordEdit({ x: i, y: 0, z: 0 }, i * 300);
		expect(t.halted).toMatch(/rate/);
	});
	it('the same cell 3× within 10 min trips churn; 3× over 11 min does not', () => {
		const a = new Tripwire(600);
		a.resetPlan(100);
		for (const t of [0, 60_000, 120_000]) a.recordEdit({ x: 1, y: 1, z: 1 }, t);
		expect(a.halted).toMatch(/churn/);
		const b = new Tripwire(600);
		b.resetPlan(100);
		for (const t of [0, 330_000, 660_000]) b.recordEdit({ x: 1, y: 1, z: 1 }, t);
		expect(b.halted).toBeNull();
	});
	// Red if `planned` defaults to 0: a stray veto before the first resetPlan would halt the session (batch A review).
	it('a plan veto before the first resetPlan does not halt', () => {
		const t = new Tripwire(600);
		t.recordPlanVeto();
		expect(t.halted).toBeNull();
	});
	// Red if other rejections count (rev 3.1 defect), or if the count doesn't reset on recompute.
	it('overrun counts done + plan vetoes against plannedEdits × 1.1, and resets on recompute', () => {
		const t = new Tripwire(600);
		t.resetPlan(10);
		for (let i = 0; i < 10; i++) t.recordEdit({ x: i, y: 0, z: 0 }, i * 1000);
		t.recordPlanVeto();
		expect(t.halted).toBeNull();          // 11 ≤ 11
		t.resetPlan(4);                        // Help-build recompute
		for (let i = 0; i < 4; i++) t.recordEdit({ x: 50 + i, y: 0, z: 0 }, 20_000 + i * 1000);
		expect(t.halted).toBeNull();
		t.recordPlanVeto();
		expect(t.halted).toMatch(/overrun/);   // 5 > 4.4
	});
});
