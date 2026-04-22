import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Player, type Keys } from './player';
import { World } from '../engine/world/world';
import { BLOCK_BY_NAME } from '../data/blocks.data';

const stone = BLOCK_BY_NAME['stone'].id;
const FWD = new THREE.Vector3(0, 0, -1);
const RIGHT = new THREE.Vector3(1, 0, 0);

function noKeys(): Keys {
	return {
		forward: false,
		back: false,
		left: false,
		right: false,
		jump: false,
	};
}

describe('Player fly mode', () => {
	it('walking player accumulates downward vy from gravity', () => {
		const w = new World(1);
		const p = new Player([100, 60, 100]);
		const startVy = p.vy;
		p.update(0.1, w, noKeys(), FWD, RIGHT);
		expect(p.vy).toBeLessThan(startVy);
	});

	it('flying player does not accumulate gravity', () => {
		const w = new World(1);
		const p = new Player([100, 60, 100]);
		p.toggleFly();
		p.update(0.1, w, noKeys(), FWD, RIGHT);
		expect(p.vy).toBe(0);
	});

	it('toggleFly zeroes vy on both transitions', () => {
		const p = new Player([100, 60, 100]);
		p.vy = -12;
		p.toggleFly();
		expect(p.vy).toBe(0);
		p.vy = 7;
		p.toggleFly();
		expect(p.vy).toBe(0);
	});

	it('flying horizontal speed equals WALK_SPEED * flySpeedTier', () => {
		const w = new World(1);
		// Ground: walking speed over 1 second. Place a floor so gravity doesn't move us.
		for (let dx = -5; dx <= 5; dx++)
			for (let dz = -5; dz <= 5; dz++) w.setBlock(100 + dx, 59, 100 + dz, stone);
		const pw = new Player([100, 60, 100]);
		pw.update(1.0, w, { ...noKeys(), forward: true }, FWD, RIGHT);
		const walkDz = pw.position[2] - 100;

		const pf = new Player([100, 60, 100]);
		pf.toggleFly();
		pf.update(1.0, w, { ...noKeys(), forward: true }, FWD, RIGHT);
		const flyDzTier2 = pf.position[2] - 100;
		expect(flyDzTier2).toBeCloseTo(walkDz * 2, 3);

		pf.adjustFlySpeed(+3); // tier 2 → 5
		const before = pf.position[2];
		pf.update(1.0, w, { ...noKeys(), forward: true }, FWD, RIGHT);
		const flyDzTier5 = pf.position[2] - before;
		expect(flyDzTier5).toBeCloseTo(walkDz * 5, 3);
	});

	it('adjustFlySpeed clamps to [1, 5] while flying, no-op when not flying', () => {
		const p = new Player([100, 60, 100]);
		p.adjustFlySpeed(+1);
		expect(p.flySpeedTier).toBe(2); // no-op when not flying

		p.toggleFly();
		expect(p.flySpeedTier).toBe(2);
		p.adjustFlySpeed(+5);
		expect(p.flySpeedTier).toBe(5);
		p.adjustFlySpeed(+1);
		expect(p.flySpeedTier).toBe(5);
		p.adjustFlySpeed(-10);
		expect(p.flySpeedTier).toBe(1);
		p.adjustFlySpeed(-1);
		expect(p.flySpeedTier).toBe(1);
	});

	it('flying player still collides with walls (no clipping)', () => {
		const w = new World(1);
		// Wall at x=102 across a vertical strip.
		for (let dy = 59; dy <= 63; dy++) w.setBlock(102, dy, 100, stone);
		const p = new Player([100, 60, 99.7]);
		p.toggleFly();
		// Push +X hard for 1 second; should stop before x=102.
		p.update(1.0, w, { ...noKeys(), right: true }, FWD, RIGHT);
		expect(p.position[0]).toBeLessThan(102);
	});
});

