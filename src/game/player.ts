import * as THREE from 'three';
import type { World } from '../engine/world/world';
import { moveWithCollisions } from '../engine/physics/collision';
import type { BlockId } from '../data/blocks.data';
import { isLiquid } from '../data/blocks.data';
import type { Inventory, PlayerTools } from '../data/crafting.data';
import { GRAVITY, JUMP_SPEED, MIN_BOUNCE_VY, padResponse, padUnderFeet } from './pads';

const WALK_SPEED = 5; // blocks/sec
const SIZE: [number, number, number] = [0.6, 1.8, 0.6];
const EYE_HEIGHT = 1.6;
const MAX_STEP = 0.4; // max displacement per physics sub-step (blocks)
const FLY_TIER_MIN = 1;
const FLY_TIER_MAX = 5;
const FLY_TIER_DEFAULT = 2;

/**
 * Vertical bounds scale with the world: the void floor is fixed (Noah likes to
 * drop into it), the ceiling sits 56 blocks above the top of the column so a
 * 64-high world keeps today's 120. Before these existed one world was saved at
 * y = -193917 and loaded as an empty blue screen.
 */
export const VOID_FLOOR_Y = -24;
export function skyCeilingY(height: number): number {
	return height + 56;
}

const WORLD_MIN_XZ = 0.5;
const WORLD_MAX_XZ = 511.5;

function clamp(v: number, lo: number, hi: number): number {
	if (!Number.isFinite(v)) return (lo + hi) / 2;
	return Math.min(hi, Math.max(lo, v));
}

/** Brings a saved spawn back into the world, repairing already-broken saves. */
export function sanitizeSpawn(pos: [number, number, number], height = 64): [number, number, number] {
	return [
		clamp(pos[0], WORLD_MIN_XZ, WORLD_MAX_XZ),
		clamp(pos[1], VOID_FLOOR_Y, skyCeilingY(height)),
		clamp(pos[2], WORLD_MIN_XZ, WORLD_MAX_XZ),
	];
}

export type Keys = {
	forward: boolean;
	back: boolean;
	left: boolean;
	right: boolean;
	jump: boolean;
	/** Shift (toys spec §4): stops pads. Optional so every existing Keys literal stays valid; absent = not held. */
	sneak?: boolean;
};

/**
 * Places the player on solid ground near their saved position. A saved position
 * with nothing under it means an immediate fall — which is how Noah's world came
 * to be saved at y = -193917 and load as an empty sky.
 */
export function findSafeSpawn(
	world: World,
	desired: [number, number, number],
): [number, number, number] {
	const top = world.height - 1;
	const [dx, dy, dz] = sanitizeSpawn(desired, world.height);

	const groundAt = (x: number, z: number, from: number): number | null => {
		const bx = Math.floor(x);
		const bz = Math.floor(z);
		const start = Math.min(Math.max(Math.floor(from), 0), top);
		for (let y = start; y >= 0; y--) {
			if (world.getBlock(bx, y, bz) !== 0) return y + 1;
		}
		// Nothing below the saved height — try from the top of the column.
		for (let y = top; y > start; y--) {
			if (world.getBlock(bx, y, bz) !== 0) return y + 1;
		}
		return null;
	};

	const here = groundAt(dx, dz, dy);
	if (here !== null) return [dx, here, dz];

	// Spiral outwards for the nearest column that has any ground at all.
	for (let r = 1; r <= 48; r++) {
		for (let ox = -r; ox <= r; ox++) {
			for (let oz = -r; oz <= r; oz++) {
				if (Math.max(Math.abs(ox), Math.abs(oz)) !== r) continue;
				const nx = Math.floor(dx) + ox;
				const nz = Math.floor(dz) + oz;
				if (nx < 0 || nx > 511 || nz < 0 || nz > 511) continue;
				const g = groundAt(nx + 0.5, nz + 0.5, top);
				if (g !== null) return [nx + 0.5, g, nz + 0.5];
			}
		}
	}
	return [dx, Math.max(dy, world.height / 2), dz];
}

export class Player {
	position: [number, number, number];
	vy = 0;
	grounded = false;
	hotbar: BlockId[] = [];
	selected = 0;
	/** Crafting counts by block name; replaced from the save by resolvePlayerExtras. */
	inventory: Inventory = {};
	/** Owned and equipped pickaxe tiers; 0 (the hand) is always owned. */
	tools: PlayerTools = { owned: [0], equipped: 0 };
	flying = false;
	flySpeedTier = FLY_TIER_DEFAULT;
	swimming = false;
	/**
	 * Toys spec §3.2: the column (x, z) of the Launch Pad that last threw him, or null when armed. It re-arms once
	 * his feet leave that column, so landing back on the pad does not throw him again. Not saved: a load starts armed.
	 */
	launchedFrom: [number, number] | null = null;
	readonly height: number;

	constructor(spawn: [number, number, number], height = 64) {
		this.height = height;
		this.position = sanitizeSpawn(spawn, height);
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
		// Tall worlds have unbreakable bedrock at y 0, so below it there is no way back up: put the player
		// on the surface of his column. Old 64-high worlds keep their void (he flies back up through his hole).
		if (world.height === 256 && this.position[1] < 0) {
			this.position = findSafeSpawn(world, [this.position[0], world.height - 1, this.position[2]]);
			this.vy = 0;
		}
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
		// Launch Pad re-arm: his feet have left the column of the pad that threw him.
		const lf = this.launchedFrom;
		if (lf && (Math.floor(this.position[0]) !== lf[0] || Math.floor(this.position[2]) !== lf[1])) this.launchedFrom = null;

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
			// Launch Pad: after the jump line, so a held jump cannot overwrite the launch.
			if (this.grounded && this.launchedFrom === null && padUnderFeet(world, this.position) === 'launch') {
				const up = padResponse(0, 'launch', keys.jump, keys.sneak === true);
				if (up > 0) {
					this.vy = up;
					this.launchedFrom = [Math.floor(this.position[0]), Math.floor(this.position[2])];
				}
			}
			vyStep = this.vy * dt;
		}

		const disp = Math.max(Math.abs(vx), Math.abs(vyStep), Math.abs(vz));
		const steps = Math.max(1, Math.ceil(disp / MAX_STEP));
		const sx = vx / steps,
			sy = vyStep / steps,
			sz = vz / steps;
		// Toys spec §3.1: the speed he lands with, read before collision zeroes it.
		const landingVy = this.vy;
		let grounded = false;
		for (let i = 0; i < steps; i++) {
			const r = moveWithCollisions(world, this.position, SIZE, [sx, sy, sz]);
			this.position = r.position;
			grounded = grounded || r.grounded;
			if (r.vy === 0) this.vy = 0;
			if (r.vx === 0 && r.vz === 0 && r.vy === 0) break;
		}
		// Slime Pad: a real landing bounces. Not grounded, so next frame's jump line cannot overwrite the bounce
		// (gate 1 measured a 19.7 bounce cut to 8.0). A soft landing, or sneak, leaves him standing.
		if (!this.flying && !this.swimming && grounded && landingVy < -MIN_BOUNCE_VY && padUnderFeet(world, this.position) === 'slime') {
			const up = padResponse(landingVy, 'slime', keys.jump, keys.sneak === true);
			if (up > 0) {
				this.vy = up;
				grounded = false;
			}
		}

		// Keep the player inside the world. Leaving it horizontally means there is no
		// ground to land on, which is how an endless fall starts.
		const [cx, cy, cz] = sanitizeSpawn(this.position, world.height);
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
