import { describe, it, expect } from 'vitest';
import { PoseBuffer, INTERP_DELAY_MS, SNAP_DISTANCE, type Pose } from './pose-buffer';

const at = (x: number, y = 0, z = 0, yaw = 0, pitch = 0): Pose => ({ x, y, z, yaw, pitch });

describe('PoseBuffer (T10)', () => {
	it('uses the spec constants: 200 ms in the past, snap over 8 blocks', () => {
		expect(INTERP_DELAY_MS).toBe(200);
		expect(SNAP_DISTANCE).toBe(8);
	});

	it('returns null before any sample', () => {
		const b = new PoseBuffer();
		expect(b.sample(0)).toBeNull();
		expect(b.sample(10_000)).toBeNull();
	});

	it('renders 200 ms in the past with linear interpolation (catches a build that renders the latest sample)', () => {
		const b = new PoseBuffer();
		b.push(0, at(0));
		b.push(100, at(1));
		// Render time 250 − 200 = 50: halfway between the samples.
		expect(b.sample(250)!.x).toBeCloseTo(0.5, 9);
		expect(b.sample(225)!.x).toBeCloseTo(0.25, 9);
	});

	it('interpolates every axis, and yaw the short way round', () => {
		const b = new PoseBuffer();
		b.push(0, { x: 0, y: 10, z: -4, yaw: Math.PI - 0.1, pitch: 0 });
		b.push(100, { x: 2, y: 12, z: -2, yaw: -Math.PI + 0.1, pitch: 0.4 });
		const p = b.sample(250)!;
		expect(p.y).toBeCloseTo(11, 9);
		expect(p.z).toBeCloseTo(-3, 9);
		expect(p.pitch).toBeCloseTo(0.2, 9);
		// Short way: through ±π, not through 0.
		expect(Math.abs(Math.cos(p.yaw) - Math.cos(Math.PI))).toBeLessThan(1e-9);
	});

	it('clamps: before the first sample it holds the first, after the last it holds the last', () => {
		const b = new PoseBuffer();
		b.push(1000, at(5));
		b.push(1100, at(6));
		expect(b.sample(1000)!.x).toBe(5); // render time 800 < first sample
		expect(b.sample(5000)!.x).toBe(6);
	});

	it('snaps instead of interpolating when consecutive samples are more than 8 blocks apart', () => {
		const b = new PoseBuffer();
		b.push(0, at(0));
		b.push(100, at(20));
		const mid = b.sample(250)!.x;
		expect(mid === 0 || mid === 20).toBe(true);
		expect(mid).toBe(0); // holds the old pose until the jump's own time
		expect(b.sample(300)!.x).toBe(20);
		// A move of exactly 8 blocks still interpolates.
		const c = new PoseBuffer();
		c.push(0, at(0));
		c.push(100, at(8));
		expect(c.sample(250)!.x).toBeCloseTo(4, 9);
	});

	it('keeps interpolating correctly as samples stream in and old ones are dropped', () => {
		const b = new PoseBuffer();
		for (let i = 0; i <= 100; i++) {
			b.push(i * 100, at(i));
			if (i >= 3) expect(b.sample(i * 100 + 50)!.x).toBeCloseTo(i - 1.5, 9);
		}
		expect(b.size()).toBeLessThan(10);
	});
});
