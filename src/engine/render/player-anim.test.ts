import { describe, it, expect } from 'vitest';
import { newAnimState, step, joints, triggerSwing, SWING_MS, type AnimState, type AnimInput } from './player-anim';

const FRAME = 1000 / 60;

/** Moves along −z at `speed` blocks/s for `ms`, stepping every frame; returns the last input. */
function run(s: AnimState, from: AnimInput, speed: number, ms: number, extra: Partial<AnimInput> = {}): AnimInput {
	let inp = { ...from, ...extra };
	for (let t = 0; t < ms; t += FRAME) {
		inp = { ...inp, now: inp.now + FRAME, z: inp.z - speed * FRAME / 1000 };
		step(s, inp);
	}
	return inp;
}

const start: AnimInput = { now: 1000, x: 0, z: 0, pitch: 0, mining: false };
const finite = (o: object) => Object.values(o).every((v) => Number.isFinite(v));

describe('walk', () => {
	it('legs swing in opposite phase, arms opposite their same-side leg, and the stride advances', () => {
		const s = newAnimState();
		step(s, start);
		let inp = run(s, start, 4.3, 2000);
		const a = joints(s, inp);
		expect(Math.sign(a.rLegX)).toBe(-Math.sign(a.lLegX));
		expect(Math.sign(a.rArmX)).toBe(-Math.sign(a.rLegX));
		// half a stride later the right leg is on the other side: phase advances 20·amount per s,
		// a half cycle is π/0.6662 phase units.
		const halfStrideMs = (Math.PI / 0.6662) / (20 * s.walkAmount) * 1000;
		const before = joints(s, inp).rLegX;
		inp = run(s, inp, 4.3, halfStrideMs);
		const after = joints(s, inp).rLegX;
		expect(Math.abs(before)).toBeGreaterThan(0.05);
		expect(Math.sign(after)).toBe(-Math.sign(before));
	});

	it('stopping settles the walk to ~0 within a second', () => {
		const s = newAnimState();
		step(s, start);
		const inp = run(s, start, 4.3, 1000);
		run(s, inp, 0, 1000);
		expect(s.walkAmount).toBeLessThan(0.01);
	});

	it('pure vertical motion does not walk', () => {
		const s = newAnimState();
		step(s, start);
		let inp = start;
		for (let t = 0; t < 1000; t += FRAME) { inp = { ...inp, now: inp.now + FRAME }; step(s, inp); }
		// y is not an input at all: falling cannot drive the walk
		expect(s.walkAmount).toBeLessThan(0.01);
	});

	it('first frame and a repeated timestamp give finite joints', () => {
		const s = newAnimState();
		step(s, start);
		expect(finite(joints(s, start))).toBe(true);
		step(s, start); // same now AND same position: 0/0 without the dt guard
		expect(finite(joints(s, start))).toBe(true);
		expect(Number.isFinite(s.walkAmount)).toBe(true);
		step(s, { ...start, z: -0.1 }); // same now, moved
		expect(finite(joints(s, start))).toBe(true);
	});

	it('idle sway is offset per avatar', () => {
		const a = newAnimState(0), b = newAnimState(3);
		expect(joints(a, start).rArmZ).not.toBeCloseTo(joints(b, start).rArmZ, 6);
	});

	it('a teleport (over 1 block in one step) does not touch the walk', () => {
		const s = newAnimState();
		step(s, start);
		step(s, { ...start, now: start.now + FRAME, z: -20 });
		expect(s.walkAmount).toBe(0);
		expect(s.walkPhase).toBe(0);
	});
});

describe('swing', () => {
	it('mining restarts the swing every 200 ms; stopping lets the last swing finish', () => {
		const s = newAnimState();
		step(s, start);
		const starts = new Set<number>();
		let inp: AnimInput = { ...start, mining: true };
		for (let t = 0; t < 1000; t += FRAME) {
			inp = { ...inp, now: inp.now + FRAME };
			step(s, inp);
			if (s.swingAt !== null) starts.add(s.swingAt);
		}
		expect(starts.size).toBeGreaterThanOrEqual(4);
		const last = s.swingAt!;
		inp = { ...inp, mining: false, now: inp.now + FRAME };
		step(s, inp);
		expect(s.swingAt).toBe(last); // still running
		const idle = joints(newAnimState(), inp);
		expect(joints(s, inp).rArmX).not.toBeCloseTo(idle.rArmX, 3);
		inp = { ...inp, now: last + SWING_MS + 1 };
		step(s, inp);
		expect(s.swingAt).toBeNull();
		expect(joints(s, inp).rArmX).toBeCloseTo(joints(newAnimState(), inp).rArmX, 9);
	});

	it('a swing moves the right arm forward (vanilla xRot negative) at p = 0.16', () => {
		const s = newAnimState();
		step(s, start);
		triggerSwing(s, start.now);
		const inp = { ...start, now: start.now + 0.16 * SWING_MS };
		const base = joints(newAnimState(), inp).rArmX;
		expect(joints(s, inp).rArmX).toBeLessThan(base - 0.3);
	});
});

describe('head', () => {
	it('headX is vanilla pitch: minus the pose pitch', () => {
		const s = newAnimState();
		expect(joints(s, { ...start, pitch: 0.4 }).headX).toBeCloseTo(-0.4, 12);
	});
});
