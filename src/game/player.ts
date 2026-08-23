import * as THREE from 'three';
import type { World } from '../engine/world/world';
import { moveWithCollisions } from '../engine/physics/collision';
import type { BlockId } from '../data/blocks.data';
import { isLiquid } from '../data/blocks.data';

const WALK_SPEED = 5; // blocks/sec
const JUMP_SPEED = 8; // blocks/sec, initial upward velocity
const GRAVITY = 24; // blocks/sec^2
const SIZE: [number, number, number] = [0.6, 1.8, 0.6];
const EYE_HEIGHT = 1.6;
const MAX_STEP = 0.4; // max displacement per physics sub-step (blocks)
const FLY_TIER_MIN = 1;
const FLY_TIER_MAX = 5;
const FLY_TIER_DEFAULT = 2;

/**
 * The world is 64 blocks tall (y 0..63). These bounds let Noah drop into the void
 * and fly well above the terrain — both of which he likes — without ever losing
 * sight of the world. Before they existed, walking off the edge of the map meant
 * an unbounded fall, and autosave persisted it: one world was recovered at
 * y = -193917, which loads as an empty blue screen.
 */
export const VOID_FLOOR_Y = -24;
export const SKY_CEILING_Y = 120;

const WORLD_MIN_XZ = 0.5;
const WORLD_MAX_XZ = 511.5;

function clamp(v: number, lo: number, hi: number): number {
	if (!Number.isFinite(v)) return (lo + hi) / 2;
	return Math.min(hi, Math.max(lo, v));
}

/** Brings a saved spawn back into the world, repairing already-broken saves. */
export function sanitizeSpawn(pos: [number, number, number]): [number, number, number] {
	return [
		clamp(pos[0], WORLD_MIN_XZ, WORLD_MAX_XZ),
		clamp(pos[1], VOID_FLOOR_Y, SKY_CEILING_Y),
		clamp(pos[2], WORLD_MIN_XZ, WORLD_MAX_XZ),
	];
}

export type Keys = {
	forward: boolean;
	back: boolean;
	left: boolean;
	right: boolean;
	jump: boolean;
};

export class Player {
	position: [number, number, number];
	vy = 0;
	grounded = false;
	hotbar: BlockId[] = [];
	selected = 0;
	flying = false;
	flySpeedTier = FLY_TIER_DEFAULT;
	swimming = false;

	constructor(spawn: [number, number, number]) {
		this.position = sanitizeSpawn(spawn);
	}

	eyePosition(): [number, number, number] {
		return [this.position[0], this.position[1] + EYE_HEIGHT, this.position[2]];
	}

	toggleFly() {
		this.flying = !this.flying;
		this.vy = 0;
	}

	adjustFlySpeed(delta: number) {
		if (!this.flying) return;
		this.flySpeedTier = Math.max(
			FLY_TIER_MIN,
			Math.min(FLY_TIER_MAX, this.flySpeedTier + delta),
		);
	}

	update(dt: number, world: World, keys: Keys, forward: THREE.Vector3, right: THREE.Vector3) {
		// Swim state (from Task 18) — keep this at the top so downstream logic sees it.
		const eye = this.eyePosition();
		const eyeBlock = world.getBlock(Math.floor(eye[0]), Math.floor(eye[1]), Math.floor(eye[2]));
		this.swimming = isLiquid(eyeBlock);

		const feetBlock = world.getBlock(
			Math.floor(this.position[0]),
			Math.floor(this.position[1]),
			Math.floor(this.position[2]),
		);
		const feetInLiquid = isLiquid(feetBlock);

		let ix = 0,
			iy = 0,
			iz = 0;
		if (this.flying || this.swimming) {
			// Full 3D along cursor forward; strafe horizontal only (right.y is ~0 by construction).
			if (keys.forward) {
				ix += forward.x;
				iy += forward.y;
				iz += forward.z;
			}
			if (keys.back) {
				ix -= forward.x;
				iy -= forward.y;
				iz -= forward.z;
			}
			if (keys.left) {
				ix -= right.x;
				iz -= right.z;
			}
			if (keys.right) {
				ix += right.x;
				iz += right.z;
			}
		} else {
			// On-ground walking — unchanged horizontal projection of the look direction.
			if (keys.forward) {
				ix += forward.x;
				iz += forward.z;
			}
			if (keys.back) {
				ix -= forward.x;
				iz -= forward.z;
			}
			if (keys.left) {
				ix -= right.x;
				iz -= right.z;
			}
			if (keys.right) {
				ix += right.x;
				iz += right.z;
			}
		}

		const mag = Math.hypot(ix, iy, iz);
		if (mag > 0) {
			ix /= mag;
			iy /= mag;
			iz /= mag;
		}

		let speed: number;
		if (this.flying) speed = WALK_SPEED * this.flySpeedTier;
		else if (this.swimming) speed = WALK_SPEED * 0.6;
		else speed = WALK_SPEED;

		const vx = ix * speed * dt;
		const vz = iz * speed * dt;

		let vyStep: number;
		if (this.flying || this.swimming) {
			this.vy = iy * speed; // cursor-driven vertical; no gravity
			vyStep = this.vy * dt;
		} else {
			this.vy -= GRAVITY * dt;
			if (keys.jump && (this.grounded || feetInLiquid)) this.vy = JUMP_SPEED;
			vyStep = this.vy * dt;
		}

		const disp = Math.max(Math.abs(vx), Math.abs(vyStep), Math.abs(vz));
		const steps = Math.max(1, Math.ceil(disp / MAX_STEP));
		const sx = vx / steps,
			sy = vyStep / steps,
			sz = vz / steps;
		let grounded = false;
		for (let i = 0; i < steps; i++) {
			const r = moveWithCollisions(world, this.position, SIZE, [sx, sy, sz]);
			this.position = r.position;
			grounded = grounded || r.grounded;
			if (r.vy === 0) this.vy = 0;
			if (r.vx === 0 && r.vz === 0 && r.vy === 0) break;
		}

		// Keep the player inside the world. Leaving it horizontally means there is no
		// ground to land on, which is how an endless fall starts.
		const [cx, cy, cz] = sanitizeSpawn(this.position);
		if (cy !== this.position[1]) {
			// Landing on the void floor or bumping the ceiling cancels vertical speed,
			// so the player rests there rather than accumulating velocity.
			this.vy = 0;
			if (cy === VOID_FLOOR_Y) grounded = true;
		}
		this.position = [cx, cy, cz];

		this.grounded = grounded;
	}
}
