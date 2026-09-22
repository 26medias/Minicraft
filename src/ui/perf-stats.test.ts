import { describe, it, expect } from 'vitest';
import { RollingStats } from './perf-stats';

describe('RollingStats (spec §6.6)', () => {
	it('fps/avg/worst over the last 1 s and >50 ms count over the last 10 s, with exact window edges (mutant: off-by-one window)', () => {
		const r = new RollingStats();
		// 60 frames at 16.7 ms ending at t=1000, one 60 ms frame at t=500 and one at t=-9500 (outside 10 s), tick 8 ms each
		for (let k = 0; k < 60; k++) r.push({ t: 1000 - k * 16.7, frameMs: 16.7, tickMs: 8 });
		r.push({ t: 500, frameMs: 60, tickMs: 50 });
		r.push({ t: -9500, frameMs: 60, tickMs: 50 }); // exactly 10.5 s before now=1000 → excluded
		r.push({ t: -8999, frameMs: 70, tickMs: 50 }); // 9.999 s before → included
		const s = r.summary(1000);
		expect(s.over50In10s).toBe(2);
		expect(s.worstMs).toBe(60);
		expect(s.fps).toBeGreaterThan(55);
		expect(s.tickShare).toBeGreaterThan(0.4);
		// a frame exactly 1000 ms old is outside the 1 s window
		const r2 = new RollingStats();
		r2.push({ t: 0, frameMs: 90, tickMs: 1 });
		r2.push({ t: 500, frameMs: 10, tickMs: 1 });
		expect(r2.summary(1000).worstMs).toBe(10);
	});
});
