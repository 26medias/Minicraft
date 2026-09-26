import { describe, it, expect } from 'vitest';
import { waterLevels, windLevels, type Sampler, type WaterCell } from './ambience';

/** A tiny voxel world: 'w' source, 'f' flow, '#' solid, absent = air. */
function world(cells: Map<string, 'w' | 'f' | '#'>): Sampler {
	const at = (x: number, y: number, z: number) => cells.get(`${x},${y},${z}`);
	return {
		water: (x, y, z): WaterCell => (at(x, y, z) === 'w' ? 'source' : at(x, y, z) === 'f' ? 'flow' : 'none'),
		open: (x, y, z) => at(x, y, z) === undefined,
		air: (x, y, z) => at(x, y, z) === undefined,
	};
}

function lake(x0: number, x1: number, z0: number, z1: number, top: number, depth: number) {
	const m = new Map<string, 'w' | 'f' | '#'>();
	for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = top - depth + 1; y <= top; y++) m.set(`${x},${y},${z}`, 'w');
	return m;
}

describe('waterLevels', () => {
	it('fades smoothly walking away from a big lake, instead of full-then-nothing', () => {
		const s = world(lake(0, 40, 0, 40, 10, 4));
		const at = (d: number) => waterLevels(s, -d, 12, 20).lake;
		const levels = [1, 3, 5, 7, 9, 11, 13].map(at);
		expect(levels[0]).toBeGreaterThan(0.9);
		for (let i = 1; i < levels.length; i++) expect(levels[i]).toBeLessThan(levels[i - 1]);
		expect(at(4)).toBeLessThan(1); // the old rule was already capped at 1 here
		expect(at(15)).toBe(0);
	});

	it('counts only the surface: deep water under a floor makes no lake sound', () => {
		const m = lake(0, 5, 0, 5, 10, 3);
		for (let x = 0; x <= 5; x++) for (let z = 0; z <= 5; z++) m.set(`${x},11,${z}`, '#');
		expect(waterLevels(world(m), 2, 13, 2).lake).toBe(0);
	});

	it('a falling column beside air is a waterfall; a flowing pond between walls is a stream', () => {
		const fall = new Map<string, 'w' | 'f' | '#'>();
		for (let y = 0; y < 8; y++) fall.set(`0,${y},0`, 'f');
		const f = waterLevels(world(fall), 3, 4, 0);
		expect(f.waterfall).toBeGreaterThan(0.3);

		const pond = new Map<string, 'w' | 'f' | '#'>();
		for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
			for (let y = 0; y <= 2; y++) {
				const wall = Math.abs(x) === 3 || Math.abs(z) === 3;
				pond.set(`${x},${y},${z}`, wall ? '#' : 'f');
			}
		}
		const p = waterLevels(world(pond), 0, 4, 0);
		expect(p.waterfall).toBe(0);
		expect(p.stream).toBeGreaterThan(0.3);
	});

	it('nothing past 13 blocks', () => {
		const m = new Map<string, 'w' | 'f' | '#'>([['13,0,0', 'w']]);
		expect(waterLevels(world(m), 0.5, 0.5, 0.5).lake).toBe(0);
	});
});

describe('windLevels (256-high world, sea 120)', () => {
	const w = (y: number, sky = true) => windLevels(y, 120, 256, sky);
	it('beach silent, a hill a breeze, a summit windy, a cave silent', () => {
		expect(w(122)).toEqual({ light: 0, strong: 0 });
		const hill = w(165);
		expect(hill.light).toBeGreaterThan(0.5);
		expect(hill.strong).toBeLessThan(0.1); // strong starts at 41 above sea
		const summit = w(230);
		expect(summit.strong).toBe(1);
		expect(summit.light).toBeLessThan(0.5);
		expect(w(230, false)).toEqual({ light: 0, strong: 0 });
	});
});