describe('Player swim mode', () => {
	const water = BLOCK_BY_NAME['water'].id;

	it('swimming is false by default', () => {
		const p = new Player([100, 60, 100]);
		expect(p.swimming).toBe(false);
	});

	it('swimming activates when eye voxel is water', () => {
		const w = new World(1);
		const p = new Player([100, 60, 100]);
		w.setBlock(100, 61, 100, water);
		p.update(0.01, w, noKeys(), FWD, RIGHT);
		expect(p.swimming).toBe(true);
	});

	it('swimming deactivates when eye leaves water', () => {
		const w = new World(1);
		const p = new Player([100, 60, 100]);
		w.setBlock(100, 61, 100, water);
		p.update(0.01, w, noKeys(), FWD, RIGHT);
		expect(p.swimming).toBe(true);
		w.setBlock(100, 61, 100, 0);
		p.update(0.01, w, noKeys(), FWD, RIGHT);
		expect(p.swimming).toBe(false);
	});

	it('swimming disables gravity accumulation', () => {
		const w = new World(1);
		const p = new Player([100, 60, 100]);
		w.setBlock(100, 61, 100, water);
		p.vy = 0;
		p.update(0.1, w, noKeys(), FWD, RIGHT);
		expect(p.vy).toBe(0);
	});
});

describe('Player cursor-directed movement', () => {
	const water = BLOCK_BY_NAME['water'].id;

	it('in fly mode, W uses full 3D camera forward (pitch down → descend)', () => {
		const w = new World(1);
		const p = new Player([100, 60, 100]);
		p.toggleFly();
		const fwd3D = new THREE.Vector3(0, -0.707, -0.707); // 45° down
		p.update(0.1, w, { ...noKeys(), forward: true }, fwd3D, RIGHT);
		expect(p.position[1]).toBeLessThan(60);
		expect(p.position[2]).toBeLessThan(100);
	});

	it('in fly mode, strafe is horizontal (no Y change)', () => {
		const w = new World(1);
		const p = new Player([100, 60, 100]);
		p.toggleFly();
		const fwd3D = new THREE.Vector3(0, -0.707, -0.707);
		const right = new THREE.Vector3(1, 0, 0);
		p.update(0.1, w, { ...noKeys(), right: true }, fwd3D, right);
		expect(p.position[1]).toBeCloseTo(60, 2);
	});

	it('swim speed is 60% of walk speed', () => {
		const w = new World(1);
		for (let y = 58; y <= 63; y++) w.setBlock(100, y, 100, water);
		const p = new Player([100, 60, 100]);
		p.update(0.01, w, noKeys(), FWD, RIGHT);
		expect(p.swimming).toBe(true);
		const before = p.position[2];
		p.update(1.0, w, { ...noKeys(), forward: true }, FWD, RIGHT);
		const dz = Math.abs(p.position[2] - before);
		// WALK_SPEED = 5, swim = 3.0 over 1 second. Tolerance allows small physics variance.
		expect(dz).toBeGreaterThan(2.5);
		expect(dz).toBeLessThan(3.5);
	});

	it('Space jumps out of shallow water (feet in liquid, eye in air)', () => {
		const w = new World(1);
		const water = BLOCK_BY_NAME['water'].id;
		// Solid floor at y=29; water at y=30; player feet at y=30 (in water), eye at y=31.6 (above water).
		w.setBlock(100, 29, 100, BLOCK_BY_NAME['stone'].id);
		w.setBlock(100, 30, 100, water);
		const p = new Player([100, 30, 100]);
		p.update(0.01, w, noKeys(), FWD, RIGHT);
		expect(p.swimming).toBe(false);
		// Before jump
		expect(p.vy).toBeLessThanOrEqual(0);
		// Press Space — vy should become positive.
		p.update(0.01, w, { ...noKeys(), jump: true }, FWD, RIGHT);
		expect(p.vy).toBeGreaterThan(0);
	});
});
