import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
	Player,
	type Keys,
	VOID_FLOOR_Y,
	SKY_CEILING_Y,
	sanitizeSpawn,
} from './player';
import { World } from '../engine/world/world';
import { AIR, BLOCK_BY_NAME } from '../data/blocks.data';

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

describe('Player jump on ground', () => {
	it('Space on solid ground produces positive vy', () => {
		const w = new World(1);
		// Place a floor so the player is grounded.
		for (let dx = -2; dx <= 2; dx++)
			for (let dz = -2; dz <= 2; dz++) w.setBlock(100 + dx, 59, 100 + dz, stone);
		const p = new Player([100, 60, 100]);
		// Settle onto the floor with one small tick (no jump).
		p.update(0.01, w, noKeys(), FWD, RIGHT);
		expect(p.grounded).toBe(true);
		// Now press Space — vy must become positive.
		p.update(0.01, w, { ...noKeys(), jump: true }, FWD, RIGHT);
		expect(p.vy).toBeGreaterThan(0);
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

describe('Player world bounds', () => {
	function openWorld(): World {
		const w = new World(1);
		const c = w.ensureChunk(16, 16);
		c.blocks.fill(AIR);
		return w;
	}
	const noKeys: Keys = { forward: false, back: false, left: false, right: false, jump: false };
	const fwd = new THREE.Vector3(0, 0, -1);
	const right = new THREE.Vector3(1, 0, 0);

	it('stops falling at the void floor instead of dropping forever', () => {
		const p = new Player([260, 40, 260]);
		const w = openWorld();
		// No ground anywhere: without a floor this falls without limit.
		for (let i = 0; i < 2000; i++) p.update(1 / 60, w, noKeys, fwd, right);
		expect(p.position[1]).toBeGreaterThanOrEqual(VOID_FLOOR_Y);
		expect(Number.isFinite(p.position[1])).toBe(true);
	});

	it('can still see the world from the void floor', () => {
		// The floor must be close enough that the terrain above stays in view.
		expect(VOID_FLOOR_Y).toBeGreaterThan(-64);
		expect(VOID_FLOOR_Y).toBeLessThan(0);
	});

	it('does not let the player fly above the sky ceiling', () => {
		const p = new Player([260, 40, 260]);
		p.flying = true;
		const w = openWorld();
		for (let i = 0; i < 4000; i++) {
			p.vy = 20;
			p.update(1 / 60, w, { ...noKeys, jump: true }, fwd, right);
		}
		expect(p.position[1]).toBeLessThanOrEqual(SKY_CEILING_Y);
	});

	it('keeps the player inside the horizontal world bounds', () => {
		const p = new Player([600, 40, -30]);
		p.update(1 / 60, openWorld(), noKeys, fwd, right);
		expect(Number.isFinite(p.position[0])).toBe(true);
		expect(p.position[0]).toBeGreaterThanOrEqual(0);
		expect(p.position[0]).toBeLessThanOrEqual(512);
		expect(p.position[2]).toBeGreaterThanOrEqual(0);
		expect(p.position[2]).toBeLessThanOrEqual(512);
	});

	it('repairs a saved position that is already out of bounds', () => {
		// Noah's world was saved at y = -193917 after falling out of the map.
		const p = new Player(sanitizeSpawn([282.3, -193917.6, 512.87]));
		expect(p.position[1]).toBeGreaterThanOrEqual(VOID_FLOOR_Y);
		expect(p.position[1]).toBeLessThanOrEqual(SKY_CEILING_Y);
		expect(p.position[2]).toBeLessThan(512);
		expect(p.position[2]).toBeGreaterThanOrEqual(0);
	});
});
