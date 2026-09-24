// Multiplayer plan task C7 (spec §7.2): the client resolves welcome.spawn into a position.
import { describe, it, expect } from 'vitest';
import { World } from '../engine/world/world';
import { spawnV3 } from '../engine/world/v3/spawn';
import { AIR, WATER, isLiquid, isSolid } from '../data/blocks.data';
import { findSafeSpawn } from './player';
import { resolveMpSpawn } from './mp-spawn';
import type { Spawn } from '../net/protocol';

const SEED = 3;
const STONE_ID = 3;
const v3 = spawnV3(SEED);

function standable(w: World, pos: [number, number, number]): boolean {
	const x = Math.floor(pos[0]), y = Math.floor(pos[1]), z = Math.floor(pos[2]);
	const g = w.getBlock(x, y - 1, z);
	return isSolid(g) && !isLiquid(g) && w.getBlock(x, y, z) === AIR && w.getBlock(x, y + 1, z) === AIR;
}

describe('resolveMpSpawn', () => {
	it('first equals findSafeSpawn(spawnV3)', () => {
		const w = World.create(SEED);
		const r = resolveMpSpawn(w, SEED, { mode: 'first', x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
		const w2 = World.create(SEED);
		expect(r.pos).toEqual(findSafeSpawn(w2, [v3.x + 0.5, w2.height - 1, v3.z + 0.5]));
	});

	it('return uses findSafeSpawn(stored) with the stored yaw and pitch', () => {
		const w = World.create(SEED);
		const stored: [number, number, number] = [v3.x + 10.5, w.height - 1, v3.z - 7.5];
		const r = resolveMpSpawn(w, SEED, { mode: 'return', x: stored[0], y: stored[1], z: stored[2], yaw: 1.25, pitch: -0.5 });
		expect(r.pos).toEqual(findSafeSpawn(World.create(SEED), stored));
		expect(r.yaw).toBe(1.25);
		expect(r.pitch).toBe(-0.5);
	});

	for (const yaw of [0, 1, Math.PI / 2, -2.5]) {
		it(`near on flat v3 terrain (seed 3, target yaw ${yaw.toFixed(2)}) is 3–6 blocks away, standable, |dy| ≤ 4, facing the target`, () => {
			const w = World.create(SEED);
			const t = findSafeSpawn(w, [v3.x + 0.5, w.height - 1, v3.z + 0.5]);
			const spawn: Spawn = { mode: 'near', x: t[0], y: t[1], z: t[2], yaw, pitch: 0, target: 7 };
			const r = resolveMpSpawn(w, SEED, spawn);
			const dx = t[0] - r.pos[0], dz = t[2] - r.pos[2];
			const dist = Math.hypot(dx, dz);
			expect(dist).toBeGreaterThanOrEqual(3);
			expect(dist).toBeLessThanOrEqual(6);
			// The ground block (feet − 1) is within ±4 of the target's feet y (gate-2 C7 scan range).
			expect(Math.abs(Math.floor(r.pos[1]) - 1 - Math.floor(t[1]))).toBeLessThanOrEqual(4);
			expect(Math.abs(r.pos[1] - t[1])).toBeLessThanOrEqual(4);
			expect(standable(w, r.pos)).toBe(true);
			// Facing the target: the camera forward vector is (-sin yaw, -cos yaw).
			const fx = -Math.sin(r.yaw), fz = -Math.cos(r.yaw);
			expect((fx * dx + fz * dz) / dist).toBeCloseTo(1, 6);
			expect(r.pitch).toBe(0);
		});
	}

	it('near prefers the column straight ahead of the target', () => {
		const w = World.create(SEED);
		const t = findSafeSpawn(w, [v3.x + 0.5, w.height - 1, v3.z + 0.5]);
		// yaw 0 faces -z.
		const r = resolveMpSpawn(w, SEED, { mode: 'near', x: t[0], y: t[1], z: t[2], yaw: 0, pitch: 0, target: 1 });
		expect(r.pos[0]).toBe(Math.floor(t[0]) + 0.5);
		expect(r.pos[2]).toBeLessThan(t[2]);
	});

	it('near with the target in a 1×2 cave pocket and no standable column returns the target position', () => {
		const w = World.create(SEED);
		const tx = v3.x, tz = v3.z, ty = 20;
		for (let x = tx - 8; x <= tx + 8; x++)
			for (let z = tz - 8; z <= tz + 8; z++)
				for (let y = ty - 7; y <= ty + 8; y++) w.setBlock(x, y, z, STONE_ID);
		w.setBlock(tx, ty, tz, AIR);
		w.setBlock(tx, ty + 1, tz, AIR);
		const t: [number, number, number] = [tx + 0.5, ty, tz + 0.5];
		const r = resolveMpSpawn(w, SEED, { mode: 'near', x: t[0], y: t[1], z: t[2], yaw: 0.3, pitch: 0.2, target: 2 });
		expect(r.pos).toEqual(t);
	});

	it('near never picks a column with liquid on it', () => {
		const w = World.create(SEED);
		const t = findSafeSpawn(w, [v3.x + 0.5, w.height - 1, v3.z + 0.5]);
		const tx = Math.floor(t[0]), ty = Math.floor(t[1]), tz = Math.floor(t[2]);
		// Flood every candidate ring (3..7 blocks out) at feet level with water, over stone ground.
		for (let x = tx - 8; x <= tx + 8; x++)
			for (let z = tz - 8; z <= tz + 8; z++) {
				const d = Math.hypot(x - tx, z - tz);
				if (d < 2) continue;
				for (let y = ty - 5; y <= ty + 6; y++) w.setBlock(x, y, z, y < ty ? STONE_ID : WATER);
			}
		const r = resolveMpSpawn(w, SEED, { mode: 'near', x: t[0], y: t[1], z: t[2], yaw: 0, pitch: 0, target: 3 });
		expect(r.pos).toEqual(t);
	});
});
